// workspace-routing — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { CwdCorrection } from "./workspace-routing2.js";
import type { SchemaNode } from "../validation/requestShape.js";
import { CREATE_BODY_PLACEHOLDER } from "../state/session.js";
import { CWD_NEAR_MISS_CANDIDATE_LIMIT } from "./workspace-routing2.js";
import { EDIT_REPLACE_PLACEHOLDER } from "../state/session.js";
import { EDIT_SEARCH_PLACEHOLDER } from "../state/session.js";
import { batchHintsEnabled } from "../util/flags.js";
import { configuredAllowedParents } from "./read-admission2.js";
import { cwdNearMissCandidatePool } from "./workspace-routing2.js";
import { cwdNearMissEnabled } from "../util/flags.js";
import { cwdNearMissMatch } from "./workspace-routing2.js";
import { effectiveCallWorkspace } from "./workspace-routing2.js";
import { hashedTraceValue } from "../util/trace.js";
import { involvedHandleEntries } from "./workspace-routing2.js";
import { involvedHandleIds } from "./workspace-routing2.js";
import { isCwdExplicit } from "./workspace-routing2.js";
import { isHomeDirItself } from "./workspace-routing2.js";
import { isWorkspaceCandidateAccepted } from "../workspace/candidates.js";
import { legacyProperties } from "./tool-schema.js";
import { nearestValidWorkspaceAncestor } from "../workspace/candidates.js";
import { nestedWorkspaceCrossing } from "../write/workspaceBoundary.js";
import { nestedWorkspaceRoots } from "../write/workspaceBoundary.js";
import { noteSerialSingleTargetHint } from "../protocol/envelope.js";
import { readdirSync } from "node:fs";
import { recordReadFamilySingleTargetCall } from "../state/session.js";
import { registeredWorkspaceCandidates } from "./workspace-routing2.js";
import { resolveWorkspaceRoot } from "./read-admission2.js";
import { trace } from "../util/trace.js";
import { workspaceCandidates } from "./workspace-routing2.js";
import { writeTargetPaths } from "./workspace-routing2.js";

/**
 * One-shot find-batching hint text (Fix B, 2026-07-12c single-query-find-loop forensics —
 * see recordSingleFindCompletion in util/session.ts) — sibling of
 * BATCH_HINT_TEXT above but for tl_search_files action=find: nudges an agent
 * making repeated single-token find calls toward the queries:[...] OR-batch
 * form. L2 (2026-07-30 T11 forensics): threshold lowered 4 -> 2 (see
 * FIND_HINT_THRESHOLD's doc comment) — text/mechanism otherwise unchanged,
 * still one-shot per session (see findHintFired). 2026-10-18: names the
 * default cap (10, TL_EFF_WIDE_FIND), as the guides do; under the `0`
 * rollback a batch of six to ten is refused with a `next` holding the first
 * five and `remaining_queries` the rest.
 */
export const FIND_HINT_TEXT =
  "2nd single-token find call this session — batch related tokens into ONE queries:[...] call (<=10, OR-matched)";

// ---------------------------------------------------------------------------
// W-BATCH-HINT (TL_BATCH_HINTS, default OFF — DESIGN-v0.15-sf-turn-economy.md
// §3): tl_read_file's own sibling of BATCH_HINT_TEXT/FIND_HINT_TEXT above. §0's
// 12-cell forensics measured 80% of paid cells re-reading the same file in
// >=3 serial slices where one `read.batch` targets[...] call would do — the
// exact serial-fan-out shape those two existing hints already nudge callers
// away from for tl_edit_file/tl_search_files, but with NO analog on tl_read_file's own
// slice/symbol path.
//
// TRIGGER. Fires on the 2nd non-full, non-`ranges[]`-batch slice/symbol read
// of the SAME path this session. "2nd" is decided from
// `servedClusterCount` — the number of served-range CLUSTERS
// (`ServedRangeLedgerState.ranges`, DC3's single byte-residency authority)
// this path already holds BEFORE the call being served adds one — so the
// condition "exactly 1 cluster existed already" is true for precisely one
// call in that path's history: naturally one-shot, with no separate
// "already fired" flag to fall out of sync with the ledger it reads.
//
// CONTENT. Names the already-held span(s) so the caller does not have to
// re-derive them — `servedClusterRanges` reports paths+ranges ONLY (never
// bodies), matching DC2/DC3: this is a presentation-layer nudge, never a
// second address-selection authority.
// ---------------------------------------------------------------------------
export const READ_BATCH_HINT_TEXT =
  "2nd slice/symbol tl_read_file call on this path this session — fold the remaining ranges into ONE targets:[{path,range},...] call (or ranges:[...] on one target) instead of serial slices";

/** Appends the already-held spans (if any) to READ_BATCH_HINT_TEXT — paths/ranges only, never bodies. */
export function composeReadBatchHint(alreadyHeld: readonly string[]): string {
  return alreadyHeld.length > 0
    ? `${READ_BATCH_HINT_TEXT}; already held: ${alreadyHeld.join(", ")}`
    : READ_BATCH_HINT_TEXT;
}

// ---------------------------------------------------------------------------
// W-BATCH-HINT candidate 3 (TL_BATCH_HINTS, default OFF — DESIGN-v0.15-sf-
// turn-economy.md §3). The sibling of the per-path hint above, for a serial
// run of single-target calls across the read family generally — see
// state/session.ts's `recordReadFamilySingleTargetCall`/
// `SERIAL_SINGLE_TARGET_HINT_THRESHOLD` and protocol/envelope.ts's
// `applySerialSingleTargetHint` for the recording/attachment halves this
// classifier feeds.
// ---------------------------------------------------------------------------

/**
 * How many targets this call names, for ONE tool's read-family shape —
 * `undefined` means "does not participate" (tl_edit_file never calls this at
 * all; a tl_search_files action other than `find` also does not participate,
 * since the streak this feeds is specifically about `find`'s single-query
 * repeat-guessing shape the existing FIND_HINT_TEXT/FIND_HINT_THRESHOLD
 * mechanism already names). Counts the CALL's declared shape, never resolves
 * anything — a bad/foreign handle or a nonexistent path still has a target
 * count, and this classifier is not the place that decides whether the call
 * succeeds.
 */
export function readFamilyCallTargetCount(
  tool: "tl_read_file" | "tl_search_files",
  action: string | undefined,
  args: Record<string, unknown>,
): number | undefined {
  if (tool === "tl_read_file") {
    const targets = args["targets"];
    if (Array.isArray(targets)) {
      // L1 (2026-09-05 review): ONE target carrying `ranges:[...]` with >=2
      // entries is already several windows of a SINGLE file/handle — the
      // exact batched form SERIAL_SINGLE_TARGET_HINT_TEXT/
      // READ_BATCH_HINT_TEXT tell callers to fold serial slices into.
      // Counting it as 1 target made the hint fire on precisely the shape
      // it recommends adopting. Classify by window count instead, mirroring
      // the top-level `ranges[]` case below.
      if (targets.length === 1) {
        const onlyTarget = targets[0];
        const onlyRanges = onlyTarget !== null && typeof onlyTarget === "object"
          ? (onlyTarget as Record<string, unknown>)["ranges"]
          : undefined;
        if (Array.isArray(onlyRanges) && onlyRanges.length >= 2) return onlyRanges.length;
      }
      return targets.length;
    }
    const handles = args["handles"];
    if (Array.isArray(handles)) return handles.length;
    const paths = args["paths"];
    if (Array.isArray(paths)) return paths.length;
    // Same batched-window shape, top-level legacy dialect: `{path,
    // ranges:[...]}` / `{handle, ranges:[...]}` with no `targets[]` wrapper
    // at all (e.g. `mode:"slice", path, ranges:[...]`).
    const topRanges = args["ranges"];
    if (Array.isArray(topRanges) && topRanges.length >= 2) return topRanges.length;
    if (typeof args["path"] === "string" && args["path"] !== "") return 1;
    if (typeof args["handle"] === "string" && args["handle"] !== "") return 1;
    return undefined;
  }
  // "" (action omitted) resolves to find-shaped default behavior — the same
  // leniency `SEARCH_MATCH_ACTIONS`/`kindForCall` (protocol/envelope.ts) give
  // it for `search.matches` classification.
  if (action !== "find" && action !== "") return undefined;
  const queries = args["queries"];
  if (Array.isArray(queries)) return queries.length;
  if (typeof args["query"] === "string" && args["query"] !== "") return 1;
  return undefined;
}

/**
 * Records this call's single/multi-target shape against the session's serial
 * streak (state/session.ts) and publishes whether the hint should ride THIS
 * response (protocol/envelope.ts's `context.serialSingleTargetHint`) — a
 * no-op when the flag is off, or when this call's shape does not participate
 * at all (`readFamilyCallTargetCount` returned `undefined`: task_pack/closure
 * reads with no explicit targets, a non-`find` tl_search_files action, or
 * tl_edit_file, which never calls this). Call unconditionally once per
 * tl_read_file/tl_search_files call that reaches dispatch, regardless of whether
 * the response that follows turns out to be a receipt/refusal — the streak
 * counts call shapes, and `applySerialSingleTargetHint` is what excludes
 * those kinds from actually carrying the hint.
 */
export function noteReadFamilySerialSingleTargetCall(
  workspace: string,
  tool: "tl_read_file" | "tl_search_files",
  action: string | undefined,
  args: Record<string, unknown>,
): void {
  if (!batchHintsEnabled()) return;
  const targetCount = readFamilyCallTargetCount(tool, action, args);
  if (targetCount === undefined) return;
  noteSerialSingleTargetHint(recordReadFamilySingleTargetCall(workspace, targetCount === 1));
}

/**
 * W-BATCH-HINT (c): the bounded, optional `ledger` INPUT field's per-entry
 * shape at the advertised-schema level — `{path, range?}`, additionalProperties
 * false so a stray key inside one entry is still an `unknown-arguments`
 * refusal rather than a silent drop. Only spliced into the tl_read_file
 * validation properties when `batchHintsEnabled()` (see its call site in
 * dispatchTool) — flag off, `ledger` is refused exactly like any other
 * unadvertised key, byte-identical to pre-W-BATCH-HINT behavior.
 */
export const READ_LEDGER_ENTRY_SCHEMA: SchemaNode = {
  type: "object",
  properties: legacyProperties(["path", "range"]),
};

export const READ_LEDGER_SCHEMA: SchemaNode = { type: "array", items: READ_LEDGER_ENTRY_SCHEMA };

/** One caller-declared `ledger` entry, after shape validation (bad-shaped entries are dropped, not refused — HINT-only). */
export interface ReadLedgerEntry {
  path: string;
  range?: string;
}

/** `N-M` (1-based inclusive) -> `[start, end]`, or undefined if it does not parse. */
export function parseLedgerRangeSpec(range: string): [number, number] | undefined {
  const match = /^(\d+)-(\d+)$/.exec(range.trim());
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return undefined;
  return [start, end];
}

/**
 * W-BATCH-HINT (c): validate + bound the caller-declared `ledger` array.
 * Malformed entries (not an object, no string `path`) are DROPPED, not
 * refused — the field is a HINT, never a contract the caller must get
 * exactly right. Entries beyond `READ_LEDGER_MAX_ENTRIES` are ignored and
 * reported via the returned `truncatedNote` (existing `note` advisory
 * channel — no new top-level wire field).
 */
export const READ_LEDGER_MAX_ENTRIES = 32;

export function parseReadLedgerInput(raw: unknown): { entries: ReadLedgerEntry[]; truncatedNote?: string } {
  if (!Array.isArray(raw)) return { entries: [] };
  const valid: ReadLedgerEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record["path"] !== "string" || record["path"] === "") continue;
    const range = typeof record["range"] === "string" ? record["range"] : undefined;
    valid.push({ path: record["path"], ...(range !== undefined ? { range } : {}) });
  }
  const entries = valid.slice(0, READ_LEDGER_MAX_ENTRIES);
  const truncatedNote = valid.length > READ_LEDGER_MAX_ENTRIES
    ? `ledger_truncated: ${valid.length - READ_LEDGER_MAX_ENTRIES} of ${valid.length} declared ledger entries ignored (cap ${READ_LEDGER_MAX_ENTRIES})`
    : undefined;
  return { entries, ...(truncatedNote !== undefined ? { truncatedNote } : {}) };
}

/**
 * A1 (2026-08-04 review): collapse body-bearing arguments to the shared
 * prescription placeholders before echoing a caller's own call shape back in a
 * `next_call` template.
 *
 * A template names the SHAPE the caller should re-issue; the caller already
 * holds the payload, so repeating it is pure cost — the convention session.ts
 * states next to those placeholder constants, and which W1's
 * `cwd-required-for-create` refusal was the one violation of. Measured before
 * this: a 24,024-byte create drew a 24,555-byte refusal, then the caller
 * re-sent the same body on the corrective retry, billing it three times for
 * one create. DESIGN-v0.10-write-capability-RFC.md §9 budgets ~320 B.
 *
 * `search` is compacted only when non-empty: `search:""` is the deprecated
 * sink's create SPELLING (shape, not payload) and must survive verbatim, or
 * the prescribed retry would stop being a create.
 */
export function compactTemplateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const compacted: Record<string, unknown> = { ...args };
  if (compacted["content"] !== undefined) compacted["content"] = CREATE_BODY_PLACEHOLDER;
  if (compacted["replace"] !== undefined) compacted["replace"] = EDIT_REPLACE_PLACEHOLDER;
  if (typeof compacted["search"] === "string" && compacted["search"].length > 0) {
    compacted["search"] = EDIT_SEARCH_PLACEHOLDER;
  }
  return compacted;
}

/**
 * L1 (2026-08-07): the same evidence shape a task_pack create route already
 * publishes as `create_target.directory_evidence` (readCodeTaskPack.ts's
 * resolveExplicitArtifactCreateTarget) -- up to three files that already live
 * in the created file's own directory, read from the filesystem the write
 * actually landed on. Mirrored onto the self-authorized create so a create
 * admitted by its own workspace pin is as auditable as a pack-grounded one:
 * the response states, in server-observed facts rather than caller text, what
 * the chosen placement sits next to. An empty list is the honest answer for a
 * directory this create itself brought into being, and is reported as such.
 */
export function createDirectoryEvidence(workspace: string, relPath: string): string[] {
  const normalized = relPath.split(path.sep).join("/");
  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized);
  try {
    return readdirSync(path.resolve(workspace, dir === "." ? "" : dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== base)
      .map((entry) => (dir === "." ? entry.name : `${dir}/${entry.name}`))
      .sort()
      .slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * B5.1: `resolveWorkspaceRoot` (write/resolveWorkspace.ts) silently falls
 * back to the server's pinned root when `cwd` is invalid/nonexistent — that
 * fallback is intentional and stays in place there (single-root callers that
 * never pass cwd must be unaffected, and it is the right behavior for the
 * PURE resolver function itself; see cwdRouting.spec.ts's direct
 * resolveWorkspaceRoot unit tests, which are unchanged by this). The bug was
 * that dispatch had NO way to tell "cwd was omitted" apart from "cwd was
 * supplied but garbage" — a typo'd cwd (e.g. `.claire`) silently served
 * results from the pinned root, which "worked" only because the pinned root
 * happened to be usable, not because the caller's intended tree was read.
 *
 * This pre-check runs BEFORE resolveWorkspaceRoot in the tl_read_file/tl_edit_file/
 * tl_search_files dispatch: when the caller supplied a non-empty `cwd` that
 * isWorkspaceOverrideAccepted rejects, return a structured refusal instead of
 * silently resolving against the pinned root. `next` carries both the
 * requested path and the root a call OMITTING cwd would resolve to, so the
 * caller can immediately retry correctly either way.
 *
 * Returns null when there is nothing to refuse (cwd omitted, or cwd is
 * present and valid) — the caller proceeds to resolveWorkspaceRoot as today.
 */
export function checkCwdOrRefuse(
  rawCwd: unknown,
  fallbackRoot: string,
): {
  ok: false;
  reason: "invalid-cwd";
  // R29-FIX (2026-09-05, D1): a named `field` is the classification signal
  // attachSupply.ts's isGenuinelyBareRefusal actually checks -- without it
  // this `reason`-only failure (no `code`) was misread as genuinely bare and
  // got the nuclear retry:"new-task" + full task-pack-abandonment `remaining`
  // prose forced onto it, even though `detail` already names the one-field
  // fix. Measured: 3x SF05 control + 2x SF13 control in a single paid smoke
  // (r9).
  field: "cwd";
  requested: string;
  resolved: string;
  detail: string;
  nearest_existing?: string;
  // v0.15 W-T-A (b): structured recovery, emitted ONLY under TL_CWD_NEAR_MISS.
  cwd_candidates?: Array<{ cwd: string; source: string }>;
  did_you_mean?: string;
} | null {
  if (rawCwd === undefined) return null; // cwd omitted — nothing to validate.
  const requested = String(rawCwd);
  if (requested.trim() === "") return null; // treat empty string like omitted.
  // H3: accept a cwd that resolves to the pinned fallback root itself, even
  // when that root lives OUTSIDE $HOME (CI/tmp deployments where the checkout
  // is not under the user's home dir). Without an explicit allowed parent,
  // isWorkspaceOverrideAccepted rejects such a path, so a cwd-echoing call
  // that simply repeats the pinned root — legitimate, and exactly what the
  // adoption sites treat as "no override" — used to draw an invalid-cwd refusal
  // on every call. Compare via realpath (resolveReal tolerates a missing path
  // by falling back to path.resolve, so a nonexistent requested cwd simply
  // won't match — it falls through to the refusal below). PI-07 (2026-08-20):
  // this accept check now lives in workspace/candidates.ts's
  // isWorkspaceCandidateAccepted, which the new candidate/did_you_mean
  // validators reuse verbatim rather than re-deriving the policy — this call
  // site is unchanged in effect, only in where the two lines live.
  const allowedParents = configuredAllowedParents(fallbackRoot);
  if (isWorkspaceCandidateAccepted(requested, fallbackRoot, allowedParents)) {
    return null; // valid — proceed normally.
  }
  // "resolved": what a call OMITTING cwd resolves to today (the pinned
  // root) — reuses resolveWorkspaceRoot itself rather than re-deriving the
  // fallback path, so this never drifts from the real fallback behavior.
  const resolved = resolveWorkspaceRoot(undefined, fallbackRoot);
  // "nearest_existing": cheap, best-effort ancestor walk-up — cheap because a
  // typo'd cwd (e.g. ".claire/..." instead of ".claude/...") is USUALLY only
  // one or two segments removed from a real directory, so an agent that reads
  // this can often just fix the last segment and retry rather than guessing
  // blind. Omitted (not present) when nothing existed along the chain.
  // PI-07 / F-A1-5 fix: nearestValidWorkspaceAncestor (workspace/candidates.ts)
  // validates every candidate ancestor through the SAME check above before
  // returning it, so this value is always safe to surface as `did_you_mean`
  // on ANY tool's refusal (protocol/refusal.ts's mapping) — not just the
  // read-path tools that re-validate again before silently adopting it
  // (checkCwdWithCorrection below).
  const nearestExisting = nearestValidWorkspaceAncestor(requested, fallbackRoot, allowedParents);
  // v0.15 W-T-A (b) — STRUCTURED REFUSAL, ALL TOOLS, NO AUTO-RESOLUTION.
  // DESIGN-v0.14-plan.md §4 measured 20 `invalid-cwd` refusals across 12 paid
  // cells; every one carried prose `detail` + `retry:"call"` only, so every one
  // cost a full round trip. `cwd-required-for-edit` has served a validated
  // `cwd_candidates` array since PI-07 — this refusal simply stopped short of
  // using the same builder. `did_you_mean` rides only when the near-miss is
  // UNIQUE; on `tl_edit_file` it stays a suggestion the caller must re-issue,
  // never an adoption (checkCwdWithCorrection states why the read path and the
  // write path are deliberately asymmetric). Flag-gated: with TL_CWD_NEAR_MISS
  // off neither key is computed and this refusal is byte-identical to its
  // pre-v0.15 form.
  // F4 (ratified, independent review 2026-09-02): the WIRE `cwd_candidates`
  // (every tool, including tl_edit_file) and the pool `did_you_mean` matches
  // against are the REGISTERED pool ONLY — never the sibling `readdirSync`
  // scan (`cwdNearMissCandidatePool`, read-path-only; see its doc comment). A
  // refusal must never enumerate scan results.
  // R11 A-2/A-3: MATCH against the untruncated registered pool (see
  // registeredWorkspaceCandidates's doc comment) — only the wire
  // `cwd_candidates` a few lines below stays capped at
  // CWD_NEAR_MISS_CANDIDATE_LIMIT, which is now a true reporting-only bound
  // rather than an accidental floor on how many candidates ever get matched.
  const registeredNearMissCandidates = cwdNearMissEnabled()
    ? registeredWorkspaceCandidates(fallbackRoot, nestedWorkspaceRoots(fallbackRoot))
    : [];
  const uniqueNearMiss = registeredNearMissCandidates.length > 0
    ? cwdNearMissMatch(requested, registeredNearMissCandidates).match
    : undefined;
  return {
    ok: false,
    reason: "invalid-cwd",
    field: "cwd",
    requested,
    resolved,
    detail: `cwd must be the pinned workspace, a worktree registered by the pinned repository, or one direct-child worktree under a configured --allowed-parent; retry with a valid cwd, or omit cwd to use ${resolved}`,
    ...(nearestExisting !== undefined ? { nearest_existing: nearestExisting } : {}),
    ...(registeredNearMissCandidates.length > 0
      ? { cwd_candidates: registeredNearMissCandidates.slice(0, CWD_NEAR_MISS_CANDIDATE_LIMIT) }
      : {}),
    ...(uniqueNearMiss !== undefined ? { did_you_mean: uniqueNearMiss.to } : {}),
  };
}

/**
 * Fix 3 (2026-07 follow-up): `.claire` is a recurring model typo for
 * `.claude` — every invalid-cwd refusal it drew cost a full agent turn, even
 * in transcripts that otherwise won the bench cell. Substitutes ONLY an
 * exact `.claire` PATH SEGMENT (never a prefix match like `.clairevoyant`),
 * segment-by-segment, so a `.claire` anywhere in the path — not just a
 * trailing one — is corrected. Returns null when no `.claire` segment is
 * present; the caller must not treat null as "already valid", only as "no
 * candidate from this rule".
 */
export function correctClaireSegment(requestedPath: string): string | null {
  if (!requestedPath.includes(".claire")) return null;
  let changed = false;
  const corrected = requestedPath.split(path.sep).map((segment) => {
    if (segment === ".claire") {
      changed = true;
      return ".claude";
    }
    return segment;
  });
  return changed ? corrected.join(path.sep) : null;
}

/**
 * tl_read_file/tl_search_files-ONLY wrapper around checkCwdOrRefuse. A cwd that
 * fails validation gets up to two cheap, bounded correction attempts before
 * this actually refuses — each candidate is re-validated through
 * checkCwdOrRefuse ITSELF (the exact same realpath/$HOME-containment checks
 * a user-supplied cwd faces), so this only widens which STRING reaches that
 * boundary, never what the boundary accepts:
 *   1. an exact `.claire` path segment substituted for `.claude`
 *      (correctClaireSegment above).
 *   2. checkCwdOrRefuse's own `nearest_existing` ancestor suggestion, when
 *      present and not just $HOME itself (isHomeDirItself) — by
 *      construction there is at most one, so "adopt it" is never a guess
 *      among several candidates.
 * Order matters: `.claire` is tried first, since it is the specific, common
 * mistake this fix targets; `nearest_existing` is the generic fallback.
 *
 * tl_edit_file and every write path must keep calling checkCwdOrRefuse
 * directly instead of this — see that call site's B5.1 comment and the
 * DESIGN-v0.8 B1 mis-target hazard on the create branch. A wrong READ/SEARCH
 * target costs a turn; a wrong WRITE target is not something a silent
 * correction should ever risk.
 */
export function checkCwdWithCorrection(
  rawCwd: unknown,
  fallbackRoot: string,
): { refusal: ReturnType<typeof checkCwdOrRefuse>; correction?: CwdCorrection } {
  const refusal = checkCwdOrRefuse(rawCwd, fallbackRoot);
  if (refusal === null) return { refusal: null };

  const requested = refusal.requested;

  const claireCandidate = correctClaireSegment(requested);
  if (claireCandidate !== null && checkCwdOrRefuse(claireCandidate, fallbackRoot) === null) {
    return { refusal: null, correction: { from: requested, to: claireCandidate } };
  }

  // v0.15 W-T-A (a) — THE THIRD CORRECTION CLASS (TL_CWD_NEAR_MISS, OFF by
  // default). REORDERED (2026-09-03, Finding 2 / INV-H;
  // DESIGN-v0.15-sf-turn-economy.md §1.2 ratified ruling): tried BEFORE the
  // generic ancestor-walk below, not after it.
  //
  // Previously this ran LAST, "so with the flag on it is strictly additive".
  // That reasoning missed a real interaction: the ancestor-walk below accepts
  // ANY existing workspace-valid ancestor, and any subdirectory of the pinned
  // root qualifies as one — so for a nested-worktree layout
  // (`<root>/worktrees/<name>`), the container directory `<root>/worktrees`
  // itself is already such an ancestor, one level short of the intended
  // worktree. The ancestor-walk therefore won UNCONDITIONALLY, before this
  // block ever ran, for the entire class of nested-worktree layouts — the
  // near-miss sibling-scan (built specifically to find the more-specific,
  // SAME-DEPTH candidate the ancestor-walk cannot see) was live-confirmed
  // reachable only for a TOP-LEVEL sibling worktree (one living outside the
  // pinned root, so no intervening valid ancestor exists), never for the
  // nested case — silently steering a read to the wrong (container)
  // directory, or masking a recoverable `invalid-cwd` behind a bare
  // `not-found` with zero corrective signal.
  //
  // `cwdNearMissMatch` returns a candidate only when it is UNIQUE and cleared
  // every acceptance and adversarial gate, and the value is then re-proved
  // through `checkCwdOrRefuse` — the same re-validation every branch here
  // does — so this can never resolve to something a live call would reject.
  if (cwdNearMissEnabled()) {
    const { pool: nearMissPool, truncated: nearMissPoolTruncated } =
      cwdNearMissCandidatePool(requested, fallbackRoot);
    // R11 A-1 (independent review, 2026-09-03): a truncated sibling scan is
    // an INCOMPLETE pool — a real second half of an ambiguous pair can sit
    // past the scanned prefix (cwdNearMissCandidatePool's own doc comment).
    // Trusting whatever partial answer the matcher would give here is exactly
    // the silent-wrong-adoption hazard this whole class exists to avoid, so a
    // truncated pool never adopts — diagnosed the same way the matcher's own
    // `pool-too-large` refusal would be, just one layer earlier.
    const near = nearMissPoolTruncated
      ? { refused: "pool-too-large" as const }
      : cwdNearMissMatch(requested, nearMissPool);
    if (near.match !== undefined && checkCwdOrRefuse(near.match.to, fallbackRoot) === null) {
      // Audit: trace is a DIAGNOSTIC log, not protocol wire, so a new field
      // here is outside the wire-invariance contract (DESIGN §1.2(a), §6).
      // FX-R3 (2026-09-03, round-18B finding 7): `from`/`to` are raw
      // absolute filesystem paths (the requested cwd and the resolved
      // sibling/nested worktree) — hash them the same way `workspaceRefOf`
      // hashes a workspace root (see `hashedTraceValue`'s doc comment).
      // Every other trace event in this server carries at most a
      // workspace-relative path or an opaque ref; this one must not be the
      // exception.
      trace("cwd_near_miss_resolved", {
        from: hashedTraceValue(requested),
        to: hashedTraceValue(near.match.to),
        relation: near.match.relation,
        ...(near.match.edit_distance !== undefined ? { edit_distance: near.match.edit_distance } : {}),
        candidate_source: near.match.source,
      }, fallbackRoot);
      return {
        refusal: null,
        correction: { from: requested, to: near.match.to, reason: near.match.relation },
      };
    }
    if (near.refused === "pool-too-large") {
      // FX-R3: same rationale as cwd_near_miss_resolved above.
      trace("cwd_near_miss_pool_too_large", { requested: hashedTraceValue(requested) }, fallbackRoot);
    }
    // Finding 2 / H-nested-ambiguous (INV-H, not reproduced live there —
    // confirmed here): an AMBIGUOUS near-miss (2+ equally-plausible sibling
    // worktrees, e.g. two nested worktrees under the same container, both one
    // edit-distance from the typo) must never fall through to the coarser
    // ancestor-walk below — that would silently resolve to a LESS specific
    // container directory instead of surfacing the tie the caller must
    // disambiguate. `checkCwdOrRefuse`'s own `cwd_candidates`/`did_you_mean`
    // (§1.2(b), already unconditional on every `invalid-cwd` refusal) is the
    // only signal an ambiguous near-miss ever gets — same as the pre-existing
    // top-level tie case, which already refuses rather than guessing
    // (`cwdNearMissMatch`'s own `hits.length > 1` -> `"ambiguous"` contract).
    if (near.refused === "ambiguous") {
      return { refusal };
    }
    // `no-candidate` / `pool-too-large` / `dot-dot`: no registered worktree
    // near-miss matched at all — fall through to the generic ancestor-walk
    // below, per the ratified ruling ("the ancestor walk applies only when no
    // registered worktree matches").
  }

  // nearest_existing only ever makes sense as a correction for an otherwise
  // well-formed but not-quite-real ABSOLUTE path. nearestValidWorkspaceAncestor
  // (workspace/candidates.ts) resolves a RELATIVE requested string against
  // path.resolve (i.e. this SERVER PROCESS's own launch cwd, not anything
  // reflecting caller intent) before walking up — for ANY nonexistent
  // relative path that walk always eventually reaches the server's own cwd,
  // which routinely exists and (when the server was launched from its own
  // pinned root, the common case) routinely passes validation, so without
  // this gate a merely-relative cwd (a real caller mistake `checkCwdOrRefuse`
  // is right to reject) would silently "correct" to a directory that has
  // nothing to do with the call.
  //
  // This is now class 2, the FALLBACK tried only when the flag is off, or
  // when it is on but no registered-worktree near-miss matched (see above) —
  // when the flag is off this runs in exactly the same position it always
  // has, byte-identical.
  if (
    path.isAbsolute(requested) &&
    refusal.nearest_existing !== undefined &&
    !isHomeDirItself(refusal.nearest_existing) &&
    checkCwdOrRefuse(refusal.nearest_existing, fallbackRoot) === null
  ) {
    return { refusal: null, correction: { from: requested, to: refusal.nearest_existing } };
  }

  return { refusal };
}

/**
 * F1 + F3, in that order: a workspace nobody declared cannot be reasoned about
 * at all, so "name your tree" precedes "that target is in someone else's
 * tree". Returns null — with at most one cached stat — for every unambiguous
 * workspace, which is what keeps this off the hot path.
 */
export function workspaceRoutingRefusal(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const workspace = effectiveCallWorkspace(args);
  const nested = nestedWorkspaceRoots(workspace);
  if (nested.length === 0) return null;

  const cwdExplicit = isCwdExplicit(args["cwd"]);
  if (
    !cwdExplicit
    && !involvedHandleEntries(args).some((entry) => entry.workspaceDeclared === true)
  ) {
    return {
      ok: false,
      reason: "cwd-required-for-edit",
      code: "cwd-required-for-edit",
      applied: false,
      terminal: false,
      detail: `${path.basename(workspace)} contains ${nested.length} other live workspace(s), so a write that names no cwd cannot be routed: neither this call nor the handles it carries ever declared which tree to edit`,
      workspace,
      cwd_candidates: workspaceCandidates(workspace, nested),
      next_call_is_template: true,
      next_call: {
        tool: toolName,
        arguments: { ...compactTemplateArgs(args), cwd: "<absolute intended workspace cwd>" },
      },
    };
  }

  const crossings = writeTargetPaths(args)
    .map((target) => ({ path: target, workspace: nestedWorkspaceCrossing(target, workspace) }))
    .filter((item): item is { path: string; workspace: string } => item.workspace !== undefined);
  if (crossings.length === 0) return null;

  const foreign = crossings[0]!.workspace;
  const single = crossings.length === 1
    && typeof args["path"] === "string"
    && args["path"] === crossings[0]!.path
    && involvedHandleIds(args).length === 0
    && !Array.isArray(args["edits"]);
  return {
    ok: false,
    reason: "workspace-boundary",
    code: "workspace-boundary",
    applied: false,
    terminal: false,
    workspace,
    nested_workspace: foreign,
    paths: crossings.slice(0, 3).map((item) => item.path),
    detail: `the target lives in ${foreign}, a linked worktree nested inside ${workspace} — a different workspace on its own branch, not a subdirectory of this one; re-issue with that cwd and a path relative to it`,
    ...(single
      ? {
          next_call: {
            tool: toolName,
            // This is an executable root-suggestion re-scope, not a
            // template: preserve the caller's actual search/replace payload so
            // the emitted call survives placeholder scrubbing and can be
            // replayed after only its cwd/path are corrected.
            arguments: {
              ...args,
              cwd: foreign,
              // `path.relative` emits NATIVE separators, so on win32 this
              // rerouted continuation handed back `packages\cli\src\...`.
              // Every workspace-relative path on this wire is POSIX-spelled
              // (same `split(path.sep).join("/")` fold `createDirectoryEvidence`
              // applies), and this one is meant to be re-issued verbatim — a
              // backslash spelling is a different string to every handle,
              // ignore-pattern and dedupe key downstream. `cwd` stays native:
              // it is an absolute host path, not a wire-relative one.
              path: path.relative(foreign, path.resolve(workspace, crossings[0]!.path))
                .split(path.sep).join("/"),
            },
          },
        }
      : {}),
  };
}
