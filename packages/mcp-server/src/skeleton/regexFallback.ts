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
  c: /^\s*\w[\w\s\*]+\s+\w+\s*\([^;]*$/,
  cpp: /^\s*(virtual\s+|static\s+|inline\s+|explicit\s+|constexpr\s+|override\s+|friend\s+)*\w[\w\s\*&:<>]*\s+\w+\s*\([^;]*$|^\s*(class|struct|enum)\s+\w+/,
  ruby: /^\s*(def|class|module)\s+/,
  php: /^\s*(public|private|protected|static|abstract|final|\s)*\s*function\s+\w+|^\s*(abstract\s+|final\s+)?class\s+\w+|^\s*interface\s+\w+/,
  kotlin: /^\s*(fun|class|object|interface|data class|sealed class|abstract class|open class)\s+\w+/,
};

function javaLikeSignature(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) return false;
  if (trimmed.includes("\"") || trimmed.includes("'")) return false;
  const words = trimmed.split(/\s+/);
  const declaration = words.findIndex((word) => word === "class" || word === "interface" || word === "enum");
  if (declaration >= 0 && words[declaration + 1] !== undefined && /^[A-Za-z_$][A-Za-z0-9_$<>\[\].]*$/.test(words[declaration + 1]!)) return true;
  const open = trimmed.indexOf("(");
  if (open <= 0) return false;
  let i = open - 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(trimmed[i]!)) i--;
  if (i >= open - 1) return false;
  const name = trimmed.slice(i + 1, open);
  if (name.length === 0 || name === "if" || name === "for" || name === "while" || name === "switch" || name === "catch") return false;
  // A method has modifiers (optional), exactly one return/type token, then
  // its name. This rejects statements such as `return foo()` and `new Foo()`.
  const before = trimmed.slice(0, i).trim().split(/\s+/);
  const modifiers = new Set(["public", "private", "protected", "static", "final", "abstract", "synchronized", "native", "strictfp", "virtual", "override", "async", "internal", "sealed", "extern", "unsafe", "partial"]);
  while (before.length > 0 && modifiers.has(before[0]!)) before.shift();
  if (before.length !== 1) return false;
  const type = before[0]!;
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.<>\[\],?A-Za-z0-9_$ ]*)$/.test(type)
    && type !== "return" && type !== "new";
}

/**
 * Extract signature lines from source text using language-specific regex patterns.
 * Returns an array of matching declaration lines (verbatim, trimmed right).
 */
export function regexSignatureLines(text: string, language: string): string[] {
  const key = language.toLowerCase();
  const pattern = LANG_PATTERNS[key];
  if (!pattern && key !== "java" && key !== "csharp") return [];

  const lines = text.split(/\r?\n/);
  return lines.filter((line) => key === "java" || key === "csharp" ? javaLikeSignature(line) : pattern!.test(line)).map((line) => line.trimEnd());
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
