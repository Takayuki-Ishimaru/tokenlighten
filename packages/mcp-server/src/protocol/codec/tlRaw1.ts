// ---------------------------------------------------------------------------
// protocol v1 -- the `tl-raw-1` codec (V10-11; D1/F-C2b nested-body support).
//
// A single-dominant-body raw block: the biggest string field is written
// VERBATIM (no JSON string-escaping, which can nearly double the size of
// code/prose bodies full of quotes and backslashes) between two occurrences
// of a delimiter DERIVED FROM THE BODY'S OWN HASH, so the delimiter can
// never collide with the body's content -- collision is VERIFIED, not
// assumed, before the delimiter is trusted (`deriveDelimiter` below).
//
// NOT wired into the V10-11 selection allowlist (`policy.ts`'s
// `NON_JSON_ALLOWLIST` covers search.matches/search.references/read.map/
// read.batch/read.artifact only). It IS reachable via the V11-07 v2 path for
// `read.text` (selectV2.ts's `V2_WIDENED_KIND`, gated on
// `TOKENLIGHTEN_RESPONSE_FORMAT=auto` + `TL_WIRE_BREAKEVEN` + an allowing
// client profile) -- see the D1 addendum below for why that eligibility used
// to be vacuous.
//
// D1 (F-C2b) ADDENDUM (2026-08-21). Through V11-07, the dominant body this
// codec looked for was ALWAYS a TOP-LEVEL string field (`bodyFieldOf`). A
// real `read.text` response never has one: its served bytes live at
// `evidence[i].body` (protocol/readFamily.ts's `ReadTextResult` --
// `{v, kind, evidence: [FreshEvidence, ...], limit?}`), an ARRAY of objects.
// `bodyFieldOf` on that shape found nothing worth encoding (at best a
// degenerate few-byte field like `kind` itself), so `canEncode` either
// declined outright or produced a candidate that could never beat json on
// bytes -- eligibility that was wired but structurally unreachable. This
// module now locates the DOMINANT body among top-level fields AND (for
// `read.text` only) the ONE evidence entry carrying a served `body`, picking
// whichever is longer -- see `locateDominantBody`. Multiple body-bearing
// evidence entries (a multi-window slice/sections serve) have no single
// dominant body and stay outside this codec's reach entirely, same as
// before: `evaluateCandidates` (policy.ts) falls back to json.
//
// WIRE FORMAT, id/version, and why this is an IN-PLACE EXTENSION rather than
// a new `tl-raw-2`: the field-selector line (third from the end) used to
// always be a JSON STRING (a top-level key) and still is for every payload
// this codec already handled -- byte-for-byte unchanged. The new nested
// case adds exactly one more shape to that ONE line: a JSON non-negative
// INTEGER (the evidence index), which a real top-level object key can never
// equal (`Object.entries` keys are always strings), so the two cannot be
// confused and decode's one extra `typeof` branch is this module's entire
// wire-format addition. Nothing about `id`/`version`/`MAGIC` needed to
// change: `${codec.id}/${codec.version}` never rides the wire text itself
// (only `MAGIC` does, and a decoder recognises tl-raw-1 output by trying to
// parse it, the same MAGIC-sniffed way `evaluateCandidates`'s own
// round-trip proof and every real consumer already work -- see
// `__tests__/wireCodecCompactE2E.spec.ts`'s `decodeWireText`); the compound
// id/version string is purely INTERNAL bookkeeping (trace records,
// clientProfile.ts's `allowedCodecIds` gate), and clientProfile.ts's own
// header confirms decode is always performed by "THIS SAME server" (no
// independent third-party implementation of the documented top-level-only
// contract exists to break). A new `tl-raw-2` id would therefore buy
// nothing: same MAGIC-sniffed self-description, same internal-only id,
// same single in-tree decoder -- just a second near-duplicate module for
// what is genuinely the same mechanism locating its one dominant body by a
// wider rule.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { Kind } from "@tokenlighten/types";
import { isPlainObject, type CodecPayload, type ResponseCodec } from "./types.js";

const MAGIC = "TL1R";
const MAX_DELIMITER_ATTEMPTS = 8;
// Built via fromCharCode rather than a literal escape in source, so no NUL
// byte ever appears in this file's own text -- only in strings it builds at
// run time.
const NUL = String.fromCharCode(0);

/**
 * Where the extracted body actually lives in a payload. `"top"` is the
 * original V10-11 shape (a top-level string field, addressed by key);
 * `"evidence"` is the D1 addition -- `payload.evidence[index].body`.
 */
type BodyLocation =
  | { readonly at: "top"; readonly field: string }
  | { readonly at: "evidence"; readonly index: number };

/** `payload["kind"]` when it is a string, else undefined -- every protocol
 *  v1 payload that reaches this codec carries its own classified `kind` as
 *  a wire field (D4), which is what `encode`/`decode` read to reproduce
 *  `canEncode`'s kind-gated decision: the `ResponseCodec` interface (see
 *  types.ts) deliberately gives `encode`/`decode` no `kind` parameter (every
 *  codec keeps that contract, not just this one), and `evaluateCandidates`
 *  (policy.ts) always calls `canEncode(kind, payload)` immediately before
 *  `encode(payload)` on the SAME payload, so the payload's own `kind` field
 *  is exactly the value `canEncode` was already given. */
function payloadKind(payload: CodecPayload): string | undefined {
  const kind = payload["kind"];
  return typeof kind === "string" ? kind : undefined;
}

/**
 * Index of the ONE `evidence` entry carrying a served `body` string, iff
 * there is EXACTLY one. Zero or several body-bearing entries return
 * undefined -- a multi-window slice/sections read.text serve has no single
 * dominant body to extract, and this codec leaves it entirely to json (same
 * "multi-body payloads stay ineligible" rule the D1 module header states).
 *
 * KEEP IN SYNC BY HAND with shape.ts's `dominantEvidenceBodyLength`, which
 * classifies the SAME shape for the breakeven table and must agree with
 * this function on when a payload has a single dominant nested body.
 */
function singleEvidenceBodyIndex(payload: CodecPayload): number | undefined {
  const evidence = payload["evidence"];
  if (!Array.isArray(evidence)) return undefined;
  let found: number | undefined;
  for (let i = 0; i < evidence.length; i++) {
    const entry: unknown = evidence[i];
    if (!isPlainObject(entry) || typeof entry["body"] !== "string") continue;
    if (found !== undefined) return undefined; // a second body-bearing entry -- no single dominant body
    found = i;
  }
  return found;
}

/**
 * The dominant body location in `payload`, by length -- greatest wins.
 * Top-level fields always compete; the one eligible nested evidence body
 * (only ever considered when `kind === "read.text"`) competes alongside
 * them rather than pre-empting them, so a genuinely bigger top-level field
 * (e.g. a large `headings` index next to a short slice body) still wins,
 * same "dominant" contract `bodyFieldOf` always had. `undefined` if payload
 * carries no string field anywhere this codec looks.
 */
function locateDominantBody(payload: CodecPayload, kind: string | undefined): BodyLocation | undefined {
  let best: BodyLocation | undefined;
  let bestLen = -1;
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" && value.length > bestLen) {
      best = { at: "top", field: key };
      bestLen = value.length;
    }
  }
  if (kind === "read.text") {
    const index = singleEvidenceBodyIndex(payload);
    if (index !== undefined) {
      const evidence = payload["evidence"] as unknown[];
      const body = (evidence[index] as Record<string, unknown>)["body"] as string;
      if (body.length > bestLen) {
        best = { at: "evidence", index };
        bestLen = body.length;
      }
    }
  }
  return best;
}

function bodyAt(payload: CodecPayload, location: BodyLocation): string {
  if (location.at === "top") return payload[location.field] as string;
  const evidence = payload["evidence"] as unknown[];
  return (evidence[location.index] as Record<string, unknown>)["body"] as string;
}

/** `payload` with the field/slot `location` names deleted -- what `encode`
 *  puts in its `meta` block. For the nested case, every OTHER evidence
 *  entry is passed through unchanged (by reference; only the located entry
 *  is shallow-cloned). */
function withoutBody(payload: CodecPayload, location: BodyLocation): CodecPayload {
  if (location.at === "top") {
    const meta = { ...payload };
    delete meta[location.field];
    return meta;
  }
  const evidence = (payload["evidence"] as unknown[]).map((entry, i) => {
    if (i !== location.index || !isPlainObject(entry)) return entry;
    const clone = { ...entry };
    delete clone["body"];
    return clone;
  });
  return { ...payload, evidence };
}

/** Inverse of `withoutBody` -- restores `body` at `location` on the decoded
 *  `meta`. Validates the nested shape explicitly (rather than letting a
 *  malformed `evidence` throw an unrelated TypeError) so a corrupted wire
 *  text fails with the same "tl-raw-1: ..." diagnostic convention every
 *  other decode error in this module uses. */
function withBody(meta: CodecPayload, location: BodyLocation, body: string): CodecPayload {
  if (location.at === "top") return { ...meta, [location.field]: body };
  const rawEvidence = meta["evidence"];
  if (!Array.isArray(rawEvidence)) {
    throw new Error("tl-raw-1: decoded meta has no evidence array for the located body");
  }
  if (location.index < 0 || location.index >= rawEvidence.length) {
    throw new Error(`tl-raw-1: evidence index ${location.index} out of range`);
  }
  const evidence = rawEvidence.map((entry, i) => {
    if (i !== location.index) return entry;
    if (!isPlainObject(entry)) throw new Error(`tl-raw-1: evidence[${location.index}] is not an object`);
    return { ...entry, body };
  });
  return { ...meta, evidence };
}

/** The field-selector line's wire encoding -- see the module header's WIRE
 *  FORMAT note. A top-level location is the SAME JSON STRING V10-11 always
 *  emitted; a nested location is a JSON non-negative integer, a shape a
 *  real object key can never take. */
function encodeLocation(location: BodyLocation): string {
  return location.at === "top" ? JSON.stringify(location.field) : JSON.stringify(location.index);
}

function decodeLocation(raw: unknown): BodyLocation {
  if (typeof raw === "string") return { at: "top", field: raw };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return { at: "evidence", index: raw };
  throw new Error(`tl-raw-1: invalid body location ${JSON.stringify(raw)}`);
}

/** A digest function: `material` in, a short opaque token out. Parameterized
 *  so `wireCodecTlRaw1.spec.ts` can deterministically exercise the RETRY
 *  loop below with a weak, collision-prone fake -- forcing a real SHA-256
 *  collision to test against is intentionally infeasible, so the loop's
 *  correctness is proven by injection instead. */
type DigestFn = (material: string) => string;

function sha256Hex16(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

/** The collision-checked derivation, generic over the digest function. */
export function deriveDelimiterWith(body: string, digest: DigestFn): string {
  let material = body;
  for (let attempt = 0; attempt < MAX_DELIMITER_ATTEMPTS; attempt++) {
    const candidate = `${NUL}TLRAW:${digest(material)}${NUL}`;
    if (!body.includes(candidate)) return candidate;
    // Astronomically unlikely with the real digest; widen the hash input
    // deterministically and retry.
    material = material + candidate;
  }
  throw new Error("tl-raw-1: could not derive a collision-free delimiter");
}

function deriveDelimiter(body: string): string {
  return deriveDelimiterWith(body, sha256Hex16);
}

function encode(payload: CodecPayload): string {
  const location = locateDominantBody(payload, payloadKind(payload));
  if (location === undefined) throw new Error("tl-raw-1: payload carries no string field");
  const body = bodyAt(payload, location);
  const delimiter = deriveDelimiter(body);
  const meta = withoutBody(payload, location);
  const metaText = JSON.stringify(meta);
  const parts = [MAGIC, String(metaText.length), metaText, encodeLocation(location), delimiter, body, delimiter];
  return parts.join("\n");
}

class LineCursor {
  private pos = 0;
  constructor(private readonly text: string) {}
  readLine(): string {
    const nl = this.text.indexOf("\n", this.pos);
    if (nl === -1) throw new Error("tl-raw-1: unexpected end of text (missing newline)");
    const line = this.text.slice(this.pos, nl);
    this.pos = nl + 1;
    return line;
  }
  readChars(n: number): string {
    const s = this.text.slice(this.pos, this.pos + n);
    if (s.length !== n) throw new Error("tl-raw-1: unexpected end of text (short meta)");
    this.pos += n;
    return s;
  }
  expectNewline(): void {
    if (this.text[this.pos] !== "\n") throw new Error("tl-raw-1: expected newline after meta");
    this.pos += 1;
  }
  rest(): string {
    return this.text.slice(this.pos);
  }
}

function decode(text: string): CodecPayload {
  const cursor = new LineCursor(text);
  const magic = cursor.readLine();
  if (magic !== MAGIC) throw new Error(`tl-raw-1: bad magic ${JSON.stringify(magic)}`);
  const metaLen = Number(cursor.readLine());
  if (!Number.isInteger(metaLen) || metaLen < 0) throw new Error("tl-raw-1: invalid meta length");
  const metaText = cursor.readChars(metaLen);
  cursor.expectNewline();
  const meta: unknown = JSON.parse(metaText);
  if (!isPlainObject(meta)) throw new Error("tl-raw-1: decoded meta is not an object");
  const location = decodeLocation(JSON.parse(cursor.readLine()));
  const delimiter = cursor.readLine();

  const remainder = cursor.rest();
  const closing = `\n${delimiter}`;
  if (!remainder.endsWith(closing)) {
    throw new Error("tl-raw-1: closing delimiter not found at end of text");
  }
  const body = remainder.slice(0, remainder.length - closing.length);
  return withBody(meta, location, body);
}

function canEncode(kind: Kind, payload: CodecPayload): boolean {
  return locateDominantBody(payload, kind) !== undefined;
}

export const tlRaw1Codec: ResponseCodec = {
  id: "tl-raw-1",
  version: "1",
  canEncode,
  encode,
  decode,
};
