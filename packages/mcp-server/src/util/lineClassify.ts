/**
 * lineClassify.ts — cheap, parse-free line classification, now serving TWO
 * distinct roles rather than only the original one below: the locator's
 * comment-only-match PRECISION penalty (soften a candidate whose only hit is
 * inside a comment), and — since readCodeTaskPack.ts's
 * `classifyExecutedSearchHit` and `exactIdentifierEvidence` began reusing
 * this same classifier — a fail-closed code-bearing HONESTY gate (may a
 * `find`/identifier hit discharge an `identifier:<term>` obligation at all?).
 * The two roles tolerate the unknown-language case differently: a precision
 * consumer may fall back to `default` ("no comment syntax") since getting it
 * wrong only costs a missed penalty; an honesty consumer must never do that
 * (see `commentSyntaxIsKnown`'s own doc comment) since getting it wrong would
 * let an unproven match masquerade as evidence. `commentSyntaxIsKnown`/
 * `lineCommentPrefixesFor` exist specifically so an honesty consumer can tell
 * "known: no comments" apart from "unknown" before ever calling
 * `classifyCommentLines`.
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

/**
 * Line-comment prefixes by language (superset of findReferences.ts's table).
 *
 * R2-B13 (2026-09-13 review round 2): MEMBERSHIP IN THIS TABLE IS ITSELF AN
 * ANSWER. `commentSyntaxIsKnown` reports whether this module has actually been
 * taught a language, because `executedSearchHitIsCodeBearing` reuses this
 * classifier as an HONESTY gate (may a `find` hit discharge an
 * `identifier:<term>` obligation?) and there the `default: []` fallback read as
 * "this language has no comments" rather than "this language is unknown" — so
 * an identifier inside an HTML `<!-- ... -->` comment counted as a declaration.
 *
 * An EMPTY array therefore means "known: this language has no LINE comment
 * syntax" (css, html, json — all of which either have block comments below or
 * no comments at all), never "unknown". A language absent from this table is
 * unknown, and every honesty consumer must fail closed on it.
 */
const LINE_COMMENT_PREFIXES: Record<string, string[]> = {
  typescript: ["//"], typescriptreact: ["//"],
  javascript: ["//"], javascriptreact: ["//"],
  java: ["//"], kotlin: ["//"], go: ["//"], rust: ["//"], scala: ["//"], swift: ["//"],
  c: ["//"], cpp: ["//"], csharp: ["//"], php: ["//", "#"],
  python: ["#"], ruby: ["#"], shell: ["#"], bash: ["#"], yaml: ["#"], toml: ["#"],
  css: [], scss: ["//"], less: ["//"],
  // R2-B13: markup — block comments only (`<!-- ... -->`, see MARKUP_BLOCK).
  html: [], xml: [], svg: [], vue: [],
  // R2-B13: `--` line comments (SQL/Lua/Haskell/Ada). SQL also has `/* */`,
  // which C_STYLE_BLOCK below grants it.
  sql: ["--"], lua: ["--"], haskell: ["--"], ada: ["--"],
  // R2-B13: `;` line comments (ini/properties files, assembly, the lisp family).
  ini: [";"], asm: [";"], lisp: [";"], clojure: [";"], scheme: [";"], elisp: [";"],
  // R2-B13: JSON proper has no comments at all; JSONC/JSON5 take `//`.
  json: [], jsonc: ["//"], json5: ["//"],
  default: [],
};

/** Languages whose block comments use the C-style `/* ... *\/` delimiters. */
const C_STYLE_BLOCK = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
  "java", "kotlin", "go", "rust", "scala", "swift",
  "c", "cpp", "csharp", "php", "css", "scss", "less",
  // R2-B13: SQL's block comment is C-style too; JSONC/JSON5 permit `/* */`.
  "sql", "jsonc", "json5",
]);

/**
 * R2-B13: languages whose block comments use the MARKUP `<!-- ... -->`
 * delimiters. Disjoint from C_STYLE_BLOCK by construction (a language must not
 * claim two block syntaxes; `classifyCommentLines` tracks exactly one open
 * block state). Markdown is deliberately absent: it is prose whose every line
 * is "comment-like", and the honesty consumers reject it on its own extension
 * before any comment question is asked.
 */
const MARKUP_BLOCK = new Set(["html", "xml", "svg", "vue"]);

/**
 * SHOULD-FIX 28 (2026-09-14, review round 4) — THIS MODULE'S OWN EXTENSION MAP.
 *
 * `util/languages.ts`'s `EXT_TO_LANGUAGE` returns tree-sitter GRAMMAR names, so
 * it maps only the extensions this server can PARSE (the 12 target languages of
 * `LANGUAGE-CAPABILITY-MATRIX.md` plus css/html/json/yaml/toml/markdown). Every
 * honesty consumer resolved its comment language through that map, so 14 of the
 * rows in `LINE_COMMENT_PREFIXES` above were unreachable (review round 3
 * NOTE 30, measured): `swift` had comment syntax taught and no way to be asked
 * about it, and a located Swift declaration was therefore refused as "unknown
 * language" and never served — the chain dead-ended one call after TL found the
 * file (finding 28).
 *
 * Knowing a language's COMMENT SYNTAX is a much weaker claim than being able to
 * parse it, so it gets its own table rather than widening `EXT_TO_LANGUAGE`
 * (which would also change grammar selection, symbol extraction and the
 * `lang` filter — none of which this module has any business moving).
 *
 * DELIBERATELY NOT EXHAUSTIVE. It maps exactly the extensions whose language
 * `LINE_COMMENT_PREFIXES` already knows and `EXT_TO_LANGUAGE` does not. An
 * extension absent here (`.dart`, `.ex`, `.erl`, `.pl`, `.r`, `.jl`, `.ps1`,
 * `.m`, `.groovy`, `.tf`, `.proto`, `.graphql`, and every extensionless file)
 * stays UNKNOWN, and every honesty consumer keeps failing closed on it — an
 * unknown language must never DISCHARGE an obligation. What finding 28 changes
 * is that such a file is still SERVED (see `readCodeTaskPack.ts`'s
 * `classifyExecutedSearchHit`), so the caller can read it and judge for itself.
 */
const EXT_TO_COMMENT_LANGUAGE: Record<string, string> = {
  swift: "swift",
  scala: "scala", sc: "scala",
  scss: "scss", less: "less",
  xml: "xml", svg: "svg", vue: "vue",
  sql: "sql",
  lua: "lua",
  hs: "haskell",
  ada: "ada", adb: "ada", ads: "ada",
  ini: "ini",
  asm: "asm",
  lisp: "lisp",
  clj: "clojure", cljs: "clojure", cljc: "clojure",
  scm: "scheme",
  el: "elisp",
  json5: "json5",
};

/**
 * SHOULD-FIX 28: the language whose COMMENT SYNTAX governs `relPath`.
 *
 * `mapped` is what the caller's own resolver said (`languageForPath` /
 * `languageForPathWithContent`) and always wins — this only fills the gap for an
 * extension that resolver does not map. Returns `undefined` when neither knows
 * it, which every honesty consumer must treat as "not provably code".
 *
 * Takes `mapped` as a parameter rather than importing `util/languages.ts` so
 * this module stays a leaf with no dependency on grammar resolution, and so the
 * `.h` content sniff (`languageForPathWithContent`) keeps its authority.
 */
export function commentSyntaxLanguageForPath(relPath: string, mapped: string | undefined): string | undefined {
  if (mapped !== undefined) return mapped;
  const normalized = relPath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT_TO_COMMENT_LANGUAGE[base.slice(dot + 1).toLowerCase()];
}

/**
 * R2-B13: has this module actually been taught `language`'s comment syntax?
 *
 * `false` for `undefined` (an extension `languageForPath` does not map) and for
 * the literal `"default"` sentinel — both mean "unknown", and a classifier that
 * cannot recognize a comment must never be read as proof that a match is code.
 * Precision consumers (the locator's comment-only penalty) may ignore this and
 * keep using the `default` fallback; honesty consumers must not.
 */
export function commentSyntaxIsKnown(language: string | undefined): boolean {
  if (language === undefined || language === "default") return false;
  return Object.prototype.hasOwnProperty.call(LINE_COMMENT_PREFIXES, language);
}

/**
 * R2-B13: this language's line-comment prefixes, or `undefined` when the
 * language is unknown (see `commentSyntaxIsKnown`). Callers that need to strip
 * a trailing comment from one line must consult THIS table rather than guess a
 * prefix from the path, so the stripper and `classifyCommentLines` can never
 * disagree about what a comment looks like.
 */
export function lineCommentPrefixesFor(language: string | undefined): readonly string[] | undefined {
  if (!commentSyntaxIsKnown(language)) return undefined;
  return LINE_COMMENT_PREFIXES[language!];
}

/**
 * R2-B13: this language's block-comment OPENER (`/*` or `<!--`), or `undefined`
 * when it has none / is unknown. Same purpose as `lineCommentPrefixesFor`: one
 * table, one answer.
 */
export function blockCommentOpenerFor(language: string | undefined): string | undefined {
  if (language === undefined) return undefined;
  if (C_STYLE_BLOCK.has(language)) return "/*";
  if (MARKUP_BLOCK.has(language)) return "<!--";
  return undefined;
}

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
  // R2-B13: markup languages open/close blocks with `<!-- ... -->`. Disjoint
  // from `cStyle`, so exactly one block syntax is ever active per call and one
  // `inBlock` flag remains sufficient.
  const markup = MARKUP_BLOCK.has(language);
  const blockClose = cStyle ? "*/" : markup ? "-->" : undefined;
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
      const close = blockClose === undefined ? -1 : line.indexOf(blockClose);
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
    } else if (markup) {
      // R2-B13: the same three cases for `<!-- ... -->`. Markup has no
      // continuation-banner convention (no ` * foo` equivalent), so only the
      // opener, the bare closer line and the mid-line opener are handled.
      if (trimmed.startsWith("<!--")) {
        isComment = true;
        if (!trimmed.slice(4).includes("-->")) inBlock = true;
      } else if (trimmed.startsWith("-->")) {
        isComment = true;
      } else {
        const openIdx = trimmed.indexOf("<!--");
        if (openIdx !== -1 && !trimmed.slice(openIdx + 4).includes("-->")) {
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
