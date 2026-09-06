/**
 * Format compression for token-efficient delivery.
 * Strips redundant whitespace without touching indentation.
 */

/**
 * Collapse runs of 2+ consecutive blank lines to one blank line and
 * strip trailing whitespace from every line.  Leading whitespace
 * (indentation) is NEVER modified — Hrubec & Cito 2026 (arXiv:2606.01326) showed 22%
 * perf drop from dedent.
 */
export function compressFormat(text: string): string {
  if (!text) return text;

  const hadTrailingNewline = text.endsWith("\n") || text.endsWith("\r\n");
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  const out: string[] = [];
  let prevBlank = false;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const isBlank = trimmed.length === 0;

    if (isBlank && prevBlank) continue;

    out.push(trimmed);
    prevBlank = isBlank;
  }

  let result = out.join("\n");

  // Remove trailing blank line that was kept as the last element if the
  // original didn't end with a newline.
  if (!hadTrailingNewline && result.endsWith("\n")) {
    result = result.replace(/\n$/, "");
  }
  // Ensure trailing newline if original had one.
  if (hadTrailingNewline && !result.endsWith("\n")) {
    result += "\n";
  }

  return result;
}

// ---------------------------------------------------------------------------
// DESIGN-v0.8 §C3: doc-comment elision.
//
// 48.7K chars (16%) of measured TL response bytes are comment lines. Most of
// that is multi-line JSDoc/docstring boilerplate that an agent re-slices via
// handle before composing an exact edit anyway (CLAUDE.md routing rule 4),
// so the FULL text is not actually load-bearing in a read/pack response —
// only its presence (so the agent knows documentation exists) and its line
// count (so line-number-based navigation stays sane) are.
//
// elideDocComments replaces MULTI-LINE doc-comment/docstring blocks with a
// single-line marker that names the original span, e.g.
// `/* doc elided L12-18 */` (Python: `# doc elided L12-18`). Single-line
// trailing `//`/`#` comments are always left untouched — they are cheap and
// often carry load-bearing inline context (e.g. "// eslint-disable-next-line").
//
// Two structural rules keep the scanner sound where the previous
// substitution-style pass was not (v0.8 bug fixes BUG-1..3):
//
//   1. Line-start anchoring. A C-style block opener is recognized ONLY when
//      `/*` is the first non-whitespace on its line. Doc comments always
//      start a line; a mid-line `/*` is two operator characters (a division
//      followed by `*`, a glob `/*`, or a regex-literal `/.../` body) and is
//      NEVER an opener. This structurally eliminates the regex-literal false
//      positive from `return s.replace(/\/*$/, "")` — that `/*` is mid-line.
//
//   2. Language allowlist (not a denylist). C-block elision runs ONLY for
//      known C-comment languages (see C_BLOCK_COMMENT_LANGS). Python gets
//      docstring-only elision (triple-quoted block at statement position).
//      Every OTHER language — markdown, ruby, yaml, toml, shell, html, json,
//      and any unknown/undefined lang — gets NO elision at all and the input
//      is returned unchanged. There is no `//`-to-EOL skip for non-C langs,
//      so Python floor-division `n // 8` no longer desyncs docstring state.
//
// Safety: string/template-literal state is still tracked character-exactly,
// so a line-start `/*` INSIDE a multi-line JS/TS template literal, or a
// triple-quote INSIDE a normal Python string, is never treated as an opener.
// Malformed/unclosed regions are left exactly as found (running off the end
// of the text is treated as "not actually a multi-line block").
// ---------------------------------------------------------------------------

/**
 * Languages that use C-style `/* ... *\/` (incl. `/** ... *\/`) block
 * comments. Exact tree-sitter language ids as produced by
 * util/languages.ts (`typescriptreact`/`javascriptreact` for tsx/jsx);
 * `swift`/`scala` are listed for completeness even though this repo's
 * extension map does not currently emit them. Only these get C-block
 * elision — every other lang (markdown, ruby, yaml, toml, shell, html,
 * json, unknown/undefined) gets none.
 */
const C_BLOCK_COMMENT_LANGS = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "kotlin",
  "swift",
  "scala",
  "php",
]);

/** Languages whose docstrings are Python-style triple-quoted blocks. */
const PYTHON_LIKE_LANGS = new Set(["python"]);

/**
 * Replace MULTI-LINE doc/comment blocks with a compact span marker. Multi-line
 * means the block spans 2+ source lines (a `/* ... *\/` or `"""..."""` that
 * opens and closes on the SAME line is left alone — it is already compact and
 * often an inline type/value annotation, not documentation). Single-line
 * trailing `//`/`#` comments are never touched, regardless of language.
 *
 * `lang` should be one of the tree-sitter language ids from util/languages.ts
 * (e.g. "typescript", "python", "cpp"). Only C-comment langs and "python" get
 * any elision; every other value (including undefined) returns `text`
 * unchanged.
 *
 * Marker format carries the original 1-based inclusive line span so an
 * elided display can be mapped back to source: `/* doc elided L<start>-<end>
 * *\/` for C-comment langs, `# doc elided L<start>-<end>` for Python (valid
 * Python syntax). Line numbers are relative to the text passed in — for a
 * whole-file read that is the raw file line; for a slice it is slice-relative
 * (add the slice's start offset to recover the file line). A Phase-2
 * write-guard can locate every marker with the substring "doc elided".
 *
 * Pure function: no I/O, no side effects. Never throws — malformed/unclosed
 * comment or string regions are left exactly as they were found.
 */
export function elideDocComments(text: string, lang?: string, startLine: number = 1): string {
  return elideDocCommentsWithWindows(text, lang, startLine).text;
}

/**
 * FX-W3 (ruling (aa), 2026-09-04): the elided-WINDOW-returning twin of
 * `elideDocComments`. Round-21A's finding: TL's own ledger accounting used to
 * DECIDE which file lines were "elided" (and therefore write-authority-
 * eligible under ruling (x)) by re-parsing the RENDERED OUTPUT for
 * marker-shaped lines after the fact (`servedSpansOfDisplayedText`,
 * `envelope.ts`'s settlement corroboration). A literal string in ordinary
 * file content that merely LOOKS like `/* doc elided L5-250 *\/` is
 * byte-identical to a genuine marker and indistinguishable from one by that
 * re-parse — so a forged marker plus an ordinary wire-level `budget.bytes`
 * shed could make a lane that received only the first 76 of 300 lines walk
 * away holding write authority over the whole file.
 *
 * RULING (aa): the elided windows are a FACT OF THE RENDERER, not a fact of
 * the wire text. This function computes and returns them at the EXACT moment
 * `elideCBlockComments`/`elidePythonDocstrings` collapse a genuine multi-line
 * block — never by scanning the OUTPUT afterward — so `elided` can only ever
 * name a window this call itself removed. A caller's own file content that
 * happens to contain marker-shaped text never appears here unless this scan
 * itself collapsed it from a real 2+-line comment/docstring block.
 *
 * Every OTHER export in this module (`elideDocComments`,
 * `elideDocCommentsForDisplay`) is a thin wrapper over this one scan, so the
 * windows and the text can never disagree with each other.
 */
export function elideDocCommentsWithWindows(
  text: string,
  lang?: string,
  startLine: number = 1,
): { text: string; elided: Array<[number, number]> } {
  if (!text) return { text, elided: [] };

  const isCLang = lang !== undefined && C_BLOCK_COMMENT_LANGS.has(lang);
  const isPython = lang !== undefined && PYTHON_LIKE_LANGS.has(lang);

  // Every other language (markdown, ruby, yaml, toml, shell, html, json, and
  // unknown/undefined) gets NO elision — the source is not C-comment-shaped
  // and treating `/*`/`"""` sequences as comments there deletes real content
  // (BUG-3: unbackticked glob patterns in .md contract prose).
  if (!isCLang && !isPython) return { text, elided: [] };

  // item 11: `startLine` is the 1-based FILE line of `text`'s first line, so a
  // marker on a slice can carry TRUE file line numbers rather than
  // slice-relative ones (a whole-file read passes startLine=1, the default, and
  // is unchanged). A value < 1 is clamped to 1 defensively.
  const base = Number.isFinite(startLine) && startLine >= 1 ? Math.floor(startLine) : 1;
  if (isPython) return elidePythonDocstrings(text, base);
  return elideCBlockComments(text, base);
}

/**
 * FX-W3: pure arithmetic complement of `windows` within [rangeStart,
 * rangeEnd] — the SURVIVING (non-elided) file-line spans a serve site should
 * book, computed directly from the RENDERER's own accounting
 * (`elideDocCommentsWithWindows`'s `elided` list, or an equivalent
 * caller-supplied window list) rather than by re-parsing the rendered text
 * for marker-shaped lines (ruling (aa)). `windows` is assumed ascending and
 * non-overlapping — `elideDocCommentsWithWindows`'s own left-to-right scan
 * already guarantees this for its own output.
 *
 * Pure and total: an empty `windows` list returns `[[rangeStart, rangeEnd]]`
 * unchanged (nothing was elided, so the whole window survived), matching
 * what `servedSpansOfDisplayedText` returned for marker-free text.
 */
export function spansExcludingWindows(
  rangeStart: number,
  rangeEnd: number,
  windows: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let cursor = rangeStart;
  for (const [winStart, winEnd] of windows) {
    const clampedStart = Math.max(rangeStart, winStart);
    const clampedEnd = Math.min(rangeEnd, winEnd);
    if (clampedEnd < clampedStart) continue; // window lies entirely outside [rangeStart, rangeEnd]
    if (clampedEnd < cursor) continue; // window lies entirely behind the cursor already
    if (clampedStart > cursor) spans.push([cursor, clampedStart - 1]);
    cursor = Math.max(cursor, clampedEnd + 1);
  }
  if (cursor <= rangeEnd) spans.push([cursor, rangeEnd]);
  return spans;
}

/**
 * item 10 (companion to W1's scanner fix): an agent that read a compressed
 * slice (comments elided) and then pastes it straight back as an edit would
 * write the ELISION MARKER into the file, silently deleting whatever the marker
 * stood for. This matches the EXACT marker shapes emitted above —
 * `/* doc elided L<a>-<b> *\/` (C-comment langs) and `# doc elided L<a>-<b>`
 * (Python) — NOT the bare words "doc elided", so legitimate prose that happens
 * to contain that phrase is acceptable collateral and is NOT blocked. Exported
 * as the single source of truth: server.ts's edit-refusal guard
 * (contentHasElisionMarker) and readCodeModes.ts's fully-elided-slice hint
 * both import this instead of hand-rolling their own copy.
 */
export const ELISION_MARKER_RE = /\/\* doc elided L\d+-\d+ \*\/|#\s?doc elided L\d+-\d+/;

/**
 * Narrow set of TL-authored display markers safe to hard-block in write
 * inputs; bare ellipses are source text. MEMBERSHIP RULE (wave-11 F3,
 * tightened at merge review): an alternative may live here only if the shape
 * cannot plausibly occur in a real workspace file. The skeleton/scope sentinel
 * vocabulary (`tokenlighten:skeleton…`/`:scope`) and the numeric
 * `<elided n=N>` placeholder FAIL that rule — this repository alone carries
 * them in 45+ legitimate source lines and docs examples (emitter template
 * literals, JSDoc describing the markers, CLI constants, numeric examples in
 * docs/components), so guarding them made TL unable to edit its own source.
 * They are deliberately EXCLUDED; the 0-match refusal's advisory detail covers
 * that residual instead.
 */
export const TL_SYNTHETIC_MARKER_RE = new RegExp(
  [
    "…\\[truncated:\\s+\\d+\\s+bytes\\s+elided\\]",
    "\\[truncated:\\s+(?:unrecognized extension served verbatim up to the byte budget; use mode=slice \\(range\\) or search_files action=find for the rest|file too large even for symbol-map; use mode=symbol for a specific function body)\\]",
  ].join("|"),
  "u",
);

/**
 * Global, capture-bearing twin of ELISION_MARKER_RE, used ONLY by
 * servedSpansOfDisplayedText. Kept immediately beside its sibling and beside
 * the two emitters (elideCBlockComments / elidePythonDocstrings) so a change
 * to the marker syntax has to update all four in one place. Slightly more
 * lenient about inner whitespace than ELISION_MARKER_RE: matching MORE markers
 * can only shrink what the ledger books, which is the safe direction.
 */
const ELISION_MARKER_SPAN_RE_G =
  /\/\*\s*doc elided L(\d+)-(\d+)\s*\*\/|#\s*doc elided L(\d+)-(\d+)/g;

/**
 * round-18A finding 7 (2026-09-03): a genuine elision marker's from/to are
 * NOT position-verifiable (see servedSpansOfDisplayedText's own doc comment
 * below -- some callers pass file-absolute numbers, others code-relative
 * ones starting at L1), so there is no sound way to prove a marker-shaped
 * string found in already-displayed text was actually emitted by
 * elideCBlockComments/elidePythonDocstrings rather than being literal file
 * content those never touched (a single-line block comment that happens to
 * read "doc elided L5-150" is byte-identical to a genuine multi-line marker
 * and indistinguishable from it by shape or position alone; measured live,
 * scratchpad/r18/h_elide.mts).
 *
 * What IS true of every marker this codebase actually emits: it stands in
 * for a real collapsed block, and the pinned elision fixtures this file's
 * own settlement corroboration must not regress (replayCorpus's seh1/seh4/
 * seh6 group -- a 40-line file collapsing one 21-line comment block into a
 * 20-line display) show a collapse ratio close to 1x relative to the TOTAL
 * displayed window. A single match claiming a width many times the entire
 * displayed text's own line count is far more consistent with a forged or
 * coincidental literal than a genuine collapse. servedSpansOfDisplayedText
 * refuses to trust (treats as ordinary, non-collapsing content) any match
 * whose declared width exceeds lines.length * MARKER_WIDTH_TRUST_MULTIPLIER
 * -- which only ever NARROWS what this function reports (the safe direction,
 * ruling (t)/(v)): a genuine marker with a legitimately enormous compression
 * ratio relative to a tiny displayed window costs one redundant re-serve
 * instead of a false receipt; a forged one can no longer shift booked spans
 * off the lines that shipped.
 */
const MARKER_WIDTH_TRUST_MULTIPLIER = 8;

/**
 * 2026-08-02 serve-honesty F1 — the INVERSE of the eliders above.
 *
 * Given the text a caller will ACTUALLY receive for a window that starts at
 * file line `rangeStart`, return the file-line spans that text really carries.
 * Every line an elision marker stands in for is excluded, because those bytes
 * never reach the wire.
 *
 * This exists because the served-range ledger used to book the REQUESTED
 * range while the response carried range-minus-elided-comments, so a later
 * read of exactly those comment lines came back as a `code_unchanged` receipt
 * for bytes the session had never been sent (live 2026-08-02: a `mode=symbol`
 * receipt for a 139-line span of which 4 lines had ever been served).
 *
 * Only a marker's WIDTH is trusted, never its printed line numbers: some call
 * sites pass a file `startLine` to elideDocComments (absolute markers) and
 * others do not (code-relative markers starting at L1), so the numbers are not
 * comparable across sites — but `to - from + 1` is the count of source lines
 * the marker replaced either way, which is all the walk needs.
 *
 * Deliberately conservative in one place: the code that follows a block
 * comment's closing delimiter on the CLOSING line does ride the wire, but it shares an
 * output line with the marker, so that whole source line is booked as unserved.
 * Under-recording costs one redundant re-serve; over-recording is the
 * correctness hole this function exists to close.
 *
 * @param rangeStart 1-based file line of the first line of `displayedText`.
 * @param rangeEnd   optional 1-based file line the window ends at; spans are
 *                   clamped to it (a display that runs long can never widen
 *                   the booking).
 *
 * FX-X3 (round-22B review, ruling (aa), 2026-09-04): retained TEST-ONLY.
 * `readCodeSmallFile.ts`'s `small_file` serve was the last production booking
 * site still calling this (marker-reparsing) producer — every content-bearing
 * serve site now books via `spansExcludingWindows` over the renderer's own
 * `elided` window list instead (never by re-parsing displayed text for
 * marker-shaped lines — see this function's own doc above for exactly why
 * that re-parse is unsound). `fxnBookingSettlementFence.spec.ts`'s
 * "servedSpansOfDisplayedText has no remaining non-test caller" check pins
 * this: it fails the day a NEW production call site reappears without a
 * reviewed exception. Kept (rather than deleted) because several existing
 * unit suites (`fxv1ElidedWindowForeignHandleCoverage.spec.ts`,
 * `fxoServeCoordinateSettlement.spec.ts`, `fxw3RendererAccountedElision
 * .spec.ts`, `readDocSectionsBooking.spec.ts`) still exercise its arithmetic
 * directly as a documented historical/regression reference.
 */
export function servedSpansOfDisplayedText(
  rangeStart: number,
  displayedText: string,
  rangeEnd?: number,
): Array<[number, number]> {
  if (displayedText === "") return [];
  const base = Number.isFinite(rangeStart) && rangeStart >= 1 ? Math.floor(rangeStart) : 1;
  const ceiling =
    rangeEnd !== undefined && Number.isFinite(rangeEnd) && Math.floor(rangeEnd) >= base
      ? Math.floor(rangeEnd)
      : Number.MAX_SAFE_INTEGER;

  const lines = displayedText.split("\n");
  // A trailing newline leaves one empty tail element that is not a source line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  // round-18A finding 7: see MARKER_WIDTH_TRUST_MULTIPLIER's doc comment.
  const trustedWidthCeiling = Math.max(1, lines.length) * MARKER_WIDTH_TRUST_MULTIPLIER;

  const spans: Array<[number, number]> = [];
  let cursor = base;
  let openStart = base;
  const closeRun = (lastLine: number): void => {
    const end = Math.min(lastLine, ceiling);
    if (end >= openStart) spans.push([openStart, end]);
  };

  for (const line of lines) {
    ELISION_MARKER_SPAN_RE_G.lastIndex = 0;
    let sawTrustedMarker = false;
    for (
      let match = ELISION_MARKER_SPAN_RE_G.exec(line);
      match !== null;
      match = ELISION_MARKER_SPAN_RE_G.exec(line)
    ) {
      const from = Number(match[1] ?? match[3]);
      const to = Number(match[2] ?? match[4]);
      const width =
        Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from + 1 : 1;
      // round-18A finding 7: an untrusted match (width wildly out of
      // proportion to the whole displayed window — see
      // MARKER_WIDTH_TRUST_MULTIPLIER) is treated as ordinary content, not a
      // marker: skip it here and let the marker-free fallback below advance
      // the cursor by one line, same as any other non-marker line.
      if (width > trustedWidthCeiling) continue;
      sawTrustedMarker = true;
      closeRun(cursor - 1);
      cursor += width;
      openStart = cursor;
    }
    // A marker CONSUMES its output line (the collapsed block ends there), so
    // only a marker-free (or untrusted-marker) line advances the cursor by one.
    if (!sawTrustedMarker) cursor += 1;
    if (cursor > ceiling + 1) break;
  }
  closeRun(cursor - 1);
  return spans;
}

/**
 * Whole-file/whole-slice "display content" resolver — wraps the
 * `keepComments ? text : elideDocComments(text, lang, startLine)` ternary
 * every content-bearing read_file success path used, adding one guard.
 *
 * 2026-07-16a bench forensics: a doc-only file (e.g. a 13-line docstring-only
 * python stub) can have elideDocComments strip its ENTIRE body down to a
 * single ELISION_MARKER_RE marker line — a whole-file serve that returns
 * just that marker with truncated:false reads, to the caller, as if the file
 * really were one comment and nothing else (the live agent concluded TL
 * was lying and went native for the rest of the task). The narrower
 * resolveSlice guard (readCodeModes.ts, search "DEFECT B") already catches
 * this for partial-range slices by attaching a `next` hint; a WHOLE-FILE
 * serve has no cheaper follow-up to hint at — the caller already asked for
 * everything — so auto-retrying server-side (serve the RAW content instead)
 * is strictly better than manufacturing the comments=keep round trip the
 * caller was always going to make anyway.
 *
 * Returns the elided text unchanged (no `note`) in every ordinary case,
 * including when elision made no change at all (unsupported language, or no
 * multi-line comment present). Falls back to the RAW (comments-kept) text,
 * plus a `note` explaining why, only when eliding would leave nothing (after
 * stripping the marker itself) while the raw input was non-empty.
 *
 * FX-W3 (ruling (aa), 2026-09-04): ALSO returns `elided`, the exact file-line
 * windows this call's OWN scan removed — a fact of the renderer
 * (`elideDocCommentsWithWindows`), always `[]` when `keepComments` is set, the
 * text is empty, elision made no change, or the doc-only fallback fired
 * (nothing was actually removed from what shipped in any of those cases).
 * Serve sites book their ledger spans from this list (`spansExcludingWindows`)
 * instead of re-parsing `content` for marker-shaped lines.
 */
export function elideDocCommentsForDisplay(
  text: string,
  lang: string | undefined,
  keepComments: boolean,
  startLine?: number,
): { content: string; note?: string; elided: Array<[number, number]> } {
  if (keepComments || text.trim() === "") return { content: text, elided: [] };
  const { text: elidedText, elided } = elideDocCommentsWithWindows(text, lang, startLine);
  if (elidedText === text) return { content: elidedText, elided: [] };
  const withoutMarkers = elidedText.split(ELISION_MARKER_RE).join("").trim();
  if (withoutMarkers === "") {
    return {
      content: text,
      note: "doc-only file; comments kept (elision would have removed all content)",
      elided: [],
    };
  }
  return { content: elidedText, elided };
}

/**
 * C-comment-language pass. Recognizes a `/* ... *\/` block ONLY when `/*` is
 * the first non-whitespace on its line (line-start anchoring); a mid-line
 * `/*` is left as-is. String and template-literal state is tracked so a
 * line-start `/*` inside a multi-line template literal is not an opener.
 * Trailing/inline `//` comments and single-line `/* ... *\/` are preserved.
 */
function elideCBlockComments(text: string, startLine: number = 1): { text: string; elided: Array<[number, number]> } {
  const out: string[] = [];
  const elided: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  // 1-based FILE line number of `text[i]` (starts at startLine so a slice's
  // markers carry true file line numbers), and whether only whitespace has
  // been seen since the current line began (so we can detect a line-start opener).
  let line = startLine;
  let atLineStart = true;

  while (i < n) {
    const ch = text[i]!;

    // --- Line comment: // — copy through to end of line untouched. ---
    if (ch === "/" && text[i + 1] === "/") {
      const end = lineEnd(text, i);
      out.push(text.slice(i, end));
      i = end;
      atLineStart = false;
      continue;
    }

    // --- C-style block comment: only a LINE-START /* is a real opener. ---
    if (atLineStart && ch === "/" && text[i + 1] === "*") {
      const closeIdx = text.indexOf("*/", i + 2);
      if (closeIdx === -1) {
        // Unclosed — not a real block; copy the rest verbatim and stop.
        out.push(text.slice(i));
        i = n;
        continue;
      }
      const blockEnd = closeIdx + 2;
      const block = text.slice(i, blockEnd);
      const span = countNewlines(block);
      if (span >= 1) {
        // Spans 2+ source lines (1+ embedded newline). Preserve any real code
        // that follows `*/` on the closing line — only the block itself goes.
        out.push(`/* doc elided L${line}-${line + span} */`);
        elided.push([line, line + span]);
        line += span;
        atLineStart = false;
        i = blockEnd;
        continue;
      }
      // Single-line /* ... */ — keep verbatim.
      out.push(block);
      i = blockEnd;
      atLineStart = false;
      continue;
    }

    // --- String / template literal: copy verbatim (may span lines). ---
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = scanQuotedString(text, i, ch);
      const segment = text.slice(i, end);
      out.push(segment);
      line += countNewlines(segment);
      i = end;
      atLineStart = false;
      continue;
    }

    if (ch === "\n") {
      out.push(ch);
      i++;
      line++;
      atLineStart = true;
      continue;
    }

    out.push(ch);
    i++;
    if (ch !== " " && ch !== "\t") atLineStart = false;
  }

  return { text: out.join(""), elided };
}

/**
 * Python pass: elide ONLY docstrings — a triple-quoted (`"""` or `'''`) block
 * whose opening line's first non-whitespace is the triple quote AND that sits
 * at a statement position (first statement of the file, or the nearest
 * preceding non-blank line ends with `:`). Triple-quoted strings assigned to
 * a variable or passed as an argument (SQL/templates) are NOT docstrings and
 * are left untouched. There is no `//`/`#` line-comment handling here (`#`
 * comments are single-line and cheap; `//` is floor division, not a comment).
 */
function elidePythonDocstrings(text: string, startLine: number = 1): { text: string; elided: Array<[number, number]> } {
  const out: string[] = [];
  const elided: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  // 1-based FILE line number (starts at startLine so a slice's markers carry
  // true file line numbers).
  let line = startLine;
  // First-non-whitespace column tracking for the current line.
  let atLineStart = true;
  // Whether any statement has been emitted yet (for "first statement" test).
  let sawStatement = false;
  // Does the nearest preceding non-blank line end with ':'? (def/class/if...)
  let prevNonBlankEndsColon = false;

  while (i < n) {
    const ch = text[i]!;

    // --- Docstring candidate: line-start triple quote at statement pos. ---
    if (
      atLineStart &&
      (ch === '"' || ch === "'") &&
      text[i + 1] === ch &&
      text[i + 2] === ch &&
      (!sawStatement || prevNonBlankEndsColon)
    ) {
      const quote = ch.repeat(3);
      const closeIdx = text.indexOf(quote, i + 3);
      if (closeIdx === -1) {
        // Unclosed — copy the rest verbatim and stop.
        out.push(text.slice(i));
        i = n;
        continue;
      }
      const blockEnd = closeIdx + 3;
      const block = text.slice(i, blockEnd);
      const span = countNewlines(block);
      if (span >= 1) {
        out.push(`# doc elided L${line}-${line + span}`);
        elided.push([line, line + span]);
        line += span;
        sawStatement = true;
        prevNonBlankEndsColon = false;
        atLineStart = false;
        i = blockEnd;
        continue;
      }
      // Single-line docstring — keep verbatim (already compact).
      out.push(block);
      line += countNewlines(block);
      sawStatement = true;
      prevNonBlankEndsColon = false;
      atLineStart = false;
      i = blockEnd;
      continue;
    }

    // --- Non-docstring triple quote (assigned/arg) or normal string: copy
    //     verbatim so its contents are never scanned as a docstring. ---
    if (ch === '"' || ch === "'") {
      if (text[i + 1] === ch && text[i + 2] === ch) {
        const quote = ch.repeat(3);
        const closeIdx = text.indexOf(quote, i + 3);
        const end = closeIdx === -1 ? n : closeIdx + 3;
        const segment = text.slice(i, end);
        out.push(segment);
        line += countNewlines(segment);
        i = end;
        atLineStart = false;
        sawStatement = true;
        continue;
      }
      const end = scanQuotedString(text, i, ch);
      const segment = text.slice(i, end);
      out.push(segment);
      line += countNewlines(segment);
      i = end;
      atLineStart = false;
      sawStatement = true;
      continue;
    }

    if (ch === "\n") {
      out.push(ch);
      i++;
      line++;
      atLineStart = true;
      continue;
    }

    out.push(ch);
    i++;
    if (ch === " " || ch === "\t") {
      // still at line start
    } else {
      // First real token on this line. If we are just leaving line-start,
      // this line is a statement; remember whether it ends with ':' once we
      // reach its newline. We approximate "ends with ':'" by inspecting the
      // trimmed line lazily below when the newline is consumed — but to keep
      // the scanner single-pass, compute it here from the line slice.
      if (atLineStart) {
        sawStatement = true;
        prevNonBlankEndsColon = lineEndsWithColon(text, i - 1);
      }
      atLineStart = false;
    }
  }

  return { text: out.join(""), elided };
}

/**
 * True if the source line CONTAINING index `from` ends (ignoring trailing
 * whitespace and a trailing `#`-comment) with a ':' — i.e. it opens a block
 * (def/class/if/for/while/with/try/else/elif/except/finally). Used to decide
 * whether a following triple-quoted block is a docstring.
 */
function lineEndsWithColon(text: string, from: number): boolean {
  const nl = text.indexOf("\n", from);
  let end = nl === -1 ? text.length : nl;
  // Strip a trailing full-line/inline `#` comment conservatively: only when a
  // '#' is not inside a string is it a comment, but a ':' that opens a block
  // is almost never followed by an inline comment containing an unbalanced
  // quote, so a simple last-non-space scan is sufficient here. Regression: this
  // truncation step was documented but never implemented — `end` stayed at the
  // newline unconditionally, so a block opener with a trailing comment (e.g.
  // `def foo():  # note`) never read as ending with ':' (the comment's own
  // trailing text was the last non-space content), silently skipping docstring
  // elision for the block that followed it.
  const hashIdx = text.indexOf("#", from);
  if (hashIdx !== -1 && hashIdx < end) end = hashIdx;
  let j = end - 1;
  while (j >= from && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j--;
  return j >= from && text[j] === ":";
}

/** Index of the end of the current line (position of '\n', or text.length). */
function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl === -1 ? text.length : nl;
}

/** Count '\n' occurrences in `s`. */
function countNewlines(s: string): number {
  let count = 0;
  for (let j = 0; j < s.length; j++) {
    if (s[j] === "\n") count++;
  }
  return count;
}

/**
 * Scan a quoted string/template literal starting at `start` (the opening
 * quote character `quote`), honoring backslash escapes, and return the
 * index just past the closing quote. Template literals (`quote === "`"`)
 * additionally must not be terminated by an escaped backtick, same escape
 * rule as single/double-quoted strings — `${...}` interpolation bodies are
 * NOT parsed separately (a nested `/* *\/`-shaped or `"""`-shaped sequence
 * inside an interpolation expression is rare and the conservative behavior
 * — leave the whole template literal untouched — is exactly the desired
 * "never elide inside a string literal" guarantee). An unterminated string
 * returns text.length (copy the remainder verbatim, same as an unclosed
 * comment).
 */
function scanQuotedString(text: string, start: number, quote: string): number {
  let j = start + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2; // skip the escaped character (works for \n, \\, \", \`, etc.)
      continue;
    }
    if (c === quote) return j + 1;
    j++;
  }
  return text.length;
}
