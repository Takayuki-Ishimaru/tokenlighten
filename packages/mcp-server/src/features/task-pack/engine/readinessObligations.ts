// readinessObligations — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackResult } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { TaskReadinessEvidence } from "@tokenlighten/types";
import type { TaskReadinessObligation } from "@tokenlighten/types";
import { ASKED_PATH_OBLIGATION_PREFIX } from "../askedPathClosure.js";
import { BEHAVIOR_QUERY_RE } from "./changeAndReadinessEvidence2.js";
import { FileReadCache } from "./packBasics2.js";
import { anchorDefinitionsFor } from "../anchorFirst.js";
import { bundledArtifactPaths } from "./artifactPackBuilder2.js";
import { callableBodiesNotShown } from "./changeAndReadinessEvidence.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { csvLookupClosedUniverse } from "./guideAndArtifactSurfaces.js";
import { currentAskedPathPlan } from "./facetClosure2.js";
import { definedCallableNames } from "./wiringEvidence3.js";
import { enumeratedItemCarriesCodeShape } from "./identifierAbsence2.js";
import { enumeratedObligationSummaryCountedResults } from "./identifierAbsence2.js";
import { enumeratedQueryItemsForEpoch } from "./readinessFalsification.js";
import { epochServedEvidence } from "./epochContract2.js";
import { exactIdentifierEvidence } from "./changeAndReadinessEvidence.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { groundedAnalysisEvidence } from "./recursiveClosure5.js";
import { hasAnalysisIntentMarker } from "./coverageAndContinuation3.js";
import { hasCallableBody } from "./changeAndReadinessEvidence2.js";
import { hasExactNamedAnswerFacetEvidence } from "./recursiveClosure.js";
import { hasOpenUniverseIntent } from "../openUniverseIntent.js";
import { hasRequiredArtifactSections } from "./artifactPackBuilder2.js";
import { hasServedCode } from "./wiringEvidence2.js";
import { identifierGroundingEnabled } from "../../../util/flags.js";
import { identifierIsUngrounded } from "./identifierAbsence2.js";
import { implementsCallableToken } from "./wiringEvidence2.js";
import { isAdditiveEnumIntent } from "../openUniverseIntent.js";
import { isArtifactConsumerSurface } from "../artifactConsumers.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isLiteralFirstSurfaceDuty } from "./changeAndReadinessEvidence.js";
import { isTraceEnabled } from "../../../util/trace.js";
import { literalSurfaceDutyEvidence } from "./changeAndReadinessEvidence2.js";
import { memberOnlyExplicitIdentifiers } from "./anchorFocus3.js";
import { memberReferenceIsUndefined } from "./identifierAbsence2.js";
import { moduleShapedQueryTokens } from "./queryIntent4.js";
import { namedAuthorityFacetProofs } from "./changeAndReadinessEvidence.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { packAnchorIO } from "./roleAndConcernScope3.js";
import { previewAnchoredIdentifiers } from "./answerCertificates2.js";
import { queryServedSurfaces } from "../../../util/packServeLog.js";
import { readCached } from "./packBasics2.js";
import { readinessEvidence } from "./changeAndReadinessEvidence2.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { sameNameIdentifierObligation } from "./sameNameSubjects.js";
import { sameNameSubjectsFor } from "./sameNameSubjects.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { shaOfText } from "../../../util/handles.js";
import { surfaceBodyContainsToken } from "./changeAndReadinessEvidence2.js";
import { surfaceBodyCoversRange } from "./seedResolution.js";
import { surfaceContainsFacet } from "./changeAndReadinessEvidence2.js";
import { surfaceRangeShipped } from "./receiptProgress3.js";
import { surfaceServesLine } from "./seedResolution.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { trace } from "../../../util/trace.js";
import { unservedSameNameDeclarations } from "./sameNameSubjects.js";
import { unshownCallableBodiesByResult } from "./changeAndReadinessEvidence2.js";
import { verifiedAbsentIdentifiersFor } from "./identifierAbsence.js";

export function buildReadinessObligations(
  result: TaskPackResult,
  profile: TaskProfile,
  query: string,
  openUniverseDischarged = false,
  /** I-7: workspace for the trace-only enumerated_obligation_summary emission below; omitted by the readiness specs that build synthetic results with no real filesystem — same optionality convention buildTaskExecutionContract's own `workspace` param already uses. */
  workspace?: string,
): TaskReadinessObligation[] {
  // Artifact consumers are context, never readiness evidence: a consumer's
  // callable body must not prove the implementation target the pack lacks.
  const surfaces = codeTaskPackSurfaces(result.surfaces).filter((surface) => !isArtifactConsumerSurface(surface));
  const served = surfaces.filter(hasServedCode);
  // R-D2 (2026-09-21, TL-06 REBUILD class) — THE SAME epoch-served evidence
  // request items already read (`epochServedEvidence`, the `priorEvidence` of
  // `buildRequestItemReadiness`) must also reach the two BASE obligations
  // this function mints (`surface-content`, `behavior-body`). Before this fix
  // only the identifier obligation (further below) and request-item proofs
  // consulted ANY carried-forward evidence, so a bare-qref/task.handle
  // REBUILD of a declared-answer task saw only its own fresh (often sparse,
  // pathless-auto-sliced) `served` for these two checks even though an
  // earlier call of the SAME task had already served the exact bytes that
  // prove them, under the identical sha.
  //
  // MUST CHECK BOTH STORES, not just the WP-S11 read-only view — see
  // `recordPredatesAdditionalServedEvidence`'s own "MUST CHECK BOTH STORES"
  // section, which this obligation-level fix must honor for the identical
  // reason: `cumulativeEligible` (and therefore which of the two stores a
  // given hop's OWN surfaces land in) is recomputed PER CALL from THAT call's
  // own `profile_binding.source`, so a declared task's later, wording-
  // inferred hop can file its surfaces in the CUMULATIVE log even though the
  // task's own seed was a declared answer. `epochServedEvidence` is the one
  // reader that already assembles the complete picture from both stores for
  // an answer-profile caller — reusing it here (rather than the narrower,
  // WP-S11-only `readOnlyViewCarriedEvidence` the identifier obligation below
  // historically used) is what closes a REBUILD whose own auto-discovery
  // finds nothing at all to re-derive from (measured: a numbered "Walk me
  // through: 1. ... 2. ..." query over a one-small fixture — hop 1's own call
  // omits `task.profile` and binds `source:"inferred"`, so its whole-file
  // serve lands in the cumulative log, not the read-only view; a bare-qref
  // repack whose own fresh discovery yields zero surfaces then never triggers
  // the existing cumulative-coverage flip either, since that flip itself is
  // gated on the rebuild's OWN surfaces being non-empty first).
  //
  // Scoped exactly like the identifier obligation's own carry: answer profile
  // only (`profile === "answer"`), and a documented no-op for every other
  // task, so nothing about the generic (edit) profile moves. NEVER granted
  // write authority: `actionFrontierForCertificate` decides
  // edit-frontier/action-frontier membership from `result.surfaces` and the
  // cumulative log directly, never from this function's obligations, so
  // widening what proves `surface-content`/`behavior-body` cannot widen what
  // an edit may touch.
  const servedWithCarried = profile === "answer" && workspace !== undefined
    ? epochServedEvidence(workspace, result, tokenizeForEpoch(query), profile).filter(hasServedCode)
    : served;
  const servedWithCarriedPaths = new Set(servedWithCarried.map((surface) => surface.path));
  // P1-9 (eval-0927 review-r4, hugeFocalValue): a required surface an earlier
  // hop cut at the transport cap is re-listed by a later rebuild as `prior`
  // with its stale `remaining`, and a cut surface never grants residency for
  // its unshipped half — so after the zooms its own `next` prescribed had
  // shipped every remaining line, `surface-content` still read "codeless" and
  // the chain ended `await_input` with nothing left to read. Answer tasks only
  // (never write authority): the session's served-range ledger proving every
  // line of the surface's range shipped is the evidence.
  const ledgerShippedRequired = profile === "answer" && workspace !== undefined
    ? surfaces.filter((surface) => surface.required !== false
      && !servedWithCarriedPaths.has(surface.path)
      && surfaceRangeShipped(workspace, surface.path, surface.range))
    : [];
  const ledgerShippedPaths = new Set(ledgerShippedRequired.map((surface) => surface.path));
  // The same fact for a surface this rebuild cut AGAIN (it carries code, but
  // re-lists the already-zoomed lines as `remaining`, and the pack reads
  // `needs-followup`): every cut required surface whose whole range the
  // ledger shows shipped needs no follow-up.
  const cutRequired = surfaces.filter((surface) => surface.required !== false
    && (surface.content_completeness === "partial" || (surface.remaining_ranges?.length ?? 0) > 0));
  const cutRequiredAllShipped = profile === "answer" && workspace !== undefined && cutRequired.length > 0
    && cutRequired.every((surface) => surfaceRangeShipped(workspace, surface.path, surface.range));
  const obligations: TaskReadinessObligation[] = [];
  const focusedAnswerEvidence = profile === "answer"
    && (result.answer_resolution !== undefined || hasExactNamedAnswerFacetEvidence(result, query));
  const provedArtifactCreate = profile === "artifact_build"
    && result.create_target !== undefined
    && hasRequiredArtifactSections(result, query);
  // W3 (turn-economy wave 2): a resolved create_target on a NON-artifact pack is
  // itself the proved frontier — the new file's path came from the caller's
  // explicit request and its parent directory exists, so nothing more needs to
  // be discovered before creating it (any served surfaces are templates, not
  // required edit content). Without this, a create-intent pack's related-context
  // surfaces are judged "codeless/uncovered", the contract falls to
  // needs-followup, and reconcileTaskPackExecutionContract demotes the create
  // route back to "go search for the file that doesn't exist yet". Scoped to
  // non-artifact profiles so artifact_build keeps its stricter section proof.
  const provedCreate = profile !== "artifact_build" && result.create_target !== undefined;
  // A1 (2026-07-30): a pack whose action-bearing evidence IS artifact content —
  // no code surface was identified at all, nothing required is missing, and every
  // caller-named artifact carries a MEANINGFUL inlined section — has proved
  // surface-content. Same principle as provedArtifactCreate above (extracted
  // artifact sections are content-bearing proof even though they are not code),
  // generalized to the read-only audit shape that has no create target. Without
  // it the T14 two-deck audit certified `awaiting-input` / "request user input"
  // while holding both decks' text, which is strictly worse than the round trip
  // inlining saves. Gated on `surfaces.length === 0` so it can never mask a
  // codeless CODE surface — the case this obligation exists to catch.
  const provedArtifactContent = surfaces.length === 0
    && result.missing.length === 0
    && (result.artifact_sections?.length ?? 0) > 0
    && hasRequiredArtifactSections(result, query);
  // 2026-07-16a: optional enrichment surfaces (required:false — e.g. the C/C++
  // header-source pair sibling, why="header-source-pair") must not veto
  // readiness: a codeless OPTIONAL surface forced risk=1 on every C++ pack.
  // `result.missing` stays unfiltered — it is required-role-scoped by
  // construction (coverage_reason "missing-roles" docs).
  const literalSourceAbsent = result.literal_source_absence;
  // R-D2: a REBUILD whose own fresh discovery names no candidate surface at
  // all (`surfaces.length === 0`) stamps a bare default "missing required
  // role" list (e.g. `["contract","api"]`, set upstream of this function,
  // before any readiness obligation runs) that reflects having found NOTHING
  // on THIS call, not a genuine per-role gap — the same upstream pass clears
  // that SAME list wholesale, irrespective of role, the moment this call
  // finds any candidate of its own (measured: a served `role:"unknown"`
  // surface clears a `missing:["contract","api"]` list with no role string
  // in common). When this epoch's carried-forward evidence already proves
  // content exists (`servedWithCarried` beyond nothing), that "found
  // nothing" signal is stale, not a real gap. Scoped to the
  // `surfaces.length === 0` REBUILD shape specifically: a call that DID pick
  // candidate surfaces of its own but still leaves a role genuinely
  // uncovered keeps today's stricter behavior (this stays false for it).
  const carriedContentDischargesMissingRoles =
    surfaces.length === 0
    && servedWithCarried.length > 0
    && !result.missing.every((entry) => entry.startsWith("explicit-gap:"));
  const contentComplete = literalSourceAbsent !== undefined || provedArtifactCreate || provedCreate || provedArtifactContent || (
    (servedWithCarried.length > 0 || ledgerShippedRequired.length > 0)
    && (result.missing.every((entry) => entry.startsWith("explicit-gap:")) || carriedContentDischargesMissingRoles)
    // R-D2: a required surface this call did not itself serve still counts
    // when this epoch's carried-forward evidence (`servedWithCarried`, see
    // its doc comment above) already covers its exact path. A path absent
    // from both never passes, so a generic/inferred task with no carried
    // entries (`servedWithCarriedPaths` reduces to `served`'s own paths)
    // keeps today's behavior exactly.
    && surfaces.filter((surface) => surface.required !== false)
      .every((surface) => servedWithCarriedPaths.has(surface.path) || ledgerShippedPaths.has(surface.path))
    && (result.content_sufficiency !== "needs-followup" || focusedAnswerEvidence || ledgerShippedRequired.length > 0 || cutRequiredAllShipped)
  );
  if (carriedContentDischargesMissingRoles && contentComplete) {
    // R-D2 — `buildReadinessObligations`'s own "surface-content" obligation is
    // now proved from carried evidence, but `result.missing` /
    // `result.coverage` were stamped by the EARLIER, non-epoch-aware
    // surface-selection pass (see the comment above), and
    // `projectCompletion` (canonicalDecision.ts) only ever DEMOTES or
    // PRESERVES `result.coverage` from here — it never promotes it on its
    // own. Left alone, every obligation certifies "proved" while
    // `result.coverage` stays "partial"/"missing-roles" from that now-stale
    // verdict, and the overall decision never reaches `act.answer`. This
    // mirrors `refreshAfterRecursiveClosure`'s existing (same-CALL) role
    // clearing + coverage promotion exactly, generalized to same-EPOCH
    // (carried) evidence. Bare role-name entries only: an `explicit-gap:`/
    // `unresolved-ledger:`-prefixed entry is a disclosed, user-facing fact
    // and is never touched here.
    result.missing = result.missing.filter(
      (entry) => entry.startsWith("explicit-gap:") || entry.startsWith("unresolved-ledger:"),
    );
    if (
      result.missing.length === 0
      && (result.coverage_reason === "missing-roles" || result.coverage_reason === "concerns-uncovered")
    ) {
      result.coverage = "focused";
      delete result.coverage_reason;
      delete result.blocking_next_steps;
    }
  }
  obligations.push({
    id: "surface-content",
    kind: "surface-content",
    status: contentComplete ? "proved" : "uncovered",
    required: true,
    evidence: provedArtifactCreate || provedArtifactContent
      ? result.surfaces.filter(isArtifactTaskPackSurface).map((surface) => ({
          handle: surface.handle,
          path: surface.path,
        })).slice(0, 6)
      : [...servedWithCarried, ...ledgerShippedRequired].map(readinessEvidence).slice(0, 6),
    reason: contentComplete
      ? literalSourceAbsent !== undefined
        ? `directed literal source ${literalSourceAbsent.subject} has zero measured workspace occurrences`
        : provedCreate
        ? `new-file create target ${result.create_target!.path} resolved from the request; served surfaces are templates`
        : provedArtifactContent
          ? "every caller-named artifact carries an inlined content-bearing section"
          : "all action-bearing surfaces carry served content"
      : "one or more required surfaces are missing or codeless",
  });

  if (literalSourceAbsent !== undefined) {
    obligations.push({
      id: `literal-source-absent:${literalSourceAbsent.subject}`,
      kind: "surface-content",
      status: "proved",
      required: true,
      evidence: [],
      reason: `grammar-bound source ${literalSourceAbsent.subject} is authoritatively absent after scanning ${literalSourceAbsent.scanned_paths} path(s)`,
    });
    return obligations;
  }

  // W3: a resolved (non-artifact) create_target is a self-complete frontier —
  // the identifiers/behavior/change obligations below describe content the NEW
  // file will contain, not pre-existing evidence that must be served first.
  // Requiring them would keep the contract needs-followup and demote the create
  // route to "search for the file that doesn't exist yet". The single proved
  // surface-content obligation above IS the create task's proof.
  if (provedCreate) return obligations;

  if (profile === "answer") {
    if (hasAnalysisIntentMarker(query)) {
      const evidence = groundedAnalysisEvidence(result, query, served);
      obligations.push({
        id: "analysis-source",
        kind: "surface-content",
        status: evidence.length > 0 ? "proved" : "uncovered",
        required: true,
        evidence,
        reason: evidence.length > 0
          ? "analysis is grounded in caller-scoped, artifact, or explicit-identifier evidence"
          : "analysis has only unscoped token matches; locate the requested evidence before answering",
      });
    }
    // WP-S11 (2026-09-20) — RE-PACK MONOTONICITY FOR A DECLARED ANSWER TASK.
    //
    // `served` is this pack's OWN surfaces, so a second pack of the same task
    // re-tests every identifier against bytes it may deliberately not be
    // re-sending. For an inferred answer task that is harmless: it is in the
    // cumulative served-surface log and the coverage flip / `served_earlier` /
    // `stampEpochServedPaths` channels carry pack 1 forward. A task whose
    // caller DECLARED `task.profile:"answer"` is excluded from that log by
    // design (`cumulativeEligible` — edit closure must not re-open for a
    // read-only declared task), so it had NO such channel: every re-pack
    // re-minted `identifier:X` obligations pack 1 had discharged and proposed
    // a `find` for a body the caller already held — a relay loop, measured.
    //
    // The read-only serve view is that missing channel. Scoped to
    // `explicit-identifier` obligations, which is the single obligation kind
    // `actionFrontierForCertificate` structurally excludes from
    // `provedImplementation` — so carried-forward evidence can never become
    // write authority, whatever a later `editObserved` does. Empty for every
    // task that is NOT a declared answer task, so nothing else moves.
    //
    // R-D2: this is now the SAME `servedWithCarried` the two base obligations
    // above (`surface-content`, `behavior-body`) read — one carried-evidence
    // computation per pack build, not three (see its own doc comment at this
    // function's top).
    const identifierServed = servedWithCarried;
    // P2-12b: the SAME fact `materializeExplicitAnswerAnchorEvidence` will
    // act on moments after this contract is built — see
    // `previewAnchoredIdentifiers`'s own doc comment for why this is safe to
    // compute here rather than moving that pass earlier.
    const anchorPreview = workspace !== undefined
      ? previewAnchoredIdentifiers(result.surfaces, query, workspace, new FileReadCache())
      : undefined;
    // WP-O (eval-0929 §8): a subject declared in several files is proved only
    // by the declaration the question means (or, when ambiguous, by every
    // declaration — disclosed); a call site or mention never proves it. See
    // `sameNameIdentifierObligation`.
    const sameNameSubjects = sameNameSubjectsFor(result);
    const memberOnly = memberOnlyExplicitIdentifiers(query);
    for (const identifier of explicitCodeIdentifiers(query).slice(0, 6)) {
      const sameNameSubject = sameNameSubjects.get(identifier);
      if (sameNameSubject !== undefined) {
        obligations.push(sameNameIdentifierObligation(sameNameSubject, identifierServed));
        continue;
      }
      // 2026-10-29 (first-hop field report): an identifier or dotted member the
      // request names AND the workspace defines (`res.redirect`, `MODEL_PRICES`,
      // `computeTotal`) is proved only by a served row that shows its DECLARATION —
      // a call site, a mention or a neighbouring symbol of the same file proves
      // nothing about what the name is. A name the workspace does not define keeps
      // the rules below.
      const anchorDefinitions = workspace !== undefined
        ? anchorDefinitionsFor(packAnchorIO(workspace, undefined), query, identifier)
        : [];
      if (anchorDefinitions.length > 0) {
        const definitionRows = identifierServed.filter((surface) =>
          anchorDefinitions.some((definition) => surface.path === definition.path && surfaceServesLine(surface, definition.startLine)));
        obligations.push({
          id: `identifier:${identifier}`,
          kind: "explicit-identifier",
          status: definitionRows.length > 0 ? "proved" : "uncovered",
          required: true,
          evidence: definitionRows.map(readinessEvidence),
          reason: definitionRows.length > 0
            ? `explicit identifier ${identifier} is proved by a served row showing its declaration`
            : `explicit identifier ${identifier} is declared at ${anchorDefinitions.map((definition) => `${definition.path}:${definition.startLine}-${definition.endLine}`).join(", ")}, which no served row shows`,
        });
        continue;
      }
      const exactEvidence = exactIdentifierEvidence(identifierServed, identifier);
      const semanticEvidence = result.answer_resolution
        && normIdent(result.answer_resolution.requested_identifier) === normIdent(identifier)
        ? identifierServed
            .filter((surface) => surface.handle === result.answer_resolution!.resolved_handle)
            .map(readinessEvidence)
        : [];
      const anchorEvidence = anchorPreview?.get(identifier);
      const evidence = exactEvidence.length > 0
        ? exactEvidence
        : semanticEvidence.length > 0
          ? semanticEvidence
          : anchorEvidence !== undefined ? [anchorEvidence] : [];
      // WP-S5 (TL_IDENTIFIER_GROUNDING, default OFF): an UNPROVED obligation
      // for a bare camelCase/PascalCase word the workspace defines nowhere is
      // dropped rather than minted — its only recovery would be a `find` this
      // server can already predict closes nothing (see the "identifier
      // grounding" doc block near `workspaceDefinesIdentifier`). Read after
      // `evidence`/verified-absence precisely so it can never remove a PROVED
      // claim from the certificate: what is proved stays on the record, and
      // only the blocking, self-defeating case is withheld.
      if (
        evidence.length === 0
        && !verifiedAbsentIdentifiersFor(result).includes(identifier)
        && (
          (identifierGroundingEnabled() && identifierIsUngrounded(result, workspace, query, identifier))
          // A member named only through access syntax (`Uploader.Retry`) that
          // the workspace defines nowhere is the caller's guess, not a code
          // identity to search for: the owner's facet gap discloses it, as it
          // did before member names became explicit (ir1010gc).
          || (memberOnly.has(normIdent(identifier)) && memberReferenceIsUndefined(result, workspace, identifier))
        )
      ) continue;
      obligations.push({
        id: `identifier:${identifier}`,
        kind: "explicit-identifier",
        status: evidence.length > 0 || verifiedAbsentIdentifiersFor(result).includes(identifier) ? "proved" : "uncovered",
        required: true,
        evidence,
        reason: evidence.length > 0
          ? exactEvidence.length > 0
            ? `explicit identifier ${identifier} is present in served evidence`
            : semanticEvidence.length > 0
              ? `requested identifier ${identifier} resolves to the served multi-facet responsibility owner`
              : `explicit identifier ${identifier} is proved by its own answer-explicit-identifier-anchor row of this same response`
          : verifiedAbsentIdentifiersFor(result).includes(identifier)
            ? `explicit identifier ${identifier} has zero literal occurrences in the workspace (verified absent — answer from that fact or correct the name)`
            : `explicit identifier ${identifier} has no served evidence`,
      });
    }
    // 2026-11 (external A/B of v0.16.4): the asked-path plan this query's hook
    // recorded (askedPathClosure.ts) — the self-method bodies the asked path
    // needs and the quoted literals proved absent from source. Read once here
    // for the behavior-body facet check and the `asked-path:<method>`
    // obligations below.
    const askedPathPlan = currentAskedPathPlan(workspace, query);
    const sourceAbsentFacets = new Set((askedPathPlan?.literalAbsences ?? []).map((absence) => absence.term.toLowerCase()));
    if (BEHAVIOR_QUERY_RE.test(query)) {
      // R-D2: `servedWithCarried`, not `served` — see this function's own
      // top-of-body doc comment. Without this, `behavior-body` was the one
      // BASE obligation with no epoch memory at all: a bare-qref/task.handle
      // REBUILD of a declared-answer task re-tested every callable-body facet
      // against only its own fresh (often sparse) surfaces, even when an
      // earlier call of the same task had already served the exact callable
      // body under the identical sha.
      const callable = servedWithCarried.filter(hasCallableBody);
      const facets = requiredQueryFacets(query);
      // A facet is a whole token (`surfaceContainsFacet`), and a quoted literal
      // the hook proved absent from every source file is answered by that
      // disclosed fact (`request_item_absences`), not owed as evidence.
      const missingFacets = facets.filter((facet) =>
        !sourceAbsentFacets.has(facet.toLowerCase())
        && !callable.some((surface) => surfaceContainsFacet(surface, facet)));
      // WP-O: a same-name subject's call sites are callable bodies too — but
      // not ITS body. The behavior is covered only once the declaration the
      // question means is served.
      const sameNameUnserved = [...sameNameSubjectsFor(result).values()]
        .filter((subject) => unservedSameNameDeclarations(subject, servedWithCarried).length > 0)
        .map((subject) => subject.identifier);
      // R2-T1 (ruling rule 3): a declaration / signature line alone is not the
      // body — see `callableBodiesNotShown`'s section header.
      const unshownBodies = callableBodiesNotShown(callable, servedWithCarried, query, workspace, "named") ?? [];
      if (unshownBodies.length > 0) unshownCallableBodiesByResult.set(result, unshownBodies);
      else unshownCallableBodiesByResult.delete(result);
      const proved = callable.length > 0
        && missingFacets.length === 0
        && sameNameUnserved.length === 0
        && unshownBodies.length === 0;
      obligations.push({
        id: "behavior-body",
        kind: "behavior-body",
        status: proved ? "proved" : "uncovered",
        required: true,
        evidence: callable.map(readinessEvidence).slice(0, 6),
        reason: proved
          ? "callable implementation evidence covers the requested behavior"
          : missingFacets.length > 0
            ? `callable evidence is missing query facets: ${missingFacets.join(",")}`
            : sameNameUnserved.length > 0
              ? `callable evidence does not include the declaration of ${sameNameUnserved.join(",")} the question asks about`
              : unshownBodies.length > 0
                ? `callable evidence shows the declaration of ${unshownBodies.map((declaration) => `${declaration.name} (${declaration.path}:${declaration.line})`).join(", ")} but no line of its body`
                : "behavioral question has no callable implementation body",
      });
    }
    // 2026-11 (external A/B of v0.16.4, flask `url_for`/`BuildError`): one
    // obligation per self-method body the asked path calls — proved only once a
    // served body of THIS task covers the method's own lines (a base-class
    // method in another module included), never by the call line that names
    // it. `kind:"behavior-body"` is the existing wire vocabulary for "the
    // implementation the question's behaviour runs through"; the id prefix
    // keeps each method addressable, so an unproved one reaches the wire by
    // name and `nextCallForUnresolved` asks for exactly its range.
    for (const window of askedPathPlan?.windows ?? []) {
      const range = `${window.start}-${window.end}`;
      const covering = servedWithCarried.filter((surface) => surface.path === window.path && surfaceBodyCoversRange(surface, range));
      const where = window.resolution === "same-class" ? "its own class" : `base class ${window.resolution.slice("base:".length)}`;
      obligations.push({
        id: `${ASKED_PATH_OBLIGATION_PREFIX}${window.name}`,
        kind: "behavior-body",
        status: covering.length > 0 ? "proved" : "uncovered",
        required: true,
        evidence: covering.map(readinessEvidence).slice(0, 2),
        reason: covering.length > 0
          ? `${window.name} (${where}, ${window.path}:${range}), called by ${window.focal} on the ${window.term} path, is served`
          : `${window.focal} calls ${window.name} on the ${window.term} path; its body (${where}, ${window.path}:${range}) is not served`,
      });
    }
    // F-V13-6: one obligation per enumerated item, minted independently of the
    // behavior-body branch above so a checklist with no behavior wording is
    // still represented. `kind:"concern"` is the existing wire vocabulary for
    // "a requirement the query raised that needs its own served evidence"; the
    // id prefix keeps the items individually addressable, which is what puts
    // each unproved one on the wire by NAME (falsification.unresolved and the
    // capability gap's obligation_ids).
    //
    // BODY-SCOPED PROOF (surfaceBodyContainsToken, not surfaceContainsToken):
    // this obligation exists because a served RANGE was treated as evidence for
    // a question it never covered, so proving it from the file PATH would
    // recreate the same vacuity one level down — the exact reason
    // surfaceBodyContainsToken was split out for proof obligations in the first
    // place.
    const enumeratedItems = enumeratedQueryItemsForEpoch(query, workspace);
    const enumeratedFacets = enumeratedItems.map((item) => item.facet);
    const literalSurfaceDuty = isLiteralFirstSurfaceDuty(query);
    if (enumeratedItems.length > 0) {
      // DISCHARGE BY NAMED AUTHORITY — the line between "no evidence for what
      // was asked" and "proof of a negative".
      //
      // When the request NAMES an implementation and the pack served that
      // body in full, an item the body does not mention is already answered by
      // the served bytes ("it never returns choose-candidate"). Requiring a
      // literal occurrence there would demand the server prove a negative and
      // would reopen discovery on a complete, correctly-targeted pack —
      // observed against replayCorpus's `buildTaskExecutionContract returns
      // answer-ready, edit-ready, choose-candidate, or needs-followup` entry,
      // where two of the four states genuinely do not exist in the function.
      // The defect this obligation exists for has no such anchor: nothing the
      // request enumerated appears anywhere in the served bytes, and no
      // identifier it named was served whole.
      const queryIdentifiers = explicitCodeIdentifiers(query);
      const namedAuthorityProofs = namedAuthorityFacetProofs(served, queryIdentifiers, enumeratedFacets, workspace);
      // I-7 (2026-08-30 forensics attribution wave): the span of `obligations`
      // this block is about to mint, so the trace emission below can report on
      // exactly those entries without touching the loop that mints them.
      const enumeratedObligationsStart = obligations.length;
      for (const item of enumeratedItems) {
        // WP-S5 (A): a plain natural-language list item is a ranking hint, not
        // a blocking obligation — nothing this server can call would close it.
        if (identifierGroundingEnabled() && !enumeratedItemCarriesCodeShape(query, item)) continue;
        const facet = item.facet;
        const evidenceSurfaces = literalSurfaceDuty
          ? literalSurfaceDutyEvidence(served, facet)
          : served.filter((surface) => surfaceBodyContainsToken(surface, facet));
        const evidence = evidenceSurfaces.map(readinessEvidence);
        // RV-10 surface duties are observational, not blocking. A proved
        // lexical anchor can join the readiness certificate; an unserved
        // named surface remains visible in trace/change_contract but does not
        // become a false "must discover" obligation.
        if (literalSurfaceDuty && evidence.length === 0) continue;
        const authoritativeAbsent = !literalSurfaceDuty
          && namedAuthorityProofs.get(facet) === "authoritative-absent";
        obligations.push({
          id: item.id,
          kind: "concern",
          status: evidence.length > 0 || authoritativeAbsent ? "proved" : "uncovered",
          required: true,
          evidence: evidence.slice(0, 3),
          reason: evidence.length > 0
            ? literalSurfaceDuty
              ? `literal-first surface duty ${facet} has a served lexical anchor`
              : `enumerated item ${facet} is present in served evidence`
            : authoritativeAbsent
              ? `enumerated item ${facet} is authoritatively absent from the fully served implementation the request named`
              : `enumerated item ${facet} was named by the request but has no served evidence`,
        });
      }
      // I-7: observe the minting itself (facet count / unproved count / the
      // named-authority discharge route), not the eventual act/gap decision --
      // T03 forensics needed exactly this and had to hand-reconstruct it from
      // raw transcripts (bench/workflows/experiments/2026-08-30-v0131-forensics/
      // REPORT.md's I-1 section). Dedup to one emission per pack via
      // enumeratedObligationSummaryCountedResults — see its own doc comment.
      // `workspace` is omitted by readiness specs that build synthetic
      // results with no real filesystem, which this silently skips (never
      // throws) rather than trace against a workspace that doesn't exist.
      //
      // PRIVACY: facets are QUERY-DERIVED tokens the caller typed, unlike the
      // workspace-relative PATHS several existing events already emit
      // (edit_hunk_frontier's `path`, repeated_range's `path`,
      // post_edit_readback's `path`) — no existing trace event emits a raw
      // query substring (grepped: only `query_chars`/length and `task_ref`/
      // hash exist), so this follows that precedent rather than the path one:
      // a short content hash (reusing shaOfText, the same primitive
      // handle-content-addressing already uses) plus the char length, never
      // the literal word.
      if (
        isTraceEnabled()
        && workspace !== undefined
        && !enumeratedObligationSummaryCountedResults.has(result)
      ) {
        enumeratedObligationSummaryCountedResults.add(result);
        const minted = obligations.slice(enumeratedObligationsStart);
        trace(
          "enumerated_obligation_summary",
          {
            facet_count: enumeratedFacets.length,
            unproved_count: minted.filter((obligation) => obligation.status === "uncovered").length,
            named_authority_discharge: [...namedAuthorityProofs.values()]
              .some((proof) => proof === "authoritative-absent"),
            facets: enumeratedFacets.map((facet) => ({
              hash: shaOfText(facet).slice(7, 15),
              chars: facet.length,
            })),
          },
          workspace,
        );
      }
    }
  }

  // A quantifier names an open universe, not a single identifier fact.  A-5
  // expands it into concrete direct dependencies; until then it is deliberately
  // undischargeable so an exact-location answer cannot falsely close it.
  if (hasOpenUniverseIntent(query) && !isAdditiveEnumIntent(query) && !csvLookupClosedUniverse(workspace)) {
    const kind = /enum|列挙/.test(query) ? "enum-variants"
      : /callers|呼び出し元/.test(query) ? "all-callers"
      : /references|参照/.test(query) ? "all-references"
      : "dependency-definitions";
    obligations.push({
      id: `open-universe:${kind}`,
      kind: "surface-content",
      status: openUniverseDischarged ? "proved" : "uncovered",
      required: true,
      evidence: [],
      reason: openUniverseDischarged
        ? `${kind} was discharged by an explicit evidence-expansion capability gap`
        : `${kind} is an exhaustive open-universe requirement awaiting evidence expansion`,
    });
  }

  if (profile === "change_propagation" || profile === "generic") {
    for (const obligation of result.change_contract?.obligations.filter((item) => item.required) ?? []) {
      const evidence = obligation.handle
        ? served.filter((surface) => surface.handle === obligation.handle).map(readinessEvidence)
        : [];
      const proved = obligation.status === "ready" && evidence.length > 0;
      obligations.push({
        id: `change:${obligation.id}`,
        kind: "change-obligation",
        status: proved ? "proved" : "uncovered",
        required: true,
        evidence,
        reason: proved ? (obligation.reason ?? `change obligation ${obligation.id} is ready`) : `change obligation ${obligation.id} lacks edit-grade evidence`,
      });
    }
  }

  if (profile === "multi_concern") {
    const concerns = result.concerns ?? [];
    const uniqueFrontiers = new Set(concerns.map((concern) => [...concern.handles].sort().join(",")));
    for (const concern of concerns) {
      const evidence = served.filter((surface) => concern.handles.includes(surface.handle)).map(readinessEvidence);
      const independent = concerns.length <= 1 || uniqueFrontiers.size > 1;
      const proved = concern.status === "covered" && evidence.length > 0 && independent;
      obligations.push({
        id: `concern:${concern.id}`,
        kind: "concern",
        status: proved ? "proved" : "uncovered",
        required: true,
        evidence,
        reason: proved
          ? "concern has served, handle-backed evidence"
          : independent
            ? "concern lacks served evidence"
            : "multiple concerns share one indistinguishable evidence frontier",
      });
    }
  }

  if (profile === "artifact_build") {
    const artifactEvidence = result.surfaces
      .filter(isArtifactTaskPackSurface)
      .map((surface) => ({ handle: surface.handle, path: surface.path }));
    const requiredArtifactSections = hasRequiredArtifactSections(result, query);
    obligations.push({
      id: "artifact-input",
      kind: "artifact-source",
      status: requiredArtifactSections && artifactEvidence.length > 0 ? "proved" : "uncovered",
      required: true,
      evidence: artifactEvidence,
      reason: requiredArtifactSections && artifactEvidence.length > 0
        ? "all requested artifact sections and source handles are bundled"
        : "one or more requested artifact source sections are not bundled",
    });
    const explicitTargetTokens = moduleShapedQueryTokens(query).map((token) => normIdent(token));
    const implementation = served.filter((surface) =>
      isImplementationPath(surface.path)
      && (
        /query-/.test(surface.why ?? "")
        || hasCallableBody(surface)
        || explicitTargetTokens.some((token) =>
          normIdent(path.basename(surface.path, path.extname(surface.path))) === token
        )
      )
    );
    const createEvidence = result.create_target
      ? artifactEvidence.filter((evidence) => bundledArtifactPaths(result).includes(evidence.path)).slice(0, 4)
      : [];
    obligations.push({
      id: "artifact-implementation",
      kind: "artifact-source",
      status: implementation.length > 0 || createEvidence.length > 0 ? "proved" : "uncovered",
      required: true,
      evidence: implementation.length > 0
        ? implementation.map(readinessEvidence).slice(0, 4)
        : createEvidence,
      reason: implementation.length > 0
        ? "query-grounded implementation target is bundled with the artifact"
        : createEvidence.length > 0
          ? `new-file frontier ${result.create_target!.path} is proved by a unique existing package directory`
        : "artifact is present but its implementation target is not proved",
    });
  }

  if (profile === "wiring") {
    const connection = result.wiring?.connections[0];
    const evidenceGraph = result.wiring?.evidence_graph;
    const sourceToken = connection?.source?.token;
    const destinationToken = connection?.destination?.token;
    const sourceImpl = served.filter((surface) => {
      if (surface.handle !== connection?.source?.handle || !isImplementationPath(surface.path)) return false;
      const token = sourceToken ?? "";
      return implementsCallableToken(servedSurfaceText(surface), token);
    });
    const consumerImpl = served.filter((surface) =>
      surface.handle === connection?.destination?.handle
      && isImplementationPath(surface.path)
      && definedCallableNames(servedSurfaceText(surface))
        .some((name) => normIdent(name) === normIdent(destinationToken ?? ""))
    );
    const insertionImpl = served.filter((surface) =>
      surface.handle === connection?.insertion_handle
      && isImplementationPath(surface.path)
      && hasCallableBody(surface)
      && connection?.evidence?.includes("callable-insertion-site") === true
    );
    const sourceNodeIds = new Set(evidenceGraph?.nodes
      .filter((node) => node.handle === connection?.source?.handle)
      .map((node) => node.id) ?? []);
    const consumerNodeIds = new Set(evidenceGraph?.nodes
      .filter((node) => node.handle === connection?.destination?.handle)
      .map((node) => node.id) ?? []);
    const insertionNodeIds = new Set(evidenceGraph?.nodes
      .filter((node) =>
        node.handle === connection?.insertion_handle
        && (node.roles.includes("insertion") || node.roles.includes("consumer"))
      )
      .map((node) => node.id) ?? []);
    const sourceDefineIds = evidenceGraph?.relations
      .filter((relation) => relation.kind === "defines" && sourceNodeIds.has(relation.to))
      .map((relation) => relation.id) ?? [];
    const consumerDefineIds = evidenceGraph?.relations
      .filter((relation) => relation.kind === "defines" && consumerNodeIds.has(relation.to))
      .map((relation) => relation.id) ?? [];
    const insertionDefineIds = evidenceGraph?.relations
      .filter((relation) => relation.kind === "defines" && insertionNodeIds.has(relation.to))
      .map((relation) => relation.id) ?? [];
    const adapterNodeIds = new Set(evidenceGraph?.nodes
      .filter((node) => node.roles.includes("adapter"))
      .map((node) => node.id) ?? []);
    const consumerAdapterRelationIds = evidenceGraph?.relations
      .filter((relation) =>
        (relation.kind === "imports" || relation.kind === "direct_calls")
        && consumerNodeIds.has(relation.from)
        && adapterNodeIds.has(relation.to)
      )
      .map((relation) => relation.id) ?? [];
    const consumerSourceRelationIds = evidenceGraph?.relations
      .filter((relation) =>
        (relation.kind === "imports" || relation.kind === "direct_calls")
        && consumerNodeIds.has(relation.from)
        && sourceNodeIds.has(relation.to)
      )
      .map((relation) => relation.id) ?? [];
    const insertionConsumerRelationIds = evidenceGraph?.relations
      .filter((relation) =>
        relation.kind === "direct_calls"
        && insertionNodeIds.has(relation.from)
        && consumerNodeIds.has(relation.to)
      )
      .map((relation) => relation.id) ?? [];
    const linkRelationIds = [...new Set([
      ...consumerAdapterRelationIds,
      ...consumerSourceRelationIds,
      ...insertionConsumerRelationIds,
    ])];
    const directCallIds = evidenceGraph?.relations
      .filter((relation) =>
        relation.kind === "direct_calls"
        && (
          (consumerNodeIds.has(relation.from)
            && (adapterNodeIds.has(relation.to) || sourceNodeIds.has(relation.to)))
          || (insertionNodeIds.has(relation.from) && consumerNodeIds.has(relation.to))
        )
      )
      .map((relation) => relation.id) ?? [];
    const relationBacked = evidenceGraph !== undefined;
    // D2: an endpoint the wiring profile resolved out of the EPOCH LEDGER has
    // no surface in this pack by construction (that is the point — the caller
    // already holds those bytes), so the served-surface filters above are
    // empty for it and the obligation would read `uncovered` for evidence the
    // caller has. Re-prove it the same way `epochServedWiringEndpoint` did:
    // the ledger entry is fingerprint-revalidated, and the file must still
    // DEFINE the endpoint token. Evidence is the bodyless handle+path pair,
    // which is exactly what the endpoint itself carries.
    const epochProvedEndpoint = (
      endpoint: { handle?: string; path?: string; token?: string } | undefined,
    ): TaskReadinessEvidence[] => {
      if (workspace === undefined || endpoint?.path === undefined || endpoint.token === undefined) return [];
      if (endpoint.handle === undefined) return [];
      const handle = endpoint.handle;
      if (!isImplementationPath(endpoint.path)) return [];
      const epochTokens = tokenizeForEpoch(query);
      if (epochTokens.length === 0) return [];
      const entry = queryServedSurfaces(workspace, workspace, { epochTokens })
        .find((candidate) => candidate.path === endpoint.path && candidate.handle === endpoint.handle);
      if (entry === undefined) return [];
      const content = readCached(workspace, endpoint.path, undefined);
      if (content === undefined || !implementsCallableToken(content, endpoint.token)) return [];
      return [{ handle, path: endpoint.path }];
    };
    const sourceEpochEvidence = sourceImpl.length > 0 ? [] : epochProvedEndpoint(connection?.source);
    const consumerEpochEvidence = consumerImpl.length > 0 ? [] : epochProvedEndpoint(connection?.destination);
    const sourceProved = sourceImpl.length > 0
      ? (!relationBacked || sourceDefineIds.length > 0)
      : sourceEpochEvidence.length > 0;
    const consumerProved = consumerImpl.length > 0
      ? (!relationBacked || consumerDefineIds.length > 0)
      : consumerEpochEvidence.length > 0;
    const semanticInsertion = result.wiring?.strategy === "semantic-multihop";
    // D3': the profile disclosed that this insertion site was chosen because it
    // is the callable in the module family the query named. The call the task
    // asks for does not exist yet BY CONSTRUCTION, so a `direct_calls` edge is
    // not available as insertion proof and cannot be required — what IS proved
    // is the served, definition-backed callable at which the edit lands.
    const domainInsertion = connection?.evidence?.includes("domain-insertion-site") === true;
    const insertionProved = insertionImpl.length > 0
      && (directCallIds.length > 0 || domainInsertion)
      && (!semanticInsertion || (insertionDefineIds.length > 0 && insertionConsumerRelationIds.length > 0));
    obligations.push({
      id: "wiring-source",
      kind: "wiring-source",
      status: sourceProved ? "proved" : "uncovered",
      required: true,
      evidence: sourceImpl.length > 0
        ? sourceImpl.map(readinessEvidence).slice(0, 4)
        : sourceEpochEvidence,
      ...(sourceDefineIds.length > 0 ? { evidence_ids: sourceDefineIds } : {}),
      reason: sourceImpl.length > 0
        ? (sourceProved
          ? "producer implementation is served and definition-backed"
          : "producer declaration lacks an implementation body or defines edge")
        : sourceProved
          ? "producer implementation was served earlier in this task epoch; its handle is already in your context"
          : "producer declaration lacks an implementation body or defines edge",
    });
    obligations.push({
      id: "wiring-consumer",
      kind: "wiring-consumer",
      status: consumerProved ? "proved" : "uncovered",
      required: true,
      evidence: consumerImpl.length > 0
        ? consumerImpl.map(readinessEvidence).slice(0, 4)
        : consumerEpochEvidence,
      ...(consumerDefineIds.length > 0 ? { evidence_ids: consumerDefineIds } : {}),
      reason: consumerImpl.length > 0
        ? (consumerProved
          ? "consumer implementation is served and definition-backed"
          : "consumer implementation/call site or defines edge is missing")
        : consumerProved
          ? "consumer implementation was served earlier in this task epoch; its handle is already in your context"
          : "consumer implementation/call site or defines edge is missing",
    });
    if (relationBacked) {
      obligations.push({
        id: "wiring-link",
        kind: "wiring-link",
        status: (linkRelationIds.length > 0 || domainInsertion) && insertionProved ? "proved" : "uncovered",
        required: true,
        evidence: [...sourceImpl, ...insertionImpl].map(readinessEvidence).slice(0, 4),
        evidence_ids: linkRelationIds,
        reason: linkRelationIds.length > 0 && insertionProved
          ? "consumer call path reaches the producer or review-only adapter at the insertion site"
          : domainInsertion && insertionProved
            // D3': stated for what it is — the link is the EDIT, and what the
            // pack proves is where it lands. Claiming a call path here would
            // be a lie; reporting it uncovered would report the task itself as
            // missing evidence and re-open discovery on served bytes.
            ? "insertion site is the callable of the module family the query named; the producer call is the edit to make"
            : "consumer import/call relation or callable insertion proof is missing",
      });
    }
    obligations.push({
      id: "wiring-insertion",
      kind: "wiring-insertion",
      status: insertionProved ? "proved" : "uncovered",
      required: true,
      evidence: insertionImpl.map(readinessEvidence).slice(0, 4),
      ...(directCallIds.length > 0 ? { evidence_ids: directCallIds } : {}),
      reason: insertionProved
        ? semanticInsertion
          ? "callable hub insertion site is definition-backed and directly calls the executable consumer"
          : directCallIds.length > 0
            ? "callable consumer insertion site is backed by a direct producer or adapter call"
            : "callable insertion site is the module family the query named; served body is the edit target"
        : "edit-grade consumer or hub insertion call is not proved",
    });
  }

  return obligations.slice(0, 12);
}
