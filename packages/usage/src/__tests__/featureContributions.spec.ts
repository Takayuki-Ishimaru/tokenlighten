import { describe, expect, it } from "vitest";
import {
  accumulateFeatureContributions,
  aggregateFeatureContributionsAcrossTrajectories,
  getFeatureContribution,
  type FeatureContributionEvent,
} from "../featureContributions.js";

function event(
  trace_id: string,
  feature: string,
  tokens: number,
  status: "measured" | "estimated" = "measured",
): FeatureContributionEvent {
  return { trace_id, feature, tokens, status, basis: `${feature} test event` };
}

describe("accumulateFeatureContributions", () => {
  it("sums signed tokens per (trace_id, feature), preserving negative totals", () => {
    const trajectories = accumulateFeatureContributions([
      event("t1", "acknowledged_prior_bytes_avoided", 400),
      event("t1", "acknowledged_prior_bytes_avoided", -600),
      event("t1", "avoided_turn", 1500),
    ]);
    expect(trajectories).toHaveLength(1);
    const t1 = trajectories[0];
    expect(t1.trace_id).toBe("t1");
    const acknowledged = t1.byFeature.find((f) => f.feature === "acknowledged_prior_bytes_avoided")!;
    expect(acknowledged.tokens).toBe(-200); // 400 + (-600), not clamped to 0
    expect(acknowledged.eventCount).toBe(2);
    const avoidedTurn = t1.byFeature.find((f) => f.feature === "avoided_turn")!;
    expect(avoidedTurn.tokens).toBe(1500);
  });

  it('status is "measured" only when EVERY contributing event was measured', () => {
    const trajectories = accumulateFeatureContributions([
      event("t1", "avoided_turn", 100, "measured"),
      event("t1", "avoided_turn", 200, "estimated"),
    ]);
    const avoidedTurn = trajectories[0].byFeature.find((f) => f.feature === "avoided_turn")!;
    expect(avoidedTurn.status).toBe("estimated");
    expect(avoidedTurn.tokens).toBe(300);
  });

  it('status is "measured" when all contributing events were measured', () => {
    const trajectories = accumulateFeatureContributions([
      event("t1", "avoided_turn", 100, "measured"),
      event("t1", "avoided_turn", 200, "measured"),
    ]);
    expect(trajectories[0].byFeature[0].status).toBe("measured");
  });

  it("groups independently per trace_id and sorts trajectories/features deterministically", () => {
    const trajectories = accumulateFeatureContributions([
      event("t2", "zzz_feature", 1),
      event("t1", "avoided_turn", 1),
      event("t1", "acknowledged_prior_bytes_avoided", 1),
    ]);
    expect(trajectories.map((t) => t.trace_id)).toEqual(["t1", "t2"]);
    expect(trajectories[0].byFeature.map((f) => f.feature)).toEqual([
      "acknowledged_prior_bytes_avoided",
      "avoided_turn",
    ]);
  });

  it("an unrecognized feature name is still accumulated verbatim (no closed enum)", () => {
    const trajectories = accumulateFeatureContributions([
      event("t1", "some_future_v12_feature", 77),
    ]);
    expect(trajectories[0].byFeature[0].feature).toBe("some_future_v12_feature");
    expect(trajectories[0].byFeature[0].tokens).toBe(77);
  });

  it("no events at all yields no trajectories, not a fabricated empty one", () => {
    expect(accumulateFeatureContributions([])).toEqual([]);
  });

  it("is pure: identical input yields a deep-equal result and never mutates it", () => {
    const events = [event("t1", "avoided_turn", 5)];
    const snapshot = JSON.parse(JSON.stringify(events));
    const a = accumulateFeatureContributions(events);
    const b = accumulateFeatureContributions(events);
    expect(a).toEqual(b);
    expect(events).toEqual(snapshot);
  });
});

describe("getFeatureContribution", () => {
  it('returns an "unavailable" summary (never undefined/throw) for a feature the trajectory never recorded', () => {
    const [t1] = accumulateFeatureContributions([event("t1", "avoided_turn", 5)]);
    const missing = getFeatureContribution(t1, "acknowledged_prior_bytes_avoided");
    expect(missing.status).toBe("unavailable");
    expect(missing.tokens).toBeNull();
    expect(missing.basis.length).toBeGreaterThan(0);
  });

  it("returns the real summary when the feature IS present", () => {
    const [t1] = accumulateFeatureContributions([event("t1", "avoided_turn", 5)]);
    expect(getFeatureContribution(t1, "avoided_turn").tokens).toBe(5);
  });
});

describe("aggregateFeatureContributionsAcrossTrajectories", () => {
  it("sums one feature across every trajectory that carried it, preserving sign", () => {
    const trajectories = accumulateFeatureContributions([
      event("t1", "avoided_turn", 100),
      event("t2", "avoided_turn", -50),
      event("t3", "some_other_feature", 999),
    ]);
    const aggregate = aggregateFeatureContributionsAcrossTrajectories(trajectories, "avoided_turn");
    expect(aggregate.tokens).toBe(50);
    expect(aggregate.eventCount).toBe(2);
  });

  it('is "unavailable" when NO trajectory ever recorded the feature', () => {
    const trajectories = accumulateFeatureContributions([event("t1", "avoided_turn", 1)]);
    const aggregate = aggregateFeatureContributionsAcrossTrajectories(trajectories, "never_seen");
    expect(aggregate.status).toBe("unavailable");
    expect(aggregate.tokens).toBeNull();
  });
});
