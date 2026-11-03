// facetReadiness — extracted implementation; imports point to the owning modules.
import type { ConcernCoverageVerdict } from "./sourceAndConcernTerms4.js";
import type { ConcernScanOutcome } from "./concernProof.js";
import type { FacetFacts } from "../facetGate.js";
import type { FacetLineSpan } from "../facetGate.js";
import type { FacetPlanEntry } from "../facetGate.js";
import type { FacetPlanWindow } from "../facetGate.js";
import type { FacetReadiness } from "./requestItemReadiness.js";
import type { FacetReadinessEntry } from "./requestItemReadiness.js";
import type { FacetRequirement } from "../requestFacets.js";
import type { RequestItemReadiness } from "./concernProof2.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { FACET_OBLIGATION_ID_PREFIX } from "./requestItemReadiness.js";
import { MAX_REQUEST_ITEM_BATCH } from "./recursiveClosure5.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { REQUEST_ITEM_OBLIGATION_PREFIX } from "./recursiveClosure5.js";
import { STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES } from "./answerPackBuilder3.js";
import { activePackByteCeiling } from "./packBasics2.js";
import { asksForStructureMap } from "../structureMap.js";
import { coalesceBlankGapWindows } from "../blankWindowBundles.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { combineSubjectFacetFacts } from "../facetGate.js";
import { csvLookupClosedUniverse } from "./guideAndArtifactSurfaces.js";
import { decideConcernStatus } from "./concernProof.js";
import { effStructureMapEnabled } from "../../../util/flags.js";
import { epochServedSurfaceEntriesWithView } from "./epochEvidence.js";
import { estimateStructureMapReplyBytes } from "./structureMap2.js";
import { evaluateFacetRequirement } from "../facetGate.js";
import { extractFacetRequirements } from "./packBasics2.js";
import { extractRequestItems } from "./packBasics2.js";
import { facetClauseMatchesItem } from "../facetGate.js";
import { facetClausesJointlyOwnItem } from "../facetGate.js";
import { facetDependencyEntriesFor } from "../facetGate.js";
import { facetPlanFor } from "../facetGate.js";
import { facetPlanWorkspaceKey } from "./facetClosure.js";
import { focalRequiredSpan } from "../facetGate.js";
import { isTraceEnabled } from "../../../util/trace.js";
import { itemConjunctionParts } from "../facetGate.js";
import { mergeLineSpans } from "./sourceAndConcernTerms.js";
import { noteUndeliveredFacetLines } from "../facetGate.js";
import { parseSurfaceSpan } from "./packState2.js";
import { parseSurfaceSpans } from "./sourceAndConcernTerms.js";
import { readCached } from "./packBasics2.js";
import { readinessEvidence } from "./changeAndReadinessEvidence2.js";
import { reconstructServedEntryEvidence } from "./epochContract3.js";
import { servedLineSpansOf } from "./sourceAndConcernTerms.js";
import { shaOfText } from "../../../util/handles.js";
import { sliceLinesToText } from "../../../util/countLines.js";
import { surfaceWhyHasMarker } from "./recursiveClosure.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { trace } from "../../../util/trace.js";
import { undeliveredFacetSpans } from "../facetGate.js";
import { unservedSubSpans as unservedFacetSubSpans } from "../facetGate.js";

/** `content` split into its REAL logical lines (a trailing newline never yields a phantom last line — the eval-0927 N+1 class). */
export function logicalLines(content: string): string[] {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * WP-H (eval-0929 §5, `SHOULD` residual 3) — a facet's own citation,
 * WINDOW-PRECISE rather than whole-surface.
 *
 * `buildFacetReadiness`'s `coveringSurfaces` (its only caller, a few lines
 * below) matches a facet's `servedWindows` to a served surface by PATH ALONE
 * — so a same-file surface whose OWN range extends well past any window this
 * facet actually needed still becomes this obligation's evidence at its FULL
 * range (`coverage.surfaces` feeds `decideConcernStatus`, which reads
 * `readinessEvidence(surface).range` verbatim — see that function's own
 * "covered" arm). That is safe (WP-B's `certificateWireInvariant.ts` never
 * loses a cited line), but it is over-broad: WP-B's `keep` predicate —
 * threaded through `capExtraEvidenceRelativeToNamedPaths` (TL142-05's 1.25x
 * named-path bound) via `wouldIntroduceBreach` — then treats the surface's
 * WHOLE claimed range as load-bearing merely because part of it is cited,
 * which can keep bytes that cap exists to remove.
 *
 * Returns `surface` itself, UNCHANGED, when nothing needs narrowing (the
 * common case: this function never allocates on that path) — otherwise a
 * SHALLOW COPY whose `range` is narrowed to exactly the lines of `surface` a
 * window in `windows` actually covers: `mergeLineSpans` over every
 * intersection, comma-joined when the overlap is not one contiguous span
 * (the SAME format `certificateWireInvariant.ts::parseCitedSpans` already
 * reads: `"1-4,9-12"`, mirroring `epochServedEvidence`'s own multi-span
 * ranges). This is the ONLY field touched — `handle`/`code`/`why`/etc. are
 * the same reference, so every OTHER reader of `coveringSurfaces` (the
 * `codeAnchored`/length checks, the diagnostic `servedEvidence` field) sees
 * the identical surface it always did, just with a tighter citation.
 *
 * Falls back to `surface` unchanged when nothing numerically overlaps (a
 * `servedWindows` entry computed from a different resolution than the
 * surface's own served span is a real but rare shape —
 * `evaluateFacetRequirement`'s "caller"/"callee" windows can widen to an
 * enclosing symbol the surface itself was sliced from) — a citation that
 * named no lines at all would be a worse bug than the one this closes, and
 * the pre-existing whole-range citation remains the safe default for that
 * edge.
 */
export function narrowSurfaceToFacetWindows(
  surface: TaskPackSurface,
  windows: readonly FacetPlanWindow[],
): TaskPackSurface {
  const span = parseSurfaceSpan(String(surface.range ?? ""));
  if (span === undefined) return surface;
  const overlaps = windows
    .filter((window) => window.path === surface.path)
    .map((window) => ({ start: Math.max(span.start, window.start), end: Math.min(span.end, window.end) }))
    .filter((overlap) => overlap.start <= overlap.end);
  if (overlaps.length === 0) return surface;
  const merged = mergeLineSpans(overlaps);
  const narrowedRange = merged.map((piece) => `${piece.start}-${piece.end}`).join(",");
  if (narrowedRange === surface.range) return surface;
  return { ...surface, range: narrowedRange };
}

export function buildFacetReadiness(
  workspace: string | undefined,
  query: string,
  profile: TaskProfile,
  result: TaskPackResult,
): FacetReadiness | undefined {
  if (workspace === undefined || profile !== "answer") return undefined;
  // Same two terminal proof shapes `buildRequestItemReadiness` leaves alone.
  if (result.create_target !== undefined || result.literal_source_absence !== undefined) return undefined;
  // A table's rows have settled it: "何件ある" is no value of a callable to go and find.
  if (csvLookupClosedUniverse(workspace)) return undefined;
  const requirements = extractFacetRequirements(query);
  const plan = facetPlanFor(facetPlanWorkspaceKey(workspace), query, (relPath) => {
    const content = readCached(workspace, relPath);
    return content === undefined ? undefined : shaOfText(content);
  });
  // 2026-10-06 independent review (P1-1/P1-2): the constants a served
  // callable reads (`runAnswerDependencyClosure`) are checked whether or not
  // the question names a facet.
  const dependencyEntries = facetDependencyEntriesFor(facetPlanWorkspaceKey(workspace), query, (relPath) => {
    const content = readCached(workspace, relPath);
    return content === undefined ? undefined : shaOfText(content);
  });
  // No facet and no dependency → nothing here runs: every ordinary pack stays byte-identical.
  if (requirements.length === 0 && dependencyEntries.length === 0) return undefined;
  // Served = bytes THIS response ships (`code`) plus the session's sha-gated
  // served-range ledger (earlier hops of this epoch). A `code_unchanged`
  // restatement ("already served, resident in your context") is a CLAIM about
  // an earlier serve, so it counts only where that ledger confirms it —
  // measured: a residency claim for lines an earlier hop had disclosed as
  // `remaining` (never shipped) would otherwise have covered the facet.
  const shipped = codeTaskPackSurfaces(result.surfaces).filter((surface) => (surface.code?.length ?? 0) > 0);
  const carried = reconstructServedEntryEvidence(
    workspace,
    epochServedSurfaceEntriesWithView(workspace, tokenizeForEpoch(query), result, true),
  );
  const evidence = [...shipped, ...carried];
  const surfacesByPath = new Map<string, TaskPackSurface[]>();
  for (const surface of evidence) {
    const bucket = surfacesByPath.get(surface.path);
    if (bucket === undefined) surfacesByPath.set(surface.path, [surface]);
    else bucket.push(surface);
  }
  const spansByPath = new Map<string, FacetLineSpan[]>();
  const servedSpans = (relPath: string): readonly FacetLineSpan[] => {
    let spans = spansByPath.get(relPath);
    if (spans === undefined) {
      spans = servedLineSpansOf(surfacesByPath.get(relPath) ?? []);
      spansByPath.set(relPath, spans);
    }
    return spans;
  };
  const linesByPath = new Map<string, string[] | undefined>();
  const fileLines = (relPath: string): readonly string[] | undefined => {
    if (!linesByPath.has(relPath)) {
      const content = readCached(workspace, relPath);
      linesByPath.set(relPath, content === undefined ? undefined : logicalLines(content));
    }
    return linesByPath.get(relPath);
  };
  // Termination (facetGate.ts `noteUndeliveredFacetLines`): lines THIS call
  // requested (a caller-supplied surface) and got no byte of — no `code`, and
  // not confirmed by the ledger — are never requested again for this query.
  // A partially shipped surface (budget paging: body + `remaining`) is
  // progress and is not recorded.
  const workspaceKey = facetPlanWorkspaceKey(workspace);
  for (const surface of codeTaskPackSurfaces(result.surfaces)) {
    if (!surfaceWhyHasMarker(surface.why, "caller-supplied") || (surface.code?.length ?? 0) > 0) continue;
    const requested = parseSurfaceSpans(surface.range);
    const confirmed = servedSpans(surface.path);
    for (const span of requested) {
      noteUndeliveredFacetLines(workspaceKey, query, surface.path, unservedFacetSubSpans(span, confirmed));
    }
  }
  const undeliveredSpans = (relPath: string): readonly FacetLineSpan[] => undeliveredFacetSpans(workspaceKey, query, relPath);

  const entries: FacetReadinessEntry[] = [];
  const openTargets: Array<{ path: string; range: string }> = [];
  const seenTargets = new Set<string>();
  const disclosures: Array<{ id: string; term: string; word: "request-item-empty" | "request-item-undetermined"; reason: string }> = [];
  const ctx = { servedSpans, fileLines, undeliveredSpans };
  const admit = (
    label: string,
    requirement: FacetRequirement,
    subjectFacts: readonly FacetFacts[],
    entry: FacetPlanEntry | undefined,
    dependency: boolean,
  ): void => {
    const facts = combineSubjectFacetFacts(subjectFacts);
    const coveringSurfaces = evidence
      .filter((surface) => facts.servedWindows.some((window) => window.path === surface.path))
      .map((surface) => narrowSurfaceToFacetWindows(surface, facts.servedWindows));
    const coverage: ConcernCoverageVerdict = facts.kind === "covered" || facts.kind === "empty"
      ? { covered: true, surfaces: coveringSurfaces, matchedTerms: [facts.term], codeAnchored: coveringSurfaces.length > 0, reason: facts.reason }
      : { covered: false, surfaces: [], matchedTerms: [], codeAnchored: false, reason: facts.reason };
    const outcome: ConcernScanOutcome = facts.kind === "open"
      ? { kind: "unserved-candidates", candidatePaths: [...new Set(facts.openTargets.map((target) => target.path))] }
      : { kind: "indeterminate", reason: facts.reason };
    const verdict = decideConcernStatus([facts.term], coverage, outcome);
    const obligation: TaskReadinessObligation = {
      id: `${FACET_OBLIGATION_ID_PREFIX}${label}:${requirement.facet}`,
      kind: "concern",
      status: verdict.status === "open" ? "uncovered" : "proved",
      required: true,
      evidence: verdict.evidence.slice(0, 6),
      reason: verdict.status === "could-not-determine"
        ? `could not determine (disclosed): ${verdict.reason}`
        : verdict.status === "covered" && facts.kind === "empty"
          ? `verified empty (disclosed): ${facts.reason}`
          : verdict.reason,
      origin: "query",
    };
    if (verdict.status === "open") {
      for (const target of facts.openTargets) {
        const range = `${target.start}-${target.end}`;
        const key = `${target.path}\u0000${range}`;
        if (seenTargets.has(key)) continue;
        seenTargets.add(key);
        openTargets.push({ path: target.path, range });
      }
    }
    if (verdict.status !== "open") {
      for (const subject of subjectFacts) {
        if (subject.disclosure !== undefined) disclosures.push({ id: `facet-${label}`, term: subject.term, word: subject.disclosure.word, reason: subject.disclosure.reason });
      }
    }
    if (isTraceEnabled()) {
      trace("facet_gate_status", {
        id: obligation.id,
        facet: requirement.facet,
        kind: facts.kind,
        status: verdict.status,
        plan: entry === undefined ? "missing" : entry.resolution,
        open: facts.openTargets.length,
        served: facts.servedWindows.length,
      }, workspace);
    }
    entries.push({
      label, ...(dependency ? { dependency: true as const } : {}), requirement, facts, status: verdict.status, obligation,
      servedEvidence: coveringSurfaces.map(readinessEvidence).slice(0, 6),
    });
  };
  requirements.forEach((requirement, position) => {
    // 2026-10-06 independent review (P1-4): a requirement naming several
    // subjects planned one entry per resolved subject (`FacetPlanEntry
    // .subject`); every one of them is required.
    const matching = plan?.entries.filter((candidate) => candidate.dependency !== true
      && candidate.facet === requirement.facet && candidate.clause === requirement.clause) ?? [];
    const entry = matching.find((candidate) => candidate.subject === undefined) ?? matching[0];
    const subjectFacts = [
      evaluateFacetRequirement(requirement, entry, ctx),
      ...matching
        .filter((candidate) => candidate !== entry && candidate.subject !== undefined)
        .map((candidate) => evaluateFacetRequirement({ ...requirement, subjectIdentifiers: [candidate.subject!], inheritedFromLead: false }, candidate, ctx)),
    ];
    admit(String(position + 1), requirement, subjectFacts, entry, false);
  });
  // 2026-10-06 independent review (P1-1/P1-2): each served callable's own
  // dependency values. Covered (the values are on the wire) or empty (it
  // reads none) adds nothing — no obligation, no disclosure; only an open or
  // undetermined one is said, so a pack whose evidence is complete stays
  // byte-identical.
  for (const entry of dependencyEntries) {
    // A callable this epoch has not delivered whole owes no dependency yet:
    // its own continuation comes first. Measured (ceilingFallbackHonesty,
    // a 120-branch focal under an 8 KB ceiling): the shed body's constants
    // took the `next`, and the follow-up certified with no branch delivered.
    const focal = entry.focal;
    if (focal === undefined) continue;
    const focalSpan = focalRequiredSpan(focal.start, focal.end, fileLines(focal.path)) ?? { start: focal.start, end: focal.end };
    if (unservedFacetSubSpans(focalSpan, servedSpans(focal.path)).length > 0) continue;
    const subject = entry.subject ?? focal.name;
    // The callable's own name is the clause a disclosure names ("value:priceFor").
    const requirement: FacetRequirement = { facet: "value", clause: subject, subjectIdentifiers: [subject], subjectTerms: [], inheritedFromLead: false };
    const facts = evaluateFacetRequirement(requirement, entry, ctx);
    if (facts.kind === "covered" || facts.kind === "empty") continue;
    admit(`dependency:${subject}`, requirement, [facts], entry, true);
  }
  // Nothing to say (no facet, every dependency covered): exactly as if this
  // gate had not run.
  if (requirements.length === 0 && entries.length === 0) return undefined;
  return { entries, openTargets, disclosures };
}

/**
 * FIX-G G5 — ONE point, ONE owner. A request item (requestItems.ts's split of
 * the same query) whose clause is a facet this gate RESOLVED (a focal exists)
 * is tracked by that facet's obligation: its own blocking obligation (if any)
 * is marked proved with a pointer to the facet — the same "owned, not
 * duplicated" rule the enumerated-item facets (F-V13-6) already impose on
 * request items — and its could-not-determine disclosure is dropped, because
 * the facet reports a real determination for the same point (eval-0927 §4:
 * "既定値" / "リクエストの処理経路" were disclosed as undetermined while the pack
 * served DEFAULT_OPTIONS and the request path).
 *
 * WP-C revision (2026-09-29, eval-0929 §6/§8): a literal ABSENCE is now
 * dropped here too, but ONLY when the disclosed term is made up entirely of
 * the closed generic/facet-descriptor vocabulary (see the filter's own doc
 * comment below) — never merely because the item is "owned". The prior rule
 * ("a verified absence is never dropped here", `absenceContradictsServed
 * Evidence` already vetoes anything the served bytes contradict) held only
 * because a facet-owned item's own absence candidate was assumed to be ITS
 * OWN subject. Measured counterexample (eval-0929 §6): a facet resolves
 * "the conditions of should_retry" against the real, present `should_retry`
 * — yet the item-absence pass, falling back to a lowercase DESCRIPTIVE word
 * once its own identifier went unrecognized (now fixed in requestItems.ts's
 * `extractTerms`), certified `request-item-absent:conditions`. "conditions"
 * is the facet's OWN classifying vocabulary (requestFacets.ts's
 * `CONDITION_BARE_EN_RE`), never the workspace subject — the facet owning
 * this clause with real, served evidence means that word is not a second,
 * independent gap. A first, broader attempt at this fix (drop whenever the
 * term is not one of the item's own `item.terms`) regressed
 * concernRetentionMatrix.spec.ts's MATRIX-A2 "database migrations are
 * executed" case: a genuinely absent, non-identifier, multi-word subject
 * ("database/migrations", from `proveUnbindableRequestItem`'s whole-item
 * union check) got silently dropped because its OWN item had been
 * mis-attributed to an unrelated facet clause by a pre-existing "plus"-
 * joined clause-boundary mismatch (outside this fix's region). Gating on
 * the closed generic-word list instead cannot drop that kind of absence —
 * "database"/"migrations" are ordinary, distinguishing content words, never
 * members of that list — while still catching the reported descriptive
 * words (conditions/callers/codes/statuses/flow/...) whichever mechanism
 * disclosed them.
 *
 * WP-C3 revision (2026-09-29, orchestrator RULING rule 2(d)): "every word of
 * a clause whose facet RESOLVED a focal" is never eligible — the facet owns
 * that point and reports its own determination for it (covered, verified
 * empty, or undetermined), so a request-item absence for the SAME point is a
 * second, competing claim, whatever word it names. Owned items' absences are
 * therefore dropped outright, like their undetermined disclosures just
 * above. The MATRIX-A2 regression that kept WP-C's narrower filter was an
 * OWNERSHIP error, not an absence one — its item was attributed to an
 * unrelated facet clause because requestFacets.ts did not split on "plus";
 * WP-C2 aligned that module's clause joiners with requestItems.ts's own
 * (`CLAUSE_SPLIT_RE`), so `facetClauseMatchesItem` no longer claims a
 * sibling point joined that way (concernRetentionMatrix.spec.ts guards it).
 */
export function reconcileRequestItemsWithFacets(
  readiness: RequestItemReadiness,
  facets: FacetReadiness,
  query: string,
): ReadonlySet<string> {
  const ownedIds = new Set<string>();
  const resolved = facets.entries.filter((entry) => entry.facts.focalResolved && entry.dependency !== true);
  if (resolved.length === 0) return ownedIds;
  const items = extractRequestItems(query);
  const clauses = resolved.map((entry) => entry.requirement.clause);
  for (const item of items) {
    if (resolved.some((entry) => facetClauseMatchesItem(entry.requirement.clause, item.text))
      || facetClausesJointlyOwnItem(clauses, item.text)) ownedIds.add(item.id);
  }
  if (ownedIds.size === 0) return ownedIds;
  const ownersOf = (itemId: string): FacetReadinessEntry[] => {
    const text = items.find((item) => item.id === itemId)?.text;
    if (text === undefined) return [];
    const single = resolved.filter((entry) => facetClauseMatchesItem(entry.requirement.clause, text));
    if (single.length > 0) return single;
    const owners = new Set<FacetReadinessEntry>();
    for (const part of itemConjunctionParts(text)) {
      const owner = resolved.find((entry) => facetClauseMatchesItem(entry.requirement.clause, part));
      if (owner !== undefined) owners.add(owner);
    }
    return [...owners];
  };
  for (const obligation of readiness.obligations) {
    const itemId = obligation.id.slice(REQUEST_ITEM_OBLIGATION_PREFIX.length);
    if (!ownedIds.has(itemId) || obligation.status === "proved") continue;
    const owners = ownersOf(itemId);
    if (owners.length === 0) continue;
    obligation.status = "proved";
    obligation.evidence = owners.flatMap((entry) => [...entry.servedEvidence]);
    obligation.reason = `this point is tracked by ${owners.map((entry) => entry.obligation.id).join(", ")} (their evidence closure); not duplicated as a separate request-item obligation`;
  }
  readiness.undetermined = readiness.undetermined.filter((entry) => !ownedIds.has(entry.id));
  // WP-C (eval-0929 §6/§8): see this function's own doc comment above — an
  // owned item's absence is dropped ONLY when the disclosed term is made up
  // ENTIRELY of the closed generic/facet-descriptor vocabulary
  // (`GENERIC_SOFTWARE_ABSENCE_WORDS`/`isGenericJapaneseAbsenceTerm` — the
  // SAME lists `distinctiveSalientAbsence`'s Tier C and
  // `proveUnbindableRequestItem` already gate candidacy on), never merely
  // "not one of the item's own identifier terms". Measured regression from
  // an earlier, broader version of this guard (concernRetentionMatrix.spec.ts
  // MATRIX-A2 "Walk me through ... plus how database migrations are
  // executed"): a genuinely absent, DISTINGUISHING multi-word term like
  // "database/migrations" (from `proveUnbindableRequestItem`'s whole-item
  // union check, never a code identifier) was wrongly dropped merely
  // because its own item got mis-attributed to an UNRELATED facet's clause
  // (a pre-existing "plus"-joined clause boundary mismatch between this
  // module's own item-splitting and requestFacets.ts's clause-splitting,
  // outside this fix's region) — silencing the ONE disclosure the query
  // had left. A facet-descriptor word (singular or joined by "/") is
  // structurally different: it can NEVER be this kind of distinguishing
  // subject (design §4.2's own test — "would this word's absence ever tell
  // a reader something about THIS workspace?" — is already false for it by
  // construction), so gating on that closed vocabulary is the narrow,
  // provably-safe defense-in-depth the brief asks for, with no way to catch
  // a genuine content absence in its net.
  //
  // WP-C3 (rule 2(d)): superseded — see this function's doc comment. The
  // facet that resolved a focal for this clause owns every word of it.
  readiness.absences = readiness.absences.filter((absence) => !ownedIds.has(absence.id));
  const gap = readiness.gap;
  if (gap !== undefined) {
    const remaining = gap.ids.filter((id) => !ownedIds.has(id));
    if (remaining.length === 0) delete readiness.gap;
    else gap.ids = remaining;
  }
  return ownedIds;
}

/**
 * FIX-G G4 — `analysis-source` asks for grounded evidence (caller-scoped,
 * artifact, or an explicit identifier) so a same-word decoy cannot close an
 * analysis. A RESOLVED facet whose focal / closure windows are on the wire is
 * that grounding in structural form: the server resolved the question's subject
 * to a callable and served the constants it reads / its call sites — never a
 * bare token match. Discharge only (never re-opens anything), mirroring
 * `reconcileAnalysisSourceFromRequestItems`.
 */
export function reconcileAnalysisSourceFromFacets(
  otherObligations: readonly TaskReadinessObligation[],
  facets: FacetReadiness,
): void {
  const stale = otherObligations.find((obligation) => obligation.id === "analysis-source" && obligation.status !== "proved");
  if (stale === undefined) return;
  const grounded = facets.entries.find((entry) => entry.dependency !== true && entry.facts.focalResolved && entry.facts.servedWindows.length > 0);
  if (grounded === undefined) return;
  stale.status = "proved";
  stale.evidence = [...grounded.servedEvidence];
  stale.reason = `analysis is grounded in the structural evidence closure served for ${grounded.obligation.id}`;
}

/** A facet `next` asks for no more window bytes than this share of the call's byte ceiling (the follow-up runs under the same client ceiling) — always at least one window, the rest ride later hops. */
export const FACET_NEXT_CEILING_SHARE = 0.75;

/** The ceiling assumed for sizing a facet `next` when no caller/client ceiling is active (the default ladder's lowest step), and the most a map continuation page is sized for under a higher one (`mergeFacetGap`). */
export const FACET_NEXT_DEFAULT_CEILING = 24576;

/**
 * From this ceiling up, the open windows of a short, map-shaped answer are asked
 * for in batches sized to the ceiling (`mergeFacetGap`'s `mapBatch`: up to
 * FACET_NEXT_MAX_TARGETS windows, each priced as the row it will ship, within the
 * ceiling less the envelope): the Copilot CLI's 18,432 B, where the batches were
 * measured. Below it a map-shaped answer's windows are batched the same way
 * (`mergeFacetGap`), and any other request's stay MAX_REQUEST_ITEM_BATCH at a time
 * within three quarters of the ceiling, measured in source bytes. What stays tied
 * to this tier is which first page is a map (`structureMapForAnswer`).
 */
export const FACET_NEXT_MAP_BATCH_MIN_CEILING_BYTES = 18 * 1024;

/**
 * Whether the pack in progress runs under a ceiling at or above the tier
 * (`FACET_NEXT_MAP_BATCH_MIN_CEILING_BYTES`). Every pack without a ceiling does.
 * `structureMapForAnswer` admits only a page that holds the map's skeleton below it.
 */
export function mapContinuationBatched(): boolean {
  return (activePackByteCeiling() ?? FACET_NEXT_DEFAULT_CEILING) >= FACET_NEXT_MAP_BATCH_MIN_CEILING_BYTES;
}

/** True when `surfaces` serve a structure map (`renderStructureMapSurface`): a surface whose rows ride as appended `structure map (a-b)` windows. */
export function servesStructureMap(surfaces: readonly TaskPackSurface[]): boolean {
  return surfaces.some(surface => surface.appended_windows?.some(window => window.marker.startsWith("\n\n/* structure map (")) === true);
}

/** Tiny disjoint facet windows share one model turn; wire bytes still bound the page. */
export const FACET_NEXT_MAX_TARGETS = 64;

/**
 * The request-item gap with every OPEN facet's exact windows appended
 * (query-bearing, ranged, ≤ FACET_NEXT_MAX_TARGETS targets), sized so the
 * follow-up response fits the same byte ceiling this call runs under:
 * a caller-ranged follow-up serves what it names, so an over-long batch would
 * ship above a client's ceiling rather than page (measured: a 10-constant
 * closure batch returned 24 KB under the VS Code 14 KB ceiling). Windows past
 * the budget are simply requested by the next hop — each hop serves at least
 * one, so the chain still terminates.
 */
export function mergeFacetGap(
  gap: RequestItemReadiness["gap"],
  facets: FacetReadiness | undefined,
  query: string,
  workspace: string | undefined,
  surfaces: readonly TaskPackSurface[] = [],
  answerTask = false,
): RequestItemReadiness["gap"] {
  if (facets === undefined || facets.openTargets.length === 0 || workspace === undefined) return gap;
  const openIds = facets.entries.filter((entry) => entry.status === "open").map((entry) => `facet-${entry.label}`);
  const baseTargets = ((gap?.next_call.arguments as { targets?: unknown } | undefined)?.targets as Array<{ path: string; range?: string }> | undefined) ?? [];
  const keyOf = (target: { path: string; range?: string }): string => `${target.path}\u0000${target.range ?? ""}`;
  const seen = new Set(baseTargets.map(keyOf));
  const targets = [...baseTargets];
  // A map-shaped answer asks for its owed windows in batches under any ceiling. Below
  // FACET_NEXT_MAP_BATCH_MIN_CEILING_BYTES a type too large for the map's skeleton is
  // walked member by member, and whole windows within a share of the ceiling, doc
  // comments counted, came back as pages of 1.7 to 9.6 KB under VS Code's 14,336 B: nine
  // replies for T03 where batches priced as the rows they ship take seven (2026-11-02).
  const mapBatch = answerTask && effStructureMapEnabled() && asksForStructureMap(query);
  const tinyWindows = mapBatch || effStructureMapEnabled() && asksForStructureMap(query)
    && mapContinuationBatched()
    && facets.openTargets.every(target => {
    const bounds = /^(\d+)-(\d+)$/.exec(target.range);
    const content = readCached(workspace, target.path);
    return bounds !== null && content !== undefined
      && Buffer.byteLength(sliceLinesToText(content, Number(bounds[1]), Number(bounds[2])), "utf8") <= MAX_SURFACE_CODE_BYTES;
  });
  // Map continuations estimate each source row with its actual body policy
  // and address cost. Reserve the small continuation envelope separately;
  // the final wire packer still enforces the unchanged client ceiling.
  const ceiling = activePackByteCeiling() ?? FACET_NEXT_DEFAULT_CEILING;
  // A page of owed windows is held to the code tier of the pack cap (27,648
  // bytes) whatever the client's ceiling is, and its own decision, contract and
  // `next` take about 3 KiB of that: windows asked past ~24.5 KB are trimmed or
  // shed, and the tail of the member the first page cut goes out alone before
  // the rest (T03 under an explicit `budget.bytes` of 28,000 and more cost one
  // or two replies more than pages that fit). The default ceiling is that
  // measure, so a ceiling above it buys no larger page.
  const pageCeiling = Math.min(ceiling, FACET_NEXT_DEFAULT_CEILING);
  const byteBudget = mapBatch ? pageCeiling - 2048 : Math.floor(ceiling * FACET_NEXT_CEILING_SHARE);
  // R2-T1 (eval-0929 review P0-3, orchestrator ruling rule 2): the largest
  // window ONE follow-up surface carries whole (the per-surface code cap) — the
  // rest of a long condition / flow focal is larger than that, and asked for
  // as one window it came back cut at that cap, costing a further hop for its
  // tail even when the follow-up had room for both. The byte budget still
  // bounds how many pieces one follow-up asks for (always the first); a piece
  // the follow-up cannot carry whole under a small ceiling is paged by the
  // gate's ordinary open -> `next` on the hop after, exactly as before.
  const pieceBytes = MAX_SURFACE_CODE_BYTES;
  let bytes = tinyWindows ? baseTargets.reduce((total, target) => {
    const bounds = /^(\d+)-(\d+)$/.exec(target.range ?? "");
    const content = readCached(workspace, target.path);
    if (bounds === null || content === undefined) return total + 256;
    return total + estimateStructureMapReplyBytes(target.path, content.split(/\r?\n/),
      [{ start: Number(bounds[1]), end: Number(bounds[2]) }], []) - STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES;
  }, 0) : 0;
  let added = tinyWindows ? baseTargets.length : 0;
  // Blank-only gaps add no new behavioral scope; carrying their actual bytes
  // avoids paying a complete evidence envelope for each tiny source fragment.
  const openTargets = tinyWindows
    ? coalesceBlankGapWindows(facets.openTargets, path => readCached(workspace, path), pieceBytes)
    : facets.openTargets;
  for (const target of openTargets) {
    if (seen.has(keyOf(target))) continue;
    const bounds = /^(\d+)-(\d+)$/.exec(target.range);
    const content = readCached(workspace, target.path);
    const windowBytes = bounds !== null && content !== undefined
      ? Buffer.byteLength(sliceLinesToText(content, Number(bounds[1]), Number(bounds[2])), "utf8")
      : 0;
    const wireBytes = !tinyWindows ? windowBytes : bounds !== null && content !== undefined
      ? estimateStructureMapReplyBytes(target.path, content.split(/\r?\n/), [{ start: Number(bounds[1]), end: Number(bounds[2]) }], []) - STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES
      : windowBytes + 256;
    if (mapBatch && bounds !== null && content !== undefined) {
      seen.add(keyOf(target));
      const lines = content.split(/\r?\n/);
      let cursor = Number(bounds[1]);
      const end = Number(bounds[2]);
      while (cursor <= end && targets.length < FACET_NEXT_MAX_TARGETS) {
        const first = byteBoundedLinePieces(content, cursor, end, pieceBytes)[0];
        if (first === undefined) break;
        let low = cursor, high = first.end, best = cursor - 1, cost = 0;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const needed = estimateStructureMapReplyBytes(target.path, lines, [{start: cursor, end: middle}], [])
            - STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES;
          if (bytes + needed <= byteBudget) {best = middle; cost = needed; low = middle + 1;}
          else high = middle - 1;
        }
        if (best < cursor) break;
        targets.push({path: target.path, range: cursor + "-" + best});
        bytes += cost; added++;
        cursor = best + 1;
      }
      continue; // Undelivered suffixes stay open in the same facet ledger.
    }
    if (added > 0 && bytes + wireBytes > byteBudget) {
      if (tinyWindows) continue; // Leave this window owed; later small windows can still fit.
      break;
    }
    if (bounds !== null && content !== undefined && windowBytes > pieceBytes) {
      // R2-T1: an oversized window is named as consecutive pieces, each one a
      // follow-up surface carries whole, as many as the budget holds (always
      // the first) — the gate names the unserved rest again on the next hop.
      seen.add(keyOf(target));
      for (const piece of byteBoundedLinePieces(content, Number(bounds[1]), Number(bounds[2]), pieceBytes)) {
        const wirePieceBytes = !tinyWindows ? piece.bytes : estimateStructureMapReplyBytes(target.path, content.split(/\r?\n/), [piece], []) - STRUCTURE_MAP_ENVELOPE_RESERVE_BYTES;
        if (added > 0 && bytes + wirePieceBytes > byteBudget) break;
        bytes += wirePieceBytes;
        added += 1;
        targets.push({ path: target.path, range: `${piece.start}-${piece.end}` });
      }
      continue;
    }
    bytes += wireBytes;
    added += 1;
    seen.add(keyOf(target));
    targets.push({ path: target.path, range: target.range });
  }
  const page = targets.slice(0, tinyWindows ? FACET_NEXT_MAX_TARGETS : MAX_REQUEST_ITEM_BATCH);
  // Pre-shed sizing of the executable candidate call: long repeated paths
  // must not consume the entire response before any source can be carried.
  // The same next also rides in the internal contract and gap. Reserve
  // their repeated control cost before allowing a batch to displace source.
  const nextBudget = Math.floor((activePackByteCeiling() ?? FACET_NEXT_DEFAULT_CEILING) * 0.125);
  const surfaceHandles = new Map(codeTaskPackSurfaces([...surfaces]).map(surface => [surface.path, surface.handle]));
  const wirePage = (): Array<{ path?: string; handle?: string; range?: string; ranges?: string[] }> => {
    if (!tinyWindows) return page;
    const grouped = new Map<string, {path?: string; handle?: string; range?: string; ranges?: string[]}>();
    for (const target of page) {
      const handle = surfaceHandles.get(target.path);
      const key = handle === undefined ? "path:" + target.path : "handle:" + handle;
      const prior = grouped.get(key);
      if (target.range === undefined || (prior && prior.range === undefined && prior.ranges === undefined)) {
        grouped.set(key, handle === undefined ? {path: target.path} : {handle}); continue;
      }
      if (!prior) {grouped.set(key, handle === undefined ? {...target} : {handle, range: target.range}); continue;}
      const ranges = prior.ranges ?? (prior.range === undefined ? [] : [prior.range]);
      if (!ranges.includes(target.range)) ranges.push(target.range);
      delete prior.range; prior.ranges = ranges;
    }
    return [...grouped.values()];
  };
  const nextBytes = (): number => Buffer.byteLength(JSON.stringify({ query, targets: wirePage(), content: "auto" }), "utf8") + 512;
  while (tinyWindows && page.length > 1 && nextBytes() > nextBudget) page.pop();
  return {
    next_call: {
      tool: "tl_read_file",
      arguments: {
        query,
        targets: wirePage(),
        content: "auto",
      },
    },
    ids: [...(gap?.ids ?? []), ...openIds],
  };
}

/**
 * R2-T1: `[start, end]` of `content` as consecutive whole-line pieces of at
 * most `maxBytes` bytes each (a single line longer than that is its own
 * piece), in order, with their byte sizes — `mergeFacetGap`'s split of a
 * window no one follow-up surface carries whole.
 */
export function byteBoundedLinePieces(
  content: string,
  start: number,
  end: number,
  maxBytes: number,
): Array<{ start: number; end: number; bytes: number }> {
  const lines = content.split(/\r?\n/);
  const last = Math.min(end, lines.length);
  const pieces: Array<{ start: number; end: number; bytes: number }> = [];
  let pieceStart = start;
  let pieceBytes = 0;
  for (let line = start; line <= last; line++) {
    const lineBytes = Buffer.byteLength(lines[line - 1] ?? "", "utf8") + (line > pieceStart ? 1 : 0);
    if (line > pieceStart && pieceBytes + lineBytes > maxBytes) {
      pieces.push({ start: pieceStart, end: line - 1, bytes: pieceBytes });
      pieceStart = line;
      pieceBytes = Buffer.byteLength(lines[line - 1] ?? "", "utf8");
      continue;
    }
    pieceBytes += lineBytes;
  }
  if (pieceStart <= last) pieces.push({ start: pieceStart, end: last, bytes: pieceBytes });
  return pieces;
}
