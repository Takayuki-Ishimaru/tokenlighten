import { withNaturalEvidence } from "../naturalQueryAdapter.js";
import {prepareNaturalQueryRoute, runNaturalQueryRoute, type NaturalRoute} from '../naturalQueryRoute.js';
import {naturalQueryForRequest, recordNaturalQueryOrigin} from '../taskContractStore.js';
import {currentSessionLane} from '../../../util/laneKey.js';
import {naturalProjectionForPack, naturalCertificateMatches, hasNaturalSpecializedCertificate} from '../naturalTaskPackIntegration.js';
import {tryServeCertifiedQueryReceipt} from './receiptRestoration2.js';
import {deriveCanonicalTaskDecision} from '../canonicalDecision.js';
// taskPackEntry — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import { ANSWER_INTENT_EN_RE } from "./coverageAndContinuation2.js";
import { DEFAULT_RESPONSE_BYTE_FLOOR } from "../../../tools/readCodeModes.js";
import { FileReadCache } from "./packBasics2.js";
import { QUERY_CANDIDATE_LIMIT } from "../queryCandidatePolicy.js";
import { activeEngineConfiguration } from "../../engines/config.js";
import { applySemanticFrontierRelationPackets } from "./semanticFrontier.js";
import { applySfContinuationBundle } from "./semanticFrontier2.js";
import { artifactPrefetchKey } from "./guideAndArtifactSurfaces.js";
import { artifactSectionPrefetch } from "./guideAndArtifactSurfaces.js";
import { asksForStructureMap } from "../structureMap.js";
import { bindTaskProfile } from "./coverageAndContinuation4.js";
import { buildQueryCandidatePack } from "../queryCandidatePolicy.js";
import { buildTaskPackCore } from "./taskPackBuilder.js";
import { compoundParsingStorage } from "./packBasics.js";
import { countLines } from "../../../util/countLines.js";
import { declarationFramedNames } from "../declarationFraming.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { hasConfirmedQueryCandidateAnchor } from "../queryCandidatePolicy.js";
import { hasRequestedMutationIntent } from "./coverageAndContinuation3.js";
import { isFacetDescriptorTerm } from "../requestFacets.js";
import { isProseAcronym } from "../concernRecovery.js";
import { jaBridgeVocabPerCallStorage } from "../../retrieval/jaBridgeWorkspaceVocab.js";
import { languageForPath } from "../../../util/languages.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { mergeUnique } from "./roleAndConcernScope.js";
import { normalizePathEntry } from "./packBasics2.js";
import { noteInheritedTaskProfile } from "./coverageAndContinuation4.js";
import { packByteCeilingStorage } from "./packBasics.js";
import { prefetchArtifactSurfaceSections } from "./guideAndArtifactSurfaces.js";
import { prepareRequestItemPrewalk } from "./requestItemAbsence.js";
import { queryCandidateSelectionRequired } from "./seedAdmission2.js";
import { queryNamedFilesWalkStorage } from "./queryIntent2.js";
import { reapplySemanticFrontierDecision } from "../canonicalDecision.js";
import { recordTaskContract } from "../taskContractStore.js";
import { requestItemPrewalkStorage } from "./requestItemAbsence2.js";
import { requiredSurfacesForTask } from "./roleAndConcernScope.js";
import { resolveCallerByteCeiling } from "../../../tools/readCodeModes.js";
import { restoreBodylessDiscoverIfConfident } from "../bodylessDiscover.js";
import { stripDelegationActorSpans } from "../requestItems.js";
import { taskContractGapProjection } from "../taskContractStore.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { trace } from "../../../util/trace.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { unreadableNamedPathStorage } from "./queryIntent3.js";
import { withEngineConfiguration } from "../../engines/config.js";

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Async entry point. Prefetches caller-named artifact extractions (A1) so the
 * synchronous pack exit can serve them as content, then builds the pack.
 */
export async function buildTaskPack(
  args: TaskPackArgs,
  workspace: string,
): Promise<TaskPackResult> {
  const configuration = activeEngineConfiguration();
  return withEngineConfiguration(configuration, () => compoundParsingStorage.run({
    enabled: configuration.compoundRequests.enabled,
    facets: new Map(), items: new Map(), plans: new Map(),
  }, () => buildTaskPackWithEngineConfiguration(args, workspace)), args.query ?? args.symbol ?? args.path ?? "");
}

export async function buildTaskPackWithEngineConfiguration(
  args: TaskPackArgs,
  workspace: string,
): Promise<TaskPackResult> {
  artifactSectionPrefetch.delete(artifactPrefetchKey(workspace));
  // T1: resolve the effective byte ceiling ONCE per call and hold it for the
  // entire async lifetime of this call (prefetch AND core) -- see
  // packByteCeilingStorage's doc comment above for why this is an ALS run()
  // rather than a plain local variable capForResult could not see anyway.
  const byteCeiling = resolveCallerByteCeiling(
    args.maxBytes,
    args.maxTokens,
    args.clientDefaultByteCeilingHint,
  );
  // DESIGN-v0.15 R1 P1 fix (2026-09-07): the tree-sitter declaration-range
  // pre-pass (prepareRequestItemPrewalk, near cachedRequestItemPass below)
  // is async and must finish before buildTaskPackCore's synchronous
  // buildTaskExecutionContract/proveRequestItem chain reads it back out via
  // requestItemPrewalkStorage.getStore() — ALS, not a bare local, for the
  // exact same reason packByteCeilingStorage just above is one (must not
  // leak across two interleaved buildTaskPack calls). The wrapped body below
  // is intentionally left at its pre-existing indentation to keep this a
  // minimal, reviewable diff.
  const requestItemPrewalk = await prepareRequestItemPrewalk(
    workspace,
    args.query ?? args.symbol ?? args.path ?? "",
  );
  // SHOULD-FIX 11 (2026-09-13, review round): scope the query-named-file
  // walk cache to this ONE call, same reasoning as the two ALS runs already
  // nested here — see queryNamedFilesWalkStorage's own doc comment.
  return queryNamedFilesWalkStorage.run(new Map(), () =>
    // BLOCKER 25 (2026-09-14, review round 4): scope the unreadable-named-path
    // ledger to this ONE call, same reasoning as the walk cache it rides with —
    // see unreadableNamedPathStorage's own doc comment.
    unreadableNamedPathStorage.run(new Map(), () =>
    requestItemPrewalkStorage.run(requestItemPrewalk, () =>
    // GATE-C2 (2026-09-22, perf wave): scope getWorkspaceJaBridgeVocabulary's
    // per-call reuse to this ONE call, same reasoning as the ALS runs already
    // nested here — see jaBridgeVocabPerCallStorage's own doc comment.
    jaBridgeVocabPerCallStorage.run(new Map(), () =>
    packByteCeilingStorage.run(byteCeiling, async () => {
    try {
      await prefetchArtifactSurfaceSections(args, workspace);
    } catch {
      // A failed prefetch must never fail the pack — it degrades to the
      // pre-A1 behavior (artifact stubs + the `extract` call).
      artifactSectionPrefetch.delete(artifactPrefetchKey(workspace));
    }
    try {
      let naturalRoute: NaturalRoute | undefined;
      let rebuildSpecializedNatural = false;
      // The task-contract ALS owns the authenticated handle. taskBinding is
      // the underlying fingerprint, which must never become a handle-store key.
      const resumeNaturalQuery = naturalQueryForRequest(workspace, args.query);
      const naturalSources = new FileReadCache();
      const prepareNatural = async (query: string) => prepareNaturalQueryRoute({
        workspace, query, profile: bindTaskProfile(args.taskProfile, query, args.writeAllowed).selected,
        taskBinding: args.taskBinding ?? '', lane: currentSessionLane(),
        readText: (relativePath) => naturalSources.read(workspace, relativePath),
      });
      if (resumeNaturalQuery !== undefined) {
        naturalRoute = await prepareNatural(resumeNaturalQuery);
        if ((naturalRoute.evidence.gaps.length > 0 || naturalRoute.targets.length === 0)
          && args.path === undefined && (args.paths?.length ?? 0) === 0) {
          // A prior specialized proof permits a fresh specialized rebuild,
          // never reuse of its old graph. All normal receipt identity/source
          // checks still apply, and forceServe below rebuilds the certificate.
          const prior = tryServeCertifiedQueryReceipt(workspace, {...args, query: resumeNaturalQuery, forceServe: false});
          rebuildSpecializedNatural = prior !== undefined && hasNaturalSpecializedCertificate(prior);
          if (!rebuildSpecializedNatural) {
          // Repeating an unsupported query does not authorize a body-bearing
          // fallback. Explicit target reads still retain its open obligations.
          const located = await locateTaskContext(workspace, {
            action: 'locate', query: stripDelegationActorSpans(resumeNaturalQuery), limit: QUERY_CANDIDATE_LIMIT,
          });
          const gaps = taskContractGapProjection(workspace, tokenizeForEpoch(resumeNaturalQuery));
          return buildQueryCandidatePack(located,
            noteInheritedTaskProfile(bindTaskProfile(args.taskProfile, resumeNaturalQuery, args.writeAllowed), args),
            candidatePath => {
              const source = naturalSources.read(workspace, candidatePath);
              return source === undefined ? undefined : countLines(source);
            }, {required: requiredSurfacesForTask(resumeNaturalQuery, workspace, args.surfaceRoles), missing: mergeUnique(gaps.open, gaps.explicitGaps)});
          }
        }
      }
      // Evaluate original arguments before inferred paths, pending-candidate
      // replay, cache restoration, or any implementation-materializing builder.
      if (naturalRoute === undefined && queryCandidateSelectionRequired(args, workspace)) {
        // The fresh plan owns readiness; locator ranks alone grant no proof.
        const located = await locateTaskContext(workspace, {
          action: "locate", query: stripDelegationActorSpans(args.query!), limit: QUERY_CANDIDATE_LIMIT,
          ...((args.path ?? (args.paths?.length === 1 ? normalizePathEntry(args.paths[0]!).path : undefined))
            ? { path: args.path ?? normalizePathEntry(args.paths![0]!).path } : {}),
          ...(args.lang ? { lang: args.lang } : {}),
        });
        const candidateSources = new FileReadCache();
        // Typed names and explicitly framed callables remain intentional targets,
        // but syntax alone cannot turn prose ("HTTP method") into a declaration.
        // Confirm only names the request spells, within the locator's bounded files.
        const identityKey = (name: string): string => name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
        const projectNames = new Set([identityKey(path.basename(workspace))]);
        try {
          const manifest = JSON.parse(candidateSources.read(workspace, "package.json") ?? "null") as { name?: unknown } | null;
          if (typeof manifest?.name === "string") {
            projectNames.add(identityKey(manifest.name));
            projectNames.add(identityKey(manifest.name.split("/").at(-1)!));
          }
        } catch { /* An unavailable package identity never creates an anchor. */ }
        // A plain name must be the request's direct subject, not an embedded
        // prose modifier such as "How does requests choose the redirect method?".
        // Reuse the existing verb recognizers; this adds no behavior vocabulary.
        const primarySubject = /^\s*([A-Za-z]+)\s+(?:the\s+)?([A-Za-z_$][\w$]*)(?=\s+(function|method)\b|\s+so\b|[.!?]?\s*$)/iu.exec(args.query!);
        const directNames = primarySubject !== null
          && (ANSWER_INTENT_EN_RE.test(primarySubject[1]!) || hasRequestedMutationIntent(primarySubject[1]!))
          && !isFacetDescriptorTerm(primarySubject[2]!)
          && (primarySubject[3] !== undefined || !projectNames.has(identityKey(primarySubject[2]!)))
          ? [primarySubject[2]!] : [];
        const names = [...new Set([
          ...explicitCodeIdentifiers(args.query!).filter(name => !projectNames.has(identityKey(name))),
          ...directNames,
        ])].filter(name => !isProseAcronym(name));
        // A bare type name can name the surrounding project or protocol. It
        // needs a foreground subject/declaration frame, not mere existence.
        // Normalize the bounded Japanese naming copula before reusing the
        // existing declaration grammar ("X っていうデカいクラス" -> "X クラス").
        const typeSubjectQuery = args.query!.replace(/([A-Za-z_$][\w$]*)\s*(?:という|っていう)[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]{0,12}?(?=クラス(?!タ))/gu, "$1 ");
        const leadingSubject = /^\s*([A-Za-z]+)\s+(?:how\s+)?(?:the\s+)?([A-Za-z_$][\w$]*)\b/u.exec(args.query!);
        const foregroundTypes = new Set(declarationFramedNames(typeSubjectQuery));
        const overviewSubject = /\boverview\s+of\s+([A-Za-z_$][\w$]*)\b/iu.exec(args.query!);
        if (asksForStructureMap(args.query!) && overviewSubject !== null) foregroundTypes.add(overviewSubject[1]!);
        if (leadingSubject !== null
          && (ANSWER_INTENT_EN_RE.test(leadingSubject[1]!) || hasRequestedMutationIntent(leadingSubject[1]!))) {
          foregroundTypes.add(leadingSubject[2]!);
        }
        const japaneseSubject = /^\s*([A-Za-z_$][\w$]*)\s*の/u.exec(args.query!);
        if (japaneseSubject !== null) foregroundTypes.add(japaneseSubject[1]!);
        const confirmed = await hasConfirmedQueryCandidateAnchor(located, names, async candidatePath => {
          const source = candidateSources.read(workspace, candidatePath);
          const language = languageForPath(candidatePath);
          if (source === undefined || !language || source.length > 1024 * 1024) return [];
          const parsed = (await candidateSources.parsedSymbols(source, language, candidatePath)) ?? [];
          const declaredTypes = new Set(parsed
            .filter(symbol => symbol.kind === "class" || symbol.kind === "interface" || symbol.kind === "type" || symbol.kind === "enum")
            .map(symbol => unqualifiedSymbolTail(symbol.name)));
          for (const symbol of parsed) {
            const qualified = symbol.name.split("::");
            if (qualified.length > 1 && qualified.at(-1) === qualified.at(-2))
              declaredTypes.add(qualified.at(-1)!);
          }
          // A constructor shares its type's identity, so cannot bypass the type
          // check when it is out of line or the parser labels it a function.
          return parsed.map(symbol => unqualifiedSymbolTail(symbol.name))
            .filter(name => !declaredTypes.has(name) || foregroundTypes.has(name));
        });
        if (!confirmed) {
          // A location proposal cannot discharge proof, but it must retain
          // requirements already declared by this authenticated task. Record
          // only requirements; never revalidate or copy served-source proofs.
          const tokens = tokenizeForEpoch(args.query!);
          naturalRoute = await prepareNatural(args.query!);
          const required = withNaturalEvidence(naturalRoute.evidence,
            () => requiredSurfacesForTask(args.query!, workspace, args.surfaceRoles));
          recordTaskContract(workspace, tokens, { query: args.query!, requiredRoles: required });
          recordNaturalQueryOrigin(workspace, args.query!);
          if (naturalRoute.evidence.gaps.length > 0 || naturalRoute.targets.length === 0) {
          const gaps = taskContractGapProjection(workspace, tokens);
          return buildQueryCandidatePack(located,
          noteInheritedTaskProfile(bindTaskProfile(args.taskProfile, args.query!, args.writeAllowed), args),
          candidatePath => {
            const source = candidateSources.read(workspace, candidatePath);
            return source === undefined ? undefined : countLines(source);
          }, { required, missing: mergeUnique(gaps.open, gaps.explicitGaps) });
          }
        }
      }
      const runCore = async (args: TaskPackArgs): Promise<TaskPackResult> => {
      const built = await buildTaskPackCore(args, workspace);
      // FIXALL-A group D (2026-09-14): `request_names_no_target` is stamped
      // inside `buildTaskExecutionContract` — the one choke point every decision
      // path passes through BEFORE the decision is derived. Stamping it here,
      // after the core returns, was too late: the core derives and applies the
      // canonical decision itself.
      const explicitBudget = resolveCallerByteCeiling(args.maxBytes, args.maxTokens, undefined);
      if (explicitBudget !== undefined && explicitBudget < DEFAULT_RESPONSE_BYTE_FLOOR) {
        (built as unknown as Record<string, unknown>).budget_floor_applied = {
          requested: explicitBudget,
          applied: DEFAULT_RESPONSE_BYTE_FLOOR,
        };
      }
      // FX-I-A: W-SATISFACTION's state and W-DEMOTE's body withholding have
      // ALREADY run, inside the core, at `applySemanticFrontierPreBookingSeam`
      // — before the first producer that books a served byte, so the pack that
      // was booked is the pack that ships. What is left here is the part that
      // cannot be synchronous (the relation-packet port build) and the part
      // that must see the final pack (the continuation bundle's extra bodyless
      // rows, and the decision restated over them). None of the three can
      // withhold a body, so none of them can invalidate a booking.
      await applySemanticFrontierRelationPackets(args, workspace, built);
      applySfContinuationBundle(built, workspace);
      try {
        // The decision must describe the pack as it SHIPS: the continuation
        // bundle may have appended addressable bodyless rows since the
        // pre-booking seam restated it. `applyCanonicalTaskDecision`
        // re-derives rather than accumulates, and this is flag- and
        // context-gated inside, so a flag-off pack never reaches it.
        reapplySemanticFrontierDecision(built);
      } catch (err) {
        // I-1: an SF defect is a trace line, never a degraded pack.
        try {
          trace(
            "sf_pack_seam_error",
            { message: err instanceof Error ? err.message : String(err) },
            workspace,
          );
        } catch {
          /* the trace channel is best-effort too */
        }
      }
      // TL_PACK_BODYLESS_DISCOVER (2026-11-03), the late half: the early pass
      // inside the core withheld bodies while the pack was a `discover`; a
      // builder's own tail (buildAnswerTaskPack's post-certification anchor
      // pass) can have firmed the decision up since. An `act.*`/`await_input`
      // reply ships the bodies it certifies over, so they go back here, at the
      // last point every builder passes through — see
      // `restoreBodylessDiscoverIfConfident`'s doc for why the ledgers that
      // already booked the pack without them stay as they are.
      restoreBodylessDiscoverIfConfident(built, workspace);
      return built;
      };
      if (naturalRoute === undefined) return await runCore(args);
      const route = naturalRoute;
      return await runNaturalQueryRoute(args, route, async seeded => {
        if (rebuildSpecializedNatural) seeded = {...seeded, path: args.path, paths: args.paths, symbol: args.symbol, forceServe: true};
        const profile = bindTaskProfile(seeded.taskProfile, route.evidence.query, seeded.writeAllowed).selected;
        const inspect = (result: TaskPackResult) => {
          const kind = deriveCanonicalTaskDecision(result)?.kind;
          const terminal = kind === 'act-answer' || kind === 'act-edit';
          const projection = naturalProjectionForPack(result, workspace, route.evidence.query, profile);
          return {terminal, matches: naturalCertificateMatches(result, projection)};
        };
        let result = await runCore(seeded);
        let checked = inspect(result);
        // Every cache door still uses the ordinary builder on a proof miss.
        // A retry is bounded; no cached or postprocessed act bypasses this gate.
        if (!checked.matches && (checked.terminal || result.pack_unchanged === true)) {
          result = await runCore({...seeded, forceServe: true});
          checked = inspect(result);
        }
        if (checked.terminal && !checked.matches) throw new Error('natural-query terminal certificate lacks current mandatory source proof');
        return result;
      });
    } finally {
      artifactSectionPrefetch.delete(artifactPrefetchKey(workspace));
    }
  })))));
}
