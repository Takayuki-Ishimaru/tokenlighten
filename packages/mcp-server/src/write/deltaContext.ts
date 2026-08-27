/**
 * deltaContext.ts — B2 / V12-02 (2026-08-27), TL_DELTA_CONTEXT (default OFF).
 *
 * THE PROBLEM. The served-range ledger (`state/session.ts`) is keyed by content
 * sha, so ANY write to a file invalidates every claim about it: a session that
 * read a 500-line file and then changed three lines in it re-serves all 500 on
 * the next read. With W3's measured `tl_residency_amplification = 8.578`, those
 * re-served bytes are charged again on every following turn.
 *
 * THE FIX. Carry the ledger ACROSS this server's own edits by re-projecting its
 * spans through the hunk that was actually written. Spans above the change keep
 * their lines, spans below shift by the net line delta, and the changed region
 * is dropped. The post-edit read then serves only the residual windows as
 * bodies and names the rest `prior` — the SAME `segments[]`/`code_unchanged`
 * projection that already exists; protocol v1 gains no kind, field or argument.
 *
 * WHY THE HUNK IS DERIVED FROM BYTES. `edit_file` reports a `lines` span and
 * `applyEditsMulti` computes an `added`/`removed` delta, but both describe what
 * the CALLER asked for after the applier's own recovery (literal-escape
 * unescaping, indentation-equivalent matching, range/anchor forms, whole-file
 * content replacement, symbol rename across many sites, rollback restore).
 * Re-deriving the change from the before/after TEXTS makes every one of those
 * shapes the same shape, and makes the two facts the transformation depends on
 * — "these lines are identical at the same index" and "those lines are
 * identical at index + delta" — proofs rather than assumptions.
 *
 * WHERE IT RUNS. `write/atomicWrite.ts`'s `writeExistingFileAtomic`, AFTER the
 * rename succeeds. That function's own doc comment already names it "the
 * narrowest single seam every existing-file edit/rollback-restore funnels
 * through", which is exactly the safety floor this lever needs: hunks THIS
 * server applied and nothing else. A create writes through a different path and
 * has no prior ledger entry to carry, so it is a no-op by construction.
 */

import { countLines } from "../util/countLines.js";
import { deltaContextEnabled } from "../util/flags.js";
import { shaOfText } from "../util/handles.js";
import { trace } from "../util/trace.js";
import {
  hasServedRangeLedgerEntry,
  transformServedRangesAcrossServerEdit,
  type ServedRangeEditHunk,
} from "../state/session.js";

/**
 * Split text into the SAME logical lines `countLines` counts: line endings
 * normalized to LF, exactly one trailing newline stripped. Both sides of a
 * comparison go through this, so a pure line-ending conversion shows up as
 * "every line changed" only when the visible text really did change.
 */
function logicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (trimmed.length === 0) return [];
  return trimmed.split("\n");
}

/**
 * The single changed region between `before` and `after`, in PRE-edit line
 * coordinates — the longest common line PREFIX and the longest common line
 * SUFFIX, with everything between them declared changed.
 *
 * DELIBERATELY NOT A DIFF. A real LCS would find more unchanged interior lines
 * and keep more of the ledger, but every additional mapping it produced would
 * be a HEURISTIC alignment ("this line probably moved there"), and a wrong
 * alignment hands the caller a `prior` marker for bytes it does not hold. The
 * prefix/suffix pair is the maximal region whose complement is unchanged BY
 * CONSTRUCTION: line `i < preStart` is `after[i]` because the prefix scan
 * compared them, and line `j > preEnd` is `after[j + delta]` for the same
 * reason. That is the whole proof, and it is why a multi-hunk batch collapses
 * safely into one enclosing region instead of guessing at the hunks between.
 *
 * Returns `undefined` when the texts are identical (nothing to project).
 */
export function computeEditHunkGeometry(
  before: string,
  after: string,
): ServedRangeEditHunk | undefined {
  if (before === after) return undefined;
  const b = logicalLines(before);
  const a = logicalLines(after);

  let prefix = 0;
  const shortest = Math.min(b.length, a.length);
  while (prefix < shortest && b[prefix] === a[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < b.length - prefix
    && suffix < a.length - prefix
    && b[b.length - 1 - suffix] === a[a.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const preStart = prefix + 1;
  const preEnd = b.length - suffix;
  const delta = a.length - b.length;
  // Identical logical lines with different raw bytes (a line-ending or
  // trailing-newline-only change): no line moved, so there is nothing to
  // project and the sha update alone would be a claim this function is not
  // entitled to make.
  if (preEnd < preStart - 1) return undefined;
  if (preEnd === preStart - 1 && delta === 0) return undefined;
  return { preStart, preEnd, delta };
}

/**
 * B2 / V12-02: carry the served-range ledger across one server-applied write.
 *
 * A NO-OP UNLESS ALL OF: the flag is on, the workspace session actually holds a
 * ledger entry for this path, and that entry describes the exact PRE-edit bytes
 * (checked by sha inside `transformServedRangesAcrossServerEdit`). Any miss
 * leaves the entry untouched, and the ordinary sha-mismatch path then serves
 * the full body — the pre-B2 behaviour.
 *
 * Emits ONE `delta_context` trace line (`phase:"ledger-transform"`) per actual
 * transformation. Zero wire bytes: `TL_TRACE` writes to
 * `~/.tokenlighten/trace/`, which is where the preregistrable live engagement
 * counter for this lever is read from.
 */
export function carryServedRangesAcrossEdit(
  workspaceRoot: string,
  relPath: string,
  beforeText: string,
  afterText: string,
): void {
  if (!deltaContextEnabled()) return;
  const hunk = computeEditHunkGeometry(beforeText, afterText);
  if (hunk === undefined) return;
  const summary = transformServedRangesAcrossServerEdit(
    workspaceRoot,
    relPath,
    shaOfText(beforeText),
    shaOfText(afterText),
    countLines(afterText),
    hunk,
  );
  if (summary === undefined) return;
  trace("delta_context", {
    phase: "ledger-transform",
    path: relPath,
    hunk: `${hunk.preStart}-${hunk.preEnd}`,
    line_delta: hunk.delta,
    spans_kept: summary.kept,
    spans_dropped: summary.dropped,
    spans_shifted: summary.shifted,
    held_lines: summary.heldLines,
  }, workspaceRoot);
}

/**
 * Cheap arming check for the write seam: is there anything to carry at all?
 * Answering "no" here is what keeps the seam from reading the pre-edit bytes of
 * every file this server writes — the read happens only for a path this session
 * has actually served ranges for.
 */
export function deltaContextArmed(workspaceRoot: string, relPath: string): boolean {
  return deltaContextEnabled() && hasServedRangeLedgerEntry(workspaceRoot, relPath);
}
