// ---------------------------------------------------------------------------
// protocol v1 -- A1: the token shadow measurement. Pure with respect to the
// wire: it reads the final text and payload, measures, and returns a record of
// numbers and classifications. `pipeline.ts` traces the record and never reads
// a selection out of it.
//
// WHAT IS MEASURED: the exact string each candidate would put on the wire,
// whole -- never a sum of fragment counts, because a token boundary can move
// across a join. What the host wraps around a tool result is outside this
// module's sight, so `boundary` says "tl-final-text" rather than implying a
// request-level figure.
//
// WHAT IS NOT RECORDED: body text, query, path, or a payload hash. A token count
// that cannot be produced is `null`, never 0.
//
// `virtual_*` answer "what would each policy have chosen here, under this
// call's real limit and profile", without enabling any of them: `byte_v1` is the
// auto gate (policy.ts), `byte_v2` the breakeven selector in bytes, and
// `token_v2` the same selector in this counter's tokens.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { BREAKEVEN_VERSION, tokenPolicyVersion } from "./breakeven.js";
import type { ClientProfile } from "./clientProfile.js";
import { EncodingCache } from "./encodingCache.js";
import {
  evaluateCandidatesWithRejections,
  HARD_JSON_FIXED_KINDS,
  isEligibleKind,
  selectForWire,
  type CodecCandidate,
} from "./policy.js";
import { isEligibleKindV2, measureCandidateUnits, restrictCandidatesForWidenedKind, safeHash, selectForWireV2 } from "./selectV2.js";
import { classifyShape } from "./shape.js";
import { byteCounter, type TokenCounter } from "./tokenCounter.js";
import { TokenCountRefused, type TokenizerResolution } from "./tokenizerResolver.js";
import type { CodecPayload } from "./types.js";

export interface TokenShadowCandidate {
  readonly codec: string;
  readonly bytes: number;
  readonly tokens: number | null;
  readonly byte_rank: number;
  readonly token_rank: number | null;
  /** Why selection could not use this candidate regardless of its gain; "eligible" otherwise. */
  readonly status: "eligible" | "byte-floor" | "over-limit" | "profile-not-allowed";
}

export interface TokenShadowRecord {
  readonly kind: Kind;
  readonly kind_class: "allowlist" | "widened" | "hard-json" | "other";
  readonly shape_class: string;
  readonly boundary: "tl-final-text";
  readonly counter_status: "measured" | "unavailable" | "refused";
  readonly counter_reason?: string;
  readonly tokenizer_id: string | null;
  /** Measurement class per the spec's table: an exact count under a named encoding, or nothing. */
  readonly measurement: "encoding-exact" | "unavailable";
  readonly model_mapping: "unverified";
  readonly policy_version: string;
  readonly breakeven_version: string;
  readonly client_profile_id: string;
  readonly limit: number;
  readonly json_bytes: number;
  readonly json_tokens: number | null;
  readonly candidates: readonly TokenShadowCandidate[];
  readonly rejected: ReadonlyArray<{ codec: string; reason: string }>;
  /** Over every candidate that round-tripped. */
  readonly rank_inverted: boolean | null;
  /** Over only the candidates selection could have taken: what an inversion can actually change. */
  readonly rank_inverted_eligible: boolean | null;
  readonly virtual_byte_v1: string;
  readonly virtual_byte_v2: string;
  readonly virtual_token_v2: string | null;
  readonly virtual_token_fallback: string | null;
  readonly init_ms: number | null;
  readonly count_ms: number;
  readonly cache_hits: number;
  readonly cache_misses: number;
}

export interface MeasureTokenShadowInput {
  readonly kind: Kind;
  readonly payload: CodecPayload;
  readonly jsonText: string;
  readonly jsonBytes: number;
  readonly limit: number;
  readonly clientProfile: ClientProfile;
  readonly tokenizer: Exclude<TokenizerResolution, { status: "disabled" }>;
  readonly cache: EncodingCache;
}

function kindClass(kind: Kind, profile: ClientProfile): TokenShadowRecord["kind_class"] {
  if (HARD_JSON_FIXED_KINDS.has(kind)) return "hard-json";
  if (isEligibleKind(kind)) return "allowlist";
  return kind === "read.text" || isEligibleKindV2(kind, profile) ? "widened" : "other";
}

/** Rank per candidate by `value`, ties sharing the lower rank. */
function ranks(values: readonly number[]): number[] {
  return values.map((value) => 1 + values.filter((other) => other < value).length);
}

export function measureTokenShadow(input: MeasureTokenShadowInput): TokenShadowRecord {
  const { kind, payload, jsonText, jsonBytes, limit, clientProfile, tokenizer, cache } = input;
  const klass = kindClass(kind, clientProfile);
  const { candidates: evaluated, rejected } = klass === "hard-json" || klass === "other"
    ? { candidates: [] as CodecCandidate[], rejected: [] }
    : evaluateCandidatesWithRejections(kind, payload);
  const usable = klass === "widened" ? restrictCandidatesForWidenedKind(kind, evaluated, clientProfile) : evaluated;

  const counter: (TokenCounter & { readonly initMs?: number }) | undefined = tokenizer.status === "ready" ? tokenizer.counter : undefined;
  let counterStatus: TokenShadowRecord["counter_status"] = counter === undefined ? "unavailable" : "measured";
  let counterReason: string | undefined = tokenizer.status === "unavailable" ? tokenizer.reason : undefined;
  let jsonTokens: number | null = null;
  const tokens: Array<number | null> = evaluated.map(() => null);
  const before = cache.stats();
  const started = performance.now();
  if (counter !== undefined) {
    const payloadHash = safeHash(payload);
    try {
      jsonTokens = measureCandidateUnits(counter, cache, payloadHash, "json", "1", jsonText, jsonBytes).units;
      evaluated.forEach((candidate, index) => {
        tokens[index] = measureCandidateUnits(
          counter, cache, payloadHash, candidate.codec.id, candidate.codec.version, candidate.text, candidate.bytes,
        ).units;
      });
    } catch (error) {
      // All or nothing: a partial comparison would rank what happened to fit.
      counterStatus = "refused";
      counterReason = error instanceof TokenCountRefused ? error.reason : "count-threw";
      jsonTokens = null;
      tokens.fill(null);
    }
  }
  const countMs = performance.now() - started;
  const after = cache.stats();

  const byteRanks = ranks(evaluated.map((candidate) => candidate.bytes));
  const measuredTokens = tokens.every((value): value is number => value !== null) ? tokens : undefined;
  const tokenRanks = measuredTokens === undefined ? undefined : ranks(measuredTokens);
  const usableSet = new Set(usable);
  const candidates = evaluated.map((candidate, index): TokenShadowCandidate => ({
    codec: `${candidate.codec.id}/${candidate.codec.version}`,
    bytes: candidate.bytes,
    tokens: tokens[index] ?? null,
    byte_rank: byteRanks[index]!,
    token_rank: tokenRanks?.[index] ?? null,
    status: !usableSet.has(candidate)
      ? "profile-not-allowed"
      : candidate.bytes >= jsonBytes
        ? "byte-floor"
        : candidate.bytes > limit
          ? "over-limit"
          : "eligible",
  }));

  // Inverted when two candidates order differently by bytes and by tokens.
  const invertedAmong = (indices: readonly number[]): boolean | null => tokenRanks === undefined || indices.length < 2
    ? null
    : indices.some((i) => indices.some((j) => byteRanks[i]! < byteRanks[j]! && tokenRanks[i]! > tokenRanks[j]!));
  const rankInverted = invertedAmong(evaluated.map((_, index) => index));
  const rankInvertedEligible = invertedAmong(evaluated.flatMap((_, index) => (candidates[index]!.status === "eligible" ? [index] : [])));

  const selectable = isEligibleKind(kind) || isEligibleKindV2(kind, clientProfile);
  const params = { kind, payload, jsonText, jsonBytes, candidates: selectable ? usable : [], limit, clientProfile };
  const byteV2 = selectForWireV2({ ...params, counter: byteCounter, cache: new EncodingCache(8) });
  let tokenChoice: string | null = null;
  let tokenFallback: string | null = null;
  if (counter !== undefined && counterStatus === "measured") {
    const tokenV2 = selectForWireV2({ ...params, counter, cache });
    tokenChoice = tokenV2.codecId;
    tokenFallback = tokenV2.fallbackReason;
  }

  return {
    kind,
    kind_class: klass,
    shape_class: classifyShape(payload, kind),
    boundary: "tl-final-text",
    counter_status: counterStatus,
    ...(counterReason !== undefined ? { counter_reason: counterReason } : {}),
    tokenizer_id: counter?.id ?? null,
    measurement: counterStatus === "measured" ? "encoding-exact" : "unavailable",
    model_mapping: "unverified",
    policy_version: tokenPolicyVersion(),
    breakeven_version: BREAKEVEN_VERSION,
    client_profile_id: clientProfile.id,
    limit,
    json_bytes: jsonBytes,
    json_tokens: jsonTokens,
    candidates,
    rejected: rejected.map((entry) => ({ codec: entry.codecId, reason: entry.reason })),
    rank_inverted: rankInverted,
    rank_inverted_eligible: rankInvertedEligible,
    virtual_byte_v1: isEligibleKind(kind) ? selectForWire("auto", payload, jsonText, jsonBytes, evaluated, limit).codecId : "json",
    virtual_byte_v2: byteV2.codecId,
    virtual_token_v2: tokenChoice,
    virtual_token_fallback: tokenFallback,
    init_ms: counter?.initMs ?? null,
    count_ms: Math.round(countMs * 100) / 100,
    cache_hits: after.hits - before.hits,
    cache_misses: after.misses - before.misses,
  };
}
