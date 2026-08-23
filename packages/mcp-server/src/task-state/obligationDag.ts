// ---------------------------------------------------------------------------
// obligationDag.ts — Task Reasoning IR v2 obligation graph (v0.11, V11-04).
//
// DESIGN-v0.10-expansion-plan-v1.3.md §7 V11-04 ("flat obligationを依存edge付き
// DAGへ拡張する", "nodeはsource requirement／direct evidence／既存checkから生成し、
// heuristic nodeはadvisoryにする", "closureはEvidence predicateを満たしたときだけ
// 行う", "1〜2箇所の局所taskではDAGを生成しない"); reconciliation §3 row V11-04
// and its common rule that heuristic evidence never closes an obligation.
//
// PURE. No store, no clock, no filesystem, no mutation of any input — every
// exported function returns fresh values. The persistence and dispatch seams
// live in `irStore.ts` / `irDispatchSeam.ts`.
//
// THE CLOSURE GATE IS ONE FUNCTION. `canClose()` is the ONLY way a node
// reaches `"satisfied"`: `reasoningDelta.ts`'s `close`/`update` ops route
// through it, so "invalid obligation closure" is structurally unreachable
// rather than review-enforced. Three independent conditions must ALL hold:
//   1. the node exists and is not invalidated;
//   2. every BLOCKING dependency has closed — where an ADVISORY (heuristic-
//      origin) dependency never blocks a non-advisory node, so a guessed edge
//      can slow nothing down;
//   3. the node's evidence predicate is satisfied by GROUNDED evidence only
//      (`evidenceClass !== "heuristic"`), which is the repo-wide rule that
//      heuristic evidence closes nothing.
// ---------------------------------------------------------------------------

import type {
  EvidenceIdentity,
  EvidenceId,
  ObligationNode,
  ObligationOrigin,
} from "@tokenlighten/types";

// ---------------------------------------------------------------------------
// Caps and local-task policy
// ---------------------------------------------------------------------------

/** Plan §7: "1〜2箇所の局所taskではDAGを生成しない" — the site half of that rule. */
export const LOCAL_TASK_MAX_SITES = 2;

/** …and the obligation half. Both must hold for a task to count as local. */
export const LOCAL_TASK_MAX_OBLIGATIONS = 2;

/** Per-node dependency fan-in cap; edges past it are dropped, never truncated silently mid-apply. */
export const OBLIGATION_DEPENDENCIES_MAX = 8;

/** Bounded hint list handed to the E-7 packer/retrieval seam. */
export const OPEN_OBLIGATION_HINTS_MAX = 16;

/**
 * A task is LOCAL when it is small in BOTH dimensions. A local task gets a
 * flat v1-style obligation list: no dependency edges are generated at all, so
 * v2 cannot invent sequencing work for a one-site change.
 */
export function isLocalTaskShape(siteCount: number, obligationCount: number): boolean {
  return siteCount <= LOCAL_TASK_MAX_SITES && obligationCount <= LOCAL_TASK_MAX_OBLIGATIONS;
}

/** True iff this origin may never close an obligation or block a non-advisory node. */
export function isAdvisoryOrigin(origin: ObligationOrigin): boolean {
  return origin === "heuristic";
}

/** Re-derive a node with `advisory` forced from `origin` and its edges bounded. */
export function normalizeObligationNode(node: ObligationNode): ObligationNode {
  return normalizeNode(node, node.blockedBy.slice(0, OBLIGATION_DEPENDENCIES_MAX));
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export interface DagRefusal {
  ok: false;
  reason: "duplicate-node" | "unknown-dependency" | "self-dependency" | "cyclic-dependency";
  detail: string;
  /** Present for `cyclic-dependency`: the node ids on the detected cycle. */
  cycle?: string[];
}

export type DagBuildResult =
  | { ok: true; nodes: ObligationNode[]; dagEnabled: boolean }
  | DagRefusal;

/**
 * Structural validation of an obligation set's dependency edges: duplicate
 * ids, self-edges, dangling edges, and cycles. Returns the refusal, or
 * `undefined` when the edge set is a legal DAG.
 *
 * Exported because `reasoningDelta.ts` must re-run it after EVERY op that adds
 * or repoints an edge — a cycle introduced by a delta is refused with the same
 * verdict a cycle present at construction gets, so there is exactly one place
 * that decides what "acyclic" means.
 */
export function validateObligationEdges(nodes: readonly ObligationNode[]): DagRefusal | undefined {
  const byId = new Map<string, ObligationNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) {
      return { ok: false, reason: "duplicate-node", detail: `obligation id repeated: ${node.id}` };
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dep of node.blockedBy) {
      if (dep === node.id) {
        return { ok: false, reason: "self-dependency", detail: `${node.id} depends on itself` };
      }
      if (!byId.has(dep)) {
        return { ok: false, reason: "unknown-dependency", detail: `${node.id} depends on unknown ${dep}` };
      }
    }
  }
  const cycle = findCycle(nodes, byId);
  if (cycle !== undefined) {
    return { ok: false, reason: "cyclic-dependency", detail: `dependency cycle: ${cycle.join(" -> ")}`, cycle };
  }
  return undefined;
}

export interface BuildObligationDagInput {
  nodes: readonly ObligationNode[];
  /** Distinct edit/review SITES the pack located — the other half of the local-task rule. */
  siteCount: number;
}

/**
 * Validate and normalize an obligation set into a DAG (or a flat list for a
 * local task). A cyclic edge set is REFUSED here, at construction, so no
 * downstream consumer ever has to defend against a cycle: `canClose()` may
 * therefore assume acyclicity and still terminate on hand-built state because
 * it only inspects DIRECT dependencies.
 */
export function buildObligationDag(input: BuildObligationDagInput): DagBuildResult {
  const invalid = validateObligationEdges(input.nodes);
  if (invalid !== undefined) return invalid;

  if (isLocalTaskShape(input.siteCount, input.nodes.length)) {
    // Flat v1-style passthrough: edges are DROPPED, not merely ignored, so the
    // persisted state cannot later be re-read as a DAG.
    return {
      ok: true,
      dagEnabled: false,
      nodes: input.nodes.map((n) => normalizeNode(n, [])),
    };
  }

  return {
    ok: true,
    dagEnabled: true,
    nodes: input.nodes.map((n) => normalizeNode(n, n.blockedBy.slice(0, OBLIGATION_DEPENDENCIES_MAX))),
  };
}

function normalizeNode(node: ObligationNode, blockedBy: string[]): ObligationNode {
  return {
    id: node.id,
    claim: node.claim,
    state: node.state,
    evidenceRefs: [...node.evidenceRefs],
    origin: node.origin,
    // `advisory` is DERIVED, never trusted from the input: a caller cannot
    // launder a heuristic node into a blocking one by setting the flag.
    advisory: isAdvisoryOrigin(node.origin),
    blockedBy: [...blockedBy],
    predicate: node.predicate,
  };
}

/** Iterative DFS colouring; returns the ids on the first cycle found. */
function findCycle(
  nodes: readonly ObligationNode[],
  byId: ReadonlyMap<string, ObligationNode>,
): string[] | undefined {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const n of nodes) colour.set(n.id, WHITE);

  for (const root of nodes) {
    if (colour.get(root.id) !== WHITE) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: root.id, next: 0 }];
    colour.set(root.id, GREY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const node = byId.get(top.id);
      const deps = node === undefined ? [] : node.blockedBy;
      if (top.next >= deps.length) {
        colour.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const dep = deps[top.next]!;
      top.next += 1;
      const c = colour.get(dep) ?? WHITE;
      if (c === GREY) {
        const from = stack.findIndex((f) => f.id === dep);
        const path = stack.slice(from === -1 ? 0 : from).map((f) => f.id);
        return [...path, dep];
      }
      if (c === WHITE) {
        colour.set(dep, GREY);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The closure gate
// ---------------------------------------------------------------------------

/**
 * The structural subset `canClose` reads. `TaskReasoningIRv2` satisfies it, and
 * so does any hand-built fixture — the gate never needs a persisted state.
 */
export interface ObligationClosureState {
  readonly obligations: readonly ObligationNode[];
  readonly evidenceCatalog: readonly EvidenceIdentity[];
}

export type CanCloseRefusalReason =
  | "unknown-node"
  | "invalidated"
  | "dependency-open"
  | "predicate-unsatisfied";

export type CanCloseResult =
  | { ok: true }
  | { ok: false; reason: CanCloseRefusalReason; blocking: string[]; detail: string };

/**
 * THE single closure gate. Nothing else in V11-04 may promote an obligation to
 * `"satisfied"`.
 */
export function canClose(nodeId: string, state: ObligationClosureState): CanCloseResult {
  const byId = new Map(state.obligations.map((n) => [n.id, n] as const));
  const node = byId.get(nodeId);
  if (node === undefined) {
    return { ok: false, reason: "unknown-node", blocking: [], detail: `no obligation ${nodeId}` };
  }
  if (node.state === "invalidated") {
    return { ok: false, reason: "invalidated", blocking: [], detail: `${nodeId} was invalidated` };
  }

  const blocking: string[] = [];
  for (const depId of node.blockedBy) {
    const dep = byId.get(depId);
    if (dep === undefined) {
      // Unknown dependency: unprovable as advisory, so it BLOCKS. A dangling
      // edge can only ever slow a closure down, never wave one through.
      blocking.push(depId);
      continue;
    }
    // The advisory rule: a heuristic-origin node never blocks a non-advisory
    // one. Advisory nodes still respect their own advisory dependencies, so an
    // advisory sub-graph stays internally ordered.
    if (!node.advisory && dep.advisory) continue;
    if (dep.state !== "satisfied") blocking.push(dep.id);
  }
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: "dependency-open",
      blocking,
      detail: `${nodeId} is blocked by ${blocking.join(", ")}`,
    };
  }

  const grounded = groundedEvidenceIds(node.evidenceRefs, state.evidenceCatalog);
  if (!predicateSatisfied(node, grounded)) {
    return {
      ok: false,
      reason: "predicate-unsatisfied",
      blocking: [],
      detail: `${nodeId}: predicate ${node.predicate.kind} unsatisfied by ${grounded.size} grounded evidence item(s)`,
    };
  }
  return { ok: true };
}

/**
 * The evidence ids of `refs` that actually resolve in the catalog AND are not
 * heuristic. An unresolvable ref and a heuristic ref are equally worthless for
 * closure — neither is direct or structural repository evidence.
 */
export function groundedEvidenceIds(
  refs: readonly EvidenceId[],
  catalog: readonly EvidenceIdentity[],
): ReadonlySet<EvidenceId> {
  const classOf = new Map(catalog.map((e) => [e.evidenceId, e.evidenceClass] as const));
  const out = new Set<EvidenceId>();
  for (const ref of refs) {
    const cls = classOf.get(ref);
    if (cls === undefined || cls === "heuristic") continue;
    out.add(ref);
  }
  return out;
}

function predicateSatisfied(node: ObligationNode, grounded: ReadonlySet<EvidenceId>): boolean {
  const p = node.predicate;
  switch (p.kind) {
    case "any-grounded-evidence":
      return grounded.size >= 1;
    case "min-grounded-evidence":
      return p.count >= 0 && grounded.size >= p.count;
    case "named-evidence":
      return p.evidenceIds.length > 0 && p.evidenceIds.every((id) => grounded.has(id));
    case "manual":
      // Deliberately unsatisfiable: a manual node is discharged by an explicit
      // act, which in this model is an `invalidate` or an `update` that first
      // replaces the predicate. Auto-closing it would be exactly the "invalid
      // obligation closure" the acceptance criteria forbid.
      return false;
    default:
      return false;
  }
}

/**
 * Whether a state's obligation set is a DAG rather than a flat v1-style list.
 *
 * DERIVED, never stored independently: both inputs (`obligations.length` and
 * each node's `blockedBy`) are inside the hashed task-state boundary, so a
 * snapshot+delta replay reproduces this value exactly. A field the seam could
 * set out-of-band would be the one piece of state replay could not rebuild.
 */
export function deriveDagEnabled(obligations: readonly ObligationNode[]): boolean {
  return obligations.length > LOCAL_TASK_MAX_OBLIGATIONS || obligations.some((o) => o.blockedBy.length > 0);
}

/** True iff every NON-ADVISORY obligation has closed — Shadow Stop's first condition. */
export function allNonAdvisoryClosed(state: ObligationClosureState): boolean {
  return state.obligations.every((n) => n.advisory || n.state === "satisfied");
}

/** The non-advisory obligations that are still not `"satisfied"`. */
export function openNonAdvisoryObligations(state: ObligationClosureState): ObligationNode[] {
  return state.obligations.filter((n) => !n.advisory && n.state !== "satisfied");
}

// ---------------------------------------------------------------------------
// E-7 boundary — the advisory hint interface (NOT wired in wave B)
// ---------------------------------------------------------------------------

/**
 * One open obligation, projected into the shape a packer/retrieval stage could
 * PREFER on. Deviation E-7: this is an optional ADVISORY input only. It carries
 * no allowed-tool constraint, no required surface, and no completeness claim —
 * a consumer that ignores it entirely must stay correct.
 *
 * Wave B ships the function with ZERO production consumers (the coveragePacker
 * / retrieval trees are owned by concurrent agents this wave); wiring it is a
 * wave-C decision.
 */
export interface OpenObligationHint {
  obligationId: string;
  claim: string;
  advisory: boolean;
  reason: CanCloseRefusalReason;
  /** Dependency ids still blocking this node, when `reason === "dependency-open"`. */
  blocking: string[];
  /** Evidence already grounding the node — a consumer may keep these surfaces. */
  groundedEvidenceIds: string[];
  /** Source URIs the node already touches; the retrieval preference signal. */
  uris: string[];
  /** 1 for a blocking node, 0.25 for an advisory one. Preference only, never a gate. */
  weight: number;
}

/**
 * Bounded, deterministic hints for the still-open obligations of `state`.
 * Non-advisory nodes first, declaration order within each group.
 */
export function openObligationHints(state: ObligationClosureState): OpenObligationHint[] {
  const uriOf = new Map(state.evidenceCatalog.map((e) => [e.evidenceId, e.source.uri] as const));
  const hints: OpenObligationHint[] = [];
  for (const node of state.obligations) {
    if (node.state === "satisfied") continue;
    const verdict = canClose(node.id, state);
    if (verdict.ok) {
      // Closable but not yet closed: still open work, and the most valuable
      // hint of all — nothing more needs to be READ to discharge it.
      hints.push(hintOf(node, "predicate-unsatisfied", [], uriOf, state));
      continue;
    }
    hints.push(hintOf(node, verdict.reason, verdict.blocking, uriOf, state));
  }
  hints.sort((a, b) => Number(a.advisory) - Number(b.advisory));
  return hints.slice(0, OPEN_OBLIGATION_HINTS_MAX);
}

function hintOf(
  node: ObligationNode,
  reason: CanCloseRefusalReason,
  blocking: string[],
  uriOf: ReadonlyMap<string, string>,
  state: ObligationClosureState,
): OpenObligationHint {
  const grounded = [...groundedEvidenceIds(node.evidenceRefs, state.evidenceCatalog)];
  const uris: string[] = [];
  for (const id of node.evidenceRefs) {
    const uri = uriOf.get(id);
    if (uri !== undefined && !uris.includes(uri)) uris.push(uri);
  }
  return {
    obligationId: node.id,
    claim: node.claim,
    advisory: node.advisory,
    reason,
    blocking: [...blocking],
    groundedEvidenceIds: grounded,
    uris,
    weight: node.advisory ? 0.25 : 1,
  };
}
