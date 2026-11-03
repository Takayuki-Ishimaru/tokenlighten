// edit-review — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { EditHunkText } from "../util/verificationPack.js";
import { GO_REVIEW_TEXT_BYTES } from "../goReturnedLocalReview.js";
import { contentHasElisionMarker } from "./edit-anchor.js";
import { goPostEditReview } from "../goReturnedLocalReview.js";
import { handleTable } from "../util/handles.js";
import { identifierTokens } from "../util/verificationPack.js";
import { isRecordLike } from "./search-support.js";
import { joinPostEditNotes } from "../goReturnedLocalReview.js";
import { mineEditSignals } from "../util/verificationPack.js";
import { servedTextOrUndefined } from "../util/textDecode.js";
import { statSync } from "node:fs";

/** Hunks keyed by explicit entry path; path-less (handle-scoped) hunks key "". */
/**
 * K2 threading (2026-08-01 verify-kit-diet): identifier tokens mined from the
 * edit call's own search/replace hunk text — the exact code this edit touched.
 * Feeds buildVerificationManifest's relevance gate (options.changedIdentifiers).
 *
 * K2 tokenizer alignment (2026-08-22): reuses verificationPack.ts's own
 * identifierTokens instead of a separate ad-hoc regex (length>=3, no
 * stopwords). The two tokenizers disagreeing meant a hunk touching only
 * short/stopword text (e.g. a 3-char method name plus its `public`/`return`
 * scaffolding) could mine a set that activated the relevance gate with
 * tokens the kit side's OWN content scanner can never produce — guaranteeing
 * zero overlap and dropping a real referencing test regardless of how
 * plainly it exercised the edit. Reusing identifierTokens closes the
 * mismatch by construction. Exported for verificationPack.spec.ts, which
 * reproduces the asymmetry directly against this function feeding
 * buildVerificationManifest's changedIdentifiers.
 */
export function identifiersFromEditArgs(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const hunks of editHunksByPath(args).values()) {
    for (const hunk of hunks) {
      for (const text of [hunk.search, hunk.replace]) {
        if (typeof text !== "string") continue;
        for (const tok of identifierTokens(text)) out.add(tok);
      }
    }
  }
  return [...out];
}

/**
 * 2026-10-29 (click/core.py report): what the verification kit should look for
 * in a test — the identifiers and string literals on the lines this edit
 * removed or added (mineEditSignals), not every token of both hunks. A hunk
 * usually quotes context lines on both sides to anchor its search text; those
 * made a one-line fix look like it touched the whole neighbourhood. A
 * range-addressed item (`content`, no `search`) contributes its new lines only,
 * and a `create` item contributes nothing: a new file's tokens are not a change
 * to existing behaviour. Separate from `identifiersFromEditArgs`, whose
 * whole-hunk tokens still feed Rule B's unread-note specificity.
 */
export function verificationSignalsFromEditArgs(args: Record<string, unknown>): { identifiers: string[]; literals: string[] } {
  const hunks: EditHunkText[] = [];
  const take = (entry: Record<string, unknown>): void => {
    if (entry["create"] === true) return;
    const search = typeof entry["search"] === "string" ? entry["search"] : undefined;
    const replace = typeof entry["replace"] === "string" ? entry["replace"] : undefined;
    const content = search === undefined && replace === undefined && typeof entry["content"] === "string"
      ? entry["content"]
      : undefined;
    if (search === undefined && replace === undefined && content === undefined) return;
    hunks.push({
      ...(search !== undefined ? { search } : {}),
      ...(replace !== undefined ? { replace } : {}),
      ...(content !== undefined ? { content } : {}),
    });
  };
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const entry of edits) if (isRecordLike(entry)) take(entry);
  } else {
    take(args);
  }
  return mineEditSignals(hunks);
}

export function editHunksByPath(args: Record<string, unknown>): Map<string, Array<{ search?: string; replace?: string }>> {
  const map = new Map<string, Array<{ search?: string; replace?: string }>>();
  const push = (p: string, h: { search?: string; replace?: string }) => {
    const list = map.get(p);
    if (list === undefined) map.set(p, [h]);
    else list.push(h);
  };
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e === null || typeof e !== "object") continue;
      const entry = e as { path?: unknown; search?: unknown; replace?: unknown };
      push(typeof entry.path === "string" ? entry.path : "", {
        ...(typeof entry.search === "string" ? { search: entry.search } : {}),
        ...(typeof entry.replace === "string" ? { replace: entry.replace } : {}),
      });
    }
  } else if (typeof args["search"] === "string" && typeof args["replace"] === "string") {
    push("", { search: args["search"] as string, replace: args["replace"] as string });
  }
  return map;
}

/**
 * R2-PEW (review P2-b): every replacement TEXT one edit call put into the file
 * `relPath`, for the multi-hunk scan that names each hunk's post-edit place —
 * a search/replace item's `replace`, or a range-handle item's `content` (the
 * lines it swapped in), whichever way the item addresses the file: an explicit
 * `path`, or a `handle` (resolved through the handle table). An item that names
 * neither addresses the call's only file when there is only one (`soleFile`).
 * `all` is true when one of them is a `target:"all"` item — ONE item that lands
 * in every place its text occurs. Deliberately separate from
 * `editHunksByPath`, which feeds the brace budget and the verification kit's
 * identifier mining and must not learn about `content`.
 */
export function postEditReplacementTexts(
  args: Record<string, unknown>,
  workspace: string,
  relPath: string,
  soleFile: boolean,
): { texts: string[]; all: boolean } {
  const texts: string[] = [];
  let all = false;
  const relative = (p: string): string => (path.isAbsolute(p) ? path.relative(workspace, p) : p).split(path.sep).join("/");
  const wanted = relative(relPath);
  const take = (entry: Record<string, unknown>): void => {
    const addressed = typeof entry["path"] === "string" && entry["path"] !== ""
      ? entry["path"]
      : typeof entry["handle"] === "string" ? handleTable.get(entry["handle"])?.path : undefined;
    if (addressed === undefined || addressed === "" ? !soleFile : relative(addressed) !== wanted) return;
    const text = typeof entry["replace"] === "string"
      ? entry["replace"]
      : typeof entry["content"] === "string" ? entry["content"] : undefined;
    if (text === undefined) return;
    texts.push(text);
    if (entry["target"] === "all") all = true;
  };
  const edits = args["edits"];
  if (Array.isArray(edits)) {
    for (const e of edits) if (isRecordLike(e)) take(e);
  } else {
    take(args);
  }
  return { texts, all };
}

/**
 * TL_EFF_EDIT_DIET (2026-10-19, v016 decision 6t-3): would `relPath`'s
 * post-edit window only echo what the caller already holds? Measured: arm A
 * received 108.8 KB of `applied[].after.body` across 27 `edit.applied` replies,
 * the windows around replacements the caller had just sent.
 *
 * True only when every item the caller SENT for this file (`sent`, captured
 * before any in-place rewrite) is a plain `search`/`replace` or a `content`
 * replacement whose new text occurs in the post-edit file (`postText`)
 * verbatim and exactly once — which proves it landed as sent and at one site —
 * and nothing between the request and the disk changed it:
 *   - no CR in the file: the server writes the file's own line endings, not
 *     the LF the caller sent;
 *   - no escape or whitespace recovery recorded for the path
 *     (`normalized_escapes`/`normalized_whitespace`, a path list from the
 *     batch engine or `true` from the single-edit one);
 *   - no `target:"all"` item (one item, several sites), no elision marker
 *     (the server resolved the elided text from disk), no intent/rename/create;
 *   - none of the projector's own safety exceptions (`review`, a fence
 *     re-typing, an orphan-tail `warning`/`leftoverLines`), which ship the
 *     full post-edit slice on purpose.
 * A replacement whose text occurs twice (a range-scoped replace-all that hit
 * twice, or the same text already elsewhere in the file) and a deletion
 * (empty new text, nothing to find) keep the window: neither proves a single
 * verbatim landing.
 */
export function postEditEchoTexts(
  sent: Record<string, unknown>,
  result: Record<string, unknown>,
  workspace: string,
  relPath: string,
  soleFile: boolean,
  postText: string,
): string[] | undefined {
  if (postText.includes("\r")) return undefined;
  for (const key of ["review", "reclassified", "warning", "leftoverLines"]) {
    if (result[key] !== undefined) return undefined;
  }
  const relative = (p: string): string => (path.isAbsolute(p) ? path.relative(workspace, p) : p).split(path.sep).join("/");
  const wanted = relative(relPath);
  for (const key of ["normalized_escapes", "normalized_whitespace"]) {
    const value = result[key];
    if (value === true) return undefined;
    if (Array.isArray(value) && value.some((entry) => typeof entry === "string" && relative(entry) === wanted)) return undefined;
  }
  const items: unknown[] = Array.isArray(sent["edits"]) ? sent["edits"] as unknown[] : [sent];
  const texts: string[] = [];
  for (const raw of items) {
    if (!isRecordLike(raw)) return undefined;
    const item = raw;
    const addressed = typeof item["path"] === "string" && item["path"] !== ""
      ? item["path"]
      : typeof item["handle"] === "string" ? handleTable.get(item["handle"])?.path : undefined;
    if (addressed === undefined || addressed === "" ? !soleFile : relative(addressed) !== wanted) continue;
    if (item["target"] !== undefined || item["create"] === true || item["intent"] !== undefined || item["mode"] !== undefined) return undefined;
    let text: string;
    if (typeof item["search"] === "string" && item["search"] !== "" && typeof item["replace"] === "string" && item["content"] === undefined) {
      text = item["replace"];
    } else if (typeof item["content"] === "string" && item["search"] === undefined && item["replace"] === undefined) {
      text = item["content"].endsWith("\n") ? item["content"].slice(0, -1) : item["content"];
    } else {
      return undefined;
    }
    if (text.trim() === "" || text.includes("\r")) return undefined;
    if (contentHasElisionMarker(item["search"]) || contentHasElisionMarker(text)) return undefined;
    const first = postText.indexOf(text);
    if (first === -1 || postText.indexOf(text, first + 1) !== -1) return undefined;
    texts.push(text);
  }
  return texts.length > 0 ? texts : undefined;
}

/**
 * TL_EFF_EDIT_DIET (2026-10-19): the post-edit lines made ENTIRELY of text the
 * caller sent — each of `texts` occurs exactly once in `postText`
 * (`postEditEchoTexts` proved it). A line the caller's text covers only in
 * part (the text starts after the line's first byte, or stops before its end)
 * still holds bytes the caller did not send at this revision, so it is not
 * counted. 1-based, merged.
 */
export function authoredFullLineSpans(postText: string, texts: readonly string[]): Array<[number, number]> {
  const lineOf = (index: number): number => {
    let line = 1;
    for (let i = 0; i < index; i += 1) if (postText.charCodeAt(i) === 10) line += 1;
    return line;
  };
  const spans: Array<[number, number]> = [];
  for (const text of texts) {
    const start = postText.indexOf(text);
    if (start === -1 || text.length === 0) continue;
    const end = start + text.length;
    const startsAtLineStart = start === 0 || postText[start - 1] === "\n";
    const endsAtLineEnd = text.endsWith("\n") || end === postText.length || postText[end] === "\n";
    const first = lineOf(start) + (startsAtLineStart ? 0 : 1);
    const last = lineOf(end - 1) - (endsAtLineEnd ? 0 : 1);
    if (first <= last) spans.push([first, last]);
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** What `attachAppliedReadback` stages, per echo path, for `holdServerEditAuthoredLines` (state/session.ts). */
export interface StagedAuthoredLines {
  sha: string;
  totalLines: number;
  spans: Array<[number, number]>;
}

// ---------------------------------------------------------------------------
// R1 (2026-10-22, codex-copilot-proxy r18 T07): the edit-time half of the Go
// returned-local review.
//
// Agents fixed the first of T07's two sites in `Compute` (the fixed
// `normalSide`), ran the tests, and found the second (the unconditional
// `b.Net` overwrite after the loop) only in a second edit cycle. When an edit
// changes a Go function above a final write of a field its return reads and
// leaves that write unchanged, the reply carries `review_note`, a source-order
// fact (`goPostEditReview`) per edited file, two files at most, one per line.
// A note compares the file before and after the write, so the call snapshots
// the Go files it addresses before any byte is written. The snapshot lives in
// the call (no module state) and is bounded; every failure here loses only the
// note, never the edit.
//
// 2026-10-24 (generality audit §3.9): a file is snapshotted up to
// GO_REVIEW_TEXT_BYTES, not only the 12 KiB the whole-file analysis reads: a larger
// file is analysed per function (goReturnedLocalReview.ts), and the note fires only
// for a code change that can reach the call, not for any change above the write.
// ---------------------------------------------------------------------------
export const GO_REVIEW_MAX_FILES = 4;

/** The absolute path of the non-test Go file `candidate` names under `root`, when it lies inside `root`. */
export function goReviewTarget(root: string, candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || candidate === "" || /[\0\r\n]/u.test(candidate)) return undefined;
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return undefined;
  return absolute.endsWith(".go") && !absolute.endsWith("_test.go") ? absolute : undefined;
}

/** The file's served text, when it is small enough for the review to read. */
export function goReviewText(absolute: string): string | undefined {
  try {
    if (statSync(absolute).size > GO_REVIEW_TEXT_BYTES) return undefined;
    // served-bytes: readServedText
    const text = servedTextOrUndefined(absolute);
    return text !== undefined && Buffer.byteLength(text, "utf8") <= GO_REVIEW_TEXT_BYTES ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The pre-edit text of up to four Go files of at most GO_REVIEW_TEXT_BYTES an edit call addresses (by handle or path), keyed by absolute path. */
export function snapshotGoEditTargets(workspace: string, args: Record<string, unknown>): Map<string, string> {
  const snapshot = new Map<string, string>();
  try {
    for (const item of Array.isArray(args["edits"]) ? args["edits"] : [args]) {
      if (snapshot.size >= GO_REVIEW_MAX_FILES) break;
      if (!isRecordLike(item)) continue;
      const entry = typeof item["handle"] === "string" ? handleTable.get(item["handle"]) : undefined;
      const absolute = entry !== undefined
        ? goReviewTarget(entry.workspaceRoot, entry.path)
        : goReviewTarget(workspace, item["path"]);
      if (absolute === undefined || snapshot.has(absolute)) continue;
      const text = goReviewText(absolute);
      if (text !== undefined) snapshot.set(absolute, text);
    }
  } catch {
    snapshot.clear();
  }
  return snapshot;
}

/**
 * The `goPostEditReview` notes of the edited files that were snapshotted before the write, one per file in
 * edit order and two at most, as the one `review_note` string (`joinPostEditNotes`).
 */
export async function goPostEditReviewNote(
  workspace: string,
  snapshot: ReadonlyMap<string, string>,
  editedPaths: readonly string[],
): Promise<string | undefined> {
  const notes: string[] = [];
  const seen = new Set<string>();
  try {
    for (const edited of editedPaths) {
      if (notes.length >= 2) break;
      const absolute = goReviewTarget(workspace, edited);
      const before = absolute === undefined ? undefined : snapshot.get(absolute);
      if (absolute === undefined || before === undefined || seen.has(absolute)) continue;
      seen.add(absolute);
      const after = goReviewText(absolute);
      if (after === undefined) continue;
      const note = await goPostEditReview({
        path: path.relative(workspace, absolute).split(path.sep).join("/"),
        before,
        after,
      });
      if (note !== undefined) notes.push(note);
    }
  } catch {
    // The edit has landed; the notes found so far, if any, still ride.
  }
  return joinPostEditNotes(notes);
}
