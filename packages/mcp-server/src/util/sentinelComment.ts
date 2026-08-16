/**
 * sentinelComment.ts — single source of truth for TokenLighten's own
 * sentinel/metadata comment lines: get_file_skeleton's
 * `tokenlighten:skeleton path=... lang=... ...` header (plus its
 * AST-fallback and byte-cap-truncation notices) and get_symbol_with_context's
 * `tokenlighten:scope path=... symbol=... lang=...` header (plus its section
 * labels and AST-fallback notice).
 *
 * Two concerns, both centralized here instead of hand-duplicated per call
 * site (getFileSkeleton.ts's inline commentChar ternary, the getSymbolWithContext.ts
 * commentChar/commentNote pair, regexFallback.ts's commentPrefixFor):
 *
 *   - EMISSION (commentNote): wrap free text as a syntactically valid
 *     one-line comment for `lang`. css has NO line-comment syntax at all —
 *     a bare `// ...` line emitted into a css skeleton is invalid CSS. An
 *     earlier pass deliberately kept `//` for css sentinel lines anyway,
 *     reasoning that consumers only ever detect them via startsWith and
 *     never re-parse them as the target language — true for TokenLighten's
 *     OWN consumers, but it still ships invalid syntax inside a response an
 *     agent may paste back verbatim. commentNote() fixes that: `/* ... *\/`
 *     for css, `# ...` for python/ruby, `// ...` everywhere else.
 *
 *   - DETECTION (isTokenlightenSentinelLine): recognize a TokenLighten
 *     sentinel/metadata line regardless of which comment form produced it,
 *     so a consumer filtering these lines out of skeleton/scope text does
 *     not need to special-case css (or python/ruby) itself. A raw
 *     `startsWith("// tokenlighten")` check — the pre-existing pattern at
 *     every call site this module replaces — only ever recognized the `//`
 *     form, silently missing python/ruby's `#` form and (before this module
 *     existed) css's block-comment form. The next new comment form is now a
 *     single-point change here instead of an N-site audit.
 */

/**
 * Single-line comment prefix for a language. css has NO line-comment syntax
 * — callers that need a syntactically valid one-liner for css must use
 * {@link commentNote} instead of this raw prefix.
 */
export function commentPrefixFor(lang: string): string {
  return lang === "python" || lang === "ruby" ? "#" : "//";
}

/**
 * A syntactically valid one-line comment carrying free text, for any
 * language get_file_skeleton/get_symbol_with_context supports — including
 * css, which renders `text` as a `/* ... *\/` one-liner instead of the
 * generic line-comment prefix.
 */
export function commentNote(lang: string, text: string): string {
  if (lang === "css") return `/* ${text} */`;
  return `${commentPrefixFor(lang)} ${text}`;
}

/**
 * True when `line` is a TokenLighten sentinel/metadata comment line — the
 * `tokenlighten:skeleton ...` or `tokenlighten:scope ...` header, or any
 * future `tokenlighten:<kind> ...` line emitted via {@link commentNote}.
 * Recognizes every comment form this module emits: `//` (most languages),
 * `#` (python/ruby), and a `/* ... *\/` one-liner (css). Leading whitespace
 * on `line` is ignored.
 *
 * Consumers should call this instead of a raw
 * `startsWith("// tokenlighten")` / `includes("// tokenlighten:skeleton")`
 * check — those only ever matched the `//` form.
 */
export function isTokenlightenSentinelLine(line: string): boolean {
  return /^(?:\/\/|#|\/\*)\s*tokenlighten:/.test(line.trim());
}
