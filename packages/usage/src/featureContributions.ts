/**
 * featureContributions.ts — V11-08 Attribution & Calibration v2.
 *
 * Trajectory-level feature-contribution records: extends the measurement
 * event vocabulary (measurementEngine.ts's `TelemetryEvent`-style
 * structural duck-typing — see that file's header doc for why this package
 * mirrors trace shapes structurally instead of importing them) so a
 * trajectory (`trace_id`, the same per-process identity
 * measurementEngine.ts reads from TL_TRACE records) can accumulate named
 * feature-contribution entries — e.g. PI-03's acknowledged-prior bytes
 * avoided, or V11-05's avoided-turn events (both cited by the V11-08 design
 * doc section, DESIGN-v0.10-expansion-plan-v1.3.md ~line 2814) — with the
 * SAME measured/estimated provenance discipline as measurementEngine.ts:
 * negative contributions are preserved (a feature can make things worse),
 * never clamped or fabricated.
 *
 * No mcp-server change ships alongside this file: nothing in mcp-server
 * emits a `feature_contribution`-shaped trace record yet (verified — see
 * this workstream's final report). This module defines the VOCABULARY and
 * the pure accumulation/rollup mechanics so a future trace-emission hook
 * (an mcp-server change, out of this package's scope per the task brief)
 * has a stable shape to target.
 */

export type FeatureContributionEventStatus = "measured" | "estimated";

export interface FeatureContributionEvent {
  /** Same identity as measurementEngine.ts's `TelemetryEvent.trace_id`. */
  readonly trace_id: string;
  /** Feature identifier, e.g. "acknowledged_prior_bytes_avoided" or
   *  "avoided_turn". Deliberately not a closed enum — new features land
   *  across many workstreams over time; an unrecognized name is still
   *  accumulated faithfully, just surfaced verbatim rather than validated
   *  against a fixed list. */
  readonly feature: string;
  /** Signed tokens this ONE event contributed. Negative is valid and is
   *  never clamped (see combineNet's identical rule in
   *  measurementEngine.ts). */
  readonly tokens: number;
  readonly status: FeatureContributionEventStatus;
  /** Always non-empty — same discipline as ComponentProvenance.basis. */
  readonly basis: string;
}

export type FeatureContributionSummaryStatus =
  | FeatureContributionEventStatus
  | "unavailable";

export interface FeatureContributionSummary {
  readonly feature: string;
  /** "measured" iff EVERY contributing event was measured; "estimated" when
   *  at least one event contributed but not all were measured; "unavailable"
   *  only when there is truly no event for this feature (never a fabricated
   *  0 standing in for missing evidence). */
  readonly status: FeatureContributionSummaryStatus;
  /** null iff status is "unavailable". Sign preserved — a negative total
   *  means this feature cost more than it saved, and must render as
   *  negative, never clamped to 0. */
  readonly tokens: number | null;
  readonly eventCount: number;
  readonly basis: string;
}

export interface TrajectoryFeatureContributions {
  readonly trace_id: string;
  /** Only features that had at least one event — sorted by feature name for
   *  deterministic output. */
  readonly byFeature: readonly FeatureContributionSummary[];
}

function summarizeFeature(
  feature: string,
  events: readonly FeatureContributionEvent[],
): FeatureContributionSummary {
  if (events.length === 0) {
    return {
      feature,
      status: "unavailable",
      tokens: null,
      eventCount: 0,
      basis: `no feature-contribution event was recorded for "${feature}"`,
    };
  }
  const tokens = events.reduce((sum, e) => sum + e.tokens, 0);
  const allMeasured = events.every((e) => e.status === "measured");
  return {
    feature,
    status: allMeasured ? "measured" : "estimated",
    tokens,
    eventCount: events.length,
    basis: `sum of ${events.length} "${feature}" event(s) `
      + `(${allMeasured ? "all measured" : "at least one estimated"})`,
  };
}

/**
 * Groups feature-contribution events by (trace_id, feature) and rolls each
 * group up into a summary. Pure: never mutates `events`; deterministic
 * (trace_id then feature, both sorted) so identical input always yields a
 * deep-equal result.
 */
export function accumulateFeatureContributions(
  events: readonly FeatureContributionEvent[],
): readonly TrajectoryFeatureContributions[] {
  const byTrace = new Map<string, FeatureContributionEvent[]>();
  for (const event of events) {
    const group = byTrace.get(event.trace_id) ?? [];
    group.push(event);
    byTrace.set(event.trace_id, group);
  }
  const trajectories: TrajectoryFeatureContributions[] = [];
  for (const [trace_id, traceEvents] of [...byTrace].sort(([a], [b]) => a.localeCompare(b))) {
    const byFeatureName = new Map<string, FeatureContributionEvent[]>();
    for (const event of traceEvents) {
      const group = byFeatureName.get(event.feature) ?? [];
      group.push(event);
      byFeatureName.set(event.feature, group);
    }
    const byFeature = [...byFeatureName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([feature, featureEvents]) => summarizeFeature(feature, featureEvents));
    trajectories.push({ trace_id, byFeature });
  }
  return trajectories;
}

/**
 * Looks up one feature's summary within a trajectory, returning an
 * "unavailable" summary (never undefined, never a thrown error) when that
 * trajectory recorded no event for it — the same "no all-dash" discipline
 * measurementDisplay.ts's tiers apply.
 */
export function getFeatureContribution(
  trajectory: TrajectoryFeatureContributions,
  feature: string,
): FeatureContributionSummary {
  return trajectory.byFeature.find((f) => f.feature === feature)
    ?? {
      feature,
      status: "unavailable",
      tokens: null,
      eventCount: 0,
      basis: `trajectory "${trajectory.trace_id}" recorded no event for "${feature}"`,
    };
}

/**
 * Aggregates one feature's contribution ACROSS every supplied trajectory —
 * useful for a fleet-wide/session-wide view. Same honesty rules as
 * summarizeFeature: "measured" only if every contributing trajectory's
 * summary for this feature was itself "measured"; "unavailable" only when
 * NO trajectory ever recorded this feature at all.
 */
export function aggregateFeatureContributionsAcrossTrajectories(
  trajectories: readonly TrajectoryFeatureContributions[],
  feature: string,
): FeatureContributionSummary {
  const present = trajectories
    .map((t) => getFeatureContribution(t, feature))
    .filter((summary) => summary.status !== "unavailable");
  if (present.length === 0) {
    return {
      feature,
      status: "unavailable",
      tokens: null,
      eventCount: 0,
      basis: `no trajectory among ${trajectories.length} recorded an event for "${feature}"`,
    };
  }
  const tokens = present.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
  const allMeasured = present.every((s) => s.status === "measured");
  const eventCount = present.reduce((sum, s) => sum + s.eventCount, 0);
  return {
    feature,
    status: allMeasured ? "measured" : "estimated",
    tokens,
    eventCount,
    basis: `sum across ${present.length} of ${trajectories.length} trajector(y/ies) `
      + `carrying "${feature}" (${allMeasured ? "all measured" : "at least one estimated"})`,
  };
}
