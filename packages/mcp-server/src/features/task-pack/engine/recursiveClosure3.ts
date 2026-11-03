// recursiveClosure — extracted implementation; imports point to the owning modules.
import type { ContinuationCall } from "./packBasics.js";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { FileReadCache } from "./packBasics2.js";
import { MAX_STAGE_CALLS } from "../../../util/continuation.js";
import { META_CONCERN_EVIDENCE_TOKENS } from "./roleAndConcernScope2.js";
import { RECURSIVE_READ_CLOSURE_MAX_BRANCHES } from "./readinessFalsification2.js";
import { admitReadOnlyNextCall } from "./unresolvedCalls.js";
import { buildRoute } from "./coverageAndContinuation4.js";
import { buildTaskChangeContract } from "./changeAndReadinessEvidence.js";
import { buildTaskWiringProfile } from "./wiringProfiles2.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { concernGroupsForQuery } from "./roleAndConcernScope3.js";
import { concernTokenMatchesSurface } from "./roleAndConcernScope3.js";
import { executeClosureRead } from "./recursiveClosure2.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { handleTable } from "../../../util/handles.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { nextHintForCoverage } from "./coverageAndContinuation.js";
import { pruneIrrelevantWiringImplementationSurfaces } from "./wiringProfiles2.js";
import { reconcileContentSufficiency } from "./contentSettlement.js";
import { reconcileTaskChangeContract } from "./contractReconciliation.js";
import { resolveReal } from "../../../util/safePath.js";
import { shouldBuildTaskChangeContract } from "./changeAndReadinessEvidence.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";

export function refreshAfterRecursiveClosure(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  workspace: string,
  cache?: FileReadCache,
): void {
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  const roles = new Set(surfaces.map((surface) => surface.role));
  result.missing = result.missing.filter((item) => !roles.has(item));
  if (result.missing_required_surfaces) {
    result.missing_required_surfaces = result.missing_required_surfaces.filter((item) => !roles.has(item));
  }
  let unmatched = unmatchedConcernTokens(query, surfaces);
  let unresolvedMultiConcerns = false;
  if (profile === "multi_concern" && result.concerns) {
    const groups = concernGroupsForQuery(query);
    for (const [index, concern] of result.concerns.entries()) {
      if (concern.status === "covered") continue;
      if (result.concern_ambiguities?.some((ambiguity) => ambiguity.id === concern.id)) continue;
      const group = groups[index];
      if (!group) continue;
      const evidenceTokens = group.tokens.filter((token) =>
        // R0 (2026-08-21, W4-A): compare case-insensitively — group.tokens
        // (concernAnchorTokens) may now carry a case-preserved identifier
        // (e.g. "buildInitializeInstructions") since orderedUniqueTokens
        // stopped silently lowercasing its output; META_CONCERN_EVIDENCE_TOKENS
        // is lowercase-only.
        !META_CONCERN_EVIDENCE_TOKENS.has(token.toLowerCase())
      );
      const matches = surfaces.filter((surface) =>
        evidenceTokens.some((token) => concernTokenMatchesSurface(token, surface))
      );
      if (matches.length > 0) {
        concern.status = "covered";
        concern.handles = [...new Set(matches.map((surface) => surface.handle))];
      }
    }
    unresolvedMultiConcerns = result.concerns.some((concern) => concern.status === "needs-followup");
    if (unresolvedMultiConcerns) {
      result.coverage = "partial";
      result.coverage_reason = "concerns-uncovered";
    }
  }
  if (
    !unresolvedMultiConcerns
    && result.missing.length === 0
    && unmatched.length === 0
    && (result.coverage_reason === "missing-roles" || result.coverage_reason === "concerns-uncovered")
  ) {
    result.coverage = "focused";
    delete result.coverage_reason;
    delete result.blocking_next_steps;
  } else if (
    !unresolvedMultiConcerns
    && result.coverage_reason === "missing-roles"
    && result.missing.length === 0
    && (result.missing_required_surfaces?.length ?? 0) === 0
  ) {
    // B1b (2026-08-01 retrieval-scope): the closure covered every role the
    // filters above could name, but an unmatched CONCERN token still holds the
    // pack partial — so the "missing-roles" label now names nothing. That exact
    // combination shipped `partial + missing-roles + missing:[]` live (run
    // 2026-07-31-semantic-signal5-2, T09 rep1/rep2). Report the reason that is
    // actually true; reconcileMissingRolesContract enforces the same invariant
    // at the shared exit for every other producer.
    result.coverage_reason = "concerns-uncovered";
  }

  if (profile === "wiring") {
    result.wiring = buildTaskWiringProfile(query, result.surfaces, workspace, cache);
    pruneIrrelevantWiringImplementationSurfaces(result);
    surfaces.splice(0, surfaces.length, ...codeTaskPackSurfaces(result.surfaces));
    unmatched = unmatchedConcernTokens(query, surfaces);
    if (result.wiring.status === "ready" && result.wiring.evidence_graph !== undefined) {
      // Recursive closure recomputes the generic role inventory. Neutral
      // directory names can reintroduce contract/api gaps even though the
      // wiring graph still proves the producer, consumer, adapter, and
      // callable insertion site. The graph is the authoritative proof for a
      // wiring task, so do not send the agent back through filename-driven
      // discovery after that proof is complete.
      result.missing = [];
      delete result.missing_required_surfaces;
      if (
        result.coverage_reason === "candidate-list"
        || result.coverage_reason === "missing-roles"
      ) {
        result.coverage = "focused";
        delete result.coverage_reason;
        delete result.blocking_next_steps;
      }
    }
  }
  reconcileContentSufficiency(result);
  // 2026-07-31: `missing_required_surfaces` is omitted from the wire whenever
  // missingRequired is EMPTY, so an ABSENT field means "nothing is required" —
  // it must not fall back to the union. `result.missing` mixes surface ROLES
  // with unresolvable caller inputs (nonexistent paths, unexpanded directory
  // notes); feeding those here produced `missing required surface(s): <a path>`
  // and, 30 lines below, a `surfaceRoles=[<a path>]` next_call that no pack can
  // ever satisfy — the caller re-ran it forever. Elsewhere in this file the same
  // expression is already spelled `?? []`; this call site was the lone exception.
  result.route = buildRoute(
    surfaces,
    result.missing_required_surfaces ?? [],
    result.coverage,
    result.missing,
    query,
    result.coverage_reason,
  );
  if (unresolvedMultiConcerns) {
    const unresolvedIds = result.concerns
      ?.filter((concern) => concern.status === "needs-followup")
      .map((concern) => concern.id) ?? [];
    result.route = {
      action: "locate_missing_surfaces",
      reason: `unresolved concern(s): ${unresolvedIds.join(",")}`,
      max_additional_tl_calls: Math.ceil(unresolvedIds.length / MAX_STAGE_CALLS),
    };
  }
  if (profile === "answer" && result.route.action === "edit_from_handles") {
    result.route = {
      action: "answer_from_handles",
      reason: "recursive read-only closure bundled the answer evidence",
      max_additional_tl_calls: 0,
    };
  }
  // Build the change contract after the refreshed route. A wiring task can
  // become edit-ready only during recursive closure; building against the
  // preceding locate route would omit the otherwise-ready obligations.
  if (query.length > 0 && shouldBuildTaskChangeContract(query, result, profile)) {
    result.change_contract = buildTaskChangeContract(query, result, workspace);
  }
  reconcileTaskChangeContract(result);
  const next = nextHintForCoverage(
    surfaces,
    result.coverage,
    result.coverage_reason,
    query,
    // Roles only: this parameter is what the missing-roles branch turns into
    // `surfaceRoles=[...]`. See the buildRoute call above for why
    // `result.missing` is the wrong array to hand it.
    result.missing_required_surfaces ?? [],
    unmatched,
  );
  if (next) result.next = next;
  else delete result.next;
}

/**
 * Bounded candidate-list expansion (2026-07-19a T13 rep0): a candidate-list
 * pack used to break out of closure with CODELESS candidates and no stop
 * condition — the most ambiguous shape got the least server help, and the
 * model thrashed full/slice/search for 109 turns ($6.15 vs $2.21 paired).
 * One pass inlines the ranked candidates' own bodies
 * (<= RECURSIVE_READ_CLOSURE_MAX_BRANCHES, under the closureCanMerge byte
 * cap) into THIS response so "here are N names" becomes "here are N bodies —
 * choose". Never recurses: after the pass the pack stops explicitly (see
 * buildTaskExecutionContract's choose-candidate close).
 */
export function runCandidateInlinePass(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  workspace: string,
  receipt: NonNullable<TaskPackResult["internalized"]>,
  cache?: FileReadCache,
): number {
  const codeless = [...new Set(
    codeTaskPackSurfaces(result.surfaces)
      .filter((surface) => !hasServedCode(surface))
      .map((surface) => surface.handle),
  )].slice(0, RECURSIVE_READ_CLOSURE_MAX_BRANCHES);
  if (codeless.length === 0) return 0;
  const used = executeClosureRead(
    result,
    { tool: "tl_read_file", arguments: { handles: codeless } },
    workspace,
  );
  if (used.evidence > 0) {
    receipt.push({
      op: "read",
      status: "used",
      evidence: used.evidence,
      ...(used.handle ? { handle: used.handle } : {}),
    });
    refreshAfterRecursiveClosure(result, profile, query, workspace, cache);
  }
  return 1;
}

export function isCandidateListPack(result: TaskPackResult): boolean {
  return result.route?.action === "confirm_candidates" || result.coverage_reason === "candidate-list";
}

export const DUPLICATE_SYMPTOM_RE = /\b(?:double|duplicate|duplicated|twice)\b|重複|二重|[2２]\s*件/iu;

/**
 * A duplicate-event report can disambiguate itself: when one served body is
 * the only candidate that repeats the caller's all-caps event identifier, it
 * is the defect site rather than a definition or display consumer.
 */
export function resolveServedDuplicateCandidate(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
): boolean {
  if (profile === "answer" || !isCandidateListPack(result) || !DUPLICATE_SYMPTOM_RE.test(query)) {
    return false;
  }
  const identifiers = explicitCodeIdentifiers(query)
    .filter((identifier) => /^[A-Z][A-Z0-9_]{3,}$/.test(identifier));
  if (identifiers.length === 0) return false;
  const candidates = codeTaskPackSurfaces(result.surfaces).filter(hasServedCode);
  const scored = candidates.map((surface) => {
    const body = surface.code ?? surface.code_unchanged ?? "";
    const repeats = Math.max(0, ...identifiers.map((identifier) =>
      body.split(identifier).length - 1
    ));
    return { surface, repeats };
  });
  const maxRepeats = Math.max(0, ...scored.map(({ repeats }) => repeats));
  const winners = scored.filter(({ repeats }) => repeats === maxRepeats);
  if (maxRepeats < 2 || winners.length !== 1) return false;

  const winner = winners[0]!.surface;
  winner.required = true;
  result.surfaces = result.surfaces.filter((surface) =>
    isArtifactTaskPackSurface(surface) || surface.handle === winner.handle
  );
  result.coverage = "focused";
  delete result.coverage_reason;
  result.missing = [];
  delete result.missing_required_surfaces;
  delete result.blocking_next_steps;
  delete result.concern_ambiguities;
  delete result.next;
  delete result.continuation;
  result.checks = [];
  return true;
}

export function admitLeanSameHandleClosure(
  result: TaskPackResult,
  candidate: ContinuationCall,
  originalQuery: string,
  workspace: string,
): ContinuationCall | undefined {
  const call = admitReadOnlyNextCall(candidate, originalQuery);
  if (call?.tool !== "tl_read_file") return undefined;
  const args = call.arguments;
  const disallowedSelectors = [
    "ranges", "symbol", "path", "paths", "query", "qref", "targets",
    "scope", "archive", "artifact", "select",
  ];
  if (disallowedSelectors.some((key) => Object.prototype.hasOwnProperty.call(args, key))) {
    return undefined;
  }
  const handles: string[] = [];
  if (typeof args["handle"] === "string") handles.push(args["handle"]);
  if (Array.isArray(args["handles"])) {
    if (args["handles"].some((item) => typeof item !== "string")) return undefined;
    handles.push(...args["handles"] as string[]);
  }
  // Lean closure completes one surface that the pack already selected. It is
  // not permission to discover by path/query/symbol, create a new surface, or
  // choose among several handles.
  if (handles.length !== 1) return undefined;
  const handle = handles[0]!;
  const entry = handleTable.get(handle);
  if (!entry?.path || resolveReal(entry.workspaceRoot) !== resolveReal(workspace)) return undefined;
  const requiredOpenSurfaces = codeTaskPackSurfaces(result.surfaces).filter((item) =>
    item.required !== false && (!hasServedCode(item) || (item.remaining_ranges?.length ?? 0) > 0)
  );
  // A contract may nominate one of several open handles. Treat that as a
  // hidden choice, not as permission to make the choice inside the server.
  if (requiredOpenSurfaces.length !== 1) return undefined;
  const surface = requiredOpenSurfaces[0]!;
  if (
    surface.handle !== handle
    || surface.path !== entry.path
    || surface.range !== entry.range
  ) return undefined;

  if (
    Object.prototype.hasOwnProperty.call(args, "range")
    && typeof args["range"] !== "string"
  ) return undefined;
  const requestedRange = typeof args["range"] === "string" ? args["range"] : undefined;
  if (hasServedCode(surface)) {
    if (requestedRange === undefined || !surface.remaining_ranges?.includes(requestedRange)) return undefined;
  } else if (requestedRange !== undefined && requestedRange !== surface.range) {
    return undefined;
  }
  return {
    ...call,
    arguments: {
      handle,
      ...(requestedRange ? { range: requestedRange } : {}),
    },
  };
}
