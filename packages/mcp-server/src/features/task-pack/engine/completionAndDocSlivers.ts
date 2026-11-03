// completionAndDocSlivers — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import type { DocSliverPlan } from "../docSliver.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { COMPLETE_STOP_REASON } from "./packState4.js";
import { COMPLETE_STOP_REASON_ANSWER } from "./packState4.js";
import { DOC_SLIVER_HEADINGS_CAP_BYTES } from "../docSliver.js";
import { DOC_SLIVER_ROUTE_MARKER } from "../docSliver.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_UNSERVED_CALLER_PATHS } from "./epochContract3.js";
import { applyCompleteStopRoute } from "./receiptProgress.js";
import { attachDocSliverNavigation } from "../docSliver.js";
import { attachDocSliverSurfaceHonesty } from "../docSliver.js";
import { attachDocSliverZoom } from "../docSliver.js";
import { buildDocSliverHeadingIndex } from "../docSliver.js";
import { capForResult } from "./packState.js";
import { clearDocSliverNavigation } from "../docSliver.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { docSliverFocusFromSurface } from "../docSliver.js";
import { docSliverRouteClause } from "../docSliver.js";
import { dropLowestRankedHeadingIndexEntry } from "../../../util/markdownSections.js";
import { fitsInCap } from "./packTrimming2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { isUnderAncestor } from "./seedResolution.js";
import { normalizePathEntry } from "./packBasics2.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { planDocSliver } from "../docSliver.js";
import { probeFileText } from "./readinessFalsification.js";
import { queryServedSurfaces } from "../../../util/packServeLog.js";
import { resolveQualifiedSymbolAnchors } from "./wiringEvidence3.js";
import { safeResolve } from "../../../util/safePath.js";
import { tokenizeForEpoch } from "../../../state/session.js";

/**
 * B1b (2026-08-01 retrieval-scope): a caller-named path is a REQUIREMENT, so
 * one that exists, is readable, and is in scope must either be SERVED or be
 * named as unresolved. Live forensics (run 2026-07-31-semantic-signal5-2, T09
 * rep1/rep2): a pack given 12 explicit paths — including the enum file the task
 * was about — served ONE surface and reported nothing about the other eleven,
 * so the caller could not tell "already covered" from "silently dropped" and
 * re-asked for the same files.
 *
 * Placed at the shared exit rather than in buildSeededTaskPack: every seeded
 * read does become a surface there, and the narrowing happens LATER (a
 * specialized builder that selects a subset, the artifact_build explicit-target
 * splice, a whole-surface drop under the byte cap). Normally a no-op.
 *
 * Deliberately additive only: it never changes coverage or the route (those are
 * already reconciled by this point), it only refuses to stay silent.
 */
export function reconcileCallerPathCoverage(
  result: TaskPackResult,
  args: TaskPackArgs | undefined,
  workspace: string,
): void {
  const entries = (args?.paths ?? []).map(normalizePathEntry);
  if (entries.length === 0) return;
  // Case-normalized on BOTH sides (2026-08-01): normalizedRequestPath
  // lowercases the request while served surface paths keep repo case — the
  // raw comparison marked genuinely-served camelCase files "named but
  // unserved" (observed live: leanExecutionContract.ts served 1-70 yet listed
  // missing).
  const servedPaths = new Set(result.surfaces.map((s) => normalizedRequestPath(s.path)));
  const servedEarlier = new Set((result.served_earlier ?? []).map((entry) => normalizedRequestPath(entry.path)));
  // E2 (2026-09-05, paid smoke r9 / SF13): `served_earlier` rides only the ONE
  // cumulative flip call, so a path an earlier call in this epoch served was
  // still being reported "named but unserved" on every later call — and each
  // such entry also mints a `tl_read_file {path}` affordance for bytes the caller
  // already holds. Consult the epoch ledger itself; `queryServedSurfaces`
  // revalidates by content fingerprint, so a file EDITED since it was served is
  // dropped from the ledger and stays disclosed. Skipped when this call carries
  // no query, where there is no epoch to gate on.
  const reconcileQuery = typeof args?.query === "string" ? args.query : "";
  if (reconcileQuery.length > 0) {
    for (const entry of queryServedSurfaces(workspace, workspace, {
      epochTokens: tokenizeForEpoch(reconcileQuery),
    })) {
      servedEarlier.add(normalizedRequestPath(entry.path));
    }
  }
  const unserved: string[] = [];
  for (const entry of entries) {
    const rel = normalizedRequestPath(entry.path);
    if (rel.length === 0) continue;
    if (servedPaths.has(rel) || servedEarlier.has(rel)) continue;
    // Already disclosed — as a bare path (unreadable/outside), as the
    // "<dir>/ (directory)" marker, or by this very pass on an earlier call.
    if (result.missing.some((item) => {
      const norm = item.toLowerCase();
      return norm === rel || norm.startsWith(`${rel} `) || norm.startsWith(`${rel}/`);
    })) continue;
    // A directory entry is honored by any surface UNDER it.
    if (result.surfaces.some((s) => isUnderAncestor(normalizedRequestPath(s.path), rel))) continue;
    const abs = safeResolve(rel, workspace);
    if (abs === undefined || !fs.existsSync(abs)) continue; // a nonexistent path is already reported by its own flow
    unserved.push(rel);
    if (unserved.length >= MAX_UNSERVED_CALLER_PATHS) break;
  }
  if (unserved.length === 0) return;
  for (const rel of unserved) result.missing.push(`${rel} (named but unserved)`);
}

/**
 * D5 (2026-09-02): a query that spells `Class::method` names exactly ONE
 * definition site. When the pack cannot serve it — the seed cap, a trim pass,
 * or a specialized builder that selected a different subset — SILENCE is the
 * failure mode the SF13 forensics caught: the caller was handed three sibling
 * headers that merely declare a same-named member and no hint that the
 * definition existed at all, so it left TL to grep for it.
 *
 * Disclose it in the same "named but unserved" shape
 * `reconcileCallerPathCoverage` uses for a caller-named path, so the file is
 * one directly addressable read away. Additive only: never changes coverage,
 * the route, or any served surface, and a zero-cost no-op for a query that
 * names no qualified anchor.
 */
export function discloseUnservedQualifiedAnchorDefinition(
  result: TaskPackResult,
  query: string,
  workspace: string,
): void {
  const resolution = resolveQualifiedSymbolAnchors(query, workspace);
  if (resolution.definitions.length === 0) return;
  const served = new Set(result.surfaces.map((surface) => normalizedRequestPath(surface.path)));
  for (const entry of result.served_earlier ?? []) served.add(normalizedRequestPath(entry.path));
  // E2 (2026-09-05): a file an EARLIER call in this epoch served is not
  // "unserved". `served_earlier` rides only the one cumulative flip call, so
  // consult the epoch ledger itself — live (r9/SF13 call 3) ekf.cpp was
  // disclosed as "named but unserved" two calls after its body was served.
  for (const entry of queryServedSurfaces(workspace, workspace, { epochTokens: tokenizeForEpoch(query) })) {
    served.add(normalizedRequestPath(entry.path));
  }
  for (const definitionPath of resolution.definitions) {
    const rel = normalizedRequestPath(definitionPath);
    if (rel.length === 0 || served.has(rel)) continue;
    if (result.surfaces.some((surface) => normalizedRequestPath(surface.path) === rel)) continue;
    if (result.missing.some((item) => {
      const norm = item.toLowerCase();
      return norm === rel || norm.startsWith(`${rel} `) || norm.startsWith(`${rel}/`);
    })) continue;
    result.missing.push(`${definitionPath} (named but unserved)`);
  }
}

/**
 * D1 (2026-08-07): does this pack disclose content it did NOT serve?
 *
 * `remaining_ranges` alone does not mean "unserved": a windowed surface
 * routinely discloses the rest of its FILE while a SIBLING surface on the same
 * path already carries those lines (an answer pack that serves a symbol plus
 * the whole file is the common shape). Granting a zoom budget for that is what
 * the 2026-08-01 serve-honesty split was defending against, and it was right
 * to — it just used `content_completeness==="partial"` as the proxy, which also
 * excluded the case where the remainder is genuinely absent (an anchor-focused
 * symbol served alone out of a large file).
 *
 * Decide it directly instead: subtract every served span on the same path from
 * each disclosed remainder. Anything left is content the caller cannot reach
 * without another call, which is exactly when one same-handle zoom is
 * sanctioned. A trimmed body (content_completeness "partial") always counts.
 *
 * A blank line holds nothing to serve, so it never counts as unserved content
 * (eval-0927 review, `readCodeTaskPack.spec.ts` WS3: two functions served as
 * two exact surfaces left only the blank line between them, and that line
 * alone granted a zoom call). Blank lines are read from the file when
 * `workspace` is given; without it every disclosed line counts, as before.
 */
export function packHasUnservedDisclosure(result: TaskPackResult, workspace?: string): boolean {
  const parseSpan = (text: string): [number, number] | undefined => {
    const match = /^(\d+)-(\d+)$/.exec(text);
    if (!match) return undefined;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return Number.isInteger(start) && Number.isInteger(end) && end >= start ? [start, end] : undefined;
  };
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  const servedByPath = new Map<string, Array<[number, number]>>();
  for (const surface of surfaces) {
    if (!hasServedCode(surface)) continue;
    const span = parseSpan(surface.range);
    if (!span) continue;
    const spans = servedByPath.get(surface.path) ?? [];
    spans.push(span);
    servedByPath.set(surface.path, spans);
  }
  const blankLinesByPath = new Map<string, readonly string[] | undefined>();
  const isBlankLine = (filePath: string, line: number): boolean => {
    if (workspace === undefined) return false;
    if (!blankLinesByPath.has(filePath)) {
      const text = probeFileText(workspace, filePath);
      blankLinesByPath.set(filePath, text === undefined ? undefined : text.replace(/\r\n?/g, "\n").split("\n"));
    }
    const lines = blankLinesByPath.get(filePath);
    return lines !== undefined && line >= 1 && line <= lines.length && (lines[line - 1] ?? "").trim() === "";
  };
  for (const surface of surfaces) {
    if (surface.content_completeness === "partial") return true;
    const disclosed = surface.remaining_ranges ?? [];
    if (disclosed.length === 0) continue;
    const served = [...(servedByPath.get(surface.path) ?? [])].sort((a, b) => a[0] - b[0]);
    for (const item of disclosed) {
      const span = parseSpan(item);
      if (!span) continue;
      let cursor = span[0];
      for (;;) {
        while (cursor <= span[1] && isBlankLine(surface.path, cursor)) cursor += 1;
        const covering = served.find(([from, to]) => from <= cursor && to >= cursor);
        if (covering === undefined) break;
        cursor = covering[1] + 1;
      }
      if (cursor <= span[1]) return true;
    }
  }
  return false;
}

/**
 * iter-2 W2: stamp the complete-stop signal on a freshly-built pack whose
 * coverage is complete/focused (single-call OR cumulative). GUIDANCE ONLY — see
 * applyCompleteStopRoute; never a refusal, never raises the call budget.
 */
export function applyCompleteStopRouteToResult(result: TaskPackResult, workspace?: string): void {
  if (result.coverage !== "complete" && result.coverage !== "focused") return;
  const isAnswer = result.route?.action === "answer_from_handles" || result.task_profile === "answer";
  // A5 (2026-08-01 signal5-2 T03): answer packs disclose partial primaries via
  // content_completeness/remaining_ranges (the primary is typically
  // required:false by design, so no required-filter here).
  //
  // D1 (2026-08-07): this predicate used to accept ONLY
  // content_completeness==="partial" — the "label-gated" narrowing added on
  // 2026-08-01 because "granting it a call budget re-opened every certified
  // answer pack". That re-opening was not caused by the grant: it was
  // routeCandidate (buildTaskExecutionContract) refusing `prepared` to any
  // route carrying a nonzero budget, so ANY zoom grant destroyed the
  // certificate. That collision is now fixed at its own site
  // (servedZoomAffordance), so the narrowing is no longer load-bearing — and
  // it was actively harmful: buildRoute's zoomNote counts the WIDER signal
  // (content_completeness partial OR remaining_ranges present), so an
  // anchor-focused primary — a whole symbol body served with the rest of the
  // FILE in remaining_ranges — got the zoom PROSE with a zero budget. The
  // ROUTE_REASON_ENVELOPE_CAP trim then cut the trailing "working set
  // complete — stop discovery" clause that justified the 0, leaving a route
  // that says "re-slice to zoom" and grants no call. Observed live
  // 2026-08-07: an operator-usage query anchor-focused on a matched symbol,
  // the answer sat in the file's leading doc block inside remaining_ranges,
  // and the caller had to spend an unsanctioned call to reach it.
  //
  // Decide on UNSERVED content instead of on the label — see
  // packHasUnservedDisclosure. That keeps the 2026-08-01 defence intact (a
  // file-complement disclosure whose lines a sibling surface already carries
  // still gets budget 0) while granting the AGENTS.md zoom ("prepared+partial
  // primary grants route.max_additional_tl_calls=1 — spend it on the served
  // zoom") when the remainder genuinely is not in the caller's hands.
  const partialPrimary = isAnswer && packHasUnservedDisclosure(result, workspace);
  const route = applyCompleteStopRoute(result.route, result.coverage, isAnswer, partialPrimary);
  if (route !== undefined) result.route = route;
}

/**
 * L1 (2026-08-08 doc-authority serve honesty) — full defect writeup in
 * features/task-pack/docSliver.ts.
 *
 * A pack may legitimately have a COMPLETE code working set while one of its
 * surfaces is a named authority document served at 0.066% of its own length
 * (anchor-focus matching a literal query token at its LAST occurrence). The
 * pack then asserted `coverage:"complete"` + `prepared` + budget 0 + "working
 * set complete — stop discovery" over that document, and every observed solver
 * disbelieved it and went hunting (10-20 discovery calls).
 *
 * This pass changes three specific signals and nothing else:
 *   (a) the sliver surface gains the heading index `mode=slice` ALREADY emits
 *       for the same handle (same field names) plus one executable
 *       section-scoped `next_call`;
 *   (b) `content_completeness:"partial"` — the existing per-surface vocabulary
 *       — marks the surface itself, while pack-level `coverage` keeps whatever
 *       the code working set earned;
 *   (c) the route's stop clause is replaced by an honest one and the budget is
 *       raised to >=1 so the zoom is sanctioned rather than stolen.
 *
 * `prepared` and the certificate are deliberately untouched: first_pack_ready
 * is a proven win, and wholesale demotion would re-open the discovery-loop
 * class. Runs AFTER applyEnvelopeWeightTrim so the reason cap cannot shear the
 * honesty clause off (the same ordering annotateEditZoomAffordance relies on).
 */
export function applyDocSliverHonesty(
  workspace: string,
  result: TaskPackResult,
  query: string,
): DocSliverFloorRestore[] {
  if (result.coverage !== "complete" && result.coverage !== "focused") return [];
  const route = result.route;
  // 2026-09-05, RECORDED SO THE NEXT READER DOES NOT RE-DIAGNOSE THIS.
  //
  // `route` is NOT a pre-v1 leftover and this guard is not why the pass looked
  // dead on a decision-wire pack. `route` is still computed on every pack and
  // still feeds `canonicalDecision.ts`'s oracle in-process; `protocol/
  // envelope.ts`'s `projectSuccessBody` deletes it only at the WIRE (§3.4 E4
  // row 1), which is why a served pack reads `route: null` while this function
  // sees a populated one. The only way it is undefined HERE is `trimToCap`
  // Phase 0 having shed it — a pack that has already proved it cannot transport
  // its own route — and attaching a heading index to that pack would be exactly
  // backwards, so the early return stays.
  //
  // What IS true of the decision wire, and is a protocol fact rather than a bug
  // to fix here: `decisionWire.ts`'s `projectEvidence` allow-list is CLOSED at
  // handle/path/range/body/prior/remaining/role plus sha/symbol/why/likely_edits,
  // so `content_completeness`, `total_lines`, `headings`, `sections_hint` and
  // the per-surface `next_call` this pass attaches never reach a caller. What
  // survives to the wire is the surface's `remaining` (the partiality claim) and
  // the effect this pass has on the CERTIFICATE via `servedDocSliverAffordance`.
  if (route === undefined) return [];
  if (route.action !== "edit_from_handles" && route.action !== "answer_from_handles") return [];
  // Idempotent: this pass can run twice over the same result (a cached re-serve
  // replays the stored route). Without this guard the honesty clause is
  // appended a second time, doubling the reason and burning envelope on a
  // duplicate sentence.
  const routeReason = route.reason ?? "";
  if (routeReason.includes(DOC_SLIVER_ROUTE_MARKER)) return [];
  // A compact `pack_unchanged` re-serve is a sub-1KB acknowledgement by
  // design; hanging an index off it would defeat the whole receipt.
  if (result.pack_unchanged === true) return [];
  const cache = new FileReadCache();
  const planned: Array<{ surface: TaskPackSurface; plan: DocSliverPlan }> = [];
  for (const surface of codeTaskPackSurfaces(result.surfaces)) {
    if (surface.role !== "doc") continue;
    // C2 (2026-08-09): a `code_unchanged` surface is NOT a compact receipt —
    // it is a full pack whose body was deduped because the caller already holds
    // those bytes. Measured on the qref recovery: skipping it let "working set
    // complete — stop discovery" ride a pack whose authority doc was still
    // 1/1514 lines served, resurrecting on the replay exactly the false closure
    // L1 exists to retire. What the correction describes is the FILE, not
    // whether these particular bytes were re-sent.
    if (surface.code === undefined && surface.code_unchanged === undefined) continue;
    const content = cache.read(workspace, surface.path);
    if (content === undefined) continue;
    const plan = planDocSliver(surface, content, query);
    if (plan === undefined) continue;
    planned.push({ surface, plan });
  }
  const first = planned[0];
  if (first === undefined) return [];

  // ---- C1 (2026-08-09): size the affordance to the budget, don't shear it ----
  //
  // L1 attached the whole affordance unconditionally and its follow-up shrank
  // whatever did not fit. Measured on the real T05c pack: a 1,465B overage sent
  // the ladder through every rung, removing 3,158B — the CONTRACT.md surface
  // itself included — and landed 1,693B UNDER the ceiling with the false "stop
  // discovery" restored. Strictly worse than pre-L1, which at least served the
  // 83B sliver and its handle.
  //
  // Build UP from the floor instead. Each level is attached only once the pack
  // has been measured with the level below it in place, so the affordance is
  // sized to the headroom that actually exists rather than trimmed after the
  // fact by a rank-blind pop:
  //
  //   floor       the sliver body + handle + remaining_ranges (untouched here)
  //               + the three cheap corrections below — never given up
  //   + clause    the route honesty that retires "working set complete"
  //   + zoom      the one sanctioned, section-scoped, executable next_call
  //   + index     as many heading entries as fit, in planDocSliver's RANK order
  //
  // The floor lands first: `partial`, `required:false` and `total_lines` are
  // true at any budget and cost a few dozen bytes. They are still BYTES, so the
  // pre-flag values are captured and handed to the backstop — a pack that was
  // already over the ceiling before this pass ran must be able to give them
  // back rather than pay for them with the doc surface itself.
  const floorRestore: DocSliverFloorRestore[] = planned.map(({ surface }) => ({
    surface,
    content_completeness: surface.content_completeness,
    required: surface.required,
    total_lines: surface.total_lines,
  }));
  for (const { surface, plan } of planned) attachDocSliverSurfaceHonesty(surface, plan);

  // Read the cap only now — `required:false` moves a doc surface out of
  // capForResult's required-code tier test, so the floor can change the cap.
  const cap = capForResult(result);
  const size = (): number => Buffer.byteLength(JSON.stringify(result), "utf8");

  const clause = docSliverRouteClause(first.surface, first.plan);
  const reason = routeReason.includes(COMPLETE_STOP_REASON)
    ? routeReason.replace(COMPLETE_STOP_REASON, clause)
    : routeReason.includes(COMPLETE_STOP_REASON_ANSWER)
      ? routeReason.replace(COMPLETE_STOP_REASON_ANSWER, clause)
      : routeReason.length > 0 ? `${routeReason}; ${clause}` : clause;
  result.route = {
    ...route,
    reason,
    max_additional_tl_calls: Math.max(route.max_additional_tl_calls ?? 0, 1),
  };
  if (size() > cap) reclaimForDocSliver(result, cap, 0);
  if (size() > cap) {
    // Not even the honesty clause fits. Revert to the untouched route: the
    // stop text may only come back when NO affordance level is present, which
    // is exactly this state (floor only).
    result.route = route;
    return floorRestore;
  }

  for (const { surface, plan } of planned) {
    attachDocSliverZoom(surface, plan);
    if (size() > cap) reclaimForDocSliver(result, cap, 0);
    if (size() > cap) {
      surface.next_call = undefined;
      return floorRestore;
    }
  }

  for (const { surface, plan } of planned) {
    reclaimForDocSliver(result, cap, DOC_SLIVER_NAV_OVERHEAD_BYTES + DOC_SLIVER_INDEX_TARGET_BYTES);
    const headroom = cap - size() - DOC_SLIVER_NAV_OVERHEAD_BYTES;
    if (headroom < DOC_SLIVER_MIN_INDEX_BYTES) return floorRestore;
    const index = buildDocSliverHeadingIndex(plan, Math.min(DOC_SLIVER_HEADINGS_CAP_BYTES, headroom));
    if (index.headings.length === 0) return floorRestore;
    attachDocSliverNavigation(surface, index);
    // DOC_SLIVER_NAV_OVERHEAD_BYTES is an estimate of the field names and the
    // truncation note; this makes the result exact, popping by rank (lowest
    // first) so the focus entry is the last one standing.
    while (size() > cap && (surface.headings?.length ?? 0) > 0) {
      dropLowestRankedHeadingIndexEntry(surface.headings!, plan.focus);
      if (surface.headings!.length === 0) clearDocSliverNavigation(surface);
    }
    if (surface.headings === undefined) return floorRestore;
  }
  return floorRestore;
}

/**
 * C1: what a doc-sliver surface looked like BEFORE this pass stamped its floor
 * honesty on it. Handed to the backstop so an overage the affordance did not
 * cause is paid for by giving the flags back, not by deleting the surface.
 */
export interface DocSliverFloorRestore {
  surface: TaskPackSurface;
  content_completeness: TaskPackSurface["content_completeness"];
  required: TaskPackSurface["required"];
  total_lines: TaskPackSurface["total_lines"];
}

/**
 * C1: bytes the navigation level costs BESIDE its entries — the `headings` /
 * `sections_hint` / `headings_truncated` / `headings_total` / `headings_note`
 * field names, the sections_hint text itself (~120B) and the truncation note
 * (~110B). Deliberately generous: an over-estimate only costs a heading entry
 * or two, while an under-estimate would push the pack over the ceiling (the
 * exact pop loop above corrects either way).
 */
export const DOC_SLIVER_NAV_OVERHEAD_BYTES = 420;

/** C1: below this, an index cannot hold even one entry worth naming. */
export const DOC_SLIVER_MIN_INDEX_BYTES = 48;

/**
 * C1: index bytes worth reclaiming advisory metadata for. ~8 entries — the
 * focus section plus its siblings, which is what makes the doc navigable. Not a
 * cap (a pack with free headroom still gets up to DOC_SLIVER_HEADINGS_CAP_BYTES);
 * only the point past which the affordance stops outbidding the pack's own
 * advisory prose.
 */
export const DOC_SLIVER_INDEX_TARGET_BYTES = 512;

/**
 * C1: fund the affordance from the pack's own ADVISORY metadata, in the exact
 * order trimToCap already sheds it — never from a code body, a handle, the
 * certificate, or any coverage claim.
 *
 * Why any reclaim at all: measured on the real T05c cell, the pack arrives here
 * 36B OVER its 32768 ceiling before the affordance is even considered (the
 * uncapped route/zoom/runtime prose added after the last fitsInCap gate), so
 * "size the affordance to the remaining headroom" would honestly resolve to
 * "there is none" and the 1,514-line authority doc would go on being dropped
 * outright. The pack's composition says where the bytes are: 26.6KB of code
 * bodies and 1.8KB of certificate — both untouchable — beside 1,942B of
 * per-surface `likely_edits` / `edit_intent` / `done_check`, advisory
 * speculation that trimToCap Phases C and D already shed BEFORE any code body.
 * Trading a restatement of the edit vocabulary for the one call that reaches
 * the authority the task cites is the same trade trimToCap makes, made earlier
 * and only when a doc-sliver affordance is actually being attached.
 *
 * Sheds the minimum: stops the moment `want` bytes of headroom exist.
 */
export function reclaimForDocSliver(result: TaskPackResult, cap: number, want: number): void {
  const headroom = (): number => cap - Buffer.byteLength(JSON.stringify(result), "utf8");
  if (headroom() >= want) return;
  const surfaces = codeTaskPackSurfaces(result.surfaces);
  for (const surface of surfaces) {
    if (surface.likely_edits === undefined) continue;
    surface.likely_edits = undefined;
    if (headroom() >= want) return;
  }
  for (const surface of surfaces) {
    if (surface.edit_intent !== undefined) {
      surface.edit_intent = undefined;
      if (headroom() >= want) return;
    }
    if (surface.done_check !== undefined) {
      surface.done_check = undefined;
      if (headroom() >= want) return;
    }
  }
}

/**
 * L1 follow-up (2026-08-08, T05c smoke-gate escape) — degrade the heading-index
 * affordance applyDocSliverHonesty just attached when it pushed an
 * already-near-ceiling pack over its transport cap. Runs only when the pack is
 * over cap; a comfortably-under-budget pack keeps the full index untouched.
 *
 * C1 (2026-08-09) rewrote it as a BACKSTOP. applyDocSliverHonesty now sizes the
 * affordance to the pack's real headroom at construction, so this only ever
 * absorbs estimation drift from the passes that run after it. It unwinds the
 * exact levels that pass built up, in reverse, and stops at the FIRST size that
 * fits (the old ladder measured once per rung and ran on past a fitting state):
 *
 *   1  heading entries, popped LOWEST-RANK-FIRST (the focus section is last out)
 *   2  the navigation level entirely (index + sections_hint)
 *   3  the sanctioned zoom (next_call)
 *   4  the route honesty clause — only once no affordance level remains, since
 *      restoring it resurrects "working set complete — stop discovery"
 *   5  advisory pack prose (the verification verdict's fixed no-install
 *      `suggestion`, then create_note / verify / checks, then the verdict
 *      itself), because past rung 4 the overage is demonstrably not this
 *      pass's doing
 *   6  the doc surface itself — forbidden while the floor fits, reachable only
 *      when the pack cannot transport even the pre-L1 sliver + handle
 */
export function shrinkDocSliverAffordanceToFit(
  result: TaskPackResult,
  routeBeforeDocSliverHonesty: TaskPackResult["route"],
  floorRestore: readonly DocSliverFloorRestore[],
): void {
  const sliverSurfaces = codeTaskPackSurfaces(result.surfaces).filter(
    (surface) =>
      surface.headings !== undefined
      || surface.next_call !== undefined
      || surface.sections_hint !== undefined,
  );

  // Rung 1 — heading entries, popped by RANK and re-measured after EVERY pop.
  // The old ladder measured once per rung and used headings.pop(), which drops
  // the LAST-IN-DOCUMENT entry: on CONTRACT.md that killed "7.6
  // `<control/mixer.hpp>`" (line 1018 of 1514) before the §1-§3 layout entries
  // nobody asked for, and it kept popping past the first size that fit.
  for (const surface of sliverSurfaces) {
    const focus = docSliverFocusFromSurface(surface);
    while (!fitsInCap(result) && (surface.headings?.length ?? 0) > 0) {
      dropLowestRankedHeadingIndexEntry(surface.headings!, focus);
      // An index of zero entries plus an instruction for slicing by heading
      // name is half an affordance — the two ride together.
      if (surface.headings!.length === 0) clearDocSliverNavigation(surface);
    }
    if (fitsInCap(result)) return;
  }

  // Rung 2 — the navigation level entirely (index + sections_hint).
  for (const surface of sliverSurfaces) {
    clearDocSliverNavigation(surface);
    if (fitsInCap(result)) return;
  }

  // Rung 3 — the sanctioned zoom. The surface's own honesty corrections
  // (content_completeness:"partial", required:false, total_lines) are cheap and
  // stay; they are true regardless of budget.
  for (const surface of sliverSurfaces) {
    surface.next_call = undefined;
    if (fitsInCap(result)) return;
  }

  // Rung 4 — the route's own doc-sliver clause, and ONLY now that every other
  // affordance level is gone: restoring it brings back "working set complete —
  // stop discovery", which may never ship beside a live affordance. Restores
  // the route exactly as it stood right before applyDocSliverHonesty touched
  // it — undoing this pass's contribution, not route text assembled earlier.
  if (routeBeforeDocSliverHonesty !== undefined) {
    result.route = routeBeforeDocSliverHonesty;
  }
  if (fitsInCap(result)) return;

  // Rung 5 — the pack is over the ceiling with NO affordance attached at all,
  // so the overage was never this pass's to cause: it is the pre-existing drift
  // from the uncapped route/verify/runtime prose added after the last
  // fitsInCap gate. Shed that prose in trimToCap's own priority order (advisory
  // speculation first) rather than charging it to the doc surface.
  //
  // 2026-09-15 (Windows wave, T05c multi_concern): measured, this ladder had
  // NOTHING to give on the exact pack it exists for. With no doc-sliver
  // affordance attached (the 2026-09-05 markdown anchor-focus re-pin) rungs
  // 1-4 are no-ops, `create_note`/`verify`/`checks` were all absent, the floor
  // restore was empty and rung 6's handle set was empty — so a 38B overage
  // shipped at 32806B, past the 32768B transport ceiling the bench smoke gate
  // refuses on. The bytes that made the difference were `verification`:
  // `attachVerificationVerdict` lands BEFORE trimToCap, but ~1.8KB of
  // un-size-checked prose lands AFTER it, so the verdict's SIZE is what
  // decides the final fit. On a host WITH the probed toolchain the verdict is
  // 93B (`available:true` + `command`); on a host WITHOUT one it is 202B —
  // `available:false` + `reason` + a 127B FIXED `suggestion` string. Every
  // Windows box in this wave, and any CI image without a C/C++ toolchain,
  // therefore breached the ceiling on a pack that fits everywhere a compiler
  // happens to be installed. This is not a Windows bug: it reproduces exactly
  // on macOS through `setToolchainPathLookupForTest`.
  //
  // The `suggestion` is a CONSTANT (VERIFY_NO_INSTALL_SUGGESTION) carrying no
  // pack-specific information, so it goes first — ahead even of the computed
  // prose below. `available`/`reason` are pack-specific honesty and are only
  // given up once every other advisory string is gone, and still ahead of
  // rung 6's floor flags and rung 7's authority-document drop.
  if (result.verification !== undefined && "suggestion" in result.verification) {
    delete (result.verification as { suggestion?: string }).suggestion;
    if (fitsInCap(result)) return;
  }
  if (result.create_note !== undefined) {
    result.create_note = undefined;
    if (fitsInCap(result)) return;
  }
  if (result.verify !== undefined) {
    result.verify = undefined;
    if (fitsInCap(result)) return;
  }
  if (result.checks !== undefined) {
    result.checks = undefined;
    if (fitsInCap(result)) return;
  }
  // The verdict itself is advisory runnability metadata, not evidence: no
  // handle, no coverage claim and no `missing` row depends on it, and an agent
  // that needs it can probe its own host. Given up before the floor flags
  // below, which are honesty ABOUT served evidence.
  if (result.verification !== undefined) {
    result.verification = undefined;
    if (fitsInCap(result)) return;
  }

  // Rung 6 — the floor honesty flags themselves. They are TRUE, and they are
  // still ~70B: a pack that entered this pass already over the ceiling must be
  // able to give them back, because the alternative below deletes a 1,514-line
  // authority doc's only mention in the pack. Restores the exact pre-pass
  // values rather than blanking the fields, so a surface that already carried
  // content_completeness keeps it.
  for (const entry of floorRestore) {
    entry.surface.content_completeness = entry.content_completeness;
    entry.surface.required = entry.required;
    entry.surface.total_lines = entry.total_lines;
    if (fitsInCap(result)) return;
  }

  // Rung 7 — absolute last resort, reached only when the FLOOR itself does not
  // fit. Dropping the doc surface is forbidden while the floor fits (that is
  // the whole C1 defect: a 1,465B overage cost a 1,514-line authority doc its
  // only mention in the pack, and every rep paid a re-pack to get it back), but
  // a pack that cannot transport its floor has nothing left to give: every
  // doc-sliver surface is required:false by construction, so this costs no edit
  // evidence and does not touch missing/coverage.
  const handles = new Set([
    ...sliverSurfaces.map((surface) => surface.handle),
    ...floorRestore.map((entry) => entry.surface.handle),
  ]);
  if (handles.size > 0) {
    result.surfaces = result.surfaces.filter((surface) => !handles.has(surface.handle));
  }
}

/** iter-2 W5: extensions whose file is a runnable module (a functional check can execute it). */
export const RUNNABLE_TARGET_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".kt", ".swift",
  ".c", ".cc", ".cpp", ".cxx", ".scala", ".ex", ".exs",
]);
