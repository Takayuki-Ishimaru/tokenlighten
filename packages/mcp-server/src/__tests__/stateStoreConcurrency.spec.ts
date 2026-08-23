/**
 * stateStoreConcurrency.spec.ts — PI-09 "simultaneous-instance locking"
 * (v0.10): the per-workspace persistent state store under CONCURRENT server
 * instances, not merely sequential multi-instance use (stateHandleStore.spec
 * .ts's restart-round-trip drills already cover sequential).
 *
 * WHAT THIS PROVES:
 *
 *   1. Two SPAWNED processes running an interleaved mint/consume/edit-dedup
 *      workload against the SAME workspace: zero invalid-handle acceptance,
 *      zero journal corruption (post-run integrity scan), zero deadlock
 *      (bounded total time), and — the precise correctness check — the final
 *      on-disk state accounts for every successful write from BOTH
 *      processes exactly once (no lost updates, no double-applied
 *      operation_ids).
 *   2. A lock holder killed with SIGKILL mid-write leaves a breakable-stale
 *      lock; the next writer proves staleness (does not steal early) and
 *      then proceeds; the store recovers to a clean, usable state.
 *   3. A FRESH lock held by a live process is never broken: a second writer
 *      waits out its bound and fails closed rather than stealing.
 *   4. Adversarial: a lock file naming a DEAD pid but stamped with a FRESH
 *      mtime is not broken until the heartbeat window has genuinely lapsed —
 *      staleness is proven by age first, dead-pid is only an additional
 *      veto, never a shortcut.
 *
 * Workers are spawned directly against `state/stateStore.ts` /
 * `state/stateHandles.ts` (not through the MCP/stdio protocol layer, the way
 * the rc/ drills spawn a full bin.ts server) — the PI-09 concurrency cell
 * under test lives entirely in the store + lock modules, and driving them
 * directly keeps the drill fast, deterministic, and focused on the exact
 * locked code paths, per this file's own fixtures/ scripts.
 *
 * ISOLATION. Every workspace is a fresh os.tmpdir() directory (F-A1-8).
 * `TOKENLIGHTEN_STATE_KEY_DIR` is pre-warmed ONCE (in this process) into a
 * dedicated temp dir and passed explicitly to every spawned worker that
 * needs it, so two workers cold-starting the SAME key file never race
 * handleKeys.ts's own (separate, out-of-scope-for-this-cell) key-creation
 * path — see the comment on `sharedKeyDir` below.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { acquireWriterLock, readWriterLockForTests } from "../state/writerLock.js";
import { resetStateStoresForTests, stateStoreFor, WorkspaceStateStore } from "../state/stateStore.js";
import { handleKeyRing, resetHandleKeyRingForTests } from "../state/handleKeys.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCK_HOLDER_TS = path.resolve(HERE, "fixtures", "stateLockHolder.ts");
const LOOP_WORKER_TS = path.resolve(HERE, "fixtures", "stateStoreLoopWorker.ts");
const SPAWN_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared fixtures / cleanup
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
const liveChildren: ChildProcess[] = [];
let sharedKeyDir: string;
let savedKeyDirEnv: string | undefined;
let savedStaleMsEnv: string | undefined;

function mkTmp(tag: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-pi09-conc-${tag}-`)));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(() => {
  savedKeyDirEnv = process.env["TOKENLIGHTEN_STATE_KEY_DIR"];
  savedStaleMsEnv = process.env["TOKENLIGHTEN_STATE_LOCK_STALE_MS"];
  sharedKeyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-pi09-conc-keys-")));
  tmpDirs.push(sharedKeyDir);
  // Pre-warm the key file ONCE, synchronously, in this process — so every
  // spawned worker below only ever READS an already-valid key file rather
  // than racing to CREATE it. handleKeys.ts's own creation race (two
  // processes both losing the "wx" temp-create step, both `renameSync`ing a
  // fresh key over each other) is a real, separate concern outside this
  // cell's scope (PI-09 "simultaneous-instance locking" is about
  // stateStore.ts's journal/CAS, not handleKeys.ts's key file) — pre-warming
  // sidesteps it entirely rather than letting it become confounding noise in
  // these drills.
  process.env["TOKENLIGHTEN_STATE_KEY_DIR"] = sharedKeyDir;
  resetHandleKeyRingForTests();
  handleKeyRing();
});

afterAll(() => {
  for (const child of liveChildren.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (savedKeyDirEnv === undefined) delete process.env["TOKENLIGHTEN_STATE_KEY_DIR"];
  else process.env["TOKENLIGHTEN_STATE_KEY_DIR"] = savedKeyDirEnv;
  if (savedStaleMsEnv === undefined) delete process.env["TOKENLIGHTEN_STATE_LOCK_STALE_MS"];
  else process.env["TOKENLIGHTEN_STATE_LOCK_STALE_MS"] = savedStaleMsEnv;
  resetHandleKeyRingForTests();
  resetStateStoresForTests();
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
});

function stateDirFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tokenlighten", "state");
}

// ---------------------------------------------------------------------------
// Fixture harness: raw lock holder (deterministic, hangs until killed/timed)
// ---------------------------------------------------------------------------

interface LockHolderHandle {
  pid: number;
  kill(): void;
  waitExit(timeoutMs?: number): Promise<void>;
}

function spawnLockHolder(dir: string, mode: string): Promise<LockHolderHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, LOCK_HOLDER_TS, dir, mode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    liveChildren.push(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const exitResolvers: Array<() => void> = [];
    child.on("exit", () => {
      for (const r of exitResolvers.splice(0)) r();
    });
    const readyTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`lock holder did not report ready in time.\n--- stderr ---\n${stderr}`));
    }, 15_000);
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (settled) return;
      const firstLine = stdout.split("\n")[0] ?? "";
      if (firstLine.startsWith("READY ")) {
        settled = true;
        clearTimeout(readyTimer);
        const pid = Number(firstLine.slice("READY ".length).trim());
        resolve({
          pid,
          kill: () => {
            // tsx/cli re-execs into an INNER process whose pid (the one the
            // fixture reports and writes into the lock file via its own
            // `process.pid`) differs from `child.pid` (the outer wrapper
            // spawn() returned) — confirmed empirically: killing only the
            // outer wrapper leaves the inner, lock-holding process running
            // as an orphan, which is silently NOT what "kill -9 the lock
            // holder" is supposed to simulate. Kill both, best-effort.
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              /* already gone */
            }
            try {
              child.kill("SIGKILL");
            } catch {
              /* ok */
            }
          },
          waitExit: (timeoutMs = 5_000) =>
            child.exitCode !== null || child.signalCode !== null
              ? Promise.resolve()
              : new Promise<void>((res, rej) => {
                  const t = setTimeout(() => rej(new Error("lock holder did not exit in time")), timeoutMs);
                  exitResolvers.push(() => {
                    clearTimeout(t);
                    res();
                  });
                }),
        });
      } else if (firstLine.startsWith("FAILED")) {
        settled = true;
        clearTimeout(readyTimer);
        reject(new Error(`lock holder failed to acquire the lock.\n--- stderr ---\n${stderr}`));
      }
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
  });
}

// ---------------------------------------------------------------------------
// Fixture harness: interleaved store-loop worker
// ---------------------------------------------------------------------------

interface WorkerSummary {
  workerId: string;
  pid: number;
  ownMintFailures: number;
  ownConsumeFailures: number;
  tamperAccepted: number;
  crossWorkspaceAccepted: number;
  casAppliedCounts: Record<string, number>;
  casExhausted: string[];
  opResults: Array<{ opId: string; firstSeen: boolean; value: string; mine: string }>;
}

function runStoreLoopWorker(
  workspaceRoot: string,
  workerId: string,
  iterations: number,
  sharedKeyCount: number,
  sharedOpCount: number,
): Promise<WorkerSummary> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        TSX_CLI,
        LOOP_WORKER_TS,
        workspaceRoot,
        workerId,
        String(iterations),
        String(sharedKeyCount),
        String(sharedOpCount),
      ],
      {
        cwd: workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TOKENLIGHTEN_STATE_KEY_DIR: sharedKeyDir },
      },
    );
    liveChildren.push(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ok */
      }
      reject(new Error(`worker ${workerId} timed out.\n--- stderr ---\n${stderr}`));
    }, SPAWN_TIMEOUT_MS);
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr!.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`worker ${workerId} exited ${code}.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
        return;
      }
      const line = stdout
        .trim()
        .split("\n")
        .pop();
      try {
        resolve(JSON.parse(line ?? "") as WorkerSummary);
      } catch {
        reject(new Error(`worker ${workerId}: could not parse summary line.\n--- stdout ---\n${stdout}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 1. Two spawned processes, interleaved mint/consume/edit-dedup
// ---------------------------------------------------------------------------

describe("simultaneous instances — two spawned processes on one workspace", () => {
  it("interleaved mint/consume/edit-dedup: zero invalid-handle acceptance, zero journal corruption, zero deadlock, zero lost updates", async () => {
    const ws = mkTmp("dual-loop");
    const iterations = 50;
    const sharedKeyCount = 5;
    const sharedOpCount = 20;

    const start = Date.now();
    const [a, b] = await Promise.all([
      runStoreLoopWorker(ws, "A", iterations, sharedKeyCount, sharedOpCount),
      runStoreLoopWorker(ws, "B", iterations, sharedKeyCount, sharedOpCount),
    ]);
    const elapsedMs = Date.now() - start;

    // Zero deadlock: bounded total time. Generous ceiling — this is a
    // liveness floor, not a performance benchmark.
    expect(elapsedMs, `dual-worker run took ${elapsedMs}ms`).toBeLessThan(45_000);

    // Zero invalid-handle acceptance.
    expect(a.tamperAccepted, JSON.stringify(a)).toBe(0);
    expect(b.tamperAccepted, JSON.stringify(b)).toBe(0);
    expect(a.crossWorkspaceAccepted, JSON.stringify(a)).toBe(0);
    expect(b.crossWorkspaceAccepted, JSON.stringify(b)).toBe(0);
    expect(a.ownConsumeFailures, JSON.stringify(a)).toBe(0);
    expect(b.ownConsumeFailures, JSON.stringify(b)).toBe(0);
    // Each worker's OWN mint keys are fingerprint-unique to it (no other
    // process ever writes them), so there is no genuine cross-worker
    // contention on them — a mint failure here would mean the lock/CAS
    // machinery is starving an uncontended writer, not an honest conflict.
    expect(a.ownMintFailures, JSON.stringify(a)).toBe(0);
    expect(b.ownMintFailures, JSON.stringify(b)).toBe(0);

    // Zero lost updates on the CAS retry loops (bounded retries never
    // exhausted).
    expect(a.casExhausted, JSON.stringify(a)).toEqual([]);
    expect(b.casExhausted, JSON.stringify(b)).toEqual([]);

    // THE precise CAS correctness check: for every shared key, the final
    // on-disk version equals the SUM of both workers' successful applies. If
    // a successful write had ever been silently clobbered by a same-version
    // race (the failure mode of evaluating CAS against a stale
    // per-process cache), this sum would be strictly less than the final
    // version.
    resetStateStoresForTests();
    const finalStore = stateStoreFor(ws)!;
    expect(finalStore.available, "final store failed to open").toBe(true);
    for (let k = 0; k < sharedKeyCount; k++) {
      const key = `shared-cas-${k}`;
      const expected = (a.casAppliedCounts[key] ?? 0) + (b.casAppliedCounts[key] ?? 0);
      expect(finalStore.versionOf(key), `key ${key}: A=${JSON.stringify(a.casAppliedCounts)} B=${JSON.stringify(b.casAppliedCounts)}`).toBe(expected);
    }

    // THE precise dedup correctness check: for every shared operation_id,
    // exactly one worker's own call was firstSeen:true, both workers agree
    // on the resulting value, and that value traces back to the winner's own
    // submission — proving no double-application and no cross-contamination.
    for (let i = 0; i < sharedOpCount; i++) {
      const opId = `shared-op-${i}`;
      const ra = a.opResults.find((r) => r.opId === opId)!;
      const rb = b.opResults.find((r) => r.opId === opId)!;
      expect(ra, opId).toBeDefined();
      expect(rb, opId).toBeDefined();
      const firstSeenCount = (ra.firstSeen ? 1 : 0) + (rb.firstSeen ? 1 : 0);
      expect(firstSeenCount, `op ${opId} firstSeen count: ${JSON.stringify({ ra, rb })}`).toBe(1);
      expect(ra.value, opId).toBe(rb.value);
      const winner = ra.firstSeen ? ra : rb;
      expect(ra.value, `op ${opId} value must trace to the actual winner`).toBe(winner.mine);
    }

    // Post-run integrity scan: every journal line is complete, valid JSON —
    // this is "record-completeness" (why readers stay lock-free) proven
    // under a REAL two-process race, not merely asserted at rest.
    const stateDir = stateDirFor(ws);
    const journalPath = path.join(stateDir, "journal.ndjson");
    if (fs.existsSync(journalPath)) {
      const raw = fs.readFileSync(journalPath, "utf8");
      for (const line of raw.split("\n").filter((l) => l !== "")) {
        expect(() => JSON.parse(line), `corrupt/torn journal line: ${line}`).not.toThrow();
      }
    }
    const snapshotPath = path.join(stateDir, "snapshot.json");
    if (fs.existsSync(snapshotPath)) {
      expect(() => JSON.parse(fs.readFileSync(snapshotPath, "utf8")), "corrupt snapshot").not.toThrow();
    }
    const sidecars = fs.readdirSync(stateDir).filter((f) => f.includes(".corrupt-"));
    expect(sidecars, `unexpected corrupt sidecars (a real corruption fail-close fired): ${sidecars.join(", ")}`).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "writer.lock")), "a lock file was left behind after a clean run").toBe(false);

    // A THIRD, fresh store instance loads cleanly — no reset, same epoch.
    resetStateStoresForTests();
    const thirdStore = WorkspaceStateStore.open(ws);
    expect(thirdStore.available).toBe(true);
    expect(thirdStore.epoch).toBe(finalStore.epoch);
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 2. kill -9 mid-write -> next writer breaks the stale lock and proceeds
// ---------------------------------------------------------------------------

describe("simultaneous instances — crash recovery", () => {
  it("kill -9 the lock holder mid-write: the next writer waits out the staleness window (does not steal early), then breaks it and proceeds; journal integrity holds", async () => {
    const ws = mkTmp("kill-mid-write");
    resetStateStoresForTests();
    const seedStore = stateStoreFor(ws)!;
    expect(seedStore.available).toBe(true);
    const seed = seedStore.put({ key: "seed", purpose: "content", data: { ok: true }, ttlMs: 300_000 });
    expect(seed.ok, JSON.stringify(seed)).toBe(true);
    const stateDir = seedStore.dir;

    // "forever-torn": acquires the raw lock (simulating being mid-write),
    // appends a deliberately INCOMPLETE line to the ALREADY-valid journal
    // above, then hangs without releasing — a faithful kill -9 mid-append.
    const holder = await spawnLockHolder(stateDir, "forever-torn");
    holder.kill();
    await holder.waitExit(5_000);
    expect(fs.existsSync(path.join(stateDir, "writer.lock")), "the crash must leave the lock file behind").toBe(true);

    const staleMs = 300;
    process.env["TOKENLIGHTEN_STATE_LOCK_STALE_MS"] = String(staleMs);
    try {
      resetStateStoresForTests();
      const before = Date.now();
      const recovered = stateStoreFor(ws)!;
      const elapsed = Date.now() - before;

      expect(recovered.available, "store failed to recover after the crash-while-locked scenario").toBe(true);
      expect(elapsed, `recovered in ${elapsed}ms — too fast to have proven staleness first`).toBeGreaterThanOrEqual(staleMs * 0.5);
      // Fail-closed-to-empty is the documented, existing contract (this
      // file's "CORRUPTION IS FAIL-CLOSED TO EMPTY"): a torn tail resets the
      // WHOLE generation, including the valid "seed" record that predated
      // it, not just the bad line. Pinned here against the genuinely torn
      // (no trailing newline, valid-JSON-prefix-then-cut) shape a real
      // kill -9 mid-appendFileSync leaves — stateHandleStore.spec.ts's
      // existing corruption test uses a COMPLETE-but-invalid line instead.
      expect(recovered.get("seed"), "fail-closed-to-empty must still apply").toBeUndefined();

      const put2 = recovered.put({ key: "post-crash", purpose: "content", data: { ok: true }, ttlMs: 60_000 });
      expect(put2.ok, JSON.stringify(put2)).toBe(true);
    } finally {
      delete process.env["TOKENLIGHTEN_STATE_LOCK_STALE_MS"];
      resetStateStoresForTests();
    }

    const rawAfter = fs.readFileSync(path.join(stateDir, "journal.ndjson"), "utf8");
    for (const line of rawAfter.split("\n").filter((l) => l !== "")) {
      expect(() => JSON.parse(line), `corrupt line survived recovery: ${line}`).not.toThrow();
    }
    expect(fs.existsSync(path.join(stateDir, "writer.lock")), "no lock file should remain after a clean recovery put").toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. A fresh lock held by a live process is never broken
// ---------------------------------------------------------------------------

describe("simultaneous instances — a fresh lock is never stolen", () => {
  it("a second writer against a FRESH, live-held lock waits, then fails closed rather than stealing", async () => {
    const ws = mkTmp("fresh-never-stolen");
    const stateDir = stateDirFor(ws);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    // Holds comfortably longer than the second writer's whole acquire
    // bound below, so theft would be caught red-handed if it happened.
    const holder = await spawnLockHolder(stateDir, "ms:2000");
    const before = readWriterLockForTests(stateDir);
    expect(before?.pid, "the holder must have actually written the lock file").toBe(holder.pid);

    const staleMs = 300; // acquire bound derives to staleMs + 1000 = 1300ms, well under the 2000ms hold
    const attemptStart = Date.now();
    const stolen = acquireWriterLock(stateDir, { staleMs });
    const attemptElapsed = Date.now() - attemptStart;
    if (stolen !== undefined) stolen.release(); // must not happen; defensive cleanup either way

    expect(stolen, "a live holder's fresh lock must never be broken").toBeUndefined();
    expect(attemptElapsed, `gave up in ${attemptElapsed}ms — should have waited out the bound`).toBeGreaterThanOrEqual(staleMs);

    const after = readWriterLockForTests(stateDir);
    expect(after?.pid, "the lock file must still name the ORIGINAL, live holder").toBe(holder.pid);

    await holder.waitExit(5_000);
    expect(readWriterLockForTests(stateDir), "the original holder must release cleanly on its own exit").toBeUndefined();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 4. Adversarial: dead pid, FRESH mtime — not broken until the window lapses
// ---------------------------------------------------------------------------

describe("simultaneous instances — adversarial stale-lock proof", () => {
  it("a lock file naming a DEAD pid but stamped with a FRESH mtime is not broken until the heartbeat window truly lapses", async () => {
    const ws = mkTmp("adversarial-dead-fresh");
    const stateDir = stateDirFor(ws);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    // A guaranteed-dead pid: spawnSync blocks until the child has already
    // exited, so by the time it returns, this pid is provably unused.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    expect(typeof deadPid, "spawnSync must report a pid").toBe("number");

    const lockPath = path.join(stateDir, "writer.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, hostname: "adversary", startedAtMs: Date.now(), monotonicStart: "0" }),
      { mode: 0o600 },
    );
    // Freshly written -> freshly stamped mtime, by construction.

    const staleMs = 300;
    // acquireBoundMs is deliberately SHORTER than staleMs here: a call whose
    // own bound never reaches the staleness window must give up without
    // ever proving staleness. (A bound longer than staleMs — e.g. the
    // default staleMs + margin — would legitimately keep retrying until real
    // time crossed the window from WITHIN that same call, which is correct
    // behavior, not "broken early"; that path is exercised by `later` below.)
    const early = acquireWriterLock(stateDir, { staleMs, acquireBoundMs: Math.floor(staleMs / 3) });
    // Not enough time has passed: must NOT be broken despite the pid being
    // provably dead — heartbeat age is the primary gate, and "never break a
    // fresh lock" allows no dead-pid shortcut around it.
    expect(early, "a fresh-mtime lock must not be broken just because its pid is dead").toBeUndefined();
    const stillThere = readWriterLockForTests(stateDir);
    expect(stillThere?.pid, "the adversarial lock file must be untouched while still fresh").toBe(deadPid);

    await new Promise((resolve) => setTimeout(resolve, staleMs + 150));

    const later = acquireWriterLock(stateDir, { staleMs });
    expect(later, "once the heartbeat window truly lapses, a dead pid's lock IS breakable").not.toBeUndefined();
    later?.release();
    expect(readWriterLockForTests(stateDir), "release must clean up after a legitimate acquire").toBeUndefined();
  }, 15_000);
});
