// edit-anchor — extracted implementation; imports point to the owning modules.
import type { HandleEntry } from "../util/handles.js";
import { ELISION_MARKER_RE } from "../util/formatCompress.js";
import { TINY_BYTES } from "../util/fullGovernor.js";
import { TINY_LINES } from "../util/fullGovernor.js";
import { TL_SYNTHETIC_MARKER_RE } from "../util/formatCompress.js";
import { canonicalToolCall } from "../protocol/envelope.js";
import { countLines } from "../util/countLines.js";
import { elideDocCommentsForDisplay } from "../util/formatCompress.js";
import { handleTable } from "../util/handles.js";
import { languageForPath } from "../util/languages.js";
import { readFileSafe } from "../util/safePath.js";
import { readFileSafeOpt } from "./read-admission2.js";
import { resolveHandleWorkspace } from "./workspace-routing2.js";
import { shaOfText } from "../util/handles.js";
import { shortSha } from "../util/handles.js";

export function extractRangeText(content: string, range: string): string | null {
  const match = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  return lines.slice(start - 1, end).join("\n") + "\n";
}

/**
 * H4: hash the "start-end" line slice of `content` the SAME way resolveSlice
 * (readCodeModes.ts) mints a range handle's sha — split on /\r?\n/, take
 * lines[start-1 .. end] inclusive, join with "\n", shaOfText. Used to refresh
 * a range/symbol handle's stored sha to its POST-edit SLICE content (not the
 * whole file) so a follow-up re-read dedupes to the same handle id. Returns
 * undefined for a malformed range (caller falls back to the whole-file sha).
 */
export function sliceShaForRange(content: string, range: string): string | undefined {
  const m = range.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return undefined;
  const start = Number(m[1]);
  const end = Number(m[2] ?? m[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return undefined;
  const lines = content.split(/\r?\n/);
  const slice = lines.slice(start - 1, end).join("\n");
  return shaOfText(slice);
}

export function contentHasElisionMarker(value: unknown): boolean {
  return typeof value === "string"
    && (ELISION_MARKER_RE.test(value) || TL_SYNTHETIC_MARKER_RE.test(value));
}

export type ElisionMarkerField = "content" | "replace" | "search" | "target";

export interface ElisionMarkerRefusalOptions {
  field: ElisionMarkerField;
  path?: string;
  range?: string;
  failedItem?: number;
}

export function elidedContentRefusal({
  field,
  path,
  range,
  failedItem,
}: ElisionMarkerRefusalOptions): Record<string, unknown> {
  const validRange = typeof range === "string" && /^\d+(?:-\d+)?$/.test(range);
  const reread = path
    ? validRange
      ? canonicalToolCall("tl_read_file", { mode: "slice", path, range, comments: "keep" })
      : canonicalToolCall("tl_read_file", { mode: "full", path, comments: "keep" })
    : canonicalToolCall("tl_read_file", { mode: "task_pack", query: "re-read the affected source with comments kept" });

  return {
    ok: false,
    reason: "elided-content",
    code: "elided-content",
    ...(path ? { path } : {}),
    ...(failedItem !== undefined ? { failed_item: { index: failedItem } } : {}),
    hint: field === "search"
      ? "search is a placeholder from a compressed read, not file text; re-read with comments=\"keep\" or anchor on an actual file line"
      : "the replacement text contains an elision marker from a compressed read; re-read with comments=\"keep\" and resend real source text",
    next: reread,
  };
}

// ---------------------------------------------------------------------------
// FX-OH F4 (2026-09-04) — ELISION-AWARE EDIT ANCHORS.
// R27b-FIX (2026-09-05, review R27b ruling) — EXACT PROJECTION, NOT A HEURISTIC.
//
// THE LOOP THIS CLOSES (r4 SF05 arm A, twice; 4 turns each). A solver reads a
// body whose doc comments were elided, anchors an edit on a span that contains
// one of the markers, and is refused `elided-content`. That refusal is correct
// about the DANGER (pasting a marker back would write it into the file, silently
// deleting what it stood for) but wrong about the REMEDY: the marker in `search`
// is a locating problem, and this server holds the file it is locating against.
//
// WHY THE FIRST TWO ATTEMPTS WERE UNSOUND. R27's fix matched the search's
// non-marker segments as whole lines and let a greedy forward scan decide how
// many file lines each marker "stood for"; R27-FIX added a LINE-LEVEL
// HEURISTIC ("the swallowed gap must look like comment or blank lines") on top
// of that inference. Review R27b defeated the heuristic twice, both times with
// `edit.applied` and silent deletion of real code:
//   (a) a C pointer-dereference statement (`  *a = 1;`) reads as a block-comment
//       continuation line, so a real-code gap passed the "comment-only" test —
//       inside C, a language the guard was explicitly scoped to protect;
//   (b) the guard never looked at the FILE'S LANGUAGE, so `# doc elided L2-3`
//       resolved against a Markdown file whose "gap" was two real `## Heading`
//       lines — a language for which this server never emits any marker at all.
//
// THE RULE NOW (R27b ruling). No inference, no line-shape heuristic, no
// language-blind acceptance. This server is the ONLY party that produces
// elision markers, and it produces them DETERMINISTICALLY from the file:
// `elideDocCommentsForDisplay` renders the file's elided view and — ruling (aa)
// — returns the EXACT file-line windows its own scan collapsed. Therefore:
//
//   1. Render the current file through the SAME function, with the SAME
//      configuration, the read path uses for that path's language. A language
//      with no elision support (markdown, yaml, shell, unknown, ...) renders
//      with NO windows, and every marker-bearing search against it refuses —
//      defeat (b) closed by construction, for every non-elidable language at
//      once rather than one line-shape at a time.
//   2. Match the caller's `search` against THAT RENDERING, whole lines, in
//      order — exact first, then the ordinary anchor's own leading/trailing
//      horizontal-whitespace equivalence (`findUniqueIndentationEquivalent`),
//      never anything looser.
//   3. Uniqueness: exactly one matching position. Zero or several refuse with
//      the F3 recovery `next`. (Several is reachable and load-bearing: real
//      file content can carry a FORGED marker-shaped line that renders
//      verbatim beside a genuine one — round-21A's forged-marker shape.)
//   4. The gap is the RENDERER'S OWN RECORDED WINDOW for that marker, never
//      inferred from the file text. Defeat (a) is closed by construction: the
//      resolved region is exactly the comment block the renderer collapsed, so
//      no scan can run past it into an unrelated declaration.
//
// `replace` mirrors the same discipline: a marker in `replace` is expanded
// back to the renderer-recorded ORIGINAL TEXT of the SAME marker, paired
// positionally and only when every marker's own `L<a>-<b>` coordinates match
// the resolved window one-to-one. Any mismatch in count or coordinates
// refuses; so does a marker in `replace` that is not alone on its line (that
// is the write-the-marker-into-the-file case, and expanding it is undefined).
//
// STILL REFUSED OUTRIGHT: a marker in `content` or `target`, and a marker in
// `replace` with none in `search`. Nothing here relaxes them.
// ---------------------------------------------------------------------------

/** A line that is nothing but an elision marker (plus indentation). */
export function isElisionMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  return /^(?:\/\* doc elided L\d+-\d+ \*\/|#\s?doc elided L\d+-\d+)$/.test(trimmed);
}

/** The `L<start>-<end>` coordinates a marker line names, or `undefined`. */
export function elisionMarkerCoordinates(line: string): [number, number] | undefined {
  const m = /^(?:\/\* doc elided L(\d+)-(\d+) \*\/|#\s?doc elided L(\d+)-(\d+))$/.exec(line.trim());
  if (m === null) return undefined;
  const from = Number(m[1] ?? m[3]);
  const to = Number(m[2] ?? m[4]);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return undefined;
  return [from, to];
}

export interface ElidedAnchorSegments {
  /** Every line of the text, with a single trailing-newline element removed. */
  readonly lines: string[];
  /** Runs of literal lines, `markers.length + 1` of them. */
  readonly segments: string[][];
  readonly markers: string[];
  readonly hadTrailingNewline: boolean;
}

/** Split marker-bearing text into literal runs; `undefined` when it carries no marker. */
export function splitOnElisionMarkers(text: string): ElidedAnchorSegments | undefined {
  const raw = text.split(/\r?\n/);
  const hadTrailingNewline = raw.length > 1 && raw[raw.length - 1] === "";
  const lines = hadTrailingNewline ? raw.slice(0, -1) : raw;
  if (!lines.some(isElisionMarkerLine)) return undefined;
  const segments: string[][] = [[]];
  const markers: string[] = [];
  for (const line of lines) {
    if (isElisionMarkerLine(line)) {
      markers.push(line);
      segments.push([]);
      continue;
    }
    segments[segments.length - 1]!.push(line);
  }
  return { lines, segments, markers, hadTrailingNewline };
}

export interface ElidedAnchorResolution {
  readonly search: string;
  readonly replace?: string;
}

/**
 * The view of the file both the renderer and the edit engine work on: LF line
 * endings (`applyEditsMulti` normalizes the file the same way before matching,
 * and restores the original convention on write) and no leading BOM (never
 * part of the first line's source text). Matching against anything else would
 * resolve an anchor the engine then fails to find.
 */
export function normalizeForElidedAnchor(content: string): string {
  const noBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return noBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** The ordinary anchor's own line equivalence (see `findUniqueIndentationEquivalent`). */
export function trimHorizontalWhitespaceForAnchor(line: string): string {
  return line.replace(/^[\t ]+|[\t ]+$/g, "");
}

/**
 * Resolve a marker-bearing `search` (and, when it mirrors the same markers, a
 * marker-bearing `replace`) against `content` — by EXACT PROJECTION onto the
 * file's own elided rendering, never by inference. `undefined` means "not
 * resolvable" — the caller keeps refusing `elided-content`.
 *
 * See the block comment above for the rule and the two review defeats it
 * replaces.
 */
export function resolveElidedEditAnchor(
  content: string,
  relPath: string,
  search: string,
  replace: string | undefined,
): ElidedAnchorResolution | undefined {
  const parsed = splitOnElisionMarkers(search);
  if (parsed === undefined) return undefined;

  // (1) The file's elided RENDERING, from the same renderer — and the same
  // per-language configuration — the read path uses. A non-elidable language
  // yields no windows and every marker-bearing anchor against it refuses.
  const normalized = normalizeForElidedAnchor(content);
  if (normalized === "") return undefined;
  const rendering = elideDocCommentsForDisplay(normalized, languageForPath(relPath), false);
  const windows = rendering.elided;
  if (windows.length === 0) return undefined;

  const fileLines = normalized.split("\n");
  const fileHadTrailingNewline = fileLines.length > 1 && fileLines[fileLines.length - 1] === "";
  const fileLineCount = fileHadTrailingNewline ? fileLines.length - 1 : fileLines.length;

  const renderedLines = rendering.content.split("\n");
  if (renderedLines.length > 1 && renderedLines[renderedLines.length - 1] === "") renderedLines.pop();

  // (4, part one) Rendered line -> file-line span, derived ONLY from the
  // renderer's own window list. Every window is replaced by exactly one output
  // line (its opener is line-start anchored, and any code following the closing
  // delimiter rides that same output line), so this walk is exact — and it
  // never consults the rendered TEXT, so a forged marker-shaped line in real
  // file content stays an ordinary line here.
  const spans: Array<[number, number]> = [];
  const windowBacked: boolean[] = [];
  {
    let file = 1;
    let w = 0;
    while (file <= fileLineCount) {
      const win = windows[w];
      if (win !== undefined && win[0] < file) return undefined; // not ascending/disjoint
      if (win !== undefined && win[0] === file) {
        if (win[1] < win[0] || win[1] > fileLineCount) return undefined;
        spans.push([win[0], win[1]]);
        windowBacked.push(true);
        file = win[1] + 1;
        w += 1;
        continue;
      }
      spans.push([file, file]);
      windowBacked.push(false);
      file += 1;
    }
    if (w !== windows.length) return undefined;
  }
  if (spans.length !== renderedLines.length) return undefined;

  // (2) + (3) Whole-line match against the rendering: exact first, then the
  // ordinary anchor's horizontal-whitespace equivalence. Exactly one position,
  // or refuse.
  const searchLines = parsed.lines;
  if (searchLines.length === 0) return undefined;
  const matchesUnder = (equal: (a: string, b: string) => boolean): number[] => {
    const hits: number[] = [];
    for (let start = 0; start + searchLines.length <= renderedLines.length; start++) {
      let ok = true;
      for (let k = 0; k < searchLines.length; k++) {
        if (!equal(renderedLines[start + k]!, searchLines[k]!)) { ok = false; break; }
      }
      if (ok) hits.push(start);
    }
    return hits;
  };
  let matches = matchesUnder((a, b) => a === b);
  if (matches.length === 0) {
    matches = matchesUnder(
      (a, b) => trimHorizontalWhitespaceForAnchor(a) === trimHorizontalWhitespaceForAnchor(b),
    );
  }
  if (matches.length !== 1) return undefined;
  const first = matches[0]!;
  const last = first + searchLines.length - 1;

  // (4, part two) Every marker inside the matched region must be a genuine,
  // renderer-recorded one that owns its whole output line — and every genuine
  // marker line must read as one. A marker-shaped line that is really file
  // content, or a marker sharing its line with code after the closing
  // delimiter, is not resolvable and refuses.
  const gapWindows: Array<[number, number]> = [];
  for (let i = first; i <= last; i++) {
    const backed = windowBacked[i] === true;
    const looksLikeMarker = isElisionMarkerLine(renderedLines[i]!);
    if (backed !== looksLikeMarker) return undefined;
    if (backed) gapWindows.push(spans[i]!);
  }
  if (gapWindows.length !== parsed.markers.length) return undefined;

  const textOfLines = (from: number, to: number): string => fileLines.slice(from - 1, to).join("\n");
  const fromLine = spans[first]![0];
  const toLine = spans[last]![1];
  let resolvedSearch = textOfLines(fromLine, toLine);
  if (parsed.hadTrailingNewline && toLine < fileLineCount) resolvedSearch += "\n";

  // (3, second half) The RESOLVED region must also be unique in the FILE, by
  // the edit engine's own rule (`applySingleEdit` matches a substring and
  // demands exactly one occurrence). A rendering that is unique only because
  // the two copies of one region carry different marker COORDINATES still
  // resolves to identical bytes, and rewriting the anchor there would hand the
  // engine an ambiguous search whose refusal no longer names the elision — or,
  // worse, let an indentation-equivalent recovery pick one. Refuse instead, so
  // the `elided-content` refusal and its F3 `comments:"keep"` recovery stand.
  if (resolvedSearch === "") return undefined;
  {
    let occurrences = 0;
    for (let at = normalized.indexOf(resolvedSearch); at >= 0; at = normalized.indexOf(resolvedSearch, at + 1)) {
      occurrences += 1;
      if (occurrences > 1) return undefined;
    }
    if (occurrences !== 1) return undefined;
  }

  if (replace === undefined) return { search: resolvedSearch };
  if (!contentHasElisionMarker(replace)) {
    // No marker in the replacement: the caller wrote the whole new region, and
    // the resolved region is exact. Apply it verbatim.
    return { search: resolvedSearch, replace };
  }
  const replaceParsed = splitOnElisionMarkers(replace);
  // A marker that is not alone on its line cannot be expanded — that is the
  // write-the-marker-into-the-file case this guard exists for.
  if (replaceParsed === undefined) return undefined;
  if (replaceParsed.markers.length !== gapWindows.length) return undefined;
  for (let k = 0; k < replaceParsed.markers.length; k++) {
    const coords = elisionMarkerCoordinates(replaceParsed.markers[k]!);
    const win = gapWindows[k]!;
    if (coords === undefined || coords[0] !== win[0] || coords[1] !== win[1]) return undefined;
  }
  const pieces: string[] = [];
  for (let k = 0; k < replaceParsed.segments.length; k++) {
    const run = replaceParsed.segments[k]!;
    if (run.length > 0) pieces.push(run.join("\n"));
    const win = gapWindows[k];
    if (win !== undefined) pieces.push(textOfLines(win[0], win[1]));
  }
  const resolvedReplace = pieces.join("\n") + (replaceParsed.hadTrailingNewline ? "\n" : "");
  return { search: resolvedSearch, replace: resolvedReplace };
}

/**
 * Apply F4 to one edit shape in place. Returns true when the anchor resolved
 * and `entry.search`/`entry.replace` were rewritten to real file text; false
 * leaves the caller's `elided-content` refusal exactly as it was.
 */
export async function applyElidedEditAnchor(
  entry: Record<string, unknown>,
  relPath: string,
  workspace: string,
): Promise<boolean> {
  const search = entry["search"];
  if (typeof search !== "string" || !contentHasElisionMarker(search)) return false;
  // `content`/`target` markers are the write-the-marker-into-the-file case and
  // are never resolved here.
  if (contentHasElisionMarker(entry["content"]) || contentHasElisionMarker(entry["target"])) return false;
  if (relPath === "") return false;
  const replace = typeof entry["replace"] === "string" ? entry["replace"] : undefined;
  let content: string | null;
  try {
    // served-bytes: not-served (edit anchor resolution: the text is MATCHED, never emitted)
    content = await readFileSafeOpt(relPath, workspace);
  } catch {
    return false;
  }
  if (content === null) return false;
  const resolved = resolveElidedEditAnchor(content, relPath, search, replace);
  if (resolved === undefined) return false;
  entry["search"] = resolved.search;
  if (resolved.replace !== undefined) entry["replace"] = resolved.replace;
  return true;
}

export function artifactReplacementElisionField(value: unknown): ElisionMarkerField | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  const inspect = (fields: ReadonlyArray<readonly [ElisionMarkerField, unknown]>): ElisionMarkerField | undefined => {
    for (const [field, candidate] of fields) {
      if (contentHasElisionMarker(candidate)) return field;
    }
    return undefined;
  };

  const replacements = artifact["replacements"];
  if (Array.isArray(replacements)) {
    for (const replacement of replacements) {
      if (replacement === null || typeof replacement !== "object" || Array.isArray(replacement)) continue;
      const row = replacement as Record<string, unknown>;
      const found = inspect([
        ["search", row["search"]],
        ["replace", row["replace"]],
      ]);
      if (found !== undefined) return found;
    }
  }

  const members = artifact["members"];
  if (Array.isArray(members)) {
    for (const member of members) {
      if (member === null || typeof member !== "object" || Array.isArray(member)) continue;
      const found = inspect([["content", (member as Record<string, unknown>)["content"]]]);
      if (found !== undefined) return found;
    }
  }

  const cells = artifact["cells"];
  if (Array.isArray(cells)) {
    for (const cell of cells) {
      if (cell === null || typeof cell !== "object" || Array.isArray(cell)) continue;
      const row = cell as Record<string, unknown>;
      const found = inspect([
        ["content", row["value"]],
        ["content", row["formula"]],
      ]);
      if (found !== undefined) return found;
    }
  }

  const form = artifact["form"];
  if (form !== null && typeof form === "object" && !Array.isArray(form)) {
    for (const field of Object.values(form as Record<string, unknown>)) {
      const values = Array.isArray(field) ? field : [field];
      const found = inspect(values.map((item) => ["content", item] as const));
      if (found !== undefined) return found;
    }
  }

  // sourcePath names already-existing bytes to copy into a ZIP member. It is
  // deliberately not text content, so binary payloads remain supported.
  return undefined;
}

export const DISALLOWED_TEXT_CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

export interface TextControlCharacterField {
  field: string;
  character: string;
  failedItem?: number;
}

export function firstDisallowedTextControlCharacter(
  fields: ReadonlyArray<readonly [string, unknown]>,
  failedItem?: number,
): TextControlCharacterField | undefined {
  for (const [field, value] of fields) {
    if (typeof value !== "string") continue;
    const match = DISALLOWED_TEXT_CONTROL_CHARACTER_RE.exec(value);
    if (match === null) continue;
    const codePoint = match[0]!.codePointAt(0)!;
    return {
      field,
      character: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
      ...(failedItem !== undefined ? { failedItem } : {}),
    };
  }
  return undefined;
}

export function artifactTextControlCharacterField(value: unknown): TextControlCharacterField | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const artifact = value as Record<string, unknown>;
  const inspect = (fields: ReadonlyArray<readonly [string, unknown]>): TextControlCharacterField | undefined =>
    firstDisallowedTextControlCharacter(fields);

  const replacements = artifact["replacements"];
  if (Array.isArray(replacements)) {
    for (const [index, replacement] of replacements.entries()) {
      if (replacement === null || typeof replacement !== "object" || Array.isArray(replacement)) continue;
      const row = replacement as Record<string, unknown>;
      const found = inspect([
        [`artifact.replacements[${index}].search`, row["search"]],
        [`artifact.replacements[${index}].replace`, row["replace"]],
      ]);
      if (found !== undefined) return found;
    }
  }

  const members = artifact["members"];
  if (Array.isArray(members)) {
    for (const [index, member] of members.entries()) {
      if (member === null || typeof member !== "object" || Array.isArray(member)) continue;
      const found = inspect([[`artifact.members[${index}].content`, (member as Record<string, unknown>)["content"]]]);
      if (found !== undefined) return found;
    }
  }

  const cells = artifact["cells"];
  if (Array.isArray(cells)) {
    for (const [index, cell] of cells.entries()) {
      if (cell === null || typeof cell !== "object" || Array.isArray(cell)) continue;
      const row = cell as Record<string, unknown>;
      const found = inspect([
        [`artifact.cells[${index}].value`, row["value"]],
        [`artifact.cells[${index}].formula`, row["formula"]],
      ]);
      if (found !== undefined) return found;
    }
  }

  const form = artifact["form"];
  if (form !== null && typeof form === "object" && !Array.isArray(form)) {
    for (const [name, field] of Object.entries(form as Record<string, unknown>)) {
      const values = Array.isArray(field) ? field : [field];
      for (const [index, item] of values.entries()) {
        const found = inspect([[`artifact.form.${name}${Array.isArray(field) ? `[${index}]` : ""}`, item]]);
        if (found !== undefined) return found;
      }
    }
  }

  // sourcePath names already-existing bytes to copy into a ZIP member. It is
  // deliberately not text content, so binary payloads remain supported.
  return undefined;
}

export function textControlCharacterRefusal({
  field,
  character,
  failedItem,
}: TextControlCharacterField): Record<string, unknown> {
  return {
    ok: false,
    reason: "invalid-input",
    code: "invalid-input",
    field,
    ...(failedItem !== undefined ? { failed_item: { index: failedItem } } : {}),
    error: `${field} contains disallowed control character ${character}; text write arguments allow only LF (U+000A), TAB (U+0009), and CR (U+000D) control characters`,
    detail: "remove the control character and re-issue the tl_edit_file call",
  };
}

/**
 * item 11: parse the 1-based file START line from a "start-end" (or bare
 * "start") range string, for passing to elideDocComments so a slice's elision
 * markers carry TRUE file line numbers. Returns 1 for a malformed range (the
 * safe default — slice-relative, i.e. unchanged from before).
 */
export function rangeStartLine(range: string | undefined): number {
  if (!range) return 1;
  const m = range.match(/^(\d+)(?:-\d+)?$/);
  if (!m) return 1;
  const start = Number(m[1]);
  return Number.isInteger(start) && start >= 1 ? start : 1;
}

/**
 * P2-15 (round-4 evaluation): the END-line sibling of `rangeStartLine`, for
 * the one call site (the mode=slice code-unchanged gate) that needs the
 * NOMINAL end a simple "start-end" range string declares — as opposed to
 * re-deriving it from `countLines(content)`, which cannot tell "N real lines
 * with an ordinary trailing newline" apart from "N+1 lines whose LAST one is
 * blank" (both serialize to the identical joined string). Returns `undefined`
 * for a bare "start" (no explicit end) or a malformed range — the caller
 * falls back to its own content-length-derived value in that case, exactly
 * as it did before this helper existed.
 */
export function rangeEndLine(range: string | undefined): number | undefined {
  if (!range) return undefined;
  const m = range.match(/^\d+-(\d+)$/);
  if (!m) return undefined;
  const end = Number(m[1]);
  return Number.isInteger(end) && end >= 1 ? end : undefined;
}

/** 1-based inclusive logical line count — a trailing "\n" does not count as
 * an extra empty final line (mirrors applyEditsMulti.ts's countLogicalLinesEntry).
 * Thin alias kept for call-site readability at its one remaining call below;
 * the implementation now lives in util/countLines.ts, shared with every other
 * mint/bounds site that needs this exact trailing-newline-aware count. */
export function countLogicalLinesForTail(content: string): number {
  return countLines(content);
}

/**
 * DESIGN-v0.8 B4.2: a `{handle, content}` range-replace only touches
 * [handleRange]; if the handle's range did not cover the WHOLE tiny file
 * (a live case: a handle minted as 1-11 of a 13-line stub), lines after the
 * replaced range are left completely untouched — including, in that case,
 * a docstring's own closing delimiter that the replace's incoming content
 * assumed it was also replacing. Rather than let that syntax error surface
 * only on the NEXT turn (a build/test failure several calls later), surface
 * the leftover tail lines inline in THIS success response so the model can
 * repair it in the same turn.
 *
 * Scoped narrowly to avoid false positives on ordinary partial-file edits:
 * only fires when (a) the edit succeeded, (b) the file is at/below the TINY
 * threshold (large files routinely have a range-scoped edit with an
 * intentionally untouched tail — that is normal, not an orphan), and (c) the
 * tail is 1-3 lines (a longer remainder is far more likely to be
 * deliberately out of scope than an accidentally-orphaned fragment).
 */
export function attachOrphanTailWarning(
  result: Record<string, unknown>,
  preEditContent: string | null,
  handleRange: string,
): Record<string, unknown> {
  if ((result as { ok?: boolean }).ok === false) return result;
  if (preEditContent === null) return result;

  const m = handleRange.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return result;
  const rangeEnd = Number(m[2] ?? m[1]);
  if (!Number.isInteger(rangeEnd)) return result;

  const preEditBytes = Buffer.byteLength(preEditContent, "utf8");
  const totalLines = countLogicalLinesForTail(preEditContent);
  const isTiny = preEditBytes <= TINY_BYTES && totalLines <= TINY_LINES;
  if (!isTiny) return result;

  const tailCount = totalLines - rangeEnd;
  if (tailCount <= 0 || tailCount > 3) return result;

  const normalized = preEditContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  const allLines = trimmed.split("\n");
  const leftoverLines = allLines.slice(rangeEnd);

  return {
    ...result,
    warning: `${tailCount} line(s) after the replaced range (${handleRange}) were left unchanged — verify they still form valid content.`,
    leftoverLines,
  };
}

/**
 * INV-I-3 (FX-P2): AGENTS.md states plainly, for `create:true`, "new
 * files/scratch/tests=>...; >32 KiB=fail" — but no code path ever enforced
 * it. A live-fire sweep (INV-I) confirmed a 2 MiB `create:true` payload wrote
 * to disk without refusal, in both the top-level single-edit shape and the
 * `edits[]` batch-create-item shape. This is the one ceiling both shapes
 * share; keep it in one place so a future change to the limit cannot drift
 * between them the way the two shapes' create-validation logic otherwise
 * lives in two different code regions of this file.
 */
export const MAX_CREATE_CONTENT_BYTES = 32 * 1024;

/**
 * Pre-write validation for `create:true`'s body, shared by the single-edit
 * create dispatch and the `edits[]` batch create-item branch. MUST run
 * before any `createFile`/disk write for the item it validates — for the
 * batch shape this means during Phase 1 (typedEdits construction), before
 * `applyEditsMulti` ever runs, so a batch containing one oversized create
 * item refuses the WHOLE batch with disk completely untouched, matching this
 * sweep's other pre-write-validation findings (INV-I's CLEAN "batch
 * all-or-nothing via pre-write validation" note).
 *
 * `field` names the offending argument in the shape of the call that reached
 * here: the bare top-level/single-edit shape names it `"content"` (the
 * literal argument key); a batch item names it `edits[${index}].content`
 * (the AGENTS.md-documented dot-path convention) and additionally carries
 * `failed_item` per this file's existing batch-refusal convention (see the
 * neighboring `batch-create-*` refusals above the edits[] loop) so a batch
 * caller gets both the precise field path and the structured locator.
 *
 * Reuses the existing `"file-too-large"` WriteCode (protocol/refusal.ts) —
 * INV-I-3's own fix sketch: mirror the vocabulary `applyEditsMulti.ts:953`
 * and `tools/searchReplaceEdit.ts:190` already use for an oversized EXISTING
 * file, rather than mint a new code for the symmetrical oversized-NEW-file
 * case.
 */
export function createContentTooLargeRefusal(
  body: string,
  field: string,
  failedItem?: { index: number; path?: string },
): Record<string, unknown> {
  const bytes = Buffer.byteLength(body, "utf8");
  return {
    ok: false,
    code: "file-too-large",
    reason: "content-too-large",
    applied: false,
    field,
    ...(failedItem !== undefined ? { failed_item: failedItem } : {}),
    detail: `create:true content is ${bytes} bytes, over the ${MAX_CREATE_CONTENT_BYTES}-byte (32 KiB) create limit — split into a smaller file, or create it empty/truncated and follow up with edits[] to grow it`,
  };
}

/**
 * B1/site-6: resolving `create=true from=<source>` used to silently return
 * null on a handle/workspace mismatch, and the create branch then fell back
 * to `String(args["content"] ?? "")` — creating the file with EMPTY content.
 * This discriminated result lets the caller tell "no usable source" (fall
 * back to args.content, today's legitimate no-op path) apart from "a real
 * source handle exists but conflicts under an explicit cwd" (must refuse,
 * never silently create an empty file). When `from` names a handle and no
 * explicit cwd was supplied, the handle's own workspaceRoot is adopted and
 * returned so the caller can create the file in the SAME tree the source
 * handle was minted from.
 */
export type CreateSourceResolution =
  | { ok: true; content: string; workspace: string }
  | { ok: false; reason: "no-source" }
  | { ok: false; reason: "workspace-conflict"; entry: HandleEntry }
  | { ok: false; reason: "workspace-missing"; entry: HandleEntry };

/**
 * W2 (2026-08-07, create-frontier lifecycle): the progressive refusal that
 * replaces the bare `{"ok":false,"error":"file_exists"}` — 34 bytes, no
 * reason, no terminal flag, no unlock, no next_call, no handle — createFile.ts
 * returns when the target path already exists.
 *
 * Measured consequence of the bare shape (2026-08-07-semantic-signal5-2): the
 * caller had no served affordance at all, so it ran `rm -f <path>` and
 * re-created the file — a destructive five-turn repair of a file the same
 * session had authored four turns earlier.
 *
 * `terminal:true` is the honest verdict: createFile never overwrites, so a
 * verbatim retry can never succeed. Per the TL_REFUSAL_PROGRESS conventions a
 * terminal refusal therefore carries an `unlock`, and the way forward here is
 * the EXISTING file's identity: a kind:"file" handle minted from its current
 * on-disk bytes (the same handle an equivalent read mints and dedupes to), its
 * byte length and sha, plus `content_identical` so a caller whose create was
 * already a no-op can stop instead of editing.
 *
 * Deliberately does NOT enroll the path in the admissible edit union. Unlike a
 * SUCCESSFUL create (W1, recordCreatedEditAdmissibility), a create that
 * bounced off an existing file proves nothing about that file's content —
 * enrolling it would turn `create:true` into a blind-edit bypass of the
 * certificate frontier for any path in the tree. A path THIS session created
 * is already enrolled by W1, which is exactly the observed
 * create → frontier-refusal → file_exists → rm -f cascade this pair collapses.
 *
 * Returned through toolOk (not toolStructuredError) so the transport shape of
 * a file_exists answer is byte-for-byte the one every existing consumer sees:
 * a non-isError result whose body carries `ok:false` and the historical
 * `error:"file_exists"` token.
 */
export async function createTargetExistsRefusal(
  relPath: string,
  requestedContent: string,
  workspace: string,
): Promise<Record<string, unknown>> {
  // served-bytes: not-served (create-collision report: emits handle/bytes/sha and content_identical, never the bytes)
  const existing = await readFileSafe(relPath, workspace);
  const cwd = { cwd: workspace };
  const identical = existing !== null && existing === requestedContent;
  const entry = existing !== null
    ? handleTable.upsert({
        kind: "file",
        path: relPath,
        workspaceRoot: workspace,
        sha: shaOfText(existing),
      })
    : undefined;
  const identity = existing !== null && entry !== undefined
    ? {
        handle: entry.id,
        bytes: Buffer.byteLength(existing, "utf8"),
        sha: shortSha(shaOfText(existing)),
        content_identical: identical,
      }
    : {};
  // INTERNAL DIALECT, NOT CALLER-FACING PROSE (2026-09-20 legacy-spelling sweep).
  // The `key=value` strings in `accepted_transitions` never reach the wire as
  // text: `protocol/refusal.ts`'s `routeUnlockAlternatives` parses each one with
  // `parseProseToolCall` and the envelope's `canonicalizeEmittedToolCalls`
  // emits the result as a STRUCTURED, canonical call (`targets:[{handle}]`,
  // `content:"full"`, `task:{pull:"closure"}`…) — pinned by the
  // `refusal.edit_create_target_exists` wire baseline. Rewriting them in the
  // canonical `{…}` spelling makes them unparseable, and the wire then carries
  // a raw string instead of an executable call (measured while trying it).
  const unlock = entry === undefined
    ? {
        accepted_transitions: [`tl_read_file path=${relPath}`],
        note: "the path exists but its bytes are not readable as text (a directory, or a binary/unreadable file) — inspect it before writing",
      }
    : identical
      ? {
          accepted_transitions: ["tl_read_file mode=closure"],
          note: "the file already holds byte-identical content, so this create was a no-op — there is nothing to write; verify and finish",
        }
      : {
          accepted_transitions: [`tl_edit_file handle=${entry.id}`, `tl_read_file mode=full handle=${entry.id}`],
          note: "create:true never overwrites — edit the existing file through the handle served here, or read it first if you need its current body",
        };
  // S3 (C2-9), adjudicated 2026-08-14 — THE PRESCRIPTION MUST BE EXECUTABLE.
  //
  // The non-identical branch used to prescribe an tl_edit_file carrying
  // `EDIT_SEARCH_PLACEHOLDER` / `EDIT_REPLACE_PLACEHOLDER`, which §2.6 forbids
  // outright ("a fully substituted `ToolCall`, never a placeholder template")
  // and `emittableToolCall` therefore REJECTS — so the v1 refusal shipped with
  // no `next` at all. A refusal that withholds and names no way forward is the
  // dead-end class F5/[R5-10] exist to remove, and here it was avoidable: the
  // server is holding the caller's own `requestedContent` and a `kind:"file"`
  // handle for the existing file, which is precisely the whole-file replace
  // shape (`tl_edit_file {handle, content}`) that dispatch already accepts.
  //
  // The content is echoed back only when it FITS: a create whose body is a
  // megabyte would otherwise pay for itself twice in one refusal. Past the
  // budget the prescription degrades to reading the existing file through the
  // same handle — still fully substituted, still executable, and the second of
  // the two transitions the note already names. Neither branch is a template.
  const CREATE_RECOVERY_CONTENT_BUDGET_BYTES = 8192;
  const contentFits = Buffer.byteLength(requestedContent, "utf8") <= CREATE_RECOVERY_CONTENT_BUDGET_BYTES;
  const nextCall = entry === undefined
    ? { tool: "tl_read_file", arguments: { path: relPath, ...cwd } }
    : identical
      ? { tool: "tl_read_file", arguments: { mode: "closure", ...cwd } }
      : contentFits
        ? {
            tool: "tl_edit_file",
            arguments: {
              handle: entry.id,
              content: requestedContent,
              ...cwd,
            },
          }
        : {
            tool: "tl_read_file",
            arguments: {
              mode: "full",
              handle: entry.id,
              ...cwd,
            },
          };
  return {
    ok: false,
    // Unchanged wire fact: `error` keeps the historical machine token so the
    // remaining consumer (argMatrix's create-over-a-handle pin) keeps reading
    // the same value. The deprecated create_file tool that also read it is
    // deleted (D11).
    error: "file_exists",
    reason: "create-target-exists",
    applied: false,
    path: relPath,
    terminal: true,
    terminal_reason: "create-target-exists",
    retry_same_call: false,
    detail: `${relPath} already exists; create:true never overwrites an existing path`,
    ...identity,
    unlock,
    ...(nextCall.tool === "tl_edit_file" ? { next_call_is_template: true } : {}),
    next_call: nextCall,
  };
}

export async function resolveCreateSourceContent(
  from: unknown,
  workspace: string,
  cwdExplicit: boolean,
): Promise<CreateSourceResolution> {
  if (typeof from !== "string" || from.trim() === "") return { ok: false, reason: "no-source" };
  const source = from.trim();
  const entry = handleTable.get(source);
  if (entry) {
    let effectiveWorkspace = workspace;
    if (entry.workspaceRoot !== workspace) {
      if (cwdExplicit) return { ok: false, reason: "workspace-conflict", entry };
      // B1: adopt the source handle's own workspace — it was validated at mint
      // time. H2: but refuse if that worktree no longer exists.
      const res = resolveHandleWorkspace([entry.workspaceRoot], cwdExplicit, workspace);
      if (res.kind === "missing") return { ok: false, reason: "workspace-missing", entry };
      effectiveWorkspace = res.kind === "adopt" ? res.workspace : entry.workspaceRoot;
    }
    if (!entry.path) return { ok: false, reason: "no-source" };
    // served-bytes: not-served (create-by-copy source: these bytes become the NEW FILE, not a response body)
    const content = await readFileSafe(entry.path, effectiveWorkspace);
    if (content === null) return { ok: false, reason: "no-source" };
    const resolved = entry.range ? extractRangeText(content, entry.range) : content;
    if (resolved === null) return { ok: false, reason: "no-source" };
    return { ok: true, content: resolved, workspace: effectiveWorkspace };
  }
  // served-bytes: not-served (create-by-copy source: these bytes become the NEW FILE, not a response body)
  const plain = await readFileSafe(source, workspace);
  if (plain === null) return { ok: false, reason: "no-source" };
  return { ok: true, content: plain, workspace };
}
