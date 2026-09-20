/**
 * packServeLog.ts — per-workspace, session-stateful record of the surfaces
 * task_pack has already served this session, plus a cheap per-workspace
 * toolchain-status cache.
 *
 * WHY this module exists (2026-07-24 forensics): task_pack's byte cap cannot
 * embed all roles of a 5-role feature task in ONE call, so a multi-call session
 * routinely serves {ui,style} in call #2 and {contract,api} in call #3.
 * Coverage was computed STATELESSLY per call (deriveCoverage), so call #3 still
 * reported `missing_required:[ui,style]` for roles a PRIOR call already served,
 * and its route said `locate_missing_surfaces` — the agent obeyed and burned
 * search calls re-fetching context it already held. This registry lets a later
 * pack compute coverage against the UNION of the current call's surfaces and
 * the still-valid surfaces earlier calls served.
 *
 * Keyed by an absolute workspace-root path — the SAME keying discipline as
 * util/session.ts, but an INDEPENDENT registry: this module never imports
 * session.ts (the epoch-token concept is passed IN by the caller, which is what
 * keeps the two modules decoupled). I/O: a few fs.stat calls at record/query
 * time for cheap content identity (size+mtime) and toolchain probes; otherwise
 * pure.
 */

import * as fs from "fs";
import * as path from "path";

import { laneScopedKey } from "./laneKey.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One surface a prior task_pack served, with cheap content identity for revalidation. */
export interface ServedSurfaceEntry {
  /** Workspace-relative POSIX path. */
  path: string;
  /** Surface role (contract/api/ui/style/domain/...). */
  role: string;
  /** The handle this surface was minted under, when one was captured. */
  handle?: string;
  /** Cheap content identity: `<size>:<mtimeMs>` at serve time (or "" when unstattable). */
  fingerprint: string;
  /** Monotonic sequence — orders served_earlier and drives FIFO eviction. */
  servedAt: number;
  /**
   * C1 (DESIGN-v0.15 §12 rows 82-84, R31-FIX regression): whether the
   * recording call's own surface for this path already amounted to
   * everything a whole-file re-pack of it could add (see
   * `util/surfaceServedCoverage.ts`'s `surfaceAlreadyCoversWholeFile`, which
   * the recorder evaluates once at record time). `undefined` — the caller
   * did not supply the range-aware verdict — is treated as `true` by every
   * consumer, preserving this ledger's original path-only semantics for
   * every caller that does not thread it through.
   */
  fullyServed?: boolean;
}

/** Cached filesystem-kind probe result (Improvement D toolchain honesty). */
export type StatKind = "file" | "dir" | "missing";

/**
 * iter-2 W4: a recorded "awaiting-input" verdict for the active task epoch. Once
 * a pack lands on execution_contract phase awaiting-input for a genuine
 * unresolved proof (NOT a human candidate-choice), a subsequent overlapping pack
 * must not silently re-grant `prepared` while the proof is still unresolved —
 * the gate would otherwise be trivially escaped by re-issuing the query. The
 * latch is consulted on the NEXT overlapping pack and cleared when the caller
 * supplies genuinely new inputs, the referenced files change, or the epoch
 * flips.
 */
export interface AwaitingInputLatch {
  /** The unresolved proof id/token that kept the pack from certifying (for the receipt). */
  unresolvedProof: string;
  /** Sorted, de-duped input paths the awaiting-input pack already had (surfaces + caller paths). A superset on a later call = genuinely new inputs = clear. */
  inputPaths: string[];
  /** Content fingerprint of the referenced files at latch time; a mismatch = files changed = clear. */
  fileFingerprint: string;
  /** Short honest note naming what would resolve the wait (already-served candidate inputs). */
  note: string;
}

/**
 * iter-2 W5: an open "functionally validate the produced module against the
 * served artifact values" obligation for the active task epoch. Set when an
 * artifact-sourced pack targets a runnable create/edit; cleared when a
 * verification-evidence event is recorded or the epoch flips. Honest, not a
 * refusal — surfaced as an OPEN item, never a block.
 */
export interface FunctionalValidationObligation {
  /** Honest, generic wording of the obligation (no sheet/filename specifics). */
  note: string;
  /** The runnable target path the obligation is about (for the open-item text). */
  targetPath: string;
}

/**
 * iter-2 W3/W4/W5: per-epoch session metadata governing attach-discipline and
 * the idempotency/obligation latches. Reset together with the served-surface
 * entries whenever the task epoch flips (see `_resetSession`), so a genuinely
 * new task starts with a clean slate.
 */
interface SessionMetaState {
  /** W3: signature of the last `verification` verdict attached this epoch (undefined = never attached). */
  verificationSig?: string;
  /** W3: true once `served_earlier` has been attached this epoch (the cumulative FLIP call). */
  servedEarlierAttached?: boolean;
  /** W3: signature of the last `frontier_index` attached this epoch (undefined = never attached). */
  frontierIndexSig?: string;
  /** W4: the active awaiting-input latch, if any. */
  awaitingInput?: AwaitingInputLatch;
  /** W5: the open functional-validation obligation, if any. */
  functionalValidation?: FunctionalValidationObligation;
  /** D3 (2026-08-01): locate calls this session already executed — query → candidate handles. */
  executedLocates?: Map<string, string[]>;
}

interface WorkspacePackLog {
  /** Accumulated significant tokens of the task epoch these entries belong to (caller-supplied). */
  epochTokens: string[];
  /** path -> most recent served surface for that path. */
  entries: Map<string, ServedSurfaceEntry>;
  /** FIFO order of paths for bounded eviction (oldest first). */
  order: string[];
  /** Per-relpath cached fs kind — trivial, but avoids repeated stats within one session. */
  statCache: Map<string, StatKind>;
  /** iter-2 W3/W4/W5: per-epoch attach-discipline & latch metadata. */
  meta: SessionMetaState;
}

// ---------------------------------------------------------------------------
// Bounds & module state
// ---------------------------------------------------------------------------

/** Bounded registry: at most this many distinct served paths per workspace (FIFO). */
const MAX_LOGGED_PATHS = 512;

/**
 * Served-bytes novelty ledger. This is deliberately separate from the
 * obligation/proof ledgers: it records what crossed the wire, keyed by task
 * epoch and lane, while proof stores record what was established. All response
 * families use this one ledger at the emission choke point.
 */
export interface ServedBytesLedgerEntry {
  readonly epoch: string;
  readonly lane: string;
  readonly bytes: number;
  readonly digest: string;
  // B-F5 (2026-08-28): "budget-shed", not "trim" — this fires when
  // emit.ts's budget LADDER cut at least one record from the payload
  // (`shed.length > 0`). Post-ready trim and prior-pack dedup are separate
  // source labels, assigned at their protocol boundaries before emission.
  // The old name "trim" claimed a broader, inaccurate scope.
  readonly source: "fresh" | "receipt" | "replay" | "budget-shed" | "verification-kit" | "post-ready-trim" | "dedup";
  readonly forced: boolean;
  readonly sequence: number;
}

const _servedBytes = new Map<string, Map<string, ServedBytesLedgerEntry>>();

export interface ServedWindowLedgerEntry {
  readonly epoch: string;
  readonly lane: string;
  readonly path: string;
  readonly sha: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sequence: number;
}

const _servedWindows = new Map<string, Map<string, ServedWindowLedgerEntry>>();
const MAX_SERVED_WINDOWS_PER_SCOPE = 512;

function servedWindowScopeKey(workspaceRoot: string, epoch?: string, lane?: string): string {
  return `${workspaceRoot}\u0000${epoch ?? "default"}\u0000${normalizeContractLane(lane)}`;
}

function servedWindowEntryKey(path: string, sha: string, startLine: number, endLine: number): string {
  return JSON.stringify([path, sha, startLine, endLine]);
}

/**
 * Record the exact semantic range whose bytes were served, scoped to the same
 * workspace/epoch/lane identity as the served-bytes ledger.
 */
export function recordServedWindow(input: {
  workspaceRoot: string;
  epoch?: string;
  lane?: string;
  path: string;
  sha: string;
  startLine: number;
  endLine: number;
}): void {
  if (
    input.path === ""
    || input.sha === ""
    || !Number.isInteger(input.startLine)
    || !Number.isInteger(input.endLine)
    || input.startLine < 1
    || input.endLine < input.startLine
  ) return;
  const scopeKey = servedWindowScopeKey(input.workspaceRoot, input.epoch, input.lane);
  const ledger = _servedWindows.get(scopeKey) ?? new Map<string, ServedWindowLedgerEntry>();
  _servedWindows.set(scopeKey, ledger);
  const entryKey = servedWindowEntryKey(input.path, input.sha, input.startLine, input.endLine);
  if (ledger.has(entryKey)) return;
  ledger.set(entryKey, {
    epoch: input.epoch ?? "default",
    lane: normalizeContractLane(input.lane),
    path: input.path,
    sha: input.sha,
    startLine: input.startLine,
    endLine: input.endLine,
    sequence: ++_seq,
  });
  while (ledger.size > MAX_SERVED_WINDOWS_PER_SCOPE) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

/**
 * Return true when the requested range contains any line not covered by a
 * previously served window in this workspace/epoch/lane scope.
 */
export function servedWindowHasUnservedLines(input: {
  workspaceRoot: string;
  epoch?: string;
  lane?: string;
  path: string;
  sha?: string;
  startLine: number;
  endLine: number;
}): boolean {
  if (
    input.path === ""
    || input.sha === undefined
    || input.sha === ""
    || !Number.isInteger(input.startLine)
    || !Number.isInteger(input.endLine)
    || input.startLine < 1
    || input.endLine < input.startLine
  ) return true;
  const ledger = _servedWindows.get(servedWindowScopeKey(input.workspaceRoot, input.epoch, input.lane));
  if (ledger === undefined) return true;
  const spans = [...ledger.values()]
    .filter((entry) => entry.path === input.path && entry.sha === input.sha)
    .map((entry) => [entry.startLine, entry.endLine] as [number, number])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let cursor = input.startLine;
  for (const [startLine, endLine] of spans) {
    if (endLine < cursor) continue;
    if (startLine > cursor) return true;
    cursor = Math.max(cursor, endLine + 1);
    if (cursor > input.endLine) return false;
  }
  return cursor <= input.endLine;
}

/** Read the scoped window ledger for focused regression specs. */
export function servedWindowLedgerSnapshot(
  workspaceRoot: string,
  epoch?: string,
  lane?: string,
): ServedWindowLedgerEntry[] {
  return [...(_servedWindows.get(servedWindowScopeKey(workspaceRoot, epoch, lane))?.values() ?? [])]
    .map((entry) => ({ ...entry }));
}

export function clearServedWindowsForScope(workspaceRoot: string, epoch?: string, lane?: string): void {
  _servedWindows.delete(servedWindowScopeKey(workspaceRoot, epoch, lane));
}


let _seq = 0;
const _logs = new Map<string, WorkspacePackLog>();

/** Record one response's served bytes and return whether they are novel.
 * `force_serve` is the sole sanctioned bypass of deduplication. */
export function recordServedBytes(input: {
  workspaceRoot: string;
  epoch?: string;
  lane?: string;
  bytes: number;
  digest: string;
  source?: ServedBytesLedgerEntry["source"];
  forceServe?: boolean;
}): { novel: boolean; entry: ServedBytesLedgerEntry } {
  const epoch = input.epoch ?? "default";
  const lane = input.lane ?? "default";
  const key = `${input.workspaceRoot}\u0000${epoch}\u0000${lane}`;
  const ledger = _servedBytes.get(key) ?? new Map<string, ServedBytesLedgerEntry>();
  _servedBytes.set(key, ledger);
  const forced = input.forceServe === true;
  const previous = ledger.get(input.digest);
  const entry = previous !== undefined && !forced
    ? previous
    : {
        epoch,
        lane,
        bytes: Math.max(0, input.bytes),
        digest: input.digest,
        source: input.source ?? "fresh",
        forced,
        sequence: ++_seq,
      } satisfies ServedBytesLedgerEntry;
  if (previous === undefined || forced) ledger.set(input.digest, entry);
  return { novel: previous === undefined || forced, entry };
}

/** Read an immutable snapshot for diagnostics/tests; no caller can mutate the ledger. */
export function servedBytesLedgerSnapshot(workspaceRoot: string, epoch?: string, lane?: string): ServedBytesLedgerEntry[] {
  const key = `${workspaceRoot}\u0000${epoch ?? "default"}\u0000${lane ?? "default"}`;
  return [...(_servedBytes.get(key)?.values() ?? [])].map((entry) => ({ ...entry }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _emptyLog(): WorkspacePackLog {
  return { epochTokens: [], entries: new Map(), order: [], statCache: new Map(), meta: {} };
}

/**
 * F-V13-3 (2026-08-30): the log is keyed by (workspace root, CALLER'S LANE),
 * not the root alone. `laneScopedKey` returns the root string itself when no
 * lane is bound, so a single agent's keys are byte-identical to before.
 *
 * A workspace-only key made every served surface of every concurrent agent one
 * pool. `priorEpochActionFrontier` reads `queryServedSurfaces` to build a
 * certificate's `action_frontier`, so lane A's handles landed in lane B's
 * certificate — the observed F-V13-3 refusal cited a frontier of three files
 * only the OTHER lane had touched. The epoch gate could not stop it: epoch
 * tokens accumulate as a UNION here, so one shared token between two agents'
 * queries leaves the gate open for the rest of the session.
 *
 * The (root, epoch, lane)-keyed `_servedBytes`/`_servedWindows` ledgers above
 * are untouched — they already take an EXPLICIT lane argument from their
 * callers, which stays the more precise contract.
 */
function _logKey(workspaceRoot: string): string {
  return laneScopedKey(workspaceRoot);
}

function _getLog(workspaceRoot: string): WorkspacePackLog {
  const key = _logKey(workspaceRoot);
  let log = _logs.get(key);
  if (log === undefined) {
    log = _emptyLog();
    _logs.set(key, log);
  }
  return log;
}

/**
 * Reset the per-epoch session state (served surfaces + attach-discipline/latch
 * metadata) while preserving the toolchain stat cache — the SINGLE place that
 * defines "a new task epoch starts fresh", used by both the epoch-flip branch of
 * recordServedSurfaces and clearServedSurfaces so the two can never drift.
 */
function _resetSession(log: WorkspacePackLog): void {
  log.epochTokens = [];
  log.entries = new Map();
  log.order = [];
  log.meta = {};
}

/** True when the two token lists share at least one entry (both non-empty). */
function _tokensOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((t) => set.has(t));
}

/**
 * D3 (2026-08-01 probe sweep): session ledger of executed locate calls, so a
 * later pack (observed live: a qref re-pack) can never re-point its next_call
 * at a locate that already ran. Lives in `meta`, so an epoch flip clears it;
 * bounded FIFO of 8 queries.
 *
 * P1-b (2026-08-28 review-fix wave): generalized to every search_files action
 * that can name a "next" — advanceExecutedLocateNextCall's `action !== "locate"`
 * passthrough let find/references/tree re-propose an already-answered search
 * forever (the same class of loop the doc comment above already closed for
 * locate). Keyed by `${action}::${query-or-path}` so the four namespaces never
 * collide; the map field itself keeps its historical name (executedLocates) to
 * avoid touching SessionMetaState's declaration site for a purely-internal
 * rename.
 */
function executedSearchKey(action: string, query: string): string {
  return `${action}::${query}`;
}

export function recordExecutedSearch(
  workspaceRoot: string,
  action: string,
  query: string,
  candidates: readonly string[],
): void {
  if (query.length === 0) return;
  const key = executedSearchKey(action, query);
  const meta = _getLog(workspaceRoot).meta;
  const map = meta.executedLocates ?? (meta.executedLocates = new Map());
  map.delete(key);
  map.set(key, [...candidates].slice(0, 8));
  while (map.size > 8) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** The recorded candidates for an already-executed (action,query) search, if any. */
export function consultExecutedSearch(workspaceRoot: string, action: string, query: string): string[] | undefined {
  return _getLog(workspaceRoot).meta.executedLocates?.get(executedSearchKey(action, query));
}

/**
 * W3 (DESIGN-v0.15-sf-intent-layers.md §4.4a): true when a search of this
 * `action` kind has been recorded ANYWHERE in this task's `executedLocates`
 * ledger, regardless of which query it was keyed to. Unlike
 * `consultExecutedSearch` (which answers for one exact (action,query) pair),
 * this answers "did a `references` call happen THIS TASK at all" — the fact
 * `resolveIntent`'s `referencesObserved` needs, independent of whether the
 * current query happens to repeat that earlier call's exact term.
 */
export function hasExecutedSearchAction(workspaceRoot: string, action: string): boolean {
  const map = _getLog(workspaceRoot).meta.executedLocates;
  if (map === undefined) return false;
  const prefix = `${action}::`;
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

export function recordExecutedLocate(
  workspaceRoot: string,
  query: string,
  candidateHandles: readonly string[],
): void {
  recordExecutedSearch(workspaceRoot, "locate", query, candidateHandles);
}

/** D3: the recorded candidate handles for an already-executed locate, if any. */
export function consultExecutedLocate(workspaceRoot: string, query: string): string[] | undefined {
  return consultExecutedSearch(workspaceRoot, "locate", query);
}

/**
 * Cheap content identity for `relPath`: `<size>:<mtimeMs>`. Returns "" when the
 * file cannot be statted (missing/outside) — an entry recorded with "" never
 * revalidates (fails closed), so a surface whose file we cannot stat is dropped
 * from cumulative coverage rather than trusted stale.
 */
function _fingerprint(workspace: string, relPath: string): string {
  try {
    const st = fs.statSync(path.join(workspace, relPath));
    if (!st.isFile()) return "";
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Served-surface registry
// ---------------------------------------------------------------------------

/**
 * Drop every logged surface for a workspace (epoch reset / taskEpoch:"new").
 * Leaves the toolchain stat cache intact — a new task in the same checkout has
 * the same toolchain — so only the served-surface state is cleared.
 *
 * M1 (2026-09-05 R28 remediation): this WAS a test-only reset hook —
 * `recordServedSurfaces`'s query-token-overlap heuristic was the only
 * production epoch transition, and it never runs at all for a declared
 * `task.profile:"answer"` task (candidate-list packs skip it), so
 * `hasExecutedSearchAction`'s `executedLocates` ledger (what `sfIntent.ts`'s
 * `referencesObserved` reads) survived an EXPLICIT `task.epoch:"new"`
 * indefinitely. Now called directly, lane-aware (via `laneScopedKey`'s
 * `AsyncLocalStorage` binding — the caller need not thread a lane through),
 * from BOTH of `state/session.ts`'s `task.epoch:"new"` reset blocks
 * (`guardExecutionDiscovery` and `guardExecutionEditCore`), at exactly the
 * same point each already clears `WorkspaceSession.intentEditObserved` — see
 * those call sites' own comments. `recordServedSurfaces`'s heuristic reset is
 * UNCHANGED and stays a useful sibling (it also catches a re-pack that
 * carries no explicit `task.epoch:"new"` but plainly asks something
 * unrelated); this is no longer a second, redundant production path — it is
 * the ONLY one an explicit epoch declaration can rely on.
 */
export function clearServedSurfaces(workspaceRoot: string): void {
  const log = _logs.get(_logKey(workspaceRoot));
  if (log === undefined) return;
  _resetSession(log);
}

/**
 * Record the surfaces a freshly-computed pack served, under the task epoch
 * identified by `epochTokens` (the caller derives these via the SAME
 * tokenizeForEpoch session.ts uses, and passes them in — this module never
 * depends on session.ts). A genuinely NEW task (non-empty incoming tokens with
 * ZERO overlap against the stored epoch) resets the log first, so a later
 * unrelated pack cannot be cumulatively "completed" by a previous task's
 * surfaces. Bounded FIFO at MAX_LOGGED_PATHS.
 */
export function recordServedSurfaces(
  workspaceRoot: string,
  workspace: string,
  surfaces: ReadonlyArray<{ path: string; role: string; handle?: string; fullyServed?: boolean }>,
  epochTokens: readonly string[],
): void {
  const log = _getLog(workspaceRoot);
  if (
    epochTokens.length > 0
    && log.epochTokens.length > 0
    && !_tokensOverlap(epochTokens, log.epochTokens)
  ) {
    // A different task in the same session — do not let its surfaces mingle
    // with (or cumulatively complete) the prior task's. Also drops the per-epoch
    // attach-discipline flags and idempotency/obligation latches (W3/W4/W5).
    _resetSession(log);
  }
  // Union epoch tokens (first-seen order), so a re-scoped follow-up query still
  // recognizes the same task.
  const seenTok = new Set(log.epochTokens);
  for (const t of epochTokens) {
    if (!seenTok.has(t)) {
      seenTok.add(t);
      log.epochTokens.push(t);
    }
  }

  for (const s of surfaces) {
    if (typeof s.path !== "string" || s.path.length === 0) continue;
    const fingerprint = _fingerprint(workspace, s.path);
    const entry: ServedSurfaceEntry = {
      path: s.path,
      role: s.role,
      ...(s.handle ? { handle: s.handle } : {}),
      ...(s.fullyServed !== undefined ? { fullyServed: s.fullyServed } : {}),
      fingerprint,
      servedAt: ++_seq,
    };
    if (!log.entries.has(s.path)) log.order.push(s.path);
    log.entries.set(s.path, entry);
    // Content changed since the file was last stat-cached — refresh so a
    // subsequent toolchain/kind probe is not stale.
    log.statCache.delete(s.path);
  }

  // FIFO eviction (oldest-served path first).
  while (log.order.length > MAX_LOGGED_PATHS) {
    const evict = log.order.shift();
    if (evict !== undefined) log.entries.delete(evict);
  }
}

/**
 * Return the still-valid surfaces earlier packs served for this task, EXCLUDING
 * anything in `excludePaths` (the current call's own surfaces). Each consulted
 * entry is revalidated by re-statting: if its content identity no longer
 * matches (the file was edited) the entry is INVALIDATED (removed) and skipped,
 * so a stale surface can never inflate coverage. Returns [] when the stored
 * epoch does not overlap the current query's epoch (a different task).
 */
export function queryServedSurfaces(
  workspaceRoot: string,
  workspace: string,
  opts: { excludePaths?: ReadonlySet<string>; epochTokens: readonly string[] },
): ServedSurfaceEntry[] {
  const log = _logs.get(_logKey(workspaceRoot));
  if (log === undefined || log.entries.size === 0) return [];
  // Epoch gate: a non-overlapping task must not read the prior task's surfaces.
  if (
    opts.epochTokens.length > 0
    && log.epochTokens.length > 0
    && !_tokensOverlap(opts.epochTokens, log.epochTokens)
  ) {
    return [];
  }
  const exclude = opts.excludePaths ?? new Set<string>();
  const out: ServedSurfaceEntry[] = [];
  for (const relPath of [...log.order]) {
    if (exclude.has(relPath)) continue;
    const entry = log.entries.get(relPath);
    if (entry === undefined) continue;
    // Revalidate ONLY consulted entries (stat is cheap but not free).
    const current = _fingerprint(workspace, relPath);
    if (current === "" || current !== entry.fingerprint) {
      // File changed/removed since it was served — invalidate the stale entry.
      log.entries.delete(relPath);
      const idx = log.order.indexOf(relPath);
      if (idx >= 0) log.order.splice(idx, 1);
      log.statCache.delete(relPath);
      continue;
    }
    out.push(entry);
  }
  return out.sort((a, b) => a.servedAt - b.servedAt);
}

/**
 * Explicitly invalidate a path's logged surface (e.g. right after a successful
 * edit touches it). Idempotent.
 */
export function invalidateServedPath(workspaceRoot: string, relPath: string): void {
  const log = _logs.get(_logKey(workspaceRoot));
  if (log === undefined) return;
  if (log.entries.delete(relPath)) {
    const idx = log.order.indexOf(relPath);
    if (idx >= 0) log.order.splice(idx, 1);
  }
  log.statCache.delete(relPath);
}

// ---------------------------------------------------------------------------
// Toolchain stat cache (Improvement D — honest verification signal)
// ---------------------------------------------------------------------------

/**
 * Cached filesystem-kind probe for `relPath` under `workspace`. Trivial fs.stat
 * wrapper, memoized per (workspace, relPath) so repeated toolchain probes in a
 * session don't re-stat the same node_modules/lockfile/pyproject paths. The
 * cache is cleared for a path whenever that path is (re)recorded as served.
 */
export function statKindCached(workspaceRoot: string, workspace: string, relPath: string): StatKind {
  const log = _getLog(workspaceRoot);
  const cached = log.statCache.get(relPath);
  if (cached !== undefined) return cached;
  let kind: StatKind;
  try {
    const st = fs.statSync(path.join(workspace, relPath));
    kind = st.isDirectory() ? "dir" : "file";
  } catch {
    kind = "missing";
  }
  log.statCache.set(relPath, kind);
  return kind;
}

/** True when any of `relPaths` resolves to an existing file (cached). */
export function anyFileExistsCached(workspaceRoot: string, workspace: string, relPaths: readonly string[]): boolean {
  return relPaths.some((p) => statKindCached(workspaceRoot, workspace, p) === "file");
}

/** True when `relPath` resolves to an existing directory (cached). */
export function dirExistsCached(workspaceRoot: string, workspace: string, relPath: string): boolean {
  return statKindCached(workspaceRoot, workspace, relPath) === "dir";
}

// ---------------------------------------------------------------------------
// iter-2 W3: metadata attach-discipline (session-once / attach-on-change)
//
// The iter-1 forensics showed frontier_index (9KB across 6 packs), served_earlier
// (3.5KB repeated every cumulative pack) and the verification verdict (209B ×7)
// were PAID as resident bytes on every later turn but never changed behavior.
// These test-and-set helpers make each field attach only when it carries new
// information, keyed to the active task epoch (reset by _resetSession on a flip).
// ---------------------------------------------------------------------------

/**
 * W3: should the `verification` verdict be attached on THIS pack? True on the
 * first attach of the epoch, or when the verdict signature CHANGED since the
 * last attach (e.g. dependencies got installed) — otherwise the identical ~200B
 * verdict is suppressed. Records `sig` as a side effect when it returns true.
 */
export function shouldAttachVerification(workspaceRoot: string, sig: string): boolean {
  const meta = _getLog(workspaceRoot).meta;
  if (meta.verificationSig === sig) return false;
  meta.verificationSig = sig;
  return true;
}

/**
 * W3: should `served_earlier` be attached on THIS cumulative pack? True only on
 * the FIRST cumulative flip of the epoch; subsequent cumulative packs omit it
 * (the model already holds the earlier surfaces). Sets the flag when true.
 */
export function shouldAttachServedEarlier(workspaceRoot: string): boolean {
  const meta = _getLog(workspaceRoot).meta;
  if (meta.servedEarlierAttached === true) return false;
  meta.servedEarlierAttached = true;
  return true;
}

/**
 * W3: should `frontier_index` be attached on THIS pack? True on the first attach
 * of the epoch, or when the inventory signature CHANGED since the last attach —
 * otherwise the identical inventory is suppressed (the model navigates the copy
 * it already holds). Records `sig` when it returns true.
 */
export function shouldAttachFrontierIndex(workspaceRoot: string, sig: string): boolean {
  const meta = _getLog(workspaceRoot).meta;
  if (meta.frontierIndexSig === sig) return false;
  meta.frontierIndexSig = sig;
  return true;
}

// ---------------------------------------------------------------------------
// iter-2 W4: awaiting-input idempotency latch
// ---------------------------------------------------------------------------

/** W4: record (or replace) the active awaiting-input latch for this epoch. */
export function recordAwaitingInputLatch(workspaceRoot: string, latch: AwaitingInputLatch): void {
  _getLog(workspaceRoot).meta.awaitingInput = latch;
}

/**
 * W4: consult the awaiting-input latch for a pack that would otherwise certify.
 * Returns the latch (so the caller re-emits the same awaiting-input verdict)
 * when it STILL holds; returns undefined — and CLEARS the latch — when it has
 * been resolved. Resolution / non-applicability:
 *   - epoch does not overlap  → different task, undefined (latch untouched).
 *   - a caller input path is NOT in the latch's recorded set → genuinely new
 *     input supplied → clear + undefined.
 *   - the referenced files changed (fingerprint mismatch) → clear + undefined.
 * Otherwise the proof is still unresolved and the same inputs are in hand → the
 * latch holds.
 */
export function consultAwaitingInputLatch(
  workspaceRoot: string,
  epochTokens: readonly string[],
  currentInputPaths: readonly string[],
  currentFileFingerprint: string,
): AwaitingInputLatch | undefined {
  const log = _logs.get(_logKey(workspaceRoot));
  const latch = log?.meta.awaitingInput;
  if (log === undefined || latch === undefined) return undefined;
  // Different task in the same session — never latch across tasks.
  if (
    epochTokens.length > 0
    && log.epochTokens.length > 0
    && !_tokensOverlap(epochTokens, log.epochTokens)
  ) {
    return undefined;
  }
  // Genuinely new input beyond what the awaiting-input pack already had clears it.
  const known = new Set(latch.inputPaths);
  if (currentInputPaths.some((p) => p.length > 0 && !known.has(p))) {
    log.meta.awaitingInput = undefined;
    return undefined;
  }
  // The referenced files changing (a new/edited unserved implementation, or the
  // artifact source being supplied) clears it.
  if (currentFileFingerprint !== latch.fileFingerprint) {
    log.meta.awaitingInput = undefined;
    return undefined;
  }
  return latch;
}

/** W4: explicitly clear the awaiting-input latch (e.g. once genuinely prepared). */
export function clearAwaitingInputLatch(workspaceRoot: string): void {
  const log = _logs.get(_logKey(workspaceRoot));
  if (log?.meta.awaitingInput !== undefined) log.meta.awaitingInput = undefined;
}

// ---------------------------------------------------------------------------
// iter-2 W5: functional-validation obligation
// ---------------------------------------------------------------------------

/** W5: record (or replace) the open functional-validation obligation for this epoch. */
export function recordFunctionalValidationObligation(
  workspaceRoot: string,
  obligation: FunctionalValidationObligation,
): void {
  _getLog(workspaceRoot).meta.functionalValidation = obligation;
}

/**
 * W5: the open functional-validation obligation for the active epoch, or
 * undefined when none stands / the epoch does not overlap. A mode=closure /
 * self-check consult reads this to list the obligation as an OPEN item.
 */
export function getFunctionalValidationObligation(
  workspaceRoot: string,
  epochTokens: readonly string[],
): FunctionalValidationObligation | undefined {
  const log = _logs.get(_logKey(workspaceRoot));
  const obligation = log?.meta.functionalValidation;
  if (log === undefined || obligation === undefined) return undefined;
  if (
    epochTokens.length > 0
    && log.epochTokens.length > 0
    && !_tokensOverlap(epochTokens, log.epochTokens)
  ) {
    return undefined;
  }
  return obligation;
}

/**
 * W5: clear the functional-validation obligation — call when a
 * verification-evidence event (a diff/test/closure self-check over the target)
 * is observed, since the obligation has then been discharged (or at least
 * acted on). Idempotent.
 */
export function clearFunctionalValidationObligation(workspaceRoot: string): void {
  const log = _logs.get(_logKey(workspaceRoot));
  if (log?.meta.functionalValidation !== undefined) log.meta.functionalValidation = undefined;
}

// ---------------------------------------------------------------------------
// Test hook
// ---------------------------------------------------------------------------

/**
 * Successful dispatcher actions keyed by workspace and session lane.  This is
 * deliberately separate from served-byte accounting: an empty/absent result
 * still consumes a prescribed next and must not be issued again unchanged.
 */
interface ExecutedNextRecord { taskEpoch?: string; resultDigest?: string; }
const _executedNextFingerprints = new Map<string, Map<string, ExecutedNextRecord>>();

// ---------------------------------------------------------------------------
// TL142-01A/01B (2026-09-13, v0.14.2 hands-on report §4 TL142-01) —
// THE RESULT-CARRYING EXECUTED-SEARCH LEDGER.
//
// Every ledger above this line is PURELY NEGATIVE. `_executedNextFingerprints`
// remembers "this exact call shape was spent"; the served-range ledger
// remembers "these bytes crossed the wire"; `executedLocates` remembers a
// `locate`'s candidate HANDLES and nothing for any other action (server.ts
// records `find`/`references`/`tree` there with a deliberately EMPTY candidate
// list, so that store can only ever suppress a repeat, never use a result).
//
// So when a pack asks the caller to run `search_files find <identifier>` and
// the caller runs it, the fact the search ESTABLISHED — "the symbol is at
// src/auth.ts:7", or "the token occurs in no scanned file" — is discarded. The
// next rebuild of that task re-derives everything from scratch, and when its
// own upstream classification does not independently reach the same
// conclusion, the decision degrades with nothing to catch it: 01A rotates
// through an already-served surface and a redundant re-search, 01B answers a
// proven absence with `await_input:"no-grounded-call-remains"`.
//
// This store is the missing POSITIVE half. Same lifetime, same key shape and
// the same bound/LRU discipline as `_executedNextFingerprints` (so nothing new
// has to be reasoned about for cleanup or growth), and deliberately
// IN-MEMORY: a restart loses it, exactly as a restart loses the executed-call
// ledger, and a task resumed after a restart falls back to today's behaviour
// (re-propose the search) rather than to a false claim.
//
// KEYING. One entry per (ledger key, TERM) — the term exactly as the caller
// spelled it, case-sensitive, with NO action in the key. `find`, `symbols` and
// `locate` are three spellings of one question ("where is this term"), and the
// shapes a pack proposes and a caller executes differ freely in ways that are
// not semantic (`queries:["t"]` vs `query:"t"`, with or without
// `scope.kind:"symbol"`). Keying on the action is exactly the mistake
// `consultExecutedLocate` made — hard-wired to `"locate"`, so it could never
// answer for the `find` the pack itself proposes. `references` and `tree`
// answer DIFFERENT questions and are deliberately not recorded here.
// ---------------------------------------------------------------------------

/** One recorded location for an executed term search. */
export interface ExecutedSearchHit {
  readonly path: string;
  /** 1-based line, when the executing response named one (`find`'s `lines[0]`, `symbols`' `line`). */
  readonly line?: number;
  /** The enclosing/declared symbol, when the executing response named one (`symbols` does; `find` does not). */
  readonly symbol?: string;
}

/**
 * A scope-COMPLETE absence verdict. Recorded only from a workspace-wide,
 * literal, un-narrowed search whose own absence certificate carried no
 * `caveat` (findText.ts's `FindAbsence`: a caveat means paths were excluded,
 * so the claim is not about the workspace). A partial-scope zero-result is NOT
 * a proof and is never recorded — the pack keeps proposing the search, which
 * is the fail-closed direction.
 */
export interface ExecutedSearchAbsence {
  readonly scannedFiles: number;
  /**
   * R1-B1 (2026-09-13 review round): the recording response's OWN disclosed
   * exclusion count (`omitted`, minus `outside_workspace` which cannot hide an
   * in-workspace occurrence), carried instead of asserted downstream.
   *
   * A proof is recorded only when this is 0 — but `promoteExecutedSearchAbsences`
   * previously hard-coded `omitted_count: 0` on the WIRE gap it mints, so the
   * projection asserted a fact it had never been told. Carrying it means the
   * certificate says what the search actually established, and a future recorder
   * that relaxes the gate cannot make the projection lie on its behalf.
   */
  readonly omittedCount: number;
  /**
   * R1-B1: true only when the recording response's own absence certificate was
   * workspace-wide, literal, un-narrowed AND caveat-free (server.ts's
   * `provenFindAbsence`). Consumers MUST check it rather than assume it: the
   * `queries[]` find branch used to read per-term `scope.completeness`, which
   * `findText.ts` stamps `"complete"` for any issued per-term absence — dropping
   * the `caveat` the same certificate carried, so a `.tokenlightenignore`d or
   * unreadable path silently backed a "scope complete" claim.
   */
  readonly scopeComplete: boolean;
  /**
   * R2-B14 (2026-09-13 review round 2): WALL-CLOCK WITNESS OF WHEN THE SCAN RAN.
   *
   * An absence is a claim about the workspace AT A MOMENT. Nothing invalidated
   * one: hits are re-statted on every promotion (`executedSearchHitSeeds`), but
   * an absence was projected onto a CERTIFIED decision forever — so creating the
   * term's declaring file mid-task produced one response that both served
   * `src/quantum.ts` and certified `request-item-absent:quantumTeleportationMode
   * (… scope complete)`.
   *
   * `promoteExecutedSearchAbsences` compares this against the mtime of every
   * surface the pack is serving: a surface younger than the scan is content the
   * scan cannot have seen, so the proof is stale and the search is re-proposed.
   * Optional because the invalidation must not DEPEND on it — the "the term
   * occurs in a served body" check runs unconditionally and is what closes the
   * reported input.
   */
  readonly recordedAtMs?: number;
}

export interface ExecutedSearchResult {
  /** The term exactly as executed (case-sensitive). */
  readonly term: string;
  /** Which action produced this result — provenance for traces, never part of the key. */
  readonly action: string;
  readonly hits: readonly ExecutedSearchHit[];
  /** Present only for a proven, scope-complete absence; mutually exclusive with a non-empty `hits`. */
  readonly absence?: ExecutedSearchAbsence;
  /**
   * Monotonic recording sequence, from this module's shared `_seq`.
   *
   * This is the staleness clock a compact "nothing changed" re-serve needs. A
   * stored pack record captures the sequence that was current when it was
   * built; if the live sequence has since moved, a search result landed AFTER
   * that capture, so re-serving the record as unchanged would deny a proof the
   * caller has already established (TL142-01A/01B's receipt door). Assigned by
   * `recordExecutedSearchResult`, never by a caller.
   */
  readonly sequence: number;
}

const _executedSearchResults = new Map<string, Map<string, ExecutedSearchResult>>();

/** Bound on distinct (workspace, lane, task) result ledgers — mirrors MAX_EXECUTED_NEXT_LEDGERS. */
export const MAX_EXECUTED_SEARCH_RESULT_LEDGERS = 256;
/** Bound on distinct terms tracked per ledger. */
export const MAX_EXECUTED_SEARCH_RESULT_TERMS = 64;
/** Bound on hits retained per term (a promotion reads the first few; an unbounded list is a leak). */
export const MAX_EXECUTED_SEARCH_RESULT_HITS = 8;

function touchExecutedSearchResultLedger(key: string, ledger: Map<string, ExecutedSearchResult>): void {
  _executedSearchResults.delete(key);
  _executedSearchResults.set(key, ledger);
  while (_executedSearchResults.size > MAX_EXECUTED_SEARCH_RESULT_LEDGERS) {
    const oldest = _executedSearchResults.keys().next().value;
    if (oldest === undefined) break;
    _executedSearchResults.delete(oldest);
  }
}

/**
 * Record what an executed term search FOUND (or proved absent).
 *
 * Idempotent-by-replacement per term: a later execution of the same term
 * supersedes an earlier one (the workspace may have changed between them, and
 * the fresher answer is the true one). A record with neither hits nor a proven
 * absence is still stored — it says "this term was searched and settled
 * nothing", which is what stops a rebuild re-proposing it as if it were new.
 */
export function recordExecutedSearchResult(
  workspaceRoot: string,
  lane: string,
  result: Omit<ExecutedSearchResult, "sequence">,
  taskBinding?: string,
): void {
  if (result.term.length === 0) return;
  const key = executedNextLedgerKey(workspaceRoot, lane, taskBinding);
  const ledger = _executedSearchResults.get(key) ?? new Map<string, ExecutedSearchResult>();
  ledger.delete(result.term);
  ledger.set(result.term, {
    term: result.term,
    action: result.action,
    hits: result.hits.slice(0, MAX_EXECUTED_SEARCH_RESULT_HITS),
    ...(result.absence !== undefined ? { absence: result.absence } : {}),
    sequence: ++_seq,
  });
  while (ledger.size > MAX_EXECUTED_SEARCH_RESULT_TERMS) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
  touchExecutedSearchResultLedger(key, ledger);
}

/**
 * What an executed search established for `term`, or undefined.
 *
 * BOUND FIRST, UNBOUND SECOND — the same two-partition question
 * `hasExecutedNextBoundOrUnbound` asks the executed-call ledger, and for the
 * identical reason: a `find` the dispatcher could bind to a resolved task
 * handle lands in the task partition, while the same call issued before a
 * handle existed lands in the unbound one. A rebuild that checked only its own
 * recovered binding would miss half the executions it is meant to learn from.
 */
export function consultExecutedSearchResult(
  workspaceRoot: string,
  lane: string,
  term: string,
  taskBinding?: string,
): ExecutedSearchResult | undefined {
  if (term.length === 0) return undefined;
  const bound = _executedSearchResults
    .get(executedNextLedgerKey(workspaceRoot, lane, taskBinding))
    ?.get(term);
  if (bound !== undefined) return bound;
  if (taskBinding === undefined || taskBinding === "") return undefined;
  return _executedSearchResults.get(executedNextLedgerKey(workspaceRoot, lane))?.get(term);
}

// ---------------------------------------------------------------------------
// R1-S10a (2026-09-13 review round): WHICH TERMS A PACK ACTUALLY ASKED THE
// CALLER TO SEARCH FOR.
//
// The result ledger above is certificate-grade state: a hit becomes a surface of
// the next rebuild, and a proven absence becomes a `request-item-absent` gap on a
// CERTIFIED decision. It was written by EVERY find/symbols/locate, prescribed or
// not, while the sibling concern recorders in server.ts have always required a
// server-prescribed call (`consumeExecutableNextScope`). So a search no pack ever
// asked for could move a task's decision.
//
// The obvious fence — the executable-next registry in taskContractStore.ts — does
// not answer this question for the packs that need it: that registry is fed from
// `effectiveContract.next_call`, and the answer-pack `discover` shape that
// prescribes an identifier find carries its next on the WIRE decision with
// `next_call` unset (measured: `R1DBG-reg next=undefined` while
// `decision.next = search_files find [..]`). That is exactly why the pre-existing
// fenced recorders never fire on those chains — and a fence that is always shut
// would not make the ledger honest, it would delete the feature.
//
// So the prescription is recorded where it is actually made, keyed by TERM — the
// orchestrator's "equivalent prescribed-next check on term equality". Same key
// shape, bounds and LRU discipline as the ledgers above.
//
// LANE-LEVEL, deliberately and narrowly: written to the unbound partition and
// read through the same bound-then-unbound merge the result ledger uses, because
// the question is "did a pack in this lane ask about this term", and a
// prescription is made before the caller's own execution has any binding to speak
// of. It is a necessary condition, never a sufficient one: every consumer of the
// result ledger additionally requires the term to appear VERBATIM in its own
// query, so one task's prescription cannot authorize learning for another's.
// ---------------------------------------------------------------------------

const _prescribedSearchTerms = new Map<string, Set<string>>();

/** Bound on distinct prescribed terms tracked per ledger — mirrors MAX_EXECUTED_SEARCH_RESULT_TERMS. */
export const MAX_PRESCRIBED_SEARCH_TERMS = 64;

/** Record that a pack prescribed a term search (find/symbols/locate) in this lane. */
export function recordPrescribedSearchTerms(
  workspaceRoot: string,
  lane: string,
  terms: readonly string[],
  taskBinding?: string,
): void {
  const key = executedNextLedgerKey(workspaceRoot, lane, taskBinding);
  const ledger = _prescribedSearchTerms.get(key) ?? new Set<string>();
  for (const term of terms) {
    if (term.length === 0) continue;
    ledger.delete(term);
    ledger.add(term);
  }
  while (ledger.size > MAX_PRESCRIBED_SEARCH_TERMS) {
    const oldest = ledger.values().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
  _prescribedSearchTerms.delete(key);
  _prescribedSearchTerms.set(key, ledger);
  while (_prescribedSearchTerms.size > MAX_EXECUTED_SEARCH_RESULT_LEDGERS) {
    const oldest = _prescribedSearchTerms.keys().next().value;
    if (oldest === undefined) break;
    _prescribedSearchTerms.delete(oldest);
  }
}

/** Did a pack in this lane (bound partition first, then unbound) prescribe a search for `term`? */
export function hasPrescribedSearchTerm(
  workspaceRoot: string,
  lane: string,
  term: string,
  taskBinding?: string,
): boolean {
  if (term.length === 0) return false;
  if (_prescribedSearchTerms.get(executedNextLedgerKey(workspaceRoot, lane, taskBinding))?.has(term) === true) return true;
  return _prescribedSearchTerms.get(executedNextLedgerKey(workspaceRoot, lane))?.has(term) === true;
}

/**
 * Every term this task has already searched, newest last — the two partitions
 * merged the same way `consultExecutedSearchResult` prefers them (a bound
 * record wins over an unbound one for the same term).
 */
export function executedSearchResults(
  workspaceRoot: string,
  lane: string,
  taskBinding?: string,
): ExecutedSearchResult[] {
  const merged = new Map<string, ExecutedSearchResult>();
  if (taskBinding !== undefined && taskBinding !== "") {
    for (const entry of _executedSearchResults.get(executedNextLedgerKey(workspaceRoot, lane))?.values() ?? []) {
      merged.set(entry.term, entry);
    }
  }
  for (const entry of _executedSearchResults.get(executedNextLedgerKey(workspaceRoot, lane, taskBinding))?.values() ?? []) {
    merged.set(entry.term, entry);
  }
  return [...merged.values()];
}

/**
 * The highest recording sequence this task has, or 0.
 *
 * The staleness clock `ServedPackRecord.executedSearchSequence` compares
 * against — see `ExecutedSearchResult.sequence`. Both partitions are consulted
 * for the same reason `consultExecutedSearchResult` consults both: an execution
 * the dispatcher could bind and one it could not are the same task's work.
 */
export function executedSearchResultSequence(
  workspaceRoot: string,
  lane: string,
  taskBinding?: string,
): number {
  let highest = 0;
  for (const entry of executedSearchResults(workspaceRoot, lane, taskBinding)) {
    if (entry.sequence > highest) highest = entry.sequence;
  }
  return highest;
}

/**
 * P1-c(ii) (2026-08-28 review-fix wave): named bounds + LRU, the same
 * discipline as MAX_LOGGED_PATHS above and MAX_TASK_CONTRACTS_PER_LANE in
 * taskContractStore.ts (A-1's boundedness regulation applied to this store's
 * sibling ledger). Without these, a long-running server accumulates one
 * inner Map per distinct (workspace, lane) forever, and each inner Map grows
 * one entry per distinct (tool, action, args) shape forever.
 */
export const MAX_EXECUTED_NEXT_LEDGERS = 256;
/** Bound on distinct fingerprints tracked per (workspace, lane) ledger. */
export const MAX_EXECUTED_NEXT_FINGERPRINTS_PER_LEDGER = 128;

/** LRU-touch one (workspace,lane) ledger and evict the oldest once the named bound is exceeded. */
function touchExecutedNextLedger(key: string, ledger: Map<string, ExecutedNextRecord>): void {
  _executedNextFingerprints.delete(key);
  _executedNextFingerprints.set(key, ledger);
  while (_executedNextFingerprints.size > MAX_EXECUTED_NEXT_LEDGERS) {
    const oldest = _executedNextFingerprints.keys().next().value;
    if (oldest === undefined) break;
    _executedNextFingerprints.delete(oldest);
  }
}

/**
 * A-F1 (2026-08-28): THE ONE LANE NORMALIZATION for every contract-scoped
 * ledger.
 *
 * Two spellings of "no lane was declared" existed side by side — the dispatch
 * helper's `""` (the *session* lane's own sentinel, where empty legitimately
 * means "the historical shared session") and the contract stores' `"default"`.
 * The executed-next ledger inherited both: the writer keyed on `""` while both
 * readers (the shared producer exit and suppressNonProgressingNextCall) keyed
 * on `"default"`, so on the DEFAULT path — lane omitted, which is what a single
 * agent always sends — the no-repeat gate silently addressed an empty
 * partition and a prescribed find whose absence had already been proved was
 * re-issued verbatim. Every store that keys on a lane routes through here, and
 * the ledger accessors below normalize again at the boundary so a future caller
 * cannot reopen the split by passing the other spelling.
 */
export const DEFAULT_CONTRACT_LANE = "default";

export function normalizeContractLane(lane: unknown): string {
  const trimmed = typeof lane === "string" ? lane.trim() : "";
  return trimmed.length > 0 ? trimmed : DEFAULT_CONTRACT_LANE;
}

/**
 * P1-c(iii) / D-4 integration (2026-08-29): fingerprint the semantic call,
 * not whichever request spelling happened to reach this boundary. Producers
 * still construct legacy read/search arguments, while the single envelope
 * funnel projects every emitted carrier to the canonical public schema. A
 * canonical call executed verbatim must therefore consume the producer's
 * legacy candidate. The normalizer below mirrors that projection for the two
 * executable-next tools, excludes routing-only cwd/lane/task handles, sorts
 * nested object keys, and keeps action in its own discriminating tuple slot.
 */
function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFingerprintValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, stableFingerprintValue(record[key])]),
  );
}

function semanticTask(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const task = { ...recordValue(args["task"]) };
  // Task handles identify the continuation carrier, not the work performed by
  // its next. Legacy fingerprints already excluded task_handle for this reason.
  delete task["handle"];
  const mappings: ReadonlyArray<readonly [string, string]> = [
    ["taskEpoch", "epoch"],
    ["taskProfile", "profile"],
    ["expected_state_version", "expected_state_version"],
    ["challenge", "challenge"],
    ["force_serve", "force_serve"],
  ];
  for (const [legacy, canonical] of mappings) {
    if (task[canonical] === undefined && args[legacy] !== undefined) task[canonical] = args[legacy];
  }
  if (task["pull"] === undefined && args["mode"] === "closure") task["pull"] = "closure";
  return Object.keys(task).length > 0 ? task : undefined;
}

function semanticBudget(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const budget = { ...recordValue(args["budget"]) };
  const mappings: ReadonlyArray<readonly [string, string]> = [
    ["maxBytes", "bytes"],
    ["maxTokens", "tokens"],
    ["limit", "items"],
    ["maxRows", "rows"],
    ["maxCells", "cells"],
    ["allowFull", "allowFull"],
  ];
  for (const [legacy, canonical] of mappings) {
    if (budget[canonical] === undefined && args[legacy] !== undefined) budget[canonical] = args[legacy];
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function semanticScope(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const scope = { ...recordValue(args["scope"]) };
  for (const key of [
    "path",
    "credentialRef",
    "lang",
    "regex",
    "depth",
    "includeClosure",
    "surfaceRoles",
    "includeScores",
    "archive",
    "kind",
  ]) {
    if (scope[key] === undefined && args[key] !== undefined) scope[key] = args[key];
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

function semanticReadTargets(args: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(args["targets"])) {
    return args["targets"]
      .map((value) => recordValue(value))
      .filter((value) => value["path"] !== undefined || value["handle"] !== undefined);
  }
  const common: Record<string, unknown> = {};
  for (const key of ["credentialRef", "range", "ranges", "symbol", "profile", "lang"]) {
    if (args[key] !== undefined) common[key] = args[key];
  }
  const targetFor = (value: unknown): Record<string, unknown> | undefined => {
    const source = typeof value === "string" ? { path: value } : recordValue(value);
    const target = { ...common };
    for (const key of ["path", "handle", "credentialRef", "range", "ranges", "symbol", "purpose", "profile", "lang", "archive"]) {
      if (source[key] !== undefined) target[key] = source[key];
    }
    const archive = recordValue(target["archive"]);
    if (target["path"] === undefined && archive["path"] !== undefined) target["path"] = archive["path"];
    return target["path"] !== undefined || target["handle"] !== undefined ? target : undefined;
  };
  const paths = Array.isArray(args["paths"]) ? args["paths"].map(targetFor) : [];
  const handles = Array.isArray(args["handles"])
    ? args["handles"].map((handle) => targetFor({ handle }))
    : [];
  const direct = args["path"] !== undefined || args["handle"] !== undefined || args["archive"] !== undefined
    ? targetFor({ path: args["path"], handle: args["handle"], archive: args["archive"] })
    : undefined;
  return [...paths, ...handles, ...(direct === undefined ? [] : [direct])]
    .filter((target): target is Record<string, unknown> => target !== undefined);
}

function semanticNextArguments(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (tool !== "read_file" && tool !== "search_files") {
    return Object.fromEntries(Object.entries(args)
      .filter(([key]) => key !== "cwd" && key !== "lane" && key !== "task_handle" && key !== "taskBinding"));
  }
  const out: Record<string, unknown> = {};
  const task = semanticTask(args);
  const budget = semanticBudget(args);
  if (task !== undefined) out["task"] = task;
  if (budget !== undefined) out["budget"] = budget;

  if (tool === "search_files") {
    const scope = semanticScope(args) ?? {};
    let action = args["action"];
    if (action === "symbols") {
      action = "find";
      if (scope["kind"] === undefined) scope["kind"] = "symbol";
    } else if (action === "locate") {
      action = "tree";
      if (scope["includeClosure"] === undefined) scope["includeClosure"] = true;
    }
    if (action !== undefined) out["action"] = action;
    const queries = Array.isArray(args["queries"])
      ? args["queries"]
      : typeof args["query"] === "string" ? [args["query"]] : [];
    if (queries.length > 0) out["queries"] = queries;
    if (Object.keys(scope).length > 0) out["scope"] = scope;
    if (args["cursor"] !== undefined) out["cursor"] = args["cursor"];
    return out;
  }

  if (args["query"] !== undefined) out["query"] = args["query"];
  if (args["qref"] !== undefined) out["qref"] = args["qref"];
  const targets = semanticReadTargets(args);
  if (targets.length > 0) out["targets"] = targets;
  const mode = args["mode"];
  const content = args["content"];
  if (content === "full" || content === "outline" || content === "auto") out["content"] = content;
  else if (Array.isArray(args["handles"]) || mode === "full") out["content"] = "full";
  else if (mode === "skeleton" || mode === "map" || mode === "overview" || mode === "digest") out["content"] = "outline";
  else if (mode !== "task_pack" && mode !== "closure" && targets.length > 0) out["content"] = "auto";

  const select = { ...recordValue(args["select"]) };
  for (const key of ["kind", "comments", "sheet", "rows", "columns", "sections", "slides", "pages"]) {
    if (select[key] === undefined && args[key] !== undefined) select[key] = args[key];
  }
  if (select["format"] === undefined && args["as"] !== undefined) select["format"] = args["as"];
  if (Object.keys(select).length > 0) out["select"] = select;
  const rawScope = recordValue(args["scope"]);
  const readScope: Record<string, unknown> = {};
  for (const key of ["includeClosure", "surfaceRoles"]) {
    const value = rawScope[key] ?? args[key];
    if (value !== undefined) readScope[key] = value;
  }
  if (Object.keys(readScope).length > 0) out["scope"] = readScope;
  return out;
}

export function nextFingerprint(tool: string, args: Record<string, unknown>): string {
  const semantic = semanticNextArguments(tool, args);
  const { action, ...rest } = semantic;
  const actionKey = typeof action === "string" && action.length > 0 ? action : null;
  return JSON.stringify([tool, actionKey, stableFingerprintValue(rest)]);
}

/**
 * The result-consumption ledger is normally lane-scoped for backwards
 * compatibility.  Once a live task handle has been resolved, however, a
 * continuation belongs to that canonical task identity, not every task that
 * happens to share a workspace/lane and an identical next-call shape.
 *
 * `taskBinding` is server-derived (the handle's stored task fingerprint), so
 * it is never accepted from or emitted to the wire.  Empty/absent retains the
 * historical key byte-for-byte for callers without durable task state.
 */
function executedNextLedgerKey(workspaceRoot: string, lane: string, taskBinding?: string): string {
  const base = `${workspaceRoot}\u0000${normalizeContractLane(lane)}`;
  return typeof taskBinding === "string" && taskBinding.length > 0
    ? `${base}\u0000task:${taskBinding}`
    : base;
}

export function recordExecutedNext(
  workspaceRoot: string,
  lane: string,
  tool: string,
  args: Record<string, unknown>,
  resultDigest?: string,
  taskBinding?: string,
): boolean {
  const key = executedNextLedgerKey(workspaceRoot, lane, taskBinding);
  const fingerprint = nextFingerprint(tool, args);
  let seen = _executedNextFingerprints.get(key);
  if (seen === undefined) {
    seen = new Map();
  }
  const repeated = seen.has(fingerprint);
  seen.delete(fingerprint);
  seen.set(fingerprint, {
    ...(typeof args["taskEpoch"] === "string" ? { taskEpoch: args["taskEpoch"] } : {}),
    ...(resultDigest !== undefined ? { resultDigest } : {}),
  });
  while (seen.size > MAX_EXECUTED_NEXT_FINGERPRINTS_PER_LEDGER) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  touchExecutedNextLedger(key, seen);
  return repeated;
}

export function hasExecutedNext(
  workspaceRoot: string,
  lane: string,
  tool: string,
  args: Record<string, unknown>,
  taskBinding?: string,
): boolean {
  return _executedNextFingerprints.get(executedNextLedgerKey(workspaceRoot, lane, taskBinding))?.has(nextFingerprint(tool, args)) ?? false;
}

/**
 * G3 (2026-09-08, qref-binding fix): the same "bound first, unbound fallback"
 * question the P1-1 receipt witnesses already ask this ledger
 * (`features/task-pack/readCodeTaskPack.ts`'s `receiptNextAlreadyExecuted`),
 * generalized so the FRESH-BUILD no-repeat gates can ask it too —
 * `suppressNonProgressingNextCall`/`alternativeProgressAxis` in that same
 * file, and `server.ts`'s wire-level `consumed` predicate
 * (`recordTaskPackExecution`).
 *
 * WHY BOTH PARTITIONS. A handleless re-pack can now recover a task's
 * canonical binding from its `qref` (`state/session.ts`'s
 * `resolveTaskQueryRefBinding`) even though the CALL BEING CHECKED never
 * carried an explicit `task.handle`. But two different producer shapes
 * disagree on which partition an execution was recorded under: a `next` that
 * itself restates `task.handle` (e.g. a re-scope call) is recorded under that
 * handle's resolved fingerprint (`canonicalTaskBindingForExecutedCall`
 * resolves it directly from the call's own args), while a `next` with no
 * task fields at all — the shape a plain content read's `next` has — is
 * always recorded under the unbound partition, because that resolver only
 * attempts a registered-scope lookup for `search_files`. Checking the
 * recovered binding FIRST (most specific — matches a caller that supplies
 * its own `task.handle` exactly as before) and the unbound partition SECOND
 * (the historical fallback, still written today) finds either shape without
 * weakening the existing bound check.
 */
export function hasExecutedNextBoundOrUnbound(
  workspaceRoot: string,
  lane: string,
  tool: string,
  args: Record<string, unknown>,
  taskBinding?: string,
): boolean {
  if (hasExecutedNext(workspaceRoot, lane, tool, args, taskBinding)) return true;
  return taskBinding !== undefined && taskBinding !== "" && hasExecutedNext(workspaceRoot, lane, tool, args);
}

/**
 * R1 (2026-08-28): the exact inverse of ONE `recordExecutedNext`, for the
 * dispatcher's in-flight pre-record only.
 *
 * The ledger means "this call shape has been spent on this lane". A call is
 * spent the moment it is dispatched — that is what makes re-proposing it
 * non-progressing — so the dispatcher now records it BEFORE the response that
 * must see it is built (server.ts's in-flight pre-record). A call that then
 * FAILS was not spent in the sense the ledger asserts, so the pre-record is
 * withdrawn; `recordExecutedNext` reports whether the fingerprint was already
 * present, and only a pre-record that introduced it is ever withdrawn, so a
 * genuinely earlier execution of the same shape survives a later failure.
 */
export function forgetExecutedNext(
  workspaceRoot: string,
  lane: string,
  tool: string,
  args: Record<string, unknown>,
  taskBinding?: string,
): void {
  _executedNextFingerprints
    .get(executedNextLedgerKey(workspaceRoot, lane, taskBinding))
    ?.delete(nextFingerprint(tool, args));
}

/**
 * E2 (2026-09-05, measured on paid smoke r9 / SF13): the paths this TASK EPOCH
 * has already served, stamped onto a pack result under a SYMBOL key.
 *
 * A symbol property is invisible to `JSON.stringify` and to `Object.keys`, so
 * this carries the epoch's served ledger to the wire-side continuation
 * projectors (`discoveryBundleNext`, which has no workspace handle of its own)
 * without adding a single response byte or a new wire field to strip.
 */
const EPOCH_SERVED_PATHS_KEY = Symbol.for("tokenlighten.epochServedPaths");

/**
 * Stamp the epoch's already-served paths onto `target`. Silently ignores a non-object.
 *
 * MUST be `enumerable: true` — this is what survives `{ ...result }`. The
 * dispatch path copies the task_pack result object at least twice before
 * `discoveryBundleNext` ever reads this ledger (`attachSupply.ts`'s
 * `{ ...result }` shallow copy, then `server.ts`'s own `{ ...suppliedBase,
 * qref }` spread) — a non-enumerable Symbol-keyed property does not survive
 * an object spread, so it would be silently dropped before the one call site
 * that consumes it, making the cross-call half of E2 dead in production
 * while still passing a unit test that stamps and reads the same raw object
 * literal. This mirors the `SF_CONTEXT_TOKEN_KEY` precedent in
 * `sfSatisfaction.ts` (see the comment above `attachSupply.ts`'s spread) —
 * do not flip this back to `enumerable: false`. Still zero wire bytes:
 * `JSON.stringify` never serialises Symbol-keyed properties, enumerable or
 * not, and no wire projector iterates `Object.keys`/`Object.entries`/`for
 * ... in` over the raw result object to leak it either.
 */
export function stampEpochServedPaths(target: unknown, paths: Iterable<string>): void {
  if (target === null || typeof target !== "object") return;
  Object.defineProperty(target, EPOCH_SERVED_PATHS_KEY, {
    value: new Set(paths),
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Paths an earlier call in this epoch already served, or an empty set. */
export function epochServedPaths(target: unknown): ReadonlySet<string> {
  if (target === null || typeof target !== "object") return new Set<string>();
  const value = (target as Record<symbol, unknown>)[EPOCH_SERVED_PATHS_KEY];
  return value instanceof Set ? value as ReadonlySet<string> : new Set<string>();
}

/** Focused regression seam for result-consumption bindings. */
export function executedNextRecordForTest(
  workspaceRoot: string,
  lane: string,
  tool: string,
  args: Record<string, unknown>,
  taskBinding?: string,
): ExecutedNextRecord | undefined {
  return _executedNextFingerprints.get(executedNextLedgerKey(workspaceRoot, lane, taskBinding))?.get(nextFingerprint(tool, args));
}

/**
 * P1-c(i) (2026-08-28): `taskEpoch:"new"` is the documented epoch boundary
 * (server.ts's `args["taskEpoch"] === "new"` branch, via
 * readCodeTaskPack.ts's `clearPackDedupeForWorkspace`) every other per-lane
 * task-scoped store already forgets itself at — `taskContractStore`'s
 * `clearTaskContractsForLane` and `priorPackStore`'s
 * `clearPriorPackObligations` are called from that exact function. This
 * store was the omission: without it, an executed-next fingerprint from an
 * earlier task on this lane survived forever and could permanently suppress
 * an unrelated LATER task's first, legitimate attempt at the same call
 * shape (same tool+action+args, different task).
 *
 * Builds the same compound key `hasExecutedNext`/`recordExecutedNext` use
 * (workspaceRoot + NUL + normalized lane) via String.fromCharCode rather
 * than repeating their literal escape, so the two stay byte-identical
 * without this function needing to import anything from them.
 */
export function clearExecutedNextForLane(workspaceRoot: string, lane: string): void {
  const base = executedNextLedgerKey(workspaceRoot, lane);
  for (const key of _executedNextFingerprints.keys()) {
    if (key === base || key.startsWith(`${base}${String.fromCharCode(0)}`)) {
      _executedNextFingerprints.delete(key);
    }
  }
  // TL142-01A/01B: the result ledger shares this key space, so it shares every
  // lifetime rule — a lane cleared of its executed calls must not keep
  // claiming what those calls found.
  for (const key of _executedSearchResults.keys()) {
    if (key === base || key.startsWith(`${base}${String.fromCharCode(0)}`)) {
      _executedSearchResults.delete(key);
    }
  }
  // R1-S10a: the prescription ledger shares the same key space and the same
  // lifetime — a cleared lane must not keep authorizing what its retired packs
  // once asked for.
  for (const key of _prescribedSearchTerms.keys()) {
    if (key === base || key.startsWith(`${base}${String.fromCharCode(0)}`)) {
      _prescribedSearchTerms.delete(key);
    }
  }
}

/** Legacy/internal no-lane callers: forget every ledger for this workspace, both key spellings a caller may pass (see clearPackDedupeForWorkspace). */
export function clearExecutedNextForWorkspace(workspaceRoot: string): void {
  const prefix = `${workspaceRoot}${String.fromCharCode(0)}`;
  for (const key of _executedNextFingerprints.keys()) {
    if (key.startsWith(prefix)) _executedNextFingerprints.delete(key);
  }
  // TL142-01A/01B: same key space, same lifetime — see clearExecutedNextForLane.
  for (const key of _executedSearchResults.keys()) {
    if (key.startsWith(prefix)) _executedSearchResults.delete(key);
  }
  // R1-S10a: same key space, same lifetime.
  for (const key of _prescribedSearchTerms.keys()) {
    if (key.startsWith(prefix)) _prescribedSearchTerms.delete(key);
  }
}

/** Clear ALL per-workspace state — used by specs' beforeEach for isolation. */
export function resetPackServeLogForTest(): void {
  _logs.clear();
  _executedNextFingerprints.clear();
  _executedSearchResults.clear();
  _prescribedSearchTerms.clear();
  _servedBytes.clear();
  _servedWindows.clear();
  _seq = 0;
}
