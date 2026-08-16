/**
 * countLines.ts — trailing-newline-aware line count.
 *
 * BUG THIS FIXES (bench transcript forensics, 2026-07-03): every file on disk
 * ends with a trailing newline in practice, but `raw.split(/\r?\n/).length`
 * counts a PHANTOM final empty segment for that trailing newline — a 50-line
 * file (content "line1\n...line50\n") splits into 51 elements, the 51st being
 * "". Any caller that treats that split length as "how many lines does this
 * file have" mints an off-by-one-too-large value. When that value becomes a
 * RANGE end (e.g. a task_pack handle minted as "1-51" for a 50-line file),
 * edit_file's own bounds check — which correctly counts LOGICAL lines via
 * countLogicalLinesEntry() in tools/applyEditsMulti.ts (strip one trailing
 * newline, then split) — rejects that handle's own range as out of bounds:
 * "range 1-51 is out of bounds (file has 50 lines)". The mint and the check
 * must agree; this module is the single source of truth both sides use.
 *
 * Semantics — deliberately BYTE-IDENTICAL to the two existing bounds-check
 * implementations this must agree with: applyEditsMulti.ts's
 * countLogicalLinesEntry() and write/rangeEdit.ts's countLogicalLines()
 * (both strip exactly one trailing newline, then split — same algorithm,
 * previously duplicated instead of shared):
 *   ""       -> 0   (empty file has no lines)
 *   "a"      -> 1   (one line, no trailing newline)
 *   "a\n"    -> 1   (one line, WITH trailing newline — the common case)
 *   "a\nb"   -> 2
 *   "a\nb\n" -> 2
 *   "\n"     -> 0   (empty content once its one trailing newline is
 *                    stripped — matches both existing checkers exactly; a
 *                    "1" here would mint a "1-1" handle for a file the
 *                    bounds check reports as having 0 lines, reproducing
 *                    this exact class of bug for a different edge case)
 * CRLF and lone-CR line endings are normalized to LF before counting, so
 * Windows-authored files count identically to LF files.
 */

/**
 * Count the logical (trailing-newline-aware) number of lines in `content`.
 * See module doc comment for exact semantics and worked examples.
 */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (trimmed.length === 0) return 0; // content was just "\n" (or "\r\n") — see module doc comment.
  return trimmed.split("\n").length;
}
