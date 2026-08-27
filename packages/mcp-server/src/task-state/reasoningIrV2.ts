// ---------------------------------------------------------------------------
// reasoningIrV2.ts — the Task Reasoning IR v2 projection (v0.11, V11-04).
//
// A SIBLING OF v1, NOT A REWRITE. `reasoningIr.ts`'s `projectTaskReasoningIR()`
// is untouched and stays unwired: v1 remains the frozen v0.10 artifact its own
// spec pins. Everything here is new code over the same input (`TaskPackResult`)
// producing the new `TaskReasoningIRv2` state.
//
// PURE, exactly like v1: this module reads ONLY the pack result, the caller's
// options, and any prior state it is handed. No store, no session, no
// filesystem, no clock, no mutation of the input. Persistence is `irStore.ts`;
// dispatch is `irDispatchSeam.ts`.
//
// WHAT v2 ADDS OVER v1's FLAT PROJECTION:
//   * STABLE EVIDENCE IDS. v1 mints `e1, e2, …` positionally, so the same file
//     gets a different id in the next pack and cross-pack accumulation is
//     impossible. v2 mints a content-derived id (uri + range + symbol + sha),
//     which is what lets a second pack of the SAME task produce a small delta
//     instead of a whole new state.
//   * DEPENDENCY EDGES from `change_contract.obligations[].depends_on` — the
//     pack already computes that ordering; v2 stops throwing it away.
//   * ORIGIN + ADVISORY. Capability gaps are heuristic, therefore advisory,
//     therefore incapable of blocking a real obligation.
//   * PREDICATES. Every node states the evidence condition that closes it, so
//     `canClose` has something to check.
//   * TOMBSTONES carried across packs, swept against live validity keys first.
//
// CAPS. v1's posture is kept and extended (v1: goal 480 / obligations 32 /
// allowedNext 6 / constraints 8) — the projection ENFORCES them rather than
// documenting them, because IR state is persisted and an unbounded projection
// would grow a workspace store without limit.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type {
  EvidenceId,
  EvidenceIdentity,
  EvidenceRole,
  EvidenceUse,
  ObligationNode,
  ReasoningDeltaOp,
  TaskReasoningIRv2,
  ValidityKey,
} from "@tokenlighten/types";
import type { TaskPackResult, TaskPackSurface } from "../features/task-pack/model.js";
import { deriveCanonicalTaskDecision } from "../features/task-pack/canonicalDecision.js";
import {
  buildObligationDag,
  canClose,
  deriveDagEnabled,
  isLocalTaskShape,
  OBLIGATION_DEPENDENCIES_MAX,
  type ObligationClosureState,
} from "./obligationDag.js";
import { computeTaskStateHash, REASONING_DELTA_OPS_MAX } from "./reasoningDelta.js";
import { sweepStaleTombstones } from "./tombstone.js";

// ---------------------------------------------------------------------------
// Caps (v1 posture, extended for the persisted v2 state)
// ---------------------------------------------------------------------------

export const IRV2_GOAL_MAX_CHARS = 480;
export const IRV2_CLAIM_MAX_CHARS = 200;
export const IRV2_OBLIGATIONS_MAX = 32;
export const IRV2_EVIDENCE_MAX = 64;
export const IRV2_USES_MAX = 64;
export const IRV2_ALLOWED_NEXT_MAX = 6;
export const IRV2_CONSTRAINTS_MAX = 8;
export const IRV2_TOMBSTONES_MAX = 32;
export const IRV2_INVALIDATION_KEYS_MAX = 96;

export interface ProjectReasoningIrV2Input {
  /** A completed buildTaskPack result (any coverage/decision shape). */
  result: TaskPackResult;
  /** Stable task identity. Never the volatile wire handle — see v1's note. */
  taskId?: string;
  /** The task query text, when the caller still holds it (goal source). */
  query?: string;
  /** Lane isolation key; "" is the shared default lane. */
  lane?: string;
  /** Prior IR state for this (task, lane); tombstones and closures carry over. */
  prior?: TaskReasoningIRv2;
  /** Live invalidation keys for the tombstone sweep; defaults to the pack's own. */
  liveValidityKeys?: readonly ValidityKey[];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** An empty, well-formed IR v2 state — the fail-closed "no prior state" value. */
export function emptyIrV2State(taskRef: string, lane: string): TaskReasoningIRv2 {
  const base: TaskReasoningIRv2 = {
    irVersion: 2,
    taskRef,
    lane,
    stateVersion: 0,
    stateHash: "",
    goal: "",
    constraints: [],
    evidenceCatalog: [],
    evidenceUses: [],
    obligations: [],
    decision: { state: "pending", evidenceRefs: [] },
    tombstones: [],
    allowedNext: [],
    invalidationKeys: [],
    appliedDeltaIds: [],
    dagEnabled: false,
  };
  return { ...base, stateHash: computeTaskStateHash(base) };
}

/**
 * Project a pack result into a complete IR v2 state. When `prior` is supplied
 * the projection is CUMULATIVE — prior evidence, closures and tombstones are
 * carried forward — because a re-pack of the same task narrows the view, it
 * does not retract what was already established.
 */
export function projectTaskReasoningIrV2(input: ProjectReasoningIrV2Input): TaskReasoningIRv2 {
  const { result } = input;
  const lane = input.lane ?? "";
  const taskRef = input.taskId ?? result.qref ?? "task";

  // --- evidence catalog: one identity per served surface, grounded only -----
  const evidenceCatalog: EvidenceIdentity[] = [];
  const evidenceIdByHandle = new Map<string, EvidenceId>();
  const seenEvidence = new Set<EvidenceId>();
  for (const surface of result.surfaces ?? []) {
    const evidenceId = stableEvidenceId(surface);
    evidenceIdByHandle.set(surface.handle, evidenceId);
    if (seenEvidence.has(evidenceId)) continue;
    seenEvidence.add(evidenceId);
    evidenceCatalog.push(evidenceIdentityOf(surface, evidenceId));
  }

  // --- obligation nodes ----------------------------------------------------
  const evidenceUses: EvidenceUse[] = [];
  const nodes: ObligationNode[] = [];
  const contract = result.change_contract;
  const contractIds = new Set((contract?.obligations ?? []).map((o) => `pack:${o.id}`));

  for (const o of contract?.obligations ?? []) {
    const evidenceId = evidenceIdByHandle.get(o.handle);
    const refs = evidenceId === undefined ? [] : [evidenceId];
    // A `needs-context` obligation is BLOCKED, not open: the pack itself says
    // the evidence to discharge it has not been served.
    const state = o.status === "needs-context" ? "blocked" : "open";
    // Edges the pack already computed. Unknown ids (an obligation the pack
    // trimmed) are dropped here rather than refused: a dangling edge would
    // block closure forever, and the pack's trim is not a dependency claim.
    const blockedBy = o.depends_on
      .map((dep) => `pack:${dep}`)
      .filter((dep) => contractIds.has(dep))
      .slice(0, OBLIGATION_DEPENDENCIES_MAX);
    nodes.push({
      id: `pack:${o.id}`,
      claim: `${o.action} ${o.path}:${o.range}${o.reason === undefined ? "" : ` (${o.reason})`}`.slice(0, IRV2_CLAIM_MAX_CHARS),
      state,
      evidenceRefs: refs,
      origin: o.required ? "source-requirement" : "direct-evidence",
      advisory: false,
      blockedBy,
      predicate: { kind: "any-grounded-evidence" },
    });
    if (evidenceId !== undefined) {
      evidenceUses.push({
        taskRef: "task",
        evidenceId,
        roles: [roleOf(o.role)],
        obligationIds: [`pack:${o.id}`],
        required: o.required,
      });
    }
  }

  // Existing checks: the pack's own per-concern coverage claims.
  for (const concern of result.concerns ?? []) {
    const refs = (concern.handles ?? [])
      .map((h: string) => evidenceIdByHandle.get(h))
      .filter((x): x is EvidenceId => x !== undefined);
    nodes.push({
      id: `concern:${concern.id}`,
      claim: `concern ${concern.id} covered by served surfaces`.slice(0, IRV2_CLAIM_MAX_CHARS),
      state: "open",
      evidenceRefs: refs,
      origin: "existing-check",
      advisory: false,
      blockedBy: [],
      predicate: { kind: "any-grounded-evidence" },
    });
  }

  // Capability gaps are HEURISTIC and therefore advisory: they can never block
  // a real obligation, and they can never be closed by an evidence count.
  for (const gap of result.execution_contract?.capability_gaps ?? []) {
    const g = gap as { kind?: string; reason?: string };
    const claim = (g.reason ?? g.kind ?? "unresolved capability gap").slice(0, IRV2_CLAIM_MAX_CHARS);
    nodes.push({
      id: `gap:${shortHash(claim)}`,
      claim,
      state: "open",
      evidenceRefs: [],
      origin: "heuristic",
      advisory: true,
      blockedBy: [],
      predicate: { kind: "manual" },
    });
  }

  // --- DAG or flat list ----------------------------------------------------
  const siteCount = new Set((result.surfaces ?? []).map((s) => s.path)).size;
  const capped = capObligations(nodes);
  const dag = buildObligationDag({ nodes: capped, siteCount });
  // A refusal here is a malformed edge set from the pack (a cycle it computed,
  // or a duplicate id). ADVISORY POSTURE: degrade to a flat list rather than
  // failing the projection — v2 must never turn a pack defect into lost state.
  const obligations = dag.ok ? dag.nodes : capped.map((n) => ({ ...n, blockedBy: [] }));

  // --- decision ------------------------------------------------------------
  // `deriveCanonicalTaskDecision` reads into `execution_contract.typestate`
  // without guarding it: a partially-shaped contract (a hand-built pack, or a
  // future field reordering) throws. A projection must stay TOTAL — an
  // underivable decision is `pending`, which is exactly what "we do not know
  // yet" means — so the throw is absorbed rather than propagated to a caller
  // that only wanted advisory state.
  const canonical = safeCanonicalDecision(result);
  const decisionState: TaskReasoningIRv2["decision"]["state"] =
    canonical === undefined ? "pending"
      : canonical.kind === "act-answer" || canonical.kind === "act-edit" ? "prepared"
        : canonical.kind === "terminal-closed" ? "done"
          : "pending";
  const decisionRefs = decisionState === "prepared"
    ? obligations.flatMap((o) => o.evidenceRefs).slice(0, 8)
    : [];

  // --- allowedNext / constraints / invalidation keys ------------------------
  const allowedNext: TaskReasoningIRv2["allowedNext"] = [];
  if (result.route !== undefined) {
    const tool = result.route.action === "edit_from_handles" ? "edit_file"
      : result.route.action === "locate_missing_surfaces" ? "search_files"
        : "read_file";
    allowedNext.push({ tool, reason: result.route.action });
  }
  if (result.next !== undefined && canonical?.kind === "discover") {
    allowedNext.push({ tool: "read_file", reason: "continue-discovery" });
  }

  const constraints: TaskReasoningIRv2["constraints"] = [];
  if (result.profile_binding !== undefined) {
    constraints.push({
      id: "profile-binding",
      text: `profile=${result.profile_binding.selected} source=${result.profile_binding.source}`,
      source: "repository",
    });
  }
  if (result.task_profile !== undefined) {
    constraints.push({ id: "task-profile", text: `task_profile=${result.task_profile}`, source: "repository" });
  }

  const invalidationKeys: ValidityKey[] = [];
  if (result.qref !== undefined) invalidationKeys.push({ type: "qref", value: result.qref });
  for (const e of evidenceCatalog) {
    const key = e.validityKeys[0];
    if (key !== undefined) invalidationKeys.push(key);
  }

  // --- tombstones: swept against live keys BEFORE they are carried forward --
  const liveKeys = input.liveValidityKeys ?? invalidationKeys;
  const carriedTombstones = input.prior === undefined
    ? []
    : sweepStaleTombstones(input.prior.tombstones, liveKeys).live.slice(0, IRV2_TOMBSTONES_MAX);

  const merged = mergeWithPrior(
    {
      evidenceCatalog: evidenceCatalog.slice(0, IRV2_EVIDENCE_MAX),
      evidenceUses: evidenceUses.slice(0, IRV2_USES_MAX),
      obligations,
    },
    input.prior,
  );

  const state: TaskReasoningIRv2 = {
    irVersion: 2,
    taskRef,
    lane,
    stateVersion: input.prior === undefined ? 1 : input.prior.stateVersion,
    stateHash: "",
    goal: (input.query ?? result.qref ?? "").slice(0, IRV2_GOAL_MAX_CHARS),
    constraints: constraints.slice(0, IRV2_CONSTRAINTS_MAX),
    evidenceCatalog: merged.evidenceCatalog,
    evidenceUses: merged.evidenceUses,
    obligations: merged.obligations,
    decision: { state: decisionState, evidenceRefs: decisionRefs },
    tombstones: carriedTombstones,
    allowedNext: allowedNext.slice(0, IRV2_ALLOWED_NEXT_MAX),
    invalidationKeys: invalidationKeys.slice(0, IRV2_INVALIDATION_KEYS_MAX),
    appliedDeltaIds: input.prior === undefined ? [] : [...input.prior.appliedDeltaIds],
    dagEnabled: deriveDagEnabled(merged.obligations),
  };
  return { ...state, stateHash: computeTaskStateHash(state) };
}

interface MergeParts {
  evidenceCatalog: EvidenceIdentity[];
  evidenceUses: EvidenceUse[];
  obligations: ObligationNode[];
}

/**
 * Prior first, new second: a closed obligation stays closed, an already-known
 * evidence identity keeps its original entry, and only genuinely new material
 * is appended. Caps are applied to the UNION, so accumulation stays bounded.
 */
function mergeWithPrior(next: MergeParts, prior: TaskReasoningIRv2 | undefined): MergeParts {
  if (prior === undefined) return next;

  const evidenceCatalog = [...prior.evidenceCatalog];
  const knownEvidence = new Set(evidenceCatalog.map((e) => e.evidenceId));
  for (const e of next.evidenceCatalog) {
    if (knownEvidence.has(e.evidenceId) || evidenceCatalog.length >= IRV2_EVIDENCE_MAX) continue;
    knownEvidence.add(e.evidenceId);
    evidenceCatalog.push(e);
  }

  const evidenceUses = [...prior.evidenceUses];
  const knownUses = new Set(evidenceUses.map(useKey));
  for (const u of next.evidenceUses) {
    if (knownUses.has(useKey(u)) || evidenceUses.length >= IRV2_USES_MAX) continue;
    knownUses.add(useKey(u));
    evidenceUses.push(u);
  }

  const obligations = [...prior.obligations];
  const knownObligations = new Set(obligations.map((o) => o.id));
  for (const o of next.obligations) {
    if (knownObligations.has(o.id) || obligations.length >= IRV2_OBLIGATIONS_MAX) continue;
    knownObligations.add(o.id);
    obligations.push(o);
  }

  return { evidenceCatalog, evidenceUses, obligations };
}

function useKey(u: EvidenceUse): string {
  return `${u.evidenceId}|${u.obligationIds.join(",")}|${u.roles.join(",")}`;
}

/** Blocked/open before satisfied, stable order within groups (v1's cap policy). */
function capObligations(nodes: readonly ObligationNode[]): ObligationNode[] {
  const rank = (s: string): number => (s === "blocked" ? 0 : s === "open" ? 1 : s === "invalidated" ? 2 : 3);
  return nodes
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o.state) - rank(b.o.state) || a.i - b.i)
    .slice(0, IRV2_OBLIGATIONS_MAX)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.o);
}

// ---------------------------------------------------------------------------
// Incremental projection — prior state + new pack => ops
// ---------------------------------------------------------------------------

/**
 * The ops that carry `prior` forward to `projected`. ADDITIVE ONLY: a re-pack
 * narrows the served view, it does not retract established evidence, so nothing
 * here removes or invalidates. Returns an empty array when the pack established
 * nothing new — the seam then writes no delta at all.
 */
export function deriveProjectionOps(
  prior: TaskReasoningIRv2,
  projected: TaskReasoningIRv2,
): ReasoningDeltaOp[] {
  const ops: ReasoningDeltaOp[] = [];
  const knownEvidence = new Set(prior.evidenceCatalog.map((e) => e.evidenceId));
  for (const e of projected.evidenceCatalog) {
    if (knownEvidence.has(e.evidenceId)) continue;
    if (prior.evidenceCatalog.length + ops.length >= IRV2_EVIDENCE_MAX) break;
    ops.push({ op: "add", target: "evidence", evidence: e });
  }

  const knownUses = new Set(prior.evidenceUses.map(useKey));
  for (const u of projected.evidenceUses) {
    if (knownUses.has(useKey(u))) continue;
    ops.push({ op: "add", target: "use", use: u });
  }

  const knownObligations = new Set(prior.obligations.map((o) => o.id));
  for (const o of projected.obligations) {
    if (knownObligations.has(o.id)) continue;
    if (prior.obligations.length >= IRV2_OBLIGATIONS_MAX) break;
    // Edges pointing at obligations the prior state never learned would be
    // dangling; drop them rather than refuse the whole delta.
    const blockedBy = o.blockedBy.filter((dep) => knownObligations.has(dep) || projected.obligations.some((p) => p.id === dep));
    ops.push({ op: "add", target: "obligation", obligation: { ...o, blockedBy } });
    knownObligations.add(o.id);
  }

  const knownTombstones = new Set(prior.tombstones.map((t) => t.id));
  for (const t of projected.tombstones) {
    if (knownTombstones.has(t.id)) continue;
    ops.push({ op: "add", target: "tombstone", tombstone: t });
  }

  if (
    prior.decision.state !== projected.decision.state
    || prior.decision.evidenceRefs.join(",") !== projected.decision.evidenceRefs.join(",")
  ) {
    ops.push({ op: "update", target: "decision", decision: projected.decision });
  }

  return ops.slice(0, REASONING_DELTA_OPS_MAX);
}

/** Tombstones dropped by the staleness sweep — the seam turns these into `invalidate` ops. */
export function staleTombstoneOps(
  prior: TaskReasoningIRv2,
  liveKeys: readonly ValidityKey[],
): ReasoningDeltaOp[] {
  const swept = sweepStaleTombstones(prior.tombstones, liveKeys);
  return swept.invalidated.map((entry) => ({
    op: "invalidate" as const,
    target: "tombstone" as const,
    id: entry.id,
    reason: `${entry.cause}:${entry.key.type}`,
  }));
}

/**
 * A1-pre (DESIGN-v0.12-plan.md §2, 柱A row A1-pre). The ONE producer of
 * `close` ops anywhere in v2: `deriveProjectionOps` above never emits one — a
 * re-served surface is not proof anything changed, so a pack re-read must
 * never promote an obligation. `editedPaths` is the opposite kind of fact: it
 * names paths the server ITSELF just wrote (edit_file's own `editedPathsOf`
 * accounting, threaded in by the caller), so this is the only producer
 * allowed to ask `canClose` on `prior`'s behalf.
 *
 * canClose is STILL the only gate. This function decides WHICH nodes get
 * asked — open, non-advisory, and grounded in evidence whose source URI is
 * one of `editedPaths` — never whether the answer is yes: a node `canClose`
 * rejects (an unmet dependency, a `manual` predicate, an invalidated node)
 * stays open, exactly as if nothing had asked. "False satisfied 0" is
 * therefore a property of `canClose` alone, inherited unchanged; this
 * function cannot weaken it, only choose not to ask.
 *
 * FIXED-POINT, not one pass: closing one obligation can unblock a dependent
 * in the SAME edit (a batch `edits[]` call landing both stages of a two-file
 * change at once), so candidates are re-tried against the just-updated draft
 * until a full pass closes nothing new. Bounded by `IRV2_OBLIGATIONS_MAX`, so
 * the loop is not an unbounded-growth risk.
 */
export function deriveEditClosureOps(
  prior: TaskReasoningIRv2,
  editedPaths: readonly string[],
): ReasoningDeltaOp[] {
  if (editedPaths.length === 0 || prior.obligations.length === 0) return [];
  const editedSet = new Set(editedPaths);
  const uriOf = new Map(prior.evidenceCatalog.map((e) => [e.evidenceId, e.source.uri] as const));

  const touchesAnEditedPath = (o: ObligationNode): boolean =>
    o.evidenceRefs.some((ref) => {
      const uri = uriOf.get(ref);
      return uri !== undefined && editedSet.has(uri);
    });

  const candidateIds = new Set(
    prior.obligations
      .filter((o) => !o.advisory && o.state === "open" && touchesAnEditedPath(o))
      .map((o) => o.id),
  );
  if (candidateIds.size === 0) return [];

  // A private draft, mutated in place as candidates close — never `prior`
  // itself (this module never mutates its input, matching every other
  // exported function here).
  const draft = prior.obligations.map((o) => ({ ...o, evidenceRefs: [...o.evidenceRefs], blockedBy: [...o.blockedBy] }));
  const view: ObligationClosureState = { obligations: draft, evidenceCatalog: prior.evidenceCatalog };
  const closedIds: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const id of candidateIds) {
      const node = draft.find((o) => o.id === id);
      if (node === undefined || node.state !== "open") continue;
      if (canClose(id, view).ok) {
        node.state = "satisfied";
        closedIds.push(id);
        progressed = true;
      }
    }
  }
  return closedIds.map((id) => ({ op: "close" as const, target: "obligation" as const, id }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A CONTENT-derived evidence id. v1's positional `e1, e2, …` cannot survive a
 * second pack; this one can, which is the whole basis of delta accumulation.
 */
function stableEvidenceId(surface: TaskPackSurface): EvidenceId {
  return `e${shortHash(`${surface.path}|${surface.range}|${surface.symbol ?? ""}|${surface.sha ?? ""}`)}`;
}

function shortHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 10);
}

function evidenceIdentityOf(surface: TaskPackSurface, evidenceId: EvidenceId): EvidenceIdentity {
  const lineRange = parseRange(surface.range);
  return {
    evidenceId,
    source: {
      kind: "file",
      uri: surface.path,
      // Never fabricate a hash: a surface with no sha is STRUCTURAL evidence,
      // and structural evidence still cannot prove an absence.
      contentHash: surface.sha ?? "",
    },
    ...(lineRange === undefined && surface.symbol === undefined
      ? {}
      : {
          locator: {
            ...(lineRange === undefined ? {} : { lineRange }),
            ...(surface.symbol === undefined ? {} : { symbol: { id: surface.symbol, name: surface.symbol, kind: "unknown" } }),
          },
        }),
    evidenceClass: surface.sha !== undefined ? "direct" : "structural",
    validityKeys: surface.sha !== undefined ? [{ type: "file-sha", value: `${surface.path}@${surface.sha}` }] : [],
  };
}

function parseRange(range: string | undefined): { startLine: number; endLine: number } | undefined {
  if (range === undefined) return undefined;
  const m = /^(\d+)-(\d+)$/.exec(range);
  if (m === null) return undefined;
  return { startLine: Number(m[1]), endLine: Number(m[2]) };
}

/** See the call site: an underivable canonical decision degrades to `pending`. */
function safeCanonicalDecision(result: TaskPackResult): ReturnType<typeof deriveCanonicalTaskDecision> {
  try {
    return deriveCanonicalTaskDecision(result);
  } catch {
    return undefined;
  }
}

/** ImpactSurface (wire) → EvidenceRole (domain) — same conservative mapping as v1. */
function roleOf(surfaceRole: string | undefined): EvidenceRole {
  switch (surfaceRole) {
    case "definition": return "definition";
    case "consumer": return "consumer";
    case "test": return "test";
    case "config": return "config";
    case "build": return "build";
    case "doc": return "doc";
    default: return "target";
  }
}

/** Re-exported so callers need one import for the local-task rule. */
export { isLocalTaskShape };
