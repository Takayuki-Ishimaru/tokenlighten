/**
 * irV2Fixtures.ts — shared builders for the V11-04 Task Reasoning IR v2 specs.
 *
 * Not a spec file (no `.spec.ts` suffix), so vitest's include pattern skips it.
 * Every builder produces a WELL-FORMED value: a state comes back with its hash
 * already computed, so a spec that wants an inconsistent state has to corrupt it
 * on purpose and that intent is visible at the call site.
 */

import type {
  EvidenceIdentity,
  EvidenceRole,
  EvidenceUse,
  HypothesisTombstone,
  ObligationNode,
  TaskReasoningIRv2,
  ValidityKey,
} from "@tokenlighten/types";
import { computeTaskStateHash } from "../../task-state/reasoningDelta.js";

export function evidence(
  id: string,
  uri: string,
  evidenceClass: EvidenceIdentity["evidenceClass"] = "direct",
): EvidenceIdentity {
  return {
    evidenceId: id,
    source: { kind: "file", uri, contentHash: `sha-${id}` },
    locator: { lineRange: { startLine: 1, endLine: 10 } },
    evidenceClass,
    validityKeys: [{ type: "file-sha", value: `${uri}@sha-${id}` }],
  };
}

export function use(evidenceId: string, obligationId: string, role: EvidenceRole = "target"): EvidenceUse {
  return { taskRef: "task", evidenceId, roles: [role], obligationIds: [obligationId], required: true };
}

export function node(id: string, overrides: Partial<ObligationNode> = {}): ObligationNode {
  const origin = overrides.origin ?? "source-requirement";
  return {
    id,
    claim: `claim ${id}`,
    state: "open",
    evidenceRefs: [],
    origin,
    advisory: origin === "heuristic",
    blockedBy: [],
    predicate: { kind: "any-grounded-evidence" },
    ...overrides,
    // `advisory` is derived; an override may not launder a heuristic node.
    ...(overrides.origin === undefined ? {} : { advisory: overrides.origin === "heuristic" }),
  };
}

export interface StateParts {
  taskRef?: string;
  lane?: string;
  stateVersion?: number;
  goal?: string;
  evidenceCatalog?: EvidenceIdentity[];
  evidenceUses?: EvidenceUse[];
  obligations?: ObligationNode[];
  decision?: TaskReasoningIRv2["decision"];
  tombstones?: HypothesisTombstone[];
  invalidationKeys?: ValidityKey[];
  appliedDeltaIds?: string[];
  dagEnabled?: boolean;
}

/** A complete, self-consistent IR v2 state (hash computed from its content). */
export function state(parts: StateParts = {}): TaskReasoningIRv2 {
  const base: TaskReasoningIRv2 = {
    irVersion: 2,
    taskRef: parts.taskRef ?? "task-1",
    lane: parts.lane ?? "",
    stateVersion: parts.stateVersion ?? 1,
    stateHash: "",
    goal: parts.goal ?? "do the thing",
    constraints: [],
    evidenceCatalog: parts.evidenceCatalog ?? [],
    evidenceUses: parts.evidenceUses ?? [],
    obligations: parts.obligations ?? [],
    decision: parts.decision ?? { state: "pending", evidenceRefs: [] },
    tombstones: parts.tombstones ?? [],
    allowedNext: [],
    invalidationKeys: parts.invalidationKeys ?? [],
    appliedDeltaIds: parts.appliedDeltaIds ?? [],
    dagEnabled: parts.dagEnabled ?? false,
  };
  return { ...base, stateHash: computeTaskStateHash(base) };
}

/** Deterministic PRNG for the property-style delta specs (seeded, reproducible). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
