/**
 * writerLock.ts — advisory cross-process WRITER lock for the per-workspace
 * state store (PI-09 "simultaneous-instance locking", v0.10).
 *
 * WHY THIS EXISTS. `stateStore.ts` was proven safe for SEQUENTIAL multi-
 * instance use (one process at a time, e.g. restart-recovery) but not for
 * CONCURRENT instances: two processes each hold an independent in-memory
 * cache of `<workspace>/.tokenlighten/state/`, so without serialization a
 * CAS check or an `operation_id` dedup lookup can be evaluated against a
 * stale view and silently lose an update (both writers observe "not seen
 * yet" and both append conflicting records). This module supplies the
 * MUTUAL EXCLUSION `stateStore.ts` re-syncs under; the resync itself (not
 * this file) is what makes the CAS/dedup decision correct once serialized —
 * see stateStore.ts's `_resyncLocked`.
 *
 * DESIGN, FOLLOWING THIS REPO'S BENCH-ARCHIVE PRECEDENT (AGENTS.md "Bench
 * archive safety"): advisory lock in the resource's own PRIVATE namespace
 * (the already-0700 `.tokenlighten/state/` directory — no new directory, no
 * new ignore rule), no blind pathname cleanup (a break re-proves staleness
 * immediately before unlinking, and a release only ever removes a lock file
 * this exact acquisition created — `pid` AND a per-acquisition monotonic
 * marker must both match), and staleness PROVEN, never assumed.
 *
 * LOCK FILE. `writer.lock`, created with `wx` (O_EXCL): the create call
 * itself is the mutual-exclusion primitive — it either succeeds (this
 * process now holds the lock) or fails with EEXIST (someone else does), with
 * no observable state in between, on every platform Node runs on (POSIX
 * O_CREAT|O_EXCL; Windows CREATE_NEW — libuv maps `wx` to both). Content is
 * `{pid, hostname, startedAtMs, monotonicStart}`, written once at creation.
 * The FILE's own mtime is the heartbeat: cheap to check with one `stat()`,
 * no need to parse content to answer "is this fresh".
 *
 * STALENESS. A lock is breakable only when heartbeat age exceeds the
 * staleness window AND (where the platform allows a liveness check) the
 * recorded pid is confirmed NOT alive. A lock proven alive is never broken,
 * regardless of how old it looks — clock skew or a slow heartbeat write must
 * never cause a live writer to lose its lock. Where liveness cannot be
 * determined at all (no usable pid, or a check that itself errors in an
 * unexpected way), the heartbeat-age bound is the sole signal — the
 * documented, conservative fallback for a platform that cannot prove more,
 * not a loophole to break fresh locks.
 *
 * SYNCHRONOUS BY CONSTRUCTION. `stateStore.ts` is entirely synchronous
 * (`*Sync` fs calls); this module matches that so acquiring the lock does
 * not require threading `async`/`await` through every call site (a much
 * larger, riskier change). The bounded backoff sleep uses the standard
 * Node main-thread trick — `Atomics.wait` on a throwaway `SharedArrayBuffer`
 * — which is a JS-engine built-in, not a dependency.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

const LOCK_FILE = "writer.lock";
const FILE_MODE = 0o600;

/** Production default: a lock idle this long, PLUS a dead-pid proof where
 *  available, is breakable. Comfortably larger than any realistic single
 *  synchronous journal append or compaction (bounded by RECORD_CAP/
 *  COMPACT_LINE_THRESHOLD in stateStore.ts — low milliseconds in practice). */
const DEFAULT_STALE_MS = 8_000;

/** How much longer than the staleness window a caller waits before giving
 *  up on a lock that never proves stale (i.e. is genuinely held by a live
 *  writer) — the "never a hang" bound. Flat, not scaled, so a small test
 *  override keeps the whole acquire attempt fast. */
const ACQUIRE_MARGIN_MS = 1_000;

const INITIAL_BACKOFF_MS = 5;
const MAX_BACKOFF_MS = 100;

// ---------------------------------------------------------------------------
// Tunables: production default, with a literal-string, single test override
// ---------------------------------------------------------------------------

/**
 * `TOKENLIGHTEN_STATE_LOCK_STALE_MS` — test-only override of the staleness
 * window. Operational/diagnostic (D10 (C) class: it changes internal lock
 * TIMING only, never a response shape) — registered in util/flags.ts's D10
 * inventory and protocolVersionBranch.spec.ts's CLASSIFIED_ENV in the same
 * commit that introduces it. Read as a literal string key, once per call, no
 * caching — matches every other env read in this tree.
 */
function defaultStaleMs(): number {
  const raw = process.env["TOKENLIGHTEN_STATE_LOCK_STALE_MS"];
  if (raw === undefined || raw === "") return DEFAULT_STALE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STALE_MS;
  return parsed;
}

export interface AcquireOptions {
  /** Staleness window override, ms. Defaults to `defaultStaleMs()`. */
  staleMs?: number;
  /** Total bound on the acquire attempt, ms. Defaults to `staleMs + ACQUIRE_MARGIN_MS`. */
  acquireBoundMs?: number;
}

export interface WriterLockHandle {
  /** Release the lock — a no-op if it is no longer provably this holder's
   *  (e.g. it was already broken as stale by someone else, which must never
   *  happen to a fresh lock, but release stays safe even if it somehow did). */
  release(): void;
}

interface LockContent {
  pid: number;
  hostname: string;
  startedAtMs: number;
  monotonicStart: string;
}

// ---------------------------------------------------------------------------
// Content + staleness
// ---------------------------------------------------------------------------

function readLockContent(lockPath: string): LockContent | undefined {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    if (typeof raw["pid"] !== "number" || !Number.isInteger(raw["pid"])) return undefined;
    if (typeof raw["hostname"] !== "string") return undefined;
    return {
      pid: raw["pid"],
      hostname: raw["hostname"],
      startedAtMs: typeof raw["startedAtMs"] === "number" ? raw["startedAtMs"] : 0,
      monotonicStart: typeof raw["monotonicStart"] === "string" ? raw["monotonicStart"] : "",
    };
  } catch {
    return undefined; // missing, unreadable, or not JSON — no content to trust
  }
}

function lockAgeMs(lockPath: string): number | undefined {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return undefined; // already gone
  }
}

/**
 * Best-effort liveness of `pid`. `true`/`false` are proofs; `undefined` means
 * the platform could not tell — the caller must treat that as "not proven
 * alive" for gating a break, never as "proven dead".
 */
function isProcessAlive(pid: number): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    // Signal 0: existence probe, sends nothing. Documented Node behavior on
    // POSIX and Windows alike.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false; // no such process: proven dead
    if (code === "EPERM") return true; // exists, just not signalable by us
    return undefined; // indeterminate — do not treat as proof of either state
  }
}

/**
 * Proven staleness: heartbeat age past the window is the primary (and, where
 * liveness cannot be determined, the SOLE) gate. A pid proven alive is an
 * absolute veto regardless of age — "never break a fresh lock" is the one
 * rule staleness math may not override.
 */
function isBreakable(lockPath: string, staleMs: number): boolean {
  const age = lockAgeMs(lockPath);
  if (age === undefined) return false; // nothing there to break
  if (age < staleMs) return false;
  const content = readLockContent(lockPath);
  if (content === undefined) return true; // stale by age, unreadable/no pid to veto with
  const alive = isProcessAlive(content.pid);
  return alive !== true; // false (proven dead) or undefined (indeterminate) -> breakable
}

function tryBreakStaleLock(lockPath: string, staleMs: number): void {
  // Re-proves staleness immediately before the destructive unlink, shrinking
  // the TOCTOU window between "looked stale" and "removed".
  if (!isBreakable(lockPath, staleMs)) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone: the holder released it, or another breaker won the race
       — either way there is nothing left to remove */
  }
}

// ---------------------------------------------------------------------------
// Sleep (synchronous, dependency-free)
// ---------------------------------------------------------------------------

function syncSleep(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  // Node explicitly permits Atomics.wait on the main thread (unlike a
  // browser's UI thread); this blocks the event loop for exactly `ms`
  // without a busy-spin.
  Atomics.wait(view, 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Acquire / release
// ---------------------------------------------------------------------------

function safeHostname(): string {
  try {
    return osHostname();
  } catch {
    return "unknown";
  }
}

/**
 * Acquire the writer lock in `dir` (the store's own private, already-0700
 * directory). Retries with bounded backoff, breaking a PROVEN-stale lock
 * along the way; returns `undefined` — never throws, never hangs — once
 * `acquireBoundMs` elapses without success.
 */
export function acquireWriterLock(dir: string, opts: AcquireOptions = {}): WriterLockHandle | undefined {
  const staleMs = opts.staleMs ?? defaultStaleMs();
  const acquireBoundMs = opts.acquireBoundMs ?? staleMs + ACQUIRE_MARGIN_MS;
  const lockPath = join(dir, LOCK_FILE);
  const deadline = Date.now() + acquireBoundMs;
  let backoff = INITIAL_BACKOFF_MS;

  for (;;) {
    const ownerMonotonic = process.hrtime.bigint().toString();
    try {
      const fd = openSync(lockPath, "wx", FILE_MODE);
      try {
        const content: LockContent = {
          pid: process.pid,
          hostname: safeHostname(),
          startedAtMs: Date.now(),
          monotonicStart: ownerMonotonic,
        };
        writeSync(fd, Buffer.from(JSON.stringify(content), "utf8"));
      } finally {
        closeSync(fd);
      }
      return makeHandle(lockPath, process.pid, ownerMonotonic, staleMs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Cannot even attempt (missing/unwritable parent, etc.) — fail closed
        // rather than retry an error backoff will not fix.
        return undefined;
      }
    }
    tryBreakStaleLock(lockPath, staleMs);
    if (Date.now() >= deadline) return undefined;
    syncSleep(Math.min(backoff, Math.max(0, deadline - Date.now())));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

function makeHandle(lockPath: string, ownerPid: number, ownerMonotonic: string, staleMs: number): WriterLockHandle {
  const refreshMs = Math.max(20, Math.floor(staleMs / 4));
  const owns = (): boolean => {
    const content = readLockContent(lockPath);
    return content !== undefined && content.pid === ownerPid && content.monotonicStart === ownerMonotonic;
  };
  // Heartbeat while held. Every mutation this lock guards is a single bounded
  // synchronous call, so in practice this timer's interval rarely elapses
  // before release() clears it — the acquire-time mtime already dates the
  // hold accurately for DEFAULT_STALE_MS. It is still wired up for real
  // (not merely implied by "we touched it at acquire time"): a future slower
  // holder, or a loaded filesystem, refreshes for real rather than relying on
  // a generous staleness constant alone.
  const timer = setInterval(() => {
    if (!owns()) return; // no longer provably ours — do not resurrect it
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      /* best effort; a missed refresh only makes this holder look stale
         sooner, which is the fail-SAFE direction, never the reverse */
    }
  }, refreshMs);
  timer.unref?.();

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      clearInterval(timer);
      // Object-identity proof before the destructive unlink: never remove a
      // lock file that staleness-breaking has already reassigned to someone
      // else (pid AND the per-acquisition monotonic marker must both match).
      if (owns()) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/** Test-only: read the raw lock content, for assertions against what an
 *  acquisition actually wrote (pid/hostname/markers), without depending on
 *  acquireWriterLock's own return shape. */
export function readWriterLockForTests(dir: string): LockContent | undefined {
  return readLockContent(join(dir, LOCK_FILE));
}

/** Test-only: age of the current lock file in ms, or undefined if absent. */
export function writerLockAgeMsForTests(dir: string): number | undefined {
  return lockAgeMs(join(dir, LOCK_FILE));
}
