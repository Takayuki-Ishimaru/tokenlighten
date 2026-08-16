// ---------------------------------------------------------------------------
// protocol v1 — the single decision on the wire, and the affordances it is
// derived from (C2-2).
//
// NORMATIVE SOURCE: DESIGN-v0.10 §2.1 (the decision, emitted once), §2.1.1
// (delivery floors on `act`, F4), §2.1.2 (`next` is a set of now-executable
// calls, F5), §3.4 E4 (the ten deleted re-encodings), §3.4.1 (ORCHESTRATOR
// CONDITION ①), §4.4 (gaps / limits / evidence), and §10.3 Appendix A
// (Revision 4) A.2.3, A.2.4, A.2.6, A.2.7, A.3, A.5.1, A.7.2, A.8.
//
// THE ONE SENTENCE THIS MODULE EXISTS FOR (§3.4.1, normative):
//
//     the set of calls a response sanctions is a function of that response's
//     own emitted affordances.
//
// Not of `route.max_additional_tl_calls` (deleted, §3.4 E4 row 1), not of a
// separately-computed budget. `sanctionFromEvidence()` below takes the ARRAY
// THIS RESPONSE EMITS and nothing else, which is why it is a pure function of
// `Evidence[]` with no second parameter: there is no third input.
// ---------------------------------------------------------------------------

import type {
  Candidate,
  CapabilityGap,
  CertificateRef,
  CoverageReason,
  CreateTarget,
  Evidence,
  FrontierEntry,
  SurfaceRole,
  TaskDecision,
  TaskRef,
  ToolCall,
  WorkspaceMarker,
} from "@tokenlighten/types";
import type { TaskExecutionContract } from "@tokenlighten/types";

import { emittableToolCall } from "./refusal.js";
import { discoveryBundleAdvisory, discoveryBundleNext } from "../features/task-pack/canonicalDecision.js";

/**
 * §3.4.1: "bounded by the same cap 4 the current implementation applies". The
 * cap is a property of the fence, so it is duplicated from
 * `state/session.ts`'s `SANCTIONED_ZOOM_BUDGET_CAP` deliberately — the fence
 * clamps what it is handed, and this module must not be able to hand it more.
 */
export const SANCTIONED_ZOOM_CAP = 4;

// ---------------------------------------------------------------------------
// A.2.7 `Evidence` — the surfaces[] collapse
// ---------------------------------------------------------------------------

/**
 * `ReadCodeTaskPackSurface` -> `Evidence` (A.2.7).
 *
 * Field mapping, one row each:
 *   handle           -> handle          (§3.3 addressing triple)
 *   path             -> path
 *   range            -> range
 *   code             -> body            (the served bytes)
 *   code_unchanged   -> prior           (§2.3's residency claim, per source)
 *   remaining_ranges -> remaining       (§4.4; ONE of CONDITION ①'s two inputs)
 *   role             -> role            ([R4-2], A.9.2 row 22)
 *
 * A.9.2 row 22 is explicit that `role` must SURVIVE the collapse and must never
 * be defaulted to `"unknown"` — `"unknown"` is an emitted value with its own
 * meaning, and a caller that passed `surfaceRoles` learns from the ABSENCE of
 * `role` that the selector did not bind.
 *
 * THE FIELD ADJUDICATION (C2-3, replacing C2-2's declared passthrough).
 *
 * A.5.1 lists `evidence: Evidence[]` and nothing else, and A.2.7 gives
 * `Evidence` exactly seven members. C2-2 carried every OTHER surface field
 * through unadjudicated and said so, because deciding a field's fate is the
 * body-authoring work item's job. This is that decision, and it is stated as
 * three lists rather than one set difference so the deviations are countable:
 *
 * KEPT PER APPENDIX (A.2.7): handle, path, range, body, prior, remaining, role.
 *
 * KEPT AS A DISCLOSED DEVIATION — four fields, each because deleting it would
 * lose a capability with no other carrier in v1 (Revision-5 rows):
 *   `sha`          the hash an edit pins to (`precondition:"expected-hash"`,
 *                  `edit_file`'s `expectedSha`). `Evidence` declares no sha and
 *                  no other v1 field carries one per surface.
 *   `symbol`       the NAMED selector this window came from. `range` cannot
 *                  express "this is `foo`" — the 2026-08-08 ND-1 finding was
 *                  precisely that a named selector denotes lines it cannot name.
 *   `why`          A.8 rule E-7 lists `why` among the prose fields shed first
 *                  under budget pressure, so the appendix EXPECTS it on the
 *                  wire; deleting it here would contradict A.8.
 *   `likely_edits` the per-surface edit targets. `decision.act.edit.frontier`
 *                  names WHICH files are writable; this names WHERE in them,
 *                  and nothing else on the v1 wire does.
 *
 * DELETED — every other surface field. Named, with the rule that kills each:
 *   `content_completeness`  Rule T: per-source truncation IS `remaining`. Two
 *                           fields for one fact is the §4.4 dialect problem.
 *   `next_call`             §2.1.2/F5: continuation authority belongs to the
 *                           single decision, not to N per-surface copies.
 *   `served_by`             renamed: it is what `prior` names.
 *   `facts`                 the guide binds evidence relations to `plan.
 *                           evidence_model`, which is the surviving carrier.
 *   `outline`, `headings`, `anchors_served`, `kind`, `required`, `edit_intent`,
 *   `done_check`, `container_path`, `member_path`, `note`, and anything else a
 *   future surface grows: not in A.2.7, no orphaned capability, so they go.
 *
 * The allow-list is CLOSED by construction below — an unlisted field cannot
 * reach the wire by accident, which is the property C2-2's passthrough lacked.
 */
/**
 * The four disclosed deviations, in one place so the deviation set is one grep.
 * Removing a row here is a pure deletion — no other code reads them.
 */
const EVIDENCE_KEPT_BEYOND_APPENDIX = ["sha", "symbol", "why", "likely_edits"] as const;

/**
 * The residency label a COMPACT `pack-unchanged` re-serve stamps on every
 * body-less surface (§2.3, A.4).
 *
 * WHY THE PROJECTOR SUPPLIES IT. The compact re-serve emits addressing-only
 * surfaces — handle/path/range/role/sha and deliberately no body — because on
 * that response every surface is prior-held BY CONSTRUCTION: that is the
 * receipt's entire claim. But the surfaces carry no per-surface residency
 * marker, so `projectEvidence` produced entries with no `body`, no `prior` and
 * no `remaining`: BARE entries, violating E-8, and — the visible consequence —
 * `answerFloorHolds` below then breached, `projectTaskDecision` degraded a
 * ready `act.answer` to `await_input:"no-grounded-call-remains"`, and
 * `readFamily.ts`'s `pack-unchanged` honesty gate (which refuses a receipt
 * whose decision moved to `discover`/`await_input`) refused the very receipt
 * this response was built to be. A three-step self-inflicted loop whose only
 * cause was an unstated fact.
 *
 * The label is the one `receiptOf` already synthesises for the same entries, so
 * stating it here does not introduce a claim — it moves an existing one to the
 * address §2.1.1's floor and A.8's E-8 both read. §2.1.1: `prior` is VERIFIABLE
 * — the named call is the task_pack call this response is the unchanged
 * re-issue of, which the caller made and holds.
 */
export function packUnchangedPriorLabel(result: Record<string, unknown>): string | undefined {
  if (result["receipt"] !== "pack-unchanged" && result["pack_unchanged"] !== true) return undefined;
  const replay = result["qref"];
  return typeof replay === "string" && replay !== ""
    ? `read_file mode=task_pack qref=${replay}`
    : "read_file mode=task_pack (earlier in this session)";
}

export function projectEvidence(surfaces: unknown, priorForBodyless?: string): Evidence[] {
  if (!Array.isArray(surfaces)) return [];
  const evidence: Evidence[] = [];
  for (const surface of surfaces) {
    if (surface === null || typeof surface !== "object" || Array.isArray(surface)) continue;
    const record = surface as Record<string, unknown>;
    const handle = typeof record["handle"] === "string" ? record["handle"] : "";
    if (handle === "") continue;
    const remaining = Array.isArray(record["remaining_ranges"])
      ? record["remaining_ranges"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const carried: Record<string, unknown> = {};
    for (const key of EVIDENCE_KEPT_BEYOND_APPENDIX) {
      const value = record[key];
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      carried[key] = value;
    }
    evidence.push({
      handle,
      // §3.3's addressing triple, plus [R4-2] / A.9.2 row 22: `role` SURVIVES
      // the collapse, and is never defaulted to "unknown" — absence tells a
      // caller that passed `surfaceRoles` that the selector did not bind.
      ...(typeof record["path"] === "string" ? { path: record["path"] } : {}),
      ...(typeof record["range"] === "string" ? { range: record["range"] } : {}),
      ...(typeof record["code"] === "string" ? { body: record["code"] } : {}),
      ...(typeof record["code_unchanged"] === "string"
        ? { prior: record["code_unchanged"] }
        : priorForBodyless !== undefined && typeof record["code"] !== "string"
          ? { prior: priorForBodyless }
          : {}),
      ...(remaining.length > 0 ? { remaining } : {}),
      ...(typeof record["role"] === "string" ? { role: record["role"] as SurfaceRole } : {}),
      ...carried,
    });
  }
  return evidence;
}

// ---------------------------------------------------------------------------
// §3.4.1 ORCHESTRATOR CONDITION ① — the sanctioned-zoom affordance, re-anchored
// ---------------------------------------------------------------------------

export interface SanctionedZoom {
  /** Handles this response left partial — the ONLY handles a zoom may name. */
  handles: string[];
  /** How many zooms are sanctioned: one per advertising entry, capped at 4. */
  budget: number;
}

/**
 * CONDITION ① (§3.4.1), in full.
 *
 * BEFORE (the wiring this replaces): the budget came from
 * `route.max_additional_tl_calls` (`server.ts`) and the handle set from
 * `surfaces[].remaining_ranges`. Both inputs are §3.4 E4 deletions, so keeping
 * either would leave the fence reading a field the wire no longer carries —
 * i.e. it would restore the 2026-08-13 "pack advertises / fence refuses"
 * contradiction under new field names, which is the outcome §3.4.1 names as
 * the failure mode.
 *
 * AFTER: one input. If a v1 pack emits `evidence[i].remaining`, a same-handle
 * window-shaped zoom against `evidence[i].handle` is servable. If it emits
 * nothing, nothing is sanctioned. There is no third input, so this function
 * takes no second argument — the type is the rule.
 *
 * The budget is the COUNT of advertising entries rather than a number the pack
 * carries: an advertisement is a promise, so N advertised handles are N
 * promises and the response owes exactly that many. Capped at 4 (§3.4.1: "the
 * same cap 4 the current implementation applies").
 */
export function sanctionFromEvidence(evidence: readonly Evidence[]): SanctionedZoom | undefined {
  const handles: string[] = [];
  for (const entry of evidence) {
    if (entry.remaining === undefined || entry.remaining.length === 0) continue;
    if (entry.handle === "" || handles.includes(entry.handle)) continue;
    handles.push(entry.handle);
  }
  if (handles.length === 0) return undefined;
  return { handles, budget: Math.min(handles.length, SANCTIONED_ZOOM_CAP) };
}

// ---------------------------------------------------------------------------
// A.2.3 `TaskRef`
// ---------------------------------------------------------------------------

const COVERAGE_REASONS: ReadonlySet<string> = new Set<CoverageReason>([
  "single-site", "candidate-list", "missing-roles", "concerns-uncovered", "diff-truncated",
]);

/**
 * A.2.3: identity and replay token are TWO things because their invalidation
 * rules are opposite. `id` is the certificate's own `task_fingerprint` (stable
 * across re-packs of the same task); `replay` is the session-lived `qref`.
 */
export function projectTaskRef(
  result: Record<string, unknown>,
  contract: TaskExecutionContract | undefined,
  fallbackId: string,
): TaskRef {
  const fingerprint = contract?.readiness_certificate?.task_fingerprint;
  const coverage = result["coverage"];
  const reason = result["coverage_reason"];
  const resolved: TaskRef["coverage"] =
    coverage === "complete" || coverage === "focused" || coverage === "partial"
      ? coverage
      : "partial";
  return {
    id: typeof fingerprint === "string" && fingerprint !== "" ? fingerprint : fallbackId,
    ...(typeof result["qref"] === "string" && result["qref"] !== ""
      ? { replay: result["qref"] }
      : {}),
    coverage: resolved,
    // A.8.2: emitted iff `coverage !== "complete"`.
    ...(resolved !== "complete" && typeof reason === "string" && COVERAGE_REASONS.has(reason)
      ? { coverage_reason: reason as CoverageReason }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// A.2.2 / A.2.4 `WorkspaceMarker` and `CertificateRef`
// ---------------------------------------------------------------------------

/** D12: `TaskWorkspaceState.version` is a TS literal and never reaches the wire. */
function projectWorkspaceMarker(value: unknown): WorkspaceMarker | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const scope = record["scope"];
  if (typeof record["fingerprint"] !== "string") return undefined;
  if (scope !== "served-evidence" && scope !== "evidence-plus-inventory") return undefined;
  return {
    fingerprint: record["fingerprint"],
    scope,
    evidence_files: Number(record["evidence_files"] ?? 0),
    inventory_files: Number(record["inventory_files"] ?? 0),
    inventory_complete: record["inventory_complete"] === true,
  };
}

/**
 * A.2.4: the certificate-binding workspace fingerprint lives on
 * `CertificateRef.workspace` and nowhere else. `obligations` is non-empty BY
 * TYPE because §2.1.1's floor is stated per obligation — a certificate that
 * names none cannot carry a floor, so it cannot authorise an `act`.
 */
function projectCertificate(
  contract: TaskExecutionContract,
  result: Record<string, unknown>,
): CertificateRef | undefined {
  const id = contract.readiness_certificate?.id ?? contract.typestate.certificate_id;
  if (typeof id !== "string" || id === "") return undefined;
  const obligations = (contract.readiness_certificate?.obligations ?? [])
    .map((obligation) => obligation.id)
    .filter((value): value is string => typeof value === "string" && value !== "");
  if (obligations.length === 0) return undefined;
  // A.2.4: the marker is the state the certificate was PROVED against, so the
  // contract's own copy is the authority. The pack's top-level `workspace_state`
  // is the same struct at an undeclared address (the census's positional-drift
  // finding) and is the fallback for a compact re-serve that carries it there.
  const workspace = projectWorkspaceMarker(contract.workspace_state)
    ?? projectWorkspaceMarker(result["workspace_state"]);
  if (workspace === undefined) return undefined;
  return { id, obligations: [obligations[0]!, ...obligations.slice(1)], workspace };
}

// ---------------------------------------------------------------------------
// A.2.6 `FrontierEntry`
// ---------------------------------------------------------------------------

/**
 * The certificate's `action_frontier` is a handle list; A.2.6 requires
 * handle + path + writable, so the paths are joined from the pack's own
 * `frontier_index`/surfaces rather than re-derived. An entry whose path cannot
 * be named is DROPPED, not defaulted: a frontier entry a client cannot address
 * is not a bounded effect area, and §2.1.1 makes an empty frontier degrade the
 * decision rather than ship an unusable one.
 */
function projectFrontier(
  contract: TaskExecutionContract,
  evidence: readonly Evidence[],
  result: Record<string, unknown>,
): FrontierEntry[] {
  const handles = contract.readiness_certificate?.action_frontier ?? [];
  const paths = new Map<string, string>();
  for (const entry of evidence) {
    if (entry.path !== undefined) paths.set(entry.handle, entry.path);
  }
  const index = result["frontier_index"];
  if (Array.isArray(index)) {
    for (const item of index) {
      if (item === null || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record["handle"] === "string" && typeof record["path"] === "string") {
        paths.set(record["handle"], record["path"]);
      }
    }
  }
  const frontier: FrontierEntry[] = [];
  for (const handle of handles) {
    const path = paths.get(handle);
    if (path === undefined) continue;
    // §2.1.1: an edit frontier is the bounded effect area, so every entry is a
    // write target by construction. `writable` is the type's readback of that,
    // not a filesystem probe.
    frontier.push({ handle, path, writable: true });
  }
  return frontier;
}

/**
 * The pack's proved create target, projected onto the decision ([R5-23],
 * ruling 6, 2026-08-14).
 *
 * WHY THIS FUNCTION IS A VALIDATOR AND NOT A COPY. The field arrives from an
 * untyped `TaskPackResult` record, and `create_target` is now HALF OF A FLOOR:
 * an `act.edit` with no frontier is legal exactly when this is present. A
 * malformed or path-less object promoted verbatim would satisfy the floor while
 * naming no place to write, which is the state the floor exists to forbid — so
 * a target that cannot state its own `path` is DROPPED, on the same rule
 * `projectFrontier` applies one function above ("an entry whose path cannot be
 * named is DROPPED, not defaulted").
 *
 * `directory_evidence` is normalised to a string array rather than required to
 * be non-empty: the producers all prove >=1 sibling before emitting, and a
 * floor that also policed the evidence list would be re-deciding upstream's
 * proof from downstream of it.
 */
function projectCreateTarget(result: Record<string, unknown>): CreateTarget | undefined {
  const value = result["create_target"];
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const path = record["path"];
  if (typeof path !== "string" || path === "") return undefined;
  const evidence = Array.isArray(record["directory_evidence"])
    ? record["directory_evidence"].filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
  return { path, directory_evidence: evidence };
}

// ---------------------------------------------------------------------------
// A.2.7 `CapabilityGap`
// ---------------------------------------------------------------------------

/**
 * `TaskCapabilityGap.kind` -> `CapabilityGap.code`, A.9.2 rows 15 + 24.
 *
 * OB-GAP IS DISCHARGED (C2-7b): both types are now the SAME five values, so
 * this set is a total map, not a narrowing. `invalid-request` and
 * `unsupported-operation` were MINTED into the v1 union — their emitters in
 * `buildCapabilityGaps` (`features/task-pack/readCodeTaskPack.ts`) are live, so
 * dropping them silently would have been information loss, and coercing them
 * into `missing-evidence` would assert "the server looked and it is not there"
 * about a request that was simply invalid: the exact class §4.4 exists to keep
 * apart. `permission-required` and `external-execution-required` were DELETED
 * from the producer type (emitter-zero AND reader-zero).
 *
 * The filter below is retained as a fail-closed floor, not as a narrowing: a
 * future producer value that this file has not been taught still declines to
 * ride the wire under a code that would misdescribe it.
 */
const GAP_CODES: ReadonlySet<string> = new Set<CapabilityGap["code"]>([
  "missing-evidence", "ambiguous-target", "invalid-request",
  "unsupported-operation", "workspace-changed",
]);

/**
 * A.2.7: gaps live on `decision.gaps` and nowhere else.
 *
 * NO CAP. `util/leanExecutionContract.ts`'s `MAX_LEAN_CAPABILITY_GAPS = 2`
 * silently dropped a third gap, and it also dropped any gap that carried no
 * `next_call`. Both rules existed because the pre-v1 gap carried prose
 * (`reason`, capped at 120 chars) and an executable call, so a gap was
 * expensive and had to earn its bytes. v1's `CapabilityGap` is `code` + `refs`
 * — no prose, no call, because §4.4 is explicit that none of the three is
 * fixed by asking for more bytes. The byte argument for the cap is gone, and a
 * silently dropped gap is an undisclosed omission, which A.8 rule E-1 does not
 * permit. So: every gap whose code is representable is emitted.
 */
function projectGaps(contract: TaskExecutionContract): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];
  for (const gap of contract.capability_gaps ?? []) {
    if (!GAP_CODES.has(gap.kind)) continue;
    const refs = [...new Set([
      ...(gap.obligation_ids ?? []).filter((value) => typeof value === "string" && value !== ""),
    ])];
    gaps.push({
      code: gap.kind as CapabilityGap["code"],
      ...(refs.length > 0 ? { refs } : {}),
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// A.3 `TaskDecision`
// ---------------------------------------------------------------------------

/** §2.1.2 (F5): the calls executable NOW. Unexecutable candidates are dropped. */
function discoverNext(
  contract: TaskExecutionContract | undefined,
  result: Record<string, unknown>,
): ToolCall | undefined {
  const fromContract = emittableToolCall(contract?.next_call);
  if (fromContract !== undefined) return fromContract;
  const continuation = result["continuation"];
  if (continuation !== null && typeof continuation === "object") {
    const stages = (continuation as { stages?: unknown }).stages;
    if (Array.isArray(stages)) {
      for (const stage of stages) {
        const calls = (stage as { calls?: unknown } | null)?.calls;
        if (!Array.isArray(calls)) continue;
        for (const call of calls) {
          const emittable = emittableToolCall(call);
          if (emittable !== undefined) return emittable;
        }
      }
    }
  }
  return undefined;
}

/**
 * The smallest executable call that widens a window THIS response already
 * served — §2.1.2's "executable NOW against the state the client holds".
 *
 * Built from `evidence[].remaining`, which is the one field that says, per
 * handle, what of it the client does NOT have. It is therefore the concrete
 * form of the branch-3 prose's own instruction — *"widening a window via its
 * handle first if the target lies outside what was served"* — turned into a
 * call the caller can run instead of a sentence it has to interpret.
 *
 * Returns `undefined` when every served handle is complete at the windows
 * requested: there is then nothing to zoom, and a `discover` naming a call that
 * fetches nothing new would be a round trip charged for no bytes.
 */
function servedEvidenceZoom(evidence: readonly Evidence[]): ToolCall | undefined {
  for (const entry of evidence) {
    const range = entry.remaining?.[0];
    if (typeof range === "string" && range !== "") {
      return { tool: "read_file", arguments: { handle: entry.handle, range } };
    }
  }
  return undefined;
}

/** A.2.5: the choices an `await_input` decision is asking the caller between. */
function projectCandidates(result: Record<string, unknown>, evidence: readonly Evidence[]): Candidate[] {
  if (result["coverage_reason"] !== "candidate-list") return [];
  const candidates: Candidate[] = [];
  for (const entry of evidence) {
    if (entry.path === undefined) continue;
    candidates.push({
      path: entry.path,
      handle: entry.handle,
      ...(entry.role !== undefined ? { kind: entry.role } : {}),
    });
  }
  return candidates;
}

/**
 * §2.1.1's evidence floor for `act.answer`, applied.
 *
 * The floor is "for every obligation the certificate names, usable evidence the
 * client holds: either an `Evidence` entry with a `body`, or an `Evidence`
 * entry whose `prior` names an earlier call in this session". Obligation ids
 * are not join keys onto evidence entries at HEAD, so the check this commit can
 * make honestly is the necessary condition: the response must carry at least
 * one usable entry, and every entry must satisfy A.8's E-8 invariant
 * (`!body` ⟹ `prior` or `remaining`). A per-obligation join is C2-3's, when the
 * read.task_pack body is authored against A.5.1 and the certificate's
 * `evidence_handles` become part of the emitted shape.
 */
export function answerFloorHolds(
  // STRUCTURAL, NOT `readonly Evidence[]`, since C2-2 exported it: the floor
  // reads exactly two fields, and `budget/actFloor.ts` re-asks it of an
  // already-projected body whose entries are untyped records. Widening the
  // parameter to the two fields the predicate actually touches is what lets
  // there be ONE definition of the floor instead of a typed one and a
  // hand-rolled copy — `Evidence[]` still satisfies it, structurally.
  evidence: readonly { readonly body?: string; readonly prior?: string }[],
): boolean {
  return evidence.some((entry) => entry.body !== undefined || entry.prior !== undefined);
}

/**
 * §2.1.1's `act.edit` floor, AS AMENDED BY [R5-23] (ruling 6, 2026-08-14):
 * *"`frontier` non-empty **OR** a create target"*.
 *
 * ONE DEFINITION, THREE CALLERS. `projectTaskDecision` below asks it before it
 * emits; `budget/actFloor.ts` asks it again after every shed rung; and
 * `budget/requiredSets.ts` states the same disjunction as a body predicate so
 * the validator can refuse a breach the projector never produced. They must
 * agree, so there is one function and the other two import it — a second
 * spelling of a floor is how a floor stops being one.
 *
 * WHY A DISJUNCTION IS NOT A WEAKENING. Both arms answer the same question —
 * *where may I write* — for the two kinds of target that exist: `frontier`
 * addresses files that exist (handle + path + writable), `create_target` names
 * the one that does not. An `act.edit` carrying NEITHER still breaches, which
 * is the whole content of the floor.
 */
export function editFloorHolds(
  frontier: readonly FrontierEntry[],
  createTarget: CreateTarget | undefined,
): boolean {
  return frontier.length > 0 || createTarget !== undefined;
}

export interface DecisionProjectionInput {
  result: Record<string, unknown>;
  contract: TaskExecutionContract | undefined;
  /** The canonical runtime verdict; `undefined` when the pack carries no contract. */
  canonicalKind: "discover" | "await-input" | "act-answer" | "act-edit" | "terminal-closed" | undefined;
  evidence: readonly Evidence[];
}

/**
 * §2.1's one-to-one projection of `CanonicalTaskDecisionKind` onto the wire
 * union, WITH §2.1.1's coupling rule applied.
 *
 * The degradations below are the coupling rule, not defensive coding: a
 * decision is a claim about what the client should do next, so it may only be
 * emitted when the response carries what that action needs. An `act.answer`
 * emitted over shed evidence instructs the client to answer from bytes it does
 * not have — the 2026-08-13 fabrication-push class. `discover` with an
 * executable `next` is a TRUE statement of the same situation.
 */
export function projectTaskDecision(input: DecisionProjectionInput): TaskDecision | undefined {
  const { result, contract, canonicalKind, evidence } = input;
  if (canonicalKind === undefined || contract === undefined) return undefined;

  const next = discoveryBundleNext(result as never) ?? discoverNext(contract, result);

  if (canonicalKind === "terminal-closed") return { kind: "done" };

  if (canonicalKind === "act-answer" || canonicalKind === "act-edit") {
    const certificate = projectCertificate(contract, result);
    if (certificate !== undefined) {
      if (canonicalKind === "act-answer") {
        if (answerFloorHolds(evidence)) return { kind: "act.answer", certificate };
      } else {
        const frontier = projectFrontier(contract, evidence, result);
        // [R5-23] / ruling 6: the create target is the SECOND arm of the floor,
        // so it is read before the guard, not after it. Before this, a pack
        // that had resolved a new-file target produced an empty frontier, fell
        // through to `discover`, and shipped beside an `edit_file create:true`
        // instruction the decision itself could not express.
        const createTarget = projectCreateTarget(result);
        if (editFloorHolds(frontier, createTarget)) {
          return {
            kind: "act.edit",
            certificate,
            // KEY ORDER IS THE WIRE. `frontier` keeps its position ahead of the
            // new key so every already-pinned `act.edit` body is byte-identical
            // (§0.3); a create-only decision simply omits it, which E-1 makes
            // the spelling of "no existing file is a write target here".
            ...(frontier.length > 0
              ? { frontier: [frontier[0]!, ...frontier.slice(1)] as [FrontierEntry, ...FrontierEntry[]] }
              : {}),
            ...(createTarget !== undefined ? { create_target: createTarget } : {}),
          };
        }
      }
    }
    // Floor breached -> degrade (§2.1.1). Never falsify the act.
    if (next !== undefined) {
      const gaps = projectGaps(contract);
      const advisory = discoveryBundleAdvisory(result as never);
      return { kind: "discover", next, ...(advisory !== undefined ? { advisory } : {}), ...(gaps.length > 0 ? { gaps } : {}) };
    }
    return { kind: "await_input", code: "no-grounded-call-remains" };
  }

  if (canonicalKind === "discover") {
    if (next !== undefined) {
      const gaps = projectGaps(contract);
      const advisory = discoveryBundleAdvisory(result as never);
      return { kind: "discover", next, ...(advisory !== undefined ? { advisory } : {}), ...(gaps.length > 0 ? { gaps } : {}) };
    }
    // §2.1: `discover` without a `next` is unrepresentable. The honest shape
    // for "I cannot name a call" is `await_input`, and A.7.2 branch 4 is
    // exactly that condition.
    return { kind: "await_input", code: "no-grounded-call-remains" };
  }

  // await-input. A.7.2 / A.9.2 row 21: the code is emitted by the branch that
  // made the decision (`contract.await_input_code`), never inferred from prose.
  const awaitCode = contract.await_input_code ?? "no-grounded-call-remains";

  // -------------------------------------------------------------------------
  // [R5-30] / ruling 6 — BRANCH 3 IS RE-SITED, GATED ON THE FLOOR.
  //
  // `act-on-served-evidence` is `grantServedTerminal`'s token
  // (`readCodeTaskPack.ts`'s awaiting-user-input block). That branch's own
  // prose GRANTS the terminal action — "the selected windows of every required
  // surface are served — act on the served evidence" — and its `next_action`
  // agrees; only the SITING said "the server cannot proceed without a human
  // choice". A value spelled *act*-on-served-evidence riding the one kind whose
  // meaning is "I cannot proceed" is the decision↔delivery falsification class
  // F4 removes everywhere else, so the siting is what moves.
  //
  // THE ORDER IS THE RULING'S, and each step is a floor, not a preference:
  //
  //  1. a REAL certificate plus a satisfied §2.1.1 floor -> `act.*`. D-2 makes
  //     the certificate non-negotiable: `act.answer`/`act.edit` are certified
  //     claims, and one is NEVER MINTED HERE. `grantServedTerminal` requires
  //     `readiness === "needs-followup"`, i.e. `!accepted`, and the certificate
  //     is minted only when `accepted` — so at HEAD this arm does not fire, and
  //     that is a fact about the branch rather than a gap in this code. It is
  //     implemented because the floor, not the branch's history, is what
  //     decides: a contract that DOES arrive here certified (a re-serve
  //     carrying `typestate.certificate_id`, say) must get the act it earned.
  //  2. otherwise a concrete restoring call -> `discover`. This is the honest
  //     statement of the uncertified case, and it is the branch's own prose
  //     made executable.
  //  3. otherwise the branch really is awaiting input, and keeps its own token.
  //     Not a residue of the old contradiction: with no certificate AND no call
  //     to name, the grant the prose offered was never real, so `await_input`
  //     is the true siting and A.7.2's per-branch token is the true code.
  // -------------------------------------------------------------------------
  if (awaitCode === "act-on-served-evidence") {
    const certificate = projectCertificate(contract, result);
    if (certificate !== undefined) {
      if (contract.next_action === "answer") {
        if (answerFloorHolds(evidence)) return { kind: "act.answer", certificate };
      } else {
        const frontier = projectFrontier(contract, evidence, result);
        const createTarget = projectCreateTarget(result);
        if (editFloorHolds(frontier, createTarget)) {
          return {
            kind: "act.edit",
            certificate,
            ...(frontier.length > 0
              ? { frontier: [frontier[0]!, ...frontier.slice(1)] as [FrontierEntry, ...FrontierEntry[]] }
              : {}),
            ...(createTarget !== undefined ? { create_target: createTarget } : {}),
          };
        }
      }
    }
    const restoring = next ?? servedEvidenceZoom(evidence);
    if (restoring !== undefined) {
      const gaps = projectGaps(contract);
      const advisory = discoveryBundleAdvisory(result as never);
      return { kind: "discover", next: restoring, ...(advisory !== undefined ? { advisory } : {}), ...(gaps.length > 0 ? { gaps } : {}) };
    }
  }

  const candidates = projectCandidates(result, evidence);
  return {
    kind: "await_input",
    code: awaitCode,
    ...(candidates.length > 0 ? { candidates } : {}),
  };
}
