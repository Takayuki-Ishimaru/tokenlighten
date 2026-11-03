// readinessFalsification — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import { FALSIFICATION_SCOPE_SUPPORT_ROLES } from "./changeAndReadinessEvidence2.js";
import { FileReadCache } from "./packBasics2.js";
import { READINESS_PROBE_COUNTEREXAMPLE_MAX_BYTES } from "./changeAndReadinessEvidence2.js";
import { READINESS_PROBE_GENERIC_TOKENS } from "./changeAndReadinessEvidence2.js";
import { READINESS_PROBE_MAX_FILES } from "./changeAndReadinessEvidence2.js";
import { READINESS_PROBE_MAX_SURFACES } from "./changeAndReadinessEvidence2.js";
import { buildReadinessObligations } from "./readinessObligations.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { classifySurface } from "../../../util/impact.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { containsWholeIdentifier } from "../wholeIdentifier.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { handleTable } from "../../../util/handles.js";
import { identifierHitMeansRequestedMember } from "./roleAndConcernScope3.js";
import { inferCallableSymbol } from "./readinessFalsification.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isWithinRoleSearchScope } from "../../locator/locateTaskContext.js";
import { looksLikeMarkupOrCssWindow } from "./readinessFalsification.js";
import { maskServedRanges } from "./readinessFalsification.js";
import { nearestNonBlankSubSpanIndex } from "./readinessFalsification.js";
import { packageQualifiedOnlyMembers } from "./roleAndConcernScope3.js";
import { parseSurfaceSpan } from "./packState2.js";
import { probeFileText } from "./readinessFalsification.js";
import { queryNamedWorkspaceFiles } from "./queryIntent3.js";
import { roleSearchScopePrefixes } from "../../locator/locateTaskContext.js";
import { selectQueryEvidence } from "../../../tools/queryEvidence.js";
import { shaOfText } from "../../../util/handles.js";
import { statedRelationToNamedPath } from "./readinessFalsification.js";
import { stripCommentOnlyLines } from "./readinessFalsification.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { trimBlankEdgeLines } from "./readinessFalsification.js";
import { trustworthySurfaceAnchorPaths } from "./queryIntent.js";
import { unservedSubSpans } from "./readinessFalsification.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/**
 * Negative retrieval pass. It searches outside the already-served ranges for
 * evidence that would falsify a provisional ready decision and inlines at
 * most two counterexamples into the SAME task_pack response.
 */
export function runInternalReadinessFalsification(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  workspace: string,
  scopePaths?: readonly string[],
): number {
  const provisionalReady = result.route?.action === "answer_from_handles"
    || (result.route?.action === "edit_from_handles" && (result.route.max_additional_tl_calls ?? 0) === 0);
  if (!provisionalReady || query.trim().length === 0) return 0;

  const initialObligations = buildReadinessObligations(result, profile, query);
  const unresolved = initialObligations.filter((obligation) =>
    obligation.status === "uncovered"
    && ["surface-content", "behavior-body", "artifact-source", "wiring-source", "wiring-consumer", "wiring-insertion"].includes(obligation.kind)
  );
  // Even when the provisional pack appears fully proved, spend one bounded
  // server-side probe looking for competing implementation evidence. This is
  // the rejection test that makes ready a falsifiable prediction rather than
  // a restatement of the route heuristic. Uncovered obligations may justify a
  // second probe, but never an agent round-trip.
  const probeLimit = unresolved.length > 0
    ? Math.min(READINESS_PROBE_MAX_SURFACES, unresolved.length)
    : 1;

  const existing = codeTaskPackSurfaces(result.surfaces);
  const existingKeys = new Set(existing.map((surface) => `${surface.path}:${surface.range}`));
  const queryTokens = tokenizeForEpoch(query)
    .filter((token) => token.length >= 4 && !READINESS_PROBE_GENERIC_TOKENS.has(token))
    .slice(0, 10);
  const explicitIdentifiers = explicitCodeIdentifiers(query).map((identifier) => identifier.toLowerCase());
  const qualifiedOnlyMembers = packageQualifiedOnlyMembers(query);
  const connection = result.wiring?.connections[0];
  const endpointTokens = [connection?.source?.token, connection?.destination?.token]
    .filter((token): token is string => typeof token === "string" && token.length > 0);
  const preferredPaths = existing.map((surface) => surface.path);
  // TL142-05 (2026-09-13): the request's own explicitly-named path(s), if
  // any — computed once, reused by the relation gate at admission time
  // below. Query-text detection only (queryNamedWorkspaceFiles), matching
  // decision #1's own "explicit query-text path mentions" framing; empty for
  // a pathless query, which routes admission through the (unchanged) weaker
  // relevance condition instead — see the push loop below.
  const namedPaths = queryNamedWorkspaceFiles(query, workspace, trustworthySurfaceAnchorPaths(existing));
  const walked = walkCodeFiles(workspace, {}).map((file) => file.relPath);
  const normalizedScopes = (scopePaths ?? [])
    .map((scope) => path.posix.normalize(scope.replace(/\\/g, "/")).replace(/^\.\//, ""))
    .filter((scope) => scope.length > 0 && scope !== ".");
  // R0 (2026-08-21, W4-A pack-augmentation-pollution forensics): a PATHLESS
  // query supplies no explicit `scopePaths` at all, which left this
  // negative-retrieval pass scanning the WHOLE workspace for a
  // "counterexample" — including an unrelated project's own tree, admitted
  // as a REQUIRED surface on nothing stronger than incidental lexical
  // overlap with the query's own prose (live case: the query's own quoted
  // phrase, planted verbatim in an unrelated fixture file's comment, was
  // "found" as a competing implementation and force-added). Fall back to
  // this task's own TRUSTWORTHY surfaces' project root(s) — the same
  // discipline selectClosureCandidates/augmentNativeSurfaceClosure now
  // apply — when the caller supplied no explicit scope; an explicit
  // scopePaths stays authoritative exactly as before (never narrowed).
  // W5-B: prefer the DOMINANT (code-bearing) trustworthy anchors when
  // computing the fallback scope — see FALSIFICATION_SCOPE_SUPPORT_ROLES.
  // Falls back to the full trustworthy set only when nothing code-bearing
  // survives (a genuinely doc-only pack keeps the prior, unnarrowed scope
  // unchanged — no regression for that case).
  const dominantRoleExisting = existing.filter((s) => !FALSIFICATION_SCOPE_SUPPORT_ROLES.has(s.role));
  const dominantAnchorPaths = trustworthySurfaceAnchorPaths(
    dominantRoleExisting.length > 0 ? dominantRoleExisting : existing,
  );
  const fallbackScopePrefixes = normalizedScopes.length === 0
    ? roleSearchScopePrefixes(dominantAnchorPaths)
    : null;
  const candidatePaths = [...new Set([...preferredPaths, ...walked])]
    .filter(isImplementationPath)
    .filter((candidate) => normalizedScopes.length === 0
      ? isWithinRoleSearchScope(candidate, fallbackScopePrefixes)
      : normalizedScopes.some((scope) =>
          candidate === scope || candidate.startsWith(`${scope.replace(/\/$/, "")}/`)
        ))
    .sort((a, b) => {
      const aPreferred = preferredPaths.includes(a) ? 1 : 0;
      const bPreferred = preferredPaths.includes(b) ? 1 : 0;
      const aPathHits = queryTokens.filter((token) => a.toLowerCase().includes(token)).length;
      const bPathHits = queryTokens.filter((token) => b.toLowerCase().includes(token)).length;
      return bPreferred - aPreferred || bPathHits - aPathHits || a.localeCompare(b);
    })
    .slice(0, READINESS_PROBE_MAX_FILES);

  const ranked: Array<{
    path: string;
    range: string;
    line: number;
    content: string;
    servedSpans: Array<{ start: number; end: number }>;
    symbol?: string;
    score: number;
    role: string;
    strong: boolean;
  }> = [];
  for (const filePath of candidatePaths) {
    const content = probeFileText(workspace, filePath);
    if (content === undefined) continue;
    const masked = maskServedRanges(content, filePath, existing);
    // Admission is decided on CODE only (see stripCommentOnlyLines) — a
    // comment mentioning the query's identifier is not a competing
    // implementation. `masked.text` (comment-inclusive) is still what
    // selectQueryEvidence windows below, so a file that DOES admit still
    // gets its normal surrounding-context window. FIX-ORIG (orchestrator
    // ruling): masking still legitimately biases WINDOW SELECTION away from
    // already-known content (the reviewed 2026-08-21 byte-saving intent);
    // it must never again reach the EMITTED body, which is narrowed to the
    // unserved remainder below instead (`servedSpans`).
    const lower = stripCommentOnlyLines(masked.text).toLowerCase();
    const queryTokenHits = queryTokens.filter((token) => lower.includes(token)).length;
    // A named identifier hits only as a WHOLE identifier (WP-N's rule), for
    // all three of its uses below: the gate on an already-served file, the
    // probe query that picks its window, and `strong`. A substring hit
    // admitted the semantic-frontier bench's decoy note (`invoiceVersionNote`,
    // `INVOICE_V2_FLAG_NOTE` merely contain the query's `invoiceVersion` /
    // `INVOICE_V2_FLAG`) as a required counterexample, and steered the window
    // of a served file to a near-miss: "Explain parseConfigHeader and
    // finalizeShutdownSequence in pipelineConfig.ts." inlined the
    // `PipelineConfigHeader` interface ("pipelineconfig" from the file name)
    // instead of the named `finalizeShutdownSequence`, and so needed two more
    // calls to answer.
    // A `meter.Sum` request is not contradicted by `stats.Sum`
    // (`identifierHitMeansRequestedMember`).
    const matchedIdentifiers = explicitIdentifiers.filter((identifier) =>
      containsWholeIdentifier(lower, identifier)
      && identifierHitMeansRequestedMember(identifier, filePath, lower, qualifiedOnlyMembers)
    );
    const identifierHit = matchedIdentifiers.length > 0;
    const endpointHit = endpointTokens.some((token) => lower.includes(token.toLowerCase()));
    // Once a file already contributes an action surface, generic lexical
    // co-occurrence in another range of that same file is not a competing
    // implementation. Require an exact named identifier or wiring endpoint
    // before paying to inline a second slice from it.
    if (preferredPaths.includes(filePath) && !identifierHit && !endpointHit) continue;
    // A single generic word is not a counterexample. Require an exact named
    // identifier, a wiring endpoint, or two independent query facets.
    //
    // For an already-covered multi-concern pack, broad lexical overlap in an
    // orchestrator/bootstrap file is not evidence of a new edit obligation:
    // words from several independent concerns naturally co-occur there. The
    // per-concern locator has already done the bounded implementation search,
    // so a negative probe must carry an exact identifier or graph endpoint.
    const allMultiConcernsCovered = profile === "multi_concern"
      && result.concerns?.length
      && result.concerns.every((concern) => concern.status === "covered");
    if (
      (allMultiConcernsCovered && !endpointHit)
      || (!identifierHit && !endpointHit && queryTokenHits < 2)
    ) {
      continue;
    }
    const probeQuery = preferredPaths.includes(filePath) && matchedIdentifiers.length > 0
      ? matchedIdentifiers.join(" ")
      : query;
    const evidence = selectQueryEvidence(masked.text, probeQuery, { path: filePath, windowLines: 18 });
    if (evidence === undefined) continue;
    const key = `${filePath}:${evidence.range}`;
    if (existingKeys.has(key)) continue;
    const endpointScore = endpointTokens.reduce((score, token) =>
      score + (lower.includes(token.toLowerCase()) ? 8 : 0), 0);
    const sameFileScore = preferredPaths.includes(filePath) ? 12 : 0;
    const role = classifySurface(filePath);
    // W5-B (item 1b): a same-root test/spec surface is a more CREDIBLE
    // falsification counterexample than an arbitrary same-root file with
    // matching lexical score — prefer it.
    const roleScore = role === "test" ? 40 : 0;
    ranked.push({
      path: filePath,
      range: evidence.range,
      line: evidence.line,
      content: evidence.content,
      servedSpans: masked.servedSpans,
      symbol: inferCallableSymbol(content, evidence.line),
      score: evidence.score + endpointScore + sameFileScore + roleScore,
      role,
      // Issue #4 (2026-08-21): identifierHit/endpointHit name an EXACT code
      // identifier or wiring endpoint — real evidence a competing
      // implementation exists. The queryTokenHits-only fallback (2+ ordinary
      // words appearing ANYWHERE in the file, admitted so a borderline case
      // with no strong identifier is not silently dropped) is corpus-wide
      // noise on any large, richly-commented/self-documenting file: this
      // repo's own generic-noun/stop-word arrays (e.g. locateTaskContext.ts
      // literally containing the string literals "server" and "issue" as
      // DATA in a stop-word Set) satisfy it for nearly any two-word query
      // without the file having anything to do with the request. A match
      // that strong evidence didn't corroborate must not be able to force a
      // REQUIRED obligation — see the `required: candidate.strong` write
      // below; it still surfaces as review-only supporting context.
      strong: identifierHit || endpointHit,
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  // W5-B (item 1d): once a same-root test/spec candidate exists at all, a
  // role-unknown candidate (generic lexical overlap, no recognized part to
  // play) never gets to stand in as the falsification counterexample.
  const sameRootTestExists = ranked.some((candidate) => candidate.role === "test");
  let added = 0;
  const usedPaths = new Set<string>();
  const admitted = new Map<string, { bytes: number; disposition: "required" | "supporting" }>();
  // FIX-ORIG (2026-09-27, orchestrator ruling — supersedes the 2026-08-21 W7
  // "seed with masked text" fix, which stopped the duplicate-served-content
  // waste by BLANKING already-served lines inside the emitted body: that
  // traded byte waste for a body that was no longer verbatim source of its
  // own `range` (eval-0927 P1's finding, confirmed live). The reviewed
  // 2026-08-21 intent — never repeat lines already served in the same
  // response — is kept the HONEST way instead: narrow `range`/`code` to the
  // UNSERVED remainder of the selected window (never blank a served line),
  // and disclose any OTHER unserved remainder via `remaining_ranges`. No new
  // marker vocabulary. `counterexampleCache` is now seeded with the REAL
  // (unmasked) file per candidate, exactly like every other oversize-surface
  // cap in this file.
  const counterexampleCache = new FileReadCache();
  for (const candidate of ranked) {
    if (added >= probeLimit) break;
    if (usedPaths.has(candidate.path) && profile !== "answer") continue;
    if (candidate.role === "unknown" && sameRootTestExists) continue;
    const span = parseSurfaceSpan(candidate.range);
    if (span === undefined) continue;
    const fullContent = probeFileText(workspace, candidate.path);
    if (fullContent === undefined) continue;
    const fullLines = fullContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const unserved = unservedSubSpans(span.start, span.end, candidate.servedSpans);
    const chosenIndex = nearestNonBlankSubSpanIndex(unserved, fullLines, candidate.line);
    // Every unserved sub-span of the selected window is either fully covered
    // by an earlier served surface or is itself blank — there is nothing left
    // in this window this item could honestly show as counterexample
    // evidence. Per the ruling: drop the candidate outright rather than admit
    // a body with nothing to prove (re-testing the admission logic against
    // just the unserved remainder would need re-deriving identifierHit/
    // endpointHit from a sub-window `stripCommentOnlyLines` scan this pass
    // does not otherwise need — left as a documented simplification; the
    // fallback the ruling itself sanctions).
    if (chosenIndex < 0) continue;
    const chosen = trimBlankEdgeLines(fullLines, unserved[chosenIndex]!);
    // W5-B (item 1c): a counterexample is supporting negative evidence, not
    // primary content — cap it far under MAX_SURFACE_CODE_BYTES using the
    // same centered/graceful-truncation mechanism every other oversize
    // surface already uses, instead of the raw (byte-uncapped) probe window
    // (root cause of the pre-fix 9.4KB body: selectQueryEvidence's +-18
    // LINE window has no BYTE ceiling, and this file's matched lines were
    // very long).
    counterexampleCache.seed(candidate.path, fullContent);
    const centerLine = Math.min(Math.max(candidate.line, chosen.start), chosen.end);
    const capped = centeredSliceForCap(
      workspace,
      candidate.path,
      `${chosen.start}-${chosen.end}`,
      counterexampleCache,
      centerLine,
      READINESS_PROBE_COUNTEREXAMPLE_MAX_BYTES,
    );
    if (capped === undefined) continue;
    // Recover the served bounds from centeredSliceForCap's own
    // remaining_ranges by POSITION relative to centerLine (same technique
    // singleSiteShortCircuitSeed uses): a "before" entry narrows the start, an
    // "after" entry narrows the end, so `range` always names exactly the
    // lines `capped.code` verbatim contains — never the wider pre-cap window.
    let servedStart = chosen.start;
    let servedEnd = chosen.end;
    for (const remainingWindow of capped.remaining_ranges) {
      const bounds = /^(\d+)-(\d+)$/.exec(remainingWindow);
      if (bounds === null) continue;
      const [, remStart, remEnd] = bounds.map(Number) as [number, number, number];
      if (remEnd < centerLine) servedStart = remEnd + 1;
      else if (remStart > centerLine) servedEnd = remStart - 1;
    }
    const finalRange = `${servedStart}-${servedEnd}`;
    // eval-0927 review (bisect: replay p11b, the zoomEpochServedView probe):
    // the item is exactly `finalRange` — its handle is minted for that range
    // below — so it names no `remaining`. The selection window's other
    // unserved spans and the lines the byte cap left out lie OUTSIDE this
    // item's range: they are not this handle's unsent windows, and naming them
    // made a complete pack look partial (a `surface-content` gap whose `next`
    // re-read lines the same response had just shipped).
    // TL142-05 (2026-09-13): relation gating. When the request names
    // explicit path(s), an additional (non-named) counterexample survives
    // only with a stated relation to one of them (report's own acceptance:
    // "追加evidenceには質問との関係を説明できる理由を持たせる") — recorded
    // INTO `why` so the caller can see why it was kept, per the report's own
    // worked example. Otherwise (the pathless variant), decision #2's own
    // relevance condition is narrower than the general admission bar just
    // above: a `strong` match (identifierHit/endpointHit) or a window naming
    // the PRIMARY evidence's own resolved symbol qualifies; a candidate
    // admitted ONLY via the weak `queryTokenHits>=2` fallback (two ordinary
    // words shared with the query, e.g. "cached"+"server", nothing to do
    // with the query's actual subject) does not — that fallback's own reason
    // for existing (an admittedly weak, "borderline case" signal, see its own
    // comment above) is exactly what turned an unrelated UI-refresh routine
    // into a false-positive competing implementation live. A markup/CSS
    // template window (diagnosticsPanel.ts's own embedded <style> block)
    // never qualifies either way. Fails CLOSED in every branch: skip this
    // candidate outright, never fall back to admitting it unconditionally.
    //
    // RIC (2026-09-13, requestItemCompletion regression): a query naming a
    // path for ONE facet (e.g. "the setting definition in package.json")
    // must not veto a counterexample that tests a DIFFERENT facet of the
    // same composite query — most concretely, the query's own PRIMARY
    // identifier/symbol (e.g. a same-named decoy `getDisplayLanguage`
    // unrelated to package.json). A relation to a named path is still
    // preferred and recorded first; only when it is absent does this fall
    // back to the identical strength bar the pathless branch already
    // enforces below (never looser: still `strong`/primary-symbol-grounded,
    // still never a markup/CSS window). Without this fallback, the
    // consumer-does-not-reference/decision-at-function-tail language-setting
    // fixtures silently dropped the sidebar.ts decoy counterexample once the
    // query also happened to name package.json — which (via a downstream
    // route/obligation interaction) let an unproven producer/consumer
    // relation reach `act.answer` with no honest disclosure, and separately
    // dead-ended a resolvable composite query on a bare next-less
    // `search.references`. Bisected empirically: reverting only this
    // relation-gate block (leaving TL142-05's named-path slot, size cap, and
    // BLOCKER-3/SHOULD-FIX-8/11 changes untouched) restored both the honest
    // gap and the composite-query closure; see ric-notes.md.
    let counterexampleWhy: string = "readiness-falsification-counterexample";
    const primarySymbol = existing.find((s) => s.required === true)?.symbol ?? existing[0]?.symbol;
    // "Naming" the primary symbol means the whole identifier, never a longer
    // one that merely starts or ends with it (`invoiceVersionNote`).
    const referencesPrimarySymbol = primarySymbol !== undefined
      && containsWholeIdentifier(candidate.content, primarySymbol, { caseInsensitive: true });
    const identifierGrounded = candidate.strong || referencesPrimarySymbol;
    if (namedPaths.length > 0) {
      // FIX-ORIG: `fullContent` is already hoisted above (it now also feeds
      // the unserved-span narrowing) — no second probe read.
      const relation = statedRelationToNamedPath(candidate.path, fullContent, namedPaths, workspace, counterexampleCache);
      if (relation !== undefined) {
        counterexampleWhy = `${relation} (readiness-falsification-counterexample)`;
      } else {
        if (!identifierGrounded) continue;
        if (looksLikeMarkupOrCssWindow(capped.code)) continue;
      }
    } else {
      if (!identifierGrounded) continue;
      if (looksLikeMarkupOrCssWindow(capped.code)) continue;
    }
    // FIX-ORIG: the handle/surface identify the NARROWED, verbatim-served
    // window (`finalRange`/`capped.code`) — never the wider pre-narrowing
    // selection (`candidate.range`), which may include lines this item does
    // not itself carry any bytes for.
    const handle = handleTable.upsert({
      kind: "range",
      path: candidate.path,
      range: finalRange,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      workspaceRoot: workspace,
      sha: shaOfText(capped.code),
    });
    (result.surfaces as TaskPackResultSurface[]).push({
      role: candidate.role,
      handle: handle.id,
      path: candidate.path,
      range: finalRange,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      // Issue #4 (2026-08-21): only a strong (identifier/endpoint) match
      // forces a REQUIRED obligation; a weak (generic-word-only) match still
      // surfaces so the agent can review it, but must not by itself flip a
      // provisionally ready pack into a blocked one. See the `strong` field
      // built above.
      required: candidate.strong,
      why: counterexampleWhy,
      code: capped.code,
    });
    // Dedup/cap bookkeeping stays keyed on the ORIGINAL selected window
    // (`candidate.range`): that is what selectQueryEvidence chose and what a
    // later ranking pass would choose again, independent of how this item
    // narrowed its own served range.
    existingKeys.add(`${candidate.path}:${candidate.range}`);
    usedPaths.add(candidate.path);
    admitted.set(`${candidate.path}:${candidate.range}`, {
      bytes: Buffer.byteLength(capped.code, "utf8"),
      disposition: candidate.strong ? "required" : "supporting",
    });
    added++;
  }
  return added;
}

export const RECURSIVE_READ_CLOSURE_MAX_DEPTH = 3;

export const RECURSIVE_READ_CLOSURE_MAX_BRANCHES = 3;

export const RECURSIVE_READ_CLOSURE_MAX_OPERATIONS = 6;

export const RECURSIVE_READ_CLOSURE_MAX_MERGED_BYTES = 24 * 1024;

/**
 * Profiles whose discovery is structurally multi-site — the only shapes where
 * the DEEP recursive closure loop has paid for itself (2026-07-19a forensics:
 * on lean single-area tasks the loop inflated pack bulk and downstream output
 * tokens with both arms worse; the wins concentrate in cross-subsystem
 * wiring/multi-concern packs). An explicit caller-pinned taskProfile
 * (profile_binding.source === "explicit") opts in regardless, so mechanism
 * runs can exercise the loop on any profile.
 */
export const RECURSIVE_CLOSURE_DEEP_PROFILES: ReadonlySet<TaskProfile> = new Set([
  "wiring",
  "multi_concern",
  // Propagation tasks are structurally multi-site too: a definition change is
  // incomplete until its bounded consumer/config surfaces are prepared. Use
  // the existing fail-closed depth/branch/operation/byte caps rather than a
  // task- or repository-specific expansion rule.
  "change_propagation",
]);
