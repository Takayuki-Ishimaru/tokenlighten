/**
 * stateStore.ts — the persistent, per-workspace state store behind PI-09's
 * explicit handles (v0.10 alpha.2).
 *
 * DEVIATION D-4 IS THE DESIGN. The plan named "SQLite/WAL等" (expansion plan
 * PI-09 item 7); the reconciliation register replaces it with an
 * append-journal + atomic-rename FILE store because a native/GPL-adjacent
 * dependency would fail `npm run licenses`, and because this repo already
 * hardened exactly this durability pattern in the bench archive. The store
 * interface below is the seam the plan asks for: a shared/remote
 * implementation can replace it without touching a call site.
 *
 * LAYOUT — `<workspaceRoot>/.tokenlighten/state/` (dir 0700, files 0600):
 *
 *   meta.json         {v,epoch,createdAtMs}  — the STORE GENERATION. A handle
 *                                              carries this epoch; a store that
 *                                              had to reset gets a new one, so
 *                                              every outstanding handle becomes
 *                                              detectably stale instead of
 *                                              silently resolving against
 *                                              rebuilt state.
 *   journal.ndjson    one JSON record per line, append-only
 *   snapshot.json     compacted state, published by atomic rename
 *   *.corrupt-<ts>    preserved unusable files (never deleted)
 *
 * `.tokenlighten/` is already ignored repo-wide (`.gitignore:48`, an
 * unanchored `\.tokenlighten/` pattern that matches at every depth) exactly as
 * `.tokenlighten/index` and `.tokenlighten/checkpoints` are — so this store
 * needs NO new ignore rule and MUST NOT add one. That is the managed-gitignore
 * discipline here: reuse the directory whose ignore contract already exists.
 *
 * CORRUPTION IS FAIL-CLOSED TO EMPTY. Any unreadable/unparseable snapshot or
 * journal line makes the whole load abort to an EMPTY store, with the offending
 * files renamed to `.corrupt-<ts>` sidecars and a FRESH epoch minted. Nothing
 * throws out of `open()`; a store that cannot be read or written reports
 * `available:false` and every handle minted against it fails validation as
 * `unknown` — the honest refusal path, never a fabricated success.
 *
 * DURABILITY BOUNDARY, STATED. Records are appended with `fs.appendFileSync`
 * and compaction publishes by `rename` (atomic within a filesystem). There is
 * no directory fsync: a power loss can lose the last appends. That is
 * acceptable here because every record is a CACHE of state the server can
 * re-derive, and the failure mode of a lost record is `handle-unknown` +
 * recovery — the same outcome as no store at all.
 *
 * CAS AND IDEMPOTENCY (PI-09 item 8). `put()` takes `expectedVersion`; a
 * mismatch returns `state-conflict` and writes NOTHING (lost update = 0).
 * `rememberOperation()` is the `operation_id` dedup table — a bounded LRU, so a
 * long-lived workspace cannot grow it without bound.
 *
 * CONCURRENT INSTANCES (PI-09 "simultaneous-instance locking"). Every
 * mutation seam (append, compact/rotate, and the corruption-reset path
 * `open()` falls back to) runs under `writerLock.ts`'s advisory cross-process
 * lock, and re-syncs this instance's in-memory state from disk WHILE holding
 * it, right before a CAS or `operation_id` decision — the lock alone only
 * serializes the disk write; the resync is what makes that decision correct
 * against another process's already-committed writes, not just this
 * process's cache. CAS remains the correctness backstop either way: a
 * version mismatch is rejected on its own merits, lock or no lock. Readers
 * (`get`, `versionOf`, the plain load `open()` attempts first) stay
 * lock-free — appends are single, OS-atomic writes, so a concurrent reader
 * observes either the pre- or post-append file, never a torn line from a
 * writer that is still running; a torn line CAN still appear from a crash
 * mid-write, which is exactly the existing fail-closed-to-empty corruption
 * path above, now additionally guarded by the lock so a live writer's
 * appends are never torn by ANOTHER live writer racing it.
 */

import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { acquireWriterLock } from "./writerLock.js";

// ---------------------------------------------------------------------------
// Record model
// ---------------------------------------------------------------------------

/**
 * `content` is the CONTENT-ADDRESSING namespace (`util/handles.ts`'s
 * `HandleEntry`), deliberately NOT one of the three wire purposes — the PI-09
 * purpose discriminator separates "why the handle was minted" from "what it
 * addresses", and persisting a content handle must never make it redeemable as
 * a task handle.
 */
export type StoredPurpose = "task" | "context" | "continuation" | "content";

export interface StoredRecord {
  key: string;
  purpose: StoredPurpose;
  version: number;
  updatedAtMs: number;
  expiresAtMs: number;
  data: Record<string, unknown>;
}

type JournalLine =
  | { t: "put"; r: StoredRecord }
  | { t: "del"; k: string }
  | { t: "op"; k: string; v: string; a: number };

export type PutOutcome =
  | { ok: true; record: StoredRecord }
  | { ok: false; outcome: "state-conflict"; currentVersion: number }
  | { ok: false; outcome: "store-unavailable" };

export interface PutInput {
  key: string;
  purpose: StoredPurpose;
  data: Record<string, unknown>;
  ttlMs: number;
  /**
   * CAS guard. Omit for an unconditional write; pass 0 to require "must not
   * exist"; pass N to require the current version to be exactly N.
   */
  expectedVersion?: number;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Journal lines before a compaction is attempted. */
const COMPACT_LINE_THRESHOLD = 512;

/** Live records retained; the oldest quarter is dropped past this. */
const RECORD_CAP = 2048;

/** Bounded `operation_id` dedup table. */
const OPERATION_CAP = 256;

/** Refuse to load a journal larger than this (a runaway file is corruption). */
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

const STATE_DIRNAME = "state";
const META_FILE = "meta.json";
const JOURNAL_FILE = "journal.ndjson";
const SNAPSHOT_FILE = "snapshot.json";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class WorkspaceStateStore {
  readonly dir: string;
  private _epoch: string;
  private _available: boolean;
  private _records = new Map<string, StoredRecord>();
  private _operations = new Map<string, { value: string; atMs: number }>();
  private _journalLines = 0;

  private constructor(dir: string) {
    this.dir = dir;
    this._epoch = "00000000";
    this._available = false;
  }

  /** The store generation. Present in every handle minted against this store. */
  get epoch(): string {
    return this._epoch;
  }

  /** False when the directory could not be created or read. */
  get available(): boolean {
    return this._available;
  }

  get size(): number {
    return this._records.size;
  }

  // -------------------------------------------------------------------------
  // Open
  // -------------------------------------------------------------------------

  static open(workspaceRoot: string): WorkspaceStateStore {
    const dir = join(workspaceRoot, ".tokenlighten", STATE_DIRNAME);
    const store = new WorkspaceStateStore(dir);
    try {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("state directory is not a real directory");
      }
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) chmodSync(dir, DIR_MODE);
      store._loadOrReset();
      store._available = true;
    } catch {
      store._available = false;
    }
    return store;
  }

  private _path(name: string): string {
    return join(this.dir, name);
  }

  /** Preserve an unusable file rather than destroying evidence of the fault. */
  private _preserve(name: string): void {
    try {
      renameSync(this._path(name), this._path(`${name}.corrupt-${Date.now()}`));
    } catch {
      /* nothing readable to preserve */
    }
  }

  private _resetToEmpty(): void {
    this._records.clear();
    this._operations.clear();
    this._journalLines = 0;
    for (const name of [SNAPSHOT_FILE, JOURNAL_FILE]) this._preserve(name);
    this._epoch = randomBytes(4).toString("hex");
    this._writeMeta();
  }

  private _writeMeta(): void {
    writeFileSync(
      this._path(META_FILE),
      JSON.stringify({ v: 1, epoch: this._epoch, createdAtMs: Date.now() }),
      { encoding: "utf8", mode: FILE_MODE },
    );
  }

  /**
   * The initial attempt, LOCK-FREE: meta + snapshot + journal, all valid.
   * Readers stay lock-free by design (record-completeness of a single OS
   * append means a live writer's in-flight line is never observably torn —
   * pinned by stateStoreConcurrency.spec.ts); this same probe is reused,
   * still lock-free in shape, as the double-check right after acquiring the
   * lock below, and (with the fallback to a locked `_resetToEmpty`) as
   * `_resyncLocked`'s pull-in-other-processes'-writes step during a live
   * mutation. Every caller that gets `false` back unconditionally follows up
   * with a reset, so a failed attempt leaving `_records`/`_operations`
   * partially repopulated is never externally observable — nothing else runs
   * on this single-threaded call stack between the failure and the reset.
   */
  private _tryPlainLoad(): boolean {
    let epoch: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(this._path(META_FILE), "utf8")) as Record<string, unknown>;
      if (raw["v"] === 1 && typeof raw["epoch"] === "string" && /^[0-9a-f]{8}$/.test(raw["epoch"])) {
        epoch = raw["epoch"];
      }
    } catch {
      epoch = undefined;
    }
    if (epoch === undefined) return false;
    this._epoch = epoch;
    this._records.clear();
    this._operations.clear();
    this._journalLines = 0;
    try {
      this._loadSnapshot();
      this._replayJournal();
    } catch {
      // ONE corruption anywhere fails the whole load closed to empty. Partial
      // recovery would mean serving handles whose state is half a generation
      // old, which is exactly the "silent wrong-state reuse" PI-09 forbids.
      return false;
    }
    this._expireNow();
    return true;
  }

  /** True when META_FILE currently holds a well-formed `{v:1, epoch}`. Used
   *  only to decide whether a reset owes a `.corrupt-<ts>` preservation of
   *  it — a corrupt/missing meta gets preserved; a valid meta whose
   *  snapshot/journal were the actual corruption does not, matching the
   *  original fail-closed contract exactly. */
  private _hasValidMeta(): boolean {
    try {
      const raw = JSON.parse(readFileSync(this._path(META_FILE), "utf8")) as Record<string, unknown>;
      return raw["v"] === 1 && typeof raw["epoch"] === "string" && /^[0-9a-f]{8}$/.test(raw["epoch"]);
    } catch {
      return false;
    }
  }

  private _loadOrReset(): void {
    if (this._tryPlainLoad()) return;
    // Meta is missing/corrupt, or the snapshot/journal failed to parse. This
    // IS a mutation seam (rename-to-corrupt + mint a fresh epoch + write
    // meta), so — unlike the plain load above — it goes under the same
    // writer lock as every other mutation: two processes cold-starting the
    // SAME brand-new workspace at once must not each mint a DIFFERENT epoch
    // and race writing meta.json.
    const lock = acquireWriterLock(this.dir);
    if (lock === undefined) {
      // Flows through open()'s existing try/catch, which sets
      // available:false — never a hang, never a lockless reset.
      throw new Error("state store: writer lock unavailable during open");
    }
    try {
      // Another process may have just finished the identical reset while
      // this one was blocked on the lock — re-check before destroying
      // anything.
      if (this._tryPlainLoad()) return;
      if (!this._hasValidMeta()) this._preserve(META_FILE);
      this._resetToEmpty();
    } finally {
      lock.release();
    }
  }

  /**
   * Called while HOLDING the writer lock, immediately before a CAS or
   * `operation_id` decision, and before a compaction builds its snapshot:
   * pulls in whatever another process has committed since this instance
   * last read, so the decision is made against the TRUE current state, not
   * a stale in-process cache — this is what makes CAS (and dedup) the
   * correctness backstop ACROSS processes, not merely within one. Safe to
   * fall back to a destructive reset here (unlike the lock-free paths above)
   * because the lock proves no one else is mid-write right now: a parse
   * failure at this point is real corruption, never another writer's
   * torn-in-flight append.
   */
  private _resyncLocked(): void {
    if (this._tryPlainLoad()) return;
    this._resetToEmpty();
  }

  /**
   * Acquire the writer lock, resync, run `fn`, always release. `{ok:false}`
   * means the lock could not be acquired within its bound (or the store was
   * already unavailable) — `fn` never ran, nothing was mutated, and
   * `_available` is left/set false so the caller's existing
   * refusal/degradation path (store-unavailable) is what the request sees.
   * Never hangs: `acquireWriterLock` itself is bounded.
   */
  private _withWriterLock<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
    if (!this._available) return { ok: false };
    const lock = acquireWriterLock(this.dir);
    if (lock === undefined) {
      this._available = false;
      return { ok: false };
    }
    try {
      this._resyncLocked();
      return { ok: true, value: fn() };
    } finally {
      lock.release();
    }
  }

  private _loadSnapshot(): void {
    let raw: string;
    try {
      raw = readFileSync(this._path(SNAPSHOT_FILE), "utf8");
    } catch {
      return; // no snapshot yet: a journal-only store is normal
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed["v"] !== 1 || !Array.isArray(parsed["records"])) {
      throw new Error("snapshot shape");
    }
    for (const entry of parsed["records"] as unknown[]) {
      const record = asRecord(entry);
      if (record === undefined) throw new Error("snapshot record shape");
      this._records.set(record.key, record);
    }
    if (Array.isArray(parsed["operations"])) {
      for (const entry of parsed["operations"] as unknown[]) {
        if (typeof entry !== "object" || entry === null) throw new Error("snapshot op shape");
        const op = entry as Record<string, unknown>;
        if (typeof op["k"] !== "string" || typeof op["v"] !== "string") throw new Error("snapshot op shape");
        this._operations.set(op["k"], { value: op["v"], atMs: Number(op["a"] ?? 0) });
      }
    }
  }

  private _replayJournal(): void {
    let raw: string;
    try {
      const stat = lstatSync(this._path(JOURNAL_FILE));
      if (stat.size > MAX_JOURNAL_BYTES) throw new Error("journal too large");
      raw = readFileSync(this._path(JOURNAL_FILE), "utf8");
    } catch (err) {
      if (err instanceof Error && err.message === "journal too large") throw err;
      return; // no journal yet
    }
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line === "") continue;
      const parsed = JSON.parse(line) as JournalLine;
      this._journalLines += 1;
      this._applyJournalLine(parsed);
    }
  }

  private _applyJournalLine(line: JournalLine): void {
    if (line.t === "put") {
      const record = asRecord(line.r);
      if (record === undefined) throw new Error("journal record shape");
      this._records.set(record.key, record);
      return;
    }
    if (line.t === "del") {
      if (typeof line.k !== "string") throw new Error("journal del shape");
      this._records.delete(line.k);
      return;
    }
    if (line.t === "op") {
      if (typeof line.k !== "string" || typeof line.v !== "string") throw new Error("journal op shape");
      this._operations.set(line.k, { value: line.v, atMs: Number(line.a ?? 0) });
      return;
    }
    throw new Error("journal line kind");
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Live record for `key`, or undefined when absent or expired. */
  get(key: string): StoredRecord | undefined {
    const record = this._records.get(key);
    if (record === undefined) return undefined;
    if (record.expiresAtMs <= Date.now()) {
      this._records.delete(key);
      return undefined;
    }
    return record;
  }

  /** Current CAS version for `key`; 0 when absent. */
  versionOf(key: string): number {
    return this.get(key)?.version ?? 0;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  put(input: PutInput): PutOutcome {
    if (!this._available) return { ok: false, outcome: "store-unavailable" };
    const locked = this._withWriterLock<PutOutcome>(() => {
      // Evaluated AFTER _withWriterLock's resync, so `currentVersion` is the
      // TRUE current version — including a write another process committed
      // since this instance last looked — not a stale in-process cache.
      const current = this.get(input.key);
      const currentVersion = current?.version ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        return { ok: false, outcome: "state-conflict", currentVersion };
      }
      const now = Date.now();
      const record: StoredRecord = {
        key: input.key,
        purpose: input.purpose,
        version: currentVersion + 1,
        updatedAtMs: now,
        expiresAtMs: now + Math.max(1000, input.ttlMs),
        data: input.data,
      };
      if (!this._appendRaw({ t: "put", r: record })) return { ok: false, outcome: "store-unavailable" };
      this._records.set(record.key, record);
      this._evictIfNeeded();
      if (this._journalLines >= COMPACT_LINE_THRESHOLD) this._compactLocked();
      return { ok: true, record };
    });
    return locked.ok ? locked.value : { ok: false, outcome: "store-unavailable" };
  }

  delete(key: string): void {
    if (!this._available) return;
    this._withWriterLock<void>(() => {
      if (!this._records.has(key)) return;
      this._records.delete(key);
      this._appendRaw({ t: "del", k: key });
    });
  }

  /**
   * `operation_id` dedup (PI-09 item 8). Returns `firstSeen:false` plus the
   * value recorded the first time, so a retried edit/state transition replays
   * its ORIGINAL outcome rather than applying twice — including when the
   * FIRST recording happened in a DIFFERENT process (the locked path below
   * resyncs before deciding, exactly like `put`'s CAS check).
   *
   * Degrades to this process's own in-memory-only bookkeeping (no resync, no
   * disk write) when the writer lock cannot be acquired — the pre-lock
   * contract for this method, preserved rather than turned into a hard
   * failure this call's return shape has no room to report; the store is
   * still marked unavailable so every OTHER call sees the honest refusal
   * path.
   */
  /**
   * PI-09 close-out: READ-ONLY lookup of a recorded `operation_id` outcome.
   *
   * `rememberOperation` cannot serve this: it WRITES on first sight, so using
   * it as a probe would record a placeholder the real outcome could never
   * replace (the table is insert-only by design — that is what makes it a
   * dedup rather than a cache). The two-step "look, then act, then record" is
   * therefore the only shape an idempotency key can have here.
   */
  lookupOperation(operationId: string): string | undefined {
    return this._operations.get(operationId)?.value;
  }

  rememberOperation(operationId: string, value: string): { firstSeen: boolean; value: string } {
    const locked = this._withWriterLock(() => this._rememberOperationEntry(operationId, value, true));
    return locked.ok ? locked.value : this._rememberOperationEntry(operationId, value, false);
  }

  private _rememberOperationEntry(
    operationId: string,
    value: string,
    persist: boolean,
  ): { firstSeen: boolean; value: string } {
    const existing = this._operations.get(operationId);
    if (existing !== undefined) return { firstSeen: false, value: existing.value };
    const entry = { value, atMs: Date.now() };
    this._operations.set(operationId, entry);
    if (this._operations.size > OPERATION_CAP) {
      // Insertion-ordered Map: the first key is the oldest.
      const oldest = this._operations.keys().next();
      if (!oldest.done) this._operations.delete(oldest.value);
    }
    if (persist) this._appendRaw({ t: "op", k: operationId, v: value, a: entry.atMs });
    return { firstSeen: true, value };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Assumes the writer lock is already held — every caller reaches this
   *  only from inside `_withWriterLock`'s `fn`. */
  private _appendRaw(line: JournalLine): boolean {
    try {
      appendFileSync(this._path(JOURNAL_FILE), `${JSON.stringify(line)}\n`, {
        encoding: "utf8",
        mode: FILE_MODE,
      });
      this._journalLines += 1;
      return true;
    } catch {
      // A store that cannot be written is a store that must stop claiming to
      // remember anything.
      this._available = false;
      return false;
    }
  }

  private _expireNow(): void {
    const now = Date.now();
    for (const [key, record] of this._records) {
      if (record.expiresAtMs <= now) this._records.delete(key);
    }
  }

  private _evictIfNeeded(): void {
    if (this._records.size <= RECORD_CAP) return;
    const sorted = Array.from(this._records.values()).sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    const drop = Math.ceil(RECORD_CAP / 4);
    for (let i = 0; i < drop && i < sorted.length; i++) this._records.delete(sorted[i]!.key);
  }

  /**
   * Publish a fresh snapshot by atomic rename, then truncate the journal.
   * Acquires the writer lock itself (and resyncs under it) — a caller inside
   * an ALREADY-locked section (`put`'s threshold-triggered compaction) must
   * call `_compactLocked` directly instead, never this method, or it would
   * try to acquire a lock it already holds.
   *
   * Crash-safety of the publish ORDER: if the process dies between the
   * rename and the truncate, the next load replays journal records the
   * snapshot already contains. Replay is last-writer-wins over the same keys
   * with the same versions, so a double-apply is a no-op — the reason the
   * journal does not need a checkpoint marker.
   */
  compact(): void {
    if (!this._available) return;
    this._withWriterLock<void>(() => this._compactLocked());
  }

  /** Assumes the writer lock is already held and the in-memory state has
   *  already been resynced (both true for every real caller: `compact()`
   *  above, and `put()`'s threshold-triggered call from inside its own
   *  locked section). Building the snapshot from a resynced `_records` is
   *  what keeps a badly-timed compaction from truncating away a record
   *  another process committed but this instance had not yet loaded. */
  private _compactLocked(): void {
    this._expireNow();
    const payload = JSON.stringify({
      v: 1,
      records: Array.from(this._records.values()),
      operations: Array.from(this._operations.entries()).map(([k, o]) => ({ k, v: o.value, a: o.atMs })),
    });
    const tmp = this._path(`${SNAPSHOT_FILE}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      writeFileSync(tmp, payload, { encoding: "utf8", mode: FILE_MODE });
      renameSync(tmp, this._path(SNAPSHOT_FILE));
      writeFileSync(this._path(JOURNAL_FILE), "", { encoding: "utf8", mode: FILE_MODE });
      this._journalLines = 0;
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      this._available = false;
    }
  }
}

function asRecord(value: unknown): StoredRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v["key"] !== "string" || v["key"] === "") return undefined;
  const purpose = v["purpose"];
  if (purpose !== "task" && purpose !== "context" && purpose !== "continuation" && purpose !== "content") {
    return undefined;
  }
  if (typeof v["version"] !== "number" || !Number.isFinite(v["version"])) return undefined;
  if (typeof v["updatedAtMs"] !== "number" || typeof v["expiresAtMs"] !== "number") return undefined;
  if (typeof v["data"] !== "object" || v["data"] === null) return undefined;
  return {
    key: v["key"],
    purpose,
    version: v["version"],
    updatedAtMs: v["updatedAtMs"],
    expiresAtMs: v["expiresAtMs"],
    data: v["data"] as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Per-workspace cache
// ---------------------------------------------------------------------------

const _stores = new Map<string, WorkspaceStateStore>();

/** Disable persistence entirely (operator kill switch / hermetic tests). */
export function stateStoreDisabled(): boolean {
  return process.env["TOKENLIGHTEN_STATE_STORE"] === "off";
}

/** The store for `workspaceRoot`, opened once per process. */
export function stateStoreFor(workspaceRoot: string): WorkspaceStateStore | undefined {
  if (stateStoreDisabled()) return undefined;
  const cached = _stores.get(workspaceRoot);
  if (cached !== undefined) return cached;
  const store = WorkspaceStateStore.open(workspaceRoot);
  _stores.set(workspaceRoot, store);
  return store;
}

/** Test hook: forget every cached store so the next call re-opens from disk. */
export function resetStateStoresForTests(): void {
  _stores.clear();
}
