// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * Chunk extraction module.
 * Converts ExtractedSymbol[] + raw source into IndexedChunkV1[].
 */

import { createHash } from "node:crypto";
import type { ExtractedSymbol } from "./graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChunkKind = "symbol" | "class" | "module" | "route" | "config" | "text";

export type SymbolKind = "function" | "class" | "method" | "const" | "type";

export interface IndexedChunkV1 {
  /** sha256(path + "\0" + byteStart + "\0" + byteEnd + "\0" + kind) */
  id: string;
  path: string;
  kind: ChunkKind;
  symbolName?: string;
  parentSymbolName?: string;
  lineStart: number;
  lineEnd: number;
  byteStart: number;
  byteEnd: number;
  signature: string;
  tokenEstimate: number;
  identifiers: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_SLICE_BYTES = 400 * 4; // 1600 bytes per token-slice

function chunkId(path: string, byteStart: number, byteEnd: number, kind: ChunkKind): string {
  return createHash("sha256")
    .update(`${path}\0${byteStart}\0${byteEnd}\0${kind}`)
    .digest("hex");
}

function classifyKind(signature: string, language: string): ChunkKind {
  if (/\b(class|interface|struct|enum|trait)\b/.test(signature)) return "class";
  if (language === "go" && /^func\s+\(/.test(signature.trimStart())) return "symbol";
  return "symbol";
}

function extractIdentifiers(text: string): string[] {
  // Iterate matchAll lazily and stop at the 32nd unique identifier —
  // spreading the whole iterator first materialized every occurrence in the
  // chunk before the cap could apply.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const tok = m[0]!;
    if (!seen.has(tok)) {
      seen.add(tok);
      result.push(tok);
      if (result.length >= 32) break;
    }
  }
  return result.sort();
}

function buildByteOffsets(lines: string[]): number[] {
  // byteOffsets[i] = byte offset of the START of line i+1 (0-indexed → 1-indexed lines).
  // byteOffsets has length lines.length + 1.
  const offsets = new Array<number>(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i++) {
    // "\n" is always one UTF-8 byte — adding 1 avoids concatenating a fresh
    // string per line just to measure it.
    offsets[i + 1] = offsets[i]! + Buffer.byteLength(lines[i]!) + 1;
  }
  return offsets;
}

function makeTextChunks(
  path: string,
  raw: string,
  totalBytes: number,
): IndexedChunkV1[] {
  const chunks: IndexedChunkV1[] = [];
  const lines = raw.split(/\r\n|\r|\n/);
  const byteOffsets = buildByteOffsets(lines);

  let sliceIndex = 0;
  let bytePos = 0;
  // bytePos only moves forward, so the line containing it is found by
  // advancing a cursor instead of rescanning the offsets from the top for
  // every chunk (that rescan made chunking O(chunks × lines) on large text
  // files).
  let startCursor = 0;

  while (bytePos < totalBytes) {
    const byteStart = bytePos;
    const byteEnd = Math.min(bytePos + TOKEN_SLICE_BYTES, totalBytes);

    while (startCursor + 1 < byteOffsets.length - 1 && byteOffsets[startCursor + 1]! <= byteStart) {
      startCursor++;
    }
    const lineStart = startCursor + 1;
    let lineEnd = lineStart;
    for (let i = lineStart - 1; i < byteOffsets.length - 1; i++) {
      if (byteOffsets[i + 1]! <= byteEnd) lineEnd = i + 1;
      else break;
    }

    const body = raw.slice(byteStart, byteEnd);
    const kind: ChunkKind = "text";
    const tokenEstimate = Math.max(1, Math.ceil((byteEnd - byteStart) / 4));

    chunks.push({
      id: chunkId(path, byteStart, byteEnd, kind),
      path,
      kind,
      symbolName: undefined,
      lineStart,
      lineEnd,
      byteStart,
      byteEnd,
      signature: "",
      tokenEstimate,
      identifiers: extractIdentifiers(body),
    });

    bytePos = byteEnd;
    sliceIndex++;
    if (bytePos >= totalBytes) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Extract chunks from a source file.
 * Converts ExtractedSymbol[] into IndexedChunkV1[].
 */
export function extractChunks(input: {
  path: string;
  raw: string;
  language: string;
  symbols: ExtractedSymbol[];
}): IndexedChunkV1[] {
  const { path, raw, language, symbols } = input;
  const lines = raw.split(/\r\n|\r|\n/);
  const byteOffsets = buildByteOffsets(lines);
  const totalBytes = byteOffsets[lines.length]!;

  // No symbols in source file → emit text chunks if file has content.
  if (symbols.length === 0) {
    const isTextFile =
      language === "" ||
      /\.(md|markdown|txt|yaml|yml|json|toml|ini|cfg|conf|xml|csv)$/.test(path);
    if (raw.length > 0 && (isTextFile || symbols.length === 0)) {
      return makeTextChunks(path, raw, totalBytes);
    }
    return [];
  }

  const chunks: IndexedChunkV1[] = [];

  for (const sym of symbols) {
    const lineStart = sym.line;
    const lineEnd = sym.endLine;

    // Clamp to valid range (1-indexed lines).
    const clampedLineStart = Math.max(1, Math.min(lineStart, lines.length));
    const clampedLineEnd = Math.max(clampedLineStart, Math.min(lineEnd, lines.length));

    const byteStart = byteOffsets[clampedLineStart - 1]!;
    const byteEnd = byteOffsets[clampedLineEnd]!;

    const kind = classifyKind(sym.signature, language);
    const tokenEstimate = Math.max(1, Math.ceil((byteEnd - byteStart) / 4));

    if (tokenEstimate <= 400) {
      // Single chunk.
      const body = raw.slice(byteStart, byteEnd);
      chunks.push({
        id: chunkId(path, byteStart, byteEnd, kind),
        path,
        kind,
        symbolName: sym.name,
        lineStart: clampedLineStart,
        lineEnd: clampedLineEnd,
        byteStart,
        byteEnd,
        signature: sym.signature,
        tokenEstimate,
        identifiers: extractIdentifiers(body),
      });
    } else {
      // Large symbol: split into slices of TOKEN_SLICE_BYTES.
      let sliceIndex = 0;
      let pos = byteStart;
      // pos only moves forward — advance a cursor for each slice's start line
      // instead of rescanning the symbol's whole line range per slice.
      let sliceStartCursor = clampedLineStart - 1;

      while (pos < byteEnd) {
        const sliceByteStart = pos;
        const sliceByteEnd = Math.min(pos + TOKEN_SLICE_BYTES, byteEnd);

        while (sliceStartCursor + 1 <= clampedLineEnd && byteOffsets[sliceStartCursor + 1]! <= sliceByteStart) {
          sliceStartCursor++;
        }
        const sliceLineStart = sliceStartCursor + 1;
        let sliceLineEnd = sliceLineStart;
        for (let i = sliceLineStart - 1; i <= clampedLineEnd; i++) {
          if (byteOffsets[i + 1] !== undefined && byteOffsets[i + 1]! <= sliceByteEnd) {
            sliceLineEnd = i + 1;
          } else {
            break;
          }
        }

        const body = raw.slice(sliceByteStart, sliceByteEnd);
        const sliceTokenEstimate = Math.max(1, Math.ceil((sliceByteEnd - sliceByteStart) / 4));

        chunks.push({
          id: chunkId(path, sliceByteStart, sliceByteEnd, kind),
          path,
          kind,
          symbolName: `${sym.name}#${sliceIndex}`,
          lineStart: sliceLineStart,
          lineEnd: sliceLineEnd,
          byteStart: sliceByteStart,
          byteEnd: sliceByteEnd,
          signature: sym.signature,
          tokenEstimate: sliceTokenEstimate,
          identifiers: extractIdentifiers(body),
        });

        pos = sliceByteEnd;
        sliceIndex++;
        if (pos >= byteEnd) break;
      }
    }
  }

  return chunks;
}
