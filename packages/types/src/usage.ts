/**
 * Privacy-preserving usage contracts.
 *
 * These records deliberately cannot represent prompts, file paths, source
 * text, tool arguments, or error messages. Producers must derive aggregate
 * numbers in memory and discard the source values before writing an event.
 */
export type TokenLightenClient =
  | "vscode"
  | "codex"
  | "claude-code"
  | "desktop"
  | "other";

export type TokenLightenTool = "read_file" | "search_files" | "edit_file";

export interface TokenLightenUsageEvent {
  /**
   * 1: the original closed field set (no `taskRef`). 2 (2026-08-30, v0.13):
   * adds `taskRef` below so `summarizeUsage` can group a multi-call TASK's
   * events before computing a reduction ratio. Both versions are read back
   * by `isUsageEvent`, which validates against a CLOSED field set keyed on
   * this value — widening the event shape without versioning it would make
   * every already-written schemaVersion:1 NDJSON line fail that check and
   * silently vanish from every summary. Every recorder writes 2 going
   * forward; 1 is accepted on read only, for logs written before this field
   * existed.
   */
  schemaVersion: 1 | 2;
  eventId: string;
  occurredAt: string;
  workspaceId: string;
  sessionId: string;
  client: TokenLightenClient;
  tool: TokenLightenTool;
  outcome: "ok" | "error";
  durationMs: number;
  responseBytes: number;
  estimatedResponseTokens: number;
  baselineTokens: number | null;
  /** Signed baseline minus TL response tokens; negative means TL added tokens. */
  estimatedSavedTokens: number | null;
  baselineMethod: "file-bytes" | null;
  writeEnabled: boolean;
  /**
   * schemaVersion:2 only — absent on a schemaVersion:1 line. An OPAQUE
   * per-workspace task-correlation id (`server.ts`'s `taskQueryRef`: a SHA-256
   * digest of workspaceRoot+query, never the raw query text or a file path —
   * consistent with this file's "no prompts, no paths, no source text"
   * contract above). `null` when this call named no task (e.g. a bare
   * handle/path edit with no `query`/`qref`). Lets `summarizeUsage` group the
   * calls of one exploratory task — an initial query call that carries no
   * baseline of its own, followed by a qref+targets continuation whose
   * baseline covers the WHOLE task — instead of scoring each call in
   * isolation, which understated the true reduction ratio.
   */
  taskRef?: string | null;
}

export interface TokenLightenAutomaticPrice {
  model: string;
  /** Compatibility alias for the standard uncached input rate. */
  costPerMillionTokensUsd: number;
  inputUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

export interface TokenLightenSessionModelUsage {
  client: TokenLightenClient;
  model: string;
  requestCount: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCostUsd: number | null;
  pricingStatus: "model" | "manual" | "unknown";
}

export interface TokenLightenReductionInterval {
  low: number;
  high: number;
}

/** Scope of a usage summary. A workspace scope carries the salted hash of the
 *  workspace root; workspaceId is null when no usage was ever recorded on this
 *  machine (no privacy salt yet), and such a scope matches no events. */
export type TokenLightenSummaryScope =
  | { kind: "machine" }
  | { kind: "workspace"; workspaceId: string | null };

export interface TokenLightenSessionEstimate {
  status: "estimated" | "provider-logs-unavailable";
  method: "local-ai-logs+deterministic-calibration";
  actualTotalTokens: number | null;
  predictedWithoutTlTokens: number | null;
  predictedSavedTokens: number | null;
  tokenReductionPercent: number | null;
  tokenReductionPercent95: TokenLightenReductionInterval | null;
  actualTotalCostUsd: number | null;
  predictedWithoutTlCostUsd: number | null;
  predictedSavedCostUsd: number | null;
  costReductionPercent: number | null;
  costReductionPercent95: TokenLightenReductionInterval | null;
  confidence: "unavailable" | "low" | "medium" | "high";
  matchedSessions: number;
  models: TokenLightenSessionModelUsage[];
  residencyModel: {
    version: "residual-turns-v1";
    meanTurnsByClient: Partial<Record<TokenLightenClient, number>>;
    residualFactorByClient: Partial<Record<TokenLightenClient, number>>;
  } | null;
  unpricedTokenShare: number | null;
  warnings: string[];
  calibration: {
    version: string;
    calibratedAt: string | null;
    source: "analytic-fallback" | "paired-derived";
    rawPairedBillingIncluded: false;
    sampleCount: number;
  };
}

export interface TokenLightenUsageSummary {
  schemaVersion: 2;
  generatedAt: string;
  scope: TokenLightenSummaryScope;
  eventCount: number;
  successfulCalls: number;
  failedCalls: number;
  estimatedResponseTokens: number;
  measuredBaselineCalls: number;
  measuredResponseTokens: number;
  measuredBaselineTokens: number;
  measuredResponseBytes: number;
  measuredBaselineBytes: number;
  measurementUnavailableReason?: "recorder-off" | "log-dir-unavailable" | "scope-mismatch";
  /** Net signed savings after subtracting calls where TL added tokens. */
  estimatedSavedTokens: number;
  /** @deprecated Use estimatedTokenReductionPercent. */
  estimatedReductionPercent: number | null;
  estimatedTokenReductionPercent: number | null;
  estimatedBaselineCostUsd: number | null;
  estimatedCostReductionPercent: number | null;
  pricingMode: "automatic" | "manual";
  costPerMillionTokensUsd: number | null;
  automaticPricing: {
    asOf: string;
    byClient: Record<TokenLightenClient, TokenLightenAutomaticPrice>;
  };
  estimatedSavedCostUsd: number | null;
  /** Full-session actual usage plus deterministic no-TL counterfactual. */
  sessionEstimate: TokenLightenSessionEstimate;
  byTool: Record<TokenLightenTool, number>;
  byClient: Record<TokenLightenClient, number>;
}

export interface TokenLightenPrivacyReport {
  schemaVersion: 1;
  generatedAt: string;
  localOnly: true;
  automaticUpload: false;
  containsPromptText: false;
  containsFilePaths: false;
  containsSourceText: false;
  containsToolArguments: false;
  containsErrorMessages: false;
  recordedFields: readonly (keyof TokenLightenUsageEvent)[];
}

export interface TokenLightenUsageExportManifest {
  schemaVersion: 1;
  generatedAt: string;
  format: "tokenlighten-usage-bundle";
  files: readonly [
    "manifest.json",
    "usage.ndjson",
    "summary.json",
    "diagnostics.json",
    "privacy-report.json",
  ];
}
