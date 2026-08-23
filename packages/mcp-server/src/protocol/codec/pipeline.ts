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
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { estimateTokensFromBytes } from "@tokenlighten/usage";
import { isTraceEnabled, trace } from "../../util/trace.js";
import { responseFormatMode, wireBreakevenEnabled, wireShadowEnabled } from "../../util/flags.js";
import { measureResponseBytes } from "../budget/measure.js";
import type { ProtocolCallContext } from "../envelope.js";
import { evaluateCandidates, isEligibleKind, selectForWire, type CodecCandidate } from "./policy.js";
import { resolveClientProfile } from "./clientProfile.js";
import { isEligibleKindV2, restrictCandidatesForWidenedKind, selectForWireV2, type SelectionResultV2 } from "./selectV2.js";
import { byteCounter, type TokenCounter } from "./tokenCounter.js";
import { EncodingCache } from "./encodingCache.js";
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
function emitV2CellTrace(kind: Kind, jsonBytes: number, result: SelectionResultV2, workspace: string): void {
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
    },
    workspace,
  );
}

const DEFAULT_V2_CACHE_SIZE = 256;
let sharedV2Cache: EncodingCache | undefined;

function getSharedV2Cache(): EncodingCache {
  if (sharedV2Cache === undefined) sharedV2Cache = new EncodingCache(DEFAULT_V2_CACHE_SIZE);
  return sharedV2Cache;
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
  try {
    const mode = responseFormatMode();
    // "debug" never touches the wire (invariant 2) but always wants the
    // full candidate comparison, independent of the separate shadow flag.
    const shadow = wireShadowEnabled() || mode === "debug";
    if (mode === "json" && !shadow) return text; // hottest path: zero extra work.

    const eligible = isEligibleKind(kind);
    const jsonBytes = measureResponseBytes(text);
    const candidates = eligible ? evaluateCandidates(kind, payload) : [];

    // D1 (F-C2a): the workspace to trace against. `workspace` is edit_file's
    // own late, authoritative note (finishEdit) -- moot for this module in
    // practice, since edit.applied is HARD_JSON_FIXED and never eligible
    // here. `codecTraceWorkspace` is the dedicated, trace-only note
    // read_file/search_files dispatch takes at entry (server.ts's
    // `dispatchWithWorkspaceNotes`) -- see ProtocolCallContext's own doc
    // comment for why this is a SEPARATE field from `workspace` (which
    // other, wire-affecting projectors also read).
    const traceWorkspace = context.workspace ?? context.codecTraceWorkspace;

    // V11-07: v2 is strictly auto-mode-gated (never compact/debug) AND
    // strictly TL_WIRE_BREAKEVEN-gated -- see the module header's
    // invariant-1 note. `resolveClientProfile` is a pure Map lookup (no
    // I/O), so computing it unconditionally here costs nothing on the
    // paths where it goes unused.
    const v2Active = mode === "auto" && wireBreakevenEnabled();
    const clientProfile = resolveClientProfile(context.clientId, v2Overrides?.now);
    const v2Eligible = v2Active && (eligible || isEligibleKindV2(kind, clientProfile));

    let selection: { text: string; codecId: string };
    if (v2Eligible) {
      // A base-allowlist kind already has its round-trip-proven candidates
      // (`candidates` above); the widened kind (read.text) never populated
      // that list (`eligible` is false for it), so it is evaluated fresh
      // here and then restricted to what E-3 actually authorizes.
      const v2Candidates = eligible
        ? candidates
        : restrictCandidatesForWidenedKind(kind, evaluateCandidates(kind, payload), clientProfile);
      const counter = v2Overrides?.counter ?? byteCounter;
      const cache = v2Overrides?.cache ?? getSharedV2Cache();
      const v2Result = selectForWireV2({
        kind, payload, jsonText: text, jsonBytes, candidates: v2Candidates, limit, clientProfile, counter, cache,
      });
      selection = { text: v2Result.text, codecId: v2Result.codecId };
      if (isTraceEnabled() && traceWorkspace !== undefined && traceWorkspace !== "") {
        emitV2CellTrace(kind, jsonBytes, v2Result, traceWorkspace);
      }
    } else {
      selection =
        (mode === "auto" || mode === "compact") && eligible
          ? selectForWire(mode, payload, text, jsonBytes, candidates, limit)
          : { text, codecId: "json" };
    }

    if (shadow && isTraceEnabled() && traceWorkspace !== undefined && traceWorkspace !== "") {
      emitShadowTrace(kind, jsonBytes, selection.codecId, candidates, traceWorkspace);
    }

    return selection.text;
  } catch {
    return text; // ANY codec-pipeline error -> json fallback, unconditionally.
  }
}
