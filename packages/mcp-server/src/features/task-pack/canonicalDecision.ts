import type { TaskExecutionContract, ToolCall } from "@tokenlighten/types";
import {
  deriveNextFromPlan,
  enforceContinuationBudget,
  type ContinuationCall,
  type ContinuationPlan,
} from "../../util/continuation.js";
import type { TaskPackResult } from "./model.js";
import { codeTaskPackSurfaces } from "./artifactSections.js";

const DISCOVERY_BUNDLE_PATH_CAP = 8;

/** Returns a bounded re-pack using only paths already related by this pack. */
export function discoveryBundleNext(result: TaskPackResult): ToolCall | undefined {
  if (result.coverage === "complete" || typeof result.qref !== "string" || result.qref === "") return undefined;
  const paths: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !paths.includes(value) && paths.length < DISCOVERY_BUNDLE_PATH_CAP) paths.push(value);
  };
  if (result.coverage_reason === "candidate-list") {
    for (const surface of result.surfaces) add((surface as { path?: unknown }).path);
  } else {
    const graph = result.wiring?.evidence_graph;
    if (graph === undefined || graph.relations.length === 0) return undefined;
    const relatedIds = new Set(graph.relations.flatMap((relation) => [relation.from, relation.to]));
    for (const node of graph.nodes) if (relatedIds.has(node.id)) add(node.path);
  }
  return paths.length < 2 ? undefined : { tool: "read_file", arguments: { mode: "task_pack", qref: result.qref, paths } };
}

export function discoveryBundleAdvisory(result: TaskPackResult): string | undefined {
  return discoveryBundleNext(result) === undefined ? undefined : "advisory: bundled paths are limited to files already related by served candidates or evidence edges";
}

/**
 * The single control-plane verdict projected onto task-pack wire fields.
 *
 * `route` is intentionally not an input to a terminal promotion: routes are
 * guidance and can be stale after trimming, qref replay, or receipt shaping.
 * A terminal decision therefore requires the contract's certificate instead.
 */
export type CanonicalTaskDecisionKind =
  | "discover"
  | "await-input"
  | "act-answer"
  | "act-edit"
  | "terminal-closed";

export interface CanonicalTaskDecision {
  kind: CanonicalTaskDecisionKind;
  next_call?: ContinuationCall;
  reason: string;
}

function isReadOnlyCall(value: unknown): value is ContinuationCall {
  if (value === null || typeof value !== "object") return false;
  const call = value as Partial<ContinuationCall>;
  return (call.tool === "read_file" || call.tool === "search_files")
    && call.arguments !== null
    && typeof call.arguments === "object";
}

function firstReadOnlyContinuation(result: TaskPackResult): ContinuationCall | undefined {
  const call = result.continuation?.stages[0]?.calls[0];
  return isReadOnlyCall(call) ? call : undefined;
}

/** Prefer a served document's disclosed next range over a lexical re-search. */
function servedDocumentZoom(result: TaskPackResult): ContinuationCall | undefined {
  const candidates = result.surfaces
    .map((surface) => ({
      surface,
      range: (surface as { remaining_ranges?: unknown }).remaining_ranges,
    }))
    .filter((item): item is { surface: TaskPackResult["surfaces"][number]; range: unknown[] } =>
      Array.isArray(item.range)
      && typeof item.range[0] === "string"
      && typeof (item.surface as { handle?: unknown }).handle === "string",
    )
    .sort((a, b) => {
      const aDoc = /\.(?:md|markdown|mdx)$/iu.test((a.surface as { path?: string }).path ?? "") ? 0 : 1;
      const bDoc = /\.(?:md|markdown|mdx)$/iu.test((b.surface as { path?: string }).path ?? "") ? 0 : 1;
      return aDoc - bDoc;
    });
  const selected = candidates[0];
  if (selected === undefined) return undefined;
  return {
    tool: "read_file",
    arguments: {
      handle: (selected.surface as { handle: string }).handle,
      range: selected.range[0] as string,
    },
  };
}

/**
 * P0a §6.1: a prepared decision is bound to a certificate either by carrying
 * the full proof or by naming its id in the typestate. The compact
 * `pack_unchanged` receipt is the second form — it re-serves a decision whose
 * certificate was already issued and whose working set is proved unchanged by
 * `workspace_state`, and paying the full certificate's bytes again on a
 * sub-1KB receipt would defeat the receipt. Both forms project the SAME lean
 * `certificate` field on the wire (see projectLeanExecutionContract).
 */
export function hasCertificateBinding(contract: TaskExecutionContract): boolean {
  return contract.readiness_certificate !== undefined
    || contract.typestate.certificate_id !== undefined;
}

function certificateIdOf(contract: TaskExecutionContract): string | undefined {
  return contract.readiness_certificate?.id ?? contract.typestate.certificate_id;
}

function hasCertificateForTerminal(contract: TaskExecutionContract): boolean {
  return contract.state === "ready"
    && contract.discovery_complete
    && hasCertificateBinding(contract)
    && (contract.next_action === "answer" || contract.next_action === "edit");
}

/**
 * A ready answer may name extra code affordances, but only an explicit
 * answer-route Markdown remainder is mandatory answer evidence. Keep this
 * narrower than servedDocumentZoom(): generic partial-code affordances remain
 * compatible with their established prepared contracts.
 */
function requiredAnswerDocumentZoom(result: TaskPackResult): ContinuationCall | undefined {
  if (
    result.route?.action !== "answer_from_handles"
    || (result.route.max_additional_tl_calls ?? 0) <= 0
  ) return undefined;
  const surface = result.surfaces.find((candidate) => {
    const value = candidate as { path?: unknown; handle?: unknown; remaining_ranges?: unknown };
    return typeof value.path === "string"
      && /\.(?:md|markdown|mdx)$/iu.test(value.path)
      && typeof value.handle === "string"
      && Array.isArray(value.remaining_ranges)
      && typeof value.remaining_ranges[0] === "string";
  }) as { handle: string; remaining_ranges: string[] } | undefined;
  if (surface === undefined) return undefined;
  return {
    tool: "read_file",
    arguments: { handle: surface.handle, range: surface.remaining_ranges[0]! },
  };
}

/**
 * §3.4.1 / D1 (2026-08-07): the ONE sanctioned served-zoom affordance shape —
 * an answer route that has granted EXACTLY one zoom call over a required
 * surface THIS SAME response left partial. AGENTS.md states the intended
 * joint shape directly: "prepared+partial primary grants
 * `route.max_additional_tl_calls=1` — spend it on the served zoom", so this
 * IS an affordance, not missing evidence, and `prepared`/`act.answer` must
 * survive it. Shared by every site that could otherwise disagree about
 * whether this shape holds: readCodeTaskPack.ts's reconcileContentSufficiency
 * (must not downgrade the route just because the profile is answer) and its
 * buildTaskExecutionContract (must let the shape reach an accepted,
 * certificate-bearing contract), and this module's own
 * deriveCanonicalTaskDecision below (must not re-force `discover` on the
 * shape the certified gate just accepted).
 */
export function hasServedZoomAffordance(result: TaskPackResult): boolean {
  if (result.route?.action !== "answer_from_handles") return false;
  if ((result.route.max_additional_tl_calls ?? 0) !== 1) return false;
  return codeTaskPackSurfaces(result.surfaces).some((surface) =>
    surface.required !== false
    && (surface.content_completeness === "partial" || (surface.remaining_ranges?.length ?? 0) > 0));
}

/**
 * W9 (2026-08-22): is this pack's task read-only?
 *
 * Both spellings, for the same reason `projectTaskRef` reads both: a DECLARED
 * `taskProfile:"answer"` lands on `task_profile`, while §14's inference lands
 * on `profile_binding.selected`. Either way the value is the profile the pack
 * was actually BUILT with — the obligations, the route relabel and the
 * terminal action all derive from it — so it is the same authority the rest of
 * the pipeline uses, not a second guess at the caller's intent.
 */
function isReadOnlyAnswerPack(result: TaskPackResult): boolean {
  return result.task_profile === "answer" || result.profile_binding?.selected === "answer";
}

/**
 * Derive one decision from contract evidence. In particular, an
 * `answer_from_handles` route can never promote a pack by itself.
 */
export function deriveCanonicalTaskDecision(result: TaskPackResult): CanonicalTaskDecision | undefined {
  const contract = result.execution_contract;
  if (contract === undefined) return undefined;

  if (contract.typestate.phase === "done" && contract.semantic_closure?.state === "closed") {
    return { kind: "terminal-closed", reason: "semantic closure receipt is closed" };
  }

  // A stale ready certificate must not hide the one remaining document range
  // that the answer route explicitly says is needed. This is intentionally
  // before certificate promotion, and intentionally Markdown-only.
  const requiredZoom = requiredAnswerDocumentZoom(result);
  if (requiredZoom !== undefined) {
    return {
      kind: "discover",
      next_call: requiredZoom,
      reason: "answer evidence is partial; zoom the served document before answering",
    };
  }

  if (hasCertificateForTerminal(contract)) {
    return {
      kind: contract.next_action === "answer" ? "act-answer" : "act-edit",
      reason: "readiness certificate authorizes the terminal action",
    };
  }

  // -------------------------------------------------------------------------
  // W9 (2026-08-22) — A READ-ONLY CANDIDATE LIST IS NOT A DEAD END.
  //
  // `choose-candidate` exists for EDIT SAFETY. With several plausible targets
  // and no dominant one, choosing FOR the caller risks editing the wrong file,
  // so readCodeTaskPack.ts deliberately suppresses every bounded fallback and
  // lands `awaiting-input` (the 2026-07-19a thrash fix; readinessSemantics.ts
  // pins it for the generic profile). That risk does not exist on a READ-ONLY
  // task: "which of these is it" is answered by reading all of them, and
  // `discoveryBundleNext` is exactly that call — one bounded re-pack over the
  // candidates THIS pack already served and ranked.
  //
  // Measured on the a4 m365-drive-mount repro (2026-08-22): the awaiting-input
  // arm made the caller invent the same re-pack by hand, without the `qref`,
  // with the paths copied out of the candidate list — a turn the server could
  // have named and did not.
  //
  // NARROW BY CONSTRUCTION. All four must hold, and each is load-bearing:
  //   1. `await_input_code === "choose-candidate"` — the CONTRACT's own marker
  //      of which branch decided (A.7.2 row 21), never re-derived from route or
  //      prose. `no-grounded-call-remains`, `name-intended-target` (tied
  //      concerns, which repository evidence provably cannot break) and
  //      `act-on-served-evidence` are all untouched.
  //   2. the pack's selected profile is `answer`. Edit/generic keep the fence
  //      exactly as it is — this is the edit-safety half, and it does not move.
  //   3. `discoveryBundleNext` can name a bundle at all: a live `qref` and >= 2
  //      candidate paths. It NEVER invents a path (the advisory it ships says
  //      so), so this cannot widen the frontier beyond what was served.
  //   4. phase is really awaiting-input, i.e. nothing above already promoted
  //      the pack to a certified terminal action.
  //
  // Deliberately AFTER the certificate gate and the required-document zoom, so
  // a pack that has earned `act.*` still gets it, and a partial answer document
  // is still zoomed first.
  // -------------------------------------------------------------------------
  if (
    contract.typestate.phase === "awaiting-input"
    && contract.await_input_code === "choose-candidate"
    && isReadOnlyAnswerPack(result)
  ) {
    const bundle = discoveryBundleNext(result);
    if (bundle !== undefined) {
      return {
        kind: "discover",
        next_call: bundle,
        reason: "read-only candidate list: re-pack every served candidate in one bounded call instead of asking which to read",
      };
    }
  }

  // An awaiting-input decision is authoritative over any stale continuation
  // that a receipt or post-trim branch left behind.
  if (
    contract.typestate.phase === "awaiting-input"
    || contract.semantic_closure?.state === "awaiting-input"
  ) {
    return { kind: "await-input", reason: contract.reason };
  }

  const routeClaimsAnswer = result.route?.action === "answer_from_handles";
  const zoom = servedDocumentZoom(result);
  // The certified gate above is where the sanctioned served-zoom affordance
  // (hasServedZoomAffordance) is meant to land `act-answer` — with a real
  // certificate. Reaching here means it did not (no certificate, or the
  // affordance genuinely does not hold), so only force `discover` when the
  // affordance is NOT what is blocking it; otherwise fall through to the
  // shape below, which can still name the same zoom call without mislabeling
  // a starved OTHER surface as "the document is partial".
  if (routeClaimsAnswer && zoom !== undefined && !hasServedZoomAffordance(result)) {
    return {
      kind: "discover",
      next_call: zoom,
      reason: "answer evidence is partial; zoom the served document before answering",
    };
  }

  const next = discoveryBundleNext(result)
    ?? (isReadOnlyCall(contract.next_call)
    ? contract.next_call
    : firstReadOnlyContinuation(result));
  if (next !== undefined) {
    return { kind: "discover", next_call: next, reason: contract.reason };
  }

  // Missing proof without a bounded evidence call must never fall through to
  // answer/edit. Asking for a decision is the conservative, fail-closed exit.
  return { kind: "await-input", reason: contract.reason };
}

function planFor(call: ContinuationCall): ContinuationPlan | undefined {
  return enforceContinuationBudget({
    version: 1,
    stages: [{ execution: "sequential", calls: [call] }],
  });
}

function clearDiscoveryProjection(result: TaskPackResult, contract: TaskExecutionContract): void {
  delete contract.next_call;
  contract.max_additional_discovery_calls = 0;
  if (contract.call_budget !== undefined) {
    contract.call_budget = {
      ...contract.call_budget,
      discovery_allowed: false,
      candidate_call: undefined,
    };
  }
  delete result.continuation;
  if (result.next?.startsWith("read_file ") === true || result.next?.startsWith("search_files ") === true) {
    delete result.next;
  }
}

function applyDiscoverDecision(
  result: TaskPackResult,
  contract: TaskExecutionContract,
  decision: CanonicalTaskDecision,
): void {
  const call = decision.next_call;
  if (call === undefined) return;
  const plan = planFor(call);
  if (plan === undefined) return;
  result.continuation = plan;
  const next = deriveNextFromPlan(plan);
  if (next !== undefined) result.next = next;
  contract.state = "needs-followup";
  contract.readiness = "needs-followup";
  contract.discovery_complete = false;
  contract.next_action = "followup";
  contract.max_additional_discovery_calls = 1;
  delete contract.readiness_certificate;
  // W9: `await_input_code` marks WHICH awaiting-input branch decided, so it is
  // meaningless once the decision is `discover` — and actively misleading,
  // since `projectTaskDecision` reads it on the await arm. A contract that has
  // just been re-projected onto discovery must not keep claiming a pending
  // human choice.
  delete contract.await_input_code;
  contract.typestate = {
    phase: "discovery",
    allowed_actions: ["read", "search"],
    challenge_required_for: [],
  };
  contract.next_call = call;
  if (contract.call_budget !== undefined) {
    contract.call_budget = {
      ...contract.call_budget,
      discovery_allowed: true,
      candidate_call: call,
    };
  }
  if (contract.semantic_closure !== undefined) {
    contract.semantic_closure = {
      ...contract.semantic_closure,
      state: "open",
    };
  }
  result.route = {
    action: call.tool === "read_file" ? "inspect_handles" : "locate_missing_surfaces",
    reason: decision.reason,
    max_additional_tl_calls: 1,
  };
}

function applyAwaitInputDecision(result: TaskPackResult, contract: TaskExecutionContract, decision: CanonicalTaskDecision): void {
  clearDiscoveryProjection(result, contract);
  contract.state = "needs-followup";
  contract.discovery_complete = false;
  contract.next_action = contract.next_action === "answer" || contract.next_action === "edit"
    ? contract.next_action
    : "request-user-input";
  const retainedActions = contract.typestate.allowed_actions.filter(
    (action) => action === "answer" || action === "edit",
  );
  // A contract that still NAMES a terminal next_action but forbids it in
  // allowed_actions is itself a §6.1 contradiction — and it is the exact
  // shape the 2026-07-25 T13 forensics called a dead end ("request user
  // input" with no way to act on evidence the caller already holds). Keep
  // the named terminal action reachable.
  const terminalNextAction = contract.next_action === "answer" || contract.next_action === "edit"
    ? [contract.next_action]
    : [];
  contract.typestate = {
    phase: "awaiting-input",
    allowed_actions: [...new Set<TaskExecutionContract["typestate"]["allowed_actions"][number]>([
      ...retainedActions,
      ...terminalNextAction,
      "request-user-input",
    ])],
    challenge_required_for: [],
  };
  if (contract.semantic_closure !== undefined) {
    contract.semantic_closure = {
      ...contract.semantic_closure,
      state: "awaiting-input",
    };
  }
  result.route = {
    action: "confirm_candidates",
    reason: decision.reason,
    max_additional_tl_calls: 0,
  };
}

function applyTerminalDecision(
  result: TaskPackResult,
  contract: TaskExecutionContract,
  decision: CanonicalTaskDecision,
): void {
  const terminalAction = decision.kind === "act-answer" ? "answer" : "edit";
  clearDiscoveryProjection(result, contract);
  contract.state = "ready";
  contract.readiness = terminalAction === "answer" ? "answer-ready" : "edit-ready";
  contract.discovery_complete = true;
  contract.next_action = terminalAction;
  const retainedActions = contract.typestate.allowed_actions.filter(
    (action) => action === "answer" || action === "edit" || action === "challenge",
  );
  const certificateId = certificateIdOf(contract);
  contract.typestate = {
    phase: "prepared",
    ...(certificateId !== undefined ? { certificate_id: certificateId } : {}),
    allowed_actions: [...new Set<TaskExecutionContract["typestate"]["allowed_actions"][number]>([
      ...retainedActions,
      terminalAction,
      "challenge",
    ])],
    challenge_required_for: ["read", "search"],
  };
  if (contract.semantic_closure !== undefined) {
    contract.semantic_closure = {
      ...contract.semantic_closure,
      state: "closed",
      unresolved: [],
    };
  }
  result.route = {
    action: terminalAction === "answer" ? "answer_from_handles" : "edit_from_handles",
    reason: result.route?.reason ?? decision.reason,
    max_additional_tl_calls: 0,
  };
}

/**
 * A closed semantic receipt is terminal: it cannot simultaneously owe a
 * follow-up, and its route must name the one action the closed proof
 * authorizes rather than whatever the pre-closure branch happened to leave
 * behind (the §6.1 contradiction this fence exists to remove).
 */
function applyTerminalClosedDecision(
  result: TaskPackResult,
  contract: TaskExecutionContract,
  decision: CanonicalTaskDecision,
): void {
  clearDiscoveryProjection(result, contract);
  const terminalAction = contract.next_action === "edit" ? "edit" : "answer";
  contract.state = "ready";
  contract.readiness = terminalAction === "answer" ? "answer-ready" : "edit-ready";
  contract.discovery_complete = true;
  contract.next_action = terminalAction;
  const certificateId = certificateIdOf(contract);
  contract.typestate = {
    phase: "done",
    ...(certificateId !== undefined ? { certificate_id: certificateId } : {}),
    allowed_actions: [terminalAction],
    challenge_required_for: [],
  };
  if (contract.semantic_closure !== undefined) {
    contract.semantic_closure = { ...contract.semantic_closure, state: "closed", unresolved: [] };
  }
  result.route = {
    action: terminalAction === "answer" ? "answer_from_handles" : "edit_from_handles",
    reason: result.route?.reason ?? decision.reason,
    max_additional_tl_calls: 0,
  };
}

/**
 * PI-02 / F-A1-1 repair: a LIVE `discover` decision that still carries
 * capability gaps, WHILE A REQUIRED ROLE IS STILL MISSING (`result.missing`
 * non-empty — DESIGN-v0.8 §A4's coverage determinant), is itself proof
 * `coverage:"complete"` was wrong — the gaps ARE the outstanding work the
 * "complete" claim says does not exist (see the matching rule in
 * `canonicalTaskDecisionInvariantViolations`, which this repair exactly
 * mirrors, including the blocking/optional discriminator and why it is
 * `missing`, not the gap's own kind). Demote coverage to the truthful lesser
 * value. Never delete the gaps/next that justify the demotion — they are the
 * caller's only route to actually closing the pack — and never upgrade the
 * decision to make the contradiction disappear.
 *
 * A gap that exists only because a readiness-certificate proof obligation is
 * unsatisfied (every required role already found; plan item 5's
 * "optional_followups") is explicitly OUT of scope here — demoting THAT
 * shape would itself be a false "a required role was never found" claim.
 */
function repairCompleteCoverageWithGaps(
  result: TaskPackResult,
  contract: TaskExecutionContract,
  decision: CanonicalTaskDecision,
): void {
  if (
    result.coverage === "complete"
    && Array.isArray(result.missing) && result.missing.length > 0
    && (contract.capability_gaps?.length ?? 0) > 0
    && decision.kind === "discover"
  ) {
    // "partial" is the truthful lesser value (DESIGN-v0.8 coverage-honesty:
    // "focused" claims a single confident site with no fan-out, which an
    // open capability gap contradicts just as much as "complete" does).
    // `coverage_reason`'s five-value vocabulary does not map cleanly onto a
    // capability-gap kind, so none is fabricated here; an already-truthful
    // value the shape happens to carry (rare — a "complete" pack does not
    // normally carry one) is left untouched rather than cleared.
    result.coverage = "partial";
  }
}

/** Apply the canonical decision at the shared task-pack exit. */
export function applyCanonicalTaskDecision(result: TaskPackResult): CanonicalTaskDecision | undefined {
  const decision = deriveCanonicalTaskDecision(result);
  const contract = result.execution_contract;
  if (decision === undefined || contract === undefined) return decision;

  // Most established exits are already internally coherent. Restrict mutation
  // to an actual control-plane contradiction so compact legacy receipts retain
  // their wire compatibility; the shared exit still gives every new/repaired
  // shape the same decision projection.
  //
  // P0a §6.1 (2026-08-13): the repair trigger is now EXACTLY the runtime
  // invariant oracle (plus the one soft demotion the oracle deliberately does
  // not encode). Deriving it from the oracle is what makes the dispatcher
  // fence total: every shape the oracle can flag is a shape this function
  // repairs, so `enforceCanonicalTaskDecisionAtExit` converges instead of
  // reporting an unrepairable violation.
  //
  // W9 (2026-08-22) adds the third term, on the same footing as the second: a
  // repair trigger the ORACLE deliberately does not encode. An awaiting-input
  // contract carrying no call is not a protocol violation — it is a coherent
  // shape, which is exactly why the oracle stays silent about it. What is
  // incoherent is shipping it AFTER the derivation above has decided the pack
  // should discover: the contract would keep phase `awaiting-input` while the
  // wire said `discover`, re-creating the §6.1 "two incompatible orders in one
  // response" class this fence exists to remove. The condition is the
  // disagreement itself, so it is self-gating: no disagreement, no repair.
  const needsRepair =
    canonicalTaskDecisionInvariantViolations(result).length > 0
    || (contract.typestate.phase === "prepared" && requiredAnswerDocumentZoom(result) !== undefined)
    || (contract.typestate.phase === "awaiting-input" && decision.kind === "discover");
  if (!needsRepair) return decision;

  // F-A1-1: a coverage-honesty repair, orthogonal to the decision-shape
  // repairs below (it touches `result.coverage` only) and self-gated on the
  // exact contradiction it addresses, so it is a no-op for every OTHER
  // needsRepair trigger.
  repairCompleteCoverageWithGaps(result, contract, decision);

  if (decision.kind === "discover") applyDiscoverDecision(result, contract, decision);
  else if (decision.kind === "await-input") applyAwaitInputDecision(result, contract, decision);
  else if (decision.kind === "act-answer" || decision.kind === "act-edit") {
    applyTerminalDecision(result, contract, decision);
  } else {
    applyTerminalClosedDecision(result, contract, decision);
  }
  return decision;
}

/** Outcome of one shared-exit invariant enforcement. */
export interface CanonicalDecisionFenceReport {
  /** Violations observed BEFORE the repair; empty means the exit was already coherent. */
  violations: string[];
  /** Violations that survived the repair — always empty unless the normalizer cannot converge. */
  residual: string[];
  repaired: boolean;
}

/**
 * P0a §6.1 single fence. Run this on EVERY task-pack-shaped response exit
 * (initial pack, qref re-pack, `pack_unchanged`/semantic-duplicate receipt,
 * byte-budget fallback, and the dispatcher's post-processing rewrites) right
 * before the wire projection. It is idempotent: a coherent response is
 * returned untouched, so the in-build applications stay valid and receipts
 * keep their pinned bytes.
 */
export function enforceCanonicalTaskDecisionAtExit(result: TaskPackResult): CanonicalDecisionFenceReport {
  // The dispatcher hands this an untyped response record, so prove the shape
  // before the decision derivation walks `surfaces`. A response with no
  // contract has no decision to project, and a non-pack shape is not ours.
  if (result?.execution_contract === undefined || !Array.isArray(result.surfaces)) {
    return { violations: [], residual: [], repaired: false };
  }
  const violations = canonicalTaskDecisionInvariantViolations(result);
  applyCanonicalTaskDecision(result);
  const residual = canonicalTaskDecisionInvariantViolations(result);
  return { violations, residual, repaired: violations.length > 0 };
}

/** Compact property-test oracle for every task-pack exit projection. */
export function canonicalTaskDecisionInvariantViolations(result: TaskPackResult): string[] {
  const contract = result.execution_contract;
  if (contract === undefined) return [];
  const violations: string[] = [];
  const phase = contract.typestate.phase;
  const hasCertificate = hasCertificateBinding(contract);
  const hasReadOnlyContinuation = result.continuation?.stages.some((stage) =>
    stage.calls.some((call) => isReadOnlyCall(call)),
  ) === true;

  if (result.route?.action === "answer_from_handles") {
    // The route is a PROJECTION of the contract's own decision, so it may say
    // "answer from the handles you hold" exactly when the contract names
    // `answer` as its next action AND authorizes that action. Three phases can
    // satisfy that: `prepared` (with its certificate binding), `done` (a
    // closed semantic receipt already proved the answer), and `awaiting-input`
    // in the served-terminal grant, where the contract's own reason is "act on
    // the served evidence" and allowed_actions carries `answer` alongside
    // request-user-input.
    //
    // `discovery` NEVER can: its instruction to the agent is "run the single
    // next_call", so an answer route beside it is the §6.1 contradiction this
    // oracle exists to make impossible (observed on the dispatcher's
    // post-challenge revocation rewrite, which downgraded the contract to
    // discovery and left the route claiming a certified answer).
    const answerAuthorized = contract.next_action === "answer"
      && contract.typestate.allowed_actions.includes("answer");
    if (
      phase === "discovery"
      || !answerAuthorized
      || (phase === "prepared" && !hasCertificate)
    ) {
      violations.push("answer-route-requires-prepared-answer-certificate");
    }
  }
  // THE W3 CREATE-ROUTE EXEMPTION IS GONE ([R5-23] / ruling 6, 2026-08-14).
  // It used to add `&& result.create_target === undefined` here, so that a pack
  // which had RESOLVED a new-file target could sit in `discovery` while its
  // route said `edit_from_handles` — the contradiction the ruling names in so
  // many words: "today's server emits `discover` while separately handing the
  // caller a create instruction the decision that names it cannot express".
  // With `create_target` promoted onto `decision.act.edit` the decision CAN
  // express it, so a create pack that is genuinely ready no longer needs to
  // hide in `discovery`, and one that is NOT ready must not claim the edit
  // route. Either way the carve-out has nothing left to tolerate.
  if (
    result.route?.action === "edit_from_handles"
    && phase === "discovery"
  ) {
    // Same contradiction, edit side: "edit from the handles you hold" beside a
    // contract whose own instruction is "run the single next_call" leaves the
    // agent two incompatible orders in one response. The guide binds on phase,
    // so the route is the field that must move.
    violations.push("edit-route-forbids-discovery-phase");
  }
  if (phase === "prepared") {
    if (contract.state !== "ready" || !hasCertificate || contract.next_call !== undefined || hasReadOnlyContinuation) {
      violations.push("prepared-forbids-discovery-projection");
    }
    if (contract.typestate.allowed_actions.some((action) => action === "read" || action === "search")) {
      violations.push("prepared-forbids-read-search");
    }
  }
  if (phase === "discovery") {
    if (contract.state === "ready" || contract.next_call === undefined || !isReadOnlyCall(contract.next_call)) {
      violations.push("discovery-requires-one-readonly-next-call");
    }
    if (result.route?.action === "answer_from_handles") violations.push("discovery-forbids-answer-route");
  }
  if (phase === "awaiting-input") {
    if (contract.next_call !== undefined || hasReadOnlyContinuation) {
      violations.push("awaiting-input-forbids-automatic-discovery");
    }
  }
  if (contract.semantic_closure?.state === "closed" && phase !== "prepared" && phase !== "done") {
    violations.push("closed-semantic-closure-requires-terminal-phase");
  }
  if (phase === "done" && (contract.next_call !== undefined || hasReadOnlyContinuation)) {
    violations.push("done-forbids-continuation");
  }
  // PI-02 / F-A1-1 (2026-08-20, narrowed 2026-08-20 after a same-day
  // over-fire report): `coverage:"complete"` is model.ts's promise that
  // "every REQUIRED ROLE is covered AND every query concern is addressed —
  // trust it, edit directly" (DESIGN-v0.8 §A4: "coverage derives from
  // required roles only, not the surface budget"). `result.missing` is that
  // exact ledger — the required-role names nothing was ever found for
  // (readCodeTaskPack.ts's coverage computation clears an entry the moment a
  // surface fills the role). A LIVE `discover` decision that still carries
  // capability gaps is the opposite claim inside the SAME response ONLY when
  // `missing` is non-empty too: `discover` always names a concrete
  // `next_call` (D-1), `gaps` rides the wire only beside `discover` (D-4), so
  // "complete" beside "discover"+gaps+a real required-role omission asserts
  // both "nothing more is needed" and "a required role was never found" at
  // once — the plan's own item 3 ("required omissionがあるのにcompleteとなる
  // response 0件", DESIGN-v0.10-expansion-plan-v1.3.md L1151).
  //
  // Deliberately NOT flagged (plan L1122, item 5 — "coverage=complete と
  // optional_followupsの併存は許す"): a `capability_gaps` entry whose OWN
  // existence has nothing to do with role identification — e.g. a
  // readiness-certificate proof obligation ("surface-content": more of an
  // ALREADY-IDENTIFIED surface's body could still be embedded) — while every
  // required role already has a surface (`missing:[]`). v0.10 ships no
  // separate `blocking_gaps`/`optional_followups` wire field (reconciliation
  // §5 D-1 keeps the one `gaps` field for both), so `result.missing` is
  // today's only truthful, domain-grounded way to tell the two apart; the gap
  // KIND alone cannot (`readCodeTaskPack.spec.ts`'s "nothing required
  // missing... not partial-by-budget" and "...blocks edit_from_handles when
  // the edit body is partial" both carry `kind:"missing-evidence"`, the SAME
  // kind PI-02's own blocking fixture uses, with `missing:[]`). Also
  // deliberately NOT flagged: a `discover` decision with NO gaps (e.g.
  // `requiredAnswerDocumentZoom`'s Markdown zoom), and `coverage:"complete"`
  // beside a capability-gap-free contract in any other phase.
  //
  // `deriveCanonicalTaskDecision` — not a second, hand-rolled approximation
  // of it — remains the source of truth for "would this contract actually
  // project a discover decision" (a structural approximation drifting from
  // the real projector is how F-A1-1 happened in the first place).
  if (
    result.coverage === "complete"
    && Array.isArray(result.missing) && result.missing.length > 0
    && (contract.capability_gaps?.length ?? 0) > 0
    && deriveCanonicalTaskDecision(result)?.kind === "discover"
  ) {
    violations.push("complete-coverage-forbids-discover-gaps");
  }
  return violations;
}
