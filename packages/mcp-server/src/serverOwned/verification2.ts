// verification — extracted implementation; imports point to the owning modules.
import { attachVerificationAdvisory } from "./verification.js";
import { buildVerificationBody } from "./task-pack-wire.js";
import { buildVerificationBodyDetailed } from "./task-pack-wire.js";
import { buildVerificationManifest } from "../util/verificationPack.js";
import { getEditedPaths } from "../state/session.js";
import { labelKitBodies } from "./verification.js";
import { verificationNotApplicableReason } from "./verification.js";

export function attachVerification(result: Record<string, unknown>, workspace: string, editArgs?: Record<string, unknown>): Record<string, unknown> {
  try {
    if ((result as { ok?: boolean }).ok === false) return result;
    const { manifest, notApplicable } = buildVerificationBodyDetailed(workspace, editArgs);
    if (manifest !== undefined) return attachVerificationAdvisory(result, manifest);
    // W9: fires ONLY when neither a verification kit NOR a closure check
    // landed on this response. attachClosure always runs before this
    // (finishEdit calls it first), so result["closure"] already tells us
    // whether it had something to say — never overridden here. Never fires
    // on dedup/budget silence: notApplicable is false in both of those.
    if (notApplicable && result["closure"] === undefined) {
      return {
        ...result,
        verification: { status: "not-applicable" as const, reason: verificationNotApplicableReason(result) },
      };
    }
    return result;
  } catch {
    return result;
  }
}

/** mode=closure variant: first call serves bodies, later calls handles-only. */
export function withVerificationSection(body: Record<string, unknown>, workspace: string): Record<string, unknown> {
  try {
    const fresh = buildVerificationBody(workspace);
    if (fresh !== undefined) return { ...body, verification: fresh };
    const manifest = buildVerificationManifest(workspace, getEditedPaths(workspace), { pythonSyntaxCheck: true });
    if (manifest === undefined) return body;
    // No body rides a re-serve: keep every handle, drop every body, and let
    // labelKitBodies say which of the two body-less MEANINGS applies from the
    // served ledger. Marking the whole kit body:"omitted" here (the old
    // behavior) told the agent nothing had been served when in fact most of it
    // already sat in its context — and hid the entries that truly never were.
    const stripBody = <T extends { code?: string }>(entry: T): Omit<T, "code"> => {
      const { code: _code, ...rest } = entry;
      return rest;
    };
    const reserved: Record<string, unknown> = {
      ...manifest,
      surfaces: manifest.surfaces.map(stripBody),
      link_set: manifest.link_set.map(stripBody),
      ...(manifest.harness !== undefined
        ? {
          harness: {
            ...manifest.harness,
            ...(manifest.harness.mock_headers !== undefined
              ? { mock_headers: manifest.harness.mock_headers.map(stripBody) }
              : {}),
          },
        }
        : {}),
      note: "verification working set — no body rides this response; every entry carries a handle and next_call fetches the omitted ones in one call",
    };
    return { ...body, verification: labelKitBodies(workspace, reserved) };
  } catch {
    return body;
  }
}

export const APPLIED_CONTEXT_LINES = 8;

export const APPLIED_ENTRY_CAP_BYTES = 2048;

export const APPLIED_TOTAL_CAP_BYTES = 8192;

export const APPLIED_MAX_ENTRIES = 6;

/**
 * PEW (v0.15.0, DESIGN-v0.15-* mechanism program — see AGENTS.md's design-
 * version-notation note; this ships as a v0.15.0 additive field, not a
 * design-series label). Sizing for `AppliedEntry.after`, the WIDE post-edit
 * window — independent of and additive to `APPLIED_*` above, which stays
 * exactly as it was (the compact `code`/`head` proof, gated by W2's
 * "compact by default" rule). Measured (measure-v015/REPORT.md PEW row): ±5
 * lines / 3 KiB / 10 KiB covered 3/9 recorded post-edit re-reads (33%, below
 * the 50% kill line); ±20 / 6 KiB / 16 KiB covered 6/9 (67%) — this is that
 * variant.
 */
export const AFTER_CONTEXT_LINES = 20;

export const AFTER_ENTRY_CAP_BYTES = 6 * 1024;

export const AFTER_TOTAL_CAP_BYTES = 16 * 1024;

// EFF (TL_EFF_SLIM_EDIT, default ON since 2026-10-01): the `after` window's
// context under the flag — the changed lines plus this many lines either
// side, never widened to an enclosing symbol. Measured 2026-10-01 on the h2
// windows: the ±20 pad plus symbol widening averaged 8.5 KB per edit reply (a
// one-line enum member came back as the file's 51 lines).
export const EFF_SLIM_AFTER_CONTEXT_LINES = 3;

// EFF (TL_EFF_WIDE_FIND, default ON since 2026-10-18): OR-matched find tokens
// accepted in one call (both h2 refusals of this shape were a sixth token, and
// the 6t-2 rerun's two were a sixth and a seventh).
export const EFF_TOLERANT_QUERY_CAP = 10;

// EFF (TL_EFF_FIND_PHRASE, default ON since 2026-10-18; `0` restores the plain
// all-miss reply): the byte budget of the token re-run.
// Replayed 2026-10-01 on the A/B's 42 empty phrase finds: unbudgeted re-runs
// on tokens such as `EKF` or `LOW` hit the ~32 KB find ceiling.
export const EFF_FIND_PHRASE_BUDGET_BYTES = 8192;

export function braceDelta(search: string, replace: string): number {
  const opens = (s: string) => (s.match(/{/g) ?? []).length;
  const closes = (s: string) => (s.match(/}/g) ?? []).length;
  return (opens(replace) - opens(search)) - (closes(replace) - closes(search));
}

/**
 * PEW: best-effort locator for a hunk's post-edit span inside a merged
 * multi-hunk file edit. `applyEditsMulti.ts`'s merge comment documents that a
 * merged chain's own `EditFileResult.lines` names only "the FINAL edit's line
 * range" — by design, and unchanged here. When a file took more than one
 * hunk in this batch, this recovers the OTHER hunks' post-edit positions by
 * finding each hunk's verbatim `replace` text in the file's FINAL text.
 *
 * FAILS OPEN, NEVER WRONG: an empty `replace` (a pure deletion — nothing
 * survives to search for) or a text this scan cannot find (a later hunk
 * further altered it) returns no span. The caller already guarantees the
 * chain's own final span independently, so a miss here only forgoes an EXTRA
 * window — and every span this returns is a verified, verbatim match.
 *
 * A MATCH IS VERBATIM, NOT PROOF OF ORIGIN (R2-PEW, review P2-b). The old scan
 * read the file line by line and took the first whole-line match past the
 * previous hunk — right only for hunks supplied top to bottom whose text is a
 * WHOLE line and occurs once. A block that also occurs earlier (a repeated
 * marker line, a `return null;`) matched the earlier line, an edit applied
 * bottom to top matched nothing past the cursor, and a `replace` that is only
 * PART of a line (the common shape: a constant changed inside a statement)
 * never matched at all — so the real hunk got neither a window nor a name. A
 * text does not say where a repeated block came from; the scan therefore
 * returns EVERY occurrence, in file order (at most one more than
 * `POST_EDIT_HUNK_CANDIDATE_CAP`, so the caller can tell "more than the cap" —
 * it treats that as "too common to be information" and keeps none), and the
 * window around the right one is shown or named in `remaining`. An extra
 * candidate merely names one more range.
 */
export function locatePostEditHunkSpans(
  index: PostEditSearchIndex,
  replaceText: string,
): Array<{ start: number; end: number }> {
  // The file's lines are CRLF-stripped in the index; a caller's own CRLF is too. A replacement that ENDS in a
  // newline owns that newline as the end of its last line, so the needle stops before it.
  let needle = replaceText.replace(/\r\n/g, "\n");
  if (needle.endsWith("\n")) needle = needle.slice(0, -1);
  if (needle === "") return [];
  const found: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (;;) {
    const at = index.text.indexOf(needle, from);
    if (at < 0) break;
    found.push({
      start: lineAtOffset(index.lineStarts, at),
      end: lineAtOffset(index.lineStarts, at + needle.length - 1),
    });
    if (found.length > POST_EDIT_HUNK_CANDIDATE_CAP) break;
    from = at + needle.length;
  }
  return found;
}

/**
 * How many occurrences of one hunk's text the multi-hunk scan is willing to
 * name individually. Past this a text is too common (a lone `}`, a bare
 * number) for "every place it occurs" to be information rather than noise, and
 * no span is kept for that hunk — the chain-final window is unaffected.
 */
export const POST_EDIT_HUNK_CANDIDATE_CAP = 4;

/** A file's REAL lines as one searchable text (each line's `\r` stripped) and the offset every line starts at. */
export interface PostEditSearchIndex {
  text: string;
  lineStarts: readonly number[];
}

export function postEditSearchIndex(realLines: readonly string[]): PostEditSearchIndex {
  const lineStarts: number[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const raw of realLines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lineStarts.push(offset);
    parts.push(line);
    offset += line.length + 1;
  }
  return { text: parts.join("\n"), lineStarts };
}

/** The 1-based line holding 0-based text `offset` — the last line that starts at or before it. */
export function lineAtOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * PEW: pad `span` by `contextLines` on each side (clamped to the file), then
 * upgrade to the smallest ENCLOSING symbol that still fits `entryCapBytes` —
 * the exact upgrade rule `attachAppliedReadback`'s own ±8 window already
 * applies, generalized so the wider ±20 `after` window can apply it too
 * without duplicating the extraction call (`symbols` is the caller's own,
 * already-extracted list; passing `[]` — as `wholeFile` entries do — simply
 * never upgrades).
 */
export function windowAroundSpan(
  lines: readonly string[],
  span: { start: number; end: number },
  contextLines: number,
  entryCapBytes: number,
  symbols: ReadonlyArray<{ name: string; range: string }>,
): { from: number; to: number } {
  let from = Math.max(1, span.start - contextLines);
  let to = Math.min(lines.length, span.end + contextLines);
  let best: { name: string; s: number; e: number } | undefined;
  for (const sym of symbols) {
    const sm = sym.range.match(/^(\d+)-(\d+)$/);
    if (sm === null) continue;
    const s = parseInt(sm[1]!, 10);
    const e = parseInt(sm[2]!, 10);
    if (s <= span.start && span.end <= e && (best === undefined || e - s < best.e - best.s)) {
      best = { name: sym.name, s, e };
    }
  }
  if (best !== undefined && (best.s < from || best.e > to)) {
    const symBytes = Buffer.byteLength(lines.slice(best.s - 1, best.e).join("\n"), "utf8");
    if (symBytes <= entryCapBytes) {
      from = best.s;
      // `lines` is the file's REAL lines (no phantom segment after a final
      // newline — see attachAppliedReadback), so this also keeps an extractor
      // range that overshoots the file from naming a line that does not exist.
      to = Math.min(best.e, lines.length);
    }
  }
  return { from, to };
}
