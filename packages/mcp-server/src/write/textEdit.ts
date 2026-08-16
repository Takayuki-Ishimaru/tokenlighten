/**
 * textEdit.ts — exact-match search/replace primitive for write tools.
 *
 * Ported from proto/src/core/textEdit.ts (applyAnchoredEdits, normalize helpers).
 * Intentionally lean: only the logic needed by search_replace_edit and
 * apply_edits_multi. No envelope/meta.
 *
 * Escape-sequence recovery: an agent that double-escapes a search/replace
 * string (JSON-encodes it twice, or otherwise sends the literal TWO-character
 * sequence `\` + `n` instead of an actual newline byte) gets a "search string
 * not found" miss even though the intended text is right there — burning a
 * full extra round trip. When the raw search is not found AND it contains a
 * literal `\n`/`\t`/`\r` escape, applySingleEdit retries with the unescaped
 * variant; if that matches EXACTLY ONCE it is applied (silently correcting
 * the caller's mistake) and the result carries `normalizedEscapes: true` plus
 * the actual `usedSearch`/`usedReplace` strings so callers that separately
 * recompute a line delta from the original input can use the strings that
 * were really matched instead of the caller's un-normalized originals.
 * The replace side is NOT unescaped in lockstep with the search: it is
 * unescaped only when it shares a live escape letter with the search that
 * recovered — see sharesLiteralEscapeClass.
 *
 * Output policy: plain data — no meta envelope.
 */

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

/** Replace the FIRST occurrence of needle in haystack. */
function replaceFirst(haystack: string, needle: string, rep: string): string {
  const i = haystack.indexOf(needle);
  return i === -1 ? haystack : haystack.slice(0, i) + rep + haystack.slice(i + needle.length);
}

/** Detect the dominant line-ending in a string. */
function detectLineEnding(s: string): "\n" | "\r\n" | "\r" {
  const idx = s.indexOf("\n");
  if (idx === -1) {
    return s.indexOf("\r") !== -1 ? "\r" : "\n";
  }
  return idx > 0 && s[idx - 1] === "\r" ? "\r\n" : "\n";
}

/** Normalize to LF + NFC for matching. */
function toLfNfc(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
}

/**
 * True when `s` contains a literal (double-escaped) `\n`, `\t`, or `\r`
 * TWO-character sequence — i.e. a backslash followed by the letter n/t/r,
 * as opposed to an actual newline/tab/CR byte. This is the double-escaping
 * mistake the recovery below targets; it deliberately does NOT touch `\\`
 * (an escaped backslash) or other escape letters, which are a different,
 * unrelated concern. Exported so other edit-application sites with their own
 * search/replace matching (e.g. apply_edits_multi's range-scoped replace-all,
 * which does not go through applySingleEdit) can offer the identical recovery
 * instead of re-deriving the detection regex.
 */
export function hasLiteralBackslashEscape(s: string): boolean {
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] !== "\\") continue;
    const next = s[i + 1]!;
    if (next === "\\") {
      i++; // escaped backslash — the pair is opaque, its second char is not an escape lead-in
      continue;
    }
    if (next === "n" || next === "t" || next === "r") return true;
  }
  return false;
}

/**
 * Invert one level of string-escaping, left to right: `\\` collapses to a
 * single backslash, `\n`/`\t`/`\r` become real newline/tab/CR bytes, and any
 * other backslash sequence (`\d`, `\s`, ...) is left untouched. This is the
 * inverse of the JSON-style over-encoding that produces the double-escape
 * mistake in the first place, so an escaped backslash shields the character
 * after it — the three characters `\`+`\`+`n` decode to the literal two-char
 * text `\n` (backslash then n), NOT a newline. Only ever applied after the
 * raw search missed AND hasLiteralBackslashEscape fired, and only kept under
 * the call site's own guard — exactly-once for the whole-file path,
 * at-least-once with a non-whitespace-only needle for the range-scoped
 * replace-all. Exported for the same reason as hasLiteralBackslashEscape
 * above.
 */
export function unescapeBackslashSequences(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && i + 1 < s.length) {
      const next = s[i + 1]!;
      if (next === "\\") { out += "\\"; i++; continue; }
      if (next === "n") { out += "\n"; i++; continue; }
      if (next === "t") { out += "\t"; i++; continue; }
      if (next === "r") { out += "\r"; i++; continue; }
    }
    out += ch;
  }
  return out;
}

/**
 * Literal escape letters (n/t/r) LIVE in `s`, using the same escaped-
 * backslash-skipping scan as hasLiteralBackslashEscape — a `\\` pair is
 * opaque and shields the character after it.
 */
function literalEscapeLetters(s: string): Set<string> {
  const letters = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i] !== "\\") continue;
    const next = s[i + 1]!;
    if (next === "\\") {
      i++;
      continue;
    }
    if (next === "n" || next === "t" || next === "r") letters.add(next);
  }
  return letters;
}

/**
 * True when `search` and `replace` BOTH contain a live literal escape of the
 * same letter (\n/\t/\r). This is the evidence gate for unescaping the
 * replace side during a search-side escape recovery: the only proof that the
 * caller is speaking one-level-over-escaped is the specific letter(s) that
 * made the search match, so only a replace sharing one of those letters is
 * unescaped with it. A replace whose escapes are all of OTHER classes (or
 * only `\\`) may legitimately want those bytes verbatim in the written text
 * (e.g. building a source string literal "a\nb"), and is left untouched.
 * Exported for the same reason as hasLiteralBackslashEscape above.
 */
export function sharesLiteralEscapeClass(search: string, replace: string): boolean {
  const searchLetters = literalEscapeLetters(search);
  if (searchLetters.size === 0) return false;
  for (const letter of literalEscapeLetters(replace)) {
    if (searchLetters.has(letter)) return true;
  }
  return false;
}

export type IndentationEquivalentMatch =
  | { kind: "none" }
  | { kind: "ambiguous"; count: number }
  | { kind: "unique"; start: number; end: number; matched: string };

function trimHorizontalWhitespace(line: string): string {
  return line.replace(/^[\t ]+|[\t ]+$/g, "");
}

function leadingHorizontalWhitespace(line: string): string {
  return line.match(/^[\t ]*/)?.[0] ?? "";
}

/**
 * Find a unique full-line block that differs from search only in leading or
 * trailing horizontal whitespace. Internal whitespace and line boundaries
 * remain exact, so this cannot turn a token-level mismatch into a write.
 */
export function findUniqueIndentationEquivalent(
  text: string,
  search: string,
): IndentationEquivalentMatch {
  if (search === "" || search.trim() === "") return { kind: "none" };

  const searchHasTrailingNewline = search.endsWith("\n");
  const searchLines = search.split("\n");
  if (searchHasTrailingNewline) searchLines.pop();
  if (searchLines.length === 0) return { kind: "none" };

  const textLines = text.split("\n");
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") lineStarts.push(i + 1);
  }

  let found: { start: number; end: number; matched: string } | undefined;
  let count = 0;
  for (let line = 0; line + searchLines.length <= textLines.length; line++) {
    let equivalent = true;
    for (let offset = 0; offset < searchLines.length; offset++) {
      if (
        trimHorizontalWhitespace(textLines[line + offset]!)
        !== trimHorizontalWhitespace(searchLines[offset]!)
      ) {
        equivalent = false;
        break;
      }
    }
    if (!equivalent) continue;

    const afterLine = line + searchLines.length;
    if (searchHasTrailingNewline && afterLine >= lineStarts.length) continue;
    const start = lineStarts[line]!;
    const lastLine = line + searchLines.length - 1;
    const end = searchHasTrailingNewline
      ? lineStarts[afterLine]!
      : lineStarts[lastLine]! + textLines[lastLine]!.length;
    const matched = text.slice(start, end);
    if (matched === search) continue;

    count++;
    if (count > 1) return { kind: "ambiguous", count };
    found = { start, end, matched };
  }

  return found ? { kind: "unique", ...found } : { kind: "none" };
}

/** Preserve the matched block's base indentation when the caller's
 * replacement kept the same base indentation as its search block. */
export function reindentReplacement(
  search: string,
  replace: string,
  matched: string,
): string {
  const searchLines = search.split("\n");
  const matchedLines = matched.split("\n");
  const searchBaseLine = searchLines.findIndex((line) => trimHorizontalWhitespace(line) !== "");
  if (searchBaseLine < 0 || searchBaseLine >= matchedLines.length) return replace;

  const searchIndent = leadingHorizontalWhitespace(searchLines[searchBaseLine]!);
  const matchedIndent = leadingHorizontalWhitespace(matchedLines[searchBaseLine]!);
  const replaceLines = replace.split("\n");
  const replaceBaseLine = replaceLines.findIndex((line) => trimHorizontalWhitespace(line) !== "");
  if (replaceBaseLine < 0) return replace;
  if (leadingHorizontalWhitespace(replaceLines[replaceBaseLine]!) !== searchIndent) return replace;

  return replaceLines.map((line) => {
    if (trimHorizontalWhitespace(line) === "") return line;
    return line.startsWith(searchIndent)
      ? matchedIndent + line.slice(searchIndent.length)
      : line;
  }).join("\n");
}

export type SearchReplaceErrorCode = "not-found" | "ambiguous" | "empty-search";

export interface SearchReplaceResult {
  ok: boolean;
  text?: string;
  error?: string;
  code?: SearchReplaceErrorCode;
  /**
   * Set true only when the raw search string was NOT found as given, it
   * contained a literal `\n`/`\t`/`\r` escape, and the UNESCAPED variant
   * matched exactly once (so the edit was applied against the unescaped
   * text). Absent on every other path, including the ordinary success case.
   */
  normalizedEscapes?: true;
  /** True when a unique full-line block recovered across indentation drift. */
  normalizedWhitespace?: true;
  /**
   * The search/replace strings ACTUALLY matched/applied. Escape recovery
   * returns the unescaped variants; indentation recovery returns the actual
   * matched block and its safely re-indented replacement. Callers that
   * separately recompute a line delta should use these strings.
   */
  usedSearch?: string;
  usedReplace?: string;
  /**
   * One-line recovery hint added to a not-found/ambiguous error ONLY when
   * the raw search contained a literal backslash escape sequence that did
   * NOT cleanly recover (0 or 2+ matches on the unescaped variant) — the
   * ordinary not-found/ambiguous error text is unchanged for every other
   * miss.
   */
  hint?: string;
}

/**
 * Apply a single search/replace to text.
 * - Exact search must occur once. If it occurs zero times, a unique full-line
 *   indentation-equivalent block may recover; ambiguous recovery still fails.
 * - Empty search string is allowed ONLY when creating a new file (allow_create path).
 *   In that case the replace string becomes the new file content directly.
 *
 * Line-ending normalization is applied during matching; the original file's
 * line-ending convention is restored in the output.
 */
export function applySingleEdit(
  text: string,
  search: string,
  replace: string
): SearchReplaceResult {
  if (search === "") {
    return {
      ok: false,
      code: "empty-search",
      // FIX 2c (mcp-server): edit_file's ADVERTISED param for this is
      // `create`, not `allow_create` — `allow_create` only ever existed on
      // the deprecated search_replace_edit alias's own schema, so an agent
      // using edit_file could not see the name this hint used to reference.
      error: "search string is empty — for new file creation use create:true with an empty search",
    };
  }

  const originalLineEnd = detectLineEnding(text);
  const normalizedText = toLfNfc(text);
  const normalizedSearch = toLfNfc(search);
  const normalizedReplace = toLfNfc(replace);

  const count = countOccurrences(normalizedText, normalizedSearch);

  if (count === 0) {
    // Literal-backslash-escape recovery: an agent that double-escapes its
    // search string (JSON-encodes it twice, or otherwise sends the literal
    // TWO-character sequence `\`+`n` instead of an actual newline byte) gets
    // a not-found miss even though the intended text is right there. Only
    // attempted when the RAW search actually contains one of these literal
    // sequences — an ordinary not-found miss with no escapes is unaffected.
    if (hasLiteralBackslashEscape(search)) {
      const unescapedSearch = toLfNfc(unescapeBackslashSequences(search));
      const unescapedCount = countOccurrences(normalizedText, unescapedSearch);
      if (unescapedCount === 1) {
        // Unescape the replace side only when it shares a live escape letter
        // with the search that recovered (sharesLiteralEscapeClass) — the
        // search's letters are the only evidence of over-escaping, and a
        // replace whose escapes are all of other classes (or only `\\`) may
        // legitimately want those bytes verbatim in the written text.
        const replaceShares = sharesLiteralEscapeClass(search, replace);
        const appliedReplace = replaceShares
          ? toLfNfc(unescapeBackslashSequences(replace))
          : normalizedReplace;
        let result = replaceFirst(normalizedText, unescapedSearch, appliedReplace);
        if (originalLineEnd !== "\n") {
          result = result.replace(/\n/g, originalLineEnd);
        }
        return {
          ok: true,
          text: result,
          normalizedEscapes: true,
          usedSearch: unescapeBackslashSequences(search),
          usedReplace: replaceShares ? unescapeBackslashSequences(replace) : replace,
        };
      }
      // 0 or 2+ matches on the unescaped variant: recovery didn't cleanly
      // resolve — fall through to the ordinary not-found error, but add a
      // one-line hint pointing at the likely cause.
      return {
        ok: false,
        code: "not-found",
        error: `search string not found in file`,
        hint: "search contained a literal backslash escape sequence (\\n/\\t/\\r); if you intended an actual newline/tab, check for double-escaping",
      };
    }
    const indentationMatch = findUniqueIndentationEquivalent(normalizedText, normalizedSearch);
    if (indentationMatch.kind === "unique") {
      const appliedReplace = reindentReplacement(
        normalizedSearch,
        normalizedReplace,
        indentationMatch.matched,
      );
      let result = normalizedText.slice(0, indentationMatch.start)
        + appliedReplace
        + normalizedText.slice(indentationMatch.end);
      if (originalLineEnd !== "\n") result = result.replace(/\n/g, originalLineEnd);
      return {
        ok: true,
        text: result,
        normalizedWhitespace: true,
        usedSearch: indentationMatch.matched,
        usedReplace: appliedReplace,
      };
    }
    if (indentationMatch.kind === "ambiguous") {
      return {
        ok: false,
        code: "ambiguous",
        error: "search string is indentation-equivalent to multiple full-line blocks — add non-whitespace context to make it unique",
      };
    }
    return { ok: false, code: "not-found", error: `search string not found in file` };
  }

  if (count > 1) {
    return {
      ok: false,
      code: "ambiguous",
      error: `search string matches ${count} locations — add more surrounding context to make it unique`,
    };
  }

  let result = replaceFirst(normalizedText, normalizedSearch, normalizedReplace);

  // Restore original line endings so unchanged lines stay byte-identical.
  if (originalLineEnd !== "\n") {
    result = result.replace(/\n/g, originalLineEnd);
  }

  return { ok: true, text: result };
}
