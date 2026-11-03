// edit-review — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { StagedAuthoredLines } from "./edit-review.js";
import { AFTER_CONTEXT_LINES } from "./verification2.js";
import { AFTER_ENTRY_CAP_BYTES } from "./verification2.js";
import { AFTER_TOTAL_CAP_BYTES } from "./verification2.js";
import { APPLIED_CONTEXT_LINES } from "./verification2.js";
import { APPLIED_ENTRY_CAP_BYTES } from "./verification2.js";
import { APPLIED_MAX_ENTRIES } from "./verification2.js";
import { APPLIED_TOTAL_CAP_BYTES } from "./verification2.js";
import { EFF_SLIM_AFTER_CONTEXT_LINES } from "./verification2.js";
import { POST_EDIT_HUNK_CANDIDATE_CAP } from "./verification2.js";
import { authoredFullLineSpans } from "./edit-review.js";
import { beginServeCall } from "../state/session.js";
import { braceDelta } from "./verification2.js";
import { editHunksByPath } from "./edit-review.js";
import { effSlimEditEnabled } from "../util/flags.js";
import { extractSymbolsFromFile } from "../tools/readCodeModes.js";
import { holdServerEditAuthoredLines } from "../state/session.js";
import { isRecordLike } from "./search-support.js";
import { locatePostEditHunkSpans } from "./verification2.js";
import { postEditEchoTexts } from "./edit-review.js";
import { postEditReplacementTexts } from "./edit-review.js";
import { postEditSearchIndex } from "./verification2.js";
import { projectEditBody } from "../protocol/editFamily.js";
import { recordServedRange } from "../state/session.js";
import { servedTextOrUndefined } from "../util/textDecode.js";
import { shaOfText } from "../util/handles.js";
import { windowAroundSpan } from "./verification2.js";

/**
 * G1 read-back (2026-07-26 desertion forensics): 25 "read back what I just
 * changed" native escapes + 11 grep-brace-count turns happened because an
 * edit success carried zero post-edit evidence. Serve the applied region
 * (±8 lines, from disk — the authoritative post-write state) and the hunk
 * brace budget on the success response itself.
 *
 * R2-PEW (review P0-1): this function BUILDS the wide `after` windows and BOOKS
 * NOTHING. A window built here can still be shrunk or dropped by
 * `shedPostEditWindowsToFit` (a host/user byte ceiling) before it ships, and a
 * ledger entry written now would claim lines that never left the server — a
 * later `tl_read_file` of them would be answered with a receipt for bytes nobody
 * holds. What this function stages instead is `stagedAfterWindows` (per path:
 * the sha of the text the window was cut from, and that text's real line
 * count); `bookShippedPostEditWindows` books from the FINAL response, after the
 * shed, so the ledger holds exactly the post-edit lines that shipped.
 *
 * TL_EFF_EDIT_DIET (2026-10-19): `sentArgs` (the caller's edit as sent, passed
 * only while the diet is on) lets a file whose post-edit window would only
 * echo the caller's own text (`postEditEchoTexts`) ship without `after`. No
 * window is staged for it; instead `stagedAuthoredLines` receives the lines
 * the caller wrote, which `finishEdit` holds at the post-edit sha
 * (`holdServerEditAuthoredLines`) so the file's served-range entry still moves
 * to the revision this edit wrote.
 */
export async function attachAppliedReadback(
  result: Record<string, unknown>,
  args: Record<string, unknown>,
  workspace: string,
  stagedAfterWindows?: Map<string, StagedPostEditWindow>,
  sentArgs?: Record<string, unknown>,
  stagedAuthoredLines?: Map<string, StagedAuthoredLines>,
): Promise<Record<string, unknown>> {
  try {
    const single = typeof (result as { path?: unknown }).path === "string"
      ? [{
          path: (result as { path: string }).path,
          lines: (result as { lines?: unknown }).lines,
          total_lines: (result as { total_lines?: unknown }).total_lines,
        }]
      : [];
    const files = Array.isArray((result as { files?: unknown }).files)
      ? ((result as { files: Array<{ path?: unknown; lines?: unknown; total_lines?: unknown }> }).files)
      : single;
    if (files.length === 0) return result;
    const hunks = editHunksByPath(args);
    const distinctPaths = new Set(files.map((f) => f.path));
    const applied: Array<Record<string, unknown>> = [];
    let total = 0;
    // PEW (v0.15.0): running total for `AppliedEntry.after`, the WIDE
    // post-edit window — a SEPARATE budget from `total`/APPLIED_TOTAL_CAP_BYTES
    // above (that one still governs the compact `code` proof, unchanged).
    let afterTotal = 0;
    const contentCache = new Map<string, string[] | null>();
    let wholeFileEntries = 0;
    // TL_EFF_EDIT_DIET: entries whose `after` was left out as an echo.
    let echoEntries = 0;
    for (const f of files.slice(0, APPLIED_MAX_ENTRIES)) {
      if (typeof f.path !== "string") continue;
      // Terminal proof for create (2026-08-22): a create carries no edited
      // span — the whole file is new, so createFile's dispatch reports
      // `total_lines` instead of `lines` (editFamily.ts's editedRows already
      // normalizes this same asymmetry for the wire `range`). Treat it the
      // same way here so a create earns the SAME slice_sha/head/applied_note
      // terminal proof a search/replace edit already gets, instead of the
      // caller re-reading its own just-written bytes to confirm them.
      const linesSpec = typeof f.lines === "string"
        ? f.lines
        : typeof f.total_lines === "number"
          ? `1-${Math.max(1, f.total_lines)}`
          : undefined;
      if (linesSpec === undefined) continue;
      const m = linesSpec.match(/^(\d+)(?:-(\d+))?$/);
      if (m === null) continue;
      const start = parseInt(m[1]!, 10);
      const end = m[2] !== undefined ? parseInt(m[2], 10) : start;
      let lines = contentCache.get(f.path);
      if (lines === undefined) {
        // served-bytes: readServedText
        // AB1 (2026-09-14, review round 11): `applied[].code` IS a served body —
        // the post-edit disk slice this response puts on the wire, with a
        // `slice_sha` over it. A raw `readFileSync(..., "utf8")` here served
        // whatever bytes were on disk, so an edit to a file carrying an
        // incidental NUL (or an editor's BOM-less UTF-16 re-save between the
        // write and this read-back) shipped them verbatim inside a success
        // response. `servedTextOrUndefined` is the same policy every read door
        // is gated on; an undecodable file simply carries no read-back (the
        // entry is skipped), which is exactly what this optional evidence
        // already does for an unreadable one.
        // served-bytes: readServedText
        const servedBack = servedTextOrUndefined(path.join(workspace, f.path));
        lines = servedBack === undefined ? null : servedBack.split("\n");
        contentCache.set(f.path, lines);
      }
      if (lines === null) continue;
      // A create (total_lines, no `lines` span) IS the whole file: no ±context
      // and no enclosing-symbol upgrade apply, and the window must not run
      // past total_lines onto the phantom "" that `.split("\n")` yields after
      // a final newline (editFamily.spec A.5.11 pins `range:"1-1"` for a
      // one-line create; the old synthesized entry already said so).
      const wholeFile = typeof f.lines !== "string";
      // R2-PEW (review P2-a): `.split("\n")` yields one PHANTOM empty segment
      // after a file's final newline — a 13-line file has 14 segments. The WIDE
      // `after` window and the ledger booking behind it count REAL lines only
      // (`after.range` naming "1-14" on a 13-line file named a line that does
      // not exist). The phantom is still part of the TEXT of an `after` window
      // that reaches the last real line — the trailing newline `tl_read_file` of
      // that same range returns (util/countLines.ts `sliceLinesToText`). The
      // compact ±8 proof (`range`/`code`/`slice_sha`/`enclosing_symbol`) is
      // NOT touched: it is v0.14.4 wire behavior other specs pin (an A7 batch
      // relies on `lines` differing from a phantom-inflated `range`).
      const hasPhantom = lines.length > 1 && lines[lines.length - 1] === "";
      const lineCount = hasPhantom ? lines.length - 1 : lines.length;
      const realLines = hasPhantom ? lines.slice(0, lineCount) : lines;
      const windowLines = (a: number, b: number): string[] =>
        lines.slice(a - 1, hasPhantom && b >= lineCount ? b + 1 : b);
      let from = wholeFile ? 1 : Math.max(1, start - APPLIED_CONTEXT_LINES);
      let to = wholeFile ? Math.min(lines.length, end) : Math.min(lines.length, end + APPLIED_CONTEXT_LINES);
      if (to < from) continue;
      // Enclosing-symbol upgrade (2026-07-26 run-A T13 relapse): a hunk inside
      // a function larger than the ±8 window forced a native sed of the whole
      // function body. Serve the smallest enclosing symbol instead when it
      // fits the entry cap; when it does not, NAME it with its range so one
      // handle re-slice replaces the native read.
      let enclosing: { symbol: string; range: string } | undefined;
      try {
        if (wholeFile) throw new Error("whole-file entry: no enclosing-symbol upgrade");
        const symbols = await extractSymbolsFromFile(lines.join("\n"), f.path, 256);
        let best: { name: string; s: number; e: number } | undefined;
        for (const sym of symbols) {
          const sm = sym.range.match(/^(\d+)-(\d+)$/);
          if (sm === null) continue;
          const s = parseInt(sm[1]!, 10);
          const e = parseInt(sm[2]!, 10);
          if (s <= start && end <= e && (best === undefined || e - s < best.e - best.s)) {
            best = { name: sym.name, s, e };
          }
        }
        if (best !== undefined && (best.s < from || best.e > to)) {
          const symBytes = Buffer.byteLength(lines.slice(best.s - 1, best.e).join("\n"), "utf8");
          if (symBytes <= APPLIED_ENTRY_CAP_BYTES) {
            from = best.s;
            to = best.e;
          } else {
            enclosing = { symbol: best.name, range: `${best.s}-${best.e}` };
          }
        }
      } catch {
        // regex scan failed — the ±8 window still serves.
      }
      const window = lines.slice(from - 1, to);
      const kept: string[] = [];
      let bytes = 0;
      for (const ln of window) {
        bytes += Buffer.byteLength(ln, "utf8") + 1;
        if (bytes > APPLIED_ENTRY_CAP_BYTES) break;
        kept.push(ln);
      }
      const code = kept.join("\n");
      const entryBytes = Buffer.byteLength(code, "utf8");
      if (entryBytes === 0 || total + entryBytes > APPLIED_TOTAL_CAP_BYTES) continue;
      total += entryBytes;
      const ownHunks = [
        ...(hunks.get(f.path) ?? []),
        ...(distinctPaths.size === 1 ? hunks.get("") ?? [] : []),
      ];
      const deltaKnown = ownHunks.length > 0
        && ownHunks.every((h) => typeof h.search === "string" && typeof h.replace === "string");
      const delta = deltaKnown
        ? ownHunks.reduce((s, h) => s + braceDelta(h.search!, h.replace!), 0)
        : undefined;
      if (wholeFile) {
        // A create's content is what the caller just sent: the top-level
        // sha/bytes/total_lines already prove it, so the entry carries no
        // slice echo (no code → editFamily adds no slice_sha/head) — the
        // terminal signal is the applied_note below (Phase 5 compactness:
        // writeResponseSize.spec CREATE_CORE_CAP).
        wholeFileEntries += 1;
        applied.push({ path: f.path, range: `${from}-${to}` });
        continue;
      }
      // PEW (v0.15.0): the WIDE post-edit verification window
      // (`AppliedEntry.after`) — additive to, never a replacement for,
      // `code`/`enclosing_symbol` above (own ±8/2 KiB budget, untouched).
      // Skipped only for `wholeFile` (create) entries, handled by the
      // `continue` above — a create's body is what the caller just sent, so
      // there is nothing new to show back.
      let entryAfter: { range: string; body: string; remaining?: string[] } | undefined;
      // TL_EFF_EDIT_DIET: a window that would only echo what the caller sent
      // (and the lines around it it was served) is not built at all.
      // A nonzero brace delta is the read-back's own safety signal (it makes
      // the projector ship the full post-edit slice), so it keeps the window.
      const postText = lines.join("\n");
      // So does an edit that removes lines: what it left is the seam around them,
      // which it did not send, and solvers read it back in a turn of their own
      // (code-fix probe, 2026-11-02: 3 of 3 runs without the window, 1 of 3 with it).
      const removesLines = ownHunks.some((hunk) => typeof hunk.search === "string" && typeof hunk.replace === "string"
        && hunk.replace.split("\n").length < hunk.search.split("\n").length);
      const echoTexts = sentArgs !== undefined && (delta === undefined || delta === 0) && !removesLines
        ? postEditEchoTexts(sentArgs, result, workspace, f.path, distinctPaths.size === 1, postText)
        : undefined;
      const echo = echoTexts !== undefined;
      if (echo) {
        echoEntries += 1;
        // No window ships, so nothing books this file at its new revision;
        // stage the lines the caller itself wrote for `finishEdit` to hold
        // (`holdServerEditAuthoredLines`), which also moves the file's
        // served-range entry off the pre-edit sha.
        stagedAuthoredLines?.set(f.path, {
          sha: shaOfText(postText),
          totalLines: lineCount,
          spans: authoredFullLineSpans(postText, echoTexts),
        });
      }
      if (!echo) {
        // EFF (TL_EFF_SLIM_EDIT): no symbol scan, so the window never widens.
        const slimAfter = effSlimEditEnabled();
        let afterSymbols: Array<{ name: string; range: string }> = [];
        if (!slimAfter) {
          try {
            afterSymbols = await extractSymbolsFromFile(lines.join("\n"), f.path, 256);
          } catch {
            // regex scan failed — the padded window still serves, unextended.
          }
        }
        // A merged multi-hunk file's OWN chain-final span (`start`/`end`
        // here, from `f.lines`) is the ONLY span applyEditsMulti.ts's result
        // names (its merge comment: a merged chain reports "the FINAL edit's
        // line range" by design) — recover the OTHER hunks' post-edit spans
        // best-effort so a batch that touched two distant parts of one file
        // gets a window near EACH, not only the last. A hunk this scan misses
        // (an earlier hunk's text further altered by a later one, or a
        // block too common to name) simply does not contribute an extra
        // window; the chain-final span below is independent of this scan and
        // always present.
        //
        // R2-PEW (review P2-b): a hunk's `replace` text is all this scan has,
        // and text does not say WHERE a repeated block came from. So every
        // occurrence of a text that occurs a handful of times is a candidate
        // span (the window around the right one is shown or named in
        // `remaining`; an extra one names one more range), and a text too
        // common to be information keeps none — see
        // `locatePostEditHunkSpans`.
        const hunkSpans: Array<{ start: number; end: number }> = [];
        // A `target:"all"` item is several places at once: it is scanned like a
        // batch even when it is the file's only item.
        const replacements = postEditReplacementTexts(args, workspace, f.path, distinctPaths.size === 1);
        if (replacements.texts.length > 1 || replacements.all) {
          const searchIndex = postEditSearchIndex(realLines);
          for (const text of replacements.texts) {
            const occurrences = locatePostEditHunkSpans(searchIndex, text);
            if (occurrences.length > 0 && occurrences.length <= POST_EDIT_HUNK_CANDIDATE_CAP) {
              hunkSpans.push(...occurrences);
            }
          }
        }
        if (!hunkSpans.some((s) => s.start <= start && end <= s.end)) {
          hunkSpans.push({ start, end });
        }
        hunkSpans.sort((a, b) => a.start - b.start || a.end - b.end);
        const padded = hunkSpans.map((span) => ({
          ...windowAroundSpan(
            realLines,
            span,
            slimAfter ? EFF_SLIM_AFTER_CONTEXT_LINES : AFTER_CONTEXT_LINES,
            AFTER_ENTRY_CAP_BYTES,
            afterSymbols,
          ),
          anchor: span.start <= start && end <= span.end,
        }));
        // Merge windows that overlap or touch (several hunks in one file
        // whose padded windows overlap collapse into ONE shown window) — but
        // only while the merged window still SHOWS the chain-final hunk (the
        // anchor). A window is cut from its TAIL at the per-entry cap, so a
        // merge whose cap boundary falls above the anchor's last line would
        // push the anchor — usually the lowest hunk — out of what is shown; the
        // windows then stay apart, the anchor's own is the one shown, and the
        // other is named. (A merge whose tail is cut BELOW the anchor is as it
        // always was: the tail is named in `remaining`.)
        const groupBytes = (a: number, b: number): number => Buffer.byteLength(windowLines(a, b).join("\n"), "utf8");
        const merged: Array<{ from: number; to: number; anchor: boolean }> = [];
        for (const p of padded) {
          const last = merged[merged.length - 1];
          if (last !== undefined && p.from <= last.to + 1) {
            const to = Math.max(last.to, p.to);
            const holdsAnchor = last.anchor || p.anchor;
            if (!holdsAnchor || groupBytes(last.from, Math.min(to, Math.max(end, last.from))) <= AFTER_ENTRY_CAP_BYTES) {
              last.to = to;
              last.anchor = holdsAnchor;
              continue;
            }
          }
          merged.push({ ...p });
        }
        // The PRIMARY shown window is whichever merged group contains this
        // entry's own `range` (`from`-`to` above) — the same anchor every
        // other field on this entry is keyed to. Every other merged group is
        // named, not shown, in `remaining` — minus any line the primary group
        // already covers (groups kept apart by the cap above can overlap it).
        const primary = merged.find((group) => group.anchor) ?? merged[0];
        if (primary !== undefined) {
          const outside: Array<{ from: number; to: number }> = [];
          for (const group of merged) {
            if (group === primary) continue;
            if (group.from < primary.from) outside.push({ from: group.from, to: Math.min(group.to, primary.from - 1) });
            if (group.to > primary.to) outside.push({ from: Math.max(group.from, primary.to + 1), to: group.to });
          }
          outside.sort((a, b) => a.from - b.from || a.to - b.to);
          const named: Array<{ from: number; to: number }> = [];
          for (const range of outside) {
            const last = named[named.length - 1];
            if (last !== undefined && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
            else named.push({ ...range });
          }
          const remainingRanges = named.map((range) => `${range.from}-${range.to}`);
          // Per-hunk cap AND whatever is left of the per-response cap — the
          // response-level shed (AFTER_TOTAL_CAP_BYTES) falls on WHICHEVER
          // file's window this loop reaches once the budget is spent, same
          // first-come-first-served rule `total`/APPLIED_TOTAL_CAP_BYTES
          // already applies to `code` above.
          const afterBudget = Math.min(AFTER_ENTRY_CAP_BYTES, AFTER_TOTAL_CAP_BYTES - afterTotal);
          if (afterBudget > 0) {
            const win = windowLines(primary.from, primary.to);
            const keptAfter: string[] = [];
            let afterBytes = 0;
            for (const ln of win) {
              const lnBytes = Buffer.byteLength(ln, "utf8") + 1;
              if (afterBytes + lnBytes > afterBudget) break;
              afterBytes += lnBytes;
              keptAfter.push(ln);
            }
            const afterBody = keptAfter.join("\n");
            const afterBodyBytes = Buffer.byteLength(afterBody, "utf8");
            if (afterBodyBytes > 0) {
              afterTotal += afterBodyBytes;
              // REAL lines shown: the phantom segment `windowLines` appends
              // after a final newline rides in the body's text, never in the
              // range it names.
              const shownTo = primary.from + Math.min(keptAfter.length, primary.to - primary.from + 1) - 1;
              // A window cut mid-way by either cap is named, never silently
              // dropped: the untold tail joins the other merged groups in
              // `remaining`, each independently re-fetchable with an ordinary
              // ranged `tl_read_file`.
              const cutRemainder = shownTo < primary.to ? [`${shownTo + 1}-${primary.to}`] : [];
              const remaining = [...cutRemainder, ...remainingRanges];
              entryAfter = {
                range: `${primary.from}-${shownTo}`,
                body: afterBody,
                ...(remaining.length > 0 ? { remaining } : {}),
              };
              // Ledger booking (PEW requirement 2) is NOT done here — see this
              // function's doc comment (review P0-1). What the booking will
              // need from THIS moment — the text the window was cut from — is
              // staged; `bookShippedPostEditWindows` books the window that
              // actually ships, after the byte-ceiling shed.
              stagedAfterWindows?.set(f.path, { sha: shaOfText(lines.join("\n")), totalLines: lineCount });
            }
          }
        }
      }
      applied.push({
        path: f.path,
        range: `${from}-${to}`,
        code,
        ...(delta !== undefined ? { brace_delta: delta } : {}),
        ...(enclosing !== undefined ? { enclosing_symbol: enclosing } : {}),
        ...(entryAfter !== undefined ? { after: entryAfter } : {}),
      });
    }
    if (applied.length === 0) return result;
    return {
      ...result,
      applied,
      // B1 (v0.12, compact edit receipt): shortened to a minimal honest
      // pointer — the mechanics these used to spell out (context-window
      // choice, brace_delta/enclosing_symbol interpretation) move to the
      // guide (residency amplification 8.578x makes every response byte
      // expensive across the rest of the session). Emission condition and
      // field identity are unchanged; only the prose shrank.
      // TL_EFF_EDIT_DIET: an entry whose `after` was left out as an echo
      // states the same fact a create does — what is on disk is what was sent.
      applied_note: wholeFileEntries + echoEntries === applied.length
        ? "post-edit disk state = content sent — no follow-up read needed"
        : "post-edit disk state — no follow-up read needed",
    };
  } catch {
    return result;
  }
}

/** True iff `value` is a well-formed `PostEditWindow` shape, loosely — same tolerance `editFamily.ts`'s own `postEditWindowOf` validator applies at the wire boundary. Used only to decide whether shrinking is worth attempting. */
export function isPostEditWindowLike(value: unknown): value is { range: string; body: string; remaining?: string[] } {
  return isRecordLike(value) && typeof value["range"] === "string" && typeof value["body"] === "string";
}

/**
 * A window's own lines, as its `range` and `body` together state them: the
 * range's bounds and one string per REAL line the range names (the extra empty
 * segment a body gets when its window ends at a file's final newline is text,
 * not a line, and is not in the list). `undefined` when `range` is not a plain
 * `N-M` span — a window that cannot say which lines it holds cannot be cut
 * honestly and is dropped whole instead.
 */
export function postEditWindowLinesOf(
  after: { range: string; body: string },
): { rangeStart: number; rangeEnd: number; lines: string[] } | undefined {
  const rangeMatch = after.range.match(/^(\d+)-(\d+)$/);
  if (rangeMatch === null) return undefined;
  const rangeStart = parseInt(rangeMatch[1]!, 10);
  const rangeEnd = parseInt(rangeMatch[2]!, 10);
  if (rangeEnd < rangeStart) return undefined;
  return { rangeStart, rangeEnd, lines: after.body.split("\n").slice(0, rangeEnd - rangeStart + 1) };
}

/**
 * PEW (v0.15.0): `after` cut to its first `keptLines` lines, the cut tail moved
 * into `remaining` — the SAME partial-cut idiom `attachAppliedReadback`
 * already applies for its own per-hunk cap, reused here so a ceiling-driven cut
 * is exactly as honest as a cap-driven one (`range` always matches what `body`
 * still covers; nothing is truncated without saying so). `keptLines` at or past
 * the window's own length is the window unchanged.
 */
export function cutPostEditWindowToLines(
  after: { range: string; body: string; remaining?: string[] },
  window: { rangeStart: number; rangeEnd: number; lines: readonly string[] },
  keptLines: number,
): { range: string; body: string; remaining?: string[] } {
  if (keptLines >= window.lines.length) return after;
  const shownTo = window.rangeStart + keptLines - 1;
  const remaining = [`${shownTo + 1}-${window.rangeEnd}`, ...(after.remaining ?? [])];
  return { range: `${window.rangeStart}-${shownTo}`, body: window.lines.slice(0, keptLines).join("\n"), remaining };
}

/**
 * PEW (v0.15.0) requirement 3 — under a declared caller/host byte ceiling
 * (VS Code's client-profile default, or its `TOKENLIGHTEN_TASK_PACK_MAX_BYTES`
 * override; `dispatchTool`'s own `defaultResponseByteCeiling`, threaded in by
 * `finishEdit` below), `after` windows are the FIRST thing shed — before the
 * verification kit, before `core`/`applied`'s other fields, before anything
 * else this response carries. `finishEdit` calls this LAST, wrapping
 * `augmentEdit`'s fully-assembled result (kit/closure/hint already attached),
 * so "first shed" is really "last computed against the real total" — the
 * kit's actual size is already known here, never guessed.
 *
 * NEVER A RUNG ON THE EDIT-FAMILY LADDER. `protocol/budget/shedders/
 * editSideEffect.ts` gives `edit.applied` ZERO shed rungs by design — no
 * shedder may cut `core`/`counts`/`paths`, and the reserve
 * (`WIRE_RESERVE_BYTES`) is what is documented to make "it always fits" true
 * for those, never a runtime cutter. This function does not touch that
 * mechanism or that guarantee: it only ever deletes/shrinks a field THIS
 * SAME response cycle just added (`AppliedEntry.after`), and only when a
 * ceiling narrower than the local caps (`AFTER_ENTRY_CAP_BYTES`/
 * `AFTER_TOTAL_CAP_BYTES`) is actually declared. `ceiling === undefined`
 * (unknown client) is a no-op — the local caps already bound `after` on
 * their own.
 *
 * HONEST, NOT A GLOBAL GUARANTEE. If the kit/core ALONE already exceed
 * `ceiling`, dropping every `after` cannot bring the response under it — this
 * function only ever removes ITS OWN feature's contribution, never anything
 * `editSideEffect.ts` protects. "The response never exceeds the ceiling" is
 * therefore a claim about `after`'s OWN contribution, not a retrofit of
 * ceiling enforcement onto the whole side-effect response.
 *
 * WHAT IT MEASURES, AND HOW MUCH IT CUTS (R2-PEW, review P2-k). The ceiling is a
 * claim about the bytes on the WIRE, so the size tested is `wireView`'s — the
 * response as the funnel will project it (`editWireView`), not the raw result
 * this function is handed: the raw result still carries every `applied[].code`
 * echo, the `files` rows and other internal fields the projection drops, and
 * measuring THAT deleted whole windows from a response that was 4.7 KB under
 * the ceiling. The default view is the response itself (the unit specs hand in
 * an already-wire-shaped one). Each window is then cut to the LARGEST number of
 * leading lines that still fits, found by re-measuring the candidate — JSON
 * escaping and the `remaining` names a cut adds are counted, never estimated —
 * and a window is dropped only when not even one line of it fits. Windows are
 * shed from the LAST file back, the order `attachAppliedReadback`'s own
 * per-response cap already uses (earlier files keep their windows first).
 *
 * The booking follows what this returns: `bookShippedPostEditWindows` records
 * the ledger from the shed response, so whatever is cut here is never claimed.
 */
// Exported for evaluation0929.postEditWindow.spec.ts's direct unit coverage
// of the ceiling-shed rule — engineering a real tl_edit_file call whose kit +
// applied[] reliably lands on a specific side of a specific byte ceiling is
// fragile; this function's own (response, ceiling) contract is not.
export function shedPostEditWindowsToFit(
  response: Record<string, unknown>,
  ceiling: number | undefined,
  wireView: (candidate: Record<string, unknown>) => unknown = (candidate) => candidate,
): Record<string, unknown> {
  if (ceiling === undefined) return response;
  const applied = response["applied"];
  if (!Array.isArray(applied) || applied.length === 0) return response;
  if (Buffer.byteLength(JSON.stringify(wireView(response)), "utf8") <= ceiling) return response;
  const nextApplied = applied.map((entry) => (isRecordLike(entry) ? { ...entry } : entry));
  const candidate = (): Record<string, unknown> => ({ ...response, applied: nextApplied });
  const fits = (): boolean => Buffer.byteLength(JSON.stringify(wireView(candidate())), "utf8") <= ceiling;
  for (let i = nextApplied.length - 1; i >= 0; i--) {
    const entry = nextApplied[i];
    if (!isRecordLike(entry)) continue;
    const after = entry["after"];
    if (!isPostEditWindowLike(after)) continue;
    // Invariant on entry: the response does NOT fit with this window whole.
    const window = postEditWindowLinesOf(after);
    let kept = 0;
    if (window !== undefined) {
      let high = window.lines.length - 1;
      while (kept < high) {
        const mid = Math.ceil((kept + high) / 2);
        entry["after"] = cutPostEditWindowToLines(after, window, mid);
        if (fits()) kept = mid;
        else high = mid - 1;
      }
    }
    if (window !== undefined && kept > 0) entry["after"] = cutPostEditWindowToLines(after, window, kept);
    else delete entry["after"];
    if (fits()) break;
  }
  return candidate();
}

/**
 * The `edit.applied` wire form of a raw edit result — what `shedPostEditWindowsToFit`
 * measures a host ceiling against. It runs the SAME projector the emit funnel
 * runs (`protocol/envelope.ts`'s `projectSuccessBody` -> `projectEditBody`,
 * over the same workspace root), so `applied[].code` echoes, `files` rows and
 * every other internal field the projection drops are not counted, and a field
 * it adds (`core`, `slice_sha`, `head`) is. Used only to MEASURE: the response
 * the shed returns is always a cut of the raw result, never this view.
 *
 * NOT MEASURED: the envelope-level disclosure keys the funnel restores after
 * projecting (`cwd_corrected`, `root_note`, `workspace`, `workspace_crossing` —
 * `protocol/disclosure.ts`), which ride only a handful of unusual calls and
 * weigh at most a few hundred bytes, well inside the headroom a host ceiling
 * (14336 under VS Code's own 16 KiB) is set with. Measured against the real
 * wire the estimate was never low: 1-97 bytes under the ceiling, across a
 * sweep, and never over (evaluation0929.pewCeilingBooking.spec.ts).
 */
export function editWireView(raw: Record<string, unknown>, workspace: string): Record<string, unknown> {
  const { ok: _ok, kind: _kind, ...body } = raw;
  return { v: 1, kind: "edit.applied", ...projectEditBody("edit.applied", body, workspace) };
}

/**
 * What `attachAppliedReadback` stages for the booking below, per file path: the
 * sha of the exact text an `after` window was cut from and that text's REAL
 * line count (no phantom segment after a final newline).
 */
export interface StagedPostEditWindow {
  sha: string;
  totalLines: number;
}

/**
 * Ledger booking for the wide post-edit window (PEW requirement 2), from the
 * response that SHIPS (R2-PEW, review P0-1). Every `applied[].after` still on
 * the final response — after `shedPostEditWindowsToFit` shrank or dropped what
 * a byte ceiling would not carry — books exactly the lines its own `range`
 * names, so a later `tl_read_file` of those lines this epoch answers with a
 * receipt/`prior`, a later edit may adopt them as served bytes, and a line that
 * was cut (or whose window was dropped whole) is never claimed: it is served
 * again, as bytes. A window that did not ship books nothing, by construction —
 * there is no earlier booking to withdraw.
 *
 * Bookkeeping only: an exception here loses the booking (later reads re-serve,
 * the safe direction) and never the response that already carries the edit.
 */
export function bookShippedPostEditWindows(
  workspace: string,
  shipped: Record<string, unknown>,
  staged: ReadonlyMap<string, StagedPostEditWindow>,
): void {
  try {
    const applied = shipped["applied"];
    if (!Array.isArray(applied) || staged.size === 0) return;
    for (const entry of applied) {
      if (!isRecordLike(entry)) continue;
      const entryPath = entry["path"];
      const after = entry["after"];
      if (typeof entryPath !== "string" || !isPostEditWindowLike(after) || after.body === "") continue;
      const facts = staged.get(entryPath);
      if (facts === undefined) continue;
      const span = after.range.match(/^(\d+)-(\d+)$/);
      if (span === null) continue;
      const from = parseInt(span[1]!, 10);
      const to = parseInt(span[2]!, 10);
      if (to < from) continue;
      recordServedRange(
        workspace,
        entryPath,
        facts.sha,
        from,
        to,
        facts.totalLines,
        { mode: "edit-after", range: after.range, call: beginServeCall(workspace) },
      );
    }
  } catch {
    // bookkeeping — see above.
  }
}

/**
 * TL_EFF_EDIT_DIET (2026-10-19): for every edited file whose post-edit window
 * was left out as an echo, hold the lines the caller wrote at the post-edit
 * revision (`holdServerEditAuthoredLines`, state/session.ts), so the file's
 * served-range entry no longer names the pre-edit sha and the caller's next
 * caller-ranged read of it is served, not refused `cursor-stale`. Bookkeeping
 * only, under the same rule as `bookShippedPostEditWindows`: an exception here
 * loses the hold and never the response that already carries the edit. Runs at
 * most once per edit: `staged` is emptied whatever happens, so the fallback
 * call on finishEdit's error path cannot hold the same lines twice.
 */
export function holdEchoAuthoredLines(workspace: string, staged: Map<string, StagedAuthoredLines>): void {
  if (staged.size === 0) return;
  try {
    const call = beginServeCall(workspace);
    for (const [relPath, facts] of staged) {
      holdServerEditAuthoredLines(workspace, relPath, facts.sha, facts.totalLines, facts.spans, call);
    }
  } catch {
    // bookkeeping — see above.
  } finally {
    staged.clear();
  }
}
