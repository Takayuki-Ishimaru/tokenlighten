/**
 * L1 — doc-authority serve honesty (2026-08-08).
 *
 * Measured defect (bench 2026-08-08-semantic-signal5-1, T05c, all 3 reps
 * byte-identical): the first task_pack over `bench/fixtures/aeroctl` served
 * 8 surfaces. Seven were whole small files; the eighth was
 *
 *   {role:"doc", path:".../CONTRACT.md", range:"1514-1514", symbol:"contract",
 *    why:"anchor-focus: explicit query identifier contract",
 *    code:"  to deviate from this contract (e.g., ...)",   // 83 bytes
 *    remaining_ranges:["1-1513"]}
 *
 * — the LAST line of a 1,514-line file (0.066%), because anchor-focus matched
 * the literal token `contract` at its last occurrence. The SAME response
 * asserted `coverage:"complete"`, `execution_contract.phase:"prepared"`,
 * `route.max_additional_tl_calls:0` and the prose "working set complete —
 * stop discovery". Every rep disbelieved that closure over the named
 * authority document and went hunting (10-20 discovery calls; one rep's
 * 20-call flail was 58.5% of the run's gate variance).
 *
 * The doc's own heading index — exact line ranges for every section — is
 * ALREADY computed and served on every `mode=slice` of the same handle. It
 * was simply never attached to the pack, so solvers guessed line numbers
 * before ever seeing the map.
 *
 * This module does NOT demote `prepared` and does NOT touch the certificate:
 * first_pack_ready is a proven win and wholesale demotion would re-open the
 * discovery-loop class. It follows the D1 precedent (`servedZoomAffordance`,
 * 2026-08-07): keep `prepared`, grant exactly ONE sanctioned same-handle
 * zoom, and stop asserting a closure the pack cannot support.
 */
import {
  buildMarkdownHeadingIndex,
  isMarkdownPath,
  parseMarkdownHeadings,
  MARKDOWN_SECTIONS_HINT,
  type MarkdownHeading,
  type MarkdownHeadingIndex,
  type MarkdownHeadingIndexEntry,
} from "../../util/markdownSections.js";
import { countLines } from "../../util/countLines.js";
import type { TaskPackSurface } from "./model.js";
import type { ContinuationCall } from "../../util/continuation.js";

/**
 * Served fraction at/above which a doc surface is a fair sample of its file
 * and needs no correction.
 *
 * Rationale: the observed defect served 0.066%. A doc whose served span is
 * under 2% is, by construction, not evidence about the other 98% — no
 * plausible query is answered by 1/50th of an authority document chosen by a
 * literal token match. 2% is also comfortably above the largest *legitimate*
 * anchor-focus doc serve seen in the corpus (a whole section of a long doc is
 * typically 2-8% of it), so a genuine section anchor is NOT flagged.
 */
export const DOC_SLIVER_MAX_SERVED_FRACTION = 0.02;

/**
 * Minimum file size for the sliver rule to apply at all.
 *
 * Rationale: below ~200 lines, 2% is under 4 lines and the *whole* file is
 * cheap to re-serve — `DOC_FULL_HINT_MAX_BYTES` (16KB) already governs that
 * path. Flagging tiny docs would add envelope weight with no navigation
 * value, since a short doc's heading index is barely smaller than the doc.
 */
export const DOC_SLIVER_MIN_TOTAL_LINES = 200;

/**
 * Entry/byte caps for the heading index attached to a sliver surface. Tighter
 * than the standalone `DOC_HEADINGS_CAP_BYTES` (4096) because this index rides
 * an already-large pack envelope: the whole affordance must stay within the
 * ~3KB overhead budget L1 was accepted under.
 */
export const DOC_SLIVER_HEADINGS_CAP_ENTRIES = 40;
export const DOC_SLIVER_HEADINGS_CAP_BYTES = 2048;

/**
 * Stable marker inside a doc-sliver route reason. Two other sites key off it:
 * `applyCompleteStopRoute` must not re-append the stop clause this lever just
 * removed (re-serve receipts), and `buildTaskExecutionContract` must let
 * `prepared` survive the sanctioned zoom budget.
 */
export const DOC_SLIVER_ROUTE_MARKER = "authority doc ";

/** Minimum concern-match score before a heading is named as THE zoom target. */
const DOC_SLIVER_MIN_MATCH_SCORE = 2;

/** Distinct body-token hits that count toward a section's score. */
const DOC_SLIVER_MAX_BODY_HITS = 6;

/** Query tokens too generic to steer a section choice. */
const DOC_SLIVER_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then",
  "code", "file", "files", "line", "lines", "read", "make", "fix",
  "fixes", "bug", "bugs", "issue", "please", "should", "would", "could",
  "contract", "md", "doc", "docs", "src", "test", "tests", "spec",
]);

export interface DocSliverPlan {
  /** Lines actually served by the surface. */
  servedLines: number;
  /** Total lines in the file. */
  totalLines: number;
  /** servedLines/totalLines, rounded for prose. */
  servedPercent: string;
  headings: MarkdownHeadingIndexEntry[];
  headingsTruncated: boolean;
  headingsTotal: number;
  headingsNote?: string;
  /**
   * C1: every parsed heading, retained so the index can be REBUILT at whatever
   * byte budget the pack actually has left instead of being built at the fixed
   * 2048B cap and sheared afterwards.
   */
  allHeadings: MarkdownHeading[];
  /** The zoom target's own span — the index's rank-0 focus, and the shrink's. */
  focus: { start: number; end: number };
  /** The executable, section-scoped zoom this pack owes the caller. */
  nextCall: ContinuationCall;
  /** Heading text the zoom targets, for the route prose. */
  targetHeading?: string;
  /** True when the target came from concern matching rather than structure. */
  concernMatched: boolean;
}

/** Inclusive line count of an "A-B" (or "A") range string; 0 when unparseable. */
export function rangeLineCount(range: string | undefined): number {
  if (range === undefined) return 0;
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(range.trim());
  if (m) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    return end >= start ? end - start + 1 : 0;
  }
  return /^\d+$/.test(range.trim()) ? 1 : 0;
}

/**
 * True when `surface` is a doc surface whose served span is a sliver of its
 * own file. Deliberately scoped to markdown docs: a small span on a CODE
 * surface is usually a precise symbol body (exactly what task_pack is for),
 * whereas a small span on a prose authority is a token coincidence.
 */
export function isDocSliverSurface(surface: TaskPackSurface, totalLines: number): boolean {
  if (surface.role !== "doc") return false;
  if (!isMarkdownPath(surface.path)) return false;
  if (totalLines < DOC_SLIVER_MIN_TOTAL_LINES) return false;
  // Only a DISCLOSED-partial serve can be a sliver: a surface with no
  // remaining_ranges is claiming to have served what it has, and a
  // fully-served doc must keep byte-identical behaviour.
  if ((surface.remaining_ranges?.length ?? 0) === 0) return false;
  const served = rangeLineCount(surface.range);
  if (served === 0) return false;
  return served / totalLines < DOC_SLIVER_MAX_SERVED_FRACTION;
}

/**
 * True when the served span IS a section of the document rather than an
 * arbitrary window inside one.
 *
 * This is the discriminator the fraction alone cannot make. A 9-line §7.6 of a
 * 1,325-line contract is 0.68% of the file — far under the sliver floor — but
 * it is a COHERENT UNIT: anchor-focus found the section the query was about,
 * which is exactly what anchor-focus is for, and re-describing it as a broken
 * promise would add envelope weight and drop a stop signal that is true. The
 * measured defect is the opposite shape: line 1514 of a 20-line section, i.e.
 * a token coincidence with no structural meaning.
 *
 * "Is a section" is generous on purpose — a serve covering most of a section
 * (headers trimmed, trailing blank lines dropped) still counts.
 */
function servedSpanIsSection(
  headings: readonly MarkdownHeading[],
  start: number,
  end: number,
): boolean {
  const servedLines = end - start + 1;
  for (const heading of headings) {
    const sectionLines = heading.endLine - heading.line + 1;
    if (sectionLines <= 0) continue;
    const overlap = Math.min(end, heading.endLine) - Math.max(start, heading.line) + 1;
    if (overlap <= 0) continue;
    // The serve must be mostly INSIDE this section and cover most OF it.
    if (overlap / servedLines >= 0.9 && overlap / sectionLines >= 0.9) return true;
  }
  return false;
}

/** ASCII identifier tokens of a query, lowercased, minus generic words. */
function queryTokens(query: string): string[] {
  const raw = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw) {
    if (token.length < 2) continue;
    const lower = token.toLowerCase();
    if (DOC_SLIVER_STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/** Distinct `tokens` occurring as whole words in `text` (case-insensitive). */
function wordHits(text: string, tokens: readonly string[]): number {
  if (text.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    // Word boundaries keep 2-char identifiers (FR/BL/FL/BR) from matching
    // inside unrelated words — the whole reason short tokens are admitted.
    const re = new RegExp(`(?:^|[^a-z0-9_])${token}(?:[^a-z0-9_]|$)`);
    if (re.test(lower)) hits++;
  }
  return hits;
}

/**
 * Pick the section a caller most likely needs. Heading-TEXT matches dominate
 * (weight 3); section-BODY matches break the common case where the query
 * names identifiers defined inside a section rather than in its title (the
 * aeroctl query names FR/BL/FL/BR, which live in the body of
 * "### 7.6 `<control/mixer.hpp>`"). Ties go to the more specific (shorter)
 * section, then to document order.
 */
function selectTargetHeading(
  headings: readonly MarkdownHeading[],
  lines: readonly string[],
  tokens: readonly string[],
): { heading: MarkdownHeading; score: number } | undefined {
  if (tokens.length === 0) return undefined;
  let best: { heading: MarkdownHeading; score: number; span: number } | undefined;
  for (const heading of headings) {
    const body = lines.slice(heading.line - 1, heading.endLine).join("\n");
    const score = 3 * wordHits(heading.text, tokens)
      + Math.min(wordHits(body, tokens), DOC_SLIVER_MAX_BODY_HITS);
    if (score < DOC_SLIVER_MIN_MATCH_SCORE) continue;
    const span = heading.endLine - heading.line + 1;
    if (
      best === undefined
      || score > best.score
      || (score === best.score && span < best.span)
    ) {
      best = { heading, score, span };
    }
  }
  return best ? { heading: best.heading, score: best.score } : undefined;
}

/**
 * Build the affordance a sliver doc surface owes: its heading index plus one
 * executable, section-scoped zoom call. Returns undefined when the file has
 * no headings at all (an index of nothing is pure overhead — the surface's
 * own `remaining_ranges` already states the gap).
 */
export function planDocSliver(
  surface: TaskPackSurface,
  content: string,
  query: string,
): DocSliverPlan | undefined {
  const lines = content.split(/\r?\n/);
  // countLines is the repo-wide trailing-newline-aware count that handle ranges
  // and edit bounds checks already agree on — a raw split() length would report
  // a 1,514-line file as 1,515 and put that phantom line in the prose.
  const totalLines = countLines(content);
  if (!isDocSliverSurface(surface, totalLines)) return undefined;
  const headings = parseMarkdownHeadings(content);
  if (headings.length === 0) return undefined;

  const servedLines = rangeLineCount(surface.range);
  const servedStart = Number(/^(\d+)/.exec(surface.range)?.[1] ?? "1");
  if (servedSpanIsSection(headings, servedStart, servedStart + servedLines - 1)) return undefined;
  const tokens = queryTokens(query);
  const match = selectTargetHeading(headings, lines, tokens);
  // Structure fallback: no concern match means we cannot claim to know WHERE
  // the answer is, so point at the document's own top-level structure (its
  // first substantive section) and let the attached index do the steering.
  const fallback = headings.find((h) => h.level > 1) ?? headings[0]!;
  const target = match?.heading ?? fallback;
  const targetRange = `${target.line}-${target.endLine}`;

  // Focus the index on the ZOOM TARGET, not on the served sliver. The sliver's
  // location is a token coincidence (the aeroctl defect anchored on the file's
  // LAST line), so focusing there spends the whole index budget describing the
  // end of the document and drops the section the task actually needs
  // (measured: "7.6 `<control/mixer.hpp>`" fell out of a 24-entry index).
  // Focusing on the target keeps that section AND its siblings at rank 0.
  const focus = { start: target.line, end: target.endLine };
  const index = buildMarkdownHeadingIndex(headings, {
    maxEntries: DOC_SLIVER_HEADINGS_CAP_ENTRIES,
    maxBytes: DOC_SLIVER_HEADINGS_CAP_BYTES,
    focus,
  });
  if (index.headings.length === 0) return undefined;

  return {
    allHeadings: headings,
    focus,
    servedLines,
    totalLines,
    servedPercent: formatPercent(servedLines, totalLines),
    headings: index.headings,
    headingsTruncated: index.truncated,
    headingsTotal: index.total,
    ...(index.note ? { headingsNote: index.note } : {}),
    nextCall: {
      tool: "read_file",
      arguments: { mode: "slice", handle: surface.handle, range: targetRange },
    },
    targetHeading: target.text,
    concernMatched: match !== undefined,
  };
}

/** "0.07%" / "1.3%" — enough precision to make a sliver look like one. */
function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

/**
 * Stamp the plan onto the surface, mirroring the EXACT field names
 * `mode=slice` already emits for the same index (`headings`,
 * `headings_truncated`, `headings_total`, `headings_note`, `sections_hint`)
 * so callers meet one vocabulary, not two.
 *
 * Also marks the surface `content_completeness:"partial"` — the existing
 * per-surface completeness vocabulary. The pack-level `coverage` stays
 * whatever the CODE working set earned; only the surface's own claim is
 * corrected.
 */
export function attachDocSliverAffordance(surface: TaskPackSurface, plan: DocSliverPlan): void {
  attachDocSliverSurfaceHonesty(surface, plan);
  attachDocSliverNavigation(surface, {
    headings: plan.headings,
    total: plan.headingsTotal,
    truncated: plan.headingsTruncated,
    ...(plan.headingsNote === undefined ? {} : { note: plan.headingsNote }),
  });
  attachDocSliverZoom(surface, plan);
}

/**
 * C1 FLOOR: the corrections that are true at ANY budget. This is the level the
 * degrade ladder may never go below while the pack fits at all — the pre-L1
 * surface (its sliver body + handle + remaining_ranges) plus the three facts
 * that cost a few dozen bytes and stop the pack lying about what it served.
 */
export function attachDocSliverSurfaceHonesty(surface: TaskPackSurface, plan: DocSliverPlan): void {
  surface.content_completeness = "partial";
  // A sliver-served reference doc is NOT a required edit surface, and the pack
  // already says so: the measured response's own `frontier` listed 6 handles
  // and the CONTRACT.md handle was not one of them, no `checks` named it, and
  // it carried no edit_intent. Saying it out loud matters because
  // `content_completeness:"partial"` on a surface the readiness model still
  // counts as REQUIRED charges the partial-surface-content factor and demotes
  // the certificate to needs-followup — trading one dishonesty (a false
  // closure over the doc) for another (a false "not ready" over a code working
  // set that genuinely is complete). Both facts are true and both are now
  // stated: the doc is partial, and it is context rather than an edit site.
  surface.required = false;
  surface.total_lines = plan.totalLines;
}

/**
 * C1: the NAVIGATION level — a heading index sized by the caller plus the
 * sections_hint that makes it usable. Attached only when the pack's own byte
 * budget has room for it; the two ride together (an index nobody knows how to
 * slice by, or a slice instruction with nothing to name, is half an affordance).
 */
export function attachDocSliverNavigation(
  surface: TaskPackSurface,
  index: MarkdownHeadingIndex,
): void {
  surface.headings = index.headings;
  if (index.truncated) {
    surface.headings_truncated = true;
    surface.headings_total = index.total;
    if (index.note !== undefined) surface.headings_note = index.note;
  }
  surface.sections_hint = MARKDOWN_SECTIONS_HINT;
}

/** C1: the ZOOM level — the one sanctioned, section-scoped, executable call. */
export function attachDocSliverZoom(surface: TaskPackSurface, plan: DocSliverPlan): void {
  surface.next_call = plan.nextCall;
}

/** C1 shrink support: clear the navigation level, leaving floor + zoom intact. */
export function clearDocSliverNavigation(surface: TaskPackSurface): void {
  surface.headings = undefined;
  surface.headings_truncated = undefined;
  surface.headings_total = undefined;
  surface.headings_note = undefined;
  surface.sections_hint = undefined;
}

/**
 * C1 shrink support: the zoom target span, recovered from the surface's OWN
 * next_call. The backstop runs far from planDocSliver (different function, no
 * plan in hand), and this is the same `${target.line}-${target.endLine}` the
 * plan put there — so rank-aware shrinking needs no extra bookkeeping.
 */
export function docSliverFocusFromSurface(
  surface: TaskPackSurface,
): { start: number; end: number } | undefined {
  const range = surface.next_call?.arguments["range"];
  if (typeof range !== "string") return undefined;
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(range.trim());
  if (m === null) return undefined;
  return { start: Number(m[1]), end: Number(m[2]) };
}

/**
 * C1: rebuild the heading index at an arbitrary byte budget. planDocSliver
 * builds one at the fixed DOC_SLIVER_HEADINGS_CAP_BYTES; the pack knows how
 * many bytes it can actually spend and re-sizes with this, keeping the SAME
 * rank order (focus section first) so a tiny budget still buys the entry the
 * task needs rather than the document's first N headings.
 */
export function buildDocSliverHeadingIndex(
  plan: DocSliverPlan,
  maxBytes: number,
): MarkdownHeadingIndex {
  if (maxBytes >= DOC_SLIVER_HEADINGS_CAP_BYTES) {
    return {
      headings: plan.headings,
      total: plan.headingsTotal,
      truncated: plan.headingsTruncated,
      ...(plan.headingsNote === undefined ? {} : { note: plan.headingsNote }),
    };
  }
  return buildMarkdownHeadingIndex(plan.allHeadings, {
    maxEntries: DOC_SLIVER_HEADINGS_CAP_ENTRIES,
    maxBytes,
    focus: plan.focus,
  });
}

/**
 * The route clause that replaces a "working set complete — stop discovery"
 * claim when a named authority doc is sliver-served. Deliberately avoids both
 * "stop discovery" and "working set complete": those phrases are the false
 * certificate this lever exists to remove, and solvers demonstrably read them
 * as permission to stop *and* as something to disprove.
 */
export function docSliverRouteClause(surface: TaskPackSurface, plan: DocSliverPlan): string {
  const where = plan.concernMatched && plan.targetHeading !== undefined
    ? `its heading index is attached and "${plan.targetHeading}" matches this task`
    : "its heading index is attached";
  return `code surfaces located — edit from resident handles; ${DOC_SLIVER_ROUTE_MARKER}${surface.path} is only ${plan.servedLines}/${plan.totalLines} lines served (${plan.servedPercent}), ${where}; ONE section-scoped read_file mode=slice of that handle is sanctioned first`;
}
