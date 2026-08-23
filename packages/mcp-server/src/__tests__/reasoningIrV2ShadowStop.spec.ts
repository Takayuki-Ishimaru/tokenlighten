/**
 * reasoningIrV2ShadowStop.spec.ts — V11-04 acceptance: shadow Stop candidates.
 *
 * Plan §7 V11-04: "shadow Stop false candidate 0件をdefault化前の必須目標とする",
 * narrowed by reconciliation E-5 to a FIXTURE-BASED offline harness.
 *
 * The fixtures below are trajectories: a sequence of IR states plus the marker
 * for where the task ACTUALLY ended. A candidate before that marker is a false
 * candidate, and the bar is 0 across every fixture.
 */

import { describe, it, expect } from "vitest";
import type { TaskReasoningIRv2 } from "@tokenlighten/types";
import {
  compareShadowStopStream,
  evaluateShadowStop,
  type ShadowStopFixture,
} from "../task-state/shadowStop.js";
import { createStrongTombstone } from "../task-state/tombstone.js";
import { evidence, node, state } from "./helpers/irV2Fixtures.js";

const catalog = [evidence("e1", "src/a.ts"), evidence("e2", "src/api/b.ts")];

function closedState(parts: Partial<Parameters<typeof state>[0]> = {}): TaskReasoningIRv2 {
  return state({
    stateVersion: 3,
    evidenceCatalog: catalog,
    obligations: [node("a", { state: "satisfied", evidenceRefs: ["e1"] })],
    invalidationKeys: [{ type: "index-generation", value: "gen-1" }],
    ...parts,
  });
}

describe("V11-04 shadow Stop — the four conditions", () => {
  it("produces a candidate when everything is closed and coverage is complete", () => {
    const result = evaluateShadowStop({ state: closedState(), coverage: "complete" });
    expect(result.blockers).toEqual([]);
    expect(result.candidate).toMatchObject({
      stateVersion: 3,
      closedObligations: ["a"],
      advisoryOpen: [],
      reason: "all-non-advisory-obligations-closed",
    });
  });

  it("NO candidate while a non-advisory obligation is open", () => {
    const result = evaluateShadowStop({
      state: closedState({ obligations: [node("a", { state: "satisfied", evidenceRefs: ["e1"] }), node("b")] }),
      coverage: "complete",
    });
    expect(result.candidate).toBeUndefined();
    expect(result.blockers).toContainEqual(expect.objectContaining({ kind: "open-obligation", id: "b" }));
  });

  it("an ADVISORY obligation may stay open — it is reported, not suppressed", () => {
    const result = evaluateShadowStop({
      state: closedState({
        obligations: [
          node("a", { state: "satisfied", evidenceRefs: ["e1"] }),
          node("guess", { origin: "heuristic", predicate: { kind: "manual" } }),
        ],
      }),
      coverage: "complete",
    });
    expect(result.candidate).toBeDefined();
    expect(result.candidate!.advisoryOpen).toEqual(["guess"]);
  });

  it("NO candidate when a node is MARKED satisfied but no longer earns it", () => {
    // Grounding vanished (an evidence invalidation a caller failed to
    // propagate). The satisfied flag alone is not a closure.
    const result = evaluateShadowStop({
      state: closedState({
        evidenceCatalog: [],
        obligations: [node("a", { state: "satisfied", evidenceRefs: ["e1"] })],
      }),
      coverage: "complete",
    });
    expect(result.candidate).toBeUndefined();
    expect(result.blockers).toContainEqual(expect.objectContaining({ kind: "unclosable-obligation", id: "a" }));
  });

  it("NO candidate on incomplete coverage", () => {
    for (const coverage of ["focused", "partial"] as const) {
      const result = evaluateShadowStop({ state: closedState(), coverage });
      expect(result.candidate).toBeUndefined();
      expect(result.blockers).toContainEqual(expect.objectContaining({ kind: "coverage-incomplete" }));
    }
  });

  it("NO candidate while a blocking gap is open", () => {
    const result = evaluateShadowStop({ state: closedState(), coverage: "complete", openGaps: ["missing consumer surface"] });
    expect(result.candidate).toBeUndefined();
    expect(result.blockers).toContainEqual(expect.objectContaining({ kind: "open-blocking-gap" }));
  });
});

describe("V11-04 shadow Stop — strong tombstone contradictions", () => {
  const strong = (id: string, contradicts?: string[], paths?: string[]) => {
    const made = createStrongTombstone({
      id,
      claim: "nothing relevant lives under src/api",
      scope: { kind: "paths", description: "src/api", paths: paths ?? ["src/api"], complete: true },
      reviveCondition: "a matching symbol appears",
      validityKeys: [{ type: "index-generation", value: "gen-1" }],
      absence: { evidenceId: "e1", scopeComplete: true, observedMatches: 0, provider: "search_files/find" },
      evidenceCatalog: catalog,
      ...(contradicts === undefined ? {} : { contradicts }),
    });
    if (!made.ok) throw new Error(`fixture refused: ${made.reason}`);
    return made.tombstone;
  };

  it("NO candidate when a live strong tombstone NAMES a closed obligation", () => {
    const result = evaluateShadowStop({
      state: closedState({ tombstones: [strong("t1", ["a"])] }),
      coverage: "complete",
    });
    expect(result.candidate).toBeUndefined();
    expect(result.blockers).toContainEqual(expect.objectContaining({ kind: "strong-tombstone-contradiction", id: "t1" }));
  });

  it("NO candidate when a closed obligation cites evidence INSIDE the exhausted path scope", () => {
    const result = evaluateShadowStop({
      state: closedState({
        obligations: [node("a", { state: "satisfied", evidenceRefs: ["e2"] })],
        tombstones: [strong("t2")],
      }),
      coverage: "complete",
    });
    expect(result.candidate).toBeUndefined();
    expect(result.blockers[0]).toMatchObject({ kind: "strong-tombstone-contradiction", id: "t2" });
  });

  it("a STALE strong tombstone contradicts nothing — it is swept first", () => {
    const result = evaluateShadowStop({
      state: closedState({ tombstones: [strong("t1", ["a"])] }),
      coverage: "complete",
      liveValidityKeys: [{ type: "index-generation", value: "gen-2" }],
    });
    expect(result.candidate).toBeDefined();
  });

  it("a WEAK rejection never blocks a candidate", () => {
    const weakLike = { ...strong("t3", ["a"]), strength: "weak" as const };
    const result = evaluateShadowStop({ state: closedState({ tombstones: [weakLike] }), coverage: "complete" });
    expect(result.candidate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The E-5 offline comparison harness
// ---------------------------------------------------------------------------

/** A trajectory that discovers, works, and legitimately finishes at v4. */
const finishedTask: ShadowStopFixture = {
  taskRef: "finished",
  actualEndVersion: 4,
  steps: [
    { state: state({ stateVersion: 1, evidenceCatalog: catalog, obligations: [node("a"), node("b", { blockedBy: ["a"] })] }), coverage: "partial" },
    { state: state({ stateVersion: 2, evidenceCatalog: catalog, obligations: [node("a", { evidenceRefs: ["e1"] }), node("b", { blockedBy: ["a"], evidenceRefs: ["e2"] })] }), coverage: "focused" },
    {
      state: state({
        stateVersion: 3,
        evidenceCatalog: catalog,
        obligations: [node("a", { state: "satisfied", evidenceRefs: ["e1"] }), node("b", { blockedBy: ["a"], evidenceRefs: ["e2"] })],
      }),
      coverage: "complete",
    },
    {
      state: state({
        stateVersion: 4,
        evidenceCatalog: catalog,
        obligations: [
          node("a", { state: "satisfied", evidenceRefs: ["e1"] }),
          node("b", { state: "satisfied", blockedBy: ["a"], evidenceRefs: ["e2"] }),
        ],
      }),
      coverage: "complete",
    },
  ],
};

/** A trajectory that never finishes: an obligation stays open throughout. */
const abandonedTask: ShadowStopFixture = {
  taskRef: "abandoned",
  actualEndVersion: null,
  steps: [1, 2, 3].map((v) => ({
    state: state({
      stateVersion: v,
      evidenceCatalog: catalog,
      obligations: [node("a", { state: "satisfied", evidenceRefs: ["e1"] }), node("open-forever")],
    }),
    coverage: "complete" as const,
  })),
};

/** A trajectory whose only "closed" state is contradicted by a strong tombstone. */
const contradictedTask: ShadowStopFixture = (() => {
  const made = createStrongTombstone({
    id: "tc",
    claim: "no consumer exists under src/api",
    scope: { kind: "paths", description: "src/api", paths: ["src/api"], complete: true },
    reviveCondition: "a consumer appears",
    validityKeys: [{ type: "index-generation", value: "gen-1" }],
    absence: { evidenceId: "e1", scopeComplete: true, observedMatches: 0, provider: "search_files/find" },
    evidenceCatalog: catalog,
    contradicts: ["a"],
  });
  if (!made.ok) throw new Error("fixture refused");
  return {
    taskRef: "contradicted",
    actualEndVersion: null,
    steps: [
      {
        state: state({
          stateVersion: 1,
          evidenceCatalog: catalog,
          obligations: [node("a", { state: "satisfied", evidenceRefs: ["e1"] })],
          tombstones: [made.tombstone],
          invalidationKeys: [{ type: "index-generation", value: "gen-1" }],
        }),
        coverage: "complete" as const,
      },
    ],
  };
})();

/** A trajectory that would look done except a blocking gap stays open. */
const gappedTask: ShadowStopFixture = {
  taskRef: "gapped",
  actualEndVersion: null,
  steps: [
    {
      state: closedState({ stateVersion: 1 }),
      coverage: "complete",
      openGaps: ["missing required surface: src/api/b.ts"],
    },
  ],
};

describe("V11-04 shadow Stop — false candidate 0 on the E-5 fixtures", () => {
  const FIXTURES: ShadowStopFixture[] = [finishedTask, abandonedTask, contradictedTask, gappedTask];

  for (const fixture of FIXTURES) {
    it(`${fixture.taskRef}: zero false candidates`, () => {
      const comparison = compareShadowStopStream(fixture);
      expect(comparison.falseCandidateVersions).toEqual([]);
      expect(comparison.falseCandidates).toBe(0);
      expect(comparison.falseCandidateRate).toBe(0);
    });
  }

  it("the finished trajectory produces its candidate exactly at the real end", () => {
    const comparison = compareShadowStopStream(finishedTask);
    expect(comparison.candidateVersions).toEqual([4]);
    expect(comparison.trueCandidates).toBe(1);
    expect(comparison.missedEnd).toBe(false);
  });

  it("the never-finished trajectories produce no candidate at all", () => {
    for (const fixture of [abandonedTask, contradictedTask, gappedTask]) {
      expect(compareShadowStopStream(fixture).candidateVersions).toEqual([]);
    }
  });

  it("the harness WOULD score a premature candidate as false (the metric is real)", () => {
    // Same states, but with the recorded end moved later: the v4 candidate is
    // now premature, and the scorer must say so. Without this the "0 false
    // candidates" rows above could pass by measuring nothing.
    const movedEnd: ShadowStopFixture = { ...finishedTask, actualEndVersion: 9 };
    const comparison = compareShadowStopStream(movedEnd);
    expect(comparison.falseCandidateVersions).toEqual([4]);
    expect(comparison.falseCandidateRate).toBe(1);
    expect(comparison.missedEnd).toBe(true);
  });
});
