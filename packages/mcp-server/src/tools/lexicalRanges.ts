import { createHash } from "node:crypto";
import { treeSitterSupports, withTreeSitterRoot, type TreeSitterNode } from "../skeleton/treeSitter.js";

export type LexicalKind = "comment" | "string";

export interface LexicalSegment {
  line: number;
  startCol: number;
  endCol: number;
  kind: LexicalKind;
}

function namedChildren(node: TreeSitterNode): TreeSitterNode[] {
  const out: TreeSitterNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

function kindForNode(type: string): LexicalKind | undefined {
  const lower = type.toLowerCase();
  if (lower.includes("comment")) return "comment";
  if (
    lower.includes("string") ||
    lower.includes("template") ||
    lower === "char_literal" ||
    lower === "character_literal" ||
    lower === "interpreted_string_literal" ||
    lower === "raw_string_literal"
  ) {
    return "string";
  }
  return undefined;
}

function pushNodeSegments(out: LexicalSegment[], node: TreeSitterNode, kind: LexicalKind): void {
  const start = node.startPosition;
  const end = node.endPosition;
  if (!start || !end) return;

  const startLine = start.row + 1;
  const endLine = end.row + 1;
  for (let line = startLine; line <= endLine; line++) {
    out.push({
      line,
      startCol: line === startLine ? start.column : 0,
      endCol: line === endLine ? end.column : Number.MAX_SAFE_INTEGER,
      kind,
    });
  }
}

// ---------------------------------------------------------------------------
// Perf (2026-09-27, large-workspace task_pack cost, item B): process-level
// LRU memo for collectLexicalSegments, keyed by (language, content hash).
// Both real callers (findReferences.ts, renameSymbol.ts) invoke this once
// per scanned file that contains their target symbol; a large source file
// matched by BOTH of a task_pack's two Layer-4 findReferences() calls (two
// different symbol tokens) was tree-sitter-parsed twice, and an unedited
// file is reparsed on every task_pack that happens to reference it. Keyed
// by CONTENT, not path: the derived comment/string ranges are a pure
// function of (text, language), so an unedited file (or a byte-identical
// copy at a different path — e.g. a vendored file shared by two packages)
// is a genuine cache hit either way; an edited file gets a new hash and is
// reparsed exactly once, naturally invalidating without any explicit
// eviction-on-write logic.
//
// Bounded like ScanContentCache/rootResolverCache elsewhere in this
// package: an explicit byte budget over what the cache really holds, LRU-
// evicted (JS Map iterates in insertion order, so delete+re-set on a hit is
// enough to act as an LRU without a separate linked list). Entries are
// stored packed — one Int32Array of (line, startCol, endCol, kind)
// quadruples per text — and a fresh Map is rebuilt on every hit: measured
// 2026-09-28 on an 11.6k-file workspace, keeping the per-segment objects
// and budgeting by source-text length retained 78 MB for a nominal 32 MiB.
// A failed parse (unsupported grammar, WASM load failure) is never cached,
// so a later call retries exactly as it did before this memo existed.
// ---------------------------------------------------------------------------

const LEXICAL_SEGMENTS_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** Test-only override for the byte budget above — exercising the REAL 32 MiB
 * bound in a unit test would mean allocating and parsing tens of MB of
 * fixture text. Defaults to the real constant; `resetLexicalSegmentsCache`
 * also resets this back to the default so one test's override cannot leak
 * into the next. */
let lexicalSegmentsCacheMaxBytes = LEXICAL_SEGMENTS_CACHE_MAX_BYTES;

/** Kind codes of the packed encoding (index = code). */
const PACKED_KINDS: readonly LexicalKind[] = ["comment", "string"];
/** Packed `endCol` for "to the end of the line" — Number.MAX_SAFE_INTEGER does not fit an Int32Array. */
const PACKED_OPEN_END = -1;
/** Accounted per-entry overhead beyond the packed array: the hex key string, the Map slot and the typed-array header. */
const PACKED_ENTRY_OVERHEAD_BYTES = 256;

interface LexicalSegmentsCacheEntry {
  /** (line, startCol, endCol, kindCode) quadruples, in the unpacked Map's iteration order. */
  packed: Int32Array;
  bytes: number;
}

const lexicalSegmentsCache = new Map<string, LexicalSegmentsCacheEntry>();
let lexicalSegmentsCacheBytes = 0;

function lexicalSegmentsCacheKey(text: string, language: string): string {
  return `${language}:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function packSegments(byLine: Map<number, LexicalSegment[]>): Int32Array {
  let count = 0;
  for (const list of byLine.values()) count += list.length;
  const packed = new Int32Array(count * 4);
  let at = 0;
  for (const list of byLine.values()) {
    for (const segment of list) {
      packed[at++] = segment.line;
      packed[at++] = segment.startCol;
      packed[at++] = segment.endCol === Number.MAX_SAFE_INTEGER ? PACKED_OPEN_END : segment.endCol;
      packed[at++] = PACKED_KINDS.indexOf(segment.kind);
    }
  }
  return packed;
}

/**
 * A fresh, independent Map for every caller — never an instance the cache
 * holds — with the same line insertion order and per-line segment order as
 * the map that was packed.
 */
function unpackSegments(packed: Int32Array): Map<number, LexicalSegment[]> {
  const byLine = new Map<number, LexicalSegment[]>();
  for (let at = 0; at < packed.length; at += 4) {
    const line = packed[at]!;
    const endCol = packed[at + 2]!;
    const segment: LexicalSegment = {
      line,
      startCol: packed[at + 1]!,
      endCol: endCol === PACKED_OPEN_END ? Number.MAX_SAFE_INTEGER : endCol,
      kind: PACKED_KINDS[packed[at + 3]!]!,
    };
    const list = byLine.get(line);
    if (list) list.push(segment);
    else byLine.set(line, [segment]);
  }
  return byLine;
}

/** Test hook: forget every cached parse AND restore the real byte budget (see `__setLexicalSegmentsCacheMaxBytesForTest`). */
export function resetLexicalSegmentsCache(): void {
  lexicalSegmentsCache.clear();
  lexicalSegmentsCacheBytes = 0;
  lexicalSegmentsCacheMaxBytes = LEXICAL_SEGMENTS_CACHE_MAX_BYTES;
}

/** Test-only: shrink the byte budget so eviction is exercisable without allocating tens of MB of fixture text. Never called from production code. */
export function __setLexicalSegmentsCacheMaxBytesForTest(bytes: number): void {
  lexicalSegmentsCacheMaxBytes = bytes;
}

/** Test-only: the bytes the cache currently accounts for (sizes budgets in terms of real entries). */
export function __lexicalSegmentsCacheBytesForTest(): number {
  return lexicalSegmentsCacheBytes;
}

export async function collectLexicalSegments(
  text: string,
  language: string,
): Promise<Map<number, LexicalSegment[]>> {
  if (!treeSitterSupports(language)) return new Map();

  const key = lexicalSegmentsCacheKey(text, language);
  const cached = lexicalSegmentsCache.get(key);
  if (cached) {
    // Re-insert to mark as most-recently-used — Map iterates in insertion
    // order, so the LEAST-recently-used entry is always the first one a
    // `.keys().next()` eviction walk below would see.
    lexicalSegmentsCache.delete(key);
    lexicalSegmentsCache.set(key, cached);
    return unpackSegments(cached.packed);
  }

  const segments = await withTreeSitterRoot(text, language, {}, (root) => {
    const out: LexicalSegment[] = [];
    const visit = (node: TreeSitterNode): void => {
      const kind = kindForNode(node.type);
      if (kind) {
        pushNodeSegments(out, node, kind);
        return;
      }
      for (const child of namedChildren(node)) visit(child);
    };
    visit(root);
    return out;
  });

  const byLine = new Map<number, LexicalSegment[]>();
  for (const segment of segments ?? []) {
    const existing = byLine.get(segment.line) ?? [];
    existing.push(segment);
    byLine.set(segment.line, existing);
  }
  for (const lineSegments of byLine.values()) {
    lineSegments.sort((a, b) => a.startCol - b.startCol || a.endCol - b.endCol);
  }
  if (segments === undefined) return byLine;

  const packed = packSegments(byLine);
  const bytes = packed.byteLength + PACKED_ENTRY_OVERHEAD_BYTES;
  // An entry that alone exceeds the whole budget is never cached (it would
  // immediately evict everything else) — it is simply parsed fresh every
  // time, exactly like before this memo existed.
  if (bytes <= lexicalSegmentsCacheMaxBytes) {
    while (lexicalSegmentsCacheBytes + bytes > lexicalSegmentsCacheMaxBytes && lexicalSegmentsCache.size > 0) {
      const oldestKey: string = lexicalSegmentsCache.keys().next().value as string;
      const oldest = lexicalSegmentsCache.get(oldestKey)!;
      lexicalSegmentsCache.delete(oldestKey);
      lexicalSegmentsCacheBytes -= oldest.bytes;
    }
    lexicalSegmentsCache.set(key, { packed, bytes });
    lexicalSegmentsCacheBytes += bytes;
  }

  // Not held by the cache (it keeps only `packed`), so it is safe to hand out.
  return byLine;
}

export function segmentKindAt(
  segments: Map<number, LexicalSegment[]>,
  line: number,
  column: number,
): LexicalKind | undefined {
  for (const segment of segments.get(line) ?? []) {
    if (column >= segment.startCol && column < segment.endCol) return segment.kind;
  }
  return undefined;
}
