// Comment- and string-aware masking of source text (W-CONCERNS, plan §6.4
// fixture 2, risk R9 / review R7-1).
//
// WHY THIS EXISTS. `relationCodeOnly` (readCodeTaskPack.ts:13915) removes
// block comments, a `//` comment that begins a line or follows whitespace, and
// a `#` line that is not `#include`. That is enough for a token census, and it
// is NOT enough for the one predicate whose entire job is to assert "this file
// DEFINES the anchored member": `qualifiedAnchorSiteKind`
// (readCodeTaskPack.ts:14024) accepted a commented-out or quoted
// `Qualifier::member(...) { }` as a definition site
// (DESIGN-v0.14-plan.md:104). A false definition is worse than no definition:
// it seeds a pack with a file that cannot answer the caller's question and it
// would, once concerns are wired, mint a `definition` obligation nothing can
// discharge.
//
// WHAT IT DOES. One left-to-right pass replaces the CONTENT of comments and
// string literals with spaces, preserving every newline and the total length
// in UTF-16 code units, so an offset computed on the masked text still
// addresses the original text. Recognized spans:
//
//   block comment       slash-star ... star-slash (multi-line)
//   line comment        `//` to end of line
//   directive/comment   `#` to end of line, EXCEPT `#include`
//   dash comment        `--` to end of line, only when it is preceded by
//                       start-of-line or whitespace AND followed by whitespace
//                       or another `-` (SQL/Lua/Haskell). `i--` and `--flag`
//                       are deliberately NOT comments: mis-masking a C-family
//                       decrement would delete real code from the line.
//   docstring           `"""` or `'''` to its matching closer (multi-line)
//   template literal    backtick to its matching backtick (multi-line)
//   string literal      `"` or `'` to its matching quote ON THE SAME LINE.
//                       An unterminated quote is left alone rather than
//                       swallowing the rest of the file — prose apostrophes
//                       ("don't") must not be able to erase a real definition
//                       further down.
//
// It is a lexical approximation, not a parser: it has no language argument and
// never asks the filesystem. Every ambiguity is resolved toward masking LESS
// of the file, because a missed mask costs one false definition while an
// over-eager mask costs a definition that exists.

/** Bound on the scan: files past this size are masked up to the bound only. */
const MASK_MAX_CHARS = 4 * 1024 * 1024;

function lineEndFrom(text: string, index: number): number {
  const newline = text.indexOf("\n", index);
  return newline === -1 ? text.length : newline;
}

/** `#` begins a C/C++ include directive (kept, exactly as `relationCodeOnly` keeps it). */
function isIncludeDirective(text: string, index: number): boolean {
  return /^#[ \t]*include\b/.test(text.slice(index, index + 16));
}

/** `--` reads as a line comment only in an unambiguous SQL/Lua/Haskell shape. */
function isDashComment(text: string, index: number): boolean {
  const before = index === 0 ? "\n" : text[index - 1]!;
  if (!/[\s(,;]/.test(before)) return false;
  const after = text[index + 2];
  return after === undefined || after === "-" || /\s/.test(after);
}

/** Index of the quote closing a single-line string, or -1 when the line ends first. */
function endOfSingleLineString(text: string, start: number, quote: string): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "\n") return -1;
    if (ch === quote) return index;
  }
  return -1;
}

/** Index of the backtick closing a template literal, or -1 when none closes it. */
function endOfTemplateLiteral(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const ch = text[index]!;
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === "`") return index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// SF-5 residuals (round 11).
// ---------------------------------------------------------------------------

/**
 * A `/` is a division operator almost everywhere EXCEPT immediately after one
 * of these — the same set (minus a couple of rarely-hit keywords) real JS/TS
 * tokenizers use to disambiguate `/` (divide) from `/.../ ` (regex literal
 * start). Getting this wrong in the "allow" direction risks treating actual
 * division as a regex (rare — division is virtually never written right
 * after `=`/`(`/`,` etc. with no operand); getting it wrong in the "deny"
 * direction is the ALREADY-SHIPPED bug this fixes: a regex literal like
 * `/[//]/` has its OWN `//` mistaken for a line comment, silently masking
 * (and hiding) every real definition later on the same line.
 */
const REGEX_CONTEXT_CHARS = new Set(["=", "(", ",", ":", "[", "!", "?", "{", "}", ";"]);

function regexLiteralAllowedHere(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i -= 1;
  if (i < 0 || text[i] === "\n") return true; // start of file or start of line
  const ch = text[i]!;
  if (REGEX_CONTEXT_CHARS.has(ch)) return true;
  if (ch === "&" && text[i - 1] === "&") return true;
  if (ch === "|" && text[i - 1] === "|") return true;
  if (ch === "n" && text.slice(Math.max(0, i - 5), i + 1) === "return") {
    const before = i - 6;
    if (before < 0 || !/[A-Za-z0-9_$]/.test(text[before]!)) return true;
  }
  return false;
}

/**
 * Index just past the `/` that closes a regex literal opened at `start`, or
 * -1 when no valid close exists on this line (an unterminated "regex" is
 * left alone, exactly like an unterminated string — never risk swallowing
 * the rest of the file). A `[...]` character class is honored so an
 * unescaped `/` inside it (`/[//]/`) never ends the literal early.
 */
function endOfRegexLiteral(text: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const ch = text[index]!;
    if (ch === "\n") return -1;
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      index += 1;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      index += 1;
      continue;
    }
    if (ch === "/") return index;
    index += 1;
  }
  return -1;
}

/**
 * Index just past the closer of a Rust raw string (`r"..."`, `r#"..."#`,
 * `r##"..."##`, ...) opened at `start` (pointing at the `r`), or `undefined`
 * when `start` is not actually a raw-string opener. The closer must repeat
 * the SAME number of `#` as the opener — Rust raw strings support no
 * escapes at all, so a literal (unescaped) search for the closer is exactly
 * right, never a false early stop.
 */
function endOfRustRawString(text: string, start: number): number | undefined {
  let index = start + 1;
  let hashes = 0;
  while (text[index] === "#") {
    hashes += 1;
    index += 1;
  }
  if (text[index] !== "\"") return undefined;
  const closer = `"${"#".repeat(hashes)}`;
  const close = text.indexOf(closer, index + 1);
  return close === -1 ? text.length : close + closer.length;
}

/** File-extension/language hint enabling nested block-comment tracking. */
export interface MaskCommentsOptions {
  /**
   * When set to a language where `/* *\/` genuinely nests (Rust, Swift,
   * Scala, Kotlin), a `/* /* *\/ still comment *\/` block is masked in full. Omitted
   * (or any other value): block comments stop at the FIRST `*\/`, matching
   * every other supported language's actual `/* *\/` semantics — this is the
   * pre-existing, still-default behavior for every caller that does not pass
   * this option.
   */
  readonly language?: string;
}

const NESTING_BLOCK_COMMENT_LANGUAGES = new Set(["rs", "rust", "swift", "scala", "kt", "kts", "kotlin"]);

/**
 * `content` with comment and string-literal spans blanked out. Length in UTF-16
 * code units, newline positions, and every byte outside a masked span are
 * preserved, so the result is a drop-in for a regex scan over the original.
 */
export function maskCommentsAndStrings(content: string, options: MaskCommentsOptions = {}): string {
  if (content === "") return content;
  const nestingBlockComments =
    options.language !== undefined && NESTING_BLOCK_COMMENT_LANGUAGES.has(options.language.toLowerCase());
  const limit = Math.min(content.length, MASK_MAX_CHARS);
  const buffer = content.split("");
  let index = 0;
  const maskTo = (end: number): void => {
    const stop = Math.min(end, content.length);
    for (; index < stop; index += 1) {
      const ch = content[index]!;
      if (ch !== "\n" && ch !== "\r") buffer[index] = " ";
    }
  };
  while (index < limit) {
    const ch = content[index]!;
    const next = content[index + 1];
    // Rust raw strings (`r"..."`, `r#"..."#`, ...) — checked before the
    // string-literal branches below since they share no leading quote char.
    // A word-boundary guard keeps an ordinary trailing-`r` identifier
    // (immediately followed by an unrelated quote, which is not valid syntax
    // anyway in the languages this masker serves) from mis-firing.
    if (ch === "r" && (next === "\"" || next === "#")) {
      const prev = index === 0 ? undefined : content[index - 1];
      const isWordBoundary = prev === undefined || !/[A-Za-z0-9_$]/.test(prev);
      if (isWordBoundary) {
        const close = endOfRustRawString(content, index);
        if (close !== undefined) {
          maskTo(close);
          continue;
        }
      }
    }
    // A regex literal is never a comment or a string this masker should
    // blank out — but its content must not be scanned character-by-character
    // either, or an embedded `//` (e.g. inside a `[...]` class like `/[//]/`)
    // gets misread as a line comment that swallows the rest of the line,
    // including a real definition on it (SF-5 residual). `next` excludes an
    // empty pattern (`//`, a real comment) and a `/*`-shaped start (not valid
    // regex syntax) from ever being considered.
    if (ch === "/" && next !== "/" && next !== "*" && regexLiteralAllowedHere(content, index)) {
      const close = endOfRegexLiteral(content, index);
      if (close !== -1) {
        index = close + 1;
        continue;
      }
    }
    if (ch === "/" && next === "*") {
      if (nestingBlockComments) {
        let depth = 1;
        let cursor = index + 2;
        while (cursor < content.length && depth > 0) {
          if (content.startsWith("/*", cursor)) {
            depth += 1;
            cursor += 2;
          } else if (content.startsWith("*/", cursor)) {
            depth -= 1;
            cursor += 2;
          } else {
            cursor += 1;
          }
        }
        maskTo(cursor);
      } else {
        const close = content.indexOf("*/", index + 2);
        maskTo(close === -1 ? content.length : close + 2);
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      maskTo(lineEndFrom(content, index));
      continue;
    }
    if (ch === "#" && !isIncludeDirective(content, index)) {
      maskTo(lineEndFrom(content, index));
      continue;
    }
    if (ch === "-" && next === "-" && isDashComment(content, index)) {
      maskTo(lineEndFrom(content, index));
      continue;
    }
    if ((ch === "\"" || ch === "'") && content.startsWith(`${ch}${ch}${ch}`, index)) {
      const close = content.indexOf(`${ch}${ch}${ch}`, index + 3);
      maskTo(close === -1 ? content.length : close + 3);
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const close = endOfSingleLineString(content, index, ch);
      if (close === -1) {
        index += 1;
        continue;
      }
      maskTo(close + 1);
      continue;
    }
    if (ch === "`") {
      const close = endOfTemplateLiteral(content, index);
      maskTo(close === -1 ? content.length : close + 1);
      continue;
    }
    index += 1;
  }
  return buffer.join("");
}
