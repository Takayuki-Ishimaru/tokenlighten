// contentSettlement — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { buildRoute } from "./coverageAndContinuation4.js";
import { canonicalContinuationCall } from "./packBasics.js";
import { changeScopeFollowupTarget } from "../changeScopeContinuation.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { deriveNextFromPlan } from "./packBasics.js";
import { enforceContinuationBudget } from "../../../util/continuation.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { hasServedZoomAffordance } from "../canonicalDecision.js";
import { hasSufficientEditContent } from "./wiringEvidence2.js";
import { isRequiredEnumReview } from "../changeScopeContinuation.js";
import { nextHintForCoverage } from "./coverageAndContinuation.js";
import { nextStringToCall } from "../../../util/continuation.js";
import { surfaceRangeShipped } from "./receiptProgress3.js";

/**
 * P1 fix: the standard "dedupe (pre-trim suppression) → trim → persist the
 * delivered code (post-trim)" pipeline every task_pack call site runs. Wraps
 * the ordering so the fingerprint WRITE can never again drift back before
 * trimToCap (which was the stale-`code_unchanged` bug).
 *
 * DESIGN-v0.8 coverage-honesty (Part 5): also the ONE choke point where the
 * structured check records are persisted for closure tracking — fires for
 * EVERY pack flow (locate, seeded, partial, diff, no-details abstain), AFTER
 * trim, so the session keeps the full record set even when the response's
 * `checks[]` lines were trimmed away. When `query`/`checkRecords` are omitted
 * (a caller with no checks to record), the session write is skipped.
 */
/**
 * DESIGN-v0.9 §4.3: recompute `route` and `next` against a post-trim pack whose
 * coverage was FLIPPED by a whole-surface drop. Uses the SAME buildRoute /
 * nextHintForCoverage the pre-trim path uses, so the values are
 * correct-by-construction for the reduced surface set — never a stale
 * "tl_edit_file handle=… (you're done)" next on a now-partial pack, and never an
 * absent route. Mutates `result` in place. Fired only on a coverage-STRING
 * change; a partial→partial reason-only change keeps its already-appropriate
 * partial `next`.
 */
export function recomputeRouteAndNextAfterTrim(
  result: TaskPackResult,
  rc: { query: string; missingRequired: string[]; unmatchedConcern: string[] },
): void {
  if (
    result.wiring?.status === "ready"
    && result.wiring.evidence_graph !== undefined
    && result.missing.length === 0
  ) {
    // A post-trim coverage flip must not replay the generic role gaps captured
    // before wiring proof was built. The proved consumer insertion frontier is
    // the authoritative route for this profile.
    result.route = {
      action: "edit_from_handles",
      reason: "wiring source, consumer, and insertion handle are bundled",
      max_additional_tl_calls: 0,
    };
    delete result.next;
    delete result.continuation;
    return;
  }
  result.route = buildRoute(
    result.surfaces, rc.missingRequired, result.coverage, result.missing, rc.query, result.coverage_reason,
  );
  if (result.route.action === "answer_from_handles") {
    delete result.next;
    delete result.continuation;
    return;
  }
  // rc.missingRequired (roles), NOT result.missing (roles + unresolvable caller
  // paths). This function's own doc comment already promised the pre-trim
  // values; only the argument had drifted, so a byte-trimmed pack emitted a
  // `surfaceRoles=[<a path>]` follow-up the next pack could never resolve.
  const nextHint = nextHintForCoverage(
    result.surfaces, result.coverage, result.coverage_reason, rc.query, rc.missingRequired, rc.unmatchedConcern,
  );
  if (nextHint !== undefined) result.next = nextHint;
  else delete result.next;
}

/**
 * DESIGN-v0.9 §4.4: stamp the response-level content_completeness ROLLUP.
 * CONVENTION (see the field docs on TaskPackSurface/TaskPackResult): the rollup
 * is emitted ONLY as "partial" and OMITTED when complete (absence = complete),
 * so it is "partial" iff any surface carries content_completeness:"partial"
 * (cliff-trimmed or body-stripped). Idempotent — clears a stale stamp when no
 * surface is partial (e.g. a pack_unchanged compact re-serialization).
 */
export function stampRollupContentCompleteness(result: TaskPackResult): void {
  if (result.surfaces.some((s) => s.content_completeness === "partial")) {
    result.content_completeness = "partial";
  } else {
    delete result.content_completeness;
  }
}

export function contentFollowupTarget(surface: TaskPackSurface, preferOutline = false): ContinuationCall | undefined {
  const outlineTargets = surface.outline
    ?.map((line) => line.match(/:\s+(tl_read_file\s+.+)$/)?.[1])
    .filter((target): target is string => target !== undefined) ?? [];
  if (preferOutline && outlineTargets.length > 0) {
    const handles = outlineTargets
      .map((target) => target.match(/\bhandle=(h[0-9a-z]+)\b/)?.[1])
      .filter((handle): handle is string => handle !== undefined);
    if (handles.length === outlineTargets.length && handles.length > 1) {
      return { tool: "tl_read_file", arguments: { handles } };
    }
    return canonicalContinuationCall(nextStringToCall(outlineTargets[0]!));
  }
  const remaining = surface.remaining_ranges?.[0];
  if (remaining) return { tool: "tl_read_file", arguments: { mode: "slice", handle: surface.handle, range: remaining } };
  const runnerUp = outlineTargets[0];
  if (runnerUp) return canonicalContinuationCall(nextStringToCall(runnerUp));
  // P1-3(e): read the hint's own `handle` field directly — `target` (the
  // legacy "tl_read_file mode=slice handle=..." string this used to regex-
  // parse via nextStringToCall) is retired.
  const inspectHandle = surface.likely_edits?.find((hint) => hint.kind === "inspect-slice")?.handle;
  if (inspectHandle !== undefined && inspectHandle !== surface.handle) {
    return { tool: "tl_read_file", arguments: { mode: "slice", handle: inspectHandle } };
  }
  // 2026-07-31: a same-handle re-slice only progresses when the caller does NOT
  // already hold the body. A fully-served surface reaches here through
  // hasSufficientEditContent's low-confidence branch (outline present,
  // inspect-slice confidence under the threshold) — and re-reading the identical
  // window cannot raise that confidence. Name no call at all rather than a
  // no-op read; the caller keeps the honest needs-followup verdict either way.
  if (!hasServedCode(surface)) return { tool: "tl_read_file", arguments: { mode: "slice", handle: surface.handle } };
  return undefined;
}

/** Keep coverage structural; gate editing separately on the bodies actually served. */
export function reconcileContentSufficiency(result: TaskPackResult, workspace?: string): void {
  // W9 defense-in-depth (2026-08-22): a resolved create route's terminal
  // fields are authoritatively owned by assertCreateRoute (the create-target
  // block sets them once; assertCreateRoute re-asserts them verbatim at the
  // pre-contract choke point). This function's default actionTargets rule has
  // no create-route awareness — with change_contract cleared by the create
  // block, it falls back to "surfaces[0] (or the first required surface) is
  // the mandatory edit target", which for a create task is a locator-era
  // surface that will never carry the new file's content. Bail out before
  // that default ever runs; create_target is still undefined the ONE time
  // this function legitimately runs before create-target resolution (from
  // refreshAfterRecursiveClosure), so this guard never masks that earlier,
  // still-relevant call.
  if (result.create_target !== undefined && result.route?.action === "edit_from_handles") {
    return;
  }
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  const editHandles = new Set(
    result.change_contract?.obligations
      .filter((obligation) => obligation.action === "edit")
      .map((obligation) => obligation.handle) ?? [],
  );
  const answerRequiredTargets = result.task_profile === "answer"
    ? surfaces.filter((surface) => surface.required === true)
    : [];
  const actionTargets = answerRequiredTargets.length > 0
    ? answerRequiredTargets
    : result.task_profile === "multi_concern"
    ? surfaces.filter((surface, index) => index === 0 || surface.required === true)
    : editHandles.size > 0
      ? surfaces.filter((surface) => editHandles.has(surface.handle))
      : surfaces.filter((surface, index) => index === 0 || surface.required === true);
  // A listed no-edit propagation claim needs its source proof too.
  for (const surface of surfaces) if (isRequiredEnumReview(surface.why)
    && !actionTargets.includes(surface)) actionTargets.push(surface);
  const hasFocusedTestEvidence = surfaces.some((surface) =>
    surface.role === "test"
    && hasServedCode(surface)
    && /query-(?:identifier|evidence)-test-match/.test(surface.why ?? "")
  );
  const incomplete = actionTargets.find((surface) => {
    if (hasSufficientEditContent(surface)) return false;
    // P1-9 (eval-0927 review-r4, hugeFocalValue): an answer task's surface
    // re-cut at the transport cap still lists lines its own earlier zooms
    // already shipped; the session's served-range ledger proving the whole
    // range shipped means no follow-up read remains (a spent zoom re-offered
    // as the route's `next` ended the chain `await_input`). Never for an edit
    // task — its frontier readiness stays on the surface's own content.
    if (workspace !== undefined && result.task_profile === "answer"
      && surfaceRangeShipped(workspace, surface.path, surface.range)) return false;
    // When the caller supplied both the exact implementation and a test slice
    // that mentions it, runner-up navigation is optional evidence rather than
    // a reason to re-read the implementation. A lone source seed does not get
    // this exemption: propagation queries still have to discover their real
    // contract/test/doc consumers.
    return !(
      hasFocusedTestEvidence
      && surface.why?.startsWith("anchor-focus: explicit query identifier ") === true
      && hasServedCode(surface)
      && surface.content_completeness !== "partial"
    );
  });
  if (!incomplete) {
    delete result.content_sufficiency;
    return;
  }

  result.content_sufficiency = "needs-followup";
  // Use the bound profile, not only the current route: trim reconciliation may
  // already have changed an answer route to inspect_handles before this pass.
  const answerTask = result.task_profile === "answer";
  // §3.4.1 / D1: a route already carrying the sanctioned served-zoom
  // affordance (answer_from_handles + budget exactly 1 over a partial
  // required surface) must not be downgraded to inspect_handles just because
  // the profile is answer — that IS the joint "prepared+partial primary"
  // shape AGENTS.md states, and downgrading it here would throw the
  // affordance away before buildTaskExecutionContract ever gets to honour it.
  const canInspect = result.route?.action === "edit_from_handles"
    || (answerTask && !hasServedZoomAffordance(result))
    || (result.route === undefined && result.coverage !== "partial" && result.missing.length === 0);
  if (!canInspect) return;
  const followup = (!answerTask ? changeScopeFollowupTarget(result) : undefined)
    ?? contentFollowupTarget(incomplete, answerTask);
  // No progressing read remains (see contentFollowupTarget's tail). Keep
  // content_sufficiency:"needs-followup" — that verdict is still true — but do
  // not install an inspect route whose one sanctioned action re-reads bytes the
  // response already served.
  if (followup === undefined) return;
  result.route = {
    action: "inspect_handles",
    reason: answerTask
      ? "answer evidence is incomplete; inspect the bundled relevant handles before answering"
      : "edit surface content is incomplete or low-confidence; inspect one handle before editing",
    max_additional_tl_calls: 1,
  };
  result.next = followup;
  delete result.continuation;
}

/**
 * Final post-trim guard: a required body which still names a bounded range is
 * not terminal evidence.  Several late seams append `missing[]` disclosures or
 * shed bodies after the first readiness contract has been built; merely
 * canonicalizing that old contract can otherwise publish `prepared` with no
 * executable way to read the range it just disclosed.
 */
export function preservePartialRangeProgress(result: TaskPackResult): boolean {
  // Multi-concern and answer profiles have their own certified document /
  // cumulative affordances. This guard repairs the generic native-body trim
  // path, where the clipped implementation itself is the only next evidence.
  if (result.profile_binding?.selected !== "generic") return false;
  // The response-level rollup is set by the byte-trim phase. A later optional
  // doc-sliver may carry navigation ranges without making the task's evidence
  // incomplete; those established prepared answers stay terminal.
  if (result.content_completeness !== "partial") return false;
  const surface = codeTaskPackSurfaces(result.surfaces).find((candidate) =>
    candidate.required !== false
    && /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(candidate.path)
    && (candidate.remaining_ranges?.length ?? 0) > 0
  );
  const range = surface?.remaining_ranges?.[0];
  if (surface === undefined || range === undefined) return false;
  const marker = `remaining-range:${surface.path}:${range}`;
  if (!result.missing.includes(marker)) {
    result.missing = [...result.missing, marker];
  }
  result.content_sufficiency = "needs-followup";
  const call: ContinuationCall = {
    tool: "tl_read_file",
    arguments: { mode: "slice", handle: surface.handle, range },
  };
  const plan = enforceContinuationBudget({
    version: 1,
    stages: [{ execution: "sequential", calls: [call] }],
  });
  if (plan !== undefined) {
    result.continuation = plan;
    const next = deriveNextFromPlan(plan);
    if (next !== undefined) result.next = next;
  }
  result.route = {
    action: "inspect_handles",
    reason: "a required served surface is partial; continue with its bounded remaining range",
    max_additional_tl_calls: 1,
  };
  return true;
}
