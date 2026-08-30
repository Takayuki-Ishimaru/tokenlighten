import type { ImpactSurface } from "./locate-impact.js";
import type { AwaitInputCode } from "./decision.js";

// ---------------------------------------------------------------------------
// DESIGN-v0.9 §5 (WS2) ContinuationPlan — contract mirror.
//
// The authoritative runtime shape lives in mcp-server
// (packages/mcp-server/src/util/continuation.ts, functionally required); this
// additive mirror is the stable public contract (precedent: the
// ReadCodeTaskPackOutput mirror below carries pack_unchanged/checks_open;
// `closure` ships as a bare string[]). A model-agnostic structured plan for the
// residual reads a response leaves, in a server-verified order any client can
// execute. The legacy `next` string is derived from `stages[0].calls[0]`
// (§5.3), so a client that reads only `next` gets the first step.
// ---------------------------------------------------------------------------
export interface ContinuationCall {
  /** One of the 3 advertised tools. */
  tool: "read_file" | "edit_file" | "search_files";
  /** Arguments schema-valid for `tool`. */
  arguments: Record<string, unknown>;
  /** Optional purpose (<=60 chars); decorative — first to shed under the byte budget. */
  purpose?: string;
}

export interface ContinuationStage {
  /**
   * "parallel": a capable client MAY batch these calls in one message.
   * "sequential": run in order. There is NO intra-stage data dependency by
   * construction, so running everything sequentially is always correct (§5.2).
   */
  execution: "parallel" | "sequential";
  /** 1..3 calls, no intra-stage data dependency. */
  calls: ContinuationCall[];
}

export interface ContinuationPlan {
  version: 1;
  /** Ordered stages; emitted only when non-empty. Later stages may depend on earlier ones. */
  stages: ContinuationStage[];
}

// ---------------------------------------------------------------------------
// read_code mode=task_pack — v0.7/v0.8 task-closure pack (contract mirror).
//
// The authoritative runtime shape is `TaskPackResult` in the mcp-server
// package (packages/mcp-server/src/tools/readCodeTaskPack.ts); it carries many
// additional optional fields (route, checks, verify, likely_edits, tree, ...).
// This interface is the stable public CONTRACT surface for the fields external
// consumers depend on, and is the canonical home for the additive session-
// semantics fields below. Kept as a superset-tolerant shape (extra fields on
// the wire are ignored by structural typing).
// ---------------------------------------------------------------------------
export interface ReadCodeTaskPackSurface {
  handle: string;
  path: string;
  range: string;
  role: ImpactSurface;
  /** Present on a freshly-computed pack when the surface embeds exact code; omitted on a compact `pack_unchanged` response. */
  code?: string;
  /**
   * DESIGN-v0.9 §4.1/§4.3/§4.4 content-completeness split (distinct from
   * `coverage`, which answers surface IDENTIFICATION). Answers "was this
   * surface's full range BODY embedded?". CONVENTION: the ONLY value ever
   * emitted is "partial" (absence = complete); present when the body was
   * match-centered-trimmed at the cliff or body-stripped under pack budget, so
   * it is always accompanied by `remaining_ranges`.
   */
  content_completeness?: "partial";
  /**
   * DESIGN-v0.9 §3.1/§4.1: uncovered "<start>-<end>" line spans of THIS
   * surface's `range` not embedded (0, 1, or 2 spans). Same-handle re-slice —
   * never a re-locate. Present only alongside content_completeness:"partial".
   */
  remaining_ranges?: string[];
}

export type ReadCodeArtifactSection =
  | { sheet: string; range: string; columns: string[]; rows: unknown[][]; truncated: boolean }
  | { kind: "docx"; sections: Array<{ heading: string; text: string }>; truncated: boolean }
  | { kind: "pptx"; slides: Array<{ heading: string; text: string }>; truncated: boolean }
  | { kind: "pdf"; pages: Array<{ page: number; text: string }>; truncated: boolean };

export type ConcernEvidenceClass =
  | "behavioral"
  | "normative"
  | "runtime-observation";

export type ConcernEvidenceSubclass = "prose" | "declaration";

export interface ConcernEvidenceSurface {
  class: ConcernEvidenceClass;
  subclass?: ConcernEvidenceSubclass;
  handle: string;
  path: string;
  range: string;
  why: string;
  matched: string[];
  code?: string;
  code_unchanged?: string;
  content_completeness?: "partial";
  remaining_ranges?: string[];
}

export interface ConcernEvidenceConflictPosition {
  class: ConcernEvidenceClass;
  subclass?: ConcernEvidenceSubclass;
  path: string;
  range: string;
  value: string;
}

export interface ConcernEvidenceConflict {
  id: string;
  kind: "literal-disagreement" | "declaration-contradiction";
  key: string;
  positions: ConcernEvidenceConflictPosition[];
  verdict: "hold-prepared";
}

export interface ConcernCoverage {
  id: string;
  status: "covered" | "needs-followup";
  handles: string[];
  evidence?: ConcernEvidenceSurface[];
  conflicts?: ConcernEvidenceConflict[];
}

/** A semantic responsibility in an edit-ready task pack. */
export type TaskChangeObligationKind =
  | "definition"
  | "source"
  | "implementation"
  | "integration"
  | "persistence"
  | "presentation"
  | "style"
  | "configuration"
  | "documentation"
  | "verification";

/**
 * One handle-grounded responsibility in a multi-surface change. `review`
 * means the surface is evidence or an upstream source, not an instruction to
 * mutate it blindly.
 */
export interface TaskChangeObligation {
  id: string;
  kind: TaskChangeObligationKind;
  action: "edit" | "review";
  status: "ready" | "needs-context";
  required: boolean;
  handle: string;
  path: string;
  range: string;
  role: ImpactSurface;
  reason?: string;
  confidence?: number;
  depends_on: string[];
}

/** Ordered, edit-ready projection of a task pack's located surfaces. */
export interface TaskChangeContract {
  version: 1;
  status: "ready" | "needs-followup";
  /** True only when the served surfaces close discovery for this task shape. */
  discovery_complete: boolean;
  obligations: TaskChangeObligation[];
  /** Obligation ids grouped into dependency-safe edit stages. */
  stages: string[][];
  missing: string[];
  /** Bounded residual TL calls required before the contract is edit-ready. */
  max_additional_tl_calls: number;
}

export type TaskWiringEvidence =
  | "query-token"
  | "located-surface"
  | "workspace-definition"
  | "project-family"
  | "closure-check"
  | "callable-insertion-site"
  | "receiver-construction-site";

/** Bounded repository evidence used to justify a role without naming conventions. */
export type TaskEvidenceRelationKind = "defines" | "references" | "imports" | "direct_calls";
export type TaskEvidenceRole =
  | "producer"
  | "consumer"
  | "adapter"
  | "insertion"
  | "host"
  | "carrier";

export interface TaskEvidenceNode {
  id: string;
  kind: "file" | "symbol";
  path: string;
  symbol?: string;
  handle: string;
  range: string;
  roles: TaskEvidenceRole[];
}

export interface TaskEvidenceRelation {
  id: string;
  kind: TaskEvidenceRelationKind;
  from: string;
  to: string;
  provenance: "lexical" | "index";
  confidence: number;
}

/** Small, deterministic relation graph over the served wiring frontier. */
export interface TaskEvidenceGraph {
  version: 1;
  nodes: TaskEvidenceNode[];
  relations: TaskEvidenceRelation[];
}

/** A source or destination proven by a reusable handle. */
export interface TaskWiringEndpoint {
  token: string;
  handle: string;
  path: string;
  range: string;
  role: ImpactSurface;
  evidence: TaskWiringEvidence[];
}

/** Compact executable-verification facts. Expectations are never synthesized. */
export interface TaskVerificationRecipe {
  /** Existing edited/test/link files needed by the executable check. */
  compile_targets: string[];
  /** Directory in which the workspace-proven entry must be executed. */
  cwd?: string;
  /** Existing executable entry; omitted when none is workspace-proven. */
  entry?: string;
  /** Existing assertions that reference every required behavior anchor. */
  assertion_refs?: string[];
  /** Workspace-visible prose contracts only; these are not executable proof. */
  contract_refs?: string[];
  /** Existing mock switches only — compact path:line#SYMBOL provenance. */
  mock_controls?: string[];
  /** Honest missing-proof disclosure; never synthesized expected behavior. */
  gaps?: string[];
  /** High confidence is omitted to keep the envelope lean. */
  confidence?: "medium" | "low";
}

/** Same-file structural obligation checked against comment-stripped edited code. */
export interface TaskWiringStructuralCheck {
  id: string;
  description: string;
  handle: string;
  tokens: string[];
}

/** Post-edit proof needed before a constructed receiver can be called complete. */
export interface TaskWiringCompletionProof {
  structural_checks: TaskWiringStructuralCheck[];
  verification?: TaskVerificationRecipe;
}

/** One directional producer-to-consumer connection. */
export interface TaskWiringConnection {
  id: string;
  status: "ready" | "needs-followup";
  /** Whether the selected callable already has a receiver or must be introduced at the certified insertion site. */
  mode?: "existing-receiver" | "construct-receiver";
  /** Concrete invariant clients must preserve while implementing a construction frontier. */
  required_action?: string;
  /** Complete scoped receiver scan supporting a construct-receiver decision. */
  receiver_search?: {
    scope: string;
    files_scanned: number;
    producer_type: string;
    scope_complete: true;
    existing_receiver_found: false;
  };
  /** Existing producer lifecycle callables that may be used at the insertion site. */
  lifecycle_symbols?: string[];
  /** Present only when the selected adapter has no existing consumer call and one must be added at a proven peer-callable site. */
  consumer_call?: {
    mode: "construct";
    adapter_symbol: string;
    insertion_anchor: string;
    /** Exact sibling callable projected from the repository's existing consumer/adapter family. */
    symbol: string;
  };
  /** Structural closure plus honest executable-verification evidence. */
  completion_proof?: TaskWiringCompletionProof;
  source?: TaskWiringEndpoint;
  destination?: TaskWiringEndpoint;
  /** Destination handle at which the connection should be implemented. */
  insertion_handle?: string;
  supporting_handles: string[];
  confidence: number;
  evidence: TaskWiringEvidence[];
  /** Stable relation ids that prove the selected endpoints/insertion site. */
  evidence_ids?: string[];
}

/** Structured wiring bundle produced without requiring an LSP. */
export interface TaskWiringProfile {
  version: 1;
  /** Resolver path used to produce this profile; omitted for legacy direct wiring. */
  strategy?: "semantic-multihop";
  status: "ready" | "needs-followup";
  connections: TaskWiringConnection[];
  missing: Array<"source" | "destination" | "insertion">;
  /** Smallest handle set expected to receive code changes. */
  edit_frontier: string[];
  /** Evidence handles that should be reviewed, not edited by default. */
  review_frontier: string[];
  /** Bounded structural evidence for the selected producer/consumer pair. */
  evidence_graph?: TaskEvidenceGraph;
  /** Why endpoint discovery was not (re)attempted; rides only when no sweep call was emitted. */
  note?: string;
}

/** Generic task shapes understood by task_pack. `auto` is request-only. */
export type TaskProfile =
  | "generic"
  | "answer"
  | "change_propagation"
  | "multi_concern"
  | "artifact_build"
  | "wiring";

/**
 * Caller-declared semantic task shape. `generic` is intentionally accepted:
 * it is the structured way to declare an ordinary code change without
 * forcing the server to recover write intent from natural-language keywords.
 */
export type TaskProfileRequest = "auto" | TaskProfile;

/** Explains how a task profile was selected without trusting heuristics blindly. */
export interface TaskProfileBinding {
  requested: TaskProfileRequest;
  selected: TaskProfile;
  source: "explicit" | "inferred" | "fallback" | "evidence";
  confidence: number;
  reason: string;
}

/** Evidence carried by one readiness obligation. */
export interface TaskReadinessEvidence {
  handle: string;
  path: string;
  range?: string;
  symbol?: string;
}

/** One independently falsifiable requirement extracted from the task. */
export interface TaskReadinessObligation {
  id: string;
  kind:
    | "surface-content"
    | "explicit-identifier"
    | "behavior-body"
    | "change-obligation"
    | "concern"
    | "artifact-source"
    | "wiring-source"
    | "wiring-consumer"
    | "wiring-link"
    | "wiring-insertion";
  status: "proved" | "uncovered";
  required: true;
  /**
   * The surfaces that proved this obligation.
   *
   * OPTIONAL since 2026-08-14. A COMPUTED proof carries it; a re-serve BINDING
   * does not — `contractForEvidenceRetention` already empties it, and an
   * always-`[]` array is the `[]`-for-absence spelling A.8's E-1 rules out.
   * Read it as `evidence ?? []`.
   */
  evidence?: TaskReadinessEvidence[];
  /** Relation ids used by graph-backed obligations; absent for legacy proof shapes. */
  evidence_ids?: string[];
  /**
   * Why this obligation is in the state `status` names.
   *
   * OPTIONAL since 2026-08-14, for the same reason as `evidence`: on a re-serve
   * binding it degenerated to a restatement of `status` ("proved"), and a
   * binding carries identity, not prose.
   */
  reason?: string;
}

/** Bounded negative checks run before a task_pack may claim ready. */
export interface TaskFalsificationReport {
  version: 1;
  checked: string[];
  counterexamples: string[];
  unresolved: string[];
}

/** Selective-prediction decision: reject ready when false-ready risk is too high. */
export interface TaskReadinessRisk {
  policy: "selective-reject";
  estimated_false_ready_risk: number;
  max_false_ready_risk: number;
  decision: "accept" | "reject";
  factors: string[];
}

/** Proof attached to a privileged ready decision. */
export interface TaskReadinessCertificate {
  version: 1;
  id: string;
  task_fingerprint: string;
  /** Workspace evidence state covered by this certificate. */
  workspace_state_fingerprint?: string;
  profile: TaskProfile;
  obligations: TaskReadinessObligation[];
  evidence_handles: string[];
  action_frontier: string[];
  /**
   * The negative checks run before `ready` was claimed.
   *
   * OPTIONAL since 2026-08-14. THE PROOF/BINDING SPLIT: a certificate computed
   * for a fresh pack carries its proof; the copy that travels with a
   * `pack-unchanged` re-serve carries only what re-BINDS the already-installed
   * fence and re-authorises the already-held decision — id, task fingerprint,
   * obligation ids, evidence handles and the action frontier. Neither this nor
   * `risk` is read on that path (the fence reads ids/handles/frontier; the wire
   * projector reads id + obligation ids + the workspace marker), and carrying
   * them made a sub-2KB revalidation receipt pay ~215 bytes to restate a proof
   * the caller already has.
   */
  falsification?: TaskFalsificationReport;
  /** As `falsification`. */
  risk?: TaskReadinessRisk;
}

/** Workspace state against which semantic closure was proved. */
export interface TaskWorkspaceState {
  version: 1;
  fingerprint: string;
  /**
   * `evidence-plus-inventory` invalidates closure when any walked source
   * inventory entry changes. `served-evidence` is the conservative fallback
   * used when a complete bounded inventory is unavailable.
   */
  scope: "served-evidence" | "evidence-plus-inventory";
  evidence_files: number;
  inventory_files: number;
  inventory_complete: boolean;
}

/** One compact, profile-neutral claim in the evidence used for a decision. */
export interface TaskDecisionEvidenceClaim {
  id: string;
  kind: TaskReadinessObligation["kind"];
  status: "supported" | "unresolved";
  reason: string;
  evidence_handles: string[];
  evidence_ids?: string[];
  confidence: number;
}

/** Common evidence projection shared by answer, edit, artifact, and wiring packs. */
export interface TaskDecisionEvidenceModel {
  version: 1;
  decision: "answer" | "edit";
  claims: TaskDecisionEvidenceClaim[];
  counterexamples: string[];
  unresolved: string[];
}

/**
 * Machine-readable reason the MCP cannot yet close the requested action.
 *
 * OB-GAP (A.9.2 rows 15 + 24, discharged in P2 / C2-7b): `kind` was SEVEN
 * values and is now FIVE. `permission-required` and `external-execution-required`
 * are DELETED — the §3.4 E2 pass found zero emitters and zero readers for both,
 * and neither is a `RefusalCode` either, so nothing in this server constructs
 * the concept. The remaining five are exactly `CapabilityGap["code"]`
 * (`mcp/protocol.ts`), so this producer type can no longer express a gap the v1
 * wire has to drop.
 */
export interface TaskCapabilityGap {
  kind:
    | "missing-evidence"
    | "ambiguous-target"
    | "invalid-request"
    | "unsupported-operation"
    | "workspace-changed";
  recoverable: boolean;
  reason: string;
  obligation_ids?: string[];
  next_call?: ContinuationCall;
}

/** Compact semantic-completeness receipt, independent of surface coverage. */
export interface TaskSemanticClosure {
  version: 1;
  state: "closed" | "open" | "awaiting-input";
  closure_id: string;
  obligations_total: number;
  obligations_proved: number;
  unresolved: string[];
}

/** Runtime phase advertised by the contract and enforced at the tool boundary. */
export interface TaskExecutionTypestate {
  phase: "discovery" | "awaiting-input" | "prepared" | "acting" | "verifying" | "done" | "revoked";
  certificate_id?: string;
  allowed_actions: Array<"read" | "search" | "request-user-input" | "answer" | "edit" | "verify" | "challenge">;
  challenge_required_for: Array<"read" | "search" | "edit">;
}

/** Value-of-information policy replacing a fixed discovery-call allowance. */
export interface TaskCallBudget {
  version: 2;
  policy: "expected-decision-change";
  /** Normalized cost of another model/tool round trip. */
  normalized_turn_cost: number;
  /** Probability-like estimate that the proposed call changes answer/edit action. */
  expected_decision_change: number;
  /** Expected decision value after false-ready consequence weighting. */
  expected_value: number;
  /** Calls are allowed only when expected_value exceeds this threshold. */
  decision_threshold: number;
  discovery_allowed: boolean;
  terminal_action: "answer" | "edit";
  candidate_call?: ContinuationCall;
  reason: string;
}

/** Compact stop/continue contract shared by answer and edit task packs. */
export interface TaskExecutionContract {
  version: 1;
  state: "ready" | "needs-followup";
  /** Precise readiness state; unlike surface coverage this is safe as a stop condition. */
  readiness: "edit-ready" | "answer-ready" | "choose-candidate" | "needs-followup";
  discovery_complete: boolean;
  next_action: "answer" | "edit" | "followup" | "request-user-input";
  /** @deprecated Compatibility projection (0/1); call_budget is authoritative. */
  max_additional_discovery_calls: number;
  reason: string;
  /** Proof carried only by an accepted ready decision. */
  readiness_certificate?: TaskReadinessCertificate;
  /** Present on rejected ready candidates so the missing proof is actionable. */
  falsification?: TaskFalsificationReport;
  /** Present on rejected ready candidates; accepted risk lives in the certificate. */
  readiness_risk?: TaskReadinessRisk;
  /** Runtime phase enforced by the MCP server for this workspace/task epoch. */
  typestate: TaskExecutionTypestate;
  /** Value-of-information gate for the candidate follow-up. */
  call_budget?: TaskCallBudget;
  /** Structured replacement for parsing the legacy human-readable `next` string. */
  next_call?: ContinuationCall;
  /** Evidence/workspace state that the current decision is bound to. */
  workspace_state?: TaskWorkspaceState;
  /** Profile-neutral evidence claims supporting the next action. */
  evidence_model?: TaskDecisionEvidenceModel;
  /** Semantic closure receipt; unlike coverage, closed is safe as a stop signal. */
  semantic_closure?: TaskSemanticClosure;
  /** Typed residual capability gaps; absent when semantic closure is closed. */
  capability_gaps?: TaskCapabilityGap[];
  /**
   * protocol v1, A.7.2 / A.9.2 row 21: WHICH awaiting-input branch produced
   * this contract. INTERNAL ONLY — the lean wire projection never emits it; it
   * exists so `decision.await_input.code` is set by the branch that took the
   * decision rather than inferred from `reason` prose downstream. Absent on
   * every non-awaiting-input contract.
   */
  await_input_code?: AwaitInputCode;
}

/**
 * Server-proved edit shortcut for one exact replacement in one existing
 * workspace-bound file. It is guidance only: clients still call edit_file and
 * the server still enforces --allow-write and unique-match at that boundary.
 */
export interface TaskPackSingleSiteUniqueMatchFastPath {
  kind: "single-site-unique-match";
  handle: string;
  path: string;
  search: string;
  replace: string;
  precondition: "unique-match";
  root_bound: true;
  occurrence_count: 1;
  /** Minimal proof identity retained by the compact projection. */
  certificate?: { id: string; sha: string };
  /** Stable task identity used to re-bind this projection. */
  task?: { id: string };
}

export interface ReadCodeTaskPackOutput {
  mode: "task_pack";
  coverage: "complete" | "focused" | "partial";
  coverage_reason?: "single-site" | "candidate-list" | "missing-roles" | "concerns-uncovered" | "diff-truncated";
  surfaces: ReadCodeTaskPackSurface[];
  missing: string[];
  next?: string;
  /** DESIGN-v0.9 §8 multi_concern coverage. */
  concerns?: ConcernCoverage[];
  /** Genuine lexical ties that require a caller choice rather than more search. */
  concern_ambiguities?: Array<{ id: string; candidates: string[] }>;
  /** Classified profile when a specialized task route was selected. */
  task_profile?: Exclude<TaskProfile, "generic">;
  /** Selection provenance, including explicit-hint validation/fallback. */
  profile_binding?: TaskProfileBinding;
  /** Machine-readable stop condition for eliminating post-ready exploration. */
  execution_contract?: TaskExecutionContract;
  /** Additive provenance for a successful pathless locator scope retry. */
  scope_inferred?: { path: string; reason: "pathless-locator-abstain" };
  /** Present only when the server proved a single safe exact replacement. */
  fast_path?: TaskPackSingleSiteUniqueMatchFastPath;
  /** Handle-grounded edit/review responsibilities for multi-surface changes. */
  change_contract?: TaskChangeContract;
  /** Directional producer-to-consumer bundle for wiring tasks. */
  wiring?: TaskWiringProfile;
  /** DESIGN-v0.9 §8 artifact_build inline extraction. */
  section?: ReadCodeArtifactSection;
  /**
   * Behavior 3 (task_pack re-call dedup): true ONLY on the compact response
   * returned when a call exactly re-issued the prior served pack and every
   * surface file is unchanged. Such a response omits code/skeleton/facts —
   * its `surfaces` carry handle/path/range/role only — so the caller reuses
   * the handles it already holds instead of paying for a full re-serialization.
   * Absent on every freshly-computed pack.
   */
  pack_unchanged?: true;
  /**
   * Behavior 3: on a `pack_unchanged` response, the still-open completion
   * checks (≤3, each ≤140 chars) — a compact reminder of what remains before
   * "done" without re-sending the full `checks[]`. Omitted when nothing open.
   */
  checks_open?: string[];
  /**
   * DESIGN-v0.9 §3.1/§4.4 response-level content-completeness ROLLUP, distinct
   * from `coverage`. CONVENTION: emitted ONLY as "partial", OMITTED when every
   * code-bearing surface embedded its full range and nothing was body-stripped
   * (absence = complete). "partial" iff any surface carries
   * content_completeness:"partial".
   */
  content_completeness?: "partial";
  /** Edit-readiness independent of surface coverage. Omitted when sufficient. */
  content_sufficiency?: "needs-followup";
  /**
   * DESIGN-v0.9 §4.3: count of whole surfaces dropped purely for size (the
   * last-resort handle loss after every body was stripped). Omitted when 0.
   */
  surface_drops?: number;
  /**
   * DESIGN-v0.9 §4.6b: internal-execution manifest — one
   * "surface-body:<handle>" entry per code-less surface body the server
   * inlined in this same response (up to the §4.8 must-fetch budget) instead
   * of prompting a `read_file handles=[...]` round trip. Every named handle is
   * verified content-bearing here. Omitted when nothing was inlined.
   */
  inlined?: string[];
  /**
   * DESIGN-v0.9 §5: structured residual-work plan. Emitted ONLY when it adds
   * information beyond the single `next` (>=2 total calls or >=2 stages); a
   * single-step residual ships as `next` alone. `next` is derived from
   * `stages[0].calls[0]` (§5.3), so the two never diverge.
   */
  continuation?: ContinuationPlan;
}

// ---------------------------------------------------------------------------
// read_code mode=closure — cheap final self-check (closure-hardening).
//
// One tiny call answers "what task_pack completion checks are still open?"
// using the SAME scan edit_code closure tracking runs (TL-edited files plus
// git-detected native edits; single-token AND two-token co-occurrence checks).
// Carries no handles and no code — response stays tiny (<600B typical). When
// the session holds no task pack, `complete` is FALSE (FIX-1, 2026-07-09d:
// an affirmative "done" on a session that never registered checks is a
// hollow-completion signal; pinned by the replay corpus) and `note` explains.
// ---------------------------------------------------------------------------
export interface ReadCodeClosureOutput {
  mode: "closure";
  /**
   * Still-open completion-check descriptions (≤8 entries, each ≤140 chars).
   * Shipped as a bare `string[]` — identical shape to the `closure.open`
   * reminder edit_code attaches, so both closure surfaces read the same.
   */
  open: string[];
  /** Count of machine-verifiable checks currently satisfied. */
  done: number;
  /** Total machine-verifiable checks in the session's active pack. */
  total: number;
  /** True when checks exist and none are open; FALSE when no pack (FIX-1). */
  complete: boolean;
  /** Present only when no task pack was recorded this session. */
  note?: string;
  /**
   * DESIGN-v0.9 §6 (WS-P3): compact session summary served instead of bare
   * ceremony on checkless/all-closed closure calls — edited-file ledger data
   * only (`edits`/`files` count distinct edit_file-edited files; native-only
   * writes are invisible to this ledger by construction).
   */
  summary?: { edits: number; files: string[]; checks_closed: number; checks_open: number };
  /**
   * DESIGN-v0.9 §3.1: affirmative completion signal. On closure reads it is
   * present only when checks exist (total>0) and all are closed — never on a
   * checkless session (FIX-1). Its edit-side sibling fires once, on the edit
   * response that closed the last open check.
   */
  closure_complete?: true;
}

// ---------------------------------------------------------------------------
// protocol v1 — `ProfilePlan` and the verification kit (A.6.1).
//
// NORMATIVE SOURCE: DESIGN-v0.10 §10.3 Appendix A (Revision 4, approved
// 2026-08-13), A.6.1. Implements the A.9.1 `task-pack.ts` row: "`ProfilePlan`
// and the evidence/plan substructures it names, unchanged semantics, `version`
// fields dropped (D12), `execution_contract` dissolved into `decision` + `plan`
// (§3.4)."
//
// The substructures above keep their declarations while the pre-v1 emitters
// still read them; `ProfilePlan` is the v1 container and takes each of them
// MINUS its `version` field, expressed as `Omit<…, "version">` so §1.6's rule —
// "removed from the wire; available as a TypeScript literal if a maintainer
// wants the compile-time marker" — is enforced by the type rather than by
// convention.
// ---------------------------------------------------------------------------

/**
 * §3.1: the `plan` contents are the RARE extension — present only when they
 * carry information. Each member is emitted iff it carries information (A.8.2);
 * absence of all five means `plan` itself is absent (A.8 rule E-1).
 *
 * MEMBERSHIP RULE (A.6.1). `plan` is the ONLY container for rare extensions. A
 * future extension lands here, additively (§1.4(a)); it does not become a
 * seventh top-level field (§3.0).
 */
export interface ProfilePlan {
  /** `TaskDecisionEvidenceModel` minus `version` (D12). 0/233 on the wire today
   *  under the lean projection; the guide teaches it, so it is a
   *  `wireEmissionParity` item, not a prune candidate. */
  evidence_model?: Omit<TaskDecisionEvidenceModel, "version">;

  /** `TaskWiringProfile` minus `version` (D12). §3.5 keeps `.strategy` as the
   *  resolver extension point. */
  wiring?: Omit<TaskWiringProfile, "version">;

  /** `ReadCodeArtifactSection[]`, verbatim (it already discriminates on `kind`,
   *  the §1.6 pattern). Rides `plan` when an artifact section is evidence
   *  INSIDE a task pack; a `read.artifact` response carries its sections as its
   *  own required field instead (§4.3). Both are true and they are different
   *  responses. */
  artifact_sections?: ReadCodeArtifactSection[];

  /**
   * S4 (C2-9), 2026-08-14 — the PROVENANCE STAMPS for `artifact_sections`,
   * `["artifact-section:<path>#<sheet-or-slide>", …]`, one per inlined source.
   *
   * Declared here, beside the sections it attests, because the two are one
   * claim and its proof: `artifact_sections` carries the extracted text and
   * this says which source and which selector it came from. Emitted iff >=1
   * section was inlined; absence means nothing was extracted in this response
   * (A.8 rule E-1), never that the extraction is unattributed.
   */
  inlined?: string[];

  /** [P2-OPEN] (A.10 O-b) — §3.0 leaves the placement open. `TaskChangeContract`
   *  minus `version` (D12). Its `obligations[]`/`action` split is what the guide
   *  binds the bounded effect area to, so relocating it must not change what an
   *  agent may edit (§0.2). */
  change_contract?: Omit<TaskChangeContract, "version">;

  /** [P2-OPEN] (A.10 O-a) — §3.0 leaves the placement open, and notes kits ride
   *  edit and closure responses too, not only packs (§4.3 shed step 3).
   *  Deciding whether those copies are the same type or a projection is P2's,
   *  and is NOT decided here. */
  verification?: VerificationKit;
}

/**
 * The verification kit. A.6.1 records that this type had NO declaration in
 * `packages/types` at the P1b HEAD — it lived only in
 * `packages/mcp-server/src/util/verificationPack.ts` as `VerificationManifest`
 * (:194-225), with the `kit_unchanged` + `kit_ref` receipt at :222-224 — and
 * that "P2 names it and moves it". This is that naming and that move,
 * transcribed field-for-field, minus `version: 2` per D12/§1.6.
 *
 * The emitter keeps `VerificationManifest` until the P2 emitter migration
 * re-points it at this declaration.
 */
export interface VerificationKit {
  /** Default strategy; "harness" only when a referencing test exists. */
  verify_strategy: "syntax_only+diff" | "harness";
  surfaces: VerificationSurface[];
  compile_facts: CompileFact[];
  link_set: LinkSetEntry[];
  omitted: number;
  /** Build-command mining + mock-header inventory — omitted when neither yields anything. */
  harness?: HarnessInfo;
  /** Local compiler/build-entry/test-entry facts — omitted for non-native, non-compile-fact edits. */
  toolchain?: ToolchainInfo;
  /** Provenance-only execution recipe; additive to harness/toolchain, never an oracle. */
  recipe?: TaskVerificationRecipe;
  /** Repo paths some OTHER kit field NAMES — `toolchain.build_entry`,
   *  `harness.build_command.source`, recipe refs — that carry no body anywhere
   *  else, paired with a handle so the same batched call can serve them. Never
   *  a path already in context. */
  named_paths?: Array<{ path: string; handle: string; named_by: string }>;
  note: string;
  /** True when this exact kit content already rode the immediately-preceding
   *  call for this workspace root — every other field collapses to its cheapest
   *  form and `kit_ref` names the unchanged content. On a `read.receipt`
   *  response the same fact is the `kit-unchanged` receipt (A.4). */
  kit_unchanged?: true;
  /** Present exactly when `kit_unchanged` is true: sha12 of the repeated kit. */
  kit_ref?: string;
}

/**
 * Body-availability marker. ONE marker for both meanings read as "never served"
 * and drove native re-reads (2026-07-31 verify-kit-gap forensics), so the two
 * are distinct: `omitted` = NOT served (not empty); `served-earlier` = already
 * in context, so a re-fetch buys nothing.
 */
export type BodyMarker = "omitted" | "served-earlier";

/** util/verificationPack.ts:35-52. */
export interface VerificationSurface {
  path: string;
  role: "test" | "mock";
  bytes: number;
  /** Edited rel paths this file references (by basename or stem token). */
  references: string[];
  handle: string;
  /** Whole-file body — TEST files only (a mock body conflicts with real headers). */
  code?: string;
  /** Present exactly when `code` is absent: slice the body via `handle`. */
  body?: BodyMarker;
  content_completeness?: "partial";
  /** Mocks ride handle-only with an explicit scope warning. */
  scope_note?: string;
}

/** util/verificationPack.ts:57-66. */
export interface CompileFact {
  path: string;
  /** Workspace headers defining identifiers this file uses but never includes. */
  missing_includes: string[];
  /** Server-attached handles for `missing_includes` — the same batched
   *  verification call serves them. */
  missing_include_handles?: Array<{ path: string; handle: string }>;
  /** Exact, bounded one-line extern declarations needed when constructing a standalone harness. */
  extern_declarations?: string[];
  note: string;
}

/** util/verificationPack.ts:68-78. */
export interface LinkSetEntry {
  path: string;
  bytes: number;
  reason: string;
  handle: string;
  /** Whole-file body — inlined within the shared verification-kit budget. */
  code?: string;
  /** Present exactly when `code` is absent: slice the body via `handle`. */
  body?: BodyMarker;
}

/** A mock header the harness must satisfy — always sliceable through `handle`.
 *  util/verificationPack.ts:80-97. */
export interface MockHeaderEntry {
  path: string;
  bytes: number;
  handle: string;
  /** Whole-file body — exempt from the per-file cap (see kitBudgetAllocator). */
  code?: string;
  /** Present exactly when `code` is absent: slice the body via `handle`. */
  body?: BodyMarker;
  note: string;
}

/** util/verificationPack.ts:99-172. */
export interface HarnessInfo {
  build_command?: { text: string; source: string; cwd?: string };
  build_command_synthesized?: true;
  entrypoint_commands?: Array<{ text: string; source: string; entrypoint: string }>;
  link_candidates?: {
    paths: string[];
    validated: false;
    reason: "no-compiler-on-host" | "sources-exceed-command-budget" | "every-source-owns-an-entrypoint";
    note: string;
  };
  create_note?: string;
  /** Native mock headers (.h/.hpp/.hh/.hxx) in an edited file's project root —
   *  handle always, body within the kit budget. */
  mock_headers?: MockHeaderEntry[];
}

/** util/verificationPack.ts:174-192. */
export interface ToolchainInfo {
  cxx?: string;
  cc?: string;
  python3?: boolean;
  build_entry?: string;
  build_entry_absent?: boolean;
  test_entry?: string;
  /** node only: directory whose package.json declared `scripts.test` ("" = workspace root). */
  test_entry_dir?: string;
  /** node: `<test_entry_dir>/node_modules` exists; python: a venv runner exists. */
  deps_installed?: boolean;
  /** Present exactly when `deps_installed === false`. */
  verify_note?: string;
}
