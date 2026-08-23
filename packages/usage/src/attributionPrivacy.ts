/**
 * attributionPrivacy.ts — V11-08 Attribution & Calibration v2.
 *
 * Extends index.ts's `privacyReport()` coverage to the new V11-08 stores
 * (parsers/, sessionMatcher.ts, coefficientStore.ts, pricingSnapshots.ts,
 * featureContributions.ts, holdoutReport.ts) with a SEPARATE, package-local
 * report rather than modifying `TokenLightenPrivacyReport`
 * (@tokenlighten/types) — that type lives outside packages/usage/, and this
 * workstream's hard constraint is "no changes outside packages/usage". A
 * shared-type extension would be the more unified end state; recorded in
 * this workstream's final report as a follow-up for orchestrator
 * adjudication rather than done here.
 *
 * Static/descriptive, not computed from live data — same posture as
 * index.ts's own `privacyReport()`.
 */

export interface AttributionStorePrivacy {
  readonly store:
    | "parsers"
    | "sessionMatcher"
    | "coefficientStore"
    | "pricingSnapshots"
    | "featureContributions"
    | "holdoutReport";
  readonly containsPromptText: false;
  readonly containsSourceText: false;
  readonly containsCredentials: false;
  /** True only for `parsers`: a parsed session's `sessionCwd` is a real
   *  filesystem path, held IN MEMORY ONLY for the lifetime of the parse
   *  result. This module writes nothing to disk. A caller MUST hash it
   *  (e.g. via index.ts's `usageWorkspaceId`) before it is logged,
   *  persisted, or compared across process boundaries — sessionMatcher.ts
   *  itself never receives raw paths, only the already-opaque
   *  `workspaceId` a caller derived. */
  readonly containsRawPathsInMemoryOnly: boolean;
  readonly notes: string;
}

export interface AttributionPrivacyReport {
  readonly schemaVersion: 1;
  readonly localOnly: true;
  readonly automaticUpload: false;
  readonly stores: readonly AttributionStorePrivacy[];
}

export function attributionPrivacyReport(): AttributionPrivacyReport {
  return {
    schemaVersion: 1,
    localOnly: true,
    automaticUpload: false,
    stores: [
      {
        store: "parsers",
        containsPromptText: false,
        containsSourceText: false,
        containsCredentials: false,
        containsRawPathsInMemoryOnly: true,
        notes: "Parses provider log lines into NormalizedSessionUsage in memory; "
          + "token category values and model ids only, never prompt/source text. "
          + "sessionCwd is a real path kept in memory for workspace matching — "
          + "never written to disk by this package.",
      },
      {
        store: "sessionMatcher",
        containsPromptText: false,
        containsSourceText: false,
        containsCredentials: false,
        containsRawPathsInMemoryOnly: false,
        notes: "Matches on an ALREADY-OPAQUE workspaceId string the caller "
          + "supplies (equality comparison only) plus tool names/timestamps — "
          + "never hashes or receives a raw path itself.",
      },
      {
        store: "coefficientStore",
        containsPromptText: false,
        containsSourceText: false,
        containsCredentials: false,
        containsRawPathsInMemoryOnly: false,
        notes: "Task family strings, client names, and numeric coefficients "
          + "only.",
      },
      {
        store: "pricingSnapshots",
        containsPromptText: false,
        containsSourceText: false,
        containsCredentials: false,
        containsRawPathsInMemoryOnly: false,
        notes: "Model ids and USD-per-million-token rates only.",
      },
      {
        store: "featureContributions",
        containsPromptText: false,
        containsSourceText: false,
        containsCredentials: false,
        containsRawPathsInMemoryOnly: false,
        notes: "trace_id (an opaque per-process identity, matching "
          + "measurementEngine.ts's TelemetryEvent.trace_id), a feature name, "
          + "and a signed token count only.",
      },
      {
        store: "holdoutReport",
        containsPromptText: false,
        containsSourceText: false,
        containsCredentials: false,
        containsRawPathsInMemoryOnly: false,
        notes: "Pure reshape of the stores above; carries nothing new.",
      },
    ],
  };
}
