// packTrimming — extracted implementation; imports point to the owning modules.
import type { AnswerStructureMap } from "./answerPackBuilder2.js";
import type { PlanAidOptions } from "../frontierNeighbours.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { ARTIFACT_CONSUMER_RESERVE_BYTES } from "../artifactConsumers.js";
import { EDIT_CONTEXT_WHY } from "./focalFlow.js";
import { LISTED_ITEM_DERIVED_WHY } from "../listedScopeItems.js";
import { REQUIRED_ENUM_REVIEW_PURPOSE } from "../changeScopeContinuation.js";
import { activePackByteCeiling } from "./packBasics2.js";
import { advisoryWireBytes } from "../answerFirstFacts.js";
import { artifactSectionCandidates } from "../artifactSections.js";
import { attachFrontierNeighbourIndex } from "../frontierNeighbours.js";
import { attachUsageInventory } from "../usageInventory.js";
import { capForResult } from "./packState.js";
import { clampToActiveCeiling } from "./packBasics2.js";
import { composeAnswerFirstAdvisory } from "../answerFirstFacts.js";
import { csvRowsOf } from "./guideAndArtifactSurfaces.js";
import { csvRowsSelector } from "./guideAndArtifactSurfaces.js";
import { deriveCanonicalTaskDecision } from "../canonicalDecision.js";
import { isArtifactConsumerSurface } from "../artifactConsumers.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { packFairTrimEnabled } from "../../../util/flags.js";
import { packWireBytes } from "./packTrimming.js";
import { plainCsvCutNote } from "../artifactSections.js";
import { plainCsvRemainder } from "../artifactSections.js";
import { projectRootOf } from "../../locator/locateTaskContext.js";
import { protocolCallContext } from "../../../protocol/envelope.js";
import { queryWindowSectionNote } from "../artifactSections.js";
import { shedAuxiliaryEnumContexts } from "../auxiliaryEnumContextIntegration.js";
import { taskPackSizePreview } from "../../../protocol/taskPackSizePreview.js";

/**
 * 09e pollution honesty (see TaskPackResult.roots): when the FINAL (post-trim)
 * surfaces span >= 2 distinct non-workspace project roots, name them — field
 * plus a route.reason suffix carrying the re-scoping remedy — so a mixed pack
 * is visibly mixed instead of silently trusted. Sits at the shared exit so
 * every flow (locate, seeded paths[], partial fallback, diff) reports the
 * same way. Runs AFTER trimToCap so the roots reflect the surfaces actually
 * served — but that also means none of trimToCap's fitsInCap checks ever see
 * this addition. 2026-07-12 cap-splice fix: real root names run well past
 * "a few bytes" (every name is counted twice — once in `roots[]`, again
 * inside route.reason's parenthetical list — across up to MAX_SURFACES_
 * DISTINCT roots), so splicing it on unconditionally could reopen a budget
 * trimToCap just closed. `roots` is also NOT in trimToCap's own "Protected
 * top-level" list (mode/coverage/missing/next) — it was never meant to be
 * exempt from the cap. Apply speculatively and commit only what still fits:
 * full annotation, then roots[] alone (the compact, higher-signal-per-byte
 * form), then neither — the same shed-if-over-budget discipline findText.ts's
 * applyRoles uses for its own advisory per-file `role` annotations.
 */
export function annotateSpannedRoots(result: TaskPackResult): void {
  const countByRoot = new Map<string, number>();
  for (const s of result.surfaces) {
    const root = projectRootOf(s.path);
    if (root === "") continue;
    countByRoot.set(root, (countByRoot.get(root) ?? 0) + 1);
  }
  if (countByRoot.size < 2) return;
  const spanned = [...countByRoot.keys()].sort((a, b) => a.localeCompare(b));
  const route =
    result.route !== undefined && !result.route.reason.includes("surfaces span")
      ? {
          ...result.route,
          reason:
            result.route.reason +
            `; surfaces span ${spanned.length} project roots (${spanned.join(", ")}) — if the task targets one, re-scope with scope:{path:"<root>"} or name it in the query`,
        }
      : result.route;

  if (fitsInCap({ ...result, roots: spanned, route })) {
    result.roots = spanned;
    result.route = route;
    return;
  }
  if (fitsInCap({ ...result, roots: spanned })) {
    result.roots = spanned;
    return;
  }
  // Neither fits inside the budget trimToCap already closed — leave `result`
  // exactly as trimToCap delivered it rather than reopening that budget.
}

/**
 * turn-economy wave 2 (W2): combined byte budget for a served pack's GUIDANCE
 * metadata. E2 forensics: under the raised 24KB pack budget, packs carried
 * ever-longer inventories of NAMED-BUT-UNSERVED files (the `trimmed` candidate
 * paths, the `missing` role list, the free-text `create_note`) — every extra
 * entry is another crawl target that tends to cost the caller a turn. This
 * bounds those three lists TOGETHER so the raised budget flows to code BODIES
 * (surfaces), not to a bigger unserved-file inventory. Surfaces,
 * execution_contract and coverage are never touched.
 */
export const GUIDANCE_METADATA_CAP_BYTES = 1280;

/** Combined serialized size of the three W2 guidance fields (values only). */
export function guidanceMetadataBytes(result: TaskPackResult): number {
  let bytes = 0;
  if (result.trimmed !== undefined) bytes += Buffer.byteLength(JSON.stringify(result.trimmed), "utf8");
  if (Array.isArray(result.missing) && result.missing.length > 0) {
    bytes += Buffer.byteLength(JSON.stringify(result.missing), "utf8");
  }
  if (result.create_note !== undefined) bytes += Buffer.byteLength(JSON.stringify(result.create_note), "utf8");
  return bytes;
}

/**
 * W2: hold the combined guidance metadata under `budgetBytes` by dropping the
 * TAIL of each list least-essential-first (keeping the highest-ranked head:
 * `trimmed` is already ranked by candidate confidence, `missing` is ordered):
 *   1) `trimmed` candidate paths — "nothing required is missing on their
 *      account", so the least task-closing; dropped to empty if needed.
 *   2) the advisory `create_note`.
 *   3) `missing` roles/concerns — load-bearing honesty, trimmed only past its
 *      head (always keep >= 1 so a pack never silently hides that SOMETHING is
 *      missing) and only as a last resort.
 * Sets `guidance_trimmed:true` iff anything was dropped. Applied at the shared
 * emit choke point at ANY pack size, independent of the overall byte cap.
 */
export function capGuidanceMetadata(result: TaskPackResult, budgetBytes = GUIDANCE_METADATA_CAP_BYTES): void {
  if (guidanceMetadataBytes(result) <= budgetBytes) return;
  let dropped = false;
  if (Array.isArray(result.trimmed)) {
    while (result.trimmed.length > 0 && guidanceMetadataBytes(result) > budgetBytes) {
      result.trimmed.pop();
      dropped = true;
    }
    if (result.trimmed.length === 0) result.trimmed = undefined;
  }
  if (guidanceMetadataBytes(result) > budgetBytes && result.create_note !== undefined) {
    result.create_note = undefined;
    dropped = true;
  }
  if (Array.isArray(result.missing)) {
    while (result.missing.length > 1 && guidanceMetadataBytes(result) > budgetBytes) {
      result.missing.pop();
      dropped = true;
    }
  }
  if (dropped) result.guidance_trimmed = true;
}

// ---------------------------------------------------------------------------
// Trim the pack to capForResult(result) using the design-mandated order.
//
// Trim order: tree/create_note → outline → verify/checks/blockers/route → secondary surfaces → facts → why → likely_edits → intents
// Protected per surface: handle, path, range, role, code
// Protected top-level: mode, coverage, missing, next
//
// A1: `protectedSurfaces` (identity set, never serialized) marks
// caller-supplied surfaces that Phase 1 must never REMOVE — every supplied
// path must appear in the final pack, code-bearing or handle+skeleton-only.
// Phase 5 (code removal) still applies to protected surfaces same as any
// other: degrading a protected surface's code to handle+skeleton is exactly
// the sanctioned overflow behavior, only outright removal is barred.
// ---------------------------------------------------------------------------

/**
 * A1 shed helpers for inlined artifact bodies. Two distinct operations, applied
 * at two very different points in the trim order:
 *
 *  - `shrinkArtifactSections` walks each matching entry down artifactSectionCandidates'
 *    bounded ladder (largest variant that helps), keeping the entry — and therefore
 *    the source identity and the content — present but smaller;
 *  - `dropArtifactSections` removes the entry outright. The artifact's stub surface
 *    (handle + `extract` call) always survives, so nothing becomes unreachable; the
 *    removal is recorded in `artifact_sections_trimmed` rather than left silent.
 *
 * Returns true when anything changed, so the caller can re-check the cap.
 */
export function shrinkArtifactSections(
  result: TaskPackResult,
  matches: (artifactPath: string) => boolean,
): boolean {
  const sections = result.artifact_sections;
  if (sections === undefined || sections.length === 0) return false;
  let changed = false;
  for (const entry of sections) {
    if (!matches(normalizedRequestPath(entry.path))) continue;
    const ladder = artifactSectionCandidates(entry.section);
    const current = Buffer.byteLength(JSON.stringify(entry.section), "utf8");
    const smaller = ladder
      .map((candidate) => ({ candidate, bytes: Buffer.byteLength(JSON.stringify(candidate), "utf8") }))
      .filter((item) => item.bytes < current)
      .sort((a, b) => b.bytes - a.bytes)[0];
    if (smaller === undefined) continue;
    const before = entry.section;
    entry.section = smaller.candidate;
    entry.content_completeness = "partial";
    if ("sheet" in before && "sheet" in smaller.candidate) {
      // This cut may have dropped rows the entry's `next` already steps over.
      const rest = plainCsvRemainder(before, smaller.candidate, csvRowsOf(entry.remaining_sections));
      if (rest !== undefined) {
        entry.remaining_sections = [`rows ${rest}`];
        entry.next = {
          tool: "tl_read_file",
          arguments: { mode: "artifact", ...(entry.handle !== undefined ? { handle: entry.handle } : { path: entry.path }), ...csvRowsSelector(entry.path, rest) },
        };
        entry.note = plainCsvCutNote(before, smaller.candidate, " (pack byte budget)");
        changed = true;
        continue;
      }
    }
    entry.note = "sheet" in smaller.candidate && smaller.candidate.query_window !== undefined
      ? queryWindowSectionNote(smaller.candidate)
      : "artifact body reduced to fit the pack byte budget; fetch the full section with next";
    if (entry.next === undefined) {
      entry.next = { tool: "tl_read_file", arguments: { mode: "artifact", path: entry.path } };
    }
    changed = true;
  }
  return changed;
}

export function dropArtifactSections(
  result: TaskPackResult,
  matches: (artifactPath: string) => boolean,
): boolean {
  const sections = result.artifact_sections;
  if (sections === undefined || sections.length === 0) return false;
  const kept = sections.filter((entry) => !matches(normalizedRequestPath(entry.path)));
  if (kept.length === sections.length) return false;
  const shed = sections
    .filter((entry) => matches(normalizedRequestPath(entry.path)))
    .map((entry) => entry.path);
  if (kept.length > 0) result.artifact_sections = kept;
  else delete result.artifact_sections;
  result.artifact_sections_trimmed = [...(result.artifact_sections_trimmed ?? []), ...shed];
  // An `inlined[]` stamp may not outlive the body it names (§11.4). attachSupply
  // would drop it at the wire exit anyway; dropping it here keeps the byte
  // accounting of the remaining trim phases honest.
  if (result.inlined !== undefined) {
    const shedNormalized = new Set(shed.map(normalizedRequestPath));
    const inlined = result.inlined.filter((stamp) => {
      const stamped = /^artifact-section:(.+)#/.exec(stamp)?.[1];
      return stamped === undefined || !shedNormalized.has(normalizedRequestPath(stamped));
    });
    if (inlined.length > 0) result.inlined = inlined;
    else delete result.inlined;
  }
  return true;
}

// ---------------------------------------------------------------------------
// FX-M Change B (TL_PACK_FAIR_TRIM, 2026-09-19): water-filling truncation for
// trimToCap's Phase E caller-supplied-body ladder. See applyFairTrimWaterFilling
// below, called from Phase E itself.
// ---------------------------------------------------------------------------

/** Search floor for the shared per-body byte ceiling: below this, a body carries too little signal to keep separate from the legacy ladder's eventual full-body strip. */
export const FAIR_TRIM_FLOOR_BYTES = 512;

/**
 * Geometric backoff factor used when the binary search's chosen ceiling does
 * not actually fit once verified. capForResult() is a STEP function of pack
 * content (Phase E's own long-standing note below: "capForResult() SHRINKS as
 * code is removed"), not a smooth one, so the search's assumption that a
 * larger ceiling never fits worse than a smaller one can be wrong by a step;
 * walking the ceiling down by this factor re-tests against the live
 * measurement until it agrees (or the floor is reached).
 */
export const FAIR_TRIM_BACKOFF_FACTOR = 0.85;

/**
 * Slack (in body bytes, summed over the truncated bodies) the water-filling
 * pass leaves under the cap for the fields dedupeTrimAndPersist re-attaches
 * AFTER trimToCap returns -- see the HEADROOM note in
 * applyFairTrimWaterFilling. 3 KiB covers the compact execution contract
 * (~1-2 KB) plus the small rollup/roots annotations with margin.
 */
export const FAIR_TRIM_RESERVE_BYTES = 3072;

/** Snapshot of one surface's pre-fair-trim body state, so every probe restores from the TRUE original rather than compounding a previous probe's truncation. */
export interface FairTrimSnapshot {
  code: string;
  contentCompleteness: TaskPackSurface["content_completeness"];
  remainingRanges: string[] | undefined;
}

/** `lines[i]`'s cumulative UTF-8 byte cost when rejoined as `lines.slice(0, i + 1).join("\n") + "\n"` — precomputed once per surface so each probe's truncation point is a binary search over this array instead of a re-join + re-measure. */
export interface LineByteTable {
  lines: string[];
  cumulativeBytes: number[];
}

export function buildLineByteTable(code: string): LineByteTable {
  const lines = code.split("\n");
  const cumulativeBytes: number[] = [];
  let acc = 0;
  for (const line of lines) {
    acc += Buffer.byteLength(line, "utf8") + 1; // +1 for the "\n" the rejoin adds after every line
    cumulativeBytes.push(acc);
  }
  return { lines, cumulativeBytes };
}

/**
 * The longest whole-line prefix of `table` whose rejoined UTF-8 byte length
 * is <= limitBytes, keeping at least one line even when that single line
 * alone exceeds limitBytes (the caller-supplied-body contract: degrade, never
 * silently vanish).
 */
export function lineByteTablePrefix(table: LineByteTable, limitBytes: number): string {
  const { lines, cumulativeBytes } = table;
  let lo = 0;
  let hi = cumulativeBytes.length - 1;
  let bestIdx = -1; // 0-based index of the last line INCLUDED, or -1 if none fit
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cumulativeBytes[mid]! <= limitBytes) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const keep = bestIdx >= 0 ? bestIdx + 1 : 1;
  return lines.slice(0, keep).join("\n") + "\n";
}

/**
 * TL_PACK_FAIR_TRIM: water-filling truncation across the caller-supplied
 * bodies in `targets`. Finds the largest shared per-body byte ceiling L
 * (binary search in [FAIR_TRIM_FLOOR_BYTES, the largest original body's own
 * byte length], probed on each surface's ORIGINAL bytes every time -- never
 * on a previous probe's output) such that truncating every body longer than L
 * to its longest whole-line prefix <= L bytes, and leaving every body already
 * <= L untouched, makes `result` fit its cap (measured ONLY via the existing
 * `fitsInCap`, never a new response-level byte-measurement site). Small
 * bodies therefore stay whole; only large bodies shrink, and every one that
 * shrinks lands on the same ceiling (within one line's worth of bytes, since
 * the kept prefix is the LONGEST one at or under L).
 *
 * On success, mutates every target surface's `code`/`content_completeness`/
 * `remaining_ranges` to its final (fitting) state and returns true. On
 * failure -- no L at or above FAIR_TRIM_FLOOR_BYTES makes the pack fit --
 * restores every target surface to its ORIGINAL code/completeness/
 * remaining_ranges and returns false, so the caller can fall through to the
 * legacy halving ladder exactly as if this pass had never run.
 */
export function applyFairTrimWaterFilling(
  result: TaskPackResult,
  targets: ReadonlySet<TaskPackSurface>,
): boolean {
  const originals = new Map<TaskPackSurface, FairTrimSnapshot>();
  const lineTables = new Map<TaskPackSurface, LineByteTable>();
  let maxBodyBytes = 0;

  for (const surf of targets) {
    if (surf.code === undefined) continue;
    originals.set(surf, {
      code: surf.code,
      contentCompleteness: surf.content_completeness,
      remainingRanges: surf.remaining_ranges,
    });
    lineTables.set(surf, buildLineByteTable(surf.code));
    const bytes = Buffer.byteLength(surf.code, "utf8");
    if (bytes > maxBodyBytes) maxBodyBytes = bytes;
  }
  // Nothing to balance, or every body is already at/under the floor -- the
  // legacy ladder handles a single body fine and gains nothing from a search.
  if (originals.size === 0 || maxBodyBytes <= FAIR_TRIM_FLOOR_BYTES) return false;

  const restore = (): void => {
    for (const [surf, snap] of originals) {
      surf.code = snap.code;
      surf.content_completeness = snap.contentCompleteness;
      surf.remaining_ranges = snap.remainingRanges;
    }
  };

  const apply = (limitBytes: number): void => {
    for (const [surf, snap] of originals) {
      const originalBytes = Buffer.byteLength(snap.code, "utf8");
      if (originalBytes <= limitBytes) {
        surf.code = snap.code;
        surf.content_completeness = snap.contentCompleteness;
        surf.remaining_ranges = snap.remainingRanges;
        continue;
      }
      surf.code = lineByteTablePrefix(lineTables.get(surf)!, limitBytes);
      surf.content_completeness = "partial";
      surf.remaining_ranges = surf.range === undefined
        ? snap.remainingRanges
        : [...new Set([...(snap.remainingRanges ?? []), surf.range])];
    }
  };

  // The floor itself must fit before a search is worthwhile at all.
  apply(FAIR_TRIM_FLOOR_BYTES);
  if (!fitsInCap(result)) {
    restore();
    return false;
  }

  // Binary search the largest L in [FLOOR, maxBodyBytes] for which apply(L)
  // fits, assuming (not yet verified) rough monotonicity.
  let lo = FAIR_TRIM_FLOOR_BYTES;
  let hi = maxBodyBytes;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    apply(mid);
    if (fitsInCap(result)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  // Verify + geometric backoff: capForResult is a step function of pack
  // content (see this function's own doc comment), so the search above may
  // have picked an L that does not actually fit. FAIR_TRIM_FLOOR_BYTES is
  // already PROVEN to fit (checked above), so this loop is guaranteed to
  // reach a fitting ceiling at or before it gets there.
  let ceiling = lo;
  apply(ceiling);
  while (!fitsInCap(result) && ceiling > FAIR_TRIM_FLOOR_BYTES) {
    const stepped = Math.floor(ceiling * FAIR_TRIM_BACKOFF_FACTOR);
    ceiling = Math.max(FAIR_TRIM_FLOOR_BYTES, Math.min(stepped, ceiling - 1));
    apply(ceiling);
  }
  if (fitsInCap(result)) {
    // HEADROOM. The ceiling found above is the LARGEST one that fits, i.e. the
    // pack now sits within a line's worth of bytes of its cap -- and
    // dedupeTrimAndPersist still re-attaches fields after trimToCap returns
    // (the compact execution contract, rollups, roots). With no slack left,
    // that pushes the pack back over the cap and the post-trim safety net
    // sheds a WHOLE caller-named surface (measured: 1 of 9 named sources lost
    // its handle, 87 B over a 22 KB cap). The legacy halving ladder never hit
    // this because it overshoots by up to half a body. Give the same slack
    // back deliberately: lower the shared ceiling until the truncated bodies
    // have released FAIR_TRIM_RESERVE_BYTES more than the fit required.
    // Sized from each body's own byte length only -- no new response-level
    // measurement site.
    let truncatedCount = 0;
    for (const snap of originals.values()) {
      if (Buffer.byteLength(snap.code, "utf8") > ceiling) truncatedCount++;
    }
    if (truncatedCount > 0 && ceiling > FAIR_TRIM_FLOOR_BYTES) {
      const lowered = Math.max(
        FAIR_TRIM_FLOOR_BYTES,
        ceiling - Math.ceil(FAIR_TRIM_RESERVE_BYTES / truncatedCount),
      );
      if (lowered < ceiling) {
        apply(lowered);
        // A lower ceiling can only shrink the pack, but capForResult steps down
        // as code is removed; if that ever makes the lowered state not fit,
        // return to the proven ceiling rather than ship an over-cap pack.
        if (!fitsInCap(result)) apply(ceiling);
      }
    }
    return true;
  }
  restore();
  return false;
}

export function trimToCap(
  result: TaskPackResult,
  protectedSurfaces?: ReadonlySet<TaskPackSurface>,
  /**
   * A1: normalized paths of the artifacts the CALLER named. Mirrors
   * protectedSurfaces semantics for artifact bodies — such a body may be
   * degraded, but only after every other body (including code) is gone, because
   * it is the very content the caller asked for. An artifact NOT in this set is
   * a discovery affordance and its body is shed early.
   */
  protectedArtifactPaths?: ReadonlySet<string>,
): TaskPackResult {
  // Artifact consumers are optional context: shed whole, lowest-ranked first,
  // before any phase below touches the pack, so a pack that cannot afford them
  // keeps every part it had without them. A no-op for any other pack.
  shedAuxiliaryEnumContexts(result.surfaces, () => fitsInCap(result));
  shedArtifactConsumerSurfaces(result);
  if (fitsInCap(result)) return result;

  // RV-4(c): caller-supplied windows are independent targets, not a ranked
  // discovery list. Remember them before Phase B sheds `why`, so a tight cap
  // can share the inline budget between them instead of preserving only the
  // first target's body by construction.
  const callerRangeBodySurfaces = new Set(result.surfaces.filter((surface) =>
    surface.why?.includes("caller-supplied") === true && surface.code !== undefined,
  ));

  // DESIGN-v0.8 §A7: the partial-pack `tree` is a navigation convenience (find
  // replacement), not task-closing content — drop it first, before any
  // per-surface affordance. `explore action=tree` remains reachable from
  // `next` regardless.
  if (result.tree !== undefined) {
    result.tree = undefined;
  }
  if (fitsInCap(result)) return result;

  // Item 4: create_note is the newest, least-essential pack-level field — a
  // "you might need to create a new file" tip is advisory speculation, not
  // task-closing content, so it is shed at the same earliest priority as
  // `tree`.
  if (result.create_note !== undefined) {
    result.create_note = undefined;
  }
  if (fitsInCap(result)) return result;

  // Drop the least-essential per-surface affordance first.
  // DESIGN-v0.8 §A5 deliverable 3: `outline` is a navigation convenience for
  // a DIFFERENT section of a contract doc, not needed to close THIS task
  // (the matched section's `code` already covers that), so it is dropped at
  // the earliest priority. DESIGN-v0.8 §C1 item 3: `slice_wider` was dropped
  // from the surface shape entirely (implied by the always-present
  // `handle`), so this phase no longer has a slice_wider field to clear.
  for (const surf of result.surfaces) {
    if (surf.outline !== undefined) {
      surf.outline = undefined;
    }
  }
  if (fitsInCap(result)) return result;

  // Phase 0: drop advisory metadata first. Handles and surfaces are the value.
  if (result.verify !== undefined) {
    result.verify = undefined;
  }
  if (fitsInCap(result)) return result;
  if (result.checks !== undefined) {
    result.checks = undefined;
  }
  if (fitsInCap(result)) return result;
  // The stop/continue summary duplicates route at this point. Under a tight
  // cap, preserve the actionable route and blocking calls; the execution
  // contract is re-added after trimming only when it still fits.
  //
  // P0a §6.2 honesty (2026-08-13): `profile_binding` used to be deleted HERE,
  // in the same breath as the contract — so the one field the spec says is
  // always emitted silently vanished under cap pressure, and a caller could
  // not tell an inferred profile from a declared one exactly when the pack was
  // most aggressive. It is ~150B of provenance; it now has the ladder's LOWEST
  // priority instead (see the tail after Phase G).
  result.execution_contract = undefined;
  if (fitsInCap(result)) return result;
  // A4: when the route actually flipped to locate_missing_surfaces,
  // blocking_next_steps carries the per-unmatched-concern-token follow-up
  // calls — dropping it here is exactly backwards: it strips the honest
  // "what to do next" guidance precisely when the pack is fattest (and thus
  // most likely to need trimming at all). Protect it in that case; it still
  // falls to the same fate as `route` below when action is NOT
  // locate_missing_surfaces (nothing to protect — item 3's original
  // reasoning still applies there).
  const protectBlockingNextSteps = result.route?.action === "locate_missing_surfaces";
  if (!protectBlockingNextSteps && result.blocking_next_steps !== undefined) {
    result.blocking_next_steps = undefined;
  }
  if (fitsInCap(result)) return result;
  if (result.route !== undefined) {
    result.route = undefined;
  }
  if (fitsInCap(result)) return result;
  // blocking_next_steps was protected above specifically because `route`
  // still existed to prove the flip was live; now that route itself has
  // been dropped (pack still over cap even without it), the protection
  // reason no longer applies — drop it last, after every other Phase-0
  // field, rather than never.
  if (protectBlockingNextSteps && result.blocking_next_steps !== undefined) {
    result.blocking_next_steps = undefined;
  }
  if (fitsInCap(result)) return result;

  // DESIGN-v0.9 §4.3 TRIM-ORDER INVERSION. The old order ran the
  // whole-surface-drop loop (HANDLE loss) BEFORE the code-body strip (handle
  // preserved) — the expensive, handle-destroying operation first, violating
  // the codebase's own "losing a handle is bad; losing embedded code alone is
  // fine" philosophy. Inverted below: shed advisory metadata, then strip code
  // BODIES (handles kept), and only drop whole surfaces as the LAST resort,
  // once the code-less envelope alone still exceeds cap.

  // Phase A: drop facts from all surfaces.
  for (const surf of result.surfaces) {
    if (surf.facts !== undefined) {
      surf.facts = undefined;
    }
  }
  if (fitsInCap(result)) return result;

  // Phase B: compact authority-bearing review provenance; drop advisory why.
  for (const surf of result.surfaces) {
    if (surf.why?.startsWith(LISTED_ITEM_DERIVED_WHY)) surf.why = `${LISTED_ITEM_DERIVED_WHY}:`;
    else if (surf.why?.startsWith(REQUIRED_ENUM_REVIEW_PURPOSE)) surf.why = REQUIRED_ENUM_REVIEW_PURPOSE;
    else if (surf.why?.startsWith(EDIT_CONTEXT_WHY)) surf.why = `${EDIT_CONTEXT_WHY}:`;
    else surf.why = undefined;
  }
  if (fitsInCap(result)) return result;

  // Phase C: drop likely_edits from all surfaces. DESIGN-v0.8 §C1 item 1
  // already confines likely_edits to the PRIMARY surface at emission time
  // (secondary surfaces never carry it) — this phase now clears it from at
  // most one surviving surface in practice. Left as a full loop rather than
  // indexing surfaces[0] directly: it stays trivially correct regardless of
  // which surface(s) actually still hold the field, at no extra cost (the
  // list is already bounded to MAX_SURFACES_DISTINCT).
  for (const surf of result.surfaces) {
    if (surf.likely_edits !== undefined) {
      surf.likely_edits = undefined;
    }
  }
  if (fitsInCap(result)) return result;

  // Phase D: drop advisory edit intents/checks only after handle targets.
  for (const surf of result.surfaces) {
    if (surf.edit_intent !== undefined) {
      surf.edit_intent = undefined;
    }
    if (surf.done_check !== undefined) {
      surf.done_check = undefined;
    }
  }
  if (fitsInCap(result)) return result;

  // Phase D2 (A1): an artifact the caller never NAMED is a discovery affordance,
  // so its inlined body is the cheapest real content in the pack — shed before
  // any code body. Shrink down the bounded ladder first, then drop the entry
  // (its stub surface + `extract` call always survive).
  //
  // An EMPTY/absent `protectedArtifactPaths` means "which artifacts the caller
  // named is unknown here" (the artifact_build flow bundles its own sections and
  // does not compute the set), NOT "none of them were named" — so this phase
  // stays a no-op and every artifact body falls to Phase G's last-resort shed.
  const artifactNamingKnown = protectedArtifactPaths !== undefined && protectedArtifactPaths.size > 0;
  const unnamedArtifact = (artifactPath: string): boolean =>
    artifactNamingKnown && !protectedArtifactPaths!.has(artifactPath);
  if (shrinkArtifactSections(result, unnamedArtifact) && fitsInCap(result)) return result;
  if (dropArtifactSections(result, unnamedArtifact) && fitsInCap(result)) return result;

  // Phase E (§4.3): strip embedded code BODIES — the surface, its role, and its
  // HANDLE all survive; the agent re-slices via the same handle. Stamping
  // content_completeness:"partial" + remaining_ranges (the whole embedded range
  // is now un-embedded) NEVER flips coverage (§4.4: a byte budget may not flip
  // coverage by itself — that was the "partial-by-budget" anti-pattern that
  // branded complete packs partial and listed covered roles as "missing").
  // NOTE capForResult() SHRINKS as code is removed (32768→28672→24576), so
  // fitsInCap is re-evaluated against the LIVE cap after each strip.
  // Before whole-body shedding, trim caller-pinned bodies in balanced rounds.
  // This protects the independent multi-target contract at a tiny cap: each
  // target retains a useful prefix (and an honest remainder) while there is
  // budget for any body at all. Only once equal rounds cannot make the result
  // fit does the ordinary body-removal ladder take over.
  //
  // FIX-FC (eval-0927 review finding 7, 2026-09-27): the halving loop below
  // used to run only `if (callerRangeBodySurfaces.size >= 2)` — a SOLE
  // caller-ranged target (`size === 1`) skipped straight to the whole-body
  // drop loop a few lines down, which always ships `code:undefined` +
  // `remaining_ranges:[surf.range]` (the ENTIRE originally-requested range,
  // never a fitted prefix) the moment the surface does not already fit.
  // Live repro: `targets:[{path,range:"300-900"}]` (601 lines) against a 6200
  // B budget shipped NO body at all — `evidence[0]` was bodyless with
  // `remaining:["300-900"]`, and the response's own `decision.next` named
  // that SAME `range:"300-900"` verbatim, so running it — exactly what
  // AGENTS.md tells a caller to do with an executable `next` — reproduced
  // the identical bodyless response forever. `protocol/budget/shedders/
  // readText.ts`'s `truncateLargestBody` (a `read.text`/`read.batch` request
  // with no `query`) already halves geometrically down to one line before
  // giving up; a task-pack build with exactly one caller-ranged target owes
  // the identical courtesy — "ship the head that fits, like every other
  // budget cut" — instead of an all-or-nothing drop. `size >= 1` below is the
  // fix: the loop's own body already generalizes to one surface with no
  // change (it filters by SET MEMBERSHIP, never by count), so widening the
  // gate is the whole change. `applyFairTrimWaterFilling`'s own multi-target
  // BALANCING has no single-target question to answer, so it stays scoped to
  // `size >= 2` — unaffected by this fix.
  if (callerRangeBodySurfaces.size >= 2) {
    // FX-M Change B (TL_PACK_FAIR_TRIM): try the water-filling pass BEFORE the
    // legacy halving loop. On success it already left `result` in its final,
    // fitting state (same early-return shape the legacy loop itself uses at
    // the top of every round). On failure it has already restored every
    // target surface's original bytes, so the legacy loop below runs exactly
    // as it would with the flag off. Flag OFF: this call is never made, so
    // the legacy loop is the only code that ever executes here.
    if (packFairTrimEnabled() && applyFairTrimWaterFilling(result, callerRangeBodySurfaces)) {
      return result;
    }
  }
  if (callerRangeBodySurfaces.size >= 1) {
    for (;;) {
      if (fitsInCap(result)) return result;
      let changed = false;
      for (const surf of result.surfaces) {
        if (!callerRangeBodySurfaces.has(surf) || surf.code === undefined) continue;
        const lines = surf.code.split("\n");
        if (lines.length <= 2) continue;
        const kept = Math.max(1, Math.ceil((lines.length - 1) / 2));
        const reduced = lines.slice(0, kept).join("\n") + "\n";
        if (reduced.length >= surf.code.length) continue;
        surf.code = reduced;
        surf.content_completeness = "partial";
        surf.remaining_ranges = surf.range === undefined
          ? surf.remaining_ranges
          : [...new Set([...(surf.remaining_ranges ?? []), surf.range])];
        changed = true;
      }
      if (!changed) break;
    }
  }
  for (let i = result.surfaces.length - 1; i >= 0; i--) {
    const surf = result.surfaces[i]!;
    if (surf.code !== undefined) {
      surf.code = undefined;
      surf.content_completeness = "partial";
      surf.remaining_ranges = [surf.range];
      if (fitsInCap(result)) return result;
    }
  }

  // Phase F (§4.3): whole-surface drop — the LAST resort, reached ONLY when the
  // pack still exceeds cap after every body has been stripped (the code-less
  // envelope alone is over budget — rare now the order is inverted). This is
  // the ONE path that may flip coverage: the dropped surface's role really is
  // gone (its handle, not just its inline code), so it becomes an honest
  // "missing-roles" partial. A1: never drop a surface in `protectedSurfaces` —
  // remove the LAST unprotected surface instead (skip over protected ones
  // rather than assuming they occupy a contiguous prefix, since native-pair
  // augmentation can splice an unprotected sibling in between two protected
  // seeds). Always keep at least 1 surface overall. `surface_drops` counts
  // these so the bench sees size-triggered handle loss; dedupeTrimAndPersist
  // recomputes route/next against the post-drop state so a coverage flip never
  // ships a stale "you're done" next.
  let surfaceDrops = 0;
  for (;;) {
    if (result.surfaces.length <= 1 || fitsInCap(result)) break;
    let dropIdx = -1;
    for (let i = result.surfaces.length - 1; i >= 0; i--) {
      if (!protectedSurfaces?.has(result.surfaces[i]!)) {
        dropIdx = i;
        break;
      }
    }
    if (dropIdx === -1) break; // every remaining surface is protected
    const dropped = (result.surfaces as TaskPackResultSurface[]).splice(dropIdx, 1)[0]!;
    // Artifact surfaces are discovery affordances, never coverage/ranking roles.
    if (!isArtifactTaskPackSurface(dropped)) {
      if (!result.missing.includes(dropped.role)) {
        result.missing.push(dropped.role);
      }
      result.coverage = "partial";
      result.coverage_reason = "missing-roles";
      surfaceDrops++;
    }
  }
  if (surfaceDrops > 0) result.surface_drops = surfaceDrops;

  // Phase G (A1) — LAST. A CALLER-NAMED artifact's inlined body is the content
  // the request was about, so it outranks every other body in the pack: it is
  // shed only here, after advisory metadata, every code body, and even whole
  // unprotected surfaces are gone. Shrink first (identity + some content
  // survive); degrade to handle+stub only if the pack is STILL over cap with
  // nothing else left to give — the same "degrade, never silently vanish"
  // contract protectedSurfaces gives a caller-supplied code surface.
  const namedArtifact = (artifactPath: string): boolean =>
    !artifactNamingKnown || protectedArtifactPaths!.has(artifactPath);
  if (shrinkArtifactSections(result, namedArtifact) && fitsInCap(result)) return result;
  if (dropArtifactSections(result, namedArtifact) && fitsInCap(result)) return result;

  // P0a §6.2 honesty (2026-08-13) — profile provenance is the ABSOLUTE last
  // resort. It used to be deleted in Phase 0 alongside the execution contract,
  // so the one field the spec calls always-emitted vanished on exactly the
  // packs that trimmed hardest, and a caller could no longer tell a declared
  // profile from an inferred one. It is ~150B: shedding it before any code
  // body could never have been the difference between fitting and not, so it
  // was pure loss. It still PARTICIPATES in the ladder (a pack that is over
  // cap with every body, surface, and artifact already gone gives it up too),
  // it simply has the lowest priority of anything the ladder can shed.
  if (result.profile_binding !== undefined) {
    result.profile_binding = undefined;
  }

  // The pack is as trimmed as it can be — return it even if slightly over cap.
  return result;
}

/** Whether the pack, measured as the transport ships it, is within its cap. Exported for taskPackSizePreview.spec.ts. */
export function fitsInCap(result: TaskPackResult): boolean {
  return packWireBytes(result) <= capForResult(result);
}

/**
 * Whether the pack fits its cap AND still fits with its `next` as the model
 * would have to send it (taskPackSizePreview.ts, "restated": the request
 * restated, every owed window listed, no root `cwd`), not only as the transport
 * compacts it into a cursor. The full execution contract — the capability gaps
 * that ride a discover as `decision.gaps` — is OPTIONAL content: `contractForTrim`
 * sheds it whole when the pack does not fit (a gap is semantic: no call rides it,
 * more bytes never close it, and the certificate restates it, so the reply that
 * closes the chain carries what it must). Compacting the `next` is a transport
 * optimization, and the room it makes belongs to the reply's rows — the shed
 * ladder, which counts what ships — not to advisory content; so the contract is
 * admitted only when the pack fits both ways. Every build before the size preview
 * counted the shipped `next` applied this admission by accident, since the preview
 * counted the restated call, and the workspace's path with it; this keeps the
 * admission and drops the path, so a reply does not move with it (codex-copilot-proxy
 * r18 T03, 2026-10-23: the discover replies of the whole-body chain had carried 369 B
 * of `gaps` the recording does not have). Exported for taskPackSizePreview.spec.ts.
 */
export function fitsInCapUncompacted(result: TaskPackResult): boolean {
  if (!fitsInCap(result)) return false;
  const restated = taskPackSizePreview(result, protocolCallContext()?.clientId, "restated");
  return restated === undefined || restated <= capForResult(result);
}

/** trimToCap's first step: drop artifact consumers until the pack keeps ARTIFACT_CONSUMER_RESERVE_BYTES spare. */
export function shedArtifactConsumerSurfaces(result: TaskPackResult): void {
  if (!result.surfaces.some(isArtifactConsumerSurface)) return;
  for (let index = result.surfaces.length - 1; index >= 0; index--) {
    if (packWireBytes(result) + ARTIFACT_CONSUMER_RESERVE_BYTES <= capForResult(result)) return;
    if (isArtifactConsumerSurface(result.surfaces[index])) result.surfaces.splice(index, 1);
  }
}

/**
 * V15-NBR/FUI (2026-09-30, review pass 2 P1-5): the two flag-gated plan aids
 * (`plan.neighbours`, `plan.usages`) attach AFTER the shed ladder has fixed
 * this pack's size. Under an active caller/env/profile byte ceiling
 * (`activePackByteCeiling`: `budget.bytes`, TOKENLIGHTEN_TASK_PACK_MAX_BYTES,
 * the VS Code profile) they may only use the headroom left under that HARD
 * limit — or they would push a pack that fit it back over it. Without one,
 * only their own caps (~1 KiB / ~1.5 KiB) bound them: the type tier the
 * ladder shed to is the server's own economy target, not a limit a reader
 * enforces, and a large pack that filled its tier would otherwise never
 * carry them. The headroom is measured lazily (each attach hook calls it only
 * once its own flag is ON, so a flags-OFF pack pays nothing and stays
 * byte-identical) and through the same `packWireBytes` measurement the
 * ladder itself uses (wireBudgetG8Fence.spec.ts); the usage inventory runs
 * second, so its headroom already counts the neighbour rows.
 */
export function attachPlanAids(result: TaskPackResult, workspace: string, query: string): void {
  const opts: PlanAidOptions = {
    headroom: () => {
      if (activePackByteCeiling() === undefined) return Number.POSITIVE_INFINITY;
      return Math.max(0, clampToActiveCeiling(Number.MAX_SAFE_INTEGER) - packWireBytes(result));
    },
  };
  attachFrontierNeighbourIndex(result, workspace, query, opts);
  attachUsageInventory(result, workspace, query, opts);
}

/**
 * TL_EFF_MAP_ANSWER_FIRST: the packs that went out as an answer-first map (the core served, the other
 * bodies owed and named). A pack's record remembers it (`ServedPackRecord.answerFirst`), so a restated
 * request can say which windows the page left owed instead of marking its whole extent.
 */
export const answerFirstPacks = new WeakSet<TaskPackResult>();

/** How an answer-first map's pack ended (`attachAnswerFirstAdvisory`). */
export type AnswerFirstShip =
  /** The advisory rides the pack, which fits its ceiling with it (or nothing was owed, so nothing is stated). */
  | "shipped"
  /** The pack's decision is not the answer the map was planned for: it states nothing. */
  | "not-answer"
  /** The pack is the answer, but not even the first tier of the facts fits under the ceiling beside it. */
  | "no-room";

/**
 * TL_EFF_MAP_ANSWER_FIRST: the facts about the member bodies an answer-first map
 * left owed ride the reply's `advisory`, in the room the finished pack has left
 * under its ceiling — attached after the shed ladder, like the plan aids above.
 * The room is MEASURED, not allowed for: the facts are composed for the whole room the
 * pack leaves, attached, and the pack is measured again as it will ship, with the
 * advisory on it (`taskPackSizePreview`, the first measurement of the shed ladder's
 * `packWireBytes`; a client whose bodies the preview cannot prove exact has the plan's
 * estimate plus the advisory's own wire bytes); while it is over its ceiling the facts
 * are composed for a smaller room — tiers and calls dropped from the end — until it
 * fits, so no tuned allowance decides whether the reply fits. A pack whose decision is
 * not the answer the map was planned for states nothing, and one that has no room for
 * even the first tier (the unserved bodies) is not shipped as the answer-first reply:
 * the caller withdraws it (`rederiveAfterPlanRestore`).
 */
export function attachAnswerFirstAdvisory(result: TaskPackResult, map: AnswerStructureMap | undefined): AnswerFirstShip | undefined {
  const plan = map?.answerFirst;
  if (plan === undefined || activePackByteCeiling() === undefined) return undefined;
  if (deriveCanonicalTaskDecision(result)?.kind !== "act-answer") return "not-answer";
  delete result.advisory;
  const clientId = protocolCallContext()?.clientId;
  const ceiling = clampToActiveCeiling(Number.MAX_SAFE_INTEGER);
  // The preview counts the finished pack as the transport ships it; a client whose bodies it cannot prove exact has the plan's estimate instead.
  const preview = taskPackSizePreview(result, clientId);
  const used = preview ?? plan.estimateBytes;
  if (plan.facts.notServed.length === 0) {
    answerFirstPacks.add(result);
    return "shipped";
  }
  let room = ceiling - used;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const text = composeAnswerFirstAdvisory(plan.facts, room);
    if (text === "") break;
    result.advisory = text;
    const total = (preview === undefined ? undefined : taskPackSizePreview(result, clientId)) ?? used + advisoryWireBytes(text);
    if (total <= ceiling) {
      answerFirstPacks.add(result);
      return "shipped";
    }
    room -= total - ceiling;
  }
  delete result.advisory;
  return "no-room";
}
