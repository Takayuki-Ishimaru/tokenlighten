// get_file_skeleton tool implementation for @tokenlighten/mcp-server.
//
// Returns signatures-only view via tree-sitter WASM (12 languages + HTML).
// Regex fallback if tree-sitter WASM fails to load.
// Output is PLAIN text: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Full spec: docs/components/02-mcp-server.md §2.4, §5.
// P1.2: skeleton profiles (class-map default) + 8 KB response cap.

import type { McpToolResult } from "@tokenlighten/types";
import { treeSitterSkeleton, treeSitterSupports } from "../skeleton/treeSitter.js";
import { regexFallbackSkeleton } from "../skeleton/regexFallback.js";
import type { TreeSitterPaths } from "../skeleton/types.js";
import { languageForPathWithContent } from "../util/languages.js";
import { compressFormat } from "../util/formatCompress.js";
import { collectSymbols, type CollectedSymbol } from "../symbols/collectSymbols.js";
import { renderSymbolDocMap, renderSymbolSkeleton } from "../symbols/renderSymbolSkeleton.js";
import { commentNote, isTokenlightenSentinelLine } from "../util/sentinelComment.js";
import { parseMarkdownHeadings, buildMarkdownHeadingIndex } from "../util/markdownSections.js";

// ---------------------------------------------------------------------------
// D8: `GetFileSkeletonInput` / `GetFileSkeletonOutput` used to live in
// `@tokenlighten/types`' `mcp/legacy-read.ts`, which is DELETED. They were
// never legacy in substance — this module serves the ADVERTISED `read_file
// mode=skeleton` path — so the two shapes move here, next to their one
// emitter, instead of being retired. `FileSkeletonPayload` replaces the old
// `GetFileSkeletonOutput & { ... }` intersection that three sites repeated.
// ---------------------------------------------------------------------------

/** Request shape of the `read_file mode=skeleton` path. */
export interface GetFileSkeletonInput {
  /** Workspace-relative file path. */
  path: string;
  /**
   * Optional line range [startLine, endLine] (1-based, inclusive).
   * When provided, skeleton is scoped to this range of the file.
   */
  lines?: [number, number];
}

/**
 * The `mode=skeleton` payload.
 *
 * A.5.3: this is the PROJECTION SOURCE for `StructuralOutline`'s `signatures`
 * form (types `mcp/read-result.ts`) — `signatures` and `language` land there
 * verbatim, `handle` and `path` are added by the server (it owns the handle
 * table), and `truncated`/`byte_budget` are the pre-v1 fields the v1 form does
 * not carry. Nothing on the wire is shaped from this type directly; the
 * envelope funnel projects it.
 */
export interface FileSkeletonPayload {
  /**
   * Rendered skeleton text: function/class signatures with bodies elided to
   * `{ /* <elided n=K> * / }` placeholders. Imports kept verbatim.
   */
  signatures: string;
  /** Language detected for this file (e.g. "typescript", "python"). */
  language: string;
  /** True when the output was truncated due to size or line-range caps. */
  truncated: boolean;
  /** Emitted iff `truncated` — the profile the renderer actually fell back to. */
  profile_used?: SkeletonProfile;
  /** Emitted iff `truncated` — the byte cap that forced the fallback. */
  byte_budget?: number;
  /** Emitted iff `truncated` — the narrower call that recovers the detail. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Constants — exported so budget tests (P3.3) can import them.
// ---------------------------------------------------------------------------

/** Hard byte cap for the rendered skeleton field. */
export const MAX_RESPONSE_BYTES = 8192;

// ---------------------------------------------------------------------------
// Skeleton profiles
// ---------------------------------------------------------------------------

/** All valid skeleton profile names. */
export type SkeletonProfile = "class-map" | "symbol-map" | "doc-map" | "full-skeleton";

/** Languages that get profile filtering (non-config, non-doc languages). */
export const CODE_LANGUAGES = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "ruby",
  "csharp",
  "php",
  "kotlin",
]);

/**
 * True when `lang` is a code language that getFileSkeleton can produce a
 * real signature skeleton for (vs. a doc/config language, or undefined for
 * an unrecognized extension). Callers outside this module (server.ts's
 * mode=auto large-non-code-file content path) should use this instead of
 * duplicating the CODE_LANGUAGES set.
 */
export function isSkeletonizableLanguage(lang: string | undefined): boolean {
  return lang !== undefined && CODE_LANGUAGES.has(lang);
}

/** Default profile for code files (non-doc, non-config). */
export const DEFAULT_PROFILE: SkeletonProfile = "class-map";

// ---------------------------------------------------------------------------
// Profile post-processor
// ---------------------------------------------------------------------------

/**
 * Import/require/use line patterns to strip for non-full profiles.
 * Matches lines that are purely imports at the top of the file.
 */
const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+/,                    // JS/TS/Java/Rust/Kotlin
  /^\s*from\s+['"][^'"]+['"]\s*import/, // Python "from x import"
  /^\s*require\s*\(/,                  // CommonJS
  /^\s*use\s+[a-zA-Z_:]+\s*;/,        // Rust "use ..."
  /^\s*#include\s*[<"]/,              // C/C++
];

/**
 * Strip import/require lines from skeleton text.
 */
function stripImports(text: string): string {
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    return !IMPORT_PATTERNS.some((pat) => pat.test(line));
  });
  return filtered.join("\n");
}

/**
 * Strip Javadoc /** ... *\/ blocks, triple-slash /// comments,
 * and leading # doc lines (Python docstring-style leading comments).
 */
function stripDocComments(text: string): string {
  const lines = text.split("\n");
  let inDoc = false;
  return lines.map((line) => {
    let out = line;
    if (inDoc) {
      const close = out.indexOf("*/");
      if (close < 0) return "";
      out = out.slice(close + 2); inDoc = false;
    }
    let open = out.indexOf("/**");
    while (open >= 0) {
      const close = out.indexOf("*/", open + 3);
      if (close >= 0) out = out.slice(0, open) + out.slice(close + 2);
      else { out = out.slice(0, open); inDoc = true; }
      if (inDoc) break;
      open = out.indexOf("/**");
    }
    const trimmed = out.trim();
    if (trimmed.startsWith("///")) return "";
    if (trimmed.startsWith("#") && !trimmed.startsWith("#!")) return "";
    return out;
  }).join("\n");
}

/**
 * Collapse multiple consecutive blank lines into a single blank line.
 */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Apply a skeleton profile to already-rendered skeleton text.
 *
 * For code files:
 * - class-map: keep class headers + public method signatures; strip imports,
 *   Javadocs, private markers. Bodies are already elided by tree-sitter.
 * - symbol-map: keep only top-level one-line symbol names. Collapse everything
 *   to the first line of each class/function block.
 * - doc-map: return only comment blocks attached to symbols. Non-commented
 *   symbols are omitted.
 * - full-skeleton: pass-through (no post-processing).
 *
 * For non-code files: always pass-through.
 */
export function applyProfile(
  skeletonText: string,
  profile: SkeletonProfile,
  language: string,
): string {
  const isCode = CODE_LANGUAGES.has(language);

  if (!isCode || profile === "full-skeleton") {
    return skeletonText;
  }

  if (profile === "class-map") {
    // Strip imports and Javadoc/doc-comment blocks.
    let out = stripImports(skeletonText);
    out = stripDocComments(out);
    out = collapseBlankLines(out);
    return out.trim();
  }

  if (profile === "symbol-map") {
    // Keep only the first line of each declaration block.
    // We split on double-newline (block separator from tree-sitter) and take
    // the first non-empty line of each block.
    let out = stripImports(skeletonText);
    out = stripDocComments(out);
    // Split on blank lines to get blocks, take first line of each block.
    const blocks = out.split(/\n{2,}/);
    const symbols: string[] = [];
    for (const block of blocks) {
      const firstLine = block
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("#") && !l.startsWith("/*"));
      if (firstLine) symbols.push(firstLine);
    }
    return symbols.join("\n");
  }

  if (profile === "doc-map") {
    // Extract comment blocks that precede declarations.
    // Match /** ... */ or // ... or # ... lines followed by a declaration line.
    const lines = skeletonText.split(/\r?\n/);
    const result: string[] = [];
    let commentBuffer: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      if (
        trimmed.startsWith("/**") ||
        trimmed.startsWith("///") ||
        trimmed.startsWith("* ") ||
        trimmed === "*" ||
        trimmed === "*/" ||
        ((trimmed.startsWith("//") || trimmed.startsWith("#")) && !isTokenlightenSentinelLine(trimmed))
      ) {
        commentBuffer.push(line);
      } else if (trimmed.length > 0) {
        // Non-comment, non-blank line — if we have a comment buffer, emit it.
        if (commentBuffer.length > 0) {
          result.push(...commentBuffer, line, "");
          commentBuffer = [];
        }
        // If no comments, skip this line (symbol with no docs).
      } else {
        // Blank line: reset comment buffer.
        commentBuffer = [];
      }
    }
    return result.join("\n").trim() || "(no documented symbols found)";
  }

  return skeletonText;
}

// ---------------------------------------------------------------------------
// Markdown skeleton — headings outline (D1, 2026-08-27 defect fix)
// ---------------------------------------------------------------------------

/**
 * Markdown has no functions/classes for tree-sitter or regexFallback.ts's
 * LANG_PATTERNS to find, so mode=skeleton on a markdown file used to render
 * regexFallbackSkeleton's "(no signatures detected)" placeholder plus an
 * AST-fallback notice — a dead end, even though mode=slice's own headings
 * index for the SAME file already carries a rich outline (parseMarkdownHeadings
 * / buildMarkdownHeadingIndex — see docSliver.ts's `headings`/`sections_hint`)
 * that the skeleton route simply never consulted. This reuses that exact
 * machinery to render the outline as the skeleton body instead.
 *
 * The index IS the entire skeleton body here (no sibling content sliver
 * sharing the budget, unlike docSliver.ts's tighter
 * DOC_SLIVER_HEADINGS_CAP_ENTRIES/_BYTES), so it gets a larger share of
 * MAX_RESPONSE_BYTES than that use — still comfortably under it, leaving
 * headroom for the header/notice lines and the generic byte-cap truncation
 * net (below) that still applies as a backstop.
 */
const MARKDOWN_SKELETON_HEADINGS_CAP_ENTRIES = 300;
const MARKDOWN_SKELETON_HEADINGS_CAP_BYTES = 6000;

function buildMarkdownSkeletonOutline(fileContent: string): string {
  const headings = parseMarkdownHeadings(fileContent);
  if (headings.length === 0) return "(no headings detected)";
  const index = buildMarkdownHeadingIndex(headings, {
    maxEntries: MARKDOWN_SKELETON_HEADINGS_CAP_ENTRIES,
    maxBytes: MARKDOWN_SKELETON_HEADINGS_CAP_BYTES,
  });
  const lines = index.headings.map((heading) => {
    const indent = "  ".repeat(Math.max(0, heading.level - 1));
    return `L${heading.range}: ${indent}${heading.text}`;
  });
  if (index.truncated && index.note) lines.push("", `// ${index.note}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface GetFileSkeletonOptions {
  /** Override tree-sitter WASM file paths (for testing). */
  treeSitterPaths?: TreeSitterPaths;
}

/**
 * Produce a skeleton of a source file: function/method signatures with bodies
 * replaced by `{ ... }` placeholders.
 *
 * Default profile for code files: "class-map" (imports stripped, Javadocs stripped).
 * Use profile="full-skeleton" for legacy behavior.
 *
 * Returns plain text: no envelope, no metadata wrappers.
 * Header line: `tokenlighten:skeleton path=... lang=... original_lines=... elided_lines=... profile=...`,
 * wrapped as a valid one-line comment for the target language via
 * commentNote() — `// ...` for most languages, `# ...` for python/ruby,
 * `/* ... *\/` for css (which has no line-comment syntax).
 *
 * Response is capped at MAX_RESPONSE_BYTES. If over cap, tries progressively
 * smaller profiles: full-skeleton → class-map → symbol-map → line-truncated.
 * On cap hit, data includes truncated:true and a hint.
 */
export async function getFileSkeleton(
  fileContent: string,
  input: GetFileSkeletonInput & { profile?: SkeletonProfile },
  opts: GetFileSkeletonOptions = {},
): Promise<McpToolResult<FileSkeletonPayload>> {
  const { path } = input;

  // .h is dual-listed c/cpp in the MCP contract — sniff fileContent (already
  // in hand here) so a C++-shaped header resolves to "cpp" instead of the
  // static "c" answer, picking the right tree-sitter grammar below.
  const language = languageForPathWithContent(path, fileContent);
  if (!language) {
    // Unknown language — serve the content verbatim (there is nothing to
    // skeletonize), but never uncapped: this branch used to return the WHOLE
    // file as `signatures`, bypassing MAX_RESPONSE_BYTES entirely (32KB .txt
    // -> 32KB response), reachable from mode=skeleton, the deprecated
    // get_file_skeleton alias, and buildFullDowngradePayload's embedded
    // skeleton. Over-cap content is byte-sliced to the same marker-reserving
    // budget the over-cap truncation below uses, then backed off to the last
    // whole line (a single-line file keeps the raw byte cut — the same rule
    // as server.ts's DOC_CONTENT_CAP_BYTES branch).
    const rawBytes = Buffer.byteLength(fileContent, "utf8");
    if (rawBytes <= MAX_RESPONSE_BYTES) {
      return {
        ok: true,
        data: {
          signatures: fileContent,
          language: "unknown",
          truncated: false,
        },
      };
    }
    const slice = Buffer.from(fileContent, "utf8")
      .subarray(0, MAX_RESPONSE_BYTES - 200) // reserve space for truncation marker
      .toString("utf8");
    const lastNewline = slice.lastIndexOf("\n");
    const kept = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
    // Marker only when the served prefix carries non-whitespace content: a
    // whitespace-only prefix must keep trimming to empty so
    // buildFullDowngradePayload's skeletonUsable check (signatures.trim())
    // still reads it as no-signal and falls back to its bounded `head`.
    const marker = kept.trim().length > 0
      ? "\n[truncated: unrecognized extension served verbatim up to the byte budget; use mode=slice (range) or search_files action=find for the rest]"
      : "";
    return {
      ok: true,
      data: {
        signatures: kept + marker,
        language: "unknown",
        truncated: true,
        byte_budget: MAX_RESPONSE_BYTES,
        hint: "unrecognized extension; use mode=slice with a range or search_files action=find for targeted reads",
      },
    };
  }

  const originalLines = fileContent.split(/\r?\n/).length;
  let skeletonText: string | undefined;
  let collectedSymbols: CollectedSymbol[] | undefined;
  let usedFallback = false;

  if (language === "markdown") {
    // Headings outline instead of the AST/regex-signature pipeline below —
    // see buildMarkdownSkeletonOutline's doc comment. Not a "fallback": no
    // degradedNotice, since this is the CORRECT rendering for markdown, not
    // a degraded one.
    skeletonText = buildMarkdownSkeletonOutline(fileContent);
  } else {
    // Try tree-sitter first.
    if (treeSitterSupports(language)) {
      try {
        if (language !== "html") {
          const symbols = await collectSymbols(fileContent, language, opts.treeSitterPaths ?? {});
          if (symbols.length > 0) {
            collectedSymbols = symbols;
            skeletonText = renderSymbolSkeleton(fileContent, symbols, language);
          }
        }
        if (!skeletonText) {
          skeletonText = await treeSitterSkeleton(fileContent, language, opts.treeSitterPaths ?? {});
        }
      } catch {
        // Fall through to regex fallback.
      }
    }

    // Fall back to regex if tree-sitter failed or produced nothing.
    if (!skeletonText || skeletonText.trim().length === 0) {
      skeletonText = regexFallbackSkeleton(fileContent, language);
      usedFallback = true;
    }
  }

  const isCode = CODE_LANGUAGES.has(language);

  // Determine effective profile.
  // Default: class-map for code files, full-skeleton for non-code.
  const requestedProfile: SkeletonProfile =
    input.profile ?? (isCode ? DEFAULT_PROFILE : "full-skeleton");

  // Degradation notice if we used regex fallback, wrapped as a valid one-line
  // comment for `language` via commentNote() (css has no line-comment syntax,
  // so it gets a `/* ... */` one-liner there instead of `// ...`).
  const degradedNotice = usedFallback
    ? `\n${commentNote(language, "note: AST unavailable; skeleton produced by regex fallback.")}`
    : "";

  /**
   * Build the full output string for a given profile.
   */
  function buildOutput(profile: SkeletonProfile): string {
    const processed = profile === "doc-map" && collectedSymbols
      ? renderSymbolDocMap(fileContent, collectedSymbols, language)
      : applyProfile(skeletonText!, profile, language!);
    const skeletonLines = processed.split(/\r?\n/).length;
    const elidedLines = Math.max(0, originalLines - skeletonLines);
    const header = commentNote(language!, `tokenlighten:skeleton path=${path} lang=${language} original_lines=${originalLines} elided_lines=${elidedLines} profile=${profile}`);
    return compressFormat([header, "", processed].join("\n") + degradedNotice);
  }

  // Profile fallback order for cap enforcement.
  const FALLBACK_ORDER: SkeletonProfile[] = ["full-skeleton", "class-map", "symbol-map"];

  let profileUsed = requestedProfile;
  let rendered = buildOutput(profileUsed);
  let byteLen = Buffer.byteLength(rendered, "utf8");

  // If over cap, try progressively smaller profiles.
  if (byteLen > MAX_RESPONSE_BYTES) {
    const startIdx = FALLBACK_ORDER.indexOf(profileUsed);
    // Try all profiles after the current one in the fallback order.
    for (let i = Math.max(startIdx, 0) + 1; i < FALLBACK_ORDER.length; i++) {
      const candidate = FALLBACK_ORDER[i]!;
      const candidateRendered = buildOutput(candidate);
      const candidateBytes = Buffer.byteLength(candidateRendered, "utf8");
      if (candidateBytes <= MAX_RESPONSE_BYTES) {
        profileUsed = candidate;
        rendered = candidateRendered;
        byteLen = candidateBytes;
        break;
      }
      // Keep trying smaller profiles even if still over cap.
      profileUsed = candidate;
      rendered = candidateRendered;
      byteLen = candidateBytes;
    }
  }

  // If still over cap after profile fallbacks, truncate by line count.
  let truncated = false;
  if (byteLen > MAX_RESPONSE_BYTES) {
    truncated = true;
    const lines = rendered.split(/\r?\n/);
    let budget = MAX_RESPONSE_BYTES - 200; // reserve space for truncation marker
    let cutAt = lines.length;
    let acc = 0;
    for (let i = 0; i < lines.length; i++) {
      acc += Buffer.byteLength(lines[i]! + "\n", "utf8");
      if (acc > budget) {
        cutAt = i;
        break;
      }
    }
    rendered = lines.slice(0, cutAt).join("\n") + `\n${commentNote(language, "[truncated: file too large even for symbol-map; use mode=symbol for a specific function body]")}`;
  } else if (profileUsed !== requestedProfile) {
    // Profile was downgraded due to cap — mark truncated.
    truncated = true;
  }

  const result: FileSkeletonPayload = {
    signatures: rendered,
    language,
    truncated,
  };

  if (truncated) {
    result.profile_used = profileUsed;
    result.byte_budget = MAX_RESPONSE_BYTES;
    result.hint = "use mode=symbol or smaller profile for focused view";
  }

  return { ok: true, data: result };
}
