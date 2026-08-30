/**
 * readCodeModes.ts — multi-resolution read_code handlers for v0.6.
 *
 * Exports:
 *   resolveMap    — mode=map  (R0: surface map, no code body)
 *   resolveDigest — mode=digest (R1: file/symbol digest)
 *   resolveSlice  — mode=slice (R2: symbol/range slice with handle + sha)
 *
 * mode=full (R3) stays in server.ts; it uses READ_FULL_CAP_BYTES which
 * is declared there.
 *
 * No Date.now() / Math.random() / argless new Date() used here.
 * All paths are workspace-relative POSIX paths.
 */

import { handleTable, shaOfText } from "../util/handles.js";
import { getSymbolWithContext } from "./getSymbolWithContext.js";
import { locateTaskContext } from "../features/locator/locateTaskContext.js";
import { languageForPathWithContent } from "../util/languages.js";
import { countLines, sliceLinesToText } from "../util/countLines.js";
import { collectSymbols, type CollectedSymbol } from "../symbols/collectSymbols.js";
import { getConcernTokens, hasConcernNoteFired, markConcernNoteFired, recordReadPath, isClosureSatisfied } from "../state/session.js";
import { isMarkdownPath, parseMarkdownHeadings, selectMarkdownSections } from "../util/markdownSections.js";
import type { TreeSitterPaths } from "../skeleton/types.js";
import type {
  ReadCodeMapOutput,
  ReadCodeDigestOutput,
  ReadCodeSliceOutput,
  ImpactSurface,
  McpLang,
} from "@tokenlighten/types";
import { MCP_LANGS } from "@tokenlighten/types";

// ---------------------------------------------------------------------------
// Byte caps
// ---------------------------------------------------------------------------

/** Maximum serialized JSON bytes for mode=map response. */
const MAP_CAP_BYTES = 1024;

/** Maximum serialized JSON bytes for mode=digest response. */
const DIGEST_CAP_BYTES = 2048;

/**
 * Hard byte cap for mode=slice content. Also imported by server.ts for its
 * mode=symbol downgrade path (single source of truth — no longer duplicated
 * there as of 2026-07-16a; was 8192).
 */
export const READ_SYMBOL_CAP_BYTES = 24576;

/**
 * A2 ranges[] batching — overall serialized budget for the SEGMENTS of one
 * multi-range slice serve. Each segment is still individually bounded by
 * READ_SYMBOL_CAP_BYTES (resolveSlice does that per segment); this is the
 * response-level ceiling that decides how many segments ride along. Set to the
 * same 24 KiB tier as the single-slice cap: a caller asking for 4 windows of one
 * spec file was paying 4 round trips (live: CONTRACT.md), and 24 KiB of already-
 * computed content is far cheaper than three extra turns. Trailing segments that
 * do not fit are DROPPED (never silently truncated mid-segment) and named in
 * `remaining_ranges` so the caller closes them in one follow-up call.
 */
export const SLICE_RANGES_TOTAL_CAP_BYTES = 24576;

/**
 * Bound on how many ranges one call may batch. A caller that wants more windows
 * than this of the same file wants mode=full/mode=symbol, not a 30-way batch.
 */
export const MAX_SLICE_RANGES = 12;

// ---------------------------------------------------------------------------
// T1/T2 size governance (2026-08-27 field-eval)
//
// Shared by readCodeTaskPack.ts's capForResult (task_pack) and server.ts's
// handles=[]/paths=[] batch loops -- ONE place resolving "did the caller ask
// for a smaller response than the default", so the two call sites cannot
// silently diverge. See clientProfile.ts's resolveDefaultResponseByteCeiling
// for the sibling env/client-profile precedence that feeds `defaultCeiling`
// below when the caller supplied neither maxBytes nor maxTokens.
// ---------------------------------------------------------------------------

/** Never trim a task_pack response smaller than this, however small the resolved ceiling -- "never refuse" stays true at every cap. */
export const DEFAULT_RESPONSE_BYTE_FLOOR = 4096;

const BYTES_PER_TOKEN_ESTIMATE = 4;

/**
 * The byte ceiling the CALLER's own arguments impose, or `defaultCeiling`
 * when the caller supplied neither. Never widens `defaultCeiling`: an
 * explicit maxBytes/maxTokens can only ask for LESS than the default,
 * matching every other cap in this server ("never loosen honesty") -- a
 * generous value here is simply ignored in favor of whatever tighter,
 * type-specific bound the response family already enforces.
 */
export function resolveCallerByteCeiling(
  explicitMaxBytes: number | undefined,
  explicitMaxTokens: number | undefined,
  defaultCeiling: number | undefined,
): number | undefined {
  const candidates: number[] = [];
  if (typeof explicitMaxBytes === "number" && Number.isFinite(explicitMaxBytes) && explicitMaxBytes > 0) {
    candidates.push(Math.floor(explicitMaxBytes));
  }
  if (typeof explicitMaxTokens === "number" && Number.isFinite(explicitMaxTokens) && explicitMaxTokens > 0) {
    candidates.push(Math.floor(explicitMaxTokens * BYTES_PER_TOKEN_ESTIMATE));
  }
  if (candidates.length > 0) return Math.min(...candidates);
  return defaultCeiling;
}

// ---------------------------------------------------------------------------
// Per-language import-line regexes (best-effort, first N lines).
// ---------------------------------------------------------------------------

const IMPORT_REGEXES: Array<RegExp> = [
  /^\s*import\s/,                               // TS/JS/Java/Kotlin/Go
  /^\s*from\s+['"][^'"]+['"]\s*import/,         // Python: from x import
  /^\s*(import|from)\s+/,                       // Python: import x  / from x import ...
  /^\s*use\s+[a-zA-Z_:]+/,                      // Rust
  /^\s*#\s*include\s/,                          // C/C++
];

/**
 * Extract import-like lines from the top of a file.
 * Caps at `maxImports` lines (default 12). Only includes lines that look
 * like imports per the per-language heuristics.
 */
function extractImports(content: string, maxImports = 12): string[] {
  const lines = content.split(/\r?\n/);
  const result: string[] = [];
  // Scan only the first 60 lines (imports are always near the top).
  const scanLimit = Math.min(lines.length, 60);
  for (let i = 0; i < scanLimit && result.length < maxImports; i++) {
    const line = lines[i]!;
    if (IMPORT_REGEXES.some((re) => re.test(line))) {
      result.push(line.trim());
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Symbol extraction from skeleton output
// ---------------------------------------------------------------------------

/**
 * Parse top-level symbol names and their 1-based line ranges from skeleton
 * signatures text. Returns at most `maxSymbols` entries (default 16).
 *
 * Heuristic: each non-blank, non-comment, non-indented line that looks like
 * a function/class/type declaration is a top-level symbol. We track which
 * original file line each skeleton line corresponds to using the elide
 * comment "/* <elided n=K> *\/" annotations.
 */
export async function extractSymbolsFromFile(
  content: string,
  _filePath: string,
  maxSymbols = 16,
  preferredNames: readonly string[] = [],
): Promise<Array<{ name: string; range: string; line: number }>> {
  // The skeleton call that used to be here always fell through to the regex
  // scan regardless of success; removed to eliminate overhead on the digest path.
  return extractSymbolsFromLines(
    content,
    maxSymbols,
    new Set(preferredNames.map((name) => name.toLowerCase())),
  );
}

/**
 * Lightweight regex scan to find top-level symbol declarations and
 * their approximate 1-based line ranges.
 *
 * EXPORTED (R2, 2026-08-28) as the SYNC twin `extractSymbolsFromFile` already
 * wraps — same function, same patterns, no I/O. The evidence-expansion ledger
 * needs "which definitions does this served body actually declare?" from inside
 * a synchronous recorder, and re-deriving that with a second, private pattern
 * set is how two answers to one question start disagreeing. Purely additive:
 * `extractSymbolsFromFile` still delegates here and is unchanged.
 */
export function extractSymbolsFromLines(
  content: string,
  maxSymbols = 16,
  preferredNames: ReadonlySet<string> = new Set(),
): Array<{ name: string; range: string; line: number }> {
  // Patterns for top-level declarations across TS/JS/Py/Go/Java/Rust.
  const DECL_PATTERNS: RegExp[] = [
    // TypeScript/JavaScript
    /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[(<]/,
    /^(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
    /^(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]/,
    /^(?:export\s+)?(?:type|interface|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
    // D2: bare TS/JS class-method declarations (no modifier at all — the
    // idiomatic shape for a public method, e.g. `assign(id: string): Foo {`).
    // The pre-existing `function`-keyword pattern above only matches
    // free functions and named methods declared with the `function`
    // keyword; it never matched THIS shape, so a class's own methods were
    // invisible to extractSymbolsFromLines and only the enclosing class
    // (often spanning hundreds of lines) was found as a boundary-cut's
    // "enclosing symbol" — defeating D2 boundary snapping for exactly the
    // common case its worked example targets. Guards:
    //   - optional modifier prefix (public/private/.../async/get/set) so
    //     modified methods still resolve here if no earlier pattern claims
    //     them first;
    //   - negative lookahead on JS/TS control-flow & reserved words so
    //     `if (...) {`, `for (...) {`, `catch (...) {`, `} else {` etc.
    //     are never mistaken for a declaration;
    //   - requires the line to END in an optional `: ReturnType` then `{`
    //     (single-line signature only — a multi-line signature's opening
    //     line has no trailing `{` and is correctly NOT matched here; that
    //     limitation is pre-existing and out of D2's scope).
    /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|override\s+|async\s+|get\s+|set\s+)*(?!(?:if|for|while|switch|catch|do|else|try|finally|return|throw|new|typeof|instanceof|in|of|yield|await|delete|void|super|this)\s*[(<])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::\s*[^{;]+)?\s*\{\s*$/,
    // Python
    /^(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
    /^class\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
    // Go
    /^func\s+(?:\([^)]+\)\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
    /^type\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:struct|interface)/,
    // Rust
    /^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/,
    /^(?:pub\s+)?(?:struct|enum|trait|impl)\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
    // Java
    /^(?:public|private|protected|static|\s)*(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    // D2 fix: the prefix group `(?:\S+\s+)+` originally had no requirement
    // that the matched line actually look like a declaration — `\S+` greedily
    // accepts prose punctuation (backticks, apostrophes, parens), so a Javadoc
    // comment line like "* is replaced (not merged)." false-matched "replaced"
    // as a symbol (confirmed against bench/fixtures/.../issueService.ts, whose
    // real Javadoc prose consumed the default maxSymbols budget before reaching
    // the actual `assign` method D2's own worked example targets). Anchoring
    // on a trailing `{` or `;` (declaration opener / interface-method
    // terminator) — the same anchor already used by the new bare-method
    // pattern below — rules out prose without narrowing real single-line Java
    // signatures (including a trailing `throws` clause).
    /^(?:public|private|protected|static|\s)*(?:\S+\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\s*[{;]\s*$/,
    // Kotlin
    /^(?:public|private|protected|internal|open|data|sealed|\s)*(?:class|interface|object|enum\s+class)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:public|private|protected|internal|suspend|inline|\s)*fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    // C#
    /^(?:public|private|protected|internal|static|abstract|sealed|partial|\s)*(?:class|interface|record|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(?:public|private|protected|internal|static|async|override|virtual|\s)*(?:[\w<>\[\],.?]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    // PHP
    /^(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    // Ruby
    /^class\s+([A-Z][A-Za-z0-9_]*)/,
    /^module\s+([A-Z][A-Za-z0-9_]*)/,
    /^def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_]*[!?=]?)\s*/,
    // C/C++
    /^(?:extern\s+)?(?:static\s+)?(?:inline\s+)?(?:const\s+)?(?:\w+[\s*&]+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/,
    /^(?:class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
    /^(?:enum)\s+(?:class\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/,
    /^namespace\s+([a-zA-Z_][a-zA-Z0-9_]*)/,
    /^(?:\w[\w\s*&]*\s+)?([a-zA-Z_]\w*::[a-zA-Z_]\w*)\s*\(/,
  ];

  const lines = content.split(/\r?\n/);
  const symbols: Array<{ name: string; startLine: number; endLine?: number }> = [];

  // Ordinary callers keep the bounded early exit. Anchor-focus callers may
  // pass explicitly named query identifiers; in that case scan declarations
  // to EOF so a symbol named by the user is not invisible merely because it
  // appears after the first `maxSymbols` declarations in a large file.
  const scanForPreferred = preferredNames.size > 0;
  for (let i = 0; i < lines.length && (scanForPreferred || symbols.length < maxSymbols); i++) {
    const line = lines[i]!;
    // Only top-level declarations (no leading whitespace beyond method-level).
    if (/^\s{4,}/.test(line)) continue; // skip deeply indented
    // C++ constructor initializer-list continuations (": member_(arg) {" /
    // ", other_(arg)") are not declarations — the bare-method pattern below
    // otherwise minted the first initializer as a phantom symbol, which both
    // polluted the list and stole the constructor's body lines (its range
    // collapsed to the signature line, so anchor-focus embedded an empty
    // body). 2026-07-11b live-bench C++ ctor shape.
    if (/^\s*[:,]/.test(line)) continue;
    for (const pat of DECL_PATTERNS) {
      const m = line.match(pat);
      if (m && m[1]) {
        symbols.push({ name: m[1], startLine: i + 1 });
        break;
      }
    }
  }

  // Estimate end lines from the complete scanned declaration list before
  // applying the ordinary cap. This preserves the exact end boundary for a
  // preferred late symbol instead of letting it incorrectly run to EOF.
  const ranged = symbols.map((sym, idx) => {
    const nextEntry = symbols[idx + 1];
    const nextStart: number = nextEntry !== undefined ? nextEntry.startLine : lines.length;
    const endLine = Math.max(sym.startLine, nextStart - 1);
    const rangeStr = String(sym.startLine) + "-" + String(endLine);
    return { name: sym.name, range: rangeStr, line: sym.startLine };
  });
  if (!scanForPreferred || ranged.length <= maxSymbols) return ranged.slice(0, maxSymbols);

  const selected = ranged.slice(0, maxSymbols);
  const selectedLines = new Set(selected.map((symbol) => symbol.line));
  for (const symbol of ranged) {
    if (!preferredNames.has(symbol.name.toLowerCase()) || selectedLines.has(symbol.line)) continue;
    selected.push(symbol);
    selectedLines.add(symbol.line);
  }
  return selected.sort((a, b) => a.line - b.line);
}

/**
 * Find up to N distinctive text hits for a symbol name within file content.
 * Returns lines where the symbol name appears but NOT on its own declaration line.
 */
function findTextHits(
  content: string,
  symbolName: string,
  maxHits = 4,
): Array<{ line: number; text: string }> {
  const lines = content.split(/\r?\n/);
  // Escape special regex chars in symbolName. Use explicit character list to avoid tsc
  // parser issues with backslash sequences inside template literals.
  const escaped = symbolName.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
  const re = new RegExp("\\b" + escaped + "\\b");
  const hits: Array<{ line: number; text: string }> = [];
  let declSeen = false;

  for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
    const line = lines[i]!;
    if (!re.test(line)) continue;
    // Skip the first declaration line.
    if (!declSeen) {
      declSeen = true;
      continue;
    }
    hits.push({ line: i + 1, text: line.trim().slice(0, 80) });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// D2: range-slice boundary snapping
// ---------------------------------------------------------------------------

/** A symbol's numeric 1-based [startLine, endLine] bounds, parsed from extractSymbolsFromLines. */
interface SymbolBounds {
  name: string;
  startLine: number;
  endLine: number;
}

/**
 * Parse extractSymbolsFromLines' `{name, range: "N-M", line}` entries into
 * numeric bounds. `range` is always well-formed ("\d+-\d+") because
 * extractSymbolsFromLines derives it from integer line numbers itself — this
 * never sees untrusted input.
 */
function symbolsToBounds(
  symbols: Array<{ name: string; range: string; line: number }>,
): SymbolBounds[] {
  const bounds: SymbolBounds[] = [];
  for (const sym of symbols) {
    const parts = sym.range.split("-");
    const startLine = parseInt(parts[0] ?? "", 10);
    const endLine = parseInt(parts[1] ?? "", 10);
    if (isNaN(startLine) || isNaN(endLine)) continue;
    bounds.push({ name: sym.name, startLine, endLine });
  }
  return bounds;
}

/**
 * Find the symbol whose body strictly contains `line` but does NOT start (or
 * end, per `edge`) exactly on it — i.e. `line` cuts the declaration mid-body
 * rather than landing on a clean boundary.
 *
 * First finds the INNERMOST (smallest span) symbol containing `line` at
 * all, then reports a cut only if THAT symbol's own edge is dirty. This
 * matters once bounds can genuinely nest (collectSymbols' tree-sitter
 * bounds: a class's [startLine,endLine] spans its whole body, containing
 * every method inside it) — a line landing cleanly on an inner method's own
 * boundary must not be reported as "cutting" an outer class merely because
 * the same line isn't the class's OWN start/end. (extractSymbolsFromLines'
 * regex fallback never hit this: its end-line-as-next-start approximation
 * makes an outer symbol's range stop before the next sibling starts, so
 * bounds there don't actually nest.)
 */
function findCuttingSymbol(
  bounds: SymbolBounds[],
  line: number,
  edge: "start" | "end",
): SymbolBounds | undefined {
  let innermost: SymbolBounds | undefined;
  for (const b of bounds) {
    if (line < b.startLine || line > b.endLine) continue;
    if (!innermost || b.endLine - b.startLine < innermost.endLine - innermost.startLine) {
      innermost = b;
    }
  }
  if (!innermost) return undefined;
  const onCleanEdge = edge === "start" ? line === innermost.startLine : line === innermost.endLine;
  return onCleanEdge ? undefined : innermost;
}

/**
 * D2: detect whether a requested [startLine, endLine] range cuts a symbol's
 * body mid-declaration at either edge, and — if so — return the enclosing
 * symbol to snap to. The START edge is checked first: it is the shape the
 * design's worked example and the live mid-method-slice repro both hit (a slice that begins
 * mid-method, at the bug's first record call), so it takes priority when a
 * range happens to cut two different symbols at once (start of one, end of
 * another) — an edge case the heuristic-based end-line approximation makes
 * possible but which real requests rarely produce.
 */
function findBoundaryCut(
  symbols: Array<{ name: string; range: string; line: number }>,
  startLine: number,
  endLine: number,
): SymbolBounds | undefined {
  const bounds = symbolsToBounds(symbols);
  return findCuttingSymbol(bounds, startLine, "start") ?? findCuttingSymbol(bounds, endLine, "end");
}

/** Map collectSymbols' tree-sitter output into the same SymbolBounds shape
 * findCuttingSymbol already operates on, using each symbol's own bare
 * declaration line (signatureStartLine, doc-comment excluded) through its
 * true closing line (endLine) — i.e. the exact span a subsequent
 * `symbol=<name>` slice would resolve to. */
function collectedSymbolsToBounds(symbols: CollectedSymbol[]): SymbolBounds[] {
  return symbols.map((s) => ({ name: s.name, startLine: s.signatureStartLine, endLine: s.endLine }));
}

/**
 * D2 (reuse fix): boundary-cut detection using EXACT tree-sitter bounds
 * (collectSymbols) instead of extractSymbolsFromLines' regex-approximated
 * end lines (end = next symbol's start - 1). The regex extractor is used
 * only as a fallback when tree-sitter is unavailable for the language or
 * throws — repo rule: the tree-sitter fallback must survive for optional
 * graph/index consumers, and this keeps that guarantee for boundary-cut too.
 * The emitted `note` string format is unchanged; only the numeric range it
 * reports becomes exact instead of approximate.
 */
async function findBoundaryCutAsync(
  content: string,
  filePath: string,
  startLine: number,
  endLine: number,
  treeSitterPaths?: TreeSitterPaths,
): Promise<SymbolBounds | undefined> {
  // .h is dual-listed c/cpp in the MCP contract — sniff content (already in
  // hand here) so a C++-shaped header resolves to "cpp" instead of the
  // static "c" answer, picking the right tree-sitter grammar via collectSymbols.
  const language = languageForPathWithContent(filePath, content);
  if (language) {
    try {
      const symbols = await collectSymbols(content, language, treeSitterPaths ?? {});
      if (symbols.length > 0) {
        const bounds = collectedSymbolsToBounds(symbols);
        return findCuttingSymbol(bounds, startLine, "start") ?? findCuttingSymbol(bounds, endLine, "end");
      }
    } catch {
      // Fall through to the regex extractor.
    }
  }
  return findBoundaryCut(extractSymbolsFromLines(content), startLine, endLine);
}

// ---------------------------------------------------------------------------
// resolveMap — R0: surface map
// ---------------------------------------------------------------------------

export type ResolveMapResult =
  | { ok: true; data: ReadCodeMapOutput }
  | { ok: false; reason: string; hit: false };

export async function resolveMap(
  workspace: string,
  args: {
    query?: string;
    path?: string;
    symbol?: string;
    lang?: string;
  },
): Promise<ResolveMapResult> {
  const query = args.query ?? "";
  if (!query && !args.path && !args.symbol) {
    return { ok: false, reason: "query is required for mode=map", hit: false };
  }

  const lang =
    typeof args.lang === "string" && (MCP_LANGS as readonly string[]).includes(args.lang)
      ? (args.lang as McpLang)
      : undefined;

  const locateResult = await locateTaskContext(workspace, {
    action: "locate",
    query: query || (args.symbol ?? args.path ?? ""),
    ...(args.symbol ? { symbol: args.symbol } : {}),
    ...(args.path ? { path: args.path } : {}),
    ...(lang ? { lang } : {}),
  });

  if (!locateResult.hit) {
    return { ok: false, reason: locateResult.reason, hit: false };
  }

  // Project to surface-map shape: one best per surface, no code body.
  const allCandidates = [locateResult.primary[0]!, ...locateResult.related];
  // Deduplicate by surface (keep first / highest-scored per surface).
  const seenSurface = new Set<ImpactSurface>();
  const surfaces: ReadCodeMapOutput["surfaces"] = [];

  for (const c of allCandidates) {
    if (seenSurface.has(c.surface)) continue;
    seenSurface.add(c.surface);

    // Ensure a handle is attached.
    const handleId = c.handle ?? handleTable.upsert({
      kind: c.symbol ? "symbol" : "range",
      path: c.path,
      range: c.range,
      symbol: c.symbol,
      workspaceRoot: workspace,
    }).id;

    surfaces.push({ role: c.surface, handle: handleId, path: c.path });

    if (surfaces.length >= 8) break;
  }

  const result: ReadCodeMapOutput = {
    mode: "map",
    surfaces,
    coverage: locateResult.completeness === "complete" ? "complete" : "partial",
    ...(locateResult.completeness !== "complete"
      ? { missing: locateResult.coverage
            ? (["contract", "api", "ui", "style", "domain", "config", "data", "test", "doc"] as ImpactSurface[])
                .filter((s) => !locateResult.coverage!.includes(s))
                .slice(0, 4)
            : [] }
      : {}),
  };

  // Trim from the tail until JSON fits in MAP_CAP_BYTES.
  let serialized = JSON.stringify(result);
  while (Buffer.byteLength(serialized, "utf8") > MAP_CAP_BYTES && result.surfaces.length > 1) {
    result.surfaces.pop();
    serialized = JSON.stringify(result);
  }

  return { ok: true, data: result };
}

// ---------------------------------------------------------------------------
// resolveDigest — R1: file/symbol digest
// ---------------------------------------------------------------------------

export type ResolveDigestResult =
  | { ok: true; data: ReadCodeDigestOutput }
  | { ok: false; error: string };

export async function resolveDigest(
  workspace: string,
  filePath: string,
  content: string,
  symbolName?: string,
): Promise<ResolveDigestResult> {
  const sha = shaOfText(content);

  // Mint or canonicalize a handle.
  const handleEntry = handleTable.upsert({
    kind: symbolName ? "symbol" : "file",
    path: filePath,
    ...(symbolName ? { symbol: symbolName } : {}),
    workspaceRoot: workspace,
    sha,
  });

  // Extract imports.
  const imports = extractImports(content);

  // Extract top-level symbols with ranges.
  const symbols = await extractSymbolsFromFile(content, filePath);

  // If a specific symbol was requested, compute text hits for it.
  const text_hits = symbolName ? findTextHits(content, symbolName) : undefined;

  const digest: ReadCodeDigestOutput["digest"] = {
    ...(imports.length > 0 ? { imports } : {}),
    ...(symbols.length > 0 ? { symbols } : {}),
    ...(text_hits && text_hits.length > 0 ? { text_hits } : {}),
  };

  let result: ReadCodeDigestOutput = {
    mode: "digest",
    handle: handleEntry.id,
    path: filePath,
    digest,
    sha,
  };

  // Trim to DIGEST_CAP_BYTES: drop text_hits first, then trim symbols from tail.
  let serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") > DIGEST_CAP_BYTES) {
    // Drop text_hits.
    const trimmedDigest: ReadCodeDigestOutput["digest"] = {
      ...(imports.length > 0 ? { imports } : {}),
      ...(symbols.length > 0 ? { symbols } : {}),
    };
    result = { ...result, digest: trimmedDigest };
    serialized = JSON.stringify(result);

    // Trim symbols from tail.
    let trimmedSymbols = symbols.slice();
    while (Buffer.byteLength(serialized, "utf8") > DIGEST_CAP_BYTES && trimmedSymbols.length > 0) {
      trimmedSymbols = trimmedSymbols.slice(0, -1);
      result = { ...result, digest: { ...trimmedDigest, symbols: trimmedSymbols } };
      serialized = JSON.stringify(result);
    }
  }

  return { ok: true, data: result };
}

// ---------------------------------------------------------------------------
// resolveSlice — R2: symbol or range slice with handle + sha
// ---------------------------------------------------------------------------

export type ResolveSliceResult =
  | {
      ok: true;
      /**
       * D2: `note` is additive to the shared ReadCodeSliceOutput contract
       * (kept local rather than added to packages/types/src/mcp.ts — this
       * workstream's file scope is readCodeModes.ts only). Present whenever a
       * requested RANGE boundary lands inside a symbol's body (a mid-
       * declaration cut). It NAMES the enclosing symbol + its true range and
       * points at `symbol=<name>`; the returned range/content/handle stay
       * exactly as requested (note-only — we never widen a range handle,
       * since it doubles as an edit handle). server.ts's single-handle
       * mode=slice path forwards `data` verbatim (toolOk(data: unknown)), so
       * `note` survives to the caller with no server.ts change; the handles[]
       * batch path (server.ts ~:720-727) destructures fields explicitly and
       * does NOT currently pass `note` through — flagged in the D2 report, not
       * fixed here (server.ts is out of this workstream's file scope).
       *
       * `assembled: true` (additive, symbol branch only) marks that `content`
       * is getSymbolWithContext's ASSEMBLED view (scope header + used-imports
       * + enclosing/sibling signatures + a `target:` marker + the body) —
       * NOT a raw file slice. `range` still carries the body's true FILE
       * range for handle/edit purposes, but it does not describe `content`'s
       * own line numbering (the preamble shifts every body line down by a
       * variable, file-independent offset). A caller computing elision/
       * display markers against `content` must treat line 1 of `content` as
       * line 1 (code-relative), the same exception server.ts's mode=symbol
       * path already documents — never bodyStart-offset file lines.
       */
      /**
       * `next` (additive, range branch only): present when the serve was
       * clamped to READ_SYMBOL_CAP_BYTES mid-range — names the WHOLE remaining
       * range in one continuation call (each follow-up clamps again, so the
       * read converges in ceil(bytes/cap) calls instead of an agent-invented
       * fixed-window walk). Forwarded verbatim by server.ts's single-handle
       * mode=slice path; the handles[] batch path drops it (explicit
       * destructure), same as `note`.
       */
      /**
       * `concern_note` (additive, range branch only — Guard 2, 2026-07-12b
       * decoy-fix forensics): present when this PARTIAL slice's own window
       * has zero hits for the session's harvested concern-anchor tokens (see
       * util/session.ts concernTokens) but the UNSERVED remainder of the
       * file has at least one — i.e. the task's own query is plausibly about
       * a region this slice didn't cover. A distinct key from `note` rather
       * than an overload of it: `note` already carries an exclusive-choice
       * boundary-cut/doc-elision warning (at most one, via `let note` +
       * `else if`), and a decoy-fix hazard is an orthogonal concern that
       * should be able to co-occur with either. Fires at most once per
       * (session, path) — see hasConcernNoteFired/markConcernNoteFired.
       * Forwarded for free by server.ts's single-handle mode=slice path
       * (full `...sliceResult.data` spread); the handles[] batch path needs
       * the same one-line addition `note` already got there.
       */
      /**
       * `downgraded_from`/`remaining_ranges` (additive, symbol branch only —
       * DESIGN-v0.9 §4.2): present when a symbol-scoped slice exceeded
       * READ_SYMBOL_CAP_BYTES and was served as a TRIMMED HEAD instead of the
       * old bare cap-exceeded refusal (aligning this branch with the top-level
       * mode=symbol FIX-C downgrade). `truncated:true`, `downgraded_from:
       * "symbol"`, `remaining_ranges` names the WHOLE symbol file range (the
       * assembled `content` is not a clean file-line prefix, so the agent
       * re-slices the full range via the range branch), and `next` points at
       * that same-handle range slice. Forwarded verbatim by the single-handle
       * mode=slice path (full `...sliceResult.data` spread); the handles[]
       * batch path forwards them explicitly (same one-line additions `note`/
       * `next` already needed there).
       */
      data: ReadCodeSliceOutput & { note?: string; assembled?: true; next?: string; concern_note?: string; downgraded_from?: "symbol"; remaining_ranges?: string[]; total_lines?: number };
    }
  | {
      ok: false;
      error: string;
      capExceeded?: boolean;
      details?: Record<string, unknown>;
      /**
       * D1: propagated verbatim from getSymbolWithContext's not-found payload
       * when this miss came from the symbol path, so callers (server.ts
       * mode=slice, handles[] batch omitted entries) can surface recovery
       * data instead of a bare error string.
       */
      code?: "not-found" | "range-invalid";
      candidates?: string[];
      skeleton?: string;
      /**
       * Concrete recovery derived from what this function already knows (e.g.
       * a range-invalid refusal knows the file's real line count, so it can
       * name a range that WILL parse). Forwarded verbatim by server.ts's
       * mode=slice refusal branch, where it wins over the generic derivation.
       */
      next?: string;
      /** The file's true line count — the fact a bad range needed. */
      total_lines?: number;
    };

/**
 * Parse one bound of a "start-end" range string, tolerating an optional
 * leading "L"/"l" (the natural line-ref shorthand agents commonly type, e.g.
 * "L1-130", "L12-L34", "l5-l9") and surrounding whitespace on that bound.
 * Digit parsing is still delegated to parseInt, so a plain numeric bound
 * (no L, no whitespace) parses byte-for-byte the same as before. Garbage
 * left after stripping the optional prefix (e.g. "Lx") still yields NaN,
 * which the caller rejects as an invalid range.
 */
function parseRangeBound(raw: string): number {
  const trimmed = raw.trim();
  const unprefixed = /^[Ll]/.test(trimmed) ? trimmed.slice(1) : trimmed;
  return parseInt(unprefixed, 10);
}

// 2026-08-01 invalid-range remedy: a rejected range's bounds are usually a
// typo away from valid (a 0-based start, a reversed start/end) — re-parsing
// them here (the same dash/comma forms parseRangeBound already accepts) and
// clamping/swapping lets a refusal's `next` hand back something the caller
// can resubmit verbatim, instead of a blanket whole-file re-read. Returns
// undefined when no bound parses at all (e.g. "abc-def") — nothing to
// correct, only drop.
function remedyRangeString(raw: string): string | undefined {
  const trimmed = raw.trim();
  const commaMatch = /^\s*([Ll]?\d+)\s*,\s*([Ll]?\d+)\s*$/.exec(trimmed);
  let a: number;
  let b: number;
  if (commaMatch) {
    a = parseRangeBound(commaMatch[1]!);
    b = parseRangeBound(commaMatch[2]!);
  } else {
    const parts = trimmed.split("-");
    a = parseRangeBound(parts[0] ?? "");
    b = parseRangeBound(parts[1] ?? parts[0] ?? "");
  }
  if (isNaN(a) || isNaN(b)) return undefined;
  const lower = Math.max(1, Math.min(a, b));
  const upper = Math.max(a, b);
  return `${lower}-${upper}`;
}

// Builds an invalid-range refusal's `next`: every bound that can be corrected
// folds into the SAME call shape the caller used (`range=` for one request,
// `ranges=[...]` for several), so the suggestion is never wider than what was
// asked. Falls back to a small first window — never the whole file — when
// nothing was correctable.
function sliceInvalidRemedyNext(filePath: string, totalLines: number, requested: readonly string[]): string {
  const remedied: string[] = [];
  for (const raw of requested) {
    const fixed = remedyRangeString(raw);
    if (fixed !== undefined && !remedied.includes(fixed)) remedied.push(fixed);
  }
  if (remedied.length === 0) {
    return `read_file mode=slice path=${filePath} range=1-${Math.min(200, totalLines)}`;
  }
  // FX-1 (v0.13 wave-3 review fix): the multi-range branch uses canonical
  // `targets=[...]` prose — a raw-string `next` bypasses
  // `canonicalizeEmittedToolCalls`, which only rewrites OBJECT-shaped embedded
  // tool calls. The singular-range sibling below is unchanged (out of the
  // confirmed-9 fix scope; see the wave-3 report addendum).
  return requested.length > 1
    ? `read_file targets=${JSON.stringify([{ path: filePath, ranges: remedied }])}`
    : `read_file mode=slice path=${filePath} range=${remedied[0]}`;
}

// ---------------------------------------------------------------------------
// Guard 2 (2026-07-12b decoy-fix forensics): out-of-slice concern-hit note.
// A partial range serve can miss the exact region a task's own query is
// about (read-economy vs localization-depth tension) — these helpers scan
// the lines OUTSIDE a served range for the session's harvested concern
// tokens (see util/session.ts recordConcernTokens) so resolveSlice can warn
// instead of silently serving a decoy window. Bounded to a single pass over
// the already-in-memory `lines` array; no extra I/O.
// ---------------------------------------------------------------------------

const MAX_CONCERN_NOTE_CHARS = 180;

/**
 * Case-insensitive substring scan of lines[fromLine..toLine] (1-based,
 * inclusive; a fromLine > toLine window — e.g. "before start" when
 * startLine is 1 — yields no iterations) for any of `tokens`. Returns the
 * 1-based hit line numbers and which tokens matched at least one of them.
 */
function tokensHitInRange(
  lines: readonly string[],
  fromLine: number,
  toLine: number,
  tokens: readonly string[],
): { hitLines: number[]; hitTokens: string[] } {
  const hitLines: number[] = [];
  const hitTokensSet = new Set<string>();
  for (let ln = fromLine; ln <= toLine; ln++) {
    const text = (lines[ln - 1] ?? "").toLowerCase();
    let lineHit = false;
    for (const t of tokens) {
      if (text.includes(t)) {
        hitTokensSet.add(t);
        lineHit = true;
      }
    }
    if (lineHit) hitLines.push(ln);
  }
  return { hitLines, hitTokens: [...hitTokensSet] };
}

/**
 * Merges consecutive line numbers into "La-Lb" (or "La" for a singleton)
 * range strings, capped at `maxRanges`. `hitLines` must already be sorted
 * ascending (true for tokensHitInRange's output and for a before+after
 * concatenation, since "before" lines all precede "after" lines).
 */
function mergeLineRanges(hitLines: readonly number[], maxRanges: number): string[] {
  if (hitLines.length === 0) return [];
  const ranges: string[] = [];
  let start = hitLines[0]!;
  let prev = hitLines[0]!;
  for (let i = 1; i < hitLines.length; i++) {
    const ln = hitLines[i]!;
    if (ln === prev + 1) {
      prev = ln;
      continue;
    }
    ranges.push(start === prev ? `L${start}` : `L${start}-${prev}`);
    if (ranges.length >= maxRanges) return ranges;
    start = ln;
    prev = ln;
  }
  ranges.push(start === prev ? `L${start}` : `L${start}-${prev}`);
  return ranges.slice(0, maxRanges);
}

/**
 * Guard 2 entry point: when a PARTIAL range serve's own window has zero
 * concern-token hits but the UNSERVED remainder of the file has at least
 * one, returns a bounded note pointing at the missed region and marks the
 * (workspace, filePath) pair as fired. Returns undefined — and does NOT
 * mark anything fired — when the guard doesn't apply: a full-file range, no
 * session tokens, the served region already hits, the unserved region has
 * no hits, this (session, path) already fired once, or (2026-07-16a
 * re-read-loop forensics) the session's closure ledger is already certified
 * satisfied.
 */
function buildConcernNote(
  workspace: string,
  filePath: string,
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string | undefined {
  const isPartialRange = startLine > 1 || endLine < lines.length;
  if (!isPartialRange) return undefined;

  // 2026-07-16a re-read-loop forensics: once attachClosure/mode=closure has certified every
  // check satisfied, suppress this nudge — re-reading edited files after a
  // verified-complete closure adds no new evidence. concern_note kept
  // naming "unread" concerns even after mode=closure had already reported
  // complete:true, driving a 20+ turn re-read loop. See
  // util/session.ts's markClosureSatisfied.
  if (isClosureSatisfied(workspace)) return undefined;

  const concernTokens = getConcernTokens(workspace);
  if (concernTokens.length === 0) return undefined;
  if (hasConcernNoteFired(workspace, filePath)) return undefined;

  const served = tokensHitInRange(lines, startLine, endLine, concernTokens);
  if (served.hitLines.length > 0) return undefined;

  const before = tokensHitInRange(lines, 1, startLine - 1, concernTokens);
  const after = tokensHitInRange(lines, endLine + 1, lines.length, concernTokens);
  const unservedHitLines = [...before.hitLines, ...after.hitLines];
  if (unservedHitLines.length === 0) return undefined;

  const unservedTokens = [...new Set([...before.hitTokens, ...after.hitTokens])].slice(0, 3);
  const ranges = mergeLineRanges(unservedHitLines, 2);
  let note = `session-query tokens (${unservedTokens.join(", ")}) hit outside served range: ${ranges.join(", ")} — widen the slice or read mode=symbol`;
  if (note.length > MAX_CONCERN_NOTE_CHARS) note = note.slice(0, MAX_CONCERN_NOTE_CHARS - 1) + "…";

  markConcernNoteFired(workspace, filePath);
  return note;
}

/**
 * Feature 3 (2026-07-12b2 "outline missed the bug" forensics):
 * Guard 2 sibling for mode=small_file outline/defer serves. A small_file
 * outline/defer response shows either a derived symbol outline or nothing at
 * all (defer) — neither is a raw content slice, so buildConcernNote's
 * range-based served/unserved split does not apply. Scans the WHOLE file
 * (already in memory — no extra I/O) for the session's concern tokens; fires
 * when at least one token hits ANYWHERE in the file and NONE of the hitting
 * tokens are visible anywhere in the (possibly empty, for defer) outline text
 * shown to the caller. Shares the once-per-(session,file) dedupe with
 * buildConcernNote via hasConcernNoteFired/markConcernNoteFired — reused
 * as-is rather than duplicated — so a file already noted by one path never
 * fires the other (slice-then-outline or outline-then-slice, either order).
 */
export function buildSmallFileConcernNote(
  workspace: string,
  filePath: string,
  content: string,
  outlineText: string,
): string | undefined {
  // C4 post-closure quiescence (2026-07-24): mirror buildConcernNote's gate
  // (line ~754). Once attachClosure / mode=closure has certified every check
  // satisfied, re-reading a file after that verified-complete closure adds no
  // new evidence — so this small_file outline/defer sibling must NOT keep
  // naming "unread" concern tokens either. The 2026-07-16a re-read-loop fix
  // suppressed the slice-path concern_note but missed THIS sibling, leaving a
  // reachable path (a post-closure mode=small_file/auto read) that still
  // manufactured fresh discovery pressure. See util/session.ts markClosureSatisfied.
  if (isClosureSatisfied(workspace)) return undefined;
  const concernTokens = getConcernTokens(workspace);
  if (concernTokens.length === 0) return undefined;
  if (hasConcernNoteFired(workspace, filePath)) return undefined;

  const lines = content.split(/\r?\n/);
  const hits = tokensHitInRange(lines, 1, lines.length, concernTokens);
  if (hits.hitLines.length === 0) return undefined;

  const outlineLower = outlineText.toLowerCase();
  const servedInOutline = hits.hitTokens.some((t) => outlineLower.includes(t));
  if (servedInOutline) return undefined;

  const tokensPart = hits.hitTokens.slice(0, 3);
  const ranges = mergeLineRanges(hits.hitLines, 2);
  let note = `session-query tokens (${tokensPart.join(", ")}) hit lines not shown in this outline: ${ranges.join(", ")} — read mode=slice or mode=full to inspect`;
  if (note.length > MAX_CONCERN_NOTE_CHARS) note = note.slice(0, MAX_CONCERN_NOTE_CHARS - 1) + "…";

  markConcernNoteFired(workspace, filePath);
  return note;
}

export async function resolveSlice(
  workspace: string,
  filePath: string,
  content: string,
  symbolName?: string,
  rangeStr?: string,
): Promise<ResolveSliceResult> {
  // R1 doc-navigation (2026-07-25 live forensics): markdown has NO code
  // symbols. A symbol tag on a .md handle is either an anchor-focus regex
  // false positive over prose (live: symbol "TokenLighten" tagged on a
  // 1500-line CONTRACT.md) or a heading title, and getSymbolWithContext can
  // resolve neither — the symbol branch below refused the whole serve
  // ('Symbol "x" not found in CONTRACT.md'), including for handles[] batch
  // items whose handle ALSO carried a perfectly good range.
  //
  // Chosen fix: make the READ side total for docs instead of stopping the
  // mint. Symbol-tagging md surfaces is load-bearing elsewhere (the pack's
  // anchor-focus `why`/`symbol` evidence, corpus case af1), so removing the
  // tag would delete information from every pack to fix one refusal; this
  // yields the symbol ONLY at slice time, where a doc has better answers: an
  // explicit/handle range wins, else the tag is resolved as a HEADING and
  // served as that section's line span. A tag that is neither still falls
  // through to the ordinary not-found, which server.ts turns into a
  // heading-index recovery rather than a dead end.
  if (symbolName && isMarkdownPath(filePath)) {
    if (rangeStr === undefined) {
      const heading = selectMarkdownSections(parseMarkdownHeadings(content), [symbolName]).matches[0];
      if (heading) rangeStr = String(heading.line) + "-" + String(heading.endLine);
    }
    if (rangeStr !== undefined) symbolName = undefined;
  }

  // If symbol is given, use getSymbolWithContext.
  if (symbolName) {
    const symResult = await getSymbolWithContext(content, { path: filePath, symbol: symbolName });
    if (!symResult.ok) {
      // D1: propagate the not-found recovery payload (candidates/skeleton)
      // instead of dropping it to a bare error string.
      return {
        ok: false,
        error: symResult.error,
        code: symResult.code,
        ...(symResult.candidates ? { candidates: symResult.candidates } : {}),
        ...(symResult.skeleton ? { skeleton: symResult.skeleton } : {}),
      };
    }

    const sliceContent = symResult.data.code;
    const sliceBytes = Buffer.byteLength(sliceContent, "utf8");
    const symRangeStart = symResult.data.range.start;
    const symRangeEnd = symResult.data.range.end;
    const symRangeStr = String(symRangeStart) + "-" + String(symRangeEnd);

    if (sliceBytes > READ_SYMBOL_CAP_BYTES) {
      // DESIGN-v0.9 §4.2: serve a TRIMMED HEAD instead of the old bare
      // cap-exceeded refusal. This branch is reachable via `mode=slice symbol=`
      // (server.ts) and the `handles=[...]` batch (a symbol-kind handle) — the
      // v0.8 FIX-C wave fixed the top-level mode=symbol path but left this
      // sibling refusing, which re-introduced a pure-loss turn (and blocks the
      // §4.6b codeless-handles internal execution for symbol-kind surfaces).
      // getSymbolWithContext's `code` is an ASSEMBLED view (preamble + body),
      // so a trimmed head is NOT a clean file-line prefix: remaining_ranges +
      // next therefore name the WHOLE symbol file range (the agent re-slices it
      // as real file lines via the range branch, which truncates-and-continues,
      // never refuses) — exactly as buildSymbolDowngradePayload's `next` does.
      // Content is trimmed to the last whole line within cap; the handle still
      // spans the full symbol range. Only a symbol whose head cannot be trimmed
      // to fit could still refuse — structurally unreachable here (the head is
      // trimmed to <= cap bytes and a non-empty symbol always yields one line),
      // so this branch never refuses on cap.
      let head = Buffer.from(sliceContent, "utf8").slice(0, READ_SYMBOL_CAP_BYTES).toString("utf8");
      const lastNl = head.lastIndexOf("\n");
      if (lastNl > 0) head = head.slice(0, lastNl);
      const headSha = shaOfText(head);
      const dgHandle = handleTable.upsert({
        kind: "symbol",
        path: filePath,
        range: symRangeStr,
        symbol: symbolName,
        workspaceRoot: workspace,
        sha: headSha,
      });
      // The displayed content is assembled, but the continuation must enter
      // the ordinary range branch. A distinct range handle guarantees that
      // the next call cannot resolve back to this same symbol branch forever.
      const rawRange = content.split(/\r?\n/).slice(symRangeStart - 1, symRangeEnd).join("\n");
      const resumeHandle = handleTable.upsert({
        kind: "range",
        path: filePath,
        range: symRangeStr,
        workspaceRoot: workspace,
        sha: shaOfText(rawRange),
      });
      recordReadPath(workspace, filePath);
      return {
        ok: true,
        data: {
          mode: "slice",
          handle: dgHandle.id,
          path: filePath,
          range: symRangeStr,
          content: head,
          truncated: true,
          sha: headSha,
          // Same assembled-view exception as the untrimmed symbol serve below:
          // `content` line 1 is code-relative, not file line symRangeStart.
          assembled: true,
          downgraded_from: "symbol",
          remaining_ranges: [symRangeStr],
          next: `read_file mode=slice handle=${resumeHandle.id} range=${symRangeStr}`,
        },
      };
    }

    const rangeField = symRangeStr;
    const sha = shaOfText(sliceContent);
    const handleEntry = handleTable.upsert({
      kind: "symbol",
      path: filePath,
      range: rangeField,
      symbol: symbolName,
      workspaceRoot: workspace,
      sha,
    });

    // Feature 1 (2026-07-12b2): a successful symbol-scoped slice IS a
    // content-bearing read of this file — record it so the unread-sibling
    // note never flags a file the agent already inspected via mode=symbol.
    recordReadPath(workspace, filePath);

    return {
      ok: true,
      data: {
        mode: "slice",
        handle: handleEntry.id,
        path: filePath,
        range: rangeField,
        content: sliceContent,
        truncated: false,
        sha,
        // See ResolveSliceResult's doc comment: `content` here is the
        // ASSEMBLED view, not a raw file slice — `range` is body-only file
        // lines and does not describe content's own numbering.
        assembled: true,
      },
    };
  }

  // Range-based slice.
  if (rangeStr) {
    // W2 (2026-07-30 refusal-economy pass): total_lines is computed once up
    // front for every "Invalid range" refusal below, rather than re-derived
    // per site. 2026-08-01: the refusal `next` itself no longer points at the
    // whole file — see sliceInvalidRemedyNext above — but total_lines still
    // rides every refusal payload.
    const totalLines = countLines(content);

    // 2026-07-11c: agents repeatedly write comma-separated ranges
    // ("160,195") instead of the dash form; rewrite to "A-B" before the
    // dash-split/parseRangeBound pipeline below so L-prefix leniency and the
    // canonicalized re-emit (further down) apply unchanged. A comma that
    // isn't exactly two bounds (e.g. "1,2,3") is rejected explicitly here —
    // left alone, parseInt's comma-stop behavior would silently truncate it
    // to a 1-line range instead of erroring.
    if (rangeStr.includes(",")) {
      const commaMatch = /^\s*([Ll]?\d+)\s*,\s*([Ll]?\d+)\s*$/.exec(rangeStr);
      if (!commaMatch) {
        return {
          ok: false,
          error: `Invalid range: ${rangeStr} (accepted forms: "start-end", single line "N"; L-prefix tolerated, e.g. "L12-L34")`,
          code: "range-invalid",
          total_lines: totalLines,
          next: sliceInvalidRemedyNext(filePath, totalLines, [rangeStr]),
        };
      }
      rangeStr = `${commaMatch[1]}-${commaMatch[2]}`;
    }
    const parts = rangeStr.split("-");
    const startLine = parseRangeBound(parts[0] ?? "1");
    let endLine = parseRangeBound(parts[1] ?? parts[0] ?? "1");

    if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
      return {
        ok: false,
        error: "Invalid range: " + rangeStr,
        code: "range-invalid",
        total_lines: totalLines,
        next: sliceInvalidRemedyNext(filePath, totalLines, [rangeStr]),
      };
    }
    // Canonicalize the echoed form: an accepted "L12-L34" (or single-bound
    // "42") re-emits as "12-34"/"42-42", so every downstream consumer of this
    // string — the minted handle's range, the response `range`, server.ts's
    // rangeStartLine (elision-marker line numbering) — parses it without
    // re-implementing the L-prefix leniency.
    rangeStr = `${startLine}-${endLine}`;

    const lines = content.split(/\r?\n/);

    // 2026-07-16 slice-handle EOF papercut: the lines.slice() below silently
    // serves only the lines that exist, but the minted handle used to record
    // the REQUESTED end bound — a "1-320" slice of a 299-line file served
    // 1-299 while its handle said 1-320, so every later edit through that
    // handle was refused with "range 1-320 is out of bounds (file has 299
    // lines)" (applyEditsMulti/rangeEdit bounds checks — deliberate
    // stale-drift protection that must NOT loosen). Clamp the END bound to
    // the true line count at mint time instead, so handle/range/sha all
    // describe the slice actually served; countLines is the same counter the
    // edit-side checks use (util/countLines.ts: the mint and the check must
    // agree). A range that STARTS past EOF stays untouched — nothing is
    // served, so there is no effective range to record (that empty-serve
    // leniency is corpus-pinned, and an edit through such a handle keeps
    // refusing).
    let clampNote: string | undefined;
    if (startLine <= totalLines && endLine > totalLines) {
      clampNote = `requested range ${startLine}-${endLine} exceeds end of file; served ${startLine}-${totalLines} (file has ${totalLines} lines)`;
      endLine = totalLines;
      rangeStr = `${startLine}-${endLine}`;
    } else if (startLine > totalLines) {
      // L5 (2026-08-08): the range starts past EOF too — nothing in it
      // overlaps the file at all. Mirrors the partial-overshoot note above
      // verbatim in shape (same prefix; "served nothing" stands in for a
      // served span). The range itself stays UNTOUCHED here — the
      // 2026-07-16 corpus-pinned leniency (an edit through this handle must
      // keep refusing) is unchanged; only the disclosure below, plus the
      // response `sha`/`total_lines` further down, change.
      clampNote = `requested range ${startLine}-${endLine} exceeds end of file; served nothing (file has ${totalLines} lines)`;
    }

    // D2: boundary awareness (NOTE-ONLY). When the requested range cuts a
    // symbol's body mid-declaration at either edge, the requested
    // range/content/handle are returned exactly as asked (sole exception:
    // the EOF clamp above, which narrows the end bound and attaches a note)
    // — we never silently widen. A `mode=slice` range handle is an edit handle
    // (edit_code handle+content / target=all replaces the handle's exact
    // range), so reassigning it to the enclosing symbol would corrupt the
    // slice→edit contract (see editCodeHandle.spec.ts). Instead we attach a
    // `note` naming the cut symbol + its true range so the agent can re-slice
    // with symbol=<name> in ONE call rather than probing blindly (the live
    // "6 blind slices to read one method" case). The design offered snap OR
    // note; note-only is the safe branch.
    let note: string | undefined;
    const cutSymbol = await findBoundaryCutAsync(content, filePath, startLine, endLine);
    if (cutSymbol) {
      const cutRangeStr = String(cutSymbol.startLine) + "-" + String(cutSymbol.endLine);
      note = `boundary cuts symbol ${cutSymbol.name} (${cutRangeStr}); use symbol=${cutSymbol.name}`;
    }

    // T1b (v0.13, UTF-16 3-way read-parity wave): sliceLinesToText restores
    // the file's own trailing newline when this range reaches EOF (see its
    // doc comment, util/countLines.ts) -- a plain lines.slice(...).join("\n")
    // silently dropped it, so a "whole file" range (an explicit mode=slice
    // range=1-N, or the handles[] batch's own isSynthesizedFileRange "1-N"
    // synthesis in server.ts) came back one trailing newline short of the
    // SAME file read via mode=full path=/handle=.
    const sliceContent = sliceLinesToText(content, startLine, endLine);
    const sliceBytes = Buffer.byteLength(sliceContent, "utf8");

    let truncated = false;
    let truncatedAtLineBoundary = false;
    let finalContent = sliceContent;
    if (sliceBytes > READ_SYMBOL_CAP_BYTES) {
      // Truncate to cap.
      const encoder = Buffer.from(sliceContent, "utf8");
      finalContent = encoder.slice(0, READ_SYMBOL_CAP_BYTES).toString("utf8");
      // Trim to last complete line.
      const lastNl = finalContent.lastIndexOf("\n");
      if (lastNl > 0) {
        finalContent = finalContent.slice(0, lastNl);
        truncatedAtLineBoundary = true;
      }
      truncated = true;
    }

    // 2026-08-01 truncated-mint consistency (edit-dispatch incident follow-up,
    // measured live): a byte-cap-truncated serve used to mint range=<the FULL
    // requested span> with sha over only the served lines — an internally
    // inconsistent handle whose later anchor edit failed applyEditsMulti's CAS
    // with a spurious served-content-stale on an UNCHANGED file (the CAS
    // hashes the handle's RECORDED range from disk; the mint hashed the
    // truncated text). Mirror the EOF clamp above: narrow the recorded AND
    // echoed range to the lines actually served, so handle/range/sha — and the
    // served-range ledger, which already measures countLines(content) — all
    // describe the same bytes; the remainder keeps being named against the
    // ORIGINAL requested end (the continuation contract below is unchanged:
    // same target span, same-handle form). Pathological case — the first
    // line alone exceeds the cap, so no clean line boundary was served: the
    // mint then carries NO sha (HandleEntry.sha is optional and the anchor CAS
    // binds only when a sha exists), because no sha can be simultaneously true
    // of the recorded range and of a partial line.
    const requestedEndLine = endLine;
    let truncNote: string | undefined;
    let remainingRange: string | undefined;
    if (truncated) {
      const servedLines = finalContent === "" ? 0 : finalContent.split("\n").length;
      const servedEnd = Math.min(requestedEndLine, startLine + Math.max(servedLines, 1) - 1);
      if (servedEnd < requestedEndLine) {
        remainingRange = `${servedEnd + 1}-${requestedEndLine}`;
      }
      endLine = servedEnd;
      rangeStr = `${startLine}-${endLine}`;
      truncNote = `requested range ${startLine}-${requestedEndLine} exceeds the serve byte cap; served ${rangeStr}`;
    }

    const sha = shaOfText(finalContent);
    const handleEntry = handleTable.upsert({
      kind: "range",
      path: filePath,
      range: rangeStr,
      workspaceRoot: workspace,
      ...(!truncated || truncatedAtLineBoundary ? { sha } : {}),
    });

    // Continuation hint for a cap-clamped serve: suggest the WHOLE remaining
    // range in one call — each follow-up clamps to the byte cap again, so the
    // read converges in ceil(bytes/cap) calls. Without this, agents invent
    // fixed-window walks (2026-07-09c: 92 slice calls across 10 arm-A cells
    // were the dominant residual turn cost).
    let next: string | undefined;
    if (remainingRange !== undefined) {
      next = `read_file mode=slice handle=${handleEntry.id} range=${remainingRange}`;
    }
    // C2 (2026-07-24): the fully-doc-comment slice case (DEFECT B, bench
    // 2026-07-09e) no longer manufactures a comments=keep round-trip hint here.
    // server.ts's mode=slice / handles[] dispatch now serves that case through
    // elideDocCommentsForDisplay — the SAME empty-elision guard mode=full and
    // mode=small_file use — which falls back to RAW content + a note in ONE
    // turn instead of a marker-only serve plus a re-slice hint. Centralizing on
    // the shared display helper is why elideDocComments/ELISION_MARKER_RE are no
    // longer imported in this module.

    // Guard 2: independent of note/next above — a boundary-cut or
    // doc-elision note (or neither) can co-occur with a concern_note, since
    // it warns about a DIFFERENT dimension (content missing outside the
    // served window, not a structural cut of the served window itself).
    const concernNote = buildConcernNote(workspace, filePath, lines, startLine, endLine);

    // Feature 1 (2026-07-12b2): a successful range slice IS a content-bearing
    // read of this file — record it (even a partial/truncated range: the
    // agent saw SOME real content, which is what distinguishes it from a
    // never-opened sibling).
    recordReadPath(workspace, filePath);

    // The EOF-clamp / byte-cap notes compose with (never replace) a
    // boundary-cut or doc-elision note — they warn about different dimensions
    // of the serve.
    const servedNoteParts = [clampNote, truncNote, note].filter((part): part is string => part !== undefined);
    const servedNote = servedNoteParts.length > 0 ? servedNoteParts.join("; ") : undefined;

    return {
      ok: true,
      data: {
        mode: "slice",
        handle: handleEntry.id,
        path: filePath,
        range: rangeStr,
        content: finalContent,
        truncated,
        // L5 (2026-08-08): a range starting past EOF served nothing, but the
        // slice-consistent `sha` above is the well-known empty-string hash —
        // indistinguishable from "I asked about a genuinely empty file".
        // Report the FILE's real identity here instead (the handle minted
        // above keeps the slice-consistent sha; only this response value
        // changes, so CAS/staleness checks through the handle are untouched).
        sha: startLine > totalLines ? shaOfText(content) : sha,
        // L5: the singular range path now reports total_lines unconditionally,
        // the same as the plural ranges[] path (resolveSliceRanges) already does.
        total_lines: totalLines,
        ...(servedNote ? { note: servedNote } : {}),
        ...(next ? { next } : {}),
        ...(remainingRange !== undefined ? { remaining_ranges: [remainingRange] } : {}),
        ...(concernNote ? { concern_note: concernNote } : {}),
      },
    };
  }

  return { ok: false, error: "symbol or range is required for mode=slice" };
}

// ---------------------------------------------------------------------------
// A2 — ranges[] batching: several windows of ONE file in ONE call.
//
// Live defect (2026-07-30 T14 forensics): reading one spec file (CONTRACT.md)
// cost FOUR separate slice round trips because read_file could address only a
// single `range` per call. Every one of those calls re-read the same file off
// disk, re-paid a turn, and re-paid the caller's whole resident context. The
// windows were known up front — they were listed in the file's own heading
// index — so nothing about the work required serialization.
//
// This is deliberately a THIN composition over resolveSlice rather than a
// second slice implementation: each requested range goes through the SAME
// clamp / EOF-note / byte-cap / boundary-cut / concern-note / recordReadPath
// path a single-range call takes, so a segment can never diverge from what
// `range=<one>` would have served. Only three things are new here: the
// response-level segment list, the overall byte budget (with honest
// remaining_ranges), and ONE file-spanning handle so an anchor edit
// (`{handle, range, content}`) works against any served segment.
// ---------------------------------------------------------------------------

/** One served window of a ranges[] batch. */
export interface SliceRangeSegment {
  /** Canonical "N-M" FILE lines actually served (EOF-clamped, L-prefix normalized). */
  range: string;
  /** Slice text for `range`. Same bytes `range=<this>` alone would have served. */
  code: string;
  /** Content sha over `code` — the same pin a single-range slice returns. */
  sha: string;
  /** True when this segment's own body hit READ_SYMBOL_CAP_BYTES. */
  truncated?: true;
  /** This segment's own EOF-clamp / boundary-cut disclosure, verbatim from resolveSlice. */
  note?: string;
}

export type ResolveSliceRangesResult =
  | {
      ok: true;
      data: {
        mode: "slice";
        /**
         * ONE handle covering the WHOLE file (kind:"file"), not per segment.
         * Its sha is over the raw file text, which is exactly what the anchor-edit
         * CAS compares for a range-less handle (applyEditsMulti's
         * servedScopeTextEntry / EditEntry.anchorShaRange) — so
         * `edit_file edits=[{handle, range:<a served segment>, content}]` is valid
         * against every segment in this response without a re-read.
         */
        handle: string;
        path: string;
        total_lines: number;
        segments: SliceRangeSegment[];
        /** Requested ranges NOT served because the overall cap filled. Same-handle follow-up. */
        remaining_ranges?: string[];
        /** Requested ranges that could not be served at all, with the reason each. */
        invalid_ranges?: Array<{ range: string; error: string }>;
        /** True when any segment was body-capped or any requested range was dropped. */
        truncated?: true;
        note?: string;
        next?: string;
        concern_note?: string;
      };
    }
  | {
      ok: false;
      error: string;
      code?: "not-found" | "range-invalid";
      total_lines?: number;
      next?: string;
    };

/**
 * Serve every requested range of ONE file in a single response.
 *
 * Per-segment semantics are resolveSlice's, unchanged. Response-level rules:
 *  - duplicates are collapsed, caller order is preserved, at most MAX_SLICE_RANGES;
 *  - a range that refuses (unparseable, or starting past EOF) does NOT sink the
 *    call — it lands in `invalid_ranges` and the rest still serve. Only when
 *    EVERY range refused is the whole call a refusal, and then the FIRST
 *    refusal is returned verbatim so its recovery payload survives;
 *  - segments are added while the running total fits SLICE_RANGES_TOTAL_CAP_BYTES.
 *    The FIRST segment always rides (a cap may bound a batch, never zero it);
 *    later ones that do not fit are dropped WHOLE into `remaining_ranges` with a
 *    `next` that re-requests exactly those in one call.
 */
export async function resolveSliceRanges(
  workspace: string,
  filePath: string,
  content: string,
  requested: readonly string[],
): Promise<ResolveSliceRangesResult> {
  const totalLines = countLines(content);
  const wholeFileRangeHint = `read_file mode=slice path=${filePath} range=1-${totalLines}`;

  const seen = new Set<string>();
  const wanted: string[] = [];
  const overflowRequests: string[] = [];
  for (const raw of requested) {
    const trimmed = String(raw).trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    if (wanted.length >= MAX_SLICE_RANGES) {
      overflowRequests.push(trimmed);
      continue;
    }
    wanted.push(trimmed);
  }
  if (wanted.length === 0) {
    return {
      ok: false,
      error: `ranges[] carried no usable entry (expected forms: "start-end", single line "N")`,
      code: "range-invalid",
      total_lines: totalLines,
      next: wholeFileRangeHint,
    };
  }

  const segments: SliceRangeSegment[] = [];
  const invalidRanges: Array<{ range: string; error: string }> = [];
  const remaining: string[] = [...overflowRequests];
  let concernNote: string | undefined;
  let usedBytes = 0;
  let capFilled = false;

  for (const range of wanted) {
    if (capFilled) {
      remaining.push(range);
      continue;
    }
    const one = await resolveSlice(workspace, filePath, content, undefined, range);
    if (!one.ok) {
      invalidRanges.push({ range, error: one.error });
      continue;
    }
    const segment: SliceRangeSegment = {
      range: String(one.data.range),
      code: one.data.content,
      sha: one.data.sha,
      ...(one.data.truncated === true ? { truncated: true as const } : {}),
      ...(one.data.note !== undefined ? { note: one.data.note } : {}),
    };
    const segmentBytes = Buffer.byteLength(JSON.stringify(segment), "utf8");
    if (segments.length > 0 && usedBytes + segmentBytes > SLICE_RANGES_TOTAL_CAP_BYTES) {
      capFilled = true;
      remaining.push(range);
      continue;
    }
    usedBytes += segmentBytes;
    segments.push(segment);
    if (concernNote === undefined && one.data.concern_note !== undefined) {
      concernNote = one.data.concern_note;
    }
  }

  if (segments.length === 0) {
    // 2026-08-01: every invalidRanges entry rides the refusal (not just the
    // first — see readCodeModes.spec.ts's ranges=["0-10","50-10"] case), and
    // next proposes a correction instead of the whole file.
    if (invalidRanges.length > 0) {
      return {
        ok: false,
        error: invalidRanges.map((entry) => entry.error).join("; "),
        code: "range-invalid",
        total_lines: totalLines,
        next: sliceInvalidRemedyNext(filePath, totalLines, invalidRanges.map((entry) => entry.range)),
      };
    }
    return {
      ok: false,
      error: `no requested range of ${filePath} could be served (file has ${totalLines} lines)`,
      code: "range-invalid",
      total_lines: totalLines,
      next: wholeFileRangeHint,
    };
  }

  // ONE file-spanning handle: kind:"file" + whole-file sha is the shape the
  // anchor-edit CAS treats as a whole-file pin (no anchorShaRange), so any
  // served segment's `range` is a valid edit anchor through it.
  const handle = handleTable.upsert({
    kind: "file",
    path: filePath,
    workspaceRoot: workspace,
    sha: shaOfText(content),
  });

  const notes: string[] = [];
  if (remaining.length > 0) {
    notes.push(
      `served ${segments.length} of ${segments.length + remaining.length} requested ranges`
      + ` (response cap ${SLICE_RANGES_TOTAL_CAP_BYTES}B`
      + (overflowRequests.length > 0 ? `, max ${MAX_SLICE_RANGES} ranges/call` : "")
      + `); remaining_ranges names the rest`,
    );
  }
  if (invalidRanges.length > 0) {
    notes.push(`${invalidRanges.length} requested range(s) could not be served — see invalid_ranges`);
  }
  const truncated = remaining.length > 0 || segments.some((segment) => segment.truncated === true);

  return {
    ok: true,
    data: {
      mode: "slice",
      handle: handle.id,
      path: filePath,
      total_lines: totalLines,
      segments,
      ...(remaining.length > 0 ? { remaining_ranges: remaining } : {}),
      ...(invalidRanges.length > 0 ? { invalid_ranges: invalidRanges } : {}),
      ...(truncated ? { truncated: true as const } : {}),
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      // FX-1: canonical `targets=[...]` prose, not the legacy `mode=slice` dialect.
      ...(remaining.length > 0
        ? { next: `read_file targets=${JSON.stringify([{ handle: handle.id, ranges: remaining }])}` }
        : {}),
      ...(concernNote !== undefined ? { concern_note: concernNote } : {}),
    },
  };
}
