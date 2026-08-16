/**
 * blastRadius.ts — single-hunk blast-radius precondition (2026-08-01).
 *
 * Measured incident (2026-08-01, this repo): a caller passed TOP-LEVEL
 * {handle, range:"676-788", content} to edit_file. The unknown `range` was
 * silently dropped and the {handle, content} range-content-replace branch ran
 * over the handle's OWN 1-788 whole-file range — findReferences.ts went
 * 788 → 57 lines and was recovered from .tokenlighten/checkpoints. The
 * unknown-argument refusal (server.ts, editFileUnknownArgumentRefusal) closes
 * that exact hole; this module is the defense-in-depth layer behind it: ANY
 * single hunk that rewrites a file at whole-file scale must be explicitly
 * acknowledged, whatever call shape produced it.
 *
 * A single range-content replacement (top-level handle+content, or an
 * edits[] item's range+content) that would shrink the target file by more
 * than BLAST_SHRINK_RATIO of its lines — or that replaces more than
 * BLAST_REPLACED_RATIO of them — requires precondition:"expected-hash".
 * Batches are redirected to that single-call form, since expected-hash is
 * structurally refused for edits[] batches (server.ts
 * precondition-unsupported-for-batch). Tiny files (<= TINY_BYTES and
 * <= TINY_LINES, util/fullGovernor.ts) are exempt: the designed tiny-file
 * flow mints 1-EOF handles precisely so a caller can replace the whole body
 * in one cheap call (DESIGN-v0.8 B4.1), and a file that small cannot lose
 * whole-file-scale history in one hunk.
 *
 * Search/replace shapes are deliberately NOT guarded: a search string
 * restates the bytes it destroys, which is its own proof of intent;
 * range+content names its target only by line number.
 */

import { TINY_BYTES, TINY_LINES } from "../util/fullGovernor.js";
import { countLines } from "../util/countLines.js";

/** Shrink fraction of the WHOLE file above which a single hunk must be acknowledged. */
export const BLAST_SHRINK_RATIO = 0.5;
/** Fraction of the file's lines a single hunk may replace before acknowledgment. */
export const BLAST_REPLACED_RATIO = 0.9;

export interface BlastRadiusMeasure {
  fileLines: number;
  replacedLines: number;
  replacementLines: number;
  resultingLines: number;
  /** Rounded percent of the file's lines removed by this hunk (negative = growth). */
  shrinkPercent: number;
  /** Rounded percent of the file's lines this hunk replaces. */
  replacedPercent: number;
}

/** Parse "N-M" (or the "N,M" comma typo applyEditsMulti already tolerates). */
export function parseBlastRange(range: string): { start: number; end: number } | null {
  const commaMatch = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(range);
  const normalized = commaMatch ? `${commaMatch[1]}-${commaMatch[2]}` : range;
  const match = /^(\d+)(?:-(\d+))?$/.exec(normalized);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
  return { start, end };
}

/**
 * Returns the measured blast radius when the hunk is over-threshold on a
 * not-tiny file, or null when the hunk needs no acknowledgment (tiny file,
 * under both thresholds, or a degenerate span — bounds errors stay the
 * responsibility of the write path itself).
 */
export function measureBlastRadius(opts: {
  fileText: string;
  spanStart: number;
  spanEnd: number;
  replacementText: string;
}): BlastRadiusMeasure | null {
  const fileLines = countLines(opts.fileText);
  if (fileLines === 0) return null;
  const fileBytes = Buffer.byteLength(opts.fileText, "utf8");
  if (fileBytes <= TINY_BYTES && fileLines <= TINY_LINES) return null;
  const start = Math.max(1, opts.spanStart);
  const end = Math.min(opts.spanEnd, fileLines);
  if (end < start) return null;
  const replacedLines = end - start + 1;
  const replacementLines = countLines(opts.replacementText);
  const resultingLines = fileLines - replacedLines + replacementLines;
  const shrinkRatio = (fileLines - resultingLines) / fileLines;
  const replacedRatio = replacedLines / fileLines;
  if (shrinkRatio <= BLAST_SHRINK_RATIO && replacedRatio <= BLAST_REPLACED_RATIO) return null;
  return {
    fileLines,
    replacedLines,
    replacementLines,
    resultingLines,
    shrinkPercent: Math.round(shrinkRatio * 100),
    replacedPercent: Math.round(replacedRatio * 100),
  };
}

/**
 * Structured refusal for the single-edit dispatch paths (server.ts). The
 * batch path (applyEditsMulti) folds the same numbers into its StepResult
 * error/hint instead — its refusal must ride the existing step→result lift.
 * `currentSha` is the shortSha of the CURRENT on-disk content, so the
 * acknowledged retry is one call (the S1 precedent in write/preconditions.ts:
 * a refusal that names the required value instead of a bare rejection).
 */
export function blastRadiusRefusal(opts: {
  path: string;
  range: string;
  measure: BlastRadiusMeasure;
  currentSha: string;
}): Record<string, unknown> {
  const m = opts.measure;
  const shrinkClause = m.shrinkPercent > 0
    ? ` and would shrink it to ${m.resultingLines} lines (-${m.shrinkPercent}%)`
    : "";
  return {
    ok: false,
    reason: "blast-radius-precondition-required",
    code: "blast-radius-precondition-required",
    path: opts.path,
    range: opts.range,
    file_lines: m.fileLines,
    replaced_lines: m.replacedLines,
    replacement_lines: m.replacementLines,
    resulting_lines: m.resultingLines,
    shrink_percent: m.shrinkPercent,
    replaced_percent: m.replacedPercent,
    // A.9.2 snake_case, renamed 2026-08-14 (see write/preconditions.ts): the
    // `expected-hash` retry this refusal PRESCRIBES is unauthorable without it.
    current_sha: opts.currentSha,
    error: `this single hunk replaces ${m.replacedLines} of the file's ${m.fileLines} lines (${m.replacedPercent}%)${shrinkClause} — a whole-file-scale replacement requires precondition:"expected-hash" to prove it is intentional`,
    next: `re-issue the SAME call with precondition:"expected-hash" expectedSha=${opts.currentSha} to acknowledge the full-range replacement, or replace only the lines that actually change via edits:[{handle, range:"N-M", content}]`,
  };
}
