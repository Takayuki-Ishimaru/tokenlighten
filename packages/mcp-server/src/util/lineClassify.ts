/**
 * lineClassify.ts — cheap, parse-free line classification for the locator's
 * comment-only-match precision penalty.
 *
 * The general failure this addresses: a candidate file surfaces ONLY because a
 * query identifier appears inside its COMMENTS or string literals (the
 * canonical case being TokenLighten's OWN source, whose comments mention
 * domain identifiers from live tasks — matching a task query purely via prose).
 * Such a file is almost never the edit target; a match that occurs only on
 * comment/string lines is far weaker evidence than one on a code line.
 *
 * This reuses the SAME line-comment-prefix heuristic findReferences.ts already
 * applies (see its `looksLikeComment`), extended with block-comment state
 * tracking across lines, so a token buried in a multi-line `/* ... *\/` banner
 * is recognized. It is deliberately LEXICAL, not a tree-sitter parse: one pass
 * over the lines with a small per-language prefix table plus block-comment
 * depth is enough, and cheap enough to run per candidate file.
 */

/** Line-comment prefixes by language (superset of findReferences.ts's table). */
const LINE_COMMENT_PREFIXES: Record<string, string[]> = {
  typescript: ["//"], typescriptreact: ["//"],
  javascript: ["//"], javascriptreact: ["//"],
  java: ["//"], kotlin: ["//"], go: ["//"], rust: ["//"], scala: ["//"], swift: ["//"],
  c: ["//"], cpp: ["//"], csharp: ["//"], php: ["//", "#"],
  python: ["#"], ruby: ["#"], shell: ["#"], bash: ["#"], yaml: ["#"], toml: ["#"],
  css: [], scss: ["//"], less: ["//"],
  default: [],
};

/** Languages whose block comments use the C-style `/* ... *\/` delimiters. */
const C_STYLE_BLOCK = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
  "java", "kotlin", "go", "rust", "scala", "swift",
  "c", "cpp", "csharp", "php", "css", "scss", "less",
]);

/**
 * Classify every 1-based line of `text` as comment-like (true) or not (false),
 * for the given language. Comment-like means: the whole line is inside a
 * block comment, or its first non-whitespace run is a line-comment prefix, or
 * (for C-style languages) a block comment opens/continues on it.
 *
 * A line that opens a block comment AFTER some code (e.g. `foo(); /* note`) is
 * NOT flagged — the code portion is real. Only lines whose FIRST
 * non-whitespace content is comment syntax (or that sit fully within an open
 * block) are flagged, which is the conservative choice for a precision penalty.
 */
export function classifyCommentLines(text: string, language: string): boolean[] {
  const lines = text.split(/\r?\n/);
  const prefixes = LINE_COMMENT_PREFIXES[language] ?? LINE_COMMENT_PREFIXES["default"]!;
  const cStyle = C_STYLE_BLOCK.has(language);
  const out: boolean[] = new Array(lines.length).fill(false);

  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    if (inBlock) {
      out[i] = true;
      // A block comment can close mid-line; if it does and real code follows,
      // the line still counts as comment-dominated for penalty purposes (its
      // matched span, if any, was almost certainly in the comment tail). We
      // only need to update the OPEN/CLOSED state for subsequent lines.
      const close = line.indexOf("*/");
      if (close !== -1) inBlock = false;
      continue;
    }

    if (!trimmed) continue; // blank line — not comment-like, but harmless

    // Line-comment prefix at start of content.
    let isComment = false;
    for (const p of prefixes) {
      if (trimmed.startsWith(p)) { isComment = true; break; }
    }
    // C-style block-comment continuation banners (` * foo`) and openers.
    if (cStyle) {
      if (trimmed.startsWith("/*")) {
        isComment = true;
        // Opened here — is it also closed on the same line?
        const rest = trimmed.slice(2);
        if (!rest.includes("*/")) inBlock = true;
      } else if (trimmed.startsWith("*/") || trimmed.startsWith("* ") || trimmed === "*") {
        isComment = true;
      } else if (!isComment) {
        // A block comment may also open AFTER real code on the line (e.g.
        // `bar(); /* start of a`) — per the doc comment above, that OPENING
        // line stays unflagged (the code portion is real), but if the
        // comment does not ALSO close on this same line, its continuation
        // lines are genuinely, fully inside the block and must still be
        // tracked — otherwise a token on one of them silently reads as
        // non-comment, contradicting this function's own "a block comment
        // opens/continues on it" contract. Gated on `!isComment` so a `/*`
        // merely MENTIONED inside an already-recognized `//` line comment
        // (prose, e.g. "// see /* example syntax") is never mistaken for a
        // real opener — this scanner does not track string literals either,
        // so (like the line-start opener above) a `/*` embedded in a string
        // is a known, accepted imprecision of this cheap lexical pass.
        const openIdx = trimmed.indexOf("/*");
        if (openIdx !== -1 && !trimmed.slice(openIdx + 2).includes("*/")) {
          inBlock = true;
        }
      }
    }
    out[i] = isComment;
  }
  return out;
}

/**
 * True when EVERY line in `matchLines` (1-based) is comment-like for the given
 * language — i.e. the query token's only occurrences in this file are inside
 * comments (or block-comment banners). Empty `matchLines` returns false (no
 * evidence either way; the caller only penalizes a POSITIVE comment-only
 * determination).
 *
 * `commentFlags` is the array returned by classifyCommentLines. Out-of-range
 * lines are treated as non-comment (defensive; never flags on a bad index).
 */
export function matchesAreCommentOnly(matchLines: ReadonlyArray<number>, commentFlags: ReadonlyArray<boolean>): boolean {
  if (matchLines.length === 0) return false;
  for (const ln of matchLines) {
    const flag = commentFlags[ln - 1];
    if (flag !== true) return false;
  }
  return true;
}
