// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * Import graph extraction for CI skeleton.
 *
 * Walks the repository, extracts symbols from source files using a regex-based
 * fallback (tree-sitter WASM is declared as an optional peer — if available,
 * callers can pre-extract symbols and pass them in; this module handles the
 * file enumeration and regex extraction layer).
 *
 * Ported from proto/src/core/codeGraph.ts + proto/src/mcp/pagerank.ts.
 * VSCode coupling removed.
 */

import { promises as fs } from "node:fs";
import { join, relative, extname } from "node:path";
import type { FileInput } from "./pagerank.js";
import type { IgnoreMatcher } from "./ignore.js";
import { readRegularFileUtf8 } from "./readGuard.js";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".php": "php",
  ".rb": "ruby",
  ".html": "html",
  ".htm": "html",
  ".jsp": "jsp",
  ".vue": "vue",
};

export function languageForPath(filePath: string): string | undefined {
  return EXT_TO_LANG[extname(filePath).toLowerCase()];
}

// ---------------------------------------------------------------------------
// .h content sniff (index-side)
// ---------------------------------------------------------------------------
//
// Mirrors packages/mcp-server/src/util/languages.ts's CPP_SNIFF_RE /
// SNIFF_WINDOW_CHARS / languageForPathWithContent EXACTLY (same regex, same
// 8192-char window) — see that file's ".h content sniff" doc comment for
// the full rationale: the MCP contract (packages/types/src/mcp.ts
// MCP_LANG_EXTS) dual-lists `.h` under both `c` and `cpp`, and the static
// EXT_TO_LANG table above has to pick one ("c"). A C++ header
// (class/template/namespace/scope-resolution syntax) run through the "c"
// entry of LANG_PATTERNS below mis-parses or silently drops those
// constructs (no class/struct/namespace patterns in LANG_PATTERNS.c) —
// exactly the failure mode this sniff exists to avoid.
//
// mcp-server's copy sniffs per-request, for callers that already hold the
// file's text (read_file, findText, locateTaskContext). This copy sniffs
// once at INDEX-BUILD time — buildFileInputs below, and indexStore.ts's
// loadOrBuildSourceIndex slow path, both already read the file's content
// off disk, so the sniff is free there. Skipping it here would let the
// PERSISTED symbol index that search_files action=symbols reads from lock
// in the extension-only "c" answer (and LANG_PATTERNS.c's function-only
// patterns) for every genuinely-C++ `.h` file in the repo, until that
// file's content next changes.
//
// skeleton-engine must not import mcp-server (see AGENTS.md's package
// table), so this is a hand-mirrored copy, not a shared import — keep the
// regex/window in sync by hand. mcp-server's
// src/__tests__/languageExtensionContract.spec.ts cross-checks both
// packages' helpers agree on the same fixtures so drift fails loudly.
const CPP_SNIFF_RE = /\bclass\s|\btemplate\s*<|\bnamespace\s|::/;

/** Sniff window — cheap regex scan over the first N chars only, not the whole file. */
const SNIFF_WINDOW_CHARS = 8192;

/**
 * Like languageForPath, but for callers that already have the file's text in
 * hand: a `.h` file that resolves to "c" by extension alone gets a cheap
 * content sniff for C++ signals (class/template/namespace/::) and resolves
 * to "cpp" if any are found in the first SNIFF_WINDOW_CHARS chars. Every
 * other extension returns the same answer as languageForPath.
 */
export function languageForPathWithContent(filePath: string, text: string): string | undefined {
  const ext = extname(filePath).toLowerCase();
  const lang = EXT_TO_LANG[ext];
  if (lang !== "c" || ext !== ".h") return lang;
  const window = text.length > SNIFF_WINDOW_CHARS ? text.slice(0, SNIFF_WINDOW_CHARS) : text;
  return CPP_SNIFF_RE.test(window) ? "cpp" : "c";
}

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

export interface EnumeratedFile {
  path: string;       // workspace-relative POSIX path
  absPath: string;
  language: string | undefined;
  sizeBytes: number;
  mtimeMs: number;
  /**
   * True for text-bearing, non-source extensions (.md/.txt/.rst/.json/.yaml/
   * .yml/.toml — see TEXT_EXTS). These enumerate so makeTextChunks
   * (chunker.ts) has content to chunk, but MUST NOT participate in symbol
   * extraction, PageRank seeding/denominators, or searchSymbols
   * eligibility — every consumer of enumerateFiles' output either skips
   * textOnly entries outright (buildFileInputs below;
   * application/buildSkeleton.ts's buildSkeleton filters them before
   * ranking) or gives them empty
   * symbols/outgoingSymbolRefs (indexStore.ts), which the ranking/search
   * math is neutral to by construction. Absent (undefined) for ordinary
   * source files.
   */
  textOnly?: boolean;
}

const MAX_FILE_SIZE_BYTES = 1_000_000; // 1 MB — skip truly huge files

// Text-bearing extensions that carry no language/symbols but are worth
// chunking (makeTextChunks in chunker.ts) for future chunk-based retrieval.
// Deliberately NOT added to EXT_TO_LANG above — that map means "has a
// language/grammar", which these do not. See EnumeratedFile.textOnly.
const TEXT_EXTS = new Set([".md", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml"]);

/**
 * Walk root recursively, collect source files not excluded by the matcher.
 * Returns POSIX-normalized workspace-relative paths.
 */
export async function enumerateFiles(
  root: string,
  matcher: IgnoreMatcher,
): Promise<EnumeratedFile[]> {
  const results: EnumeratedFile[] = [];
  await walk(root, root, matcher, results);
  return results;
}

async function walk(
  root: string,
  dir: string,
  matcher: IgnoreMatcher,
  out: EnumeratedFile[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as import("node:fs").Dirent[];
  } catch {
    return;
  }

  // Sort by raw byte order (Buffer.compare) — locale-insensitive, deterministic across platforms.
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name as string), Buffer.from(b.name as string)));

  for (const entry of entries) {
    const absPath = join(dir, entry.name as string);
    const relPath = relative(root, absPath).replace(/\\/g, "/");

    if (matcher.ignores(relPath)) continue;

    if (entry.isDirectory()) {
      await walk(root, absPath, matcher, out);
    } else if (entry.isFile()) {
      const lang = languageForPath(entry.name as string);
      const textOnly = !lang && TEXT_EXTS.has(extname(entry.name as string).toLowerCase());
      if (!lang && !textOnly) continue; // skip non-source, non-text-bearing files

      let stat: { size: number; mtimeMs: number };
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;

      const enumerated: EnumeratedFile = {
        path: relPath,
        absPath,
        language: lang,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      if (textOnly) enumerated.textOnly = true;
      out.push(enumerated);
    }
  }
}

// ---------------------------------------------------------------------------
// Regex-based symbol extraction (fallback — no tree-sitter required)
// ---------------------------------------------------------------------------

export interface ExtractedSymbol {
  name: string;
  line: number;
  endLine: number;
  signature: string;
}

/**
 * Extract top-level symbols from source text using regex patterns.
 * This is the fallback path per spec §3.4 — fast, language-agnostic approximation.
 * tree-sitter-based extraction can be layered on top by callers.
 */
export function extractSymbolsRegex(text: string, language: string): ExtractedSymbol[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: ExtractedSymbol[] = [];

  const patterns = LANG_PATTERNS[language] ?? LANG_PATTERNS.default;

  for (const pattern of patterns) {
    for (const m of text.matchAll(pattern)) {
      const name = m[1];
      if (!name) continue;
      const line = lineOf(text, m.index ?? 0);
      const sigLine = lines[line - 1]?.trimEnd() ?? "";
      out.push({
        name,
        line,
        endLine: estimateEndLine(lines, line - 1),
        signature: sigLine,
      });
    }
  }

  // Deduplicate by name+line, sort by line.
  const seen = new Set<string>();
  return out
    .filter((s) => {
      const key = `${s.name}:${s.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
}

const LANG_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm,
    /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gm,
    /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gm,
  ],
  typescriptreact: [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
  ],
  javascript: [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm,
    /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
  ],
  javascriptreact: [
    /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/gm,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
  ],
  python: [
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
    /^\s*class\s+([A-Za-z_]\w*)/gm,
  ],
  go: [
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm,
    /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm,
  ],
  rust: [
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[(<]/gm,
    /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm,
  ],
  java: [
    /^\s*(?:public|protected|private|abstract|final|static|\s)*\b(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:[\w$<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\(/gm,
    // static final UPPER_SNAKE constants — visibility + static + final + type + NAME + '='
    /^\s*(?:public|protected|private)?\s*static\s+final\s+(?:[\w$<>\[\],.?]+\s+)([A-Z][A-Z0-9_]*)\s*=/gm,
  ],
  kotlin: [
    /^\s*(?:fun)\s+([A-Za-z_]\w*)\s*\(/gm,
    /^\s*(?:class|interface|object)\s+([A-Za-z_]\w*)/gm,
  ],
  csharp: [
    /^\s*(?:public|private|protected|internal|static|abstract|sealed|partial|\s)*\b(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/gm,
    /^\s*(?:public|private|protected|internal)?\s+(?:static\s+)?(?:async\s+)?(?:[\w<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\(/gm,
  ],
  php: [
    /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm,
    /^\s*function\s+([A-Za-z_]\w*)\s*\(/gm,
  ],
  ruby: [
    /^\s*class\s+([A-Z]\w*)/gm,
    /^\s*module\s+([A-Z]\w*)/gm,
    /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\s*/gm,
  ],
  c: [
    // Function definitions with body (brace-terminated)
    /^\s*(?!#)(?:extern\s+|static\s+|inline\s+)*(?:[A-Za-z_*][\w*\s]*\s)([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/gm,
    // Function declarations in headers (semicolon-terminated, no body)
    /^\s*(?!#)(?:extern\s+|static\s+|inline\s+)*(?:[A-Za-z_*][\w*\s]*\s)([A-Za-z_]\w*)\s*\([^;{]*\)\s*;/gm,
  ],
  cpp: [
    // Class/struct/union/enum declarations
    /^\s*(?!#)(?:typedef\s+)?(?:class|struct|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/gm,
    // Function/method definitions with body — single-line params
    /^\s*(?!#)(?:[A-Za-z_*][\w*\s]*\s)([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?\{/gm,
    // Method definitions with multi-line parameter lists (up to ~5 lines)
    /^\s*(?!#)(?:[A-Za-z_*][\w*\s]*\s)([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*\([\s\S]{0,300}\)\s*(?:const\s*)?(?:noexcept\s*)?\{/gm,
    // Function/method declarations in headers (semicolon-terminated)
    /^\s*(?!#)(?:virtual\s+|constexpr\s+|explicit\s+|static\s+|inline\s+|override\s+)*(?:[A-Za-z_*][\w*\s]*\s)([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*\([^;{]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:= 0\s*)?;/gm,
  ],
  default: [
    /^\s*(?:function|def|fn|func)\s+([A-Za-z_]\w*)\s*\(/gm,
  ],
};

// Callers invoke this once per matchAll hit with the SAME text string, so a
// fresh scan from index 0 per call made extraction O(matches × bytes) on
// symbol-dense files. Memoize the newline positions of the last-seen text
// (reference hit inside a per-file match loop) and binary-search per call.
let lineOfMemoText: string | undefined;
let lineOfMemoNewlines: number[] = [];

function lineOf(text: string, index: number): number {
  if (text !== lineOfMemoText) {
    const positions: number[] = [];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) positions.push(i);
    lineOfMemoText = text;
    lineOfMemoNewlines = positions;
  }
  const nl = lineOfMemoNewlines;
  let lo = 0;
  let hi = nl.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nl[mid]! < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * Rough heuristic: scan forward from the symbol's start line looking for the
 * matching close-brace at depth 0, capping at 200 lines to bound cost.
 */
function estimateEndLine(lines: string[], startIdx: number): number {
  let depth = 0;
  let sawBrace = false;
  const limit = Math.min(startIdx + 200, lines.length);
  for (let i = startIdx; i < limit; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{") { depth++; sawBrace = true; }
      else if (ch === "}") { depth--; }
    }
    if (sawBrace && depth <= 0) return i + 1;
  }
  return Math.min(startIdx + 20, lines.length);
}

// ---------------------------------------------------------------------------
// Build FileInput[] for PageRank
// ---------------------------------------------------------------------------

/**
 * Read files and extract symbols, producing FileInput[] for buildSymbolGraph.
 * Falls back to regex extraction if tree-sitter is unavailable.
 */
export async function buildFileInputs(
  files: EnumeratedFile[],
): Promise<{ inputs: FileInput[]; parseFailures: Map<string, number> }> {
  const inputs: FileInput[] = [];
  const parseFailures = new Map<string, number>();

  for (const f of files) {
    // Text-bearing files (.md/.txt/... — EnumeratedFile.textOnly) carry no
    // symbols and must not seed PageRank. application/buildSkeleton.ts's
    // buildSkeleton also filters these out before calling here, but this
    // skip keeps buildFileInputs safe for any caller regardless of
    // pre-filtering.
    if (f.textOnly) continue;

    let raw: string;
    try {
      raw = await readRegularFileUtf8(f.absPath, MAX_FILE_SIZE_BYTES);
    } catch {
      continue;
    }

    // Index-build time has content in hand — sniff .h files for C++
    // signals instead of trusting walk()'s static extension-only "c"
    // answer. See languageForPathWithContent's doc comment above.
    const effectiveLanguage = languageForPathWithContent(f.path, raw) ?? f.language ?? "default";

    let symbols: ExtractedSymbol[];
    try {
      symbols = extractSymbolsRegex(raw, effectiveLanguage);
    } catch {
      // Regex extraction failed — treat as empty symbol set.
      const failures = parseFailures.get(f.language ?? "unknown") ?? 0;
      parseFailures.set(f.language ?? "unknown", failures + 1);
      symbols = [];
    }

    inputs.push({
      path: f.path,
      raw,
      mtimeMs: f.mtimeMs,
      symbols,
    });
  }

  return { inputs, parseFailures };
}
