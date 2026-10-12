// ---------------------------------------------------------------------------
// TL-REVIEW-2 (2026-10-06 independent runtime review of v0.15.1) —
// SOURCE-FAITHFUL EVIDENCE BODIES.
//
// THE DEFECT. Under the default comment policy (`select.comments:"elide"`)
// every read producer renders its window through `elideDocCommentsWithWindows`
// (util/formatCompress.ts), which replaces each multi-line comment block /
// docstring by ONE marker line (`/* doc elided L28-37 */`), and several also
// run `compressFormat` (blank-line runs collapsed, trailing whitespace
// stripped). That DISPLAY text then reached the wire as `evidence[].body`
// (and `read.batch` `entries[].content`) under a `range` in SOURCE
// coordinates — so body line 29 was source line 38. Worse, where no range was
// declared (`content:"full"`, `small_file`) the projector derived one from the
// DISPLAY line count (`1-109` for a 136-line file), and the read-request
// continuation then compared that against the source-coordinate ledger and
// invented `remaining:["110-111"]` plus a cursor that re-served the tail of a
// comment block. The task-pack projector shipped the same shape
// (`range:"2-13"` over a 6-line body).
//
// THE CONTRACT THIS MODULE ENFORCES. For `read.text`, `read.task_pack` and
// `read.batch`, every shipped body is the source's own contiguous line range:
//
//     body.split("\n") === sourceLines[lo-1 .. hi-1]   for range "lo-hi"
//
// A rendering that elided comment blocks is therefore SPLIT into several
// faithful entries on the same handle — exactly the per-window shape the
// protocol already carries for multi-window serves (`segments[]` -> one
// `Evidence` per window) — and the elided windows are DISCLOSED on the first
// resulting entry in one compact optional field, `elided: ["28-37", …]`
// (packages/types: `Evidence.elided`, `BatchEntry.elided`). Not `remaining`:
// `remaining` means "unserved and owed — fetch it", it feeds the read-request
// remainder D, the act floor and every continuation, and a policy-elided
// comment block is none of those. Not prose: a `note` is shed first by the
// budget ladder and cannot be settled against.
//
// WHY A SEAM AND NOT N PRODUCERS. The display text is minted at ~30 producer
// sites (server.ts's full/head/auto/slice/handles/paths/symbol serves,
// readCodeSmallFile.ts, readCodeModes.ts and dozens of task-pack builders),
// with three marker-numbering conventions (file-absolute, slice-relative, and
// relative to an assembled symbol view) and two `compressFormat` orders. Every
// one of them already books the served-range ledger in SOURCE coordinates
// (`spansExcludingWindows` over the renderer's own `elided` windows, ruling
// (aa)); only the wire projection lost the coordinates. So the fix lives at
// the projection: one function, run by `protocol/envelope.ts`'s
// `projectSuccessBody` immediately after the read-family projector and BEFORE
// the certificate binding, the answer-line gutter and `emit.ts` — so the
// budget ladder, the wire `limit`/`next` derivation, the read-request settle
// (`readRequestContinuation.ts`) and the served-range settlement all operate
// on faithful entries in source coordinates.
//
// SOUNDNESS (ruling (aa): elided windows are a fact of the RENDERER, never
// re-derived by parsing marker-shaped text). This module never trusts a body.
// It re-reads the evidence's own file (resolved through the handle table, the
// same root the producer served from), re-runs the SAME renderer over the
// candidate source window, and accepts a body only when it is byte-equal —
// line by line — to that rendering (or to its `compressFormat` image, or a
// whole-line prefix of either). Marker lines are matched only at the exact
// display positions where the renderer itself collapsed a block, and only when
// their width equals that block's width (which tolerates the slice-relative
// numbering some producers use, never a forged literal elsewhere). Only then
// are the renderer's own windows used: the shipped body becomes the source
// lines the rendering covered, and the windows become `elided`. Anything that
// does not verify — a synthetic outline, a skeleton, a NUL-stripped serve, a
// file that changed between the serve and this projection — is left exactly
// as the producer built it. This function never throws and never guesses.
//
// ASSEMBLED SYMBOL VIEWS. Verify their target against its declared source
// window, then put only that source in the body. The synthetic scope header,
// imports and sibling signatures remain supplementary metadata in `note`.
// They never acquire the target's source coordinates or edit authority.
//
// THE DOC-ONLY FALLBACK. A rendering that would leave a window with no source
// line at all (every line inside elided blocks) is served RAW, comments kept —
// the same rule `elideDocCommentsForDisplay` applies to a doc-only file.
// ---------------------------------------------------------------------------

import { statSync } from "node:fs";

import type { Kind } from "@tokenlighten/types";

import { elideDocCommentsWithWindows } from "../util/formatCompress.js";
import { handleTable } from "../util/handles.js";
import { languageForPath } from "../util/languages.js";
import { READ_PATH_MAX_BYTES, safeResolve } from "../util/safePath.js";
import { isTokenlightenSentinelLine } from "../util/sentinelComment.js";
import { servedTextOrUndefined } from "../util/textDecode.js";

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** A 1-based inclusive `[start, end]` source line window. */
type Window = [number, number];

/** The source of one file, as LOGICAL lines (CRLF folded, no phantom trailing element). */
interface SourceText {
  readonly lines: readonly string[];
  readonly lang: string | undefined;
}

/** `"12-48"` -> `[12, 48]`; anything else -> `undefined`. */
function parseRange(range: unknown): Window | undefined {
  if (typeof range !== "string") return undefined;
  const match = /^(\d+)-(\d+)$/.exec(range);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return undefined;
  return [start, end];
}

function windowString(window: Window): string {
  return `${window[0]}-${window[1]}`;
}

/** Body text -> logical lines (a single trailing newline is not a line; CR before LF dropped). */
function bodyLinesOf(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = text.endsWith("\n");
  const core = trailingNewline ? text.slice(0, -1) : text;
  return { lines: core.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)), trailingNewline };
}

// ---------------------------------------------------------------------------
// The display model — a rendering of one source window, line by line, with
// the source lines each output line stands for.
// ---------------------------------------------------------------------------

interface DisplayLine {
  /** The output line exactly as the renderer (and optionally compressFormat) emits it. */
  text: string;
  /** Source lines this output line ships verbatim (several after a blank-run collapse). */
  covers: number[];
  /** Set iff this output line is the renderer's marker for this collapsed window. */
  elided?: Window;
}

/**
 * Render source lines `[start, end]` with the production renderer and map
 * every output line back to the source line(s) it stands for, using ONLY the
 * renderer's own `elided` windows (each window is exactly one output line —
 * `emitMultiLineBlock`'s invariant). `undefined` if the walk does not close
 * exactly, which can only mean the renderer broke that invariant.
 */
function renderModel(source: SourceText, start: number, end: number): DisplayLine[] | undefined {
  if (start < 1 || end > source.lines.length || end < start) return undefined;
  const slice = source.lines.slice(start - 1, end).join("\n");
  const rendered = elideDocCommentsWithWindows(slice, source.lang, start);
  const model: DisplayLine[] = [];
  let line = start;
  let next = 0;
  for (const text of rendered.text.split("\n")) {
    const window = rendered.elided[next];
    if (window !== undefined && window[0] === line) {
      model.push({ text, covers: [], elided: [window[0], window[1]] });
      line = window[1] + 1;
      next += 1;
    } else {
      model.push({ text, covers: [line] });
      line += 1;
    }
  }
  if (line !== end + 1 || next !== rendered.elided.length) return undefined;
  return model;
}

/**
 * The same model after `compressFormat` (util/formatCompress.ts): trailing
 * whitespace stripped from every line, and a blank line that follows another
 * blank line folded into it. A folded blank line's source line is still
 * COVERED — the producer shipped the run collapsed, and the faithful body
 * restores it from the source.
 */
function compressModel(model: readonly DisplayLine[]): DisplayLine[] {
  const out: DisplayLine[] = [];
  let previousBlank = false;
  for (const line of model) {
    const text = line.text.trimEnd();
    const blank = text.length === 0;
    if (blank && previousBlank && line.elided === undefined) {
      out[out.length - 1]!.covers.push(...line.covers);
      continue;
    }
    out.push({ text, covers: [...line.covers], ...(line.elided !== undefined ? { elided: line.elided } : {}) });
    previousBlank = blank;
  }
  return out;
}

const MARKER_LINE_RE = /^(\s*)(?:\/\* doc elided L(\d+)-(\d+) \*\/|#\s?doc elided L(\d+)-(\d+))$/;

/**
 * A body line equals a marker the renderer emitted at THIS position, up to
 * the marker's numbering convention: same indentation, same comment style,
 * same width. Some producers render with file-absolute line numbers, some
 * slice- or view-relative (`elideDocComments(code, lang)` with the default
 * start line 1); the WIDTH is the count of lines the marker replaced in the
 * text that was rendered either way — compared with the display marker's own
 * width, which is that same count — and the position is fixed by the
 * renderer's own walk.
 */
function markerEquivalent(bodyLine: string, displayLine: string): boolean {
  const body = MARKER_LINE_RE.exec(bodyLine);
  const display = MARKER_LINE_RE.exec(displayLine);
  if (body === null || display === null) return false;
  if (body[1] !== display[1]) return false;
  const bodyIsC = body[2] !== undefined;
  const displayIsC = display[2] !== undefined;
  if (bodyIsC !== displayIsC) return false;
  const width = (match: RegExpExecArray): number => Number(match[3] ?? match[5]) - Number(match[2] ?? match[4]);
  return width(body) === width(display);
}

/** How many leading display lines `bodyLines` matches, iff it matches a whole-line prefix of `model`. */
function matchPrefix(bodyLines: readonly string[], model: readonly DisplayLine[]): number | undefined {
  if (bodyLines.length === 0 || bodyLines.length > model.length) return undefined;
  for (let index = 0; index < bodyLines.length; index += 1) {
    const body = bodyLines[index]!;
    const display = model[index]!;
    if (body === display.text) continue;
    if (display.elided !== undefined && markerEquivalent(body, display.text)) continue;
    return undefined;
  }
  return bodyLines.length;
}

/** What one verified body shipped, in source coordinates. */
interface Verified {
  /** Source lines the body shipped (verbatim or collapsed), ascending. */
  covered: number[];
  /** Renderer windows the body replaced by a marker, ascending. */
  elided: Window[];
  /** True iff the body is a strict whole-line prefix of the candidate rendering. */
  prefix: boolean;
}

function verifiedFrom(model: readonly DisplayLine[], matched: number): Verified {
  const covered: number[] = [];
  const elided: Window[] = [];
  for (let index = 0; index < matched; index += 1) {
    const line = model[index]!;
    covered.push(...line.covers);
    if (line.elided !== undefined) elided.push(line.elided);
  }
  // compressFormat folds a run of trailing blank lines into the final newline:
  // a body that stops right before nothing but blank, marker-free display lines
  // shipped them. Restoring blank lines from the source never invents content.
  const rest = model.slice(matched);
  const prefix = rest.length > 0 && !rest.every((line) => line.elided === undefined && line.text.trim() === "");
  if (!prefix) for (const line of rest) covered.push(...line.covers);
  covered.sort((a, b) => a - b);
  return { covered, elided, prefix };
}

/** Try one candidate rendering (raw, then its compressFormat image). */
function verifyAgainst(bodyLines: readonly string[], model: readonly DisplayLine[] | undefined): Verified | undefined {
  if (model === undefined) return undefined;
  const raw = matchPrefix(bodyLines, model);
  if (raw !== undefined) return verifiedFrom(model, raw);
  const compressed = compressModel(model);
  const folded = matchPrefix(bodyLines, compressed);
  if (folded !== undefined) return verifiedFrom(compressed, folded);
  return undefined;
}

/**
 * The OTHER order: `compressFormat` first, then the renderer — exactly what a
 * symbol serve does (`getSymbolWithContext.ts` compresses the assembled code,
 * `server.ts` elides it). The two orders differ only where a blank-line run
 * sits inside a comment block (the block shrinks before it is collapsed), so
 * this is a fallback, tried after `verifyAgainst`. Windows are still the
 * renderer's own — computed over the compressed text and mapped back to
 * source lines through the compression's own line map.
 */
function compressFirstModel(source: SourceText, start: number, end: number): DisplayLine[] | undefined {
  if (start < 1 || end > source.lines.length || end < start) return undefined;
  const lines: string[] = [];
  const covers: number[][] = [];
  let previousBlank = false;
  for (let line = start; line <= end; line += 1) {
    const text = source.lines[line - 1]!.trimEnd();
    const blank = text.length === 0;
    if (blank && previousBlank) {
      covers[covers.length - 1]!.push(line);
      continue;
    }
    lines.push(text);
    covers.push([line]);
    previousBlank = blank;
  }
  const rendered = elideDocCommentsWithWindows(lines.join("\n"), source.lang, 1);
  const model: DisplayLine[] = [];
  let at = 1;
  let next = 0;
  for (const text of rendered.text.split("\n")) {
    const window = rendered.elided[next];
    if (window !== undefined && window[0] === at) {
      const first = covers[window[0] - 1]?.[0];
      const lastCover = covers[window[1] - 1];
      const last = lastCover?.[lastCover.length - 1];
      if (first === undefined || last === undefined) return undefined;
      model.push({ text, covers: [], elided: [first, last] });
      at = window[1] + 1;
      next += 1;
    } else {
      const cover = covers[at - 1];
      if (cover === undefined) return undefined;
      model.push({ text, covers: [...cover] });
      at += 1;
    }
  }
  if (at !== lines.length + 1 || next !== rendered.elided.length) return undefined;
  return model;
}

/** Every rendering a producer may have shipped for `[start, end]`, first match wins. */
function verifyWindow(bodyLines: readonly string[], source: SourceText, start: number, end: number): Verified | undefined {
  return verifyAgainst(bodyLines, renderModel(source, start, end))
    ?? verifyCompressFirst(bodyLines, compressFirstModel(source, start, end));
}

function verifyCompressFirst(bodyLines: readonly string[], model: readonly DisplayLine[] | undefined): Verified | undefined {
  if (model === undefined) return undefined;
  const matched = matchPrefix(bodyLines, model);
  return matched === undefined ? undefined : verifiedFrom(model, matched);
}

/** `[start, end]` minus every hole, rendered span by span and concatenated. */
function multiSpanModel(source: SourceText, start: number, end: number, holes: readonly Window[]): DisplayLine[] | undefined {
  const model: DisplayLine[] = [];
  let cursor = start;
  const spans: Window[] = [];
  for (const [holeStart, holeEnd] of holes) {
    if (holeStart > cursor) spans.push([cursor, holeStart - 1]);
    cursor = Math.max(cursor, holeEnd + 1);
  }
  if (cursor <= end) spans.push([cursor, end]);
  if (spans.length < 2) return undefined;
  for (const [spanStart, spanEnd] of spans) {
    const part = renderModel(source, spanStart, spanEnd);
    if (part === undefined) return undefined;
    model.push(...part);
  }
  return model;
}

/** In-range `remaining` holes, ascending and disjoint, or `[]`. */
function inRangeHoles(start: number, end: number, remaining: unknown): Window[] {
  if (!Array.isArray(remaining)) return [];
  const holes: Window[] = [];
  for (const raw of remaining) {
    const window = parseRange(raw);
    if (window === undefined) return [];
    if (window[0] >= start && window[1] <= end) holes.push(window);
  }
  holes.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < holes.length; index += 1) {
    if (holes[index - 1]![1] >= holes[index]![0]) return [];
  }
  return holes;
}

/** The rebuilt form of one body: faithful windows plus the disclosed elided windows. */
interface Rebuild {
  segments: Window[];
  elided: Window[];
  /** Source window the body's own claim covered but did not ship (a prefix serve). */
  undelivered?: Window;
}

/** Group sorted source lines into maximal consecutive runs. */
function runsOf(lines: readonly number[]): Window[] {
  const runs: Window[] = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    if (last !== undefined && line === last[1] + 1) last[1] = line;
    else if (last === undefined || line > last[1]) runs.push([line, line]);
  }
  return runs;
}

/**
 * Decide what `bodyText`, served for `[start, end?]` of `source`, really is.
 *
 * `undefined` = leave the entry exactly as it is: already faithful, or not a
 * rendering this module can verify. Candidates, first match wins:
 *   1. the declared window `[start, end]`;
 *   2. the declared window minus its in-range `remaining` holes (a producer
 *      that shed lines out of the middle, `lineGutter.ts`'s WP-G1 shape);
 *   3. `[start, EOF]` — the window a whole-file serve (`content:"full"`,
 *      `small_file`, auto) really rendered when no range was declared and the
 *      projector derived one from the DISPLAY line count.
 */
function rebuildPlan(
  source: SourceText,
  bodyText: string,
  start: number,
  end: number | undefined,
  remaining: unknown,
): Rebuild | undefined {
  const { lines: bodyLines } = bodyLinesOf(bodyText);
  if (bodyLines.length === 0 || start > source.lines.length) return undefined;

  const eof = source.lines.length;
  const declaredEnd = end !== undefined ? Math.min(end, eof) : undefined;

  if (declaredEnd !== undefined && declaredEnd >= start) {
    // Exactly the canonical faithful body for the declared window: nothing to do.
    if (bodyText === faithfulBody(source.lines, [start, declaredEnd], bodyText.endsWith("\n"))) return undefined;
    // Verbatim lines joined as SEPARATORS (`lines.join("\n")`) — every slice
    // producer's spelling. Faithful already, EXCEPT when the window's last line
    // is blank: `"a\n"` then reads as ONE line to every terminator-semantics
    // reader (TL's own `lineCount`, the budget shedders, Python's
    // `splitlines()` the reviewer's oracle uses) although `range` says two.
    // Normalized to the canonical spelling, which those readers all agree on.
    const separatorLines = bodyText.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    const window = source.lines.slice(start - 1, declaredEnd);
    if (separatorLines.length === window.length && window.every((line, index) => line === separatorLines[index])) {
      return { segments: [[start, declaredEnd]], elided: [] };
    }
  }

  // Already faithful over a PREFIX of the window: nothing to do (an
  // under-length body is the budget pipeline's own disclosed shed).
  const raw = source.lines.slice(start - 1, start - 1 + bodyLines.length);
  if (raw.length === bodyLines.length && raw.every((line, index) => line === bodyLines[index])) return undefined;

  // Cheap gate before any rendering: every rendering of `[start, …]` opens
  // with source line `start` itself (trailing whitespace possibly stripped by
  // compressFormat) or with the marker of a block that opens there. Anything
  // else — an outline, a skeleton, a synthetic preview — is left alone without
  // rendering the file.
  const head = bodyLines[0]!;
  const firstSource = source.lines[start - 1]!;
  if (head !== firstSource && head !== firstSource.trimEnd() && !MARKER_LINE_RE.test(head)) return undefined;

  let verified: Verified | undefined;
  let candidate: "declared" | "holes" | "eof" | undefined;
  if (declaredEnd !== undefined && declaredEnd >= start) {
    verified = verifyWindow(bodyLines, source, start, declaredEnd);
    if (verified !== undefined) candidate = "declared";
    if (verified === undefined) {
      const holes = inRangeHoles(start, declaredEnd, remaining);
      if (holes.length > 0) {
        verified = verifyAgainst(bodyLines, multiSpanModel(source, start, declaredEnd, holes));
        if (verified !== undefined) candidate = "holes";
      }
    }
  }
  if (verified === undefined && declaredEnd !== eof) {
    verified = verifyWindow(bodyLines, source, start, eof);
    if (verified !== undefined) candidate = "eof";
  }
  if (verified === undefined || candidate === undefined) return undefined;

  let segments = runsOf(verified.covered);
  let elided = verified.elided;
  const extentEnd = Math.max(
    segments.length > 0 ? segments[segments.length - 1]![1] : 0,
    elided.length > 0 ? elided[elided.length - 1]![1] : 0,
  );
  if (segments.length === 0) {
    // Every line of the window sits inside elided blocks: serve it RAW, the
    // doc-only rule (`elideDocCommentsForDisplay`), never an empty entry.
    segments = [[start, Math.max(start, extentEnd)]];
    elided = [];
  }
  const rebuild: Rebuild = { segments, elided };
  // A strict-prefix serve of a DECLARED window claimed lines it did not ship.
  if (candidate === "declared" && verified.prefix && declaredEnd !== undefined && extentEnd < declaredEnd) {
    rebuild.undelivered = [extentEnd + 1, declaredEnd];
  }
  return rebuild;
}

// ---------------------------------------------------------------------------
// Assembled symbol scope views (getSymbolWithContext.ts) — labelled synthetic
// renderings whose TARGET part is made verbatim, never split.
// ---------------------------------------------------------------------------

const TARGET_LABEL_RE = /^(?:\/\/|#)\s*target:$|^\/\*\s*target:\s*\*\/$/;
const AST_FALLBACK_NOTE_RE = /^(?:\/\/|#)\s*note: AST-fallback mode/;

/**
 * Separate a verified assembled view into its source target and supplementary
 * context. An unverified rendering is never guessed into a source range.
 */
function faithfulAssembledView(source: SourceText, bodyText: string, start: number, end: number): { body: string; range: string; note: string } | undefined {
  const { lines, trailingNewline } = bodyLinesOf(bodyText);
  if (lines.length < 2 || !isTokenlightenSentinelLine(lines[0]!)) return undefined;
  const label = lines.findIndex((line, index) => index > 0 && TARGET_LABEL_RE.test(line.trim()));
  if (label < 0) return undefined;
  let tailStart = lines.length;
  if (tailStart - 1 > label && AST_FALLBACK_NOTE_RE.test(lines[tailStart - 1]!.trim())) tailStart -= 1;
  const preamble = lines.slice(0, label).filter((line) => !MARKER_LINE_RE.test(line));
  let target = lines.slice(label + 1, tailStart);
  const declaredEnd = Math.min(end, source.lines.length);
  if (target.length > 0 && declaredEnd >= start) {
    const verbatim = source.lines.slice(start - 1, declaredEnd);
    const alreadyVerbatim = verbatim.length === target.length && verbatim.every((line, index) => line === target[index]);
    const verified = alreadyVerbatim ? undefined : verifyWindow(target, source, start, declaredEnd);
    if (!alreadyVerbatim && verified === undefined) return undefined;
    if (verified !== undefined) {
      const lastLine = Math.max(
        verified.covered.length > 0 ? verified.covered[verified.covered.length - 1]! : start - 1,
        verified.elided.length > 0 ? verified.elided[verified.elided.length - 1]![1] : start - 1,
      );
      if (lastLine >= start) target = source.lines.slice(start - 1, lastLine);
    }
  }
  if (target.length === 0 || declaredEnd < start) return undefined;
  return {
    body: joinBodyLines(target, trailingNewline),
    range: `${start}-${start + target.length - 1}`,
    note: [...preamble, ...lines.slice(tailStart)].join("\n").trimEnd(),
  };
}

// ---------------------------------------------------------------------------
// Source resolution — the same root the producer served from.
// ---------------------------------------------------------------------------

interface SourceResolver {
  (handle: unknown, path: unknown): { source: SourceText; path: string } | undefined;
}

/**
 * Resolve an entry's file through its OWN handle first (a handle carries the
 * absolute root it was minted against — a read addressed by handle may adopt
 * that root mid-call, see server.ts's "the handle IS the workspace pin"), then
 * the call's resolved workspace. Reads are confined by `safeResolve`, capped at
 * the read ceiling, decoded with the SERVE policy (`servedTextOrUndefined`:
 * the same BOM/UTF-16/NUL-strip verdict the producer served), and cached per
 * response.
 */
function sourceResolver(fallbackRoot: string | undefined): SourceResolver {
  const cache = new Map<string, SourceText | null>();
  const load = (root: string, relPath: string): SourceText | undefined => {
    const key = `${root}\u0000${relPath}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    let loaded: SourceText | null = null;
    try {
      const resolved = safeResolve(relPath, root);
      if (resolved !== undefined) {
        const stat = statSync(resolved);
        if (stat.isFile() && stat.size <= READ_PATH_MAX_BYTES) {
          // served-bytes: readServedText
          const text = servedTextOrUndefined(resolved);
          if (text !== undefined) {
            const lines = text.replace(/\r\n/g, "\n").split("\n");
            if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
            loaded = { lines, lang: languageForPath(relPath) };
          }
        }
      }
    } catch {
      loaded = null;
    }
    cache.set(key, loaded);
    return loaded ?? undefined;
  };
  return (handle, path) => {
    const entry = nonEmptyString(handle) ? handleTable.get(handle) : undefined;
    const relPath = nonEmptyString(path) ? path : entry?.path;
    if (!nonEmptyString(relPath)) return undefined;
    const root = entry !== undefined && entry.path === relPath ? entry.workspaceRoot : fallbackRoot;
    if (!nonEmptyString(root)) return undefined;
    const source = load(root, relPath);
    return source === undefined ? undefined : { source, path: relPath };
  };
}

// ---------------------------------------------------------------------------
// Entry rebuilding
// ---------------------------------------------------------------------------

/** Fields that describe a whole surface; carried once, on its first segment. */
const FIRST_SEGMENT_ONLY = new Set(["why", "likely_edits", "note", "concern_note", "next"]);

/**
 * Join body LINES so that every terminator-semantics reader counts exactly
 * `lines.length` of them: "\n" between lines, plus ONE terminating "\n" when
 * `finalNewline` is asked for or when the last line is blank. The second
 * clause is what makes a body unambiguous: `["a", ""]` joined is `"a\n"`,
 * which TL's own `lineCount`, the budget shedders and Python's `splitlines()`
 * (the review oracle) all read as ONE line although its `range` names two;
 * `"a\n\n"` is two for all of them. Exported for the line-truncating budget
 * shedders (`budget/shedders/readText.ts`, `readBatch.ts`) and the emit tail's
 * fit (`readRequestContinuation.ts`), so a cut that ends on a blank line keeps
 * its body and its narrowed `range` in agreement.
 */
export function joinBodyLines(lines: readonly string[], finalNewline = false): string {
  const text = lines.join("\n");
  return finalNewline || (lines.length > 0 && lines[lines.length - 1] === "") ? `${text}\n` : text;
}

/** The canonical faithful body of `window` (`joinBodyLines` over its source lines). */
function faithfulBody(lines: readonly string[], window: Window, finalNewline: boolean): string {
  return joinBodyLines(lines.slice(window[0] - 1, window[1]), finalNewline);
}

/** Every parseable `"a-b"` window in `value` (an array), in order; `[]` otherwise. */
function parsedWindows(value: unknown): Window[] {
  if (!Array.isArray(value)) return [];
  const windows: Window[] = [];
  for (const raw of value) {
    const window = parseRange(raw);
    if (window !== undefined) windows.push(window);
  }
  return windows;
}

/** Ascending, de-duplicated, overlap-merged windows (adjacent ones stay separate: each is one block). */
function mergedWindows(windows: readonly Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Window[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
    else merged.push([window[0], window[1]]);
  }
  return merged;
}

/** `remaining`-shaped windows plus `extra`, merged and ascending, as strings. */
function mergedRemaining(existing: unknown, extra: Window | undefined): string[] | undefined {
  const windows: Window[] = [];
  if (Array.isArray(existing)) {
    for (const raw of existing) {
      const window = parseRange(raw);
      if (window === undefined) return Array.isArray(existing) ? (existing as string[]) : undefined;
      windows.push(window);
    }
  }
  if (extra !== undefined && !windows.some((window) => window[0] <= extra[0] && window[1] >= extra[1])) {
    windows.push(extra);
  }
  if (windows.length === 0) return undefined;
  windows.sort((a, b) => a[0] - b[0]);
  const merged: Window[] = [];
  for (const window of windows) {
    const last = merged[merged.length - 1];
    if (last !== undefined && window[0] <= last[1] + 1) last[1] = Math.max(last[1], window[1]);
    else merged.push([window[0], window[1]]);
  }
  return merged.map(windowString);
}

/** An assembled prefix's remainder excludes the source it now proves served. */
function assembledEntry(
  entry: Record_,
  view: NonNullable<ReturnType<typeof faithfulAssembledView>>,
  source: SourceText,
  fields: { body: "body" | "content"; remaining: "remaining" | "remaining_ranges" },
): Record_ {
  const out = { ...entry, [fields.body]: view.body, range: view.range,
    note: [entry["note"], view.note].filter(nonEmptyString).join("\n") };
  const declared = parseRange(entry["range"])!;
  const served = parseRange(view.range)!;
  const existing = entry[fields.remaining];
  const windows = parsedWindows(existing);
  // Preserve an unrecognized carrier rather than guess its meaning.
  if (existing !== undefined && (!Array.isArray(existing) || windows.length !== existing.length)) return out;
  const owed: Window[] = [];
  for (const window of windows) {
    if (window[0] < served[0]) owed.push([window[0], Math.min(window[1], served[0] - 1)]);
    if (window[1] > served[1]) owed.push([Math.max(window[0], served[1] + 1), window[1]]);
  }
  const end = Math.min(declared[1], source.lines.length);
  if (served[1] < end) owed.push([served[1] + 1, end]);
  const remaining = mergedRemaining(owed.map(windowString), undefined);
  if (remaining === undefined) delete out[fields.remaining];
  else out[fields.remaining] = remaining;
  return out;
}

/**
 * Rebuild one entry into its faithful segments, preserving the producer's key
 * order: `range` and the body field are replaced per segment, `elided` is
 * inserted right after the body on the FIRST segment, and every per-surface
 * fact (`remaining`/`remaining_ranges`, `why`, `likely_edits`, `note`, `next`)
 * rides the first segment only — the "ONE remaining PER TARGET, ON ITS FIRST
 * ENTRY" convention `readFamily.ts` and `readRequestContinuation.ts` share.
 * `truncated` (batch entries) stays true only on the last segment, which is
 * where the producer's cut actually is.
 */
function rebuiltEntries(
  entry: Record_,
  plan: Rebuild,
  source: SourceText,
  fields: { body: "body" | "content"; remaining: "remaining" | "remaining_ranges" },
  overrides: Record_ = {},
): Record_[] {
  const finalNewline = typeof entry[fields.body] === "string" && (entry[fields.body] as string).endsWith("\n");
  const remaining = mergedRemaining(entry[fields.remaining], plan.undelivered);
  // A producer may already have disclosed windows OUTSIDE this body (the
  // `elided_windows` carrier, readFamily.ts) — keep them, merged in order.
  const elided = mergedWindows([...parsedWindows(entry["elided"]), ...plan.elided]);
  const keys = Object.keys({ ...entry, ...overrides });
  return plan.segments.map((segment, index) => {
    const first = index === 0;
    const last = index === plan.segments.length - 1;
    const out: Record_ = {};
    for (const key of keys) {
      if (key === "range") {
        out["range"] = windowString(segment);
        continue;
      }
      if (key === fields.body) {
        out[fields.body] = faithfulBody(source.lines, segment, last && finalNewline);
        if (first && elided.length > 0) out["elided"] = elided.map(windowString);
        continue;
      }
      if (key === "elided") continue;
      if (key === fields.remaining) {
        if (first && remaining !== undefined) out[fields.remaining] = remaining;
        continue;
      }
      if (key === "truncated") {
        out["truncated"] = last ? (overrides["truncated"] ?? entry["truncated"]) : false;
        continue;
      }
      if (!first && FIRST_SEGMENT_ONLY.has(key)) continue;
      out[key] = key in overrides ? overrides[key] : entry[key];
    }
    if (!("range" in out)) out["range"] = windowString(segment);
    if (first && remaining !== undefined && !(fields.remaining in out)) out[fields.remaining] = remaining;
    return out;
  });
}

/** One `evidence[]` entry -> its faithful replacement(s); the entry itself when nothing applies. */
function faithfulEvidence(entry: unknown, resolve: SourceResolver): unknown[] {
  if (!isRecord(entry)) return [entry];
  const body = entry["body"];
  if (typeof body !== "string" || body === "") return [entry];
  const window = parseRange(entry["range"]);
  if (window === undefined) return [entry];
  const resolved = resolve(entry["handle"], entry["path"]);
  if (resolved === undefined) return [entry];
  const view = faithfulAssembledView(resolved.source, body, window[0], window[1]);
  if (view !== undefined) return [assembledEntry(entry, view, resolved.source, { body: "body", remaining: "remaining" })];
  const plan = rebuildPlan(resolved.source, body, window[0], window[1], entry["remaining"]);
  if (plan === undefined) return [entry];
  return rebuiltEntries(entry, plan, resolved.source, { body: "body", remaining: "remaining" });
}

/** One `read.batch` entry -> its faithful replacement(s). */
function faithfulBatchEntry(entry: unknown, resolve: SourceResolver): unknown[] {
  if (!isRecord(entry)) return [entry];
  const form = entry["form"];
  const content = entry["content"];
  if (typeof content !== "string" || content === "") return [entry];
  if (form === "handle" || form === "range") {
    const window = parseRange(entry["range"]);
    if (window === undefined) return [entry];
    const resolved = resolve(entry["handle"], entry["path"]);
    if (resolved === undefined) return [entry];
    const view = faithfulAssembledView(resolved.source, content, window[0], window[1]);
    if (view !== undefined) return [assembledEntry(entry, view, resolved.source, { body: "content", remaining: "remaining_ranges" })];
    const plan = rebuildPlan(resolved.source, content, window[0], window[1], entry["remaining_ranges"]);
    if (plan === undefined) return [entry];
    return rebuiltEntries(entry, plan, resolved.source, { body: "content", remaining: "remaining_ranges" });
  }
  if (form === "file") {
    // A whole-file entry carries no `range`: its window is the whole file.
    const resolved = resolve(entry["handle"], entry["path"]);
    if (resolved === undefined) return [entry];
    const plan = rebuildPlan(resolved.source, content, 1, undefined, undefined);
    if (plan === undefined) return [entry];
    const total = resolved.source.lines.length;
    if (plan.elided.length === 0 && plan.segments.length === 1 && plan.segments[0]![0] === 1 && plan.segments[0]![1] === total) {
      // Nothing elided — only whitespace normalization (compressFormat) to
      // undo: the entry still IS the whole file, so it keeps its `file` form.
      return [{ ...entry, content: faithfulBody(resolved.source.lines, [1, total], content.endsWith("\n")) }];
    }
    // A `file` entry promises the WHOLE file in `content`; once comment blocks
    // are elided it no longer is one, so each faithful segment becomes the
    // range-addressed `handle` form (`{handle, path, range, content,
    // truncated, sha}`, A.5.4) on the same handle — or the `range` form when
    // the producer named no handle/sha to address it by.
    const addressed = nonEmptyString(entry["handle"]) && nonEmptyString(entry["sha"]);
    const shaped: Record_ = addressed
      ? {
        form: "handle",
        handle: entry["handle"],
        path: entry["path"],
        range: "",
        content,
        truncated: false,
        sha: entry["sha"],
        ...(entry["note"] !== undefined ? { note: entry["note"] } : {}),
      }
      : { form: "range", path: entry["path"], range: "", content, truncated: false };
    return rebuiltEntries(shaped, plan, resolved.source, { body: "content", remaining: "remaining_ranges" });
  }
  return [entry];
}

/** Narrow each continuation only when its own file capability matches. */
function assembledContinuation(
  payload: Record_,
  resolve: SourceResolver,
  prefixes: readonly { source: SourceText; declared: Window; served: Window }[],
): Record_ {
  if (prefixes.length === 0) return payload;
  const narrowCall = (next: unknown): unknown => {
    if (!isRecord(next)) return next;
    const args = next["arguments"];
    if (next["tool"] !== "tl_read_file" || !isRecord(args) || !Array.isArray(args["targets"])) return next;
    let changed = false;
    const targets = args["targets"].map(target => {
      if (!isRecord(target)) return target;
      const source = resolve(target["handle"], target["path"]);
      const prefix = prefixes.find(row => source?.source === row.source && target["range"] === windowString(row.declared));
      if (prefix === undefined) return target;
      changed = true;
      return { ...target, range: `${prefix.served[1] + 1}-${Math.min(prefix.declared[1], prefix.source.lines.length)}` };
    });
    return changed ? { ...next, arguments: { ...args, targets } } : next;
  };
  let out = payload;
  for (const field of ["evidence", "entries"]) {
    const list = out[field];
    if (!Array.isArray(list)) continue;
    let changed = false;
    const entries = list.map(entry => {
      if (!isRecord(entry)) return entry;
      const next = narrowCall(entry["next"]);
      if (next === entry["next"]) return entry;
      changed = true;
      return { ...entry, next };
    });
    if (changed) out = { ...out, [field]: entries };
  }
  const topNext = narrowCall(out["next"]);
  if (topNext !== out["next"]) out = { ...out, next: topNext };
  const limit = out["limit"];
  if (!isRecord(limit)) return out;
  const next = narrowCall(limit["next"]);
  return next === limit["next"] ? out : { ...out, limit: { ...limit, next } };
}

/**
 * The read-family seam (see this file's header). Returns `payload` unchanged
 * (same reference) for every other kind, when no workspace root is known, and
 * when no entry needed rebuilding; otherwise a shallow copy whose `evidence`
 * (or `entries`) array holds the faithful entries.
 */
export function applySourceFidelity(
  payload: Record_,
  kind: Kind,
  context: {
    readonly workspace?: string;
    readonly readServeWorkspace?: string;
    readonly codecTraceWorkspace?: string;
  } | undefined,
): Record_ {
  if (kind !== "read.text" && kind !== "read.task_pack" && kind !== "read.batch") return payload;
  const field = kind === "read.batch" ? "entries" : "evidence";
  const list = payload[field];
  if (!Array.isArray(list) || list.length === 0) return payload;
  // A read's resolved root rides `readServeWorkspace`/`codecTraceWorkspace`
  // (`workspace` is the EDIT dispatcher's slot — see their doc comments in
  // envelope.ts); an entry's own handle root, when it has one, wins anyway.
  const resolve = sourceResolver(context?.readServeWorkspace ?? context?.codecTraceWorkspace ?? context?.workspace);
  let changed = false;
  const rebuilt: unknown[] = [];
  const prefixes: { source: SourceText; declared: Window; served: Window }[] = [];
  for (const entry of list) {
    let replacement: unknown[];
    try {
      replacement = kind === "read.batch" ? faithfulBatchEntry(entry, resolve) : faithfulEvidence(entry, resolve);
    } catch {
      replacement = [entry];
    }
    if (replacement.length !== 1 || replacement[0] !== entry) changed = true;
    if (replacement.length === 1 && replacement[0] !== entry && isRecord(entry) && isRecord(replacement[0])) {
      const body = entry[kind === "read.batch" ? "content" : "body"];
      const declared = parseRange(entry["range"]);
      const served = parseRange(replacement[0]["range"]);
      const source = resolve(entry["handle"], entry["path"]);
      if (typeof body === "string" && isTokenlightenSentinelLine(body.split("\n")[0] ?? "")
        && declared !== undefined && served !== undefined && source !== undefined
        && served[0] === declared[0] && served[1] < Math.min(declared[1], source.source.lines.length)) {
        prefixes.push({ source: source.source, declared, served });
      }
    }
    rebuilt.push(...replacement);
  }
  return changed ? assembledContinuation({ ...payload, [field]: rebuilt }, resolve, prefixes) : payload;
}
