/**
 * fullGovernor.ts — v0.7 full-read governor.
 *
 * Decides whether a mode=full read should be allowed, downgraded, or denied.
 * Pure: no fs I/O. Caller provides byteSize, lineCount, sha, etc.
 * Calls recordFullExpansion to update session state when the decision is "allow".
 */

import {
  recordFullExpansion,
  recordTinyFullExpansion,
  recordAllowFullExpansion,
  recordCandidatePackFullRead,
  recordRepeatedRead,
  getSession,
} from "../state/session.js";
import { getAdaptiveAdvice } from "./adaptive.js";
// Compatibility export: callers historically imported this limit from the
// governor module.
export { PER_TASK_FULL_CAP } from "../shared/readLimits.js";

// ---------------------------------------------------------------------------
// Exported threshold constants
// ---------------------------------------------------------------------------

export const TINY_BYTES = 8 * 1024;
export const TINY_LINES = 250;

/**
 * Per-task full-read shape governor for tiny files. The default keeps the
 * first six tiny full reads as full content; set TL_TINY_SKELETON_CAP=0 to
 * disable this shape cap, or =N to override it for a process.
 */
export const TINY_SKELETON_CAP = 6;

function configuredTinySkeletonCap(): number {
  const raw = process.env["TL_TINY_SKELETON_CAP"];
  if (raw === undefined || raw.trim() === "") return TINY_SKELETON_CAP;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : TINY_SKELETON_CAP;
}
/**
 * turn-economy wave 2 (W1): per-response byte budget for a GOVERNED full
 * serve. When a mode=full/auto/small_file read is downgraded by any governor
 * cap (per-path, per-task, tiny, allowFull, candidate-pack) OR exceeds the raw
 * byte cap, the response now SERVES the file head up to this many bytes with a
 * `truncated` flag + a remainder `next` — never a zero-content skeleton with a
 * breadcrumb the caller must spend a whole extra API turn to redeem. Matches
 * readCodeTaskPack.ts's MAX_SURFACE_CODE_BYTES (kept as a separate constant to
 * avoid importing across the tool/util boundary): the caps now bound
 * bytes-per-response, not force a second call.
 */
export const GOVERNED_FULL_SERVE_BYTES = 12288;
export const LARGE_BYTES = 24 * 1024;
export const LARGE_LINES = 800;
export const PER_PATH_FULL_CAP = 1;
/**
 * DESIGN-v0.8 §C4: tiny files (<=TINY_BYTES/<=TINY_LINES) are exempt from
 * PER_PATH_FULL_CAP/PER_TASK_FULL_CAP — that exemption is what let an agent
 * load many whole small files into permanent context (one live task: 9 whole
 * files, 61K chars). TINY_TASK_CAP is a SEPARATE, independent budget scoped only to
 * tiny-file full expansions: the first TINY_TASK_CAP tiny full-reads in a
 * session stay cheap (unconditional allow, matching pre-C4 behavior); the
 * next one downgrades to skeleton+handle via the same alternatives/downgrade
 * payload shape non-tiny reads already use.
 *
 * FIX-3b (2026-07-09d forensics): raised 5 -> 8. 84% of that run's 25
 * tiny-task-cap events were a single legitimate pattern — a firmware-fixture
 * small-header fan-out (many genuinely tiny header files read in one
 * coherent chain) — tripping the cap partway through and downgrading the
 * rest of the chain. 8 clears the observed chain lengths while still
 * bounding the pathological many-whole-small-files slurp the cap
 * exists for. governorExempt callers (readCodePack's explicit paths[]
 * enumeration) are UNAFFECTED by this constant either way — see
 * recordTinyFullExpansion's exempt counter in session.ts, which keeps their
 * recording out of this budget entirely (FIX-3a).
 *
 * 2026-07-16a: raised 8 -> 64. This cap is a runaway backstop against the
 * many-whole-small-files slurp, not a routine governor on ordinary tiny
 * reads — the turn-economy analysis found a downgrade here forces an extra
 * API turn (~$0.03, ~100k cache-read tokens) that a tiny file's worth of
 * extra content (well under $0.01) never justifies. 8 was still tight enough
 * to fire on ordinary chains: 30 outline->slice double round-trips in that
 * bench run were this cap (and the AUTO_FULL_THRESHOLD_BYTES/TINY_BYTES gap
 * it interacted with) manufacturing a second turn for content the agent was
 * always going to fetch anyway. 64 keeps the backstop against a genuine
 * pathological slurp while staying out of the way of normal work.
 */
export const TINY_TASK_CAP = 64;
/**
 * A-4 (reports/bench/2026-07-03a): allowFull=true bypasses PER_TASK_FULL_CAP
 * entirely — the allowFull branch below only ever consulted PER_PATH_FULL_CAP,
 * so one full read per DISTINCT path was unbounded (one live doc-heavy task
 * legally did 10 full reads, ~50K cache-read tokens each). ALLOWFULL_TASK_CAP is a SEPARATE
 * session-total budget scoped only to allowFull expansions (tracked by
 * allowFullExpansionsTotal, independent of fullExpansionsTotal): the first
 * ALLOWFULL_TASK_CAP allowFull full-reads are served, the next downgrades to
 * skeleton+handle via the same served-downgrade payload. Chosen higher than
 * PER_TASK_FULL_CAP because allowFull is an explicit opt-in — the cap is a
 * runaway backstop, not the primary throttle.
 */
export const ALLOWFULL_TASK_CAP = 12;
/**
 * 2026-07-19a candidate-pack brake: while a candidate-list task pack's choice
 * is pending (session.candidatePackPending), broad full reads are capped at
 * this many across BOTH the plain and allowFull budgets. The pack already
 * serves the ranked candidates' own bodies inline (readCodeTaskPack's
 * candidate inline pass), so tree-wide full re-reads past a small allowance
 * are the T13 rep0 runaway shape (23 full + 23 slice calls in one cell), not
 * discovery. Tiny files stay exempt (cheap); the brake releases on an edit, a
 * non-candidate pack, or taskEpoch:"new".
 */
export const CANDIDATE_PACK_FULL_CAP = 2;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FullReadAlternative {
  mode: string;
  handle?: string;
  range?: string;
}

export interface FullReadDecision {
  decision: "allow" | "downgrade" | "deny";
  reason?: string;
  alternatives?: FullReadAlternative[];
  /**
   * G2: set to "first-read-under-allowFull-ceiling" when this allow is the C5
   * first-read auto-allow (a genuine FIRST read of a file between the default
   * cap and LARGE_BYTES, no allowFull supplied, per-task budget not exhausted).
   * The server carries it through as the response's `auto_allowed` note. Any
   * other allow (including a normal sub-cap allow) leaves this undefined.
   */
  autoAllowed?: "first-read-under-allowFull-ceiling";
}

export interface DecideFullReadArgs {
  workspace: string;
  path: string;
  byteSize: number;
  lineCount: number;
  sha: string;
  allowFull?: boolean;
  hasFileHandle?: boolean;
  taskPackCoverageComplete?: boolean;
  fileHandle?: string;
  /**
   * G2: the server sets this when the file is OVER the default read byte cap
   * but still within the C5 auto-allow window (<= LARGE_BYTES) and allowFull
   * was NOT supplied — i.e. a plain retry with allowFull would be guaranteed
   * to succeed. When true and this is a genuine per-path first read AND the
   * per-task budget is not exhausted, the decision is a plain "allow" carrying
   * autoAllowed:"first-read-under-allowFull-ceiling" (skipping the wasted
   * downgrade→retry turn). When the per-task budget IS exhausted, it downgrades
   * even on a first read — closing the pre-G2 hole where this inline branch
   * never consulted the per-task cap and served unbounded distinct 12-24KB
   * full reads. Only meaningful for non-tiny files with allowFull absent; the
   * server never sets it otherwise.
   */
  autoAllowUnderCeiling?: boolean;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Decide whether a full-file read should proceed, be downgraded, or be denied.
 *
 * When the decision is "allow", side-effects recordFullExpansion on the session.
 */
export function decideFullRead(args: DecideFullReadArgs): FullReadDecision {
  // D10 (2026-08-14): the governor is unconditional. `TL_FULL_GOVERNOR` and its
  // always-allow off-branch are deleted.
  const session = getSession(args.workspace);
  const isTiny = args.byteSize <= TINY_BYTES && args.lineCount <= TINY_LINES;

  // A candidate pack already paid to inline the bounded choices. Counting
  // only non-tiny files let an agent reopen discovery by full-reading dozens
  // of small enum/UI/route files (T09). The pending-choice budget is a turn
  // budget, independent of file size, so apply it before the tiny exemption.
  if (session.candidatePackPending && session.candidatePackFullReads >= CANDIDATE_PACK_FULL_CAP) {
    return {
      decision: "downgrade",
      reason: "candidate-pack-full-repeat",
      alternatives: buildAlternatives(args),
    };
  }

  // DESIGN-v0.8 §C4: tiny files are cheap enough to always allow — but only
  // up to their OWN separate TINY_TASK_CAP budget. Checked BEFORE recording
  // this read (same "check then record" order as the non-tiny per-task/
  // per-path checks below), so exactly TINY_TASK_CAP reads are allowed and
  // the (TINY_TASK_CAP+1)th downgrades.
  if (isTiny) {
    if (session.tinyFullExpansionsTotal >= TINY_TASK_CAP) {
      return {
        decision: "downgrade",
        reason: "tiny-task-cap-reached",
        alternatives: buildAlternatives(args),
      };
    }
    // Once the configured tiny shape budget is spent, return the same
    // structure-first downgrade used by the per-task governor. A zero value
    // explicitly disables this lower cap while retaining TINY_TASK_CAP.
    const tinySkeletonCap = configuredTinySkeletonCap();
    if (tinySkeletonCap > 0 && session.tinyFullExpansionsTotal >= tinySkeletonCap) {
      return {
        decision: "downgrade",
        reason: "tiny-skeleton-cap-reached",
        alternatives: buildAlternatives(args),
      };
    }
    recordFullExpansion(args.workspace, args.path, args.sha);
    // FIX-3a: this call site is the ordinary agent-facing tiny read (no
    // exempt-recording concept here — decideFullRead has no governorExempt
    // parameter) so it deliberately omits recordTinyFullExpansion's `exempt`
    // argument, recording into the gated tinyFullExpansionsTotal counter the
    // cap check above reads. See session.ts's recordTinyFullExpansion for the
    // exempt counter readCodeSmallFile.ts's governorExempt path uses instead.
    recordTinyFullExpansion(args.workspace);
    recordCandidatePackFullRead(args.workspace);
    return { decision: "allow" };
  }

  // Check per-path counter (after potential sha-change reset from recordFullExpansion peek).
  const prevEntry = session.fullExpansionsPerPath.get(args.path);
  const shaChanged = prevEntry !== undefined && prevEntry.lastSha !== args.sha;

  // Effective per-path count: reset to 0 when sha changed (recordFullExpansion will set it to 1).
  const effectivePathCount = (prevEntry === undefined || shaChanged) ? 0 : prevEntry.count;

  // Record this as a repeated read (sentinel range "full") for adaptive tracking.
  recordRepeatedRead(args.workspace, args.path, "full");

  // Consult adaptive advice for a potentially tightened per-task cap.
  const advice = getAdaptiveAdvice(args.workspace);
  const effectiveCap = advice.effectivePerTaskCap;

  // 2026-07-19a candidate-pack brake (see CANDIDATE_PACK_FULL_CAP): applies
  // to BOTH the plain and allowFull branches below — allowFull is an opt-in
  // around the per-task budget, not around a pending candidate choice.
  // allowFull=true bypasses the per-task cap but not the per-path cap (one full
  // per path unless sha changes) — and, A-4, not the SEPARATE
  // ALLOWFULL_TASK_CAP session-total budget. The allowFull-total check comes
  // BEFORE the per-path check (same "check then record" order as the tiny
  // branch above) so a distinct path over the allowFull budget downgrades
  // rather than being served as an unbounded first read.
  if (args.allowFull === true) {
    if (session.allowFullExpansionsTotal >= ALLOWFULL_TASK_CAP) {
      return {
        decision: "downgrade",
        reason: "allowfull-task-cap-reached",
        alternatives: buildAlternatives(args),
      };
    }
    if (effectivePathCount >= PER_PATH_FULL_CAP) {
      return {
        decision: "downgrade",
        reason: "per-path-cap-reached",
        alternatives: buildAlternatives(args),
      };
    }
    recordFullExpansion(args.workspace, args.path, args.sha);
    recordAllowFullExpansion(args.workspace);
    recordCandidatePackFullRead(args.workspace);
    return { decision: "allow" };
  }

  // Per-task cap check (uses adaptive effective cap, which may be lower than the static constant).
  if (session.fullExpansionsTotal >= effectiveCap) {
    return {
      decision: "downgrade",
      reason: "per-task-cap-reached",
      alternatives: buildAlternatives(args),
    };
  }

  // Per-path cap check.
  if (effectivePathCount >= PER_PATH_FULL_CAP) {
    return {
      decision: "downgrade",
      reason: "per-path-cap-reached",
      alternatives: buildAlternatives(args),
    };
  }

  recordFullExpansion(args.workspace, args.path, args.sha);
  recordCandidatePackFullRead(args.workspace);
  // G2: this allow is reached only AFTER the per-task and per-path cap checks
  // above pass — so an over-default-cap file in the C5 window is served
  // directly (skipping the wasted downgrade→retry-with-allowFull turn) ONLY
  // when the per-task budget still has room. When the budget is exhausted, the
  // per-task-cap check above already returned a downgrade, closing the pre-G2
  // hole where the inline server branch served unbounded distinct 12-24KB
  // reads without ever consulting the cap.
  if (args.autoAllowUnderCeiling === true) {
    return { decision: "allow", autoAllowed: "first-read-under-allowFull-ceiling" };
  }
  return { decision: "allow" };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildAlternatives(args: DecideFullReadArgs): FullReadAlternative[] {
  const sliceRange = `1-${Math.min(50, args.lineCount)}`;
  const alts: FullReadAlternative[] = [];

  // slice as the most targeted alternative.
  alts.push({
    mode: "slice",
    ...(args.fileHandle ? { handle: args.fileHandle } : {}),
    range: sliceRange,
  });

  // task_pack is always a valid fallback.
  alts.push({
    mode: "task_pack",
    ...(args.fileHandle ? { handle: args.fileHandle } : {}),
  });

  return alts;
}
