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

let _seq = 0;
const _logs = new Map<string, WorkspacePackLog>();

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
 */
export function recordExecutedLocate(
  workspaceRoot: string,
  query: string,
  candidateHandles: readonly string[],
): void {
  if (query.length === 0) return;
  const meta = _getLog(workspaceRoot).meta;
  const map = meta.executedLocates ?? (meta.executedLocates = new Map());
  map.delete(query);
  map.set(query, [...candidateHandles].slice(0, 8));
  while (map.size > 8) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** D3: the recorded candidate handles for an already-executed locate, if any. */
export function consultExecutedLocate(workspaceRoot: string, query: string): string[] | undefined {
  return _getLog(workspaceRoot).meta.executedLocates?.get(query);
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

/** Clear ALL per-workspace state — used by specs' beforeEach for isolation. */
export function resetPackServeLogForTest(): void {
  _logs.clear();
  _seq = 0;
}
