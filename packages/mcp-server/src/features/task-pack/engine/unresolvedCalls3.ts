// unresolvedCalls — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { TaskCallBudget } from "@tokenlighten/types";
import type { TaskFalsificationReport } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskReadinessCertificate } from "@tokenlighten/types";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import type { TaskReadinessRisk } from "@tokenlighten/types";
import type { TaskWorkspaceState } from "@tokenlighten/types";
import { READINESS_NORMALIZED_TURN_COST } from "./changeAndReadinessEvidence.js";
import { UNCOVERED_EPOCH_CONCERN_PREFIX } from "./epochContract2.js";
import { UNREADABLE_NAMED_PATH_PREFIX } from "./queryIntent4.js";
import { UNSERVED_EPOCH_ROLE_PREFIX } from "./epochContract2.js";
import { anchorDefinitionsFor } from "../anchorFirst.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { isAnswerIntentQuery } from "./coverageAndContinuation4.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { packAnchorIO } from "./roleAndConcernScope3.js";
import { shaOfText } from "../../../util/handles.js";

/** Longest declaration a definition read asks for in one target. */
export const ANCHOR_DEFINITION_READ_MAX_LINES = 400;

/**
 * …and the most source BYTES of it one read asks for. The read exists to put the declaration in
 * front of the caller (the obligation is proved by its first line); a declaration that cannot be
 * delivered in one page under a byte ceiling (a 160-branch function under an 8 KiB budget) would
 * come back as a bodyless row again and again, so its head is read and the rest is the body's
 * own obligation (`behavior-body`, the facet windows), which pages.
 */
export const ANCHOR_DEFINITION_READ_MAX_BYTES = 3200;

/** A definition read always asks for at least this many lines of the declaration. */
export const ANCHOR_DEFINITION_READ_MIN_LINES = 8;

/** Targets a single anchor-definition read carries. */
export const ANCHOR_DEFINITION_READ_MAX_TARGETS = 3;

/**
 * 2026-10-29: the ONE ranged read that fetches the declaration of every
 * still-uncovered anchor obligation (`identifier:<X>` for an X the request
 * names and the workspace defines) — `targets:[{path, range}]` over the
 * declaration's own span, query-bearing so the response re-enters the pack
 * with a decision. Never a name search: that returns the call sites the
 * obligation exists to see past.
 */
export function anchorDefinitionGap(
  obligations: readonly TaskReadinessObligation[],
  query: string,
  workspace: string,
): { next_call: ContinuationCall; ids: string[] } | undefined {
  const targets: Array<{ path: string; range: string }> = [];
  const ids: string[] = [];
  for (const obligation of obligations) {
    if (obligation.status === "proved" || obligation.kind !== "explicit-identifier" || !obligation.id.startsWith("identifier:")) continue;
    const io = packAnchorIO(workspace, undefined);
    const definition = anchorDefinitionsFor(io, query, obligation.id.slice("identifier:".length))[0];
    if (definition === undefined) continue;
    let last = Math.min(definition.endLine, definition.startLine + ANCHOR_DEFINITION_READ_MAX_LINES - 1);
    const text = io.read(definition.path);
    if (text !== undefined) {
      const lines = text.split(/\r?\n/);
      let bytes = 0;
      let end = definition.startLine - 1;
      for (let index = definition.startLine - 1; index < last; index++) {
        bytes += Buffer.byteLength(lines[index] ?? "", "utf8") + 1;
        if (bytes > ANCHOR_DEFINITION_READ_MAX_BYTES && index + 1 - definition.startLine >= ANCHOR_DEFINITION_READ_MIN_LINES) break;
        end = index;
      }
      last = Math.max(definition.startLine, Math.min(last, end + 1));
    }
    targets.push({ path: definition.path, range: `${definition.startLine}-${last}` });
    ids.push(obligation.id);
    if (targets.length >= ANCHOR_DEFINITION_READ_MAX_TARGETS) break;
  }
  if (targets.length === 0) return undefined;
  return { next_call: { tool: "tl_read_file", arguments: { query, targets, content: "auto" } }, ids };
}

/**
 * 2026-10-29: stamps what the anchor obligations say about this pack — the
 * definition read that closes the uncovered ones (`request_item_gap`, which
 * `canonicalDecision.ts`'s `unservedRequestItemZoom` turns into `discover`
 * before the certificate is consulted) and `anchor_closure`, whether every
 * anchor the workspace defines is proved by a served declaration (read by
 * `canonicalDecision.ts` to stop proposing document / candidate zooms once the
 * named subject is answered). Re-run with every contract rebuild: the stamps
 * always describe the latest obligations.
 */
export function stampAnchorObligations(
  result: TaskPackResult,
  obligations: readonly TaskReadinessObligation[],
  query: string,
  workspace: string | undefined,
  profile: TaskProfile,
): void {
  if (profile !== "answer" || workspace === undefined) return;
  const io = packAnchorIO(workspace, undefined);
  const anchorObligations = obligations.filter((obligation) =>
    obligation.kind === "explicit-identifier"
    && obligation.id.startsWith("identifier:")
    && anchorDefinitionsFor(io, query, obligation.id.slice("identifier:".length)).length > 0);
  const ownGap = (gap: TaskPackResult["request_item_gap"]): boolean =>
    gap !== undefined && gap.ids.length > 0 && gap.ids.every((id) => id.startsWith("identifier:"));
  if (anchorObligations.length === 0) {
    delete result.anchor_closure;
    if (ownGap(result.request_item_gap)) delete result.request_item_gap;
    return;
  }
  const uncovered = anchorObligations.filter((obligation) => obligation.status !== "proved");
  // Closure claims the NAMED SUBJECT is answered, so zoom proposals (a document page, a candidate
  // bundle) can stop. It does not hold while the pack still has an open obligation of any kind (the
  // callers of a second subject, a constant a request item names) or is still a candidate list: those
  // zooms are the continuation.
  const settled = obligations.every((obligation) => obligation.status === "proved")
    && result.coverage_reason !== "candidate-list"
    && result.route?.action !== "confirm_candidates";
  result.anchor_closure = {
    satisfied: uncovered.length === 0 && settled && isAnswerIntentQuery(query),
    ids: anchorObligations.map((obligation) => obligation.id),
  };
  const gap = anchorDefinitionGap(uncovered, query, workspace);
  if (gap === undefined) {
    if (ownGap(result.request_item_gap)) delete result.request_item_gap;
    return;
  }
  const existing = ownGap(result.request_item_gap) ? undefined : result.request_item_gap;
  const existingTargets = (existing?.next_call.arguments as { targets?: unknown } | undefined)?.targets;
  if (existing === undefined || !Array.isArray(existingTargets)) {
    result.request_item_gap = gap;
    return;
  }
  const ownTargets = (gap.next_call.arguments as { targets: Array<{ path: string; range: string }> }).targets;
  const keyOf = (target: { path: string; range?: string }): string => `${target.path}\u0000${target.range ?? ""}`;
  const own = new Set(ownTargets.map(keyOf));
  result.request_item_gap = {
    next_call: {
      ...existing.next_call,
      arguments: { ...existing.next_call.arguments, targets: [...ownTargets, ...(existingTargets as Array<{ path: string; range?: string }>).filter((target) => !own.has(keyOf(target)))] },
    },
    ids: [...gap.ids, ...existing.ids],
  };
}

export function certificateIdentityProfile(result: TaskPackResult, proofProfile: TaskProfile): TaskProfile {
  // Cumulative proof can evaluate held roles with generic obligations. Its
  // task identity still belongs to the original selected request profile.
  return result.coverage_basis === "cumulative" && proofProfile === "generic"
    ? result.profile_binding?.selected ?? result.task_profile ?? proofProfile : proofProfile;
}

export function deterministicCertificate(
  query: string,
  profile: TaskProfile,
  obligations: TaskReadinessObligation[],
  falsification: TaskFalsificationReport,
  risk: TaskReadinessRisk,
  actionFrontier: string[],
  workspaceState: TaskWorkspaceState,
  ledgerDigest?: string,
  identityProfile: TaskProfile = profile,
): TaskReadinessCertificate {
  const taskHash = shaOfText(`${identityProfile}\u0000${query}`).replace(/^sha256:/, "").slice(0, 16);
  const proofHash = shaOfText(JSON.stringify({
    taskHash,
    ...(identityProfile !== profile ? {proofProfile: profile} : {}),
    obligations: obligations.map((obligation) => [obligation.id, obligation.status, (obligation.evidence ?? []).map((item) => item.handle)]),
    actionFrontier,
    workspaceState: workspaceState.fingerprint,
    ledgerDigest,
  })).replace(/^sha256:/, "").slice(0, 16);
  return {
    version: 1,
    id: ledgerDigest === undefined ? `ready-${proofHash}` : `ready-${ledgerDigest.slice(0, 16)}-${proofHash}`,
    task_fingerprint: `task-${taskHash}`,
    workspace_state_fingerprint: workspaceState.fingerprint,
    profile,
    obligations,
    evidence_handles: [...new Set(obligations.flatMap((obligation) => (obligation.evidence ?? []).map((item) => item.handle)))].slice(0, 16),
    action_frontier: actionFrontier,
    falsification,
    risk,
  };
}

export function valueCallBudget(
  terminalAction: "answer" | "edit",
  baseReady: boolean,
  accepted: boolean,
  unresolvedCount: number,
  risk: TaskReadinessRisk,
  candidateCall: ContinuationCall | undefined,
): TaskCallBudget {
  const expectedDecisionChange = accepted
    ? Math.min(0.1, risk.estimated_false_ready_risk)
    : Math.min(0.98, Math.max(baseReady ? 0.72 : 0.58, unresolvedCount * 0.22));
  const falseReadyWeight = terminalAction === "edit" ? 1.35 : 1.1;
  const expectedValue = Number((expectedDecisionChange * falseReadyWeight).toFixed(3));
  const discoveryAllowed = !accepted && candidateCall !== undefined && expectedValue > READINESS_NORMALIZED_TURN_COST;
  return {
    version: 2,
    policy: "expected-decision-change",
    normalized_turn_cost: READINESS_NORMALIZED_TURN_COST,
    expected_decision_change: Number(expectedDecisionChange.toFixed(3)),
    expected_value: expectedValue,
    decision_threshold: READINESS_NORMALIZED_TURN_COST,
    discovery_allowed: discoveryAllowed,
    terminal_action: terminalAction,
    ...(candidateCall ? { candidate_call: candidateCall } : {}),
    reason: discoveryAllowed
      ? "candidate evidence can change the terminal action and exceeds one-turn cost"
      : accepted
        ? "certificate risk is below threshold; further discovery has lower value than one turn"
        : "no bounded candidate call has positive decision value",
  };
}

export function answerArtifactDiscoveryCall(
  result: TaskPackResult,
  query: string,
): ContinuationCall | undefined {
  const artifacts = result.surfaces
    .filter(isArtifactTaskPackSurface);
  if (artifacts.length === 0) return undefined;
  const evidenceText = [
    query,
    ...codeTaskPackSurfaces(result.surfaces).map((surface) =>
      surface.code ?? surface.code_unchanged ?? ""
    ),
  ].join("\n").toLowerCase();
  const ranked = artifacts.map((surface) => {
    const basename = path.basename(surface.path).toLowerCase();
    const stem = path.basename(surface.path, path.extname(surface.path)).toLowerCase();
    const tokens = stem.split(/[^a-z0-9]+/u).filter((token) => token.length >= 4);
    const basenameMentions = evidenceText.split(basename).length - 1;
    const stemMentions = evidenceText.split(stem).length - 1;
    const tokenMentions = tokens.reduce(
      (total, token) => total + Math.min(3, evidenceText.split(token).length - 1),
      0,
    );
    // A literal artifact citation is stronger evidence than an arbitrary
    // number of generic stem-token repetitions in a large source/doc slice.
    // Cap token frequency so long files cannot win merely by saying "claim"
    // many times while explicitly naming a different authority.
    return {
      surface,
      score: basenameMentions * 64 + stemMentions * 32 + tokenMentions,
    };
  }).sort((a, b) => b.score - a.score || a.surface.path.localeCompare(b.surface.path));
  const selected = ranked[0]?.surface;
  return selected
    ? { tool: "tl_read_file", arguments: { mode: "artifact", path: selected.path } }
    : undefined;
}

/**
 * EVERY WAY THIS RESPONSE ITSELF SAYS "A REQUIRED THING IS STILL OPEN".
 *
 * The one place the served-terminal grant (`buildTaskExecutionContract`'s
 * `servedTerminalCertificate`, P2-4) consults before certifying. Each entry is
 * a disclosure the response ALREADY publishes, restated in one vocabulary so
 * the certificate cannot be minted beside its own contradiction:
 *
 *   (a) `result.missing` rows from the durable epoch ledger and the two epoch
 *       reconciliations — `unresolved-ledger:` (this function's own ledger
 *       projection: a required-role/concern-token obligation with no proof),
 *       `unserved-required-role:` and `uncovered-concern:`
 *       (`reconcileEpochTaskContract`'s backstop disclosures) — plus
 *       `missing_required_surfaces[]`, the role axis's ordinary spelling.
 *       `explicit-gap:` rows are deliberately NOT here: a verified absence is
 *       a PROOF, not an open requirement, and `gapNamesRecovery` already owns
 *       the gap that still names something to fetch.
 *   (b) for an edit-shaped pack, `change_contract.missing[]` — i.e. exactly
 *       `change_contract.discovery_complete === false`, since
 *       `reconcileTaskChangeContract` derives one from the other. The
 *       advisory `route:<action>` marker is excluded: `buildTaskChangeContract`
 *       appends it only when the contract is OTHERWISE empty, to say "the
 *       route is not edit_from_handles" — a statement about guidance shape,
 *       not an unserved requirement, and every served-terminal pack has a
 *       non-edit route by construction (`readiness === "needs-followup"`), so
 *       counting it would retire the P2-4 grant wholesale rather than gate it.
 *   (c) an uncovered concern with a required obligation still unproved.
 *       `proofModelSettled` implies this today (every `TaskReadinessObligation`
 *       is `required: true`, so "all proved" already excludes it); it is kept
 *       as an independent conjunct so relaxing either one alone cannot reopen
 *       the false-complete door.
 *
 * Returns the reasons rather than a boolean so the caller can name what
 * blocked it; an empty array is "this response discloses nothing open".
 */
export function openEpochContractRequirements(
  result: TaskPackResult,
  obligations: readonly TaskReadinessObligation[],
  terminalAction: "answer" | "edit",
): string[] {
  const open: string[] = [];
  for (const entry of result.missing) {
    if (
      entry.startsWith("unresolved-ledger:")
      || entry.startsWith(UNSERVED_EPOCH_ROLE_PREFIX)
      || entry.startsWith(UNCOVERED_EPOCH_CONCERN_PREFIX)
      // BLOCKER 25 (2026-09-14, review round 4): a file the REQUEST ITSELF
      // named and this response could not read is the plainest possible
      // "a required thing is still open" — the served-terminal grant must not
      // certify beside it either (`deriveCanonicalTaskDecisionRaw` closes the
      // ORDINARY certificate route; this closes P2-4's).
      || entry.startsWith(UNREADABLE_NAMED_PATH_PREFIX)
    ) open.push(entry);
  }
  for (const role of result.missing_required_surfaces ?? []) {
    open.push(`${UNSERVED_EPOCH_ROLE_PREFIX}${role}`);
  }
  if (terminalAction === "edit") {
    for (const entry of result.change_contract?.missing ?? []) {
      if (!entry.startsWith("route:")) open.push(`change-contract:${entry}`);
    }
  }
  if (
    result.coverage_reason === "concerns-uncovered"
    && obligations.some((obligation) => obligation.status !== "proved")
  ) open.push("uncovered-concern:unproved-required-obligation");
  return [...new Set(open)];
}
