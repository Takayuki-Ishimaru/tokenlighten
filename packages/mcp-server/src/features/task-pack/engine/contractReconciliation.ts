// contractReconciliation — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ContinuationCall } from "./packBasics.js";
import type { ImpactSurface } from "@tokenlighten/types";
import type { PackCheckRecord } from "../../../state/session.js";
import type { TaskExecutionContract } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskReadinessCertificate } from "@tokenlighten/types";
import { MAX_CHECK_LINE_CHARS } from "./createAndWiringEndpoints2.js";
import { MAX_COMPLETION_CHECKS } from "./createAndWiringEndpoints2.js";
import { REQUEST_ITEM_OBLIGATION_PREFIX } from "./recursiveClosure5.js";
import { apiSurfaceDir } from "./createAndWiringEndpoints2.js";
import { buildWiringCooccurrenceCheck } from "./wiringEvidence.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { consultExecutedSearch } from "../../../util/packServeLog.js";
import { deriveCheckId } from "../../../state/session.js";
import { deriveNextFromPlan } from "./packBasics.js";
import { dominantRoot } from "../../../util/dominantRoot.js";
import { dynamicEnumConsumerVerdict } from "./contractReconciliation2.js";
import { enforceContinuationBudget } from "../../../util/continuation.js";
import { enumSubjectSymbols } from "./contractReconciliation2.js";
import { existingSiblingMembers } from "./contractReconciliation2.js";
import { extractEnumValueTokens } from "./createAndWiringEndpoints2.js";
import { handleTable } from "../../../util/handles.js";
import { hasExecutedNext } from "../../../util/packServeLog.js";
import { hasRenameRequestMarker } from "./coverageAndContinuation3.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { hasSufficientEditContent } from "./wiringEvidence2.js";
import { hasWiringIntentMarker } from "./coverageAndContinuation3.js";
import { isEnumLikeQuery } from "../../../util/queryShape.js";
import { isEnumLikeQueryShaped } from "./roleAndConcernScope2.js";
import { isPerSiteCheckSurface } from "./contractReconciliation2.js";
import { kebabCheckToken } from "./createAndWiringEndpoints2.js";
import { kebabTokenVariant } from "./createAndWiringEndpoints2.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { parseSurfaceSpan } from "./packState2.js";
import { primaryEnumContextRows } from "../auxiliaryEnumContextIntegration.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { readCached } from "./packBasics2.js";
import { roleInventoryFor } from "./roleAndConcernScope.js";
import { styleHasLiteralEnumSite } from "./contractReconciliation2.js";
import { unmatchedConcernTokens } from "./roleAndConcernScope3.js";
import { workspaceHasRole } from "./roleAndConcernScope.js";

/**
 * Keep proof payloads from competing with evidence surfaces during trim.
 *
 * Root cause (2026-08-21 smoke-gate T05c dead-end forensics): this allowlist
 * used to omit `workspace_state` — a small fixed-size marker (a handful of
 * numbers, two short strings, one sha256 hex string; nowhere near the
 * kilobyte-scale evidence bodies this function actually exists to shed). For
 * a pack that fits comfortably under its byte cap, that omission was masked:
 * a LATER, un-trimmed `buildTaskExecutionContract(...)` rebuild (the
 * "post-trim route recomputation" pass, further down this same pipeline)
 * overwrites `execution_contract` wholesale and restores it. But a pack that
 * is STILL over cap after that rebuild runs this function a second time (the
 * `!fitsInCap(trimmed)` compaction step) with nothing left to restore it
 * afterward. decisionWire.ts's projectCertificate requires workspace_state
 * (or a top-level result.workspace_state that production code never actually
 * populates) to construct the wire certificate — without it, an otherwise
 * fully-proved "prepared/ready/edit" contract silently degrades to
 * `await_input:"no-grounded-call-remains"` with zero candidates and zero
 * next, because a "prepared" phase contract carries no next_call to fall
 * back to either. Observed live: an 8-surface, fully-covered multi_concern
 * aeroctl fix pack (all three reported bugs located) discarded outright.
 */
export function contractForTrim(contract: TaskExecutionContract): TaskExecutionContract {
  const certificate = contract.readiness_certificate;
  return {
    version: contract.version,
    state: contract.state,
    readiness: contract.readiness,
    discovery_complete: contract.discovery_complete,
    next_action: contract.next_action,
    max_additional_discovery_calls: contract.max_additional_discovery_calls,
    reason: contract.reason,
    typestate: contract.typestate,
    ...(contract.workspace_state ? { workspace_state: contract.workspace_state } : {}),
    ...(certificate ? {
      readiness_certificate: {
        ...certificate,
        obligations: certificate.obligations.map((obligation) => ({
          id: obligation.id,
          kind: obligation.kind,
          status: obligation.status,
          required: true as const,
          evidence: [],
          ...(obligation.evidence_ids ? { evidence_ids: obligation.evidence_ids } : {}),
          reason: obligation.status === "proved"
            ? "proved by referenced evidence"
            : obligation.reason ?? obligation.status,
        })),
        ...(certificate.falsification !== undefined ? {
          falsification: {
            ...certificate.falsification,
            checked: certificate.falsification.checked.slice(0, 3),
            counterexamples: certificate.falsification.counterexamples.slice(0, 2),
            unresolved: certificate.falsification.unresolved.slice(0, 2),
          },
        } : {}),
      },
    } : {}),
    ...(contract.call_budget ? { call_budget: contract.call_budget } : {}),
    ...(contract.next_call ? { next_call: contract.next_call } : {}),
  };
}

/**
 * Last proof-only compaction before any source evidence is discarded.
 * The certificate id remains bound to the full proof and workspace state;
 * frontiers and evidence stay available on the task pack itself.
 *
 * 2026-08-21 (T05c byte-cap regression, follow-up to the workspace_state
 * fix above): this used to hand-roll a certificate that still carried a
 * truncated `falsification` report, a `risk` model minus `factors`, and a
 * per-obligation `evidence: []` + `reason: status` pair — bytes
 * `certificateBindingFor`'s own doc comment already named as wasted on
 * exactly this tier ("~256 bytes of proof on a receipt whose whole claim is
 * 'you already hold this'"), and the TaskReadinessObligation/
 * TaskReadinessCertificate fields those bytes fill (`evidence`, `reason`,
 * `falsification`, `risk`) are documented OPTIONAL for precisely this
 * binding-not-proof reason. No production reader consults them once a
 * certificate reaches this stage: decisionWire.ts's projectCertificate reads
 * only id/obligation-ids/workspace; leanExecutionContract.ts's `prepared`
 * projection reads only id/obligation-ids/allowed/frontier; contractForTrim
 * (above) has already zeroed every obligation's `evidence` and dropped the
 * contract-level `evidence_model` regardless. Delegating to
 * certificateBindingFor — written for the same "carries identity, not
 * prose" tier on the pack-unchanged re-serve path — removes that dead
 * weight instead of re-deriving it, so retaining `workspace_state` (the
 * fix above) no longer has to cost an otherwise-fitting multi_concern pack
 * a required-adjacent surface (observed: T05c's paired mixer.hpp) to the
 * optional-surface eviction ladder below.
 */
export function contractForEvidenceRetention(contract: TaskExecutionContract): TaskExecutionContract {
  const compact = contractForTrim(contract);
  const certificate = compact.readiness_certificate;
  if (!certificate) return compact;
  return {
    ...compact,
    // 2026-07-25 T13 forensics: evidence_handles/action_frontier are short
    // handle-id arrays (≤16 entries), not evidence bytes — stripping them
    // produced a state:"ready" contract whose certificate had frontier:[]
    // (the fence armed from it could only refuse). certificateBindingFor
    // keeps both through every retention trim.
    readiness_certificate: certificateBindingFor(certificate),
  };
}

/**
 * The certificate BINDING a `pack-unchanged` re-serve carries — not the proof.
 *
 * §2.1.1 (C2-3) put a certificate on the compact re-serve because the wire
 * `decision` needs one: `projectTaskDecision` degrades an `act` to
 * `await_input:"no-grounded-call-remains"` unless it can build a `CertificateRef`
 * (id + NON-EMPTY obligation ids + workspace marker), and A.4's `pack-unchanged`
 * gate rejects a body whose decision moved. What it did NOT need was the PROOF:
 * `contractForEvidenceRetention`'s output still carried the falsification report,
 * the selective-prediction risk model, and a per-obligation `evidence: []` +
 * `reason:"proved"` pair that only restated `status` — ~256 bytes of proof on a
 * receipt whose whole claim is "you already hold this".
 *
 * What a re-serve genuinely re-binds, and therefore all this keeps:
 *   - `id` + `task_fingerprint`  the fence's install key (`state/session.ts`'s
 *     `certificateId`/`taskFingerprint`) and `TaskRef.id` on the wire;
 *   - `obligations[].id` + `status`  `CertificateRef.obligations` (non-empty by
 *     type) and the fence's `obligationIds`;
 *   - `evidence_handles` + `action_frontier`  the fence's admissible set and
 *     `FrontierEntry[]`. The 2026-07-25 T13 forensics rule stands: stripping
 *     these two arms a fence that can only refuse.
 * The workspace marker rides `TaskExecutionContract.workspace_state` / the
 * pack's own top-level copy, which `projectCertificate` already reads.
 */
export function certificateBindingFor(
  certificate: TaskReadinessCertificate,
): TaskReadinessCertificate {
  return {
    version: certificate.version,
    id: certificate.id,
    task_fingerprint: certificate.task_fingerprint,
    // `workspace_state_fingerprint` is NOT re-bound here: it has no reader
    // anywhere in the tree (it is written at mint and never read back), and the
    // marker the wire actually uses — `CertificateRef.workspace` — is projected
    // from `TaskExecutionContract.workspace_state` or from the compact record's
    // own top-level `workspace_state`, both of which this response carries.
    profile: certificate.profile,
    obligations: certificate.obligations.map((obligation) => ({
      id: obligation.id,
      kind: obligation.kind,
      status: obligation.status,
      required: true as const,
    })),
    evidence_handles: certificate.evidence_handles,
    action_frontier: certificate.action_frontier,
  };
}

export function reconcileTaskChangeContract(result: TaskPackResult): void {
  const contract = result.change_contract;
  if (contract === undefined) return;
  const servedByHandle = new Map(codeTaskPackSurfaces(result.surfaces).map((surface) => [surface.handle, surface]));
  for (const obligation of contract.obligations) {
    let surface = servedByHandle.get(obligation.handle);
    if (surface === undefined) {
      const original = handleTable.get(obligation.handle), wanted = parseSurfaceSpan(obligation.range);
      const replacements = [...servedByHandle.values()].filter(candidate => {
        const entry = handleTable.get(candidate.handle), span = parseSurfaceSpan(candidate.range ?? "");
        return candidate.path === obligation.path && wanted !== undefined && span !== undefined
          && span.start <= wanted.start && span.end >= wanted.end && hasSufficientEditContent(candidate)
          && original !== undefined && entry !== undefined && entry.path === original.path
          && entry.workspaceRoot === original.workspaceRoot && entry.lane === original.lane;
      });
      // A whole-file fold may replace a narrow handle. Rebind only a unique
      // containing, actually served window in the same capability scope.
      if (replacements.length === 1) {
        surface = replacements[0]!;
        obligation.handle = surface.handle;
      }
    }
    obligation.status = surface !== undefined && hasSufficientEditContent(surface) ? "ready" : "needs-context";
  }
  const nonContextMissing = contract.missing.filter((item) => !item.startsWith("context:"));
  const contextMissing = contract.obligations
    .filter((item) => item.required && item.status === "needs-context")
    .map((item) => "context:" + item.id);
  contract.missing = [...new Set([...nonContextMissing, ...contextMissing])];
  contract.status = contract.missing.length === 0 ? "ready" : "needs-followup";
  contract.discovery_complete = contract.status === "ready";
  contract.max_additional_tl_calls = contract.status === "ready"
    ? 0
    : Math.max(1, contract.max_additional_tl_calls);
  if (contract.status === "needs-followup" && result.route?.action === "edit_from_handles") {
    result.route.reason = "read the contract's needs-context handles once, then batch the edits";
    result.route.max_additional_tl_calls = 1;
  }
}

/**
 * Keep the advisory route/profile summaries subordinate to the authoritative
 * execution contract. A provisional edit route can be rejected by the later
 * falsification/readiness pass; leaving coverage=complete, wiring=ready, and
 * change_contract=ready beside phase=discovery made agents trust the wrong
 * half of the response and is exactly the T13 false-complete shape.
 */
export function reconcileTaskPackExecutionContract(result: TaskPackResult): void {
  const contract = result.execution_contract;
  if (!contract || contract.state === "ready") return;

  const hasTerminalContradiction = result.route?.action === "edit_from_handles"
    || result.next?.tool === "tl_edit_file"
    || result.wiring?.status === "ready"
    || result.change_contract?.status === "ready";
  if (!hasTerminalContradiction) return;

  const unresolved = contract.falsification?.unresolved ?? [];
  if (result.wiring !== undefined || result.change_contract !== undefined) {
    // Role/surface coverage and action readiness are distinct for a generic
    // candidate pack. Only structured change/wiring profiles claim complete
    // edit closure and therefore need a coverage demotion when proof rejects.
    result.coverage = "partial";
    result.coverage_reason = "concerns-uncovered";
  }
  const preservedDiscoveryRoute = result.route !== undefined
    && result.route.action !== "edit_from_handles"
    && (result.route.max_additional_tl_calls ?? 0) > 0
    ? result.route
    : undefined;
  result.route = {
    action: "locate_missing_surfaces",
    reason: contract.reason,
    max_additional_tl_calls: contract.next_call ? 1 : 0,
  };

  if (contract.next_call) {
    const plan = enforceContinuationBudget({
      version: 1,
      stages: [{ execution: "sequential", calls: [contract.next_call] }],
    });
    if (plan) {
      result.continuation = plan;
      const next = deriveNextFromPlan(plan);
      if (next) result.next = next;
      else delete result.next;
    }
  } else if (preservedDiscoveryRoute !== undefined) {
    // Proof rejection demotes the pack's EDIT claim, not its sanctioned
    // discovery. A pre-existing bounded non-terminal route (e.g. the
    // unresolved-concern synthesis) stays legal — overwriting it with a
    // zero-call locate route strips every machine-executable action from the
    // response (observed live: T05c 2026-07-30 rep2, 16-escape desertion).
    result.route = preservedDiscoveryRoute;
    if (result.next?.tool === "tl_edit_file") delete result.next;
    if (result.continuation?.stages[0]?.calls[0]?.tool === "tl_edit_file") delete result.continuation;
  } else {
    // Strip only edit-flavored guidance — the contradiction being repaired is
    // the edit claim; a read/search-shaped next stays legal and keeps one
    // bounded call open.
    if (result.next === undefined || result.next.tool === "tl_edit_file") {
      delete result.next;
      delete result.continuation;
    } else {
      result.route.max_additional_tl_calls = 1;
    }
  }

  if (result.change_contract?.status === "ready") {
    result.change_contract.status = "needs-followup";
    result.change_contract.discovery_complete = false;
    result.change_contract.max_additional_tl_calls = contract.next_call ? 1 : 0;
    result.change_contract.missing = [
      ...new Set([
        ...result.change_contract.missing,
        ...unresolved.map((id) => `execution:${id}`),
      ]),
    ];
  }

  if (result.wiring?.status === "ready") {
    const missing = new Set(result.wiring.missing);
    if (unresolved.includes("wiring-source")) missing.add("source");
    if (unresolved.includes("wiring-consumer") || unresolved.includes("wiring-insertion")) {
      missing.add("destination");
    }
    result.wiring.status = "needs-followup";
    result.wiring.missing = [...missing];
    result.wiring.edit_frontier = [];
    for (const connection of result.wiring.connections) connection.status = "needs-followup";
  }
}

/**
 * I-6 fix (v0.13.1 forensics, DESIGN-v0.13-plan.md §6 2026-08-30 entry;
 * bench/workflows/experiments/2026-08-30-v0131-forensics/{REPORT.md,root/
 * i6_fallback_probe.mjs,root/i6-fallback-result.json}): whether ONE of
 * `enforceNoDeadEndContract`'s own last-resort candidates has already run.
 *
 * `hasExecutedNext` fingerprints the WHOLE call — tool, action, AND every
 * task/budget/scope field the real dispatch carried (packServeLog.ts's
 * `nextFingerprint`/`semanticTask`). A real tl_search_files dispatch almost
 * always carries SOME task envelope (`taskEpoch`/`taskProfile`/...), while
 * this guard's own bare `{action:"tree"}` candidate carries none — so their
 * fingerprints never match, and `hasExecutedNext` alone can never see that
 * the candidate already ran (measured: recording a real dispatch's args
 * `{cwd,lane,action:"tree",taskEpoch:"new",taskProfile:"answer"}` and then
 * checking the bare candidate against it returns `false` — the two
 * fingerprints differ only in the task field the candidate never carries).
 * Root's unit probe reproduced the resulting loop end-to-end: the identical
 * pathless-tree next came back after the SAME workspace/lane had already
 * executed it (`i6-fallback-result.json`: `repeated_identically:true`).
 *
 * `consultExecutedSearch`'s coarser `${action}::${query-or-path}` ledger is
 * immune to that task/epoch noise — the same two-ledger reasoning
 * `receiptContractWithoutConsumedSearch` below already documents for the
 * receipt path — so this checks it too, scoped to the one candidate shape
 * that is actually pathless: a bare `tl_search_files` tree. server.ts's
 * `recordExecutedSearch` call now keys a pathless tree under the workspace
 * root (`treePath ?? workspace`), matched here with the identical fallback,
 * so a bare-tree candidate consulted here and a bare-tree call recorded
 * there always agree on one key.
 */
export function noDeadEndCandidateAlreadyExecuted(
  ledger: { workspace: string; lane: string },
  candidate: ContinuationCall,
): boolean {
  const candidateArgs = (candidate.arguments ?? {}) as Record<string, unknown>;
  if (hasExecutedNext(ledger.workspace, ledger.lane, candidate.tool, candidateArgs)) return true;
  if (candidate.tool === "tl_search_files" && candidateArgs["action"] === "tree") {
    const treePath = typeof candidateArgs["path"] === "string" ? candidateArgs["path"] : undefined;
    return consultExecutedSearch(ledger.workspace, "tree", treePath ?? ledger.workspace) !== undefined;
  }
  return false;
}

/**
 * Final no-dead-end invariant (2026-07-30): a non-prepared pack must always
 * carry at least one machine-executable action — a bounded next/continuation,
 * a route with sanctioned calls, or a granted terminal action. A response
 * whose only allowed action is request-user-input is unactionable for an
 * autonomous caller, and the live consequence is native-tool desertion
 * (T05c rep2 2026-07-30: 16 native escapes immediately after exactly this
 * shape). Belt-and-suspenders behind the builder/reconciler fixes; counts
 * via checks[] whenever it has to rewrite so the rate is observable.
 */
export function enforceNoDeadEndContract(
  result: TaskPackResult,
  query: string,
  /**
   * A-F2: the executed-next ledger this pack is being built against. Without
   * it the guard is free to re-open a call whose result the session already
   * consumed — which is why it had to run BEFORE suppression, and why the
   * suppression that ran after it could leave a dead end nothing repaired.
   * Optional so the readiness specs' synthetic, workspace-free contracts keep
   * their pre-A-F2 call shape.
   */
  ledger?: { workspace: string; lane: string },
): void {
  const contract = result.execution_contract;
  if (contract === undefined || result.literal_source_absence !== undefined) return;
  const phase = contract.typestate.phase;
  if (phase === "prepared" || phase === "acting" || phase === "verifying" || phase === "done") return;
  if (result.route !== undefined && (result.route.reason === undefined || result.route.reason === "")) {
    result.route.reason = contract.reason;
  }
  const grantsTerminal = contract.typestate.allowed_actions.includes("edit")
    || contract.typestate.allowed_actions.includes("answer");
  const hasBoundedCall = contract.next_call !== undefined
    || result.next !== undefined
    || result.continuation !== undefined
    || (result.route?.max_additional_tl_calls ?? 0) > 0;
  // Tied concern candidates stay a user decision by design (multiConcern
  // spec): the ambiguity inventory IS the actionable content, and repository
  // evidence cannot break a tie — synthesizing a find would just expand it.
  if ((result.concern_ambiguities?.length ?? 0) > 0) return;
  if (grantsTerminal || hasBoundedCall) return;
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  // R-B1 (2026-09-21, review B2): an open REQUEST ITEM changes what "one
  // bounded evidence call" may be. Neither a `tl_search_files tree` nor a
  // `find` can discharge a request item, and neither response carries a
  // decision or a `next` — so a verbatim follower was stranded there, and
  // only an out-of-band `{qref}` re-pack recovered (confirmed live on this
  // repository and on a one-file fixture whose concern sat in the unserved
  // remainder of the named file). For a request-item gap the candidates are,
  // in order: (1) the point's own batched read (`request_item_gap`: the
  // window where its wording occurs in a candidate's unserved part, or the
  // unserved candidate itself), (2) a query-bearing read of the unserved
  // remainder of a partly served surface when no position is known. Both
  // carry the query, so the response re-enters the pack and answers with a
  // decision. Never a bare tree. With nothing unexecuted left the contract
  // stays awaiting-input, whose `unresolved` names the open concern — an
  // honest terminal state, never a dead end.
  const openRequestItem = (contract.falsification?.unresolved ?? []).some((id) => id.startsWith(REQUEST_ITEM_OBLIGATION_PREFIX));
  let candidates: ContinuationCall[];
  if (openRequestItem) {
    const gapCall = result.request_item_gap?.next_call as ContinuationCall | undefined;
    const remainderReads: ContinuationCall[] = [];
    for (const surface of surfaces) {
      const remaining = surface.remaining_ranges?.[0];
      if (!hasServedCode(surface) || remaining === undefined) continue;
      remainderReads.push({ tool: "tl_read_file", arguments: { query, targets: [{ path: surface.path, range: remaining }], content: "auto" } });
      break;
    }
    candidates = [...(gapCall !== undefined ? [gapCall] : []), ...remainderReads];
  } else {
    const codeless = surfaces.find((surface) => !hasServedCode(surface));
    const unmatched = unmatchedConcernTokens(query, surfaces)[0];
    candidates = [
      ...(codeless !== undefined ? [{ tool: "tl_read_file", arguments: { handle: codeless.handle } } as ContinuationCall] : []),
      ...(unmatched !== undefined ? [{ tool: "tl_search_files", arguments: { action: "find", query: unmatched } } as ContinuationCall] : []),
      { tool: "tl_search_files", arguments: { action: "tree" } },
    ];
  }
  // A-F2: re-opening a call whose result is already consumed is the same
  // non-progress this guard exists to prevent, one indirection removed. With a
  // ledger in hand the guard picks the first UNEXECUTED candidate; with every
  // candidate consumed it leaves the contract alone rather than manufacturing
  // a loop, and the disclosure written by repairSuppressedNextCall stands.
  // I-6 fix: "unexecuted" is decided by noDeadEndCandidateAlreadyExecuted
  // (hasExecutedNext PLUS a pathless-tree-aware consultExecutedSearch check —
  // see that function's own doc comment), not by hasExecutedNext alone.
  const call = ledger === undefined
    ? candidates[0]!
    : candidates.find((candidate) => !noDeadEndCandidateAlreadyExecuted(ledger, candidate));
  if (call === undefined) return;
  const plan = enforceContinuationBudget({
    version: 1,
    stages: [{ execution: "sequential", calls: [call] }],
  });
  if (plan) {
    result.continuation = plan;
    const next = deriveNextFromPlan(plan);
    if (next !== undefined) result.next = next;
  }
  result.route = {
    action: "locate_missing_surfaces",
    reason: "no-dead-end guard: re-opened one bounded evidence call after the contract stripped every machine-executable action",
    max_additional_tl_calls: 1,
  };
  contract.next_call = call;
  contract.max_additional_discovery_calls = 1;
  contract.next_action = "followup";
  if (contract.typestate.phase === "awaiting-input") {
    contract.typestate = { phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: [] };
  }
  if (contract.semantic_closure !== undefined && contract.semantic_closure.state === "awaiting-input") {
    contract.semantic_closure.state = "open";
  }
  if (contract.call_budget !== undefined) {
    contract.call_budget = {
      ...contract.call_budget,
      discovery_allowed: true,
      reason: `${contract.call_budget.reason}; no-dead-end guard re-opened one bounded call`,
    };
  }
  result.checks = [...(result.checks ?? []), "no-dead-end-guard: rewrote a dead-end contract (telemetry)"];
}

/** Cap on the number of per-site sibling checks emitted (item 2). */
export const MAX_PER_SITE_CHECKS = 8;

/**
 * DESIGN-v0.8 coverage-honesty (Part 5): structured, closure-trackable check
 * records. A record with a `token`+`glob` is machine-verifiable by edit_code
 * closure tracking (satisfied when `token` appears in a file matching `glob`);
 * a record with `desc` only is advisory. Emitted per role that STRUCTURALLY
 * exists in the located surfaces' dominant root (never a phantom role).
 *
 * Ids are CONTENT-derived (deriveCheckId: role + glob + token set; role +
 * desc for advisory records) so the same logical check keeps ONE id across
 * repeat same-task packs and different checks never collide. The positional
 * `chk-<n>` scheme this replaces was NOT stable across packs: emission order
 * shifts with surface inventory, so an epoch merge could overwrite an OPEN
 * check with an unrelated same-index one (closure then verified the wrong
 * token) or accumulate duplicates of a re-emitted check under new indexes.
 */
export function buildCheckRecords(
  query: string,
  surfaces: TaskPackSurface[],
  workspace: string,
): PackCheckRecord[] {
  surfaces = primaryEnumContextRows(surfaces);
  const records: PackCheckRecord[] = [];
  const push = (r: Omit<PackCheckRecord, "id">): void => {
    const id = deriveCheckId(r);
    // Identical identity = the same logical check; keep the first emission
    // (required-surface per-site checks are pushed before optional ones).
    if (records.some((x) => x.id === id)) return;
    records.push({ id, ...r });
  };

  // Item 5: camelCase-robust enum gate so a camelCase-only query still emits
  // the machine-verifiable style/api check records (and, below, the per-site
  // sibling checks from item 2).
  if (isEnumLikeQueryShaped(query)) {
    // Roles that structurally exist in the located surfaces' own dominant
    // root — never emit a style record for a root that has no stylesheets.
    const root = surfaces.length > 0
      ? dominantRoot(surfaces.map((s) => s.path), (p) => projectRootOf(p))
      : null;
    const inventory = roleInventoryFor(workspace, root);
    const tokens = extractEnumValueTokens(query);
    const tokenLabel = tokens[0] ?? "the new value";

    // contract/api: advisory (desc only) — no literal token to grep, the edit
    // is structural (add to the family/initializers).
    if (inventory.has("contract")) {
      push({ desc: `contract: add ${tokenLabel} to the family definition and exhaustive initializers`, role: "contract" });
    }
    if (inventory.has("api")) {
      push({ desc: `api: handle ${tokenLabel} in validation, transitions, and aggregation enumerations`, role: "api" });
    }

    // style: machine-verifiable — the `--<kebab>` custom property must exist
    // in a stylesheet. Only when the root actually HAS a style role.
    if (inventory.has("style") && tokens.length > 0) {
      const kebab = kebabTokenVariant(tokens[0]!);
      const matcher = kebabCheckToken(tokens[0]!);
      if (kebab && matcher) {
        push({
          desc: `style: token ${kebab} (or a namespaced --*${matcher}) present in stylesheets`,
          token: matcher,
          glob: "*.css",
          role: "style",
        });
      }
    }

    // Item 2 (per-site sibling checks): each enumeration SITE (initializer /
    // aggregation map / style / contract surface) gets its OWN single-token
    // check scoped to that exact file's rel path, so closure can tell the agent
    // WHICH site still lacks the new member (the enum-extension forensic: stats
    // map, board columns, badge config across ~8 files had no per-file check, so
    // closure could not say which remained). The token is the NOVEL member (a
    // value being ADDED, not already a sibling); for a style site the token is
    // its CSS custom-property form (--kebab) since the raw ALL-CAPS constant
    // does not appear verbatim in a stylesheet. Capped at MAX_PER_SITE_CHECKS,
    // required surfaces first.
    const existing = existingSiblingMembers(surfaces, workspace);
    const novelMembers = tokens.filter((t) => !existing.has(normIdent(t)));
    if (novelMembers.length > 0) {
      const siteSurfaces = surfaces
        .filter(isPerSiteCheckSurface)
        .filter(s => s.role !== "style" || styleHasLiteralEnumSite(s, query, existing, workspace))
        .sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1)); // required first
      // IMPROVEMENT C: memoize the dynamic-consumer verdict per site file so a
      // file that consumes the enum ONLY via dynamic derivation gets an
      // informational entry instead of a false "member present" gate (which
      // sent agents into npm-test rabbit holes). `existing` (the contract's
      // sibling members) is the static-enumeration evidence source.
      const subjectSymbols = enumSubjectSymbols(query, surfaces);
      const verdictCache = new Map<string, { suppress: boolean; symbol?: string }>();
      const verdictFor = (s: TaskPackSurface): { suppress: boolean; symbol?: string } => {
        let v = verdictCache.get(s.path);
        if (v === undefined) {
          const body = readCached(workspace, s.path);
          v = body === undefined
            ? { suppress: false } // body unavailable -> keep the check (conservative)
            : dynamicEnumConsumerVerdict(body, subjectSymbols, existing);
          verdictCache.set(s.path, v);
        }
        return v;
      };
      let perSiteEmitted = 0;
      const informedPaths = new Set<string>();
      for (const member of novelMembers) {
        const kebab = kebabCheckToken(member);
        for (const s of siteSurfaces) {
          if (perSiteEmitted >= MAX_PER_SITE_CHECKS) break;
          // IMPROVEMENT C: dynamic consumer (Object.values(E)/nativeEnum(E)/
          // Record<E,...>/keyof typeof E) with no static enumeration evidence —
          // no literal edit is required here. Emit one informational (advisory,
          // token-less, never reported open) entry per such file and skip the
          // literal obligation for every novel member.
          const verdict = verdictFor(s);
          if (verdict.suppress) {
            if (!informedPaths.has(s.path)) {
              informedPaths.add(s.path);
              push({
                desc: `${path.basename(s.path)}: derives from ${verdict.symbol} dynamically — no literal edit required`,
                role: s.role,
              });
              perSiteEmitted++;
            }
            continue;
          }
          // A stylesheet stores the member as its CSS custom-property form,
          // not the raw ALL-CAPS constant — match the single-dash suffix form
          // there (see kebabCheckToken: namespaced --color-priority-<kebab>
          // must satisfy too).
          const token = s.role === "style" ? kebab : member;
          if (token === undefined) continue;
          push({
            token,
            glob: s.path,
            role: s.role,
            desc: `${s.role}: ${member} present in ${path.basename(s.path)}`,
          });
          perSiteEmitted++;
        }
        if (perSiteEmitted >= MAX_PER_SITE_CHECKS) break;
      }
    }

    // search/filter/lookup/autocomplete: the value's user-visible text must
    // match. Scope the glob to the api surface's directory when identifiable;
    // otherwise leave advisory (desc only, no token — an unscoped literal
    // search over the whole repo is too loose to be a useful closure check).
    if (/\b(search|filter|lookup|autocomplete)\b/i.test(query) && tokens.length > 0) {
      const dir = apiSurfaceDir(surfaces);
      if (dir) {
        push({
          desc: `search/filter: user-visible text for ${tokens[0]} must match`,
          token: tokens[0]!.toLowerCase(),
          glob: dir,
          role: "api",
        });
      } else {
        push({ desc: `search/filter: user-visible text for ${tokens[0]} must match`, role: "api" });
      }
    }
  }

  // rename/bug/spec queries: today's advisory single line, as a record with no
  // token (advisory-only — closure tracking never reports it open).
  if (hasRenameRequestMarker(query)) {
    push({ desc: "rename: update imports, exports, tests, docs, and string/config references that intentionally name the symbol" });
  }

  // Closure-hardening: a cross-surface WIRING check (source→destination
  // co-occurrence) when the query connects two distinct-role surfaces. Emitted
  // for any query shape (not just enum-like) since wiring is orthogonal to the
  // enum/rename shapes above. A plain enum/value propagation is deliberately
  // excluded: filename-grounded words such as "enum" are not runtime signals,
  // and turning them into a co-occurrence check creates a permanently-open
  // false obligation. An explicit wiring verb still opts an enum task in.
  if (!isEnumLikeQuery(query) || hasWiringIntentMarker(query)) {
    const wiring = buildWiringCooccurrenceCheck(query, surfaces, workspace);
    if (wiring) push(wiring);
  }

  return records;
}

/**
 * Build the pack's public `checks` string[] AND the structured records the
 * session's closure tracker consumes. The public field stays string[] (Part 5:
 * "the pack's public `checks` field STAYS string[]"); `records` is recorded
 * separately via recordPackChecks in dedupeTrimAndPersist. Lines are derived
 * from the same shape as before, capped at MAX_COMPLETION_CHECKS and
 * MAX_CHECK_LINE_CHARS.
 *
 * FIX-A (2026-07-09d forensics): `unmatchedConcern` — the SAME gated token
 * list route.reason already names ("concern(s) not covered: telemetry,
 * sensor") — takes priority over the generic enum contract/api/ui template
 * below when non-empty: the template was "the same generic 3-line ...
 * template on every pack regardless of task", while naming the actual
 * uncovered concern(s) is directly actionable. Callers with no meaningful
 * concept of an unmatched concern for this pack (the no-candidate abstain,
 * the seeded paths[] flow — see their own call sites' comments) omit it,
 * which keeps their existing (unconditional enum-template) behavior.
 */
export function buildCompletionChecks(
  query: string,
  surfaces: TaskPackSurface[],
  missing: string[],
  workspace: string,
  unmatchedConcern: string[] = [],
): { lines: string[]; records: PackCheckRecord[] } {
  const present = new Set(surfaces.map((s) => s.role));
  const checks: string[] = [];

  if (unmatchedConcern.length > 0) {
    // Name the specific gap instead of the boilerplate template — matches
    // route.reason's own "concern(s) not covered: ..." phrasing so the two
    // fields never disagree about what is actually missing.
    checks.push(`concern(s) not covered: ${unmatchedConcern.join(",")} — locate/confirm before declaring done`);
  } else if (isEnumLikeQueryShaped(query)) {
    // Item 5: camelCase-robust enum gate (matches the record-derivation gate).
    checks.push("contract: update exported enum/schema/type definitions and any Record/switch initializers");
    checks.push("api/domain: update validation, transition, repository/search, and aggregation paths that enumerate the value");
    if (surfaces.some((s) => s.role === "ui" || s.role === "style")) {
      checks.push("ui/style: update badges/forms/filters plus design tokens or class names for the new value");
    }
  }

  if (hasRenameRequestMarker(query)) {
    checks.push("rename: update imports, exports, tests, docs, and string/config references that intentionally name the symbol");
  }

  // A "<role>: not covered" hint is only actionable when that role actually
  // EXISTS somewhere in this workspace but this pack didn't reach it. In a
  // repo with no presentation layer at all (e.g. C++ firmware), emitting
  // "ui: not covered" / "style: not covered" is phantom guidance that sends
  // the agent to locate a surface that cannot exist — mirror the
  // workspaceHasRole() guard that requiredSurfacesForTask already applies.
  for (const role of ["contract", "api", "domain", "ui", "style", "test"]) {
    if (checks.length >= MAX_COMPLETION_CHECKS) break;
    const eligible =
      missing.includes(role) ||
      (!present.has(role) && checks.length > 0 && ["contract", "api", "ui", "style"].includes(role));
    if (eligible && workspaceHasRole(workspace, role as ImpactSurface)) {
      checks.push(`${role}: not covered by this pack; run targeted locate/search before declaring done`);
    }
  }

  const lines = [...new Set(checks)]
    .slice(0, MAX_COMPLETION_CHECKS)
    .map((l) => (l.length > MAX_CHECK_LINE_CHARS ? l.slice(0, MAX_CHECK_LINE_CHARS) : l));
  return { lines, records: buildCheckRecords(query, surfaces, workspace) };
}
