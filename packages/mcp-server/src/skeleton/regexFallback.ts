// Regex-based skeleton fallback for @tokenlighten/mcp-server.
//
// Used when Tree-sitter WASM fails to load or the language is unsupported.
// Output is PLAIN text: no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2 — meta envelope dominated cache_write cost.
//
// Extracts declaration-line signatures by language-specific patterns.
// Scope header (enclosing class / siblings) is NOT produced in fallback mode;
// a one-line notice is appended per docs/components/02-mcp-server.md §4.6.

import { commentNote } from "../util/sentinelComment.js";

/** Supported language patterns for regex-based signature extraction. */
const LANG_PATTERNS: Record<string, RegExp> = {
  python: /^\s*(async\s+)?def\s+\w+|^\s*class\s+\w+/,
  javascript: /^\s*(async\s+)?function\s+\w+|^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?class\s+\w+/,
  typescript: /^\s*(async\s+)?function\s+\w+|^\s*(export\s+)?(default\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?(abstract\s+)?class\s+\w+|^\s*(export\s+)?interface\s+\w+|^\s*(export\s+)?type\s+\w+\s*=/,
  go: /^\s*func\s+/,
  rust: /^\s*(pub\s+)?(async\s+)?fn\s+\w+|^\s*(pub\s+)?struct\s+\w+|^\s*(pub\s+)?enum\s+\w+|^\s*(pub\s+)?trait\s+\w+|^\s*(pub\s+)?impl\s+/,
  java: /^\s*(public|private|protected|static|final|abstract|synchronized|native|strictfp|\s)+\s+\w[\w<>\[\]]*\s+\w+\s*\(|^\s*(public|private|protected)?\s*(abstract\s+|final\s+)?class\s+\w+|^\s*(public|private|protected)?\s*interface\s+\w+|^\s*(public|private|protected)?\s*enum\s+\w+/,
  c: /^\s*\w[\w\s\*]+\s+\w+\s*\([^;]*$/,
  cpp: /^\s*(virtual\s+|static\s+|inline\s+|explicit\s+|constexpr\s+|override\s+|friend\s+)*\w[\w\s\*&:<>]*\s+\w+\s*\([^;]*$|^\s*(class|struct|enum)\s+\w+/,
  ruby: /^\s*(def|class|module)\s+/,
  csharp: /^\s*(public|private|protected|internal|static|virtual|override|abstract|sealed|async|partial|\s)*\s+\w[\w\.\[\]<>]*\s+\w+\s*\(|^\s*(public|private|protected|internal)?\s*(abstract\s+|sealed\s+|static\s+|partial\s+)*class\s+\w+|^\s*(public|private|protected|internal)?\s*interface\s+\w+/,
  php: /^\s*(public|private|protected|static|abstract|final|\s)*\s*function\s+\w+|^\s*(abstract\s+|final\s+)?class\s+\w+|^\s*interface\s+\w+/,
  kotlin: /^\s*(fun|class|object|interface|data class|sealed class|abstract class|open class)\s+\w+/,
};

/**
 * Extract signature lines from source text using language-specific regex patterns.
 * Returns an array of matching declaration lines (verbatim, trimmed right).
 */
export function regexSignatureLines(text: string, language: string): string[] {
  const key = language.toLowerCase();
  const pattern = LANG_PATTERNS[key];
  if (!pattern) return [];

  const lines = text.split(/\r?\n/);
  return lines.filter((line) => pattern.test(line)).map((line) => line.replace(/\s+$/, ""));
}

/**
 * Produce a regex-based skeleton for use when Tree-sitter is unavailable.
 * Appends a fallback notice so agents know scope context is not available.
 *
 * Output format per docs/components/02-mcp-server.md §4.6:
 *   - One signature per line
 *   - Trailing note, wrapped as a valid one-line comment for `language` via
 *     commentNote(): `// note: AST-fallback mode ...` for most languages,
 *     `# note: ...` for python/ruby, `/* note: ... *\/` for css (which has
 *     no line-comment syntax).
 */
export function regexFallbackSkeleton(text: string, language: string): string {
  const sigs = regexSignatureLines(text, language);
  const body = sigs.length > 0 ? sigs.join("\n") : "(no signatures detected)";
  return [
    body,
    "",
    commentNote(language, "note: AST-fallback mode (no scope header); use get_file_skeleton instead for unsupported languages."),
  ].join("\n");
}
