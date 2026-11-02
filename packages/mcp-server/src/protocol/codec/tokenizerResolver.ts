// ---------------------------------------------------------------------------
// protocol v1 -- A1: the real-tokenizer provider behind the TokenCounter seam.
//
// `tokenCounter.ts` stays the interface; this module answers "which real
// counter, if any, is available for THIS process right now". Nothing here is
// reachable from the default path: `wireTokenizerNeeded()` is false unless an
// operator set TL_WIRE_TOKENIZER AND something would consume the count, so an
// unconfigured server never touches the dictionary (a ~2.3 MB module and a
// 300-650 ms synchronous constructor, measured 2026-10-30).
//
// WHAT A COUNT MEANS. A value from this counter is the exact token count of
// one final text under one named encoding. It is NOT a provider's billed
// input: the host adds its own message wrappers, and no client name in this
// repository identifies a model. `model_mapping` is therefore always
// "unverified" -- TL_WIRE_TOKENIZER names an encoding to optimise for, never a
// model, and no client profile promotes it.
//
// WHY THE LOAD IS ASYNC AND THE COUNT IS SYNC. `applyResponseCodec` runs inside
// the synchronous emit funnel, so the count must be synchronous, while the
// repository's bundling contract (bundle-cli.mjs) only inlines LITERAL dynamic
// `import("pkg")` calls. `ensureWireTokenizerLoaded` is awaited once per tool
// call before dispatch; a counter that has not finished loading is reported as
// "not-loaded" and the caller falls back -- never waits, never guesses.
//
// THE COST GUARD IS MANDATORY, NOT AN OPTIMISATION. js-tiktoken's merge is
// quadratic in the UTF-8 length of one regex piece: measured 2026-10-30,
// 1,000 repeated letters take ~85 ms, 16,000 take 18.8 s, 4,000 spaces take 1.0 s,
// and 2,700 unbroken Japanese characters take 5-7 s, against 11-24 ms for 32 KB of
// ordinary JSON.
// A tool body can legitimately contain any of those, and this runs on the
// event loop. So every text is priced BEFORE it is encoded (`countCost`), and a
// text over either bound is refused rather than counted. The bounds below are
// design values chosen from that measurement (~90 ms linear, ~85 ms quadratic
// per text); they are not derived from a latency requirement.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { isTraceEnabled } from "../../util/trace.js";
import { measureResponseBytes } from "../budget/measure.js";
import {
  responseFormatMode,
  wireBreakevenEnabled,
  wireShadowEnabled,
  wireTokenSelectEnabled,
  wireTokenizerEncoding,
} from "../../util/flags.js";
import type { TokenCounter } from "./tokenCounter.js";

export type WireTokenizerEncoding = "o200k_base" | "cl100k_base";

const SUPPORTED_ENCODINGS: ReadonlySet<string> = new Set<WireTokenizerEncoding>(["o200k_base", "cl100k_base"]);

/** Refuse a text larger than this outright, in UTF-8 bytes. */
export const MAX_COUNT_INPUT_BYTES = 128 * 1024;
/** Refuse a text whose regex pieces cost more than this, in summed squared UTF-8 bytes (see the module header). */
export const MAX_COUNT_QUADRATIC_COST = 1_000_000;
/** Pieces below this length cannot move the quadratic estimate; skipping them keeps the scan cheap. */
const COST_PIECE_FLOOR_BYTES = 64;

/**
 * The character classes both encodings' patterns split on, over-approximated: a
 * piece here is never shorter than the one the encoder sees. Whitespace is a class
 * of its own because a run of it is one piece too: 4,000 spaces cost 1.0 s, the
 * same curve as letters.
 */
const PIECE_PATTERN = /[\p{L}\p{M}]+|\p{N}+|\s+|[^\s\p{L}\p{M}\p{N}]+/gu;

export type TokenCountRefusalReason = "input-too-large" | "input-too-costly" | "invalid-count" | "count-threw";

/** Thrown by a real counter's `count` so a caller can tell "no measurement" from a measurement. */
export class TokenCountRefused extends Error {
  constructor(readonly reason: TokenCountRefusalReason) {
    super(`token count refused: ${reason}`);
    this.name = "TokenCountRefused";
  }
}

/** The encoder underneath a real counter. A seam so failure injection never needs a broken dictionary on disk. */
export interface TokenizerBackend {
  /** Identifies the encoder implementation; part of the counter identity. */
  readonly implementation: string;
  /** Digest of the dictionary, pattern and special-token table actually loaded; part of the counter identity. */
  readonly dictionaryRevision: string;
  /** Length of the ordinary (no special-token interpretation) encoding of `text`. */
  encodeLength(text: string): number;
}

export type TokenizerLoader = (encoding: WireTokenizerEncoding) => Promise<TokenizerBackend>;

export interface RealTokenCounter extends TokenCounter {
  readonly unit: "tokens";
  readonly encoding: WireTokenizerEncoding;
  /** Time the dictionary load and encoder construction took, once. */
  readonly initMs: number;
}

export type TokenizerUnavailableReason = "unknown-encoding" | "not-loaded" | "load-failed";

export type TokenizerResolution =
  | { readonly status: "disabled" }
  | { readonly status: "ready"; readonly counter: RealTokenCounter }
  | { readonly status: "unavailable"; readonly reason: TokenizerUnavailableReason };

type LoadSlot =
  | { readonly state: "loading"; readonly promise: Promise<void> }
  | { readonly state: "ready"; readonly counter: RealTokenCounter }
  | { readonly state: "failed" };

const slots = new Map<WireTokenizerEncoding, LoadSlot>();
let loader: TokenizerLoader = loadJsTiktoken;

/**
 * The ordinary encoding of `encoding`, through the lite entry so only the one
 * dictionary asked for is ever evaluated. `encode(text, [], [])` is the part
 * that matters for tool bodies: js-tiktoken's default REJECTS text containing
 * `<|endoftext|>`, and an allow-list would map it to a special id; empty lists
 * count it as the ordinary characters it is.
 */
async function loadJsTiktoken(encoding: WireTokenizerEncoding): Promise<TokenizerBackend> {
  const [{ Tiktoken }, ranks] = await Promise.all([
    import("js-tiktoken/lite"),
    encoding === "o200k_base" ? import("js-tiktoken/ranks/o200k_base") : import("js-tiktoken/ranks/cl100k_base"),
  ]);
  const dictionary = ranks.default;
  const encoder = new Tiktoken(dictionary);
  const dictionaryRevision = createHash("sha256")
    .update(dictionary.pat_str, "utf8")
    .update(JSON.stringify(dictionary.special_tokens), "utf8")
    .update(dictionary.bpe_ranks, "utf8")
    .digest("hex")
    .slice(0, 12);
  return {
    implementation: "js-tiktoken-1",
    dictionaryRevision,
    encodeLength: (text) => encoder.encode(text, [], []).length,
  };
}

/** The bound check run before any text reaches the encoder. Undefined means "safe to count". */
export function countCost(text: string): TokenCountRefusalReason | undefined {
  // UTF-16 length x 3 is an upper bound on UTF-8 bytes, so most texts skip the exact measure.
  if (text.length * 3 > MAX_COUNT_INPUT_BYTES && measureResponseBytes(text) > MAX_COUNT_INPUT_BYTES) {
    return "input-too-large";
  }
  let cost = 0;
  for (const match of text.matchAll(PIECE_PATTERN)) {
    const piece = match[0];
    if (piece.length * 3 < COST_PIECE_FLOOR_BYTES) continue;
    const bytes = measureResponseBytes(piece);
    cost += bytes * bytes;
    if (cost > MAX_COUNT_QUADRATIC_COST) return "input-too-costly";
  }
  return undefined;
}

function buildCounter(encoding: WireTokenizerEncoding, backend: TokenizerBackend, initMs: number): RealTokenCounter {
  return {
    // Everything that can change a count: encoding, implementation, the loaded
    // dictionary itself, and how special-token look-alikes are treated. No
    // spaces -- this is a component of breakeven.ts's and encodingCache.ts's
    // space-joined keys.
    id: `tiktoken/${encoding}/${backend.implementation}/dict-${backend.dictionaryRevision}/special-ordinary`,
    unit: "tokens",
    encoding,
    initMs,
    count(text: string): number {
      const refusal = countCost(text);
      if (refusal !== undefined) throw new TokenCountRefused(refusal);
      let units: number;
      try {
        units = backend.encodeLength(text);
      } catch {
        throw new TokenCountRefused("count-threw");
      }
      if (!Number.isSafeInteger(units) || units < 0 || (units === 0 && text.length > 0)) {
        throw new TokenCountRefused("invalid-count");
      }
      return units;
    },
  };
}

/** True when this call could consume a real count -- the only condition under which the dictionary is ever loaded. */
export function wireTokenizerNeeded(): boolean {
  if (wireTokenizerEncoding() === undefined) return false;
  const mode = responseFormatMode();
  if ((wireShadowEnabled() || mode === "debug") && isTraceEnabled()) return true;
  return wireTokenSelectEnabled() && mode === "auto" && wireBreakevenEnabled();
}

/**
 * Load the configured encoding once for this process. Never throws; a failure
 * is remembered, so a missing dictionary costs one attempt rather than one per
 * tool call, and `resolveWireTokenizer` reports it from then on.
 */
export async function ensureWireTokenizerLoaded(): Promise<void> {
  if (!wireTokenizerNeeded()) return;
  const encoding = wireTokenizerEncoding();
  if (encoding === undefined || !SUPPORTED_ENCODINGS.has(encoding)) return;
  const known = encoding as WireTokenizerEncoding;
  const slot = slots.get(known);
  if (slot !== undefined) {
    if (slot.state === "loading") await slot.promise;
    return;
  }
  const started = performance.now();
  const promise = loader(known).then(
    (backend) => {
      slots.set(known, { state: "ready", counter: buildCounter(known, backend, Math.round(performance.now() - started)) });
    },
    () => {
      slots.set(known, { state: "failed" });
    },
  );
  slots.set(known, { state: "loading", promise });
  await promise;
}

/** The configured counter, or why there is none. Synchronous and free of I/O: safe on the emit path. */
export function resolveWireTokenizer(): TokenizerResolution {
  const encoding = wireTokenizerEncoding();
  if (encoding === undefined) return { status: "disabled" };
  if (!SUPPORTED_ENCODINGS.has(encoding)) return { status: "unavailable", reason: "unknown-encoding" };
  const slot = slots.get(encoding as WireTokenizerEncoding);
  if (slot === undefined || slot.state === "loading") return { status: "unavailable", reason: "not-loaded" };
  if (slot.state === "failed") return { status: "unavailable", reason: "load-failed" };
  return { status: "ready", counter: slot.counter };
}

/** Test-only: replace the loader (failure injection, fake dictionaries) and forget every loaded counter. */
export function setWireTokenizerLoaderForTest(next?: TokenizerLoader): void {
  loader = next ?? loadJsTiktoken;
  slots.clear();
}
