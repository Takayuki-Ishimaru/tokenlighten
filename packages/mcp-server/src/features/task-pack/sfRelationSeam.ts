// ---------------------------------------------------------------------------
// sfRelationSeam.ts — W-RELATION-SEAM: the task_pack production seam that
// compiles relation packets for grounded relation concerns and projects them
// into the EXISTING `plan.wiring.evidence_graph` field.
//
// NORMATIVE SOURCE: DESIGN-v0.15-semantic-frontier-plan.md §3.7 (relation
// packets: one packet per grounded relation concern, definition + declaration
// + direct callers/callees as edge lines with zoom handles, riding the
// EXISTING `plan.wiring.evidence_graph` field — no new wire field per §4.2;
// `SF_RELATION_PACKET_BYTES = 4096`; large fan-out gets honest truncation and
// the CONSUMER decides whether to fall back to `search_files
// {action:"references"}`, never this seam) and §3.7.2 (edges come from
// `features/graph-evidence`'s `EdgeDeriver`/providers via the real
// `RelationGraphPort`, never a literal scan; a real edge — never a
// `path-heuristics`-provider advisory one — is what can close the concern,
// and that judgment already lives in `sfSatisfaction.ts`'s
// `relationPacketSatisfies`/`packetCovers`, consumed here unmodified).
//
// THIS IS THE FIRST PRODUCTION IMPORTER of
// `features/graph-evidence/relationPacket.ts` and `relationGraphPort.ts`.
// Both were pure/unwired through W-RELATION-PACKET and W-RELATION-WIRE (see
// `features/graph-evidence/__tests__/purity.spec.ts`'s `UNWIRED_PURE_FILES` /
// `UNWIRED_ADAPTER_FILES`, and each module's own "imported only by tests this
// wave" guard spec, `relationPacket.spec.ts` / `relationPacketPort.spec.ts`).
// All three fences were updated in the same commit that added this file,
// naming this exact path (`features/task-pack/sfRelationSeam.ts`) as the one
// sanctioned importer.
//
// GATING (belt-and-suspenders, matching `sfConcerns.ts`'s own posture): this
// module re-checks `sfRelationPacketsEnabled() && graphEvidenceEnabled()`
// itself even though `assertSemanticFrontierV2FlagConsistency()` already
// refuses the inconsistent combination at startup — a defect in that check
// must not turn into an unbounded workspace walk here. Concern ACCESS itself
// additionally requires `TL_SF_STATEFUL` and (for concerns to exist at all)
// `TL_SF_STRUCTURAL_CONCERNS`, and observation-only profiles must never reach
// this module at all — both of those gates live at this module's one call
// site (`applySemanticFrontierState`, readCodeTaskPack.ts), which already
// never runs without `sfStatefulEnabled()`, and which skips calling in under
// `sfObservationOnly(result.profile_binding)`.
//
// FAIL-OPEN (I-1, matching the seam's own posture). Every path below degrades
// to "no packet for this concern" rather than throwing: a port-construction
// failure, a per-concern compile failure, or an anchor the port could not
// resolve are all the same "carry on without this concern's packet" outcome.
// The caller's own try/catch is the outer safety net; this module's inner
// try/catch exists so ONE bad concern never sinks the others in the same
// call.
// ---------------------------------------------------------------------------

import type { GraphIndex } from "../../graph/index.js";
import { graphEvidenceEnabled, sfRelationPacketsEnabled } from "../../util/flags.js";
import {
  compileRelationPacket,
  projectRelationPacketToEvidenceGraph,
  type RelationAnchor,
  type RelationGraphPort,
  type RelationPacket,
  type RelationPacketBudget,
} from "../graph-evidence/relationPacket.js";
import {
  createWorkspaceRelationGraphPort,
  mintRelationHandles,
} from "../graph-evidence/relationGraphPort.js";
// F7 (round 11): the D5 qualified-anchor resolver is injected into the port
// FROM here — this module lives in `features/task-pack` (same directory as
// `readCodeTaskPack.ts`), so importing it here creates no cycle. The cycle
// this avoids is graph-evidence/relationGraphPort.ts importing it directly,
// which — now that THIS file is that module's sanctioned production
// importer — would close a loop back through graph-evidence.
import { resolveQualifiedSymbolAnchors } from "./readCodeTaskPack.js";
import type { SfConcernAnchor, SfStructuralConcern } from "./sfConcerns.js";
import type { SfConcernProof, SfRelationPacketView, SfSatisfactionResult } from "./sfSatisfaction.js";
import type {
  TaskEvidenceGraph,
  TaskEvidenceNode,
  TaskEvidenceRelation,
  TaskEvidenceUnavailableKind,
} from "@tokenlighten/types";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** §3.7.2: bounded to the first N grounded relation concerns per pack, in extraction-priority order (I-2). */
export const SF_RELATION_CONCERN_MAX = 2;

// ---------------------------------------------------------------------------
// Input / output
// ---------------------------------------------------------------------------

export interface SfRelationSeamInput {
  readonly workspaceRoot: string;
  readonly lane?: string;
  /** This pack's full concern set; only grounded `relation` concerns are processed (see `eligibleConcerns`). */
  readonly concerns: readonly SfStructuralConcern[];
  /** `result.wiring?.evidence_graph`, when a prior producer (e.g. `attachAnswerImportEvidenceGraph`, `buildTaskWiringProfile`) already attached one. Merged deterministically, never overwritten. */
  readonly existingGraph?: TaskEvidenceGraph;
  /** Test-only: injected straight through to `createWorkspaceRelationGraphPort`. Never set by the production call site. */
  readonly testIndex?: GraphIndex;
  readonly testGeneration?: string;
  readonly testFiles?: readonly string[];
  /** Test-only: overrides `compileRelationPacket`'s default budget (also sizes the port's raw fan-out cap). Never set by the production call site. */
  readonly testBudget?: Partial<RelationPacketBudget>;
}

export interface SfRelationSeamPacket {
  readonly concern: SfStructuralConcern;
  /**
   * Duck-type compatible with `SfRelationPacketView` (sfSatisfaction.ts's own
   * note: "which the real `RelationPacket` satisfies without either file
   * knowing about [the other]") — feed straight into `applyResponseToConcerns`
   * as `response.relationPacket`.
   */
  readonly view: SfRelationPacketView;
}

export interface SfRelationSeamOutcome {
  /** One entry per concern actually processed (anchor resolved to a `RelationAnchor` and compiled without error). */
  readonly packets: readonly SfRelationSeamPacket[];
  /** Present iff at least one packet contributed a node — merges with `input.existingGraph` when given. */
  readonly evidenceGraph?: TaskEvidenceGraph;
}

const EMPTY_OUTCOME: SfRelationSeamOutcome = { packets: [] };

// ---------------------------------------------------------------------------
// Concern selection
// ---------------------------------------------------------------------------

function anchorFor(anchor: SfConcernAnchor): RelationAnchor | undefined {
  if (anchor.kind === "symbol") return { symbol: anchor.symbol };
  if (anchor.kind === "qualified") return { qualified: { class: anchor.qualifier, member: anchor.member } };
  // A path or verb anchor names a FILE relation, not a symbol packet — out of
  // this compiler's declared scope (definition/declaration/direct
  // callers-callees for ONE symbol anchor, per §3.7.1).
  return undefined;
}

/** Grounded (non-advisory), symbol/qualified-anchored `relation` concerns only, first `SF_RELATION_CONCERN_MAX` by extraction order. */
function eligibleConcerns(concerns: readonly SfStructuralConcern[]): SfStructuralConcern[] {
  const out: SfStructuralConcern[] = [];
  for (const concern of concerns) {
    if (concern.kind !== "relation" || concern.advisory) continue;
    if (concern.anchor.kind !== "symbol" && concern.anchor.kind !== "qualified") continue;
    out.push(concern);
    if (out.length >= SF_RELATION_CONCERN_MAX) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic graph merge
// ---------------------------------------------------------------------------

/**
 * Union, deduped and sorted, omitted (never `[]`) when neither side names
 * anything — mirrors `TaskEvidenceGraph.unavailable`'s own absence-is-
 * meaning contract (`@tokenlighten/types`: "Absent (never `[]`) when every
 * class every contributor emits was at least attempted").
 */
function mergeUnavailable(
  existing: readonly TaskEvidenceUnavailableKind[] | undefined,
  addition: readonly TaskEvidenceUnavailableKind[] | undefined,
): TaskEvidenceUnavailableKind[] | undefined {
  const merged = new Set<TaskEvidenceUnavailableKind>([...(existing ?? []), ...(addition ?? [])]);
  if (merged.size === 0) return undefined;
  return [...merged].sort();
}

/**
 * Union by id, each side's own entry winning ties (existing content is never
 * replaced), sorted for determinism. `unavailable` (FX-I-B, round 13,
 * 2026-09-03) is unioned the same way — a relation class either side
 * declares uncomputable stays uncomputable in the merged graph; DROPPING it
 * here (the pre-fix behavior) silently turned "no callee source exists" into
 * "computed, found none" on the wire, contradicting guide v85's own "callees
 * iff not `unavailable`" instruction to agents. `truncated` is NOT carried:
 * `TaskEvidenceGraph` (`@tokenlighten/types`) has no such field today — see
 * this file's own header note / the round-13 report for why that guide
 * sentence needs correcting instead of a field being invented here.
 */
function mergeEvidenceGraphs(existing: TaskEvidenceGraph | undefined, addition: TaskEvidenceGraph): TaskEvidenceGraph {
  const nodes = new Map<string, TaskEvidenceNode>();
  const relations = new Map<string, TaskEvidenceRelation>();
  for (const node of existing?.nodes ?? []) nodes.set(node.id, node);
  for (const node of addition.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
  for (const relation of existing?.relations ?? []) relations.set(relation.id, relation);
  for (const relation of addition.relations) if (!relations.has(relation.id)) relations.set(relation.id, relation);
  const unavailable = mergeUnavailable(existing?.unavailable, addition.unavailable);
  // FX-R2 (round 18B finding 4, 2026-09-03): OR, never dropped — one
  // over-budget contributor to a merged pack makes the WHOLE merged graph
  // "some contributor could not fit", which the caller must not read as
  // "resolved, found nothing" just because another contributor fit fine.
  const overBudget = existing?.over_budget === true || addition.over_budget === true;
  return {
    version: 1,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relations: [...relations.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ...(unavailable !== undefined ? { unavailable } : {}),
    ...(overBudget ? { over_budget: true } : {}),
  };
}

/**
 * Test-only: exercises `mergeEvidenceGraphs`'s `unavailable` union/dedupe/
 * omit-when-empty logic directly. The only production port
 * (`createWorkspaceRelationGraphPort`, relationGraphPort.ts) unconditionally
 * reports `"callees"` in `unavailableRelations` for EVERY anchor (FX-G-B) —
 * that specific class has no real call-edge source at all today, so this
 * part is genuinely anchor-independent — but `"callers"` is NOT
 * unconditional the way this comment used to claim: FX-R2 (round 18B)
 * makes it conditional on whether a real `GraphIndex` exists at all for the
 * workspace, and FX-U2 (round 19B finding 1) further conditions it, PER
 * ANCHOR, on whether that anchor's bare member name collides with another
 * class's same-named member in the loaded index (see
 * `RelationGraphPort.unavailableRelationsForAnchor`'s doc in
 * `relationPacket.ts`, and `relationGraphPort.ts`'s `unavailableRelationsForAnchor`
 * / `callersOf`). So there IS a real production path to a packet where
 * `callers` is available (an unambiguous qualified or bare-symbol anchor
 * against a real index) — `callees` alone remains the unreachable-from-
 * production case this wrapper exists to cover: there is no way to drive
 * `compileSfRelationPackets` through the real production path to a packet
 * where `callees` IS available, so the "omitted when neither side names
 * anything" and "present when only one side does" branches are unreachable
 * from an end-to-end `buildTaskPack()` test today for THAT class. This
 * wrapper lets `sfRelationWireDisclosure.spec.ts` prove those branches
 * against the merge function itself, matching this directory's existing
 * `*ForTest` export convention (e.g. `evidenceResolution.ts`'s
 * `resetEvidenceMemoForTest`).
 */
export function mergeEvidenceGraphsForTest(
  existing: TaskEvidenceGraph | undefined,
  addition: TaskEvidenceGraph,
): TaskEvidenceGraph {
  return mergeEvidenceGraphs(existing, addition);
}

// ---------------------------------------------------------------------------
// The compiler seam
// ---------------------------------------------------------------------------

/**
 * Compiles at most `SF_RELATION_CONCERN_MAX` relation packets for this pack's
 * grounded relation concerns, mints real handles for every admitted site
 * (never an `unresolved:*` placeholder — `mintRelationHandles` drops what it
 * cannot mint instead), and projects the result into one `TaskEvidenceGraph`,
 * merged deterministically with `input.existingGraph`.
 *
 * The port is built ONCE per call and reused across every concern this call
 * processes ("cache per pack" — DESIGN-v0.15 §3.7.2's per-packet budget is
 * about the SERVED packet, not about re-parsing the workspace per concern).
 */
export async function compileSfRelationPackets(input: SfRelationSeamInput): Promise<SfRelationSeamOutcome> {
  if (!sfRelationPacketsEnabled() || !graphEvidenceEnabled()) return EMPTY_OUTCOME;
  const candidates = eligibleConcerns(input.concerns);
  if (candidates.length === 0) return EMPTY_OUTCOME;

  let port: RelationGraphPort;
  try {
    port = await createWorkspaceRelationGraphPort({
      workspaceRoot: input.workspaceRoot,
      qualifiedResolver: resolveQualifiedSymbolAnchors,
      ...(input.lane !== undefined ? { lane: input.lane } : {}),
      ...(input.testIndex !== undefined ? { index: input.testIndex } : {}),
      ...(input.testGeneration !== undefined ? { generation: input.testGeneration } : {}),
      ...(input.testFiles !== undefined ? { files: input.testFiles } : {}),
      ...(input.testBudget !== undefined ? { budget: input.testBudget } : {}),
    });
  } catch {
    return EMPTY_OUTCOME;
  }

  const packets: SfRelationSeamPacket[] = [];
  let graph = input.existingGraph;

  for (const concern of candidates) {
    const anchor = anchorFor(concern.anchor);
    if (anchor === undefined) continue;
    let minted: RelationPacket;
    try {
      const compiled = compileRelationPacket({
        anchor,
        graph: port,
        ...(input.testBudget !== undefined ? { budget: input.testBudget } : {}),
      });
      minted = mintRelationHandles(compiled, input.workspaceRoot).packet;
    } catch {
      continue;
    }
    // `RelationPacket` structurally satisfies `SfRelationPacketView` — no
    // adapter needed (see the type's own doc note in sfSatisfaction.ts).
    // FX-Y1 (round-23B finding 1, HIGH, ruling (cc), 2026-09-04): `minted`
    // (a real `RelationPacket`) carries its own `unavailable` untouched —
    // this seam adds no adapter for it. That is deliberate: `minted` already
    // structurally satisfies `SfRelationPacketView` (this type's own doc
    // note), so `applyResponseToConcerns` (sfSatisfaction.ts) reads
    // `view.unavailable` directly off the same object this seam pushes into
    // `packets` below — the ONE thing this seam does to "expose the packet's
    // disclosure to satisfaction" is push the whole packet, once, and let the
    // two modules' independent structural-typing agreement do the rest. Do
    // NOT narrow, copy, or re-derive `unavailable` here: satisfaction and the
    // wire projection two lines below must see the IDENTICAL disclosure.
    packets.push({ concern, view: minted });
    const projected = projectRelationPacketToEvidenceGraph(minted) as unknown as TaskEvidenceGraph;
    // FX-I-B: a packet that resolved nothing usable (no nodes/relations) can
    // still carry `unavailable` (e.g. an anchor that failed to resolve, from
    // a port that structurally cannot compute callees for ANY anchor) — that
    // disclosure must reach the wire too, not only the byte-bearing case.
    // FX-R2 (round 18B finding 4): the same is true of `over_budget` — an
    // over-budget packet has everything shedable already stripped (so
    // `nodes`/`relations`/`unavailable` alone would often be empty here too),
    // and dropping it silently is exactly the defect being fixed.
    if (
      projected.nodes.length > 0 ||
      projected.relations.length > 0 ||
      (projected.unavailable?.length ?? 0) > 0 ||
      projected.over_budget === true
    ) {
      graph = mergeEvidenceGraphs(graph, projected);
    }
  }

  return { packets, ...(graph !== undefined ? { evidenceGraph: graph } : {}) };
}

// ---------------------------------------------------------------------------
// Satisfaction-result merge — `applyResponseToConcerns` accepts exactly one
// `relationPacket` per call (§4.2: `SfResponse.relationPacket` is singular),
// but this seam may compile up to `SF_RELATION_CONCERN_MAX` packets with
// DIFFERENT anchors in one pack. The call site runs one extra
// `applyResponseToConcerns` pass per compiled packet and folds each result in
// with this — pure bookkeeping, no new satisfaction RULE.
// ---------------------------------------------------------------------------

export function mergeSfSatisfactionResults(
  base: SfSatisfactionResult,
  extra: SfSatisfactionResult,
  concerns: readonly SfStructuralConcern[],
): SfSatisfactionResult {
  const satisfied = new Set([...base.satisfied, ...extra.satisfied]);
  const alreadySatisfied = new Set([...base.alreadySatisfied, ...extra.alreadySatisfied]);
  const proofs: Record<string, SfConcernProof> = { ...base.proofs };
  for (const id of extra.satisfied) {
    if (proofs[id] === undefined && extra.proofs[id] !== undefined) proofs[id] = extra.proofs[id]!;
  }
  const openVerify = [...new Set([...base.openVerify, ...extra.openVerify])];
  const untouched = concerns
    .map((concern) => concern.id)
    .filter((id) => !satisfied.has(id) && !alreadySatisfied.has(id));
  return {
    satisfied: [...satisfied],
    proofs,
    untouched,
    alreadySatisfied: [...alreadySatisfied],
    openVerify,
  };
}
