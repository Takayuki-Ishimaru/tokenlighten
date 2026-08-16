/**
 * scipReader.ts — minimal hand-rolled SCIP protobuf decoder.
 *
 * SCIP proto fields we care about:
 *   Index (top-level message):
 *     field 2: documents (repeated Document)
 *     field 3: external_symbols (repeated SymbolInformation — skipped)
 *
 *   Document:
 *     field 1: relative_path (string)
 *     field 4: occurrences (repeated Occurrence)
 *
 *   Occurrence:
 *     field 1: range (repeated int32, packed or unpacked — [startLine, startChar, endLine, endChar] or [startLine, startChar, endLine] for same-line)
 *     field 2: symbol (string)
 *     field 3: symbol_roles (int32; bit 0 = IsDefinition)
 *
 * Wire types: 0=varint, 1=64-bit, 2=length-delimited, 5=32-bit.
 * Unknown fields are skipped via wire-type rules.
 *
 * Exports parseScip(buf: Buffer): GraphIndex.
 */

import type { GraphIndex, GraphLocation } from "./index.js";

// ---------------------------------------------------------------------------
// Protobuf wire-type constants
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN_DELIM = 2;
const WIRE_32BIT = 5;

// ---------------------------------------------------------------------------
// Low-level protobuf reader
// ---------------------------------------------------------------------------

class ProtoReader {
  private pos: number = 0;
  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  get position(): number {
    return this.pos;
  }

  /**
   * Read a base-128 varint.
   *
   * Regression: this used to accumulate via `result |= (byte&0x7f) << shift`
   * with a separate float-based "hi" fallback once `shift > 28`, commented
   * as reading into a float "to avoid signed 32-bit truncation" past 28
   * bits — but `|=`/`<<` ToInt32-coerce their operands to 32 bits BEFORE
   * that fallback is ever consulted, so a payload byte at shift 28 whose
   * value needs bits 4-6 (i.e. >= 16) already had those bits silently
   * shifted past bit 31 and dropped on the very same line. Worse, for a
   * varint whose LAST byte lands at shift 28, the loop's own
   * `if ((byte & 0x80) === 0) break;` fires before the `shift > 28` check
   * is ever reached, so the fallback never even runs — the function
   * returned the corrupted `result` directly. Accumulating with regular
   * (non-bitwise) arithmetic instead avoids 32-bit coercion entirely:
   * `+`/`*` operate on IEEE-754 doubles, exact for integers up to 2^53 —
   * far beyond any line/column/symbol-role value this reader needs — so no
   * separate high-bits path is needed at all.
   */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      if (this.pos >= this.buf.length) throw new Error("scip: unexpected end of buffer reading varint");
      const byte = this.buf[this.pos++]!;
      result += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  }

  /** Read a tag and return { fieldNumber, wireType }. */
  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readVarint();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }

  /** Read a length-delimited field as a Buffer slice. */
  readBytes(): Buffer {
    const len = this.readVarint();
    if (this.pos + len > this.buf.length) throw new Error("scip: length-delimited overrun");
    const slice = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  /** Read a length-delimited field as UTF-8 string. */
  readString(): string {
    return this.readBytes().toString("utf8");
  }

  /** Skip a field by wire type. */
  skipByWireType(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarint();
        break;
      case WIRE_64BIT:
        this.pos += 8;
        break;
      case WIRE_LEN_DELIM:
        this.readBytes();
        break;
      case WIRE_32BIT:
        this.pos += 4;
        break;
      default:
        throw new Error(`scip: unknown wire type ${wireType}`);
    }
  }

  /** Decode a sub-message from a length-delimited slice. */
  sub(): ProtoReader {
    return new ProtoReader(this.readBytes());
  }
}

// ---------------------------------------------------------------------------
// SCIP structure types
// ---------------------------------------------------------------------------

interface ScipOccurrence {
  symbol: string;
  startLine: number;
  startChar: number;
  isDefinition: boolean;
}

interface ScipDocument {
  relativePath: string;
  occurrences: ScipOccurrence[];
}

// ---------------------------------------------------------------------------
// Parse a packed or unpacked repeated int32 range field.
// SCIP range is [startLine, startChar, endLine, endChar] (4 ints) or
// [startLine, startChar, endLine] (3 ints, same-line shorthand where endChar
// is encoded differently). We only need startLine and startChar.
// ---------------------------------------------------------------------------

function parseRangeField(bytes: Buffer): { startLine: number; startChar: number } {
  // Try to decode as packed varint array.
  const reader = new ProtoReader(bytes);
  const values: number[] = [];
  while (!reader.done) {
    values.push(reader.readVarint());
  }
  if (values.length >= 2) {
    return { startLine: values[0]!, startChar: values[1]! };
  }
  return { startLine: 0, startChar: 0 };
}

// ---------------------------------------------------------------------------
// Parse an Occurrence message.
// ---------------------------------------------------------------------------

function parseOccurrence(reader: ProtoReader): ScipOccurrence {
  let symbol = "";
  let startLine = 0;
  let startChar = 0;
  let symbolRoles = 0;

  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1: { // range — length-delimited packed int32s
        if (wireType === WIRE_LEN_DELIM) {
          const rangeBytes = reader.readBytes();
          const parsed = parseRangeField(rangeBytes);
          startLine = parsed.startLine;
          startChar = parsed.startChar;
        } else {
          reader.skipByWireType(wireType);
        }
        break;
      }
      case 2: { // symbol — string
        if (wireType === WIRE_LEN_DELIM) {
          symbol = reader.readString();
        } else {
          reader.skipByWireType(wireType);
        }
        break;
      }
      case 3: { // symbol_roles — int32 (varint)
        if (wireType === WIRE_VARINT) {
          symbolRoles = reader.readVarint();
        } else {
          reader.skipByWireType(wireType);
        }
        break;
      }
      default:
        reader.skipByWireType(wireType);
        break;
    }
  }

  return {
    symbol,
    startLine,
    startChar,
    isDefinition: (symbolRoles & 1) !== 0,
  };
}

// ---------------------------------------------------------------------------
// Parse a Document message.
// ---------------------------------------------------------------------------

function parseDocument(reader: ProtoReader): ScipDocument {
  let relativePath = "";
  const occurrences: ScipOccurrence[] = [];

  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 1: { // relative_path — string
        if (wireType === WIRE_LEN_DELIM) {
          relativePath = reader.readString();
        } else {
          reader.skipByWireType(wireType);
        }
        break;
      }
      case 4: { // occurrences — repeated Occurrence
        if (wireType === WIRE_LEN_DELIM) {
          const sub = reader.sub();
          occurrences.push(parseOccurrence(sub));
        } else {
          reader.skipByWireType(wireType);
        }
        break;
      }
      default:
        reader.skipByWireType(wireType);
        break;
    }
  }

  return { relativePath, occurrences };
}

// ---------------------------------------------------------------------------
// Parse the top-level Index message.
// ---------------------------------------------------------------------------

function parseIndex(reader: ProtoReader): ScipDocument[] {
  const documents: ScipDocument[] = [];

  while (!reader.done) {
    const { fieldNumber, wireType } = reader.readTag();
    switch (fieldNumber) {
      case 2: { // documents — repeated Document
        if (wireType === WIRE_LEN_DELIM) {
          const sub = reader.sub();
          documents.push(parseDocument(sub));
        } else {
          reader.skipByWireType(wireType);
        }
        break;
      }
      default:
        reader.skipByWireType(wireType);
        break;
    }
  }

  return documents;
}

// ---------------------------------------------------------------------------
// Build a GraphIndex from parsed SCIP documents.
// ---------------------------------------------------------------------------

function buildGraphIndex(documents: ScipDocument[]): GraphIndex {
  // symbol -> definition location
  const defMap = new Map<string, GraphLocation>();
  // symbol -> list of reference locations
  const refMap = new Map<string, GraphLocation[]>();
  // filePath -> list of symbols defined in other files that this file references
  // (used to approximate importsOf)
  const importsMap = new Map<string, Set<string>>();

  for (const doc of documents) {
    const filePath = doc.relativePath;
    if (!importsMap.has(filePath)) {
      importsMap.set(filePath, new Set());
    }

    for (const occ of doc.occurrences) {
      if (!occ.symbol) continue;
      const loc: GraphLocation = { path: filePath, line: occ.startLine, column: occ.startChar };

      if (occ.isDefinition) {
        if (!defMap.has(occ.symbol)) {
          defMap.set(occ.symbol, loc);
        }
      } else {
        const existing = refMap.get(occ.symbol);
        if (existing) {
          existing.push(loc);
        } else {
          refMap.set(occ.symbol, [loc]);
        }
      }
    }
  }

  // Build importsOf: for each file, find symbols referenced (non-def) whose
  // definition lives in a different file — those are "imports".
  const importsOfMap = new Map<string, string[]>();
  for (const doc of documents) {
    const filePath = doc.relativePath;
    const importedPaths = new Set<string>();
    for (const occ of doc.occurrences) {
      if (!occ.symbol || occ.isDefinition) continue;
      const defLoc = defMap.get(occ.symbol);
      if (defLoc && defLoc.path !== filePath) {
        importedPaths.add(defLoc.path);
      }
    }
    importsOfMap.set(filePath, Array.from(importedPaths));
  }

  // exportsOf: symbols defined in a file.
  const exportsOfMap = new Map<string, string[]>();
  for (const doc of documents) {
    const filePath = doc.relativePath;
    const exported: string[] = [];
    for (const occ of doc.occurrences) {
      if (occ.symbol && occ.isDefinition) {
        exported.push(occ.symbol);
      }
    }
    exportsOfMap.set(filePath, exported);
  }

  return {
    definition(symbol: string): GraphLocation | undefined {
      return defMap.get(symbol);
    },
    references(symbol: string): GraphLocation[] {
      return refMap.get(symbol) ?? [];
    },
    importsOf(filePath: string): string[] {
      return importsOfMap.get(filePath) ?? [];
    },
    exportsOf(filePath: string): string[] {
      return exportsOfMap.get(filePath) ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse a SCIP binary protobuf buffer into a GraphIndex.
 * Throws on malformed input.
 */
export function parseScip(buf: Buffer): GraphIndex {
  const reader = new ProtoReader(buf);
  const documents = parseIndex(reader);
  return buildGraphIndex(documents);
}
