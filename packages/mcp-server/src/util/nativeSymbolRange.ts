/**
 * nativeSymbolRange.ts — shared C/C++ ("native") path predicate + range
 * widener.
 *
 * Consolidates what were two independent copies:
 *   - readCodeTaskPack.ts's `isNativeExtPath` + `NATIVE_EXTS` + `widenNativeSymbolRange`
 *   - locateTaskContext.ts's `isCppPath` + `CPP_EXTS` + `widenNativeCandidateRange`
 *
 * Both call sites want the SAME heuristic: read the file, collectSymbols,
 * pick the smallest enclosing symbol containing the match line, cap its
 * span at MAX_NATIVE_SYMBOL_LINES, and fall back to a generous ±half-cap
 * window around the match line when no symbol encloses it (e.g. a
 * file-scope lookup table). Only real difference between the two prior
 * copies: readCodeTaskPack.ts's version accepted an optional read/parse
 * cache (its per-pack FileReadCache) so a pack build doesn't re-read/
 * re-parse the same file multiple times; locateTaskContext.ts's version
 * always read fresh. That difference is preserved here via an optional
 * `NativeSymbolRangeCache` parameter — pass one to get memoized reads,
 * omit it to always read fresh (locateTaskContext.ts's prior behavior).
 *
 * util/ must not import from tools/ — this module owns the full
 * implementation rather than re-exporting a tools/ helper.
 */

import * as fs from "fs";
import * as path from "path";
import { languageForPathWithContent } from "./languages.js";
import { collectSymbols, type CollectedSymbol } from "../symbols/collectSymbols.js";

/**
 * Cap on a widened native (C/C++) symbol range's line count: keeps one huge
 * enclosing symbol (e.g. a large class/struct) from swallowing the whole
 * per-surface/candidate code budget.
 */
export const MAX_NATIVE_SYMBOL_LINES = 120;

const NATIVE_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hh", ".hxx"]);

/** True for a C/C++ source/header path (by extension). */
export function isNativeExtPath(relPath: string): boolean {
  return NATIVE_EXTS.has(path.extname(relPath).toLowerCase());
}

/**
 * Minimal read/parse memo a caller may optionally supply so repeated
 * widening calls over the same pack/locate run don't re-read or re-parse
 * the same file. Structurally compatible with readCodeTaskPack.ts's
 * FileReadCache (which already exposes `read` and `parsedSymbols` with
 * these exact signatures) — no adapter needed at that call site.
 */
export interface NativeSymbolRangeCache {
  read(workspace: string, relPath: string): string | undefined;
  parsedSymbols(text: string, lang: string, relPath: string): Promise<CollectedSymbol[] | null>;
}

function readFresh(workspace: string, relPath: string): string | undefined {
  try {
    return fs.readFileSync(path.join(workspace, relPath), "utf8");
  } catch {
    return undefined;
  }
}

async function parseFresh(text: string, lang: string): Promise<CollectedSymbol[] | null> {
  try {
    return await collectSymbols(text, lang, {});
  } catch {
    return null;
  }
}

/**
 * Widen [startLine, endLine] to the enclosing symbol of a C/C++ file at
 * `relPath`, using `collectSymbols` to find the smallest symbol whose span
 * contains the midpoint of the incoming range (the actual matched line,
 * recovered from a fixed keyword-centered window). Falls back to a
 * generous ±MAX_NATIVE_SYMBOL_LINES/2 window around the match line when no
 * enclosing symbol is found (e.g. a file-scope lookup table outside any
 * function/class). Never shrinks the input range — widening is additive
 * only. Returns the input unchanged on any I/O/parse failure, when the
 * path's language is unsupported, or when `relPath` is not a native-ext
 * path.
 */
export async function widenNativeRange(
  workspace: string,
  relPath: string,
  startLine: number,
  endLine: number,
  cache?: NativeSymbolRangeCache,
): Promise<{ startLine: number; endLine: number }> {
  if (!isNativeExtPath(relPath)) return { startLine, endLine };
  const matchLine = Math.round((startLine + endLine) / 2);

  const text = cache ? cache.read(workspace, relPath) : readFresh(workspace, relPath);
  if (text === undefined) return { startLine, endLine };

  // .h is dual-listed c/cpp in the MCP contract — sniff text (read above) so
  // a C++-shaped header resolves to "cpp" instead of the static "c" answer,
  // picking the right tree-sitter grammar for the widening parse below.
  const lang = languageForPathWithContent(relPath, text);
  if (!lang) return { startLine, endLine };

  const symbols = cache ? await cache.parsedSymbols(text, lang, relPath) : await parseFresh(text, lang);
  if (symbols === null) return { startLine, endLine };

  // Smallest enclosing symbol whose range contains matchLine (innermost —
  // e.g. a method inside a class picks the method, not the whole class).
  let best: { startLine: number; endLine: number } | undefined;
  for (const s of symbols) {
    if (s.startLine <= matchLine && matchLine <= s.endLine) {
      if (!best || (s.endLine - s.startLine) < (best.endLine - best.startLine)) {
        best = { startLine: s.startLine, endLine: s.endLine };
      }
    }
  }

  if (!best) {
    const fallbackStart = Math.max(1, matchLine - Math.floor(MAX_NATIVE_SYMBOL_LINES / 2));
    const fallbackEnd = matchLine + Math.ceil(MAX_NATIVE_SYMBOL_LINES / 2);
    return {
      startLine: Math.min(fallbackStart, startLine),
      endLine: Math.max(fallbackEnd, endLine),
    };
  }

  const cappedEnd = Math.min(best.endLine, best.startLine + MAX_NATIVE_SYMBOL_LINES);
  return {
    startLine: Math.min(best.startLine, startLine),
    endLine: Math.max(cappedEnd, endLine),
  };
}

/**
 * String-range convenience wrapper over `widenNativeRange` for callers
 * (readCodeTaskPack.ts) whose candidate ranges are "start-end" strings
 * rather than a numeric pair. Returns the input `range` unchanged when it
 * is not a well-formed "start-end" string, in addition to every fail-open
 * case `widenNativeRange` itself covers.
 */
export async function widenNativeRangeString(
  workspace: string,
  relPath: string,
  range: string,
  cache?: NativeSymbolRangeCache,
): Promise<string> {
  if (!isNativeExtPath(relPath)) return range;
  const m = range.match(/^(\d+)-(\d+)$/);
  if (!m) return range;
  const rangeStart = parseInt(m[1]!, 10);
  const rangeEnd = parseInt(m[2]!, 10);
  const { startLine, endLine } = await widenNativeRange(workspace, relPath, rangeStart, rangeEnd, cache);
  return `${startLine}-${endLine}`;
}
