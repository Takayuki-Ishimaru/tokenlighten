// ---------------------------------------------------------------------------
// protocol v1 -- B2a: the `tl-dedup-1` codec, exact-repeat folding.
//
// A log's repeated line and a table's repeated row are written once, and every
// occurrence becomes a reference, so the count and the position of each one come
// back on decode. Only byte-identical values fold. Two lines differing by one digit
// are two values, and two objects differing only in key order are two values too.
//
// WHAT THE ROUND TRIP RESTORES is the canonical payload `policy.ts` proves against,
// which is what every codec here restores, and not any file's original bytes. A
// body's line endings survive because lines split on "\n" alone.
//
// WIRE FORMAT. A self-describing first line, then one JSON document {"D":[...],
// "J":payload}. Inside J, {"$tl1d":items} rebuilds a string from its lines, and
// {"$tl1d":items,"a":1} rebuilds an array. An item is a literal (a string line, or
// {"v":element} in an array, so a numeric element can never read as a reference), a
// number n meaning D[n], or [n,k] meaning D[n] k times in a row. Whether any of it
// is worth sending is `policy.ts`'s and `selectV2.ts`'s decision, in bytes or
// tokens, as for every other codec.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { isPlainObject, UnsupportedShapeError, type CodecPayload, type ResponseCodec } from "./types.js";

const MAGIC = "TL1D";
const HEADER = `${MAGIC} exact-repeat folding: in J, {"$tl1d":[...]} rebuilds a value; n = D[n], [n,k] = D[n] k times, strings are literal lines.`;
const MARKER = "$tl1d";
const MAX_PAYLOAD_CHARS = 8 * 1024 * 1024;
const MIN_ENTRY_JSON_CHARS = 8;
/** What one reference costs, roughly: digits and a separator. */
const REFERENCE_CHARS = 4;

type Tally = Map<string, { count: number; value: unknown }>;

function hasMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMarker);
  if (!isPlainObject(value)) return false;
  return Object.keys(value).some((key) => key === MARKER || hasMarker(value[key]));
}

/** A line and an array element with the same text are separate entries: they rebuild different things. */
function lineKey(line: string): string {
  return `L${JSON.stringify(line)}`;
}

function elementKey(element: unknown): string {
  return `E${JSON.stringify(element)}`;
}

function tally(value: unknown, seen: Tally): void {
  const note = (key: string, entry: unknown): void => {
    const row = seen.get(key);
    if (row === undefined) seen.set(key, { count: 1, value: entry });
    else row.count += 1;
  };
  if (typeof value === "string") {
    if (!value.includes("\n")) return;
    for (const line of value.split("\n")) note(lineKey(line), line);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      note(elementKey(element), element);
      tally(element, seen);
    }
    return;
  }
  if (isPlainObject(value)) for (const key of Object.keys(value)) tally(value[key], seen);
}

/** Worth an entry: long enough, and what its repeats save outweighs its references. */
function dictionaryOf(seen: Tally): { entries: unknown[]; index: Map<string, number> } {
  const entries: unknown[] = [];
  const index = new Map<string, number>();
  for (const [key, row] of seen) {
    if (row.count < 2) continue;
    const chars = key.length - 1;
    if (chars < MIN_ENTRY_JSON_CHARS || (row.count - 1) * chars <= row.count * REFERENCE_CHARS) continue;
    index.set(key, entries.length);
    entries.push(row.value);
  }
  return { entries, index };
}

function foldRuns(keys: readonly string[], index: ReadonlyMap<string, number>, literal: (position: number) => unknown): unknown[] {
  const items: unknown[] = [];
  for (let position = 0; position < keys.length;) {
    const entry = index.get(keys[position]!);
    if (entry === undefined) {
      items.push(literal(position));
      position += 1;
      continue;
    }
    let end = position + 1;
    while (end < keys.length && keys[end] === keys[position]) end += 1;
    items.push(end - position === 1 ? entry : [entry, end - position]);
    position = end;
  }
  return items;
}

function fold(value: unknown, index: ReadonlyMap<string, number>): unknown {
  if (typeof value === "string") {
    if (!value.includes("\n")) return value;
    const lines = value.split("\n");
    const keys = lines.map(lineKey);
    if (!keys.some((key) => index.has(key))) return value;
    return { [MARKER]: foldRuns(keys, index, (position) => lines[position]) };
  }
  if (Array.isArray(value)) {
    const keys = value.map(elementKey);
    if (!keys.some((key) => index.has(key))) return value.map((element) => fold(element, index));
    return { [MARKER]: foldRuns(keys, index, (position) => ({ v: fold(value[position], index) })), a: 1 };
  }
  if (isPlainObject(value)) {
    const out: CodecPayload = {};
    for (const key of Object.keys(value)) out[key] = fold(value[key], index);
    return out;
  }
  return value;
}

/** The dictionary this payload would use, or `undefined` when the codec does not apply. */
function plan(payload: CodecPayload): { entries: unknown[]; index: Map<string, number> } | undefined {
  if (JSON.stringify(payload).length > MAX_PAYLOAD_CHARS || hasMarker(payload)) return undefined;
  const seen: Tally = new Map();
  tally(payload, seen);
  const dictionary = dictionaryOf(seen);
  return dictionary.entries.length === 0 ? undefined : dictionary;
}

function reference(dictionary: readonly unknown[], position: unknown): unknown {
  if (typeof position !== "number" || !Number.isInteger(position) || position < 0 || position >= dictionary.length) {
    throw new Error(`${MAGIC}: reference ${String(position)} is out of range`);
  }
  return dictionary[position];
}

function unfold(value: unknown, dictionary: readonly unknown[]): unknown {
  if (Array.isArray(value)) return value.map((element) => unfold(element, dictionary));
  if (!isPlainObject(value)) return value;
  const items = value[MARKER];
  if (items === undefined) {
    const out: CodecPayload = {};
    for (const key of Object.keys(value)) out[key] = unfold(value[key], dictionary);
    return out;
  }
  if (!Array.isArray(items)) throw new Error(`${MAGIC}: malformed folded value`);
  const asArray = value["a"] === 1;
  const rebuilt: unknown[] = [];
  for (const item of items) {
    if (typeof item === "number") {
      rebuilt.push(reference(dictionary, item));
    } else if (Array.isArray(item)) {
      const [position, times] = item as unknown[];
      if (typeof times !== "number" || !Number.isInteger(times) || times < 2) throw new Error(`${MAGIC}: malformed repeat`);
      const entry = reference(dictionary, position);
      for (let copy = 0; copy < times; copy += 1) rebuilt.push(entry);
    } else if (asArray) {
      if (!isPlainObject(item) || !("v" in item)) throw new Error(`${MAGIC}: malformed literal element`);
      rebuilt.push(unfold(item["v"], dictionary));
    } else {
      if (typeof item !== "string") throw new Error(`${MAGIC}: malformed literal line`);
      rebuilt.push(item);
    }
  }
  if (asArray) return rebuilt;
  if (!rebuilt.every((line): line is string => typeof line === "string")) throw new Error(`${MAGIC}: a line reference is not text`);
  return rebuilt.join("\n");
}

export const tlDedup1Codec: ResponseCodec = {
  id: "tl-dedup-1",
  version: "1",
  canEncode(_kind: Kind, payload: CodecPayload): boolean {
    try {
      return plan(payload) !== undefined;
    } catch {
      return false;
    }
  },
  encode(payload: CodecPayload): string {
    const dictionary = plan(payload);
    if (dictionary === undefined) throw new UnsupportedShapeError(`${MAGIC}: nothing to fold, or a reserved marker is present`);
    return `${HEADER}\n${JSON.stringify({ D: dictionary.entries, J: fold(payload, dictionary.index) })}`;
  },
  decode(text: string): CodecPayload {
    const newline = text.indexOf("\n");
    if (newline < 0 || !text.startsWith(MAGIC)) throw new Error(`${MAGIC}: not this codec's text`);
    const document = JSON.parse(text.slice(newline + 1)) as unknown;
    if (!isPlainObject(document) || !Array.isArray(document["D"]) || !isPlainObject(document["J"])) {
      throw new Error(`${MAGIC}: malformed document`);
    }
    return unfold(document["J"], document["D"]) as CodecPayload;
  },
};
