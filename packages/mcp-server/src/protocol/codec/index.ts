// ---------------------------------------------------------------------------
// protocol v1 -- V10-11 Adaptive Wire Encoding, package barrel.
//
// See DESIGN-v0.10-expansion-plan-v1.3.md V10-11 for the full workstream
// spec (groundwork scope: abstraction + shadow measurement + opt-in
// compact; NOT the later "limited default-on for safe read-only kinds"
// step the design doc also describes -- that is out of scope for this
// commit and remains gated behind TOKENLIGHTEN_RESPONSE_FORMAT's default
// "json").
//
// PIPELINE PLACEMENT. The design doc's own emitter sketch (V10-11 point 2,
// and PI-01's two-stage emitter, PI-01 point 2) puts codec encoding AFTER
// host-cap shedding/segmentation produces the final semantic payload, and
// requires re-measuring through the one sanctioned byte counter afterwards.
// PI-01 (`HostBudgetProfile`, the two-stage control-first emitter) has not
// landed in this tree yet -- it is its own P0 work item, scoped later than
// V10-11's groundwork (confirmed absent: no file or symbol named "PI-01"
// exists anywhere in this tree or on `develop`, 2026-08-20). Its stand-in
// TODAY is `emit.ts`'s existing `runLadder`/`wireBudget.ts` per-kind budget
// table, which already is this server's host-cap shedding/segmentation
// stage. `applyResponseCodec` is therefore wired into `emit.ts` immediately
// after the ladder (and the required-set/failClosed refusal-conversion
// tail) produces its final `text`/`current` pair, and re-measures via
// `budget/measure.ts` -- the same placement PI-01 will occupy once it
// exists, under its own workstream.
// ---------------------------------------------------------------------------

export type { CodecPayload, ResponseCodec } from "./types.js";
export { canonicalEqual, isPlainObject, isPrimitive, UnsupportedShapeError } from "./types.js";
export { jsonCodec } from "./jsonCodec.js";
export { tlTable1Codec } from "./tlTable1.js";
export { tlRaw1Codec } from "./tlRaw1.js";
export { toon41Codec } from "./toon.js";
export { CODECS_BY_ID, NON_JSON_CANDIDATES } from "./registry.js";
export {
  evaluateCandidates,
  isEligibleKind,
  selectForWire,
  HARD_JSON_FIXED_KINDS,
  MIN_ABSOLUTE_GAIN_BYTES,
  MIN_RELATIVE_GAIN,
  MIN_ROWS,
  NON_JSON_ALLOWLIST,
  type CodecCandidate,
  type ResponseFormatMode,
  type SelectionResult,
} from "./policy.js";
export { countUniformArrayRows, isPositionalRowsShape } from "./shape.js";
export { applyResponseCodec, resetV2CacheForTest, type ApplyResponseCodecV2Overrides } from "./pipeline.js";
export { classifyShape, type ShapeClass } from "./shape.js";
export { byteCounter, type TokenCounter } from "./tokenCounter.js";
export {
  resolveClientProfile,
  isCodecAllowedForClient,
  isProfileStale,
  UNKNOWN_CLIENT_PROFILE,
  PROFILE_STALE_AFTER_MS,
  type ClientProfile,
} from "./clientProfile.js";
export {
  resolveBreakevenThresholds,
  BREAKEVEN_VERSION,
  GLOBAL_DEFAULT_THRESHOLDS,
  type BreakevenThresholds,
  type BreakevenCellKey,
} from "./breakeven.js";
export {
  EncodingCache,
  hashSemanticPayload,
  type EncodingCacheKey,
  type CachedMeasurement,
  type EncodingCacheStats,
} from "./encodingCache.js";
export {
  selectForWireV2,
  isEligibleKindV2,
  restrictCandidatesForWidenedKind,
  type SelectionResultV2,
  type FallbackReasonV2,
  type SelectForWireV2Params,
} from "./selectV2.js";
