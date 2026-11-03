// anchorFocus — extracted implementation; imports point to the owning modules.
import type { AnchorFocusCandidate } from "./anchorFocus.js";
import type { AnchorFocusResult } from "./anchorFocus.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { TaskPackSurface } from "../model.js";
import { ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT } from "./seededPackBuilder2.js";
import { FileReadCache } from "./packBasics2.js";
import { HIGH_CONFIDENCE_THRESHOLD } from "./packBasics2.js";
import { MAX_REMAINING_RANGE_ENTRIES } from "./surfaceMaterialization.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { SEEDED_ANSWER_MAX_ANCHOR_WINDOWS } from "./packBasics2.js";
import { anchorFocusRunnerUpOutline } from "./anchorFocus3.js";
import { appendWhySegmentOnce } from "./seedResolution.js";
import { elideDocComments } from "../../../util/formatCompress.js";
import { languageForPath } from "../../../util/languages.js";
import { selectAnchorFocus } from "./anchorFocus3.js";

/**
 * Shared attach step for an anchor-focus hit, applied to the ALREADY-BUILT
 * surface (never touches candidateToSurface/whySummary): names the pick in
 * `why` instead of leaving it looking like an ordinary caller-supplied/
 * locator tag, and reuses TaskPackSurface's existing `outline` (string[])
 * affordance for the ready-to-run runner-up hints. Factored verbatim out of
 * buildSeededTaskPack's FILE-seed loop (behavior unchanged there) so the
 * locator-candidate path below attaches the exact same affordance.
 */
export function attachAnchorFocusAffordance(
  surface: TaskPackSurface,
  focus: AnchorFocusResult,
  filePath: string,
  workspace: string,
): void {
  const callerScoped = /(?:^|; )caller-supplied(?:-dir)?$/.test(surface.why ?? "");
  // A doc-section pick is checked FIRST: its literal-first arm carries the same
  // ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT score the code path uses, and a
  // Markdown heading is not a code identifier. The distinct wording also keeps
  // it out of the two "explicit query identifier" readers
  // (suppressFragmentOnlyFilenameMatches' workspace-unique symbol anchors and
  // reconcileContentSufficiency's runner-up exemption), both of which reason
  // about resolved CODE symbols.
  const focusWhy = focus.best.kind === "doc-section"
    ? `anchor-focus: query-matched section ${JSON.stringify(focus.best.name)}`
    : focus.best.kind === "module-header"
    ? `anchor-focus: query-matched module header of ${focus.best.name}`
    : focus.best.score >= ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT
    ? `anchor-focus: explicit query identifier ${focus.best.name}`
    : `anchor-focus: query-matched symbol ${focus.best.name}`;
  // Anchor focusing changes the selected range, not the authority of the
  // caller-provided path. Preserve that provenance in the existing compact
  // `why` field so readiness cannot mistake a scoped artifact for an
  // untrusted repository-wide token hit.
  surface.why = callerScoped ? appendWhySegmentOnce(focusWhy, "caller-supplied") : focusWhy;
  if (focus.runnerUps.length > 0) {
    surface.outline = anchorFocusRunnerUpOutline(focus.runnerUps, filePath, workspace);
  }
}

/** Inclusive line bounds of a `"<start>-<end>"` range, or undefined for any other shape. */
export function anchorWindowBounds(range: string | undefined): { start: number; end: number } | undefined {
  const match = range === undefined ? null : /^(\d+)-(\d+)$/.exec(range);
  if (match === null) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : undefined;
}

/**
 * WP-S2 rule 3 (TL_SEEDED_GENEROUS, answer profile only): the windows a
 * caller-NAMED file that is too large to serve whole should carry, instead of
 * the single `focus.best` pick.
 *
 * A caller who names four files and describes four things wants four answers;
 * the single-pick anchor gives one, and the recorded sessions then spent 2-4
 * turns zooming for the rest — which, at one turn per ~9-14 KB, costs more
 * than the windows would have. So take the SAME ranked candidate list
 * `selectAnchorFocus` already produced (`best` plus its runner-ups, in score
 * order) and keep up to SEEDED_ANSWER_MAX_ANCHOR_WINDOWS of them, subject to:
 *
 *   - `best` is always window 0 (the seed's own range/symbol was set from it);
 *   - a candidate whose body does not fit MAX_SURFACE_CODE_BYTES is skipped —
 *     that is the enclosing type this fix exists to get past;
 *   - a candidate that CONTAINS or is CONTAINED BY an already-kept one is
 *     skipped, so the windows are disjoint and nothing is served twice;
 *   - the running total stays within `fileBudget` (never more than
 *     MAX_SURFACE_CODE_BYTES, and less when the pack's own byte ceiling has
 *     already been spent on the other named files), so multi-window never
 *     spends more on one file than the single-window path was already
 *     allowed, and never more than the response can actually carry.
 *
 * Returns `[]` when only `best` qualifies, which keeps the caller on today's
 * single-surface shape.
 */
export function multiWindowAnchorFocus(
  focus: AnchorFocusResult,
  content: string,
  relPath: string,
  fileBudget: number,
): AnchorFocusCandidate[] {
  const bestBounds = anchorWindowBounds(focus.best.range);
  if (bestBounds === undefined) return [];
  const lines = content.split(/\r?\n/);
  const windowBytes = (bounds: { start: number; end: number }): number =>
    Buffer.byteLength(
      elideDocComments(lines.slice(bounds.start - 1, bounds.end).join("\n"), languageForPath(relPath), bounds.start),
      "utf8",
    );
  const budget = Math.min(MAX_SURFACE_CODE_BYTES, Math.max(0, fileBudget));
  const keptBounds: Array<{ start: number; end: number }> = [bestBounds];
  const kept: AnchorFocusCandidate[] = [focus.best];
  let spent = windowBytes(bestBounds);
  if (spent > budget) return [];
  for (const candidate of focus.runnerUps) {
    if (kept.length >= SEEDED_ANSWER_MAX_ANCHOR_WINDOWS) break;
    // A runner-up that scored nothing is a list entry, not evidence: serving
    // it would spend the file's window budget on a symbol the query never
    // mentioned. It still reaches the caller through the surface `outline`.
    if (candidate.score <= 0) continue;
    const bounds = anchorWindowBounds(candidate.range);
    if (bounds === undefined) continue;
    if (keptBounds.some((k) => bounds.start <= k.end && k.start <= bounds.end)) continue;
    const bytes = windowBytes(bounds);
    if (bytes > budget || spent + bytes > budget) continue;
    spent += bytes;
    keptBounds.push(bounds);
    kept.push(candidate);
  }
  return kept.length > 1 ? kept : [];
}

/**
 * WP-S2 rule 3: make the windows of ONE file account for that file exactly
 * once. `partialityStamp` stamps every surface with the complement of its own
 * range within the whole file, which is correct for a lone surface and
 * duplicated N times across N windows of the same file — the caller would
 * then re-read the same spans once per window. Replace those stamps with a
 * partition: each uncovered span is attached to the window it immediately
 * follows (the leading span goes to the first window), so the union of served
 * ranges and disclosed `remaining_ranges` is the file, with no span twice.
 *
 * `content_completeness` is left exactly as `partialityStamp` set it — it
 * labels an embed-level TRIM of the served slice, which this does not change.
 */
export function partitionAnchorWindowRemainders(windows: TaskPackSurface[], totalLines: number): void {
  const served: Array<{ start: number; end: number; surface: TaskPackSurface }> = [];
  for (const surface of windows) {
    const bounds = anchorWindowBounds(surface.range);
    if (bounds === undefined) return; // non-plain range: leave every stamp alone
    served.push({ ...bounds, surface });
  }
  served.sort((a, b) => a.start - b.start);
  const gapsFor = new Map<TaskPackSurface, string[]>(windows.map((surface) => [surface, []]));
  let cursor = 1;
  for (let i = 0; i < served.length; i++) {
    const entry = served[i]!;
    if (entry.start > cursor) {
      // The leading gap has no predecessor; give it to the first window.
      const owner = i === 0 ? entry.surface : served[i - 1]!.surface;
      gapsFor.get(owner)!.push(`${cursor}-${entry.start - 1}`);
    }
    cursor = Math.max(cursor, entry.end + 1);
  }
  if (cursor <= totalLines && served.length > 0) {
    gapsFor.get(served[served.length - 1]!.surface)!.push(`${cursor}-${totalLines}`);
  }
  for (const surface of windows) {
    const gaps = gapsFor.get(surface) ?? [];
    if (gaps.length === 0) delete surface.remaining_ranges;
    else surface.remaining_ranges = gaps.slice(0, MAX_REMAINING_RANGE_ENTRIES);
  }
}

/**
 * Anchor-focus for LOCATOR-produced candidates — the required-role FILL and
 * caller-supplied-DIR expansion loops in buildSeededTaskPack. Run 2026-07-10c:
 * selectAnchorFocus fired in 0/10 arm-A cells because its only call site was
 * the direct FILE-seed path, while every real pack call opens with
 * paths=["<dir>"]+query — those candidates reach the two loops instead, and
 * neither consulted the query for symbol selection, so a >4KB file embedded
 * nothing and agents fell back to slice chains.
 *
 * Trigger (all must hold): the candidate carries no SYMBOL pin (a
 * symbol-anchored candidate is already locate-precise — never overridden;
 * a locator range is NOT treated as a pin, because these loops' candidates
 * always arrive with a synthetic text window / candidateDetails range, so a
 * literal no-range gate would keep the feature dead — the 10c finding);
 * `query` is non-empty; and the candidate FILE's content (read through the
 * per-pack FileReadCache — no second disk read; sliceCode reuses the memo)
 * overflows MAX_SURFACE_CODE_BYTES.
 *
 * On a hit, returns the candidate re-pointed at the top pick's own
 * symbol+range — so the embedded code and the minted handle range match
 * exactly — with any pre-minted locator `handle` DROPPED (it still points at
 * the old window; candidateToSurface would otherwise reuse it verbatim since
 * the new range equals the new rawRange) and confidence lifted over the
 * embed gate (an anchor hit means the query names this symbol; same
 * Math.max bump augmentMissingRequiredRoleSurfaces applies). Returns
 * undefined — caller keeps today's behavior for that candidate — on zero
 * overlap or when any trigger condition fails.
 */
export async function anchorFocusForLocatorCandidate(
  candidate: ImpactCandidate,
  workspace: string,
  query: string,
  cache: FileReadCache,
): Promise<{ candidate: ImpactCandidate; focus: AnchorFocusResult } | undefined> {
  // An ordinary symbol-pinned locator candidate is already precise. The
  // directory resolver's explicit-identifier candidate is different: its
  // symbol came from the caller and its literal line may still be a comment.
  // On an oversized file, run anchor focus so the exact parsed body and the
  // normal runner-up affordance survive (small files are widened directly by
  // candidateToSurface's parsed-symbol path).
  if (candidate.symbol !== undefined && candidate.why !== "explicit-query-identifier") return undefined;
  if (query.trim().length === 0) return undefined;
  const content = cache.read(workspace, candidate.path);
  if (content === undefined) return undefined;
  if (Buffer.byteLength(content, "utf8") <= MAX_SURFACE_CODE_BYTES) return undefined;
  const focus = await selectAnchorFocus(content, candidate.path, query, cache);
  if (!focus) return undefined;
  const { handle: _staleWindowHandle, ...rest } = candidate;
  return {
    candidate: {
      ...rest,
      range: focus.best.range,
      symbol: focus.best.name,
      confidence: Math.max(candidate.confidence, HIGH_CONFIDENCE_THRESHOLD),
    },
    focus,
  };
}

// ---------------------------------------------------------------------------
// Explicit working-tree defect investigations can use changed source regions.
// Symptom wording alone does not establish any relationship to a git diff.
// ---------------------------------------------------------------------------

/** Words that mark a query as describing a defect rather than a feature addition. */
export const SYMPTOM_WORDS =
  /\b(bug|fix|fixes|fixing|broken|breaks|regression|race\s*condition|deadlock|crash(?:es|ing)?|leak(?:s|ing)?|windup|overflow|underflow|off[- ]by[- ]one|incorrect|wrong|invalid|stale|flaky|flapping|hang(?:s|ing)?|null\s*pointer|undefined\s*behaviou?r|corrupt(?:ed|ion)?|does\s*not\s*work|doesn'?t\s*work|not\s*working|fails?|failing|failure|error(?:s)?|misbehav|unexpected|reversed|inverted|swapped)\b/i;
