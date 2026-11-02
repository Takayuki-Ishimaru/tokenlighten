// ---------------------------------------------------------------------------
// protocol v1 -- V10-11 pipeline entrypoint: `emit.ts` calls exactly this one
// function, after the wire-budget ladder has produced the final semantic
// payload (today's stand-in for the design doc's PI-01 host-cap
// shedding/segmentation stage, which has not landed in this tree yet -- see
// this directory's `index.ts` header) and BEFORE the text is measured for
// the last time.
//
// SAFETY INVARIANTS (all enforced HERE, not trusted from callers):
//   1. Default path (`TOKENLIGHTEN_RESPONSE_FORMAT` unset, `TL_WIRE_SHADOW`
//      unset) returns `text` UNCHANGED, with NO extra work at all -- this is
//      what keeps `wireBaselines.spec.ts`/`replayCorpus.spec.ts` green
//      without regeneration.
//   2. Shadow mode (`TL_WIRE_SHADOW=1`, or `TOKENLIGHTEN_RESPONSE_FORMAT=debug`)
//      NEVER changes the returned text, regardless of what it measures or logs.
//   3. Any exception anywhere in this module is caught here and answered
//      with the original `text` -- a codec defect degrades to "shipped as
//      json", never to a thrown response.
//
// V11-07 addendum (Adaptive Wire Encoding v2). A SECOND selection path,
// `selectV2.ts`'s `selectForWireV2`, runs ONLY when BOTH
// `TOKENLIGHTEN_RESPONSE_FORMAT=auto` AND `TL_WIRE_BREAKEVEN` are active
// (`v2Active` below) -- with either one unset (the default for both), this
// module takes EXACTLY the branch it took before v2 existed, so invariant 1
// above still holds unconditionally. v2 adds no new invariant of its own:
// it runs inside the SAME try/catch (invariant 3), and it can only ever
// choose a candidate `evaluateCandidates` already round-trip-proved.
//
// A1/A2 addendum (2026-10-30). The shadow path also measures every candidate in
// a real tokenizer when TL_WIRE_TOKENIZER names one (tokenShadow.ts), under
// invariant 2; TL_WIRE_TOKEN_SELECT makes the v2 path above compare in those
// tokens, falling back to its byte comparison on any failure. The text a token
// choice was measured on is the text returned here, and emit.ts does not change
// it afterwards. `callTool`'s later projection may rewrite a JSON reply's
// `next`, but it parses the reply as JSON and so leaves a codec-encoded one alone.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { estimateTokensFromBytes } from "@tokenlighten/usage";
import { isTraceEnabled, trace } from "../../util/trace.js";
import { responseFormatMode, wireBreakevenEnabled, wireShadowEnabled, wireStableEnabled, wireTokenSelectEnabled } from "../../util/flags.js";
import { measureResponseBytes } from "../budget/measure.js";
import type { ProtocolCallContext } from "../envelope.js";
import { tokenPolicyVersion } from "./breakeven.js";
import { evaluateCandidates, isEligibleKind, selectForWire, type CodecCandidate } from "./policy.js";
import { resolveClientProfile, type ClientProfile } from "./clientProfile.js";
import {
  isEligibleKindV2,
  restrictCandidatesForWidenedKind,
  selectForWireV2,
  type SelectForWireV2Params,
  type SelectionResultV2,
} from "./selectV2.js";
import { byteCounter, type TokenCounter } from "./tokenCounter.js";
import { resolveWireTokenizer, TokenCountRefused } from "./tokenizerResolver.js";
import { measureTokenShadow } from "./tokenShadow.js";
import { EncodingCache } from "./encodingCache.js";
import { hostCounterActive } from "./hostSelect.js";
import { canonicalKeyOrder, noteReplyRepeat } from "./stableSerialization.js";
import type { CodecPayload } from "./types.js";

function emitShadowTrace(
  kind: Kind,
  jsonBytes: number,
  chosenCodecId: string,
  candidates: readonly CodecCandidate[],
  workspace: string,
): void {
  for (const candidate of candidates) {
    const codecId = `${candidate.codec.id}/${candidate.codec.version}`;
    trace(
      "wire_codec_shadow",
      {
        kind,
        codec: codecId,
        json_bytes: jsonBytes,
        codec_bytes: candidate.bytes,
        est_tokens: estimateTokensFromBytes(candidate.bytes),
        chosen: codecId === chosenCodecId,
      },
      workspace,
    );
  }
}

/**
 * V11-07: one `wire_codec_v2_cell` record per response that actually ran v2
 * selection -- ADDITIVE to the `wire_codec_shadow` family above (a
 * DIFFERENT event name, never a shape change to `wire_codec_shadow` itself,
 * which stays pinned exactly as wireCodecShadow.spec.ts proves it today).
 * `malformed` is always `false`: every candidate `selectForWireV2` ever
 * sees already passed `evaluateCandidates`'s round-trip oracle, so a v2
 * cell can never actually observe a malformed/misparsing candidate -- the
 * field exists to make that invariant directly visible in the trace
 * stream, not to report a branch this module can actually take.
 */
function emitV2CellTrace(kind: Kind, jsonBytes: number, result: SelectionResultV2, workspace: string, tokenFallback?: string): void {
  const inTokens = result.tokenizerId !== byteCounter.id && result.jsonUnits !== undefined;
  trace(
    "wire_codec_v2_cell",
    {
      kind,
      codec: result.codecId,
      json_bytes: jsonBytes,
      fallback_reason: result.fallbackReason,
      tokenizer_id: result.tokenizerId,
      client_profile_id: result.clientProfileId,
      shape_class: result.shapeClass,
      cache_hit: result.cacheHit,
      malformed: false,
      // A2 only, so a byte-selected record keeps its pinned shape.
      ...(inTokens ? {
        selection_basis: "tokens",
        policy_version: tokenPolicyVersion(),
        model_mapping: "unverified",
        json_units: result.jsonUnits,
        chosen_units: result.chosenUnits ?? result.jsonUnits,
      } : {}),
      ...(tokenFallback !== undefined ? { selection_basis: "bytes-fallback", token_fallback: tokenFallback } : {}),
    },
    workspace,
  );
}

const DEFAULT_V2_CACHE_SIZE = 256;
/** Text retained across the shared cache, in UTF-16 units. A design bound: roughly sixty responses at the 128 KB counting ceiling. */
const DEFAULT_V2_CACHE_RETAINED_CHARS = 8 * 1024 * 1024;
let sharedV2Cache: EncodingCache | undefined;

function getSharedV2Cache(): EncodingCache {
  if (sharedV2Cache === undefined) sharedV2Cache = new EncodingCache(DEFAULT_V2_CACHE_SIZE, DEFAULT_V2_CACHE_RETAINED_CHARS);
  return sharedV2Cache;
}

/**
 * A1: at most one `wire_codec_token_shadow` per response, and only when a
 * tokenizer was asked for -- TL_WIRE_SHADOW alone keeps exactly the records it
 * always wrote. Its own try/catch: a defect in a diagnostic must not reach
 * invariant 3's json fallback and cost a selection already made.
 */
function emitTokenShadowTrace(
  kind: Kind,
  payload: CodecPayload,
  text: string,
  jsonBytes: number,
  limit: number,
  clientProfile: ClientProfile,
  cache: EncodingCache,
  workspace: string,
): void {
  try {
    const tokenizer = resolveWireTokenizer();
    if (tokenizer.status === "disabled") return;
    const record = measureTokenShadow({ kind, payload, jsonText: text, jsonBytes, limit, clientProfile, tokenizer, cache });
    trace("wire_codec_token_shadow", { ...record }, workspace);
  } catch { /* the diagnostic is lost; the response is not */ }
}

/**
 * A2: the byte comparison v2 has always made, unless TL_WIRE_TOKEN_SELECT asks
 * for tokens and a counter can answer for this exact payload. Every other outcome
 * selects in bytes and carries the reason, so a record can never say a choice
 * was made in tokens when it was not. An injected counter bypasses all of this:
 * it is the caller's explicit choice, and failures remain its own.
 */
function selectV2WithTokenFallback(
  params: Omit<SelectForWireV2Params, "counter">,
  override: TokenCounter | undefined,
): { result: SelectionResultV2; tokenFallback?: string } {
  if (override !== undefined) return { result: selectForWireV2({ ...params, counter: override }) };
  if (!wireTokenSelectEnabled()) return { result: selectForWireV2({ ...params, counter: byteCounter }) };
  const tokenizer = resolveWireTokenizer();
  if (tokenizer.status !== "ready") {
    return {
      result: selectForWireV2({ ...params, counter: byteCounter }),
      tokenFallback: tokenizer.status === "disabled" ? "tokenizer-not-configured" : tokenizer.reason,
    };
  }
  try {
    const result = selectForWireV2({ ...params, counter: tokenizer.counter });
    if (result.fallbackReason !== "no-token-policy") return { result };
    return { result: selectForWireV2({ ...params, counter: byteCounter }), tokenFallback: "no-token-policy" };
  } catch (error) {
    return {
      result: selectForWireV2({ ...params, counter: byteCounter }),
      tokenFallback: error instanceof TokenCountRefused ? error.reason : "count-threw",
    };
  }
}

/** Test-only: forces the next `applyResponseCodec` call to build a fresh shared v2 cache, so hit/miss counts do not leak across specs. */
export function resetV2CacheForTest(): void {
  sharedV2Cache = undefined;
}

/**
 * V11-07 injection seam for a real/fake TokenCounter and/or a private
 * EncodingCache -- see tokenCounter.ts's header and
 * __tests__/wireCodecV2Selection.spec.ts's `fakeTokenCounter`. `now`
 * overrides `Date.now()` for client-profile staleness resolution. Every
 * field is optional; omitting all of them reproduces production behaviour
 * exactly (byteCounter, the shared cache, the real clock).
 */
export interface ApplyResponseCodecV2Overrides {
  readonly counter?: TokenCounter;
  readonly cache?: EncodingCache;
  readonly now?: number;
}

/**
 * `text`/`payload` are the funnel's final, validated JSON pair for this
 * response (`emit.ts`'s `text`/`current` after the ladder and required-set
 * enforcement -- see that module). `limit` is the same wire budget `emit.ts`
 * already computed. Returns the text to actually put on the wire.
 */
export function applyResponseCodec(
  text: string,
  payload: CodecPayload,
  kind: Kind,
  context: ProtocolCallContext,
  limit: number,
  v2Overrides?: ApplyResponseCodecV2Overrides,
): string {
  // B5: outside the try below, so a failure here keeps the reply as it stood. Key
  // order alone moves, so `limit` and every byte measure above still hold.
  if (wireStableEnabled()) {
    try {
      const stable = canonicalKeyOrder(JSON.parse(text) as CodecPayload);
      const stableText = JSON.stringify(stable);
      const workspace = context.workspace ?? context.codecTraceWorkspace;
      if (isTraceEnabled() && workspace !== undefined && workspace !== "") {
        trace("wire_stability", { kind, bytes: measureResponseBytes(stableText), key_order_changed: stableText !== text, repeat_of_prior: noteReplyRepeat(stableText) }, workspace);
      }
      text = stableText;
      payload = canonicalKeyOrder(payload);
    } catch { /* not JSON, or not ours to reorder */ }
  }
  try {
    const mode = responseFormatMode();
    // "debug" never touches the wire (invariant 2) but always wants the
    // full candidate comparison, independent of the separate shadow flag.
    const shadow = wireShadowEnabled() || mode === "debug";
    if (mode === "json" && !shadow) return text; // hottest path: zero extra work.

    const eligible = isEligibleKind(kind);
    const jsonBytes = measureResponseBytes(text);
    const candidates = eligible ? evaluateCandidates(kind, payload) : [];

    // D1 (F-C2a): the workspace to trace against. `workspace` is tl_edit_file's
    // own late, authoritative note (finishEdit) -- moot for this module in
    // practice, since edit.applied is HARD_JSON_FIXED and never eligible
    // here. `codecTraceWorkspace` is the dedicated, trace-only note
    // tl_read_file/tl_search_files dispatch takes at entry (server.ts's
    // `dispatchWithWorkspaceNotes`) -- see ProtocolCallContext's own doc
    // comment for why this is a SEPARATE field from `workspace` (which
    // other, wire-affecting projectors also read).
    const traceWorkspace = context.workspace ?? context.codecTraceWorkspace;

    // V11-07: v2 is strictly auto-mode-gated (never compact/debug) AND
    // strictly TL_WIRE_BREAKEVEN-gated -- see the module header's
    // invariant-1 note. `resolveClientProfile` is a pure Map lookup (no
    // I/O), so computing it unconditionally here costs nothing on the
    // paths where it goes unused.
    // B6: a host's counts are asynchronous, so hostSelect.ts chooses after this funnel,
    // from the JSON reply left here. Nothing else about the reply differs.
    const v2Active = mode === "auto" && wireBreakevenEnabled() && !hostCounterActive();
    const clientProfile = resolveClientProfile(context.clientId, v2Overrides?.now);
    const v2Eligible = v2Active && (eligible || isEligibleKindV2(kind, clientProfile));

    let selection: { text: string; codecId: string };
    if (mode === "auto" && hostCounterActive()) {
      selection = { text, codecId: "json" };
    } else if (v2Eligible) {
      // A base-allowlist kind already has its round-trip-proven candidates
      // (`candidates` above); the widened kind (read.text) never populated
      // that list (`eligible` is false for it), so it is evaluated fresh
      // here and then restricted to what E-3 actually authorizes.
      const v2Candidates = eligible
        ? candidates
        : restrictCandidatesForWidenedKind(kind, evaluateCandidates(kind, payload), clientProfile);
      const cache = v2Overrides?.cache ?? getSharedV2Cache();
      const { result: v2Result, tokenFallback } = selectV2WithTokenFallback(
        { kind, payload, jsonText: text, jsonBytes, candidates: v2Candidates, limit, clientProfile, cache },
        v2Overrides?.counter,
      );
      selection = { text: v2Result.text, codecId: v2Result.codecId };
      if (isTraceEnabled() && traceWorkspace !== undefined && traceWorkspace !== "") {
        emitV2CellTrace(kind, jsonBytes, v2Result, traceWorkspace, tokenFallback);
      }
    } else {
      selection =
        (mode === "auto" || mode === "compact") && eligible
          ? selectForWire(mode, payload, text, jsonBytes, candidates, limit)
          : { text, codecId: "json" };
    }

    if (shadow && isTraceEnabled() && traceWorkspace !== undefined && traceWorkspace !== "") {
      emitShadowTrace(kind, jsonBytes, selection.codecId, candidates, traceWorkspace);
      emitTokenShadowTrace(kind, payload, text, jsonBytes, limit, clientProfile, v2Overrides?.cache ?? getSharedV2Cache(), traceWorkspace);
    }

    return selection.text;
  } catch {
    return text; // ANY codec-pipeline error -> json fallback, unconditionally.
  }
}
