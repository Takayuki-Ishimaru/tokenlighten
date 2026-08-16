/**
 * Post-not-found forensics (2026-07-26 T09 R2 escape forensics): a
 * search-not-found used to return no evidence of what IS in the range, so
 * solvers reconstructed the file's byte reality with native `cat -A`/`od -c`
 * whitespace archaeology (4 native turns measured on one refusal). Serve the
 * closest region — located by whitespace-normalized first-line anchor —
 * verbatim in the error itself, so tab/space or wording drift is visible in
 * the response the solver already has.
 */

export interface NearestMatchInfo {
  nearest_match?: { range: string; code: string; note: string; out_of_range?: true };
  actual?: { range: string; code: string; note: string };
}

const FORENSICS_CAP_BYTES = 1200;
const FORENSICS_CONTEXT_LINES = 2;
const FORENSICS_FALLBACK_HEAD_LINES = 12;

/**
 * Anchor-edit staleness/bounds refresh cap. Larger than FORENSICS_CAP_BYTES
 * because this payload is not a diffing HINT but the actual re-anchoring
 * material: an anchor edit addresses lines by number instead of restating the
 * served bytes, so a refused anchor edit can only be retried in ONE step if
 * the refusal carries enough of the CURRENT bytes at that range to re-derive
 * the new coordinates without a native re-read.
 */
const ANCHOR_REFRESH_CAP_BYTES = 2048;

function normalizeWs(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** Join lines under the byte cap, cutting on a line boundary. */
function capJoin(lines: readonly string[], capBytes: number = FORENSICS_CAP_BYTES): string {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > capBytes) break;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * @param segmentText the searched scope's current text (LF-normalized)
 * @param search the search string that failed to match
 * @param segmentStartLine 1-based file line number of segmentText's first line
 */
export function nearestMatchForensics(
  segmentText: string,
  search: string,
  segmentStartLine: number,
): NearestMatchInfo {
  try {
    if (segmentText.trim() === "") return {};
    // A range segment carries its trailing newline — drop the phantom empty
    // last element so served ranges match real line numbers.
    const segLines = segmentText.replace(/\n$/, "").split("\n");
    const searchLines = search.split("\n").filter((l) => l.trim() !== "");
    const anchor = searchLines.length > 0 ? normalizeWs(searchLines[0]!) : "";
    if (anchor !== "") {
      for (let i = 0; i < segLines.length; i++) {
        if (normalizeWs(segLines[i]!) !== anchor) continue;
        const from = Math.max(0, i - FORENSICS_CONTEXT_LINES);
        const to = Math.min(segLines.length, i + searchLines.length + FORENSICS_CONTEXT_LINES);
        const windowNorm = new Set(segLines.slice(from, to).map(normalizeWs));
        const matched = searchLines.filter((l) => windowNorm.has(normalizeWs(l))).length;
        return {
          nearest_match: {
            range: `${segmentStartLine + from}-${segmentStartLine + to - 1}`,
            code: capJoin(segLines.slice(from, to)),
            note: `closest region by whitespace-normalized first-line match (${matched}/${searchLines.length} search lines present) — diff against your search to spot tab/space or content drift; no native re-read needed`,
          },
        };
      }
    }
    const headCount = Math.min(FORENSICS_FALLBACK_HEAD_LINES, segLines.length);
    if (headCount === 0) return {};
    return {
      actual: {
        range: `${segmentStartLine}-${segmentStartLine + headCount - 1}`,
        code: capJoin(segLines.slice(0, headCount)),
        note: "scope head — the search's first line has no whitespace-normalized match here; compare content before retrying",
      },
    };
  } catch {
    return {};
  }
}

/**
 * P4.2 (2026-08-02 T13 rep1-a idx 70→71): whole-file anchor locator for a
 * range-scoped miss. Only called when the in-range search produced the
 * scope-head `actual` fallback — i.e. the anchor is genuinely absent from the
 * searched SEGMENT. The live case had the anchor at ~L118 while the handle was
 * bound to 199-259; the scope-head answer was true and useless, and the solver
 * paid a re-read of 1-198 plus a fresh handle, deterministically, per occurrence.
 *
 * Bounded: one pass over the normalized lines, FORENSICS_CAP_BYTES of output.
 * Returns {} when the anchor is absent file-wide OR matches more than once —
 * an ambiguous relocation is worse than none. `excludeStart`/`excludeEnd` are
 * the 1-based bounds of the handle's own range, echoed back so the caller can
 * see WHY its in-range search missed.
 */
export function outOfRangeAnchor(
  fileText: string,
  search: string,
  excludeStart: number,
  excludeEnd: number,
): NearestMatchInfo {
  try {
    // D10 (2026-08-14): `TL_REFUSAL_PROGRESS` is deleted; advisory relocation
    // is unconditional.
    if (fileText.trim() === "" || search.trim() === "") return {};
    const lines = fileText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");
    const searchLines = search.split("\n").filter((line) => line.trim() !== "");
    const anchor = searchLines.length > 0 ? normalizeWs(searchLines[0]!) : "";
    if (anchor === "") return {};

    let hit = -1;
    let hits = 0;
    for (let i = 0; i < lines.length; i++) {
      if (normalizeWs(lines[i]!) !== anchor) continue;
      hits++;
      if (hits > 1) return {};
      hit = i;
    }
    if (hits !== 1 || hit < 0) return {};

    const startLine = hit + 1;
    // Inside the bound range there is nothing to relocate to — the caller's
    // own segment search already covered it.
    if (startLine >= excludeStart && startLine <= excludeEnd) return {};
    const endLine = Math.min(lines.length, hit + searchLines.length);
    return {
      nearest_match: {
        range: `${startLine}-${endLine}`,
        code: capJoin(lines.slice(hit, endLine)),
        note: `your search text is at L${startLine}-${endLine}, OUTSIDE the range ${excludeStart}-${excludeEnd} this handle is bound to — re-issue with a handle/range covering L${startLine}-${endLine}; no full re-read needed`,
        out_of_range: true,
      },
    };
  } catch {
    return {};
  }
}

/**
 * A range-scoped search miss, with the whole-file locator layered on top of the
 * existing in-segment forensics. The in-segment result is returned verbatim
 * when it located a nearest match; otherwise its scope-head `actual` is KEPT
 * and the out-of-range relocation is added alongside it (purely additive).
 */
export function rangeMissForensics(
  fileText: string,
  segmentText: string,
  search: string,
  rangeStart: number,
  rangeEnd: number,
): NearestMatchInfo {
  const inSegment = nearestMatchForensics(segmentText, search, rangeStart);
  if (inSegment.nearest_match !== undefined) return inSegment;
  return { ...inSegment, ...outOfRangeAnchor(fileText, search, rangeStart, rangeEnd) };
}

/**
 * Anchor-edit CAS staleness payload: the CURRENT bytes at the range the caller
 * anchored to, so the refusal itself is the re-anchoring material (one retry,
 * no native re-read). `startLine`/`endLine` are 1-based inclusive and are
 * clamped to the file so a range that now runs past EOF still returns whatever
 * of it survives instead of nothing.
 *
 * Deliberately reuses `nearest_match` (not a new field name): agents already
 * treat nearest_match as "the actual bytes — fix your call from this", and the
 * managed guide teaches exactly that. A distinct key would need its own
 * teaching to be actionable.
 */
export function refreshedRangeSlice(
  currentText: string,
  startLine: number,
  endLine: number,
): NearestMatchInfo {
  try {
    const lines = currentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");
    if (currentText === "" || lines.length === 0) return {};
    const from = Math.max(0, Math.min(startLine - 1, lines.length - 1));
    const to = Math.max(from + 1, Math.min(endLine, lines.length));
    const kept = lines.slice(from, to);
    if (kept.length === 0) return {};
    return {
      nearest_match: {
        range: `${from + 1}-${to}`,
        code: capJoin(kept, ANCHOR_REFRESH_CAP_BYTES),
        note: "CURRENT bytes at the range you anchored to — the file changed after this handle was served; re-anchor from these lines (no re-read needed)",
      },
    };
  } catch {
    return {};
  }
}

/**
 * Out-of-bounds anchor payload: the head of the file as it stands now, so the
 * caller can see the real shape of a file whose line count no longer covers
 * the requested range. Pairs with `file_line_count` on the refusal.
 */
export function fileHeadForensics(currentText: string): NearestMatchInfo {
  try {
    const lines = currentText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");
    if (currentText === "" || lines.length === 0) return {};
    const headCount = Math.min(FORENSICS_FALLBACK_HEAD_LINES, lines.length);
    return {
      actual: {
        range: `1-${headCount}`,
        code: capJoin(lines.slice(0, headCount), ANCHOR_REFRESH_CAP_BYTES),
        note: "current file head — the requested range runs past EOF; re-anchor within file_line_count",
      },
    };
  } catch {
    return {};
  }
}
