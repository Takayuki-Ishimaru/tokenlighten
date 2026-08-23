// ---------------------------------------------------------------------------
// protocol v1 -- V10-11 selection policy: WHEN a non-json codec may be used.
//
// This is the ONLY module that decides desirability (row counts, byte gain
// thresholds, the allowlist, the hard-fixed-json kinds). Every codec module
// answers only "can I represent this payload" (`canEncode`); this module
// answers "should this response use anything other than json".
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { measureResponseBytes } from "../budget/measure.js";
import { NON_JSON_CANDIDATES } from "./registry.js";
import { countUniformArrayRows } from "./shape.js";
import { canonicalEqual, type CodecPayload, type ResponseCodec } from "./types.js";

/**
 * Kinds V10-11 may EVER consider for non-json encoding. Deliberately closed
 * and code-level (not a further env var): the design doc's own D10 posture
 * is that a protocol-affecting switch belongs in code, reviewed per commit,
 * not multiplied into another runtime knob -- this list, plus
 * `HARD_JSON_FIXED_KINDS` below, together ARE V10-11's "kind-level kill
 * switch" (a kind absent from both is simply never touched; the design
 * doc's `TOKENLIGHTEN_RESPONSE_FORMAT` note about a kind-level kill switch
 * is satisfied by this closed, auditable set rather than a second env var).
 *
 * `read.text` and `search.tree` are deliberately absent: the design doc
 * marks `read.text`'s raw-block path as starting from shadow/opt-in only
 * (not yet allowlisted), and `search.tree` was never named as a V10-11
 * target.
 */
export const NON_JSON_ALLOWLIST: ReadonlySet<Kind> = new Set<Kind>([
  "search.matches",
  "search.references",
  "read.map",
  "read.batch",
  "read.artifact",
]);

/**
 * Coverage/control-surface kinds that are ALWAYS json, even under
 * `TOKENLIGHTEN_RESPONSE_FORMAT=compact`. Checked independently of (and
 * before) `NON_JSON_ALLOWLIST` -- the two sets are disjoint by construction;
 * this is defense in depth against a future edit accidentally widening the
 * allowlist to include one of these.
 */
export const HARD_JSON_FIXED_KINDS: ReadonlySet<Kind> = new Set<Kind>([
  "refusal",
  "edit.applied",
  "edit.reclassified",
  "edit.rolled_back",
  "edit.state_unknown",
  "read.receipt",
  "read.closure",
  "read.task_pack",
]);

/** V10-11 acceptance: ">=10% per eligible response" is the floor this
 *  threshold enforces at the single-response granularity `pipeline.ts`
 *  operates at (DESIGN-v0.10-expansion-plan-v1.3.md V10-11, "eligible
 *  response token reduction 10% or more"). */
export const MIN_RELATIVE_GAIN = 0.10;
export const MIN_ABSOLUTE_GAIN_BYTES = 64;
export const MIN_ROWS = 3;

export type ResponseFormatMode = "json" | "auto" | "compact" | "debug";

export interface CodecCandidate {
  readonly codec: ResponseCodec;
  readonly text: string;
  readonly bytes: number;
}

/** True iff `kind` may EVER be considered for non-json encoding. */
export function isEligibleKind(kind: Kind): boolean {
  return NON_JSON_ALLOWLIST.has(kind) && !HARD_JSON_FIXED_KINDS.has(kind);
}

/**
 * Every candidate that (a) claims it can encode `payload`, and (b) PROVES it
 * round-trips canonically before its bytes are ever trusted. Sorted
 * ascending by measured wire bytes (smallest first). A candidate whose
 * `canEncode`/`encode`/`decode` throws, or whose decode does not canonically
 * equal `payload`, is silently excluded -- never surfaced as an error.
 */
export function evaluateCandidates(kind: Kind, payload: CodecPayload): CodecCandidate[] {
  const out: CodecCandidate[] = [];
  for (const codec of NON_JSON_CANDIDATES) {
    try {
      if (!codec.canEncode(kind, payload)) continue;
      const text = codec.encode(payload);
      const decoded = codec.decode(text);
      if (!canonicalEqual(decoded, payload)) continue;
      out.push({ codec, text, bytes: measureResponseBytes(text) });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.bytes - b.bytes);
  return out;
}

export interface SelectionResult {
  readonly text: string;
  readonly codecId: string; // "json" when nothing else was chosen
}

/**
 * The live (wire-affecting) decision: given the candidates `evaluateCandidates`
 * already proved round-trip-correct, choose one iff `mode` and the gain
 * thresholds allow it, and iff its bytes do not exceed `limit` (the same
 * wire budget `emit.ts` already computed for this response -- "never exceed
 * the host cap").
 */
export function selectForWire(
  mode: ResponseFormatMode,
  payload: CodecPayload,
  jsonText: string,
  jsonBytes: number,
  candidates: readonly CodecCandidate[],
  limit: number,
): SelectionResult {
  // Defense in depth: `pipeline.ts` only calls this for mode "auto"/
  // "compact", but a future caller mistake must not silently start choosing
  // non-json output under "json"/"debug".
  if (mode !== "auto" && mode !== "compact") return { text: jsonText, codecId: "json" };
  const winner = candidates[0];
  if (winner === undefined) return { text: jsonText, codecId: "json" };
  if (winner.bytes > limit) return { text: jsonText, codecId: "json" };
  // Hard safety floor regardless of mode: never emit something bigger than
  // the json it replaces.
  const absoluteGain = jsonBytes - winner.bytes;
  if (absoluteGain <= 0) return { text: jsonText, codecId: "json" };

  if (mode === "compact") {
    return { text: winner.text, codecId: `${winner.codec.id}/${winner.codec.version}` };
  }

  // mode === "auto": the full optimization gate.
  const relativeGain = jsonBytes > 0 ? absoluteGain / jsonBytes : 0;
  const rows = countUniformArrayRows(payload);
  const passes =
    rows >= MIN_ROWS && absoluteGain >= MIN_ABSOLUTE_GAIN_BYTES && relativeGain >= MIN_RELATIVE_GAIN;
  if (!passes) return { text: jsonText, codecId: "json" };
  return { text: winner.text, codecId: `${winner.codec.id}/${winner.codec.version}` };
}
