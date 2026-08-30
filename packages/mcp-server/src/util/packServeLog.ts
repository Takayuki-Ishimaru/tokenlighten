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

function _getLog(workspaceRoot: string): WorkspacePackLog {
  let log = _logs.get(workspaceRoot);
  if (log === undefined) {
    log = _emptyLog();
    _logs.set(workspaceRoot, log);
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
 */
export function clearServedSurfaces(workspaceRoot: string): void {
  const log = _logs.get(workspaceRoot);
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
  surfaces: ReadonlyArray<{ path: string; role: string; handle?: string }>,
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
  const log = _logs.get(workspaceRoot);
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
  const log = _logs.get(workspaceRoot);
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
  const log = _logs.get(workspaceRoot);
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
  const log = _logs.get(workspaceRoot);
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
  const log = _logs.get(workspaceRoot);
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
  const log = _logs.get(workspaceRoot);
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
      .filter(([key]) => key !== "cwd" && key !== "lane" && key !== "task_handle"));
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

export function recordExecutedNext(
  workspaceRoot: string,
  lane: string,
  tool: string,
  args: Record<string, unknown>,
  resultDigest?: string,
): boolean {
  const key = `${workspaceRoot}\u0000${normalizeContractLane(lane)}`;
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

export function hasExecutedNext(workspaceRoot: string, lane: string, tool: string, args: Record<string, unknown>): boolean {
  return _executedNextFingerprints.get(`${workspaceRoot}\u0000${normalizeContractLane(lane)}`)?.has(nextFingerprint(tool, args)) ?? false;
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
export function forgetExecutedNext(workspaceRoot: string, lane: string, tool: string, args: Record<string, unknown>): void {
  _executedNextFingerprints
    .get(`${workspaceRoot}${String.fromCharCode(0)}${normalizeContractLane(lane)}`)
    ?.delete(nextFingerprint(tool, args));
}

/** Focused regression seam for result-consumption bindings. */
export function executedNextRecordForTest(workspaceRoot: string, lane: string, tool: string, args: Record<string, unknown>): ExecutedNextRecord | undefined {
  return _executedNextFingerprints.get(`${workspaceRoot}\u0000${normalizeContractLane(lane)}`)?.get(nextFingerprint(tool, args));
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
  const sep = String.fromCharCode(0);
  _executedNextFingerprints.delete(`${workspaceRoot}${sep}${normalizeContractLane(lane)}`);
}

/** Legacy/internal no-lane callers: forget every ledger for this workspace, both key spellings a caller may pass (see clearPackDedupeForWorkspace). */
export function clearExecutedNextForWorkspace(workspaceRoot: string): void {
  const prefix = `${workspaceRoot}${String.fromCharCode(0)}`;
  for (const key of _executedNextFingerprints.keys()) {
    if (key.startsWith(prefix)) _executedNextFingerprints.delete(key);
  }
}

/** Clear ALL per-workspace state — used by specs' beforeEach for isolation. */
export function resetPackServeLogForTest(): void {
  _logs.clear();
  _executedNextFingerprints.clear();
  _servedBytes.clear();
  _servedWindows.clear();
  _seq = 0;
}
