// ---------------------------------------------------------------------------
// protocol v1 -- the `toon-4.1` codec (V10-11).
//
// VERIFIED, PINNED SOURCE: TOON (Token-Oriented Object Notation) Working
// Draft, Version 4.1, dated 2026-07-26, https://github.com/toon-format/spec .
// Text fetched byte-exact via `curl` from
// https://raw.githubusercontent.com/toon-format/spec/main/SPEC.md and read
// in full on 2026-08-20 (this is the spec's own raw text, not a paraphrase
// or a summary produced by an intermediate fetcher). Every rule cited below
// by section number (SN) is that document's normative text.
//
// IMPLEMENTED SUBSET, stated precisely so this module never claims more
// conformance than it has:
//   - Root form: object only (S5's array/keyed-header/single-primitive root
//     forms are NOT implemented -- every protocol v1 payload this codec is
//     ever asked to encode is a JSON object, so they are out of scope, not
//     merely unsupported by oversight).
//   - S8 Objects: `key: value` / `key:` (nested, recursive, arbitrary
//     depth). Implemented in full.
//   - S9.1 Primitive arrays, inline form: implemented in full, including the
//     `key: []` empty form.
//   - S9.3 Arrays of objects, tabular form: implemented ONLY for
//     uniform-PRIMITIVE columns (every element a plain object, all with the
//     identical key SET, every value on every key a primitive). S9.3's
//     "nested-uniform column" escape hatch (a column of uniform nested
//     objects collapsing into a nested field group) is NOT implemented --
//     none of V10-11's allowlisted kinds need it, and a column that is not
//     uniform-primitive simply makes `canEncode` return false (safe json
//     fallback) rather than emit approximate syntax.
//   - S9.2 (arrays of primitive arrays), S9.4 (mixed/non-uniform list form),
//     S9.5 (keyed tabular objects), S10 (objects as list items): NOT
//     implemented. A payload needing any of them fails `canEncode`.
//   - S11 Delimiters: comma only. Tab/pipe delimiter selection is not
//     implemented (comma is the spec's own default, S11.1).
//   - S7.1 Escaping, S7.2 string quoting, S7.3 key quoting, S12 indentation
//     (2-space, LF, no trailing whitespace, no trailing document newline):
//     implemented exactly as specified, byte-for-byte.
//   - S2 Number canonical form: `String(n)` / `Number(s)` are used directly.
//     This is deliberate, not a shortcut: ECMA-262's Number::toString
//     already switches to exponential notation at exactly the same
//     thresholds S2 specifies (< 1e-6, >= 1e21), never emits leading zeros,
//     never emits trailing fractional zeros, and `String(-0) === "0"` -- so
//     it already IS S2's canonical form for every finite JS number.
//
// `decode` is the exact inverse of THIS module's `encode` -- it is a correct
// parser for the grammar subset above, not a general third-party TOON
// reader; that is consistent with how every codec in this directory is used
// (round-trip self-proof), not as a public interchange parser.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import {
  isPlainObject,
  isPrimitive,
  UnsupportedShapeError,
  type CodecPayload,
  type ResponseCodec,
} from "./types.js";

const INDENT_SIZE = 2;

// ---------------------------------------------------------------------------
// S7.1 Escaping -- the six-row table, quoted content only.
// ---------------------------------------------------------------------------

function toonEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case '"': out += '\\"'; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default: {
        const cp = ch.codePointAt(0)!;
        out += cp <= 0x1f ? "\\u" + cp.toString(16).padStart(4, "0") : ch;
      }
    }
  }
  return out;
}

function toonUnescape(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== "\\") { out += ch; i += 1; continue; }
    const next = s[i + 1];
    if (next === "\\") { out += "\\"; i += 2; }
    else if (next === '"') { out += '"'; i += 2; }
    else if (next === "n") { out += "\n"; i += 2; }
    else if (next === "r") { out += "\r"; i += 2; }
    else if (next === "t") { out += "\t"; i += 2; }
    else if (next === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("toon-4.1: invalid \\u escape");
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    } else {
      throw new Error(`toon-4.1: invalid escape sequence \\${String(next)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// S7.2 Quoting rules for string VALUES; S7.3 for keys/field names.
// Comma-only (S11), so "the relevant delimiter" is always ",".
// ---------------------------------------------------------------------------

const NUMERIC_LIKE_RE = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i;
const UNQUOTED_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function needsValueQuoting(s: string): boolean {
  if (s === "") return true;
  if (s[0] === " " || s[0] === "\t") return true;
  if (s[s.length - 1] === " " || s[s.length - 1] === "\t") return true;
  if (s === "true" || s === "false" || s === "null") return true;
  if (NUMERIC_LIKE_RE.test(s)) return true;
  if (s.includes(":") || s.includes('"') || s.includes("\\")) return true;
  if (s.includes("[") || s.includes("]") || s.includes("{") || s.includes("}")) return true;
  if (s.includes(",")) return true;
  if (s.startsWith("-")) return true;
  if (s.startsWith("#")) return true;
  for (const ch of s) {
    if (ch.codePointAt(0)! <= 0x1f) return true;
  }
  return false;
}

function encodeKey(key: string): string {
  return UNQUOTED_KEY_RE.test(key) ? key : `"${toonEscape(key)}"`;
}

function encodeString(s: string): string {
  return needsValueQuoting(s) ? `"${toonEscape(s)}"` : s;
}

function encodeScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  return encodeString(value);
}

// ---------------------------------------------------------------------------
// S9.3 tabular-array detection -- uniform-primitive columns only (see header).
// ---------------------------------------------------------------------------

function tabularFieldsOf(arr: unknown[]): string[] | undefined {
  if (arr.length === 0 || !arr.every((el) => isPlainObject(el))) return undefined;
  const objs = arr as CodecPayload[];
  if (objs.some((o) => Object.keys(o).length === 0)) return undefined;
  const fields = Object.keys(objs[0]!);
  const fieldSet = new Set(fields);
  for (const o of objs) {
    const keys = Object.keys(o);
    if (keys.length !== fields.length || !keys.every((k) => fieldSet.has(k))) return undefined;
    if (!keys.every((k) => isPrimitive(o[k]))) return undefined;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

function indent(depth: number): string {
  return " ".repeat(depth * INDENT_SIZE);
}

function encodeField(key: string, value: unknown, depth: number, lines: string[]): void {
  const k = encodeKey(key);
  if (isPrimitive(value)) {
    lines.push(`${indent(depth)}${k}: ${encodeScalar(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${indent(depth)}${k}: []`);
      return;
    }
    if (value.every(isPrimitive)) {
      const vals = (value as Array<string | number | boolean | null>).map(encodeScalar).join(",");
      lines.push(`${indent(depth)}${k}[${value.length}]: ${vals}`);
      return;
    }
    const fields = tabularFieldsOf(value);
    if (fields !== undefined) {
      const objs = value as CodecPayload[];
      const headerFields = fields.map(encodeKey).join(",");
      lines.push(`${indent(depth)}${k}[${objs.length}]{${headerFields}}:`);
      for (const o of objs) {
        const cells = fields.map((f) => encodeScalar(o[f] as string | number | boolean | null)).join(",");
        lines.push(`${indent(depth + 1)}${cells}`);
      }
      return;
    }
    throw new UnsupportedShapeError(`toon-4.1: array field "${key}" is outside the implemented subset`);
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    lines.push(`${indent(depth)}${k}:`);
    if (entries.length > 0) encodeObjectBody(value, depth + 1, lines);
    return;
  }
  throw new UnsupportedShapeError(`toon-4.1: field "${key}" has an unsupported value type`);
}

function encodeObjectBody(obj: CodecPayload, depth: number, lines: string[]): void {
  for (const [key, value] of Object.entries(obj)) encodeField(key, value, depth, lines);
}

function encode(payload: CodecPayload): string {
  const lines: string[] = [];
  encodeObjectBody(payload, 0, lines);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Decoder -- the exact inverse of the encoder above.
// ---------------------------------------------------------------------------

const NUM_TOKEN_RE = /^-?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/i;

function isCanonicalNumberToken(s: string): boolean {
  if (!NUM_TOKEN_RE.test(s)) return false;
  const sign = s[0] === "-" ? 1 : 0;
  let j = sign;
  while (j < s.length && s[j]! >= "0" && s[j]! <= "9") j++;
  const intPart = s.slice(sign, j);
  return !(intPart.length > 1 && intPart[0] === "0");
}

function decodeToken(raw: string): string | number | boolean | null {
  if (raw.startsWith('"')) return toonUnescape(raw.slice(1, -1));
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (isCanonicalNumberToken(raw)) return Number(raw);
  return raw;
}

/** Comma-split that respects `"..."` quoting (commas inside quotes are not
 *  split points); returns raw (still-quoted-if-quoted) tokens. */
function splitDelimited(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (inQuotes) {
      cur += c;
      if (c === "\\") { cur += s[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') inQuotes = false;
      i += 1;
      continue;
    }
    if (c === '"' && cur === "") { inQuotes = true; cur += c; i += 1; continue; }
    if (c === ",") { out.push(cur); cur = ""; i += 1; continue; }
    cur += c;
    i += 1;
  }
  out.push(cur);
  return out;
}

/**
 * `stopChars` is the set of characters that end an UNQUOTED token here --
 * different in the two contexts this is called from: a top-level key stops
 * at `[`/`:` (S6's header/key-value grammar), a field-list entry stops at
 * `,`/`}` (S6's `fields-seg`). A quoted token always stops at its own
 * closing `"` regardless of context, per S7.4's quoted-token-boundary rule.
 */
function parseKeyToken(line: string, pos: number, stopChars: string): { key: string; next: number } {
  if (line[pos] === '"') {
    let j = pos + 1;
    while (j < line.length) {
      if (line[j] === "\\") { j += 2; continue; }
      if (line[j] === '"') { j += 1; break; }
      j += 1;
    }
    return { key: toonUnescape(line.slice(pos + 1, j - 1)), next: j };
  }
  let j = pos;
  while (j < line.length && !stopChars.includes(line[j]!)) j++;
  return { key: line.slice(pos, j), next: j };
}

type ParsedLine =
  | { kind: "tabular"; key: string; n: number; fields: string[] }
  | { kind: "inline-array"; key: string; n: number; rest: string }
  | { kind: "kv"; key: string; value: string };

function classifyLine(content: string): ParsedLine {
  const { key, next } = parseKeyToken(content, 0, "[:");
  let pos = next;
  if (content[pos] === "[") {
    const closeIdx = content.indexOf("]", pos);
    if (closeIdx === -1) throw new Error("toon-4.1: unterminated bracket segment");
    const n = Number(content.slice(pos + 1, closeIdx));
    pos = closeIdx + 1;
    if (content[pos] === "{") {
      const fields: string[] = [];
      pos += 1;
      for (;;) {
        const tok = parseKeyToken(content, pos, ",}");
        fields.push(tok.key);
        pos = tok.next;
        if (content[pos] === ",") { pos += 1; continue; }
        if (content[pos] === "}") { pos += 1; break; }
        throw new Error("toon-4.1: malformed field list");
      }
      if (content[pos] !== ":") throw new Error("toon-4.1: expected ':' after field list");
      return { kind: "tabular", key, n, fields };
    }
    if (content[pos] !== ":") throw new Error("toon-4.1: expected ':' after bracket segment");
    const rest = content[pos + 1] === " " ? content.slice(pos + 2) : "";
    return { kind: "inline-array", key, n, rest };
  }
  if (content[pos] !== ":") throw new Error("toon-4.1: expected ':' after key");
  const value = content[pos + 1] === " " ? content.slice(pos + 2) : "";
  return { kind: "kv", key, value };
}

function indentDepthOf(line: string): number {
  let n = 0;
  while (line[n] === " ") n++;
  return n / INDENT_SIZE;
}

function parseObjectBody(lines: string[], iRef: { i: number }, depth: number): CodecPayload {
  const obj: CodecPayload = {};
  while (iRef.i < lines.length) {
    const line = lines[iRef.i]!;
    const d = indentDepthOf(line);
    if (d < depth) break;
    if (d > depth) throw new Error("toon-4.1: unexpected indentation increase");
    const content = line.slice(depth * INDENT_SIZE);
    const parsed = classifyLine(content);
    iRef.i += 1;
    if (parsed.kind === "tabular") {
      const rows: CodecPayload[] = [];
      for (let r = 0; r < parsed.n; r++) {
        const rowLine = lines[iRef.i];
        if (rowLine === undefined) throw new Error("toon-4.1: missing tabular row");
        const rowContent = rowLine.slice((depth + 1) * INDENT_SIZE);
        const cells = splitDelimited(rowContent);
        if (cells.length !== parsed.fields.length) throw new Error("toon-4.1: row cell count mismatch");
        const rowObj: CodecPayload = {};
        parsed.fields.forEach((f, idx) => { rowObj[f] = decodeToken(cells[idx]!); });
        rows.push(rowObj);
        iRef.i += 1;
      }
      obj[parsed.key] = rows;
    } else if (parsed.kind === "inline-array") {
      if (parsed.n === 0) {
        obj[parsed.key] = [];
      } else {
        const cells = splitDelimited(parsed.rest);
        if (cells.length !== parsed.n) throw new Error("toon-4.1: inline array count mismatch");
        obj[parsed.key] = cells.map(decodeToken);
      }
    } else if (parsed.value === "") {
      obj[parsed.key] = parseObjectBody(lines, iRef, depth + 1);
    } else if (parsed.value === "[]") {
      obj[parsed.key] = [];
    } else {
      obj[parsed.key] = decodeToken(parsed.value);
    }
  }
  return obj;
}

function decode(text: string): CodecPayload {
  const lines = text.length === 0 ? [] : text.split("\n");
  return parseObjectBody(lines, { i: 0 }, 0);
}

function canEncode(_kind: Kind, payload: CodecPayload): boolean {
  try {
    encode(payload);
    return true;
  } catch {
    return false;
  }
}

export const toon41Codec: ResponseCodec = {
  id: "toon-4.1",
  version: "4.1",
  canEncode,
  encode,
  decode,
};
