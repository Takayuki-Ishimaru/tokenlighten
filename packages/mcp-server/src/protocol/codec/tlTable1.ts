// ---------------------------------------------------------------------------
// protocol v1 -- the `tl-table-1` codec (V10-11).
//
// A compact text format for a JSON payload that contains one or more
// "arrays of uniform flat objects" (search.matches' `files`/`locations`,
// search.references' `references`/`files`, read.map's
// `signatures`/`surfaces`/`files`, read.batch's `entries` when every entry
// shares one `form`, and read.artifact's `columns`+`rows` tables).
// Everything outside those arrays stays literal JSON; only the repeated-key
// overhead of a uniform array is removed (declared header once, then one
// row per element).
//
// WIRE FORMAT (this module is the ONLY normative source for it):
//
//   "TL1T" "\n"
//   <skeletonLen decimal>"\n"
//   <skeletonLen JS-string-length chars of skeleton JSON>"\n"
//   <blockCount decimal>"\n"
//   <blockCount blocks, each:>
//     <mode: "O" (object rows, keyed) | "P" (positional rows)>"\n"
//     <header: TAB-joined escaped column names>"\n"
//     <rowCount decimal>"\n"
//     <rowCount row lines, each: TAB-joined `tag`+escaped-content cells>"\n" each
//
// `skeleton` is `payload` with every qualifying array/rows-field replaced,
// in pre-order, by the placeholder object `{PLACEHOLDER_KEY: i}` (i = block
// index). `PLACEHOLDER_KEY` (see below) is a dollar-prefixed sentinel that
// can never collide with a real protocol-v1 field name (real keys are
// always plain lower/snake_case identifiers, never dollar-prefixed).
//
// CELL TAGS (one character, no separator before the content that follows it):
//   S <escaped string>   N <number text>   B "true"|"false"   Z (null, no content)
//   U (key absent -- O-mode only, no content)   J <escaped JSON.stringify(value)> (fallback)
//
// ESCAPING (applied to string/J cell content and to header column names --
// `escapeCell`/`unescapeCell` below, fuzz-proven by
// `wireCodecTlTable1.spec.ts`): backslash, HTAB and LF/CR are
// backslash-escaped; every other C0 control (and DEL) becomes `\xHH`;
// everything else -- including all of CJK and astral-plane emoji -- passes
// through unchanged. Because a literal HTAB/LF never survives escaping,
// splitting a row on raw TAB and a block on raw LF after the fact is always
// safe: any such byte remaining IS a real delimiter, never content.
// ---------------------------------------------------------------------------

import type { Kind } from "@tokenlighten/types";
import { isNonEmptyObjectArray, isPlainObject, type CodecPayload, type ResponseCodec } from "./types.js";
import { isPositionalRowsShape } from "./shape.js";

const MAGIC = "TL1T";
const PLACEHOLDER_KEY = "$tlTable";

// ---------------------------------------------------------------------------
// Cell escaping
// ---------------------------------------------------------------------------

export function escapeCell(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case "\t": out += "\\t"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      default: {
        const cp = ch.codePointAt(0)!;
        if (cp <= 0x1f || cp === 0x7f) {
          out += "\\x" + cp.toString(16).padStart(2, "0");
        } else {
          out += ch;
        }
      }
    }
  }
  return out;
}

export function unescapeCell(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === "\\") { out += "\\"; i += 2; }
      else if (next === "t") { out += "\t"; i += 2; }
      else if (next === "n") { out += "\n"; i += 2; }
      else if (next === "r") { out += "\r"; i += 2; }
      else if (next === "x") {
        const hex = s.slice(i + 2, i + 4);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else {
        // Never produced by escapeCell; stay total rather than throw mid-scan.
        out += ch;
        i += 1;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// `String(n)`/`Number(s)` are exact inverses for every finite JS number
// (including `-0`, since `String(-0) === "0"`), so no custom
// canonicalization is needed.
function numToText(n: number): string {
  return Number.isFinite(n) ? String(n) : "0";
}

// ---------------------------------------------------------------------------
// Blocks: "header: string[], rows: (tag+content)[][]" -- the ONE internal
// shape both extraction paths (keyed object-array, positional columns/rows)
// build, and the ONE shape decode reconstructs from.
// ---------------------------------------------------------------------------

type BlockMode = "O" | "P";
interface Block {
  mode: BlockMode;
  header: string[];
  rows: string[][]; // already tag+escaped-content, one string per cell
}

function encodeCellValue(value: unknown): string {
  if (value === null) return "Z";
  if (typeof value === "string") return "S" + escapeCell(value);
  if (typeof value === "number") return "N" + numToText(value);
  if (typeof value === "boolean") return "B" + (value ? "true" : "false");
  return "J" + escapeCell(JSON.stringify(value));
}

function decodeCellValue(cell: string): unknown {
  const tag = cell[0];
  const content = cell.slice(1);
  switch (tag) {
    case "Z": return null;
    case "S": return unescapeCell(content);
    case "N": return Number(unescapeCell(content));
    case "B": return content === "true";
    case "J": return JSON.parse(unescapeCell(content));
    default:
      throw new Error(`tl-table-1: unknown cell tag ${JSON.stringify(tag)}`);
  }
}

function blockFromObjectArray(arr: CodecPayload[]): Block {
  const header: string[] = [];
  const seen = new Set<string>();
  for (const obj of arr) {
    for (const key of Object.keys(obj)) {
      if (!seen.has(key)) { seen.add(key); header.push(key); }
    }
  }
  const rows = arr.map((obj) =>
    header.map((key) => (key in obj ? encodeCellValue(obj[key]) : "U")),
  );
  return { mode: "O", header, rows };
}

function blockFromPositionalRows(columns: string[], rows: unknown[][]): Block {
  return {
    mode: "P",
    header: columns,
    rows: rows.map((row) => row.map(encodeCellValue)),
  };
}

function blockToObjectArray(block: Block): CodecPayload[] {
  return block.rows.map((cells) => {
    const obj: CodecPayload = {};
    block.header.forEach((key, i) => {
      const cell = cells[i]!;
      if (cell[0] !== "U") obj[key] = decodeCellValue(cell);
    });
    return obj;
  });
}

function blockToPositionalRows(block: Block): unknown[][] {
  return block.rows.map((cells) => cells.map(decodeCellValue));
}

// ---------------------------------------------------------------------------
// Skeleton walk (encode direction): find every qualifying array / positional
// rows-field, in pre-order, replace with a placeholder, collect blocks.
// ---------------------------------------------------------------------------

function extract(value: unknown, blocks: Block[]): unknown {
  if (Array.isArray(value)) {
    if (isNonEmptyObjectArray(value)) {
      const idx = blocks.length;
      blocks.push(blockFromObjectArray(value));
      return { [PLACEHOLDER_KEY]: idx };
    }
    return value.map((el) => extract(el, blocks));
  }
  if (isPlainObject(value)) {
    const out: CodecPayload = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "rows" && isPositionalRowsShape(value)) {
        const idx = blocks.length;
        blocks.push(blockFromPositionalRows(value["columns"], v as unknown[][]));
        out[key] = { [PLACEHOLDER_KEY]: idx };
        continue;
      }
      out[key] = extract(v, blocks);
    }
    return out;
  }
  return value;
}

function isPlaceholder(value: unknown): value is { [PLACEHOLDER_KEY]: number } {
  return (
    isPlainObject(value)
    && Object.keys(value).length === 1
    && typeof value[PLACEHOLDER_KEY] === "number"
  );
}

function reinsert(value: unknown, blocks: Block[]): unknown {
  if (isPlaceholder(value)) {
    const block = blocks[value[PLACEHOLDER_KEY]];
    if (block === undefined) throw new Error("tl-table-1: block index out of range");
    return block.mode === "O" ? blockToObjectArray(block) : blockToPositionalRows(block);
  }
  if (Array.isArray(value)) return value.map((el) => reinsert(el, blocks));
  if (isPlainObject(value)) {
    const out: CodecPayload = {};
    for (const [key, v] of Object.entries(value)) out[key] = reinsert(v, blocks);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Line-oriented framing
// ---------------------------------------------------------------------------

function encodeBlock(block: Block): string {
  const lines: string[] = [];
  lines.push(block.mode);
  lines.push(block.header.map(escapeCell).join("\t"));
  lines.push(String(block.rows.length));
  for (const row of block.rows) lines.push(row.join("\t"));
  return lines.join("\n") + "\n";
}

function encode(payload: CodecPayload): string {
  const blocks: Block[] = [];
  const skeleton = extract(payload, blocks);
  const skeletonText = JSON.stringify(skeleton);
  const parts: string[] = [MAGIC, String(skeletonText.length), skeletonText, String(blocks.length)];
  let out = parts.join("\n") + "\n";
  for (const block of blocks) out += encodeBlock(block);
  return out;
}

class LineCursor {
  private pos = 0;
  constructor(private readonly text: string) {}
  readLine(): string {
    const nl = this.text.indexOf("\n", this.pos);
    if (nl === -1) throw new Error("tl-table-1: unexpected end of text (missing newline)");
    const line = this.text.slice(this.pos, nl);
    this.pos = nl + 1;
    return line;
  }
  readChars(n: number): string {
    const s = this.text.slice(this.pos, this.pos + n);
    if (s.length !== n) throw new Error("tl-table-1: unexpected end of text (short skeleton)");
    this.pos += n;
    return s;
  }
  expectNewline(): void {
    if (this.text[this.pos] !== "\n") throw new Error("tl-table-1: expected newline after skeleton");
    this.pos += 1;
  }
}

function decodeBlock(cursor: LineCursor): Block {
  const mode = cursor.readLine();
  if (mode !== "O" && mode !== "P") throw new Error(`tl-table-1: unknown block mode ${JSON.stringify(mode)}`);
  const headerLine = cursor.readLine();
  const header = headerLine === "" ? [] : headerLine.split("\t").map(unescapeCell);
  const rowCount = Number(cursor.readLine());
  if (!Number.isInteger(rowCount) || rowCount < 0) throw new Error("tl-table-1: invalid row count");
  const rows: string[][] = [];
  for (let i = 0; i < rowCount; i++) {
    const line = cursor.readLine();
    const cells = line === "" && header.length === 0 ? [] : line.split("\t");
    if (cells.length !== header.length) throw new Error("tl-table-1: row/column count mismatch");
    rows.push(cells);
  }
  return { mode, header, rows };
}

function decode(text: string): CodecPayload {
  const cursor = new LineCursor(text);
  const magic = cursor.readLine();
  if (magic !== MAGIC) throw new Error(`tl-table-1: bad magic ${JSON.stringify(magic)}`);
  const skeletonLen = Number(cursor.readLine());
  if (!Number.isInteger(skeletonLen) || skeletonLen < 0) throw new Error("tl-table-1: invalid skeleton length");
  const skeletonText = cursor.readChars(skeletonLen);
  cursor.expectNewline();
  const skeleton: unknown = JSON.parse(skeletonText);
  const blockCount = Number(cursor.readLine());
  if (!Number.isInteger(blockCount) || blockCount < 0) throw new Error("tl-table-1: invalid block count");
  const blocks: Block[] = [];
  for (let i = 0; i < blockCount; i++) blocks.push(decodeBlock(cursor));
  const result = reinsert(skeleton, blocks);
  if (!isPlainObject(result)) throw new Error("tl-table-1: decoded root is not an object");
  return result;
}

function canEncode(_kind: Kind, payload: CodecPayload): boolean {
  try {
    const blocks: Block[] = [];
    extract(payload, blocks);
    return blocks.length > 0;
  } catch {
    return false;
  }
}

export const tlTable1Codec: ResponseCodec = {
  id: "tl-table-1",
  version: "1",
  canEncode,
  encode,
  decode,
};
