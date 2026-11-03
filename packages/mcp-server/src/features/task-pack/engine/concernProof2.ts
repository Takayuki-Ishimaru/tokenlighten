// concernProof — extracted implementation; imports point to the owning modules.
import type { ConcernTermVariants } from "./sourceAndConcernTerms3.js";
import type { LineSpan } from "./sourceAndConcernTerms.js";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import type { ToolCall } from "@tokenlighten/types";
import { containsJapanese } from "../../retrieval/jaQueryBridge.js";
import { languageForPath } from "../../../util/languages.js";
import { lineCommentMarkerIndex } from "./sourceAndConcernTerms2.js";
import { readCached } from "./packBasics2.js";
import { stripQuotedRuns } from "./sourceAndConcernTerms3.js";
import { textHasWordVariant } from "../salientWordMatch.js";

/**
 * `text` split into lines with comments and quoted runs blanked, ONE entry per
 * source line (unlike `concernCodeOnlyText`, which drops lines inside a block
 * comment and so cannot map back to line numbers). Same comment rules.
 */
export function concernCodeOnlyLines(lines: readonly string[], language: string | undefined): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (const rawLine of lines) {
    let line = rawLine;
    if (inBlockComment) {
      const closeAt = line.indexOf("*/");
      if (closeAt < 0) {
        out.push("");
        continue;
      }
      line = line.slice(closeAt + 2);
      inBlockComment = false;
    }
    const commentAt = lineCommentMarkerIndex(line, language);
    let code = commentAt >= 0 ? line.slice(0, commentAt) : line;
    const openAt = code.indexOf("/*");
    if (openAt >= 0) {
      const closeAt = code.indexOf("*/", openAt + 2);
      if (closeAt < 0) {
        inBlockComment = true;
        code = code.slice(0, openAt);
      } else {
        code = `${code.slice(0, openAt)} ${code.slice(closeAt + 2)}`;
      }
    }
    out.push(stripQuotedRuns(code));
  }
  return out;
}

/** Hits closer than this many lines belong to one cluster (`concernWindowInUnservedPart`). */
export const CONCERN_WINDOW_CLUSTER_GAP = 20;

/** Context lines kept above a window's first hit. */
export const CONCERN_WINDOW_LEAD_LINES = 2;

/** How far past the last hit the enclosing block may extend. */
export const CONCERN_WINDOW_MAX_BLOCK_LINES = 60;

/** Hard bound on one window. */
export const CONCERN_WINDOW_MAX_LINES = 120;

/**
 * R-B1 (2026-09-21, review B2 item 1): the window of `relPath` that carries a
 * request item's own wording inside the file's UNSERVED part — so the
 * continuation for an open concern addresses the lines that answer it rather
 * than the hull of every unserved line. Positional, never a keyword list:
 * lines where any of the concern's term variants occur (`textHasWordVariant`,
 * the policy's own matcher; a Japanese variant by substring), clustered, the
 * cluster with the most CODE-position hits chosen (a doc-comment mention
 * ranks below the implementation), then extended over the block that follows
 * its last hit by indentation. `undefined` when the wording does not occur in
 * the unserved part at all — the caller then keeps the whole remainder as the
 * target, so this can only ever NARROW an existing continuation.
 */
export function concernWindowInUnservedPart(
  workspace: string,
  relPath: string,
  missingPieces: readonly LineSpan[],
  variantsByTerm: ReadonlyMap<string, ConcernTermVariants>,
): LineSpan | undefined {
  const content = readCached(workspace, relPath);
  if (content === undefined || missingPieces.length === 0) return undefined;
  const variants = [...new Set([...variantsByTerm.values()].flatMap((entry) => entry.variants))].filter((v) => v.length > 0);
  if (variants.length === 0) return undefined;
  const lines = content.split(/\r\n|\r|\n/);
  const codeLines = concernCodeOnlyLines(lines, languageForPath(relPath));
  const matches = (text: string): boolean => variants.some((variant) => (containsJapanese(variant)
    ? text.toLowerCase().includes(variant.toLowerCase())
    : textHasWordVariant(text, variant)));
  const hits: Array<{ line: number; piece: number; code: boolean }> = [];
  missingPieces.forEach((piece, pieceIndex) => {
    for (let n = Math.max(1, piece.start); n <= Math.min(piece.end, lines.length); n += 1) {
      if (!matches(lines[n - 1]!)) continue;
      hits.push({ line: n, piece: pieceIndex, code: matches(codeLines[n - 1] ?? "") });
    }
  });
  if (hits.length === 0) return undefined;
  const clusters: Array<typeof hits> = [];
  for (const hit of hits) {
    const current = clusters[clusters.length - 1];
    const previous = current?.[current.length - 1];
    if (current !== undefined && previous !== undefined && previous.piece === hit.piece && hit.line - previous.line <= CONCERN_WINDOW_CLUSTER_GAP) {
      current.push(hit);
    } else {
      clusters.push([hit]);
    }
  }
  const codeCount = (cluster: typeof hits): number => cluster.filter((hit) => hit.code).length;
  const chosen = clusters.reduce((best, cluster) => (codeCount(cluster) > codeCount(best) ? cluster : best), clusters[0]!);
  const piece = missingPieces[chosen[0]!.piece]!;
  const first = chosen[0]!.line;
  const last = chosen[chosen.length - 1]!.line;
  const indentOf = (line: string): number => (line.match(/^[ \t]*/u)?.[0] ?? "").replace(/\t/gu, "    ").length;
  const baseIndent = indentOf(lines[last - 1] ?? "");
  const blockLimit = Math.min(piece.end, lines.length, last + CONCERN_WINDOW_MAX_BLOCK_LINES);
  let end = last;
  for (let n = last + 1; n <= blockLimit; n += 1) {
    const line = lines[n - 1]!;
    if (line.trim().length === 0 || indentOf(line) > baseIndent) {
      end = n;
      continue;
    }
    if (/^\s*(?:[}\])]|end\b)/u.test(line)) end = n;
    break;
  }
  while (end > last && (lines[end - 1] ?? "").trim().length === 0) end -= 1;
  const start = Math.max(piece.start, first - CONCERN_WINDOW_LEAD_LINES);
  return { start, end: Math.min(end, start + CONCERN_WINDOW_MAX_LINES - 1) };
}

export function configurationFileQuestion(query: string): boolean {
  return /\b(?:config(?:uration)?|settings?)\s+(?:file|json)\b|設定(?:ファイル|JSON)/iu.test(query);
}

export interface RequestItemReadiness {
  obligations: TaskReadinessObligation[];
  gap?: { next_call: ToolCall; ids: string[] };
  /**
   * DESIGN-v0.15 R1: request items PROVED by verified absence (see
   * `RequestItemProof.absentTerm`). Always present (possibly empty),
   * mirroring `obligations`. Review finding 2(b) fix (2026-09-08):
   * `scope_complete`/`omitted_count` mirror `RequestItemProof.
   * absentScopeComplete`/`absentOmittedCount` — carried all the way to
   * `TaskPackResult.request_item_absences` (model.ts) so the wire wording
   * (`decisionWire.ts`, `buildCapabilityGaps`) never claims "scope complete"
   * for a scan that excluded paths.
   */
  absences: Array<{ id: string; term: string; scope_complete: boolean; omitted_count: number; incidental?: boolean }>;
  /**
   * R-D2 (2026-09-21, item B, plan §5): topic items the ALL-TOPIC pass found
   * genuinely `could-not-determine` (`RequestItemProof.undeterminedTerm`) —
   * never covered, never a verified absence, and never blocking (invariant
   * (iv) is unchanged: this array mints no obligation). Before this fix such
   * a concern was silent — the pack certified without naming it anywhere
   * (plan §5: 「…見つからないこと、または未確定であることを必ず示す」).
   * Always present (possibly empty), mirroring `absences`.
   */
  undetermined: Array<{ id: string; term: string; reason: string }>;
}
