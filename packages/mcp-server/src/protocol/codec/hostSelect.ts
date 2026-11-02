// ---------------------------------------------------------------------------
// protocol v1 -- B6: selection in a host's own counts.
//
// `emitFinalizedPayload` is synchronous and a host counter is not, so this runs once
// more at the one asynchronous point after it, on the finished JSON reply: count the
// reply and its candidates, choose with the same `selectForWireV2`, and swap the
// spelling. A codec only re-spells the canonical payload the funnel already settled,
// so coverage, the ledger and every `next` are untouched. Byte floor and host limit
// are the same hard gates: a candidate must be smaller than this reply, which already
// fits, so `limit` is its own size.
//
// With no usable host this makes the selection the server makes without one, and any
// other failure returns the reply as it stood. Only the configured path reaches any of
// this; see `hostCounterActive`.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { isTraceEnabled, trace } from "../../util/trace.js";
import { responseFormatMode, wireBreakevenEnabled, wireHostCounterSocket, wireTokenSelectEnabled } from "../../util/flags.js";
import { measureResponseBytes } from "../budget/measure.js";
import { tokenPolicyVersion } from "./breakeven.js";
import { resolveClientProfile } from "./clientProfile.js";
import { EncodingCache } from "./encodingCache.js";
import { connectHostCounter, type HostCounterConnection } from "./hostCounterSocket.js";
import { precountForHost, type HostCounterBridge, type HostPrecount } from "./hostTokenCounter.js";
import { evaluateCandidates, isEligibleKind } from "./policy.js";
import { isEligibleKindV2, restrictCandidatesForWidenedKind, selectForWireV2 } from "./selectV2.js";
import { byteCounter } from "./tokenCounter.js";
import { resolveWireTokenizer } from "./tokenizerResolver.js";
import type { CodecPayload } from "./types.js";

/** A design bound: a slow host must cost a reply no more than this. */
const HOST_COUNT_TIMEOUT_MS = 1_500;
/** After a timeout the host is not asked again for this long, so a stuck one costs one reply and not all of them. */
const HOST_PAUSE_AFTER_TIMEOUT_MS = 60_000;
let hostPausedUntil = 0;

let connection: { socket: string; link: HostCounterConnection } | undefined;

/** True when selection is deferred to this stage, so the funnel leaves the reply as JSON. */
export function hostCounterActive(): boolean {
  return wireHostCounterSocket() !== undefined && wireTokenSelectEnabled() && responseFormatMode() === "auto" && wireBreakevenEnabled();
}

function currentBridge(): HostCounterBridge | undefined {
  const socket = wireHostCounterSocket();
  if (socket === undefined) return undefined;
  if (connection?.socket !== socket) {
    connection?.link.close();
    connection = { socket, link: connectHostCounter(socket, process.env["TL_WIRE_HOST_COUNTER_TOKEN"] ?? "") };
  }
  return connection.link.bridge();
}

/** The reply to send: `text`, or a smaller spelling of it when the host's counts say so. */
export async function applyHostCountedCodec(
  text: string,
  clientId: string | undefined,
  workspace: string | undefined,
  options: { getBridge?: () => HostCounterBridge | undefined; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  try {
    if (options.getBridge === undefined && !hostCounterActive()) return text;
    let payload: CodecPayload;
    try {
      payload = JSON.parse(text) as CodecPayload;
    } catch {
      return text;
    }
    const kind = payload["kind"] as Kind;
    const clientProfile = resolveClientProfile(clientId);
    const eligible = isEligibleKind(kind);
    if (!eligible && !isEligibleKindV2(kind, clientProfile)) return text;
    const candidates = eligible ? evaluateCandidates(kind, payload) : restrictCandidatesForWidenedKind(kind, evaluateCandidates(kind, payload), clientProfile);
    if (candidates.length === 0) return text;
    const precount: HostPrecount = Date.now() < hostPausedUntil
      ? { status: "unavailable", reason: "timeout" }
      : await precountForHost(options.getBridge ?? currentBridge, [text, ...candidates.map((candidate) => candidate.text)], {
        timeoutMs: options.timeoutMs ?? HOST_COUNT_TIMEOUT_MS,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    const traceTo = isTraceEnabled() && workspace !== undefined && workspace !== "" ? workspace : undefined;
    const bytes = measureResponseBytes(text);
    const selection = { kind, payload, jsonText: text, jsonBytes: bytes, candidates, limit: bytes, clientProfile };
    if (precount.status !== "ready") {
      if (precount.reason === "timeout" && Date.now() >= hostPausedUntil) hostPausedUntil = Date.now() + HOST_PAUSE_AFTER_TIMEOUT_MS;
      if (traceTo !== undefined) trace("wire_codec_host_select", { kind, status: "unavailable", reason: precount.reason }, traceTo);
      // No host's count to go by: the selection this server makes without one, in the
      // local tokenizer when it has one and in bytes otherwise.
      const local = resolveWireTokenizer();
      if (local.status === "ready") {
        try {
          const inTokens = selectForWireV2({ ...selection, counter: local.counter, cache: new EncodingCache(16) });
          if (inTokens.fallbackReason !== "no-token-policy") return inTokens.text;
        } catch { /* refused: bytes below */ }
      }
      return selectForWireV2({ ...selection, counter: byteCounter, cache: new EncodingCache(16) }).text;
    }
    const result = selectForWireV2({ ...selection, counter: precount.counter, cache: new EncodingCache(16) });
    if (traceTo !== undefined) {
      trace("wire_codec_host_select", {
        kind,
        status: "selected",
        codec: result.codecId,
        fallback_reason: result.fallbackReason,
        tokenizer_id: precount.counter.id,
        count_method: precount.counter.method,
        policy_version: tokenPolicyVersion(),
        json_units: result.jsonUnits,
        chosen_units: result.chosenUnits ?? result.jsonUnits,
      }, traceTo);
    }
    return result.text;
  } catch {
    return text;
  }
}

/** Test-only: forget the shared connection. */
export function resetHostCounterForTest(): void {
  hostPausedUntil = 0;
  connection?.link.close();
  connection = undefined;
}
