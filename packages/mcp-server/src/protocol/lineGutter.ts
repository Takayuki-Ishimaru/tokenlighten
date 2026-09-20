// ---------------------------------------------------------------------------
// WP-S4 (2026-09-20) — answer-profile line gutter (TL_ANSWER_LINE_GUTTER).
//
// See util/flags.ts's `answerLineGutterEnabled` doc block for the flag's
// rollout status (default OFF, member of the TL_TURN_ECONOMY umbrella) and
// full motivation. In short: a served code body's `range` (e.g. "256-308")
// names the FILE lines it covers, but multi-line doc comments inside that
// body are collapsed by `elideDocCommentsWithWindows`
// (util/formatCompress.ts) into a single marker line, so a model cannot
// count from the body's own text to a statement's true source line. This
// module numbers each line of an eligible served body with that true line,
// so a host that wants `file:line` (or a model asked to cite one) never has
// to spend a native grep/`search_files find` call re-discovering it.
//
// THE ONE SEAM. `applyAnswerLineGutter` is called from exactly one place:
// `protocol/envelope.ts`'s `finalizeProtocolResponse`, immediately before it
// hands the payload to `emit.ts`'s `emitFinalizedPayload` — i.e. AFTER every
// consumer of the un-numbered producer body has already run (the read-family
// projection in `readFamily.ts`, `canonicalizeEmittedToolCalls`, and the
// ledger/certificate binding in `ledgerCertificateBinding.ts`) and BEFORE the
// wire budget first measures the response's bytes. That ordering is what
// keeps `limit`/shedding honest (the ladder sheds what actually ships) and
// keeps every ledger/fence/dedupe/`slice_sha`/obligation check operating on
// the producer's own un-numbered bytes.
//
// MUTATION, NOT CLONING. `applyAnswerLineGutter` mutates eligible evidence
// bodies IN PLACE and returns the SAME payload object it was given — it
// never spreads/clones the payload, the evidence/entries array, or an
// individual entry. `protocol/ledgerCertificateBinding.ts` associates
// ledger/certificate metadata with the exact payload object (and objects its
// own `markCarrier` walks into) via a `WeakMap<object, …>` keyed by
// reference; replacing any of those references here would silently detach
// that binding. Numbering only ever overwrites a leaf STRING field
// (`body`/`content`) that no ledger/certificate/dedupe logic reads, so this
// is safe.
//
// SOUND MAPPING (ruling (aa), util/formatCompress.ts): elided windows are a
// fact of the RENDERER, never re-derived by parsing marker-shaped text out of
// an already-served body. This module re-reads the workspace file for the
// evidence's own `path`+`range`, re-runs `elideDocCommentsWithWindows` on
// that exact slice (or slices — WP-G1, 2026-09-20: `range` minus every
// IN-RANGE `remaining`/`remaining_ranges` window is rendered span by span and
// concatenated, the shape a response-budget cap leaves when it sheds lines
// out of the MIDDLE of one body instead of an edge), and numbers a served
// body only when it is byte-equal to that rendering, a whole-line prefix of
// it (a body a byte cap cut short), or that rendering plus verbatim
// out-of-range context lines a symbol-focused surface appends for a
// still-missing explicit identifier (`materializeExplicitAnswerAnchorEvidence`,
// readCodeTaskPack.ts) — each such line numbered only when it is unique
// outside every served span. Anything else — comments kept, a trimmed
// middle, a synthetic outline, a stale file — ships un-numbered: this module
// never guesses.
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from "node:fs";

import type { Kind } from "@tokenlighten/types";

import { answerLineGutterEnabled } from "../util/flags.js";
import { elideDocCommentsWithWindows, spansExcludingWindows } from "../util/formatCompress.js";
import { languageForPath } from "../util/languages.js";
import { isMarkdownPath } from "../util/markdownSections.js";
import { READ_PATH_MAX_BYTES, safeResolve } from "../util/safePath.js";
import { laneTaskProfile, recordLaneTaskProfile } from "../state/laneTaskHandles.js";

type WireBody = Record<string, unknown>;

const ANSWER_PROFILE = "answer";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Languages `elideDocCommentsWithWindows` (util/formatCompress.ts) actually
 * transforms — the languages its own C_BLOCK_COMMENT_LANGS/PYTHON_LIKE_LANGS
 * allowlists recognize as having real comment/docstring grammar. Duplicated
 * here rather than imported (those sets are private to that module, and this
 * work package does not own it) as this module's own definition of "a path
 * whose language has a parser" — the brief's phrase for what counts as CODE
 * evidence. Everything else — markdown, plain text, JSON/YAML/TOML/HTML/CSS
 * config, Office, archives, and unrecognized extensions — is excluded,
 * matching "not Markdown, plain text, config, Office, archive": none of
 * those map into this set, and an evidence path from an artifact/archive
 * read is never shaped as a plain `path`+`range`+`body` entry to begin with.
 */
const GUTTER_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
  "java", "c", "cpp", "csharp", "go", "rust", "kotlin", "swift", "scala", "php",
  "python",
]);

function isGutterEligiblePath(path: string): boolean {
  if (isMarkdownPath(path)) return false;
  const lang = languageForPath(path);
  return lang !== undefined && GUTTER_LANGUAGES.has(lang);
}

/** Parses a wire range string ("256-308") into 1-based inclusive line bounds. */
function parseLineRange(range: string): { start: number; end: number } | undefined {
  const match = /^(\d+)-(\d+)$/.exec(range);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return undefined;
  return { start, end };
}

/**
 * Synchronous, workspace-confined file read for the gutter's own byte-equality
 * check. `finalizeProtocolResponse` (this module's one caller) is a plain
 * synchronous function on the response-emission path, so this mirrors
 * `safeResolve`'s lexical containment discipline (util/safePath.ts) rather
 * than the async `readFileSafe` used elsewhere in this server: the path was
 * already served by this SAME call moments earlier, so re-reading it opens no
 * new attack surface, only re-reads what the producer already decided was
 * safe. Returns undefined on any failure whatsoever (missing file, workspace
 * escape, oversize, decode error) — the caller's response to "cannot verify"
 * is always "leave this entry un-numbered", never a thrown error on the
 * response path.
 */
function readWorkspaceFileSync(relPath: string, workspace: string): string | undefined {
  const resolved = safeResolve(relPath, workspace);
  if (resolved === undefined) return undefined;
  try {
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > READ_PATH_MAX_BYTES) return undefined;
    return readFileSync(resolved, "utf8");
  } catch {
    return undefined;
  }
}

/** 1-based inclusive [start,end] slice of `fileText`'s lines, joined by "\n". */
function sliceLines(fileText: string, start: number, end: number): string | undefined {
  const lines = fileText.split("\n");
  const startIdx = start - 1;
  if (startIdx < 0 || startIdx >= lines.length) return undefined;
  const endIdx = Math.min(end, lines.length) - 1;
  if (endIdx < startIdx) return undefined;
  return lines.slice(startIdx, endIdx + 1).join("\n");
}

/** `text.split("\n")`, dropping the bogus trailing empty element a trailing "\n" leaves. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Walks `count` OUTPUT lines starting at `rangeStart`, assigning each its true
 * FILE source line number. `elided` (`elideDocCommentsWithWindows`'s own
 * return value) lists the [start,end] FILE-line spans the renderer collapsed
 * into ONE output line each, in ascending, non-overlapping order (guaranteed
 * by that function's single left-to-right scan). A marker line is numbered
 * with the span's FIRST line — matching the marker text itself, since
 * `elideCBlockComments`/`elidePythonDocstrings` both write the span's start
 * line into the marker they emit — and the cursor then resumes at the line
 * right after the span, which is exactly the source line the OUTPUT line
 * immediately following the marker holds.
 */
function sourceLineNumbersFor(
  elided: ReadonlyArray<readonly [number, number]>,
  rangeStart: number,
  count: number,
): number[] {
  const numbers: number[] = [];
  let cursor = rangeStart;
  let windowIndex = 0;
  for (let i = 0; i < count; i++) {
    const window = elided[windowIndex];
    if (window !== undefined && cursor === window[0]) {
      numbers.push(window[0]);
      cursor = window[1] + 1;
      windowIndex++;
    } else {
      numbers.push(cursor);
      cursor += 1;
    }
  }
  return numbers;
}

/** A 1-based inclusive `[start, end]` FILE line span. */
type LineSpan = [number, number];

/**
 * Parses every string in a `remaining`/`remaining_ranges` array into a line
 * span. Returns undefined — never a partial list — the moment any entry
 * fails to parse as a wire range, so a malformed window can never silently
 * vanish from the cut-structure accounting below.
 */
function parseRemainingWindows(remaining: unknown): LineSpan[] | undefined {
  if (remaining === undefined) return [];
  if (!Array.isArray(remaining)) return undefined;
  const windows: LineSpan[] = [];
  for (const item of remaining) {
    if (typeof item !== "string") return undefined;
    const bounds = parseLineRange(item);
    if (bounds === undefined) return undefined;
    windows.push([bounds.start, bounds.end]);
  }
  return windows;
}

/**
 * WP-G1 (2026-09-20): the holes a MULTI-SPAN body cuts out of its own
 * `range` — the shape a response-budget ladder leaves when it sheds lines out
 * of the MIDDLE of one evidence body instead of trimming an edge (`limit`
 * reads `{"cause":"capped","omitted":["evidence"]}` when it does that).
 * `remaining`/`remaining_ranges` names windows this HANDLE has not served,
 * which is not the same set as "holes inside THIS item's own `range`": a
 * window that is not FULLY contained in `[rangeStart, rangeEnd]` — most
 * commonly one entirely before or after it, describing content this call
 * never reached at all — says nothing about a cut inside the served window,
 * so it is dropped rather than treated (or partially treated, via clamping)
 * as a gap to number around.
 *
 * What is left after that filter must be strictly ascending and
 * non-overlapping — the renderer only ever produces disjoint, in-order cuts
 * — so any overlap (or a malformed window from `parseRemainingWindows`)
 * returns undefined: the caller's response to an unrecognized cut shape is
 * "leave this entry un-numbered", never a guess at where the pieces go.
 */
function inRangeHoles(rangeStart: number, rangeEnd: number, remaining: unknown): LineSpan[] | undefined {
  const windows = parseRemainingWindows(remaining);
  if (windows === undefined) return undefined;

  const contained: LineSpan[] = [];
  for (const [start, end] of windows) {
    if (start >= rangeStart && end <= rangeEnd) contained.push([start, end]);
  }
  contained.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < contained.length; i++) {
    if (contained[i - 1]![1] >= contained[i]![0]) return undefined;
  }
  return contained;
}

/**
 * Renders one FILE line span and numbers each of its OUTPUT lines with the
 * true source line `sourceLineNumbersFor` derives from the renderer's own
 * elision windows — the single-span building block `renderSpans` assembles a
 * multi-span body's combined rendering from.
 */
function renderSpan(
  fileText: string,
  span: LineSpan,
  lang: string | undefined,
): { lines: string[]; sourceLines: number[] } | undefined {
  const sourceSlice = sliceLines(fileText, span[0], span[1]);
  if (sourceSlice === undefined) return undefined;
  const rendered = elideDocCommentsWithWindows(sourceSlice, lang, span[0]);
  const lines = splitLines(rendered.text);
  const sourceLines = sourceLineNumbersFor(rendered.elided, span[0], lines.length);
  return { lines, sourceLines };
}

/**
 * Renders every span in ascending order and concatenates their OUTPUT lines
 * — exactly the shape a multi-span body takes on the wire: `renderer(span1)
 * + "\n" + renderer(span2) + ...`, with no marker line at the cut itself
 * (the JUMP in the resulting gutter, e.g. `…79|` then `180|…`, is the only
 * signal a reader gets that something was cut). A single span (no in-range
 * holes) degenerates to exactly today's one-call rendering, so this is a
 * strict generalization, not a behavior change, whenever `remaining` names
 * no hole inside `range`.
 */
function renderSpans(
  fileText: string,
  spans: readonly LineSpan[],
  lang: string | undefined,
): { lines: string[]; sourceLines: number[] } | undefined {
  const lines: string[] = [];
  const sourceLines: number[] = [];
  for (const span of spans) {
    const rendered = renderSpan(fileText, span, lang);
    if (rendered === undefined) return undefined;
    lines.push(...rendered.lines);
    sourceLines.push(...rendered.sourceLines);
  }
  return { lines, sourceLines };
}

/**
 * Numbers `bodyLines` against `rendered`, per ruling (aa): the
 * correspondence is a fact of the renderer's own spans, never re-derived by
 * parsing marker-shaped text out of `bodyLines` itself.
 *
 * Returns the numbered lines when `bodyLines` is byte-equal to
 * `rendered.lines` line by line, or a whole-line PREFIX of it (a body a byte
 * cap cut short). Returns undefined for anything else (comments kept, a
 * trimmed middle, a stale file, ...), which the caller treats as "leave this
 * entry un-numbered".
 */
function numberPrefixMatch(
  bodyLines: readonly string[],
  rendered: { lines: readonly string[]; sourceLines: readonly number[] },
): string[] | undefined {
  if (bodyLines.length === 0 || bodyLines.length > rendered.lines.length) return undefined;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i] !== rendered.lines[i]) return undefined;
  }
  return bodyLines.map((line, i) => `${rendered.sourceLines[i]}|${line}`);
}

/** Every 1-based FILE line covered by some span — the composite path's "outside the served spans" test below is defined against this set. */
function servedLineNumbers(spans: readonly LineSpan[]): Set<number> {
  const served = new Set<number>();
  for (const [start, end] of spans) {
    for (let n = start; n <= end; n++) served.add(n);
  }
  return served;
}

/**
 * The SINGLE FILE position (1-based start line) where the CONTIGUOUS `block`
 * occurs verbatim, entirely outside `served`. Undefined when there is no
 * such position, or more than one (ambiguous) — the same "found exactly
 * once" rule as a single line, generalized to a run of several: a line that
 * is not unique on its own (a bare `}`, a blank separator) can still be
 * placed confidently once its NEIGHBORS are folded into the same match,
 * because the run's combined text is far rarer than any one line of it.
 */
function uniqueBlockOutsideServed(
  fileLines: readonly string[],
  served: ReadonlySet<number>,
  block: readonly string[],
): number | undefined {
  const len = block.length;
  let found: number | undefined;
  for (let i = 0; i + len <= fileLines.length; i++) {
    const fileStart = i + 1;
    let matches = true;
    for (let k = 0; k < len; k++) {
      if (served.has(fileStart + k) || fileLines[i + k] !== block[k]) { matches = false; break; }
    }
    if (!matches) continue;
    if (found !== undefined) return undefined;
    found = fileStart;
  }
  return found;
}

/**
 * Places every line of `extraLines` — the raw context a composite body
 * appends after its window — with its true source line, greedily preferring
 * the LONGEST contiguous run starting at each unplaced position that
 * matches a UNIQUE contiguous block of `fileLines` outside `served`
 * (`uniqueBlockOutsideServed`). A run of length 1 is the plain single-line
 * uniqueness rule; a longer run can place lines that are not unique alone
 * (a bare `}`, a blank separator) because the BLOCK they sit in is. A line
 * that participates in no unique block at any length — a synthetic marker
 * comment naming a query facet, an isolated blank separator with no
 * confirmable neighbor — is left unplaced (undefined); the caller renders
 * that as `~|`, never a guess.
 */
function placeAppendedLines(
  extraLines: readonly string[],
  fileLines: readonly string[],
  served: ReadonlySet<number>,
): Array<number | undefined> {
  const placements: Array<number | undefined> = new Array(extraLines.length).fill(undefined);
  let i = 0;
  while (i < extraLines.length) {
    let placedLen = 0;
    for (let len = extraLines.length - i; len >= 1; len--) {
      const start = uniqueBlockOutsideServed(fileLines, served, extraLines.slice(i, i + len));
      if (start !== undefined) {
        for (let k = 0; k < len; k++) placements[i + k] = start + k;
        placedLen = len;
        break;
      }
    }
    i += placedLen > 0 ? placedLen : 1;
  }
  return placements;
}

/** A numbering result plus how many of its lines carry a TRUE source number, for `bestNumbering` to compare candidates by. */
interface NumberedBody {
  readonly lines: readonly string[];
  readonly numberedCount: number;
}

/**
 * WP-G1 (2026-09-20, follow-up): numbers `bodyLines` against ONE candidate
 * `rendered` spans-rendering — the body is `rendered`'s own rendering (A),
 * or that rendering followed by N >= 1 raw, verbatim OUT-OF-RANGE context
 * lines (B) — `materializeExplicitAnswerAnchorEvidence` (readCodeTaskPack.ts)
 * appends exactly one such line per still-missing explicit identifier,
 * joined to whatever came before with a plain "\n", never a separator
 * marker (a `buildAnswerTaskPack` "query-focused member" excerpt appends a
 * whole run the same way, plus its own synthetic marker/blank lines).
 *
 * (A) is tried first via `numberPrefixMatch`: covers both an exact match and
 * a whole-line-prefix cut, with no composite lines involved — always fully
 * numbered (`numberedCount = bodyLines.length`) when it succeeds.
 *
 * (B) is whatever is left once (A) fails: the longest common prefix between
 * `bodyLines` and `rendered.lines` is the CANDIDATE window part, regardless
 * of which one is longer (a composite is not necessarily longer than the
 * full window rendering: the window itself may ALSO have been byte-cut
 * short before the append ran — "prefix-cut composite"). This is only a
 * CANDIDATE when the prefix covers at least one line and stops before
 * `bodyLines` ends (otherwise `bodyLines` was a whole-line prefix, which (A)
 * already handles).
 *
 * A candidate is accepted only with independent corroboration, per ruling
 * (aa) (never guess): either the prefix covers the ENTIRE rendering (a full
 * window match essentially never happens by coincidence for unrelated
 * content), or `placeAppendedLines` confirms at least one leftover line.
 * Without EITHER, this function returns undefined (the caller's "this
 * candidate has no support at all").
 *
 * A SECOND, caller-visible guard applies even once accepted: `bestNumbering`
 * rejects any candidate whose `~|`-prefixed lines OUTNUMBER its truly
 * numbered ones (a mostly-un-numbered body is noise, not a partial win), by
 * comparing `numberedCount` against `lines.length - numberedCount` there —
 * kept out of this function so it stays a pure "number THIS candidate"
 * step, with the accept/reject-the-whole-candidate policy in one place.
 */
function attemptNumbering(
  bodyLines: readonly string[],
  rendered: { lines: readonly string[]; sourceLines: readonly number[] },
  spans: readonly LineSpan[],
  fileText: string,
): NumberedBody | undefined {
  const clean = numberPrefixMatch(bodyLines, rendered);
  if (clean !== undefined) return { lines: clean, numberedCount: clean.length };

  const maxCompare = Math.min(bodyLines.length, rendered.lines.length);
  let prefixLen = 0;
  while (prefixLen < maxCompare && bodyLines[prefixLen] === rendered.lines[prefixLen]) prefixLen++;
  if (prefixLen === 0 || prefixLen >= bodyLines.length) return undefined;

  const fullWindowMatched = prefixLen === rendered.lines.length;
  const extraLines = bodyLines.slice(prefixLen);
  // `splitLines`, not a raw `.split("\n")`: a file ending in "\n" otherwise
  // leaves one bogus trailing empty-string "line" past the real end of the
  // file, at a line NUMBER just outside any span — a genuinely blank extra
  // line (a real blank line the served spans already cover) would then
  // spuriously "match" that phantom line as if it were unique content
  // outside the served window.
  const fileLines = splitLines(fileText);
  // A FULL window match is strong corroboration on its own (byte-equal to
  // the ENTIRE spans rendering essentially never happens by coincidence for
  // unrelated content), so an appended line MAY be placed at its true
  // position even when that position falls INSIDE the already-served
  // spans — exactly the shape a known producer defect creates (an excerpt
  // loop appends a verbatim re-run of a member the primary body, byte-equal
  // in full, already contains whole). A merely PARTIAL prefix match is a
  // much weaker signal (see this function's own doc comment on a
  // "comments kept" accidental prefix), so that shape still requires its
  // corroboration to come from OUTSIDE every served span — a match INSIDE
  // would only prove the coincidence, never rule it out.
  const excluded = fullWindowMatched ? new Set<number>() : servedLineNumbers(spans);
  const placements = placeAppendedLines(extraLines, fileLines, excluded);
  const placedCount = placements.filter((p) => p !== undefined).length;

  if (!fullWindowMatched && placedCount === 0) return undefined;

  const numberedWindow = bodyLines
    .slice(0, prefixLen)
    .map((line, i) => `${rendered.sourceLines[i]}|${line}`);
  const numberedExtra = extraLines.map((line, i) => {
    const sourceLine = placements[i];
    return sourceLine !== undefined ? `${sourceLine}|${line}` : `~|${line}`;
  });

  return { lines: [...numberedWindow, ...numberedExtra], numberedCount: prefixLen + placedCount };
}

/**
 * WP-G1 (2026-09-20, follow-up): tries every candidate spans-rendering in
 * `candidates` — in the ORDER given — via `attemptNumbering`, and returns
 * the one giving TRUE numbers to the MOST body lines. A candidate that
 * `attemptNumbering` rejects, or whose result would leave more lines `~|`
 * than truly numbered (a mostly-un-numbered body is noise, never applied —
 * the caller's answer to "no confident interpretation" is to leave the body
 * untouched), never competes. A STRICTLY greater `numberedCount` is required
 * to unseat an earlier candidate, so ties (and "only the first candidate
 * produced anything at all") favor whichever was tried first — the caller
 * puts the field's OWN claimed `range` first for exactly this reason: a
 * `remaining` claim is a hint from the producer, never an authority, and
 * must never demote a body that matches the plain, un-cut rendering.
 */
function bestNumbering(
  bodyLines: readonly string[],
  fileText: string,
  lang: string | undefined,
  candidates: readonly (readonly LineSpan[])[],
): NumberedBody | undefined {
  let best: NumberedBody | undefined;
  for (const spans of candidates) {
    if (spans.length === 0) continue;
    const rendered = renderSpans(fileText, spans, lang);
    if (rendered === undefined) continue;
    const attempt = attemptNumbering(bodyLines, rendered, spans, fileText);
    if (attempt === undefined) continue;
    const tildeCount = attempt.lines.length - attempt.numberedCount;
    if (tildeCount >= attempt.numberedCount) continue; // guard (2): never mostly noise
    if (best === undefined || attempt.numberedCount > best.numberedCount) best = attempt;
  }
  return best;
}

/**
 * Numbers `entry[field]` in place when every precondition holds: `entry`
 * carries a non-empty `path`+`range`, the path is CODE-eligible, and the
 * file can be read from the workspace `readCached` closes over. The served
 * text is checked against TWO candidate spans-renderings via `bestNumbering`
 * — the field's own claimed `range` taken WHOLE (no cut at all), then
 * `range` minus every IN-RANGE `remaining`/`remaining_ranges` window
 * (`inRangeHoles`) when that yields a consistent, non-empty set of spans —
 * and whichever gives TRUE numbers to the most lines wins. This is
 * deliberate, not an oversight: `remaining` is a HINT from the producer
 * about where a cut MIGHT be, never an authority on what the served bytes
 * actually are. A known producer defect (`buildAnswerTaskPack`'s
 * "query-focused member" excerpt loop, readCodeTaskPack.ts) can merge a
 * claimed hole into a primary surface whose body already contains the whole
 * member uncut, and trusting that claim unconditionally used to number far
 * FEWER lines than simply trying the plain, whole-`range` rendering first
 * would have. Any failure at any step — including neither candidate
 * verifying, per `bestNumbering`'s own soundness and anti-noise guards —
 * leaves `entry` untouched. This function never throws and never guesses.
 */
function numberEntryFieldInPlace(
  entry: unknown,
  field: "body" | "content",
  readCached: (relPath: string) => string | undefined,
): void {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return;
  const record = entry as WireBody;
  const path = record["path"];
  const range = record["range"];
  const text = record[field];
  if (!isNonEmptyString(path) || !isNonEmptyString(range) || !isNonEmptyString(text)) return;
  if (!isGutterEligiblePath(path)) return;

  const bounds = parseLineRange(range);
  if (bounds === undefined) return;

  const fileText = readCached(path);
  if (fileText === undefined) return;

  const lang = languageForPath(path);
  const bodyLines = splitLines(text);

  const candidates: LineSpan[][] = [[[bounds.start, bounds.end]]];
  // Evidence items (`read.task_pack`/`read.text`) name their unserved
  // windows `remaining`; batch entries (`read.batch`) name the same concept
  // `remaining_ranges` (types/src/mcp/protocol.ts vs. read-result.ts).
  const remaining = record[field === "content" ? "remaining_ranges" : "remaining"];
  const holes = inRangeHoles(bounds.start, bounds.end, remaining);
  if (holes !== undefined && holes.length > 0) {
    candidates.push(spansExcludingWindows(bounds.start, bounds.end, holes));
  }

  const best = bestNumbering(bodyLines, fileText, lang, candidates);
  if (best === undefined) return;

  const numbered = best.lines.join("\n");
  record[field] = text.endsWith("\n") ? `${numbered}\n` : numbered;
}

/**
 * The subset of `ProtocolCallContext` (protocol/envelope.ts) this module
 * needs. `workspace` is populated by the EDIT dispatcher only (see
 * `finalizeProtocolResponse`'s own `resolvedWorkspace = context.workspace ??
 * context.codecTraceWorkspace` fallback, and the read-family branch's
 * neighboring comment: "`codecTraceWorkspace` ... is the only workspace root
 * this funnel has for a read/search call"), so a read_file call's resolved
 * root -- confirmed empirically: `read.task_pack`/`read.text`/`read.batch`
 * all carry `context.workspace === undefined` and the REAL realpath'd root in
 * `codecTraceWorkspace` -- is reached only through the second field. Mirrors
 * that exact fallback rather than reading `context.args.cwd` (the caller's
 * own unvalidated string) so this module trusts the SAME resolved identity
 * every other workspace-scoped consumer in this funnel does.
 */
interface AnswerLineGutterContext {
  readonly workspace?: string;
  readonly codecTraceWorkspace?: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/**
 * True iff THIS call's own arguments declare an answer-profile task — the
 * normalized internal `taskProfile` field server.ts's dispatcher sets from
 * the wire's `task.profile`, whether the caller wrote it directly on this
 * call or `inheritDeclaredTaskProfile` (server.ts) carried it over from a
 * query/qref this same call resolved. Never inferred from a bare
 * `task.handle` with neither: that shape is out of this module's reach (see
 * util/flags.ts's `answerLineGutterEnabled` doc block and this work
 * package's own final report for the exact seam a handle-only lookup would
 * need).
 */
function isDeclaredAnswerProfile(context: AnswerLineGutterContext | undefined): boolean {
  return context?.args?.["taskProfile"] === ANSWER_PROFILE;
}

/**
 * WP-V1 (2026-09-20): true iff THIS call's own arguments declare a task
 * profile at all — answer or generic. The lane-sticky fallback below must
 * only fill in for a call that declares NONE (a leaned continuation; see
 * util/flags.ts's `leanCallsEnabled`), never override an explicit
 * declaration either direction.
 */
function hasDeclaredTaskProfile(context: AnswerLineGutterContext | undefined): boolean {
  return context?.args?.["taskProfile"] !== undefined;
}

/** The `lane` this call's own (possibly absent) arguments declared — the same empty-string default `state/laneTaskHandles.ts`'s registry keys on. */
function laneOf(context: AnswerLineGutterContext | undefined): string {
  const lane = context?.args?.["lane"];
  return typeof lane === "string" ? lane : "";
}

/**
 * WP-V1 (2026-09-20, replay-forensics follow-up): true iff THIS call's own
 * arguments carry a (non-empty) `query` — a fresh investigation, which must
 * bind whatever profile it resolves to and never inherit the lane's prior
 * one, even when it declares no explicit `task.profile` of its own.
 */
function hasQuery(context: AnswerLineGutterContext | undefined): boolean {
  const query = context?.args?.["query"];
  return typeof query === "string" && query !== "";
}

/**
 * WP-V1 (2026-09-20, replay-forensics follow-up): true iff `payload`'s own
 * `decision.kind` is `"act.edit"`. An edit-directed pack must stay
 * copy-exact for `edit_file`'s search/replace matching — the same reasoning
 * `applyAnswerLineGutter` below already applies to an explicit generic
 * profile — so the lane-inherited fallback must never number one, even when
 * its OWN resolved `profile` happens to be the inferred "generic" this
 * fallback otherwise targets.
 */
function isActEditDecision(payload: WireBody): boolean {
  const decision = payload["decision"];
  if (decision === null || typeof decision !== "object" || Array.isArray(decision)) return false;
  return (decision as Record<string, unknown>)["kind"] === "act.edit";
}

/**
 * The ONE seam: call from `protocol/envelope.ts`'s `finalizeProtocolResponse`,
 * after every ledger/certificate/dedupe consumer has already looked at
 * `payload` and immediately before `emit.ts`'s `emitFinalizedPayload`
 * measures it for the wire budget. Mutates eligible evidence bodies IN PLACE
 * and returns the SAME `payload` reference — see this file's own top-of-file
 * comment for why cloning would be unsafe here.
 *
 * No-op (returns `payload` untouched, no read, no allocation beyond the
 * empty cache) unless: the flag is on, `kind` is one of the three
 * read-family members that carry evidence bodies, a workspace root is known,
 * and the call is bound to an ANSWER profile.
 */
export function applyAnswerLineGutter(
  payload: WireBody,
  kind: Kind,
  context: AnswerLineGutterContext | undefined,
): WireBody {
  if (!answerLineGutterEnabled()) return payload;
  if (kind !== "read.task_pack" && kind !== "read.text" && kind !== "read.batch") return payload;

  const workspace = context?.workspace ?? context?.codecTraceWorkspace;
  if (!isNonEmptyString(workspace)) return payload;

  const lane = laneOf(context);

  // `read.task_pack` carries its own resolved `profile`; `read.text`/
  // `read.batch` have no such field, so the signal is either this call's own
  // (possibly inherited) declared args, or — only when this call declares NO
  // task profile at all AND carries no fresh `query` (a leaned continuation,
  // see util/flags.ts's `leanCallsEnabled`; OR a query-less multi-target
  // ranged read that server.ts's dispatcher promotes to `read.task_pack`
  // with an INFERRED "generic" profile, replay-forensics follow-up 2026-
  // 09-20) — the lane's own most recent PRIOR task pack profile. Read
  // BEFORE this call's own profile is recorded below: a promoted-generic
  // pack's own profile would otherwise overwrite the lane's prior "answer"
  // state before this fallback ever gets to consult it, permanently and
  // wrongly resetting the very state it needs to inherit from. Never
  // overrides an EXPLICIT declaration or a fresh query either way, and
  // never numbers an edit-directed pack (`isActEditDecision`) even when
  // this fallback would otherwise apply.
  const inheritsLaneAnswer = !hasDeclaredTaskProfile(context)
    && !hasQuery(context)
    && !isActEditDecision(payload)
    && laneTaskProfile(workspace, lane) === ANSWER_PROFILE;
  const isAnswer = kind === "read.task_pack"
    ? payload["profile"] === ANSWER_PROFILE || inheritsLaneAnswer
    : isDeclaredAnswerProfile(context) || inheritsLaneAnswer;

  // WP-V1 (2026-09-20): every read.task_pack response — answer or generic —
  // updates the lane's most-recently-seen profile AFTER the read above, so a
  // LATER generic/change pack in the same lane turns a prior sticky answer
  // state back off starting with the NEXT call, without erasing the state
  // THIS call itself needed to consult.
  if (kind === "read.task_pack" && isNonEmptyString(payload["profile"])) {
    recordLaneTaskProfile(workspace, lane, payload["profile"]);
  }

  if (!isAnswer) return payload;

  const field: "body" | "content" = kind === "read.batch" ? "content" : "body";
  const list = payload[kind === "read.batch" ? "entries" : "evidence"];
  if (!Array.isArray(list)) return payload;

  const fileCache = new Map<string, string | undefined>();
  const readCached = (relPath: string): string | undefined => {
    if (!fileCache.has(relPath)) fileCache.set(relPath, readWorkspaceFileSync(relPath, workspace));
    return fileCache.get(relPath);
  };

  for (const entry of list) {
    numberEntryFieldInPlace(entry, field, readCached);
  }
  return payload;
}

/**
 * Removes this module's `<source line>|` gutter — or, WP-G1 (2026-09-20), a
 * composite body's un-placeable-context `~|` marker — from every line of
 * `text`, when present. Exported for evaluation/test code that must compare
 * a served body's CONTENT independently of whether the gutter flag happened
 * to be on for that call (e.g. firstPackPrecisionEval.spec.ts) — never
 * called by the production response pipeline itself, which numbers or does
 * not per `answerLineGutterEnabled()` and never needs to undo its own output.
 */
export function stripAnswerLineGutter(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(?:\d+|~)\|/, ""))
    .join("\n");
}
