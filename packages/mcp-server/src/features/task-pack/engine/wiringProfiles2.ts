// wiringProfiles — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { PackCheckRecord } from "../../../state/session.js";
import type { SemanticWiringResolution } from "../../../tools/semanticWiringResolver.js";
import type { TaskChangeObligationKind } from "@tokenlighten/types";
import type { TaskEvidenceGraph } from "@tokenlighten/types";
import type { TaskEvidenceNode } from "@tokenlighten/types";
import type { TaskEvidenceRelation } from "@tokenlighten/types";
import type { TaskEvidenceRelationKind } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskVerificationRecipe } from "@tokenlighten/types";
import type { TaskWiringEndpoint } from "@tokenlighten/types";
import type { TaskWiringProfile } from "@tokenlighten/types";
import type { VerificationManifest } from "../../../util/verificationPack.js";
import type { WiringEndpoint } from "./createAndWiringEndpoints2.js";
import { CONSTRUCT_COMPLETE_EXTRA_BUDGET } from "./packBasics.js";
import { FileReadCache } from "./packBasics2.js";
import { HUB_EDIT_HUNK_MAX_BYTES } from "./packBasics.js";
import { HUB_EDIT_HUNK_RADII } from "./packBasics.js";
import { HUB_EXCERPT_BUDGET_BYTES } from "./packBasics.js";
import { MAX_SEMANTIC_WIRING_SURFACES } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { TINY_FILE_MAX_BYTES } from "./packBasics2.js";
import { TINY_FILE_MAX_LINES } from "./packBasics2.js";
import { WIRING_COMPLETE_SURFACE_BYTES } from "./packBasics.js";
import { WIRING_COMPLETE_SURFACE_LINES } from "./packBasics.js";
import { WIRING_DEST_ROLE_RANK } from "./createAndWiringEndpoints2.js";
import { WIRING_DOMAIN_GENERIC_VOCAB } from "./wiringEvidence3.js";
import { WIRING_DOMAIN_MAX_SCORED_FILES } from "./wiringEvidence3.js";
import { WIRING_DOMAIN_MAX_SEGMENT_FILES } from "./wiringEvidence3.js";
import { WIRING_DOMAIN_MAX_SYMBOLS } from "./wiringEvidence3.js";
import { WIRING_DOMAIN_MIN_TOKEN_LEN } from "./wiringEvidence3.js";
import { asImpactSurface } from "./wiringEvidence2.js";
import { bestServedWiringConsumer } from "./wiringEvidence2.js";
import { buildVerificationManifest } from "../../../util/verificationPack.js";
import { buildWiringCooccurrenceCheck } from "./wiringEvidence.js";
import { buildWiringEvidenceGraph } from "./wiringEvidence2.js";
import { calledCallableNames } from "./wiringEvidence3.js";
import { centeredSliceForCap } from "./packBasics2.js";
import { classifySurface } from "../../../util/impact.js";
import { countLines } from "../../../util/countLines.js";
import { declaredCallableNames } from "./wiringEvidence3.js";
import { definedCallableNames } from "./wiringEvidence3.js";
import { deriveCheckId } from "../../../state/session.js";
import { effHubWholeEnabled } from "../../../util/flags.js";
import { elideDocComments } from "../../../util/formatCompress.js";
import { endpointFromSurface } from "./wiringEvidence2.js";
import { ensureWiringEndpointSurface } from "./wiringEvidence2.js";
import { epochServedWiringEndpoint } from "./wiringEvidence2.js";
import { evidenceNodeId } from "./wiringEvidence3.js";
import { evidenceRelationId } from "./wiringEvidence3.js";
import { extractSymbolsFromLines } from "../../../tools/readCodeModes.js";
import { handleTable } from "../../../util/handles.js";
import { hasCallableBody } from "./changeAndReadinessEvidence2.js";
import { hasCallableDeclarationSibling } from "./createAndWiringEndpoints2.js";
import { hasEditGradeCallArgument } from "./wiringEvidence3.js";
import { importedWiringSource } from "./wiringEvidence2.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isUnderAncestor } from "./seedResolution.js";
import { languageForPath } from "../../../util/languages.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { pathFamilyPieces } from "./wiringProfiles.js";
import { qualifiedAnchorDefinitionPathsForToken } from "./wiringEvidence2.js";
import { readCached } from "./packBasics2.js";
import { relationCodeOnly } from "./wiringEvidence3.js";
import { resolveSemanticWiring } from "../../../tools/semanticWiringResolver.js";
import { resolveWiringWorkspaceToken } from "./createAndWiringEndpoints.js";
import { roleFillScope } from "./roleAndConcernScope.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { structuralWiringDestinationRole } from "./createAndWiringEndpoints2.js";
import { structuralWiringSourceRole } from "./createAndWiringEndpoints2.js";
import { surfaceIndexForToken } from "./createAndWiringEndpoints2.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { trace } from "../../../util/trace.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { wiringCandidateTokens } from "./createAndWiringEndpoints2.js";
import { wiringConsumerToken } from "./wiringEvidence2.js";
import { workspaceCallConsumer } from "./wiringEvidence.js";
import { workspaceCallableDeclarationPaths } from "./wiringEvidence2.js";
import { workspaceCallableDefinitionPaths } from "./wiringEvidence2.js";

/**
 * E1 (2026-09-05, measured on paid smoke r9 / SF13): the DESTINATION DOMAIN a
 * query names, expressed as WORKSPACE FILES rather than as words.
 *
 * A query token is admitted only when the repository itself already spells it
 * as a path segment — a directory name, a basename stem, or a `_`/`-`-separated
 * piece of one. Nothing is hardcoded: the workspace's own naming supplies the
 * vocabulary, so this is inert for any query whose words name no module family.
 *
 * THE SINGLE VOCABULARY SEAM. Every step that asks "does this path belong to
 * the domain the query named?" — the family builder below AND the
 * already-in-domain abstention in `wiringDestinationDomainEndpoint` — resolves
 * its words HERE, so a word rejected as non-discriminating is rejected
 * everywhere a destination endpoint or insertion surface is chosen.
 */
export function wiringQueryDomainWords(query: string, walked: readonly string[]): Set<string> {
  const workspaceWide = workspaceWidePathPieces(walked);
  return new Set(
    tokenizeForEpoch(query).filter((term) =>
      term.length >= WIRING_DOMAIN_MIN_TOKEN_LEN
      && !WIRING_DOMAIN_GENERIC_VOCAB.has(term)
      && !workspaceWide.has(term)
    ),
  );
}

/**
 * D3' (2026-09-05, measured on paid smoke r10 / SF13): path pieces that EVERY
 * walked file spells — the workspace's own naming, not a module family inside
 * it.
 *
 * A "family" is only useful because it PARTITIONS the workspace: `inFamily`
 * has to be able to say some file is OUTSIDE the domain the query named. When
 * the server is rooted ABOVE the project it is reading (live r10: the solver
 * worktree held the project under `<fixtures>/<project>/<firmware>/…`, so the
 * project directory was a path piece of all 125 walked files) every ancestor
 * segment is spelled by every file. A query that merely NAMES the project then
 * admitted that segment as a family, `inFamily` became true for every path
 * including the destination already chosen, and the whole domain rule
 * short-circuited to "already in domain" — silently inert exactly where the
 * layout made it matter. The same word over a project-rooted workspace (no
 * such shared ancestor) kept working, which is why this only ever showed up
 * under a deeper root.
 *
 * R32 finding #2 (P1): rejecting ONLY the literally-universal piece (spelled
 * by every walked file) is one file-count short of the real failure mode. An
 * ordinary monorepo shape — one dominant project directory plus a single
 * shared/legacy file living just outside it — leaves the project segment at
 * (N-1)/N, never literally 100%, while it remains exactly as uninformative
 * about any PARTICULAR file as the universal case: a piece a MAJORITY of the
 * walked files share still cannot tell the files that matter apart, and
 * re-seating "into" it moves the destination toward the workspace's own
 * center of mass, not toward a real subsystem. The rule therefore generalizes
 * from "spelled by every file" to "spelled by a STRICT MAJORITY of files"
 * (strictly more than half) — 100% is always a majority, so this subsumes the
 * universal case outright, and "more than half" is the only threshold with no
 * tunable fraction to pick: below it, at least as many files lack the piece
 * as have it, so the piece still discriminates; at a bare half split it need
 * not, but a piece at EXACTLY half remains eligible to name a family — the
 * boundary is "more than half", never "half or more".
 *
 * Rejecting universal/majority pieces costs nothing anywhere else: a piece
 * that covers most or all of the walked set carries little to no information
 * about any one path, so no correct decision could ever have depended on it.
 * Applied ON TOP OF, never instead of, the length floor, the generic denylist
 * and the >=2-file multiplicity floor. Tuning-free by construction — there is
 * no coverage fraction to pick, only the structural "more than half" bound.
 */
export function workspaceWidePathPieces(walked: readonly string[]): Set<string> {
  const universal = new Set<string>();
  const fileCountByPiece = new Map<string, number>();
  let scanned = 0;
  for (const rel of walked) {
    if (scanned >= WIRING_DOMAIN_MAX_SEGMENT_FILES) break;
    scanned++;
    for (const piece of new Set(pathFamilyPieces(rel))) {
      fileCountByPiece.set(piece, (fileCountByPiece.get(piece) ?? 0) + 1);
    }
  }
  // A one-file walk has no partition to speak of; the >=2-file family floor
  // already refuses it, so claim nothing here.
  if (scanned < 2) return universal;
  // R32 finding #2: strictly more than half, not "every file" — a piece a
  // bare majority of the walk shares is exactly as uninformative about which
  // file is the destination as one every file shares. Exactly half is NOT a
  // majority and remains eligible to name a family (decide-and-document: the
  // boundary is ">", never ">=").
  for (const [piece, count] of fileCountByPiece) {
    if (count * 2 > scanned) universal.add(piece);
  }
  return universal;
}

export function wiringDestinationDomainTokens(
  query: string,
  walked: readonly string[],
): Set<string> {
  const wanted = wiringQueryDomainWords(query, walked);
  const found = new Set<string>();
  if (wanted.size === 0) return found;
  // R31 finding #2 (b): a family must be a directory segment or stem/piece
  // shared by AT LEAST TWO workspace files -- a single file can never be a
  // "family" on its own (e.g. one incidentally-named `*_test_*.cpp` file).
  const fileCountByPiece = new Map<string, number>();
  let scanned = 0;
  for (const rel of walked) {
    if (++scanned > WIRING_DOMAIN_MAX_SEGMENT_FILES) break;
    const piecesInFile = new Set(pathFamilyPieces(rel));
    for (const piece of piecesInFile) {
      if (!wanted.has(piece)) continue;
      fileCountByPiece.set(piece, (fileCountByPiece.get(piece) ?? 0) + 1);
    }
  }
  for (const [piece, count] of fileCountByPiece) {
    if (count >= 2) found.add(piece);
  }
  return found;
}

/**
 * D3': the disclosure a domain-seated destination carries in its own `why`.
 *
 * PROVENANCE, not a re-derived property. `buildTaskWiringProfile` runs more
 * than once per request (a probe pass and a final pass); by the second run the
 * re-seated destination is already this pack's retained
 * "wiring destination for …" surface, so `wiringDestinationDomainEndpoint`
 * correctly abstains — it IS in domain now — and a flag recomputed per
 * invocation reads false on exactly the profile that reaches the wire.
 *
 * Asking instead "is this destination in the named family?" would be WRONG in
 * the other direction: it would also fire for a destination the domain rule
 * never chose (a shape-chosen consumer that merely happens to sit in a family
 * the query names a property of), and grant it insertion-readiness with no
 * call edge. Measured: `semanticWiringResolver.spec.ts`'s
 * "no executable health-like producer" fixture, where `health` is a real
 * two-file path family but the query names its destination explicitly.
 *
 * So the marker rides the SURFACE the first pass created, which is the same
 * object the later pass reuses.
 */
export const DOMAIN_SEATED_WHY_NOTE = "seated inside the module family this query named";

/**
 * E1: re-seat a wiring DESTINATION that landed outside the domain the query
 * named.
 *
 * Live (paid smoke r9 / SF13): the query's destination domain was telemetry —
 * `telemetry`, `mavlink`, `dialect`, `status`, `encoder`, every one of them a
 * real segment of `firmware/{src,include}/telemetry/mavlink_dialect.*` — and the
 * pack nonetheless named `hardware_init` (later `task_estimator_entry`) in
 * `firmware/src/app/tasks_init.cpp` as "the insertion site", because the
 * destination is chosen from callable-insertion-site shape alone and no step
 * ever asked whether the callable sits in the family the caller described. The
 * telemetry encoder was never served and never entered `frontier_index`.
 *
 * Ranked with EXACTLY `bestServedWiringConsumer`'s scoring (query-term hits in
 * body ×4 + in path ×2) so one vocabulary decides both promotions. Returns
 * `endpoint` when a domain-matched callable implementation exists, or `note`
 * when the family is real but contains no eligible destination — the caller
 * then keeps its own choice and DISCLOSES that it is out-of-domain. `undefined`
 * (the overwhelmingly common case) means the query named no family, or the
 * destination already sits inside it: the wire is byte-identical.
 */
export function wiringDestinationDomainEndpoint(
  query: string,
  walked: readonly string[],
  workspace: string,
  cache: FileReadCache | undefined,
  current: WiringEndpoint,
): { endpoint?: WiringEndpoint; note?: string } | undefined {
  const familyTokens = wiringDestinationDomainTokens(query, walked);
  if (familyTokens.size === 0) return undefined;
  const inFamily = (relPath: string): boolean =>
    pathFamilyPieces(relPath).some((piece) => familyTokens.has(piece));
  if (current.path !== undefined && inFamily(current.path)) return undefined;
  // R31 finding #2 follow-up: the >=2-file multiplicity requirement above is
  // about ADMITTING a family as grounds to move the destination TO one of its
  // files -- a single incidentally-named file must never be strong enough
  // evidence for that. But the ALREADY-CHOSEN `current` destination's own
  // name matching a query word it is the only file to spell (e.g. a query
  // naming "transmitPacket" over a destination already named
  // `packet_sender.ts`) is not a re-seat candidate at all -- it is exactly
  // the caller's own choice already looking right, which one file's own name
  // is sufficient evidence for. Skipping this would re-seat a shape-correct
  // destination onto an unrelated real family (e.g. a source-side helper the
  // query also happens to mention) purely because the query's OWN vocabulary
  // for the current destination failed the multiplicity floor.
  if (
    current.path !== undefined
    && pathFamilyPieces(current.path).some((piece) => wiringQueryDomainWords(query, walked).has(piece))
  ) {
    return undefined;
  }
  const queryTerms = tokenizeForEpoch(query)
    .filter((term) => term.length >= WIRING_DOMAIN_MIN_TOKEN_LEN)
    .slice(0, 32);
  const eligible = walked
    .filter((relPath) => relPath !== current.path && isImplementationPath(relPath) && inFamily(relPath))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, WIRING_DOMAIN_MAX_SCORED_FILES);
  const familyNote = `no destination-domain match for ${[...familyTokens].sort().slice(0, 4).join(", ")}`;
  if (eligible.length === 0) return { note: familyNote };
  // R31 finding #2 (c): the family token itself must never be the ONLY
  // evidence that seats the destination inside this domain -- every eligible
  // file already contains a family piece BY CONSTRUCTION (that is what makes
  // it eligible), so scoring with the family token(s) included would let a
  // single generic word corroborate itself. A candidate is only ACCEPTED when
  // at least one further, non-family query token also hits its path or body:
  // the total score must exceed what the family token(s) alone contribute.
  const familyOnlyTerms = queryTerms.filter((term) => familyTokens.has(term));
  let best: { path: string; content: string; score: number } | undefined;
  for (const relPath of eligible) {
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    const body = normIdent(content);
    const pathText = normIdent(relPath);
    const bodyHits = queryTerms.filter((term) => body.includes(normIdent(term))).length;
    const pathHits = queryTerms.filter((term) => pathText.includes(normIdent(term))).length;
    const score = bodyHits * 4 + pathHits * 2;
    if (score <= 0) continue;
    const familyOnlyBodyHits = familyOnlyTerms.filter((term) => body.includes(normIdent(term))).length;
    const familyOnlyPathHits = familyOnlyTerms.filter((term) => pathText.includes(normIdent(term))).length;
    const familyOnlyScore = familyOnlyBodyHits * 4 + familyOnlyPathHits * 2;
    if (score <= familyOnlyScore) continue;
    if (best === undefined || score > best.score) best = { path: relPath, content, score };
  }
  if (best === undefined) return { note: familyNote };
  // The endpoint TOKEN centres the served window and names the insertion site,
  // so pick the declaration in this file the query's own terms describe best:
  // its NAME counts double and its BODY once, which is what separates two
  // same-suffixed encoders (`encodeSysStatus`, whose body carries the sensor
  // health words, from `encodeBatteryStatus`, whose body does not).
  // `definedCallableNames` is deliberately NOT used here — it caps at 12 names,
  // which on a codec file is spent entirely on its pack/unpack helpers.
  const bestLines = best.content.split(/\r?\n/);
  // Term matching is SEGMENTED, never raw substring: `tokenizeForEpoch` splits
  // camelCase, so the query term "encoder" no longer matches `encodeRcChannels`
  // by accident while "sensor" still matches the `sensors` a body spells
  // (prefix rule, the same grounding `wiringCandidateTokens` uses).
  const hitsIn = (text: string): number => {
    const tokens = new Set(tokenizeForEpoch(text));
    return queryTerms.filter((term) =>
      tokens.has(term) || [...tokens].some((candidate) => candidate.startsWith(term))
    ).length;
  };
  let token: string | undefined;
  let tokenScore = 0;
  for (const symbol of extractSymbolsFromLines(best.content, WIRING_DOMAIN_MAX_SYMBOLS)) {
    const bounds = symbol.range.split("-");
    const start = Number.parseInt(bounds[0] ?? "", 10);
    const end = Number.parseInt(bounds[1] ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    // An insertion site is CALLABLE; a namespace/class/struct header is not.
    if (!(bestLines[start - 1] ?? "").includes("(")) continue;
    const name = unqualifiedSymbolTail(symbol.name);
    const score = hitsIn(name) * 2 + hitsIn(bestLines.slice(start - 1, end).join("\n"));
    if (score > tokenScore) {
      tokenScore = score;
      token = name;
    }
  }
  return {
    endpoint: {
      token: token ?? definedCallableNames(best.content)[0] ?? current.token,
      path: best.path,
      role: structuralWiringDestinationRole(best.path, asImpactSurface(classifySurface(best.path))) ?? "api",
    },
  };
}

export function buildLegacyTaskWiringProfile(
  query: string,
  surfaces: TaskPackSurface[],
  workspace: string,
  cache?: FileReadCache,
): TaskWiringProfile {
  const walked = walkCodeFiles(workspace, {}).map((file) => file.relPath);
  const tokens = wiringCandidateTokens(query, walked, surfaces);
  const check = buildWiringCooccurrenceCheck(query, surfaces, workspace);

  if (check?.tokens === undefined || check.tokens.length < 2 || check.glob === undefined) {
    const sourceToken = tokens[0];
    const destinationToken = tokens.find((token) =>
      sourceToken !== undefined && normIdent(token) !== normIdent(sourceToken)
    );
    const sourceIndex = sourceToken === undefined ? -1 : surfaceIndexForToken(sourceToken, surfaces);
    const destinationIndex = destinationToken === undefined
      ? -1
      : surfaceIndexForToken(destinationToken, surfaces);
    const sourceSurface = sourceIndex >= 0 ? surfaces[sourceIndex] : undefined;
    const destinationSurface = destinationIndex >= 0 ? surfaces[destinationIndex] : undefined;
    // D2: an endpoint this pack did not serve may still be one the caller
    // already holds from an earlier call in this epoch. Consulted ONLY where
    // the in-pack resolution came up empty, so a resolved endpoint's wire is
    // untouched.
    const sourceEndpointResolved = sourceToken !== undefined && sourceSurface !== undefined
      ? endpointFromSurface(sourceToken, sourceSurface, ["query-token", "located-surface"])
      : epochServedWiringEndpoint(sourceToken, query, surfaces, workspace, cache);
    const destinationEndpointResolved = destinationToken !== undefined && destinationSurface !== undefined
      ? endpointFromSurface(destinationToken, destinationSurface, ["query-token", "located-surface"])
      : epochServedWiringEndpoint(destinationToken, query, surfaces, workspace, cache);
    const missing: Array<"source" | "destination"> = [];
    if (sourceEndpointResolved === undefined) missing.push("source");
    if (destinationEndpointResolved === undefined) missing.push("destination");
    return {
      version: 1,
      status: "needs-followup",
      connections: [{
        id: "w1",
        status: "needs-followup",
        ...(sourceEndpointResolved !== undefined ? { source: sourceEndpointResolved } : {}),
        ...(destinationEndpointResolved !== undefined ? { destination: destinationEndpointResolved } : {}),
        supporting_handles: [],
        confidence: 0.4,
        evidence: ["query-token"],
      }],
      missing: missing.length > 0 ? missing : ["destination"],
      edit_frontier: [],
      review_frontier: [sourceEndpointResolved?.handle, destinationEndpointResolved?.handle]
        .filter((handle): handle is string => handle !== undefined),
    };
  }

  const [sourceToken, destinationToken] = check.tokens;
  const familyScope = roleFillScope(surfaces);
  const inFamily = (candidatePath: string): boolean =>
    familyScope === null || familyScope === "" || familyScope === "."
      ? familyScope !== null
      : isUnderAncestor(candidatePath, familyScope);
  const isDestinationRole = (role: string): boolean => WIRING_DEST_ROLE_RANK[role] !== undefined;

  const mappedSourceIndex = surfaceIndexForToken(sourceToken!, surfaces);
  const mappedSource = mappedSourceIndex >= 0
    && !isDestinationRole(surfaces[mappedSourceIndex]!.role)
    ? surfaces[mappedSourceIndex]
    : undefined;
  const directorySource = mappedSource ?? surfaces.find((candidate) =>
    !isDestinationRole(candidate.role)
    && path.dirname(candidate.path) === check.sourceDir
    && (
      normIdent(candidate.code ?? "").includes(normIdent(sourceToken!))
      || normIdent(path.basename(candidate.path)).includes(normIdent(sourceToken!))
    )
  );
  const resolvedSource = directorySource === undefined
    ? resolveWiringWorkspaceToken(
        sourceToken!,
        walked,
        "",
        inFamily,
        "",
        (role) => !isDestinationRole(role),
        (relPath) => structuralWiringSourceRole(relPath, classifySurface(relPath), walked),
      )
    : undefined;
  const sourceEndpoint: WiringEndpoint | undefined = directorySource !== undefined
    ? { token: sourceToken!, path: directorySource.path, role: asImpactSurface(directorySource.role) }
    : resolvedSource !== undefined
      ? { token: sourceToken!, path: resolvedSource.path, role: resolvedSource.role }
      : undefined;

  const declaredDestinationSurface = surfaces.find((candidate) => candidate.path === check.glob);
  const promotedDestinationSurface = bestServedWiringConsumer(query, destinationToken!, surfaces);
  if (
    promotedDestinationSurface !== undefined
    && declaredDestinationSurface !== undefined
    && promotedDestinationSurface.handle !== declaredDestinationSurface.handle
  ) {
    // The declaration/API remains useful review evidence, but it must no
    // longer compete with the proved consumer for required-surface trim space.
    declaredDestinationSurface.required = false;
  }
  const retainedConsumerSurface = surfaces.find((candidate) =>
    candidate.why?.startsWith("wiring destination for ") === true
    && hasCallableBody(candidate)
  );
  const retainedConsumerToken = retainedConsumerSurface?.why
    ?.match(/^wiring destination for (.+?);/)?.[1];
  const retainedConsumer: WiringEndpoint | undefined = retainedConsumerSurface !== undefined
    && retainedConsumerToken !== undefined
    ? {
        token: retainedConsumerToken,
        path: retainedConsumerSurface.path,
        role: structuralWiringDestinationRole(
          retainedConsumerSurface.path,
          asImpactSurface(retainedConsumerSurface.role),
        ) ?? "api",
      }
    : undefined;
  const provisionalDestinationSurface = promotedDestinationSurface ?? declaredDestinationSurface;
  const closureDefinitionSurface: TaskPackSurface | undefined = provisionalDestinationSurface ?? (() => {
    const content = readCached(workspace, check.glob!, cache);
    if (content === undefined) return undefined;
    return {
      role: asImpactSurface(check.role ?? classifySurface(check.glob!)),
      handle: "",
      path: check.glob!,
      range: `1-${Math.max(1, countLines(content))}`,
      code: content.slice(0, 32768),
    };
  })();
  const closureConsumer = retainedConsumer ?? workspaceCallConsumer(
      closureDefinitionSurface,
      walked,
      workspace,
      cache,
      familyScope,
      query,
    );
  if (closureConsumer !== undefined && provisionalDestinationSurface !== undefined) {
    provisionalDestinationSurface.required = false;
  }
  const destinationSurface = closureConsumer === undefined
    ? provisionalDestinationSurface
    : surfaces.find((candidate) => candidate.path === closureConsumer.path);
  const shapeDestinationEndpoint: WiringEndpoint = {
    token: destinationSurface === undefined
      ? closureConsumer?.token ?? destinationToken!
      : wiringConsumerToken(query, destinationSurface, closureConsumer?.token ?? destinationToken!),
    path: closureConsumer?.path ?? destinationSurface?.path ?? check.glob,
    role: destinationSurface !== undefined
      ? structuralWiringDestinationRole(destinationSurface.path, asImpactSurface(destinationSurface.role))
        ?? asImpactSurface(destinationSurface.role)
      : closureConsumer?.role ?? asImpactSurface(check.role ?? classifySurface(check.glob)),
  };
  // E1: everything above chooses the destination on callable-insertion-site
  // SHAPE. When the query named a destination DOMAIN that the workspace really
  // spells as a module family, the endpoint must come from that family — and
  // when it cannot, the out-of-domain site says so in its own `why`.
  //
  // SUITEFIX (2026-09-05): E1 must never re-seat a destination the shape
  // logic already proved with a real consumer relation freshly computed FOR
  // THIS query. `promotedDestinationSurface` (bestServedWiringConsumer, a
  // served surface the query's own evidence already ranked above the bare
  // declaration) and a `closureConsumer` produced by `workspaceCallConsumer`
  // (a direct-call hop from the shape destination's own definition to
  // whoever actually calls it) are both concrete, query-fresh call/import
  // relations, not the callable-insertion-site FALLBACK E1 is meant to
  // correct. Without this guard, a query word that is merely a path piece of
  // the family (e.g. "MAVLink" naming `mavlink.cpp`) out-ranks a destination
  // the workspace already proves calls the source, silently trading a
  // verified consumer for an unrelated same-family file.
  //
  // `retainedConsumer` is EXCLUDED from this guard even though it also feeds
  // `closureConsumer` (`closureConsumer = retainedConsumer ?? workspaceCallConsumer(...)`):
  // it recovers a surface an EARLIER stage already tagged "wiring destination
  // for <token>" and says nothing about whether that stage's token/source
  // matches THIS one — reproduced live on SF13 (aeroctl), where a stale
  // "wiring destination for start" tag on `tasks_init.cpp` (unrelated to
  // isHealthy) short-circuited the guard and blocked the correct re-seat onto
  // `mavlink_dialect.cpp`. Only a closure/promotion hop computed fresh from
  // THIS call's own tokens counts as proof.
  //
  // The fallback case — no relation, just a bare declaration or `check.glob`
  // match — is exactly when E1 must still apply.
  const shapeDestinationIsRelationBacked = (closureConsumer !== undefined && retainedConsumer === undefined)
    || promotedDestinationSurface !== undefined;
  const domainDestination = shapeDestinationIsRelationBacked
    ? undefined
    : wiringDestinationDomainEndpoint(
        query,
        walked,
        workspace,
        cache,
        shapeDestinationEndpoint,
      );
  const destinationEndpoint: WiringEndpoint = domainDestination?.endpoint ?? shapeDestinationEndpoint;

  const ensuredDestination = ensureWiringEndpointSurface(
    surfaces,
    destinationEndpoint,
    workspace,
    cache,
    true,
    MAX_SURFACES_DISTINCT,
    MAX_SURFACE_CODE_BYTES,
    TINY_FILE_MAX_BYTES,
    TINY_FILE_MAX_LINES,
    // Either disclosure, never both: the endpoint is EITHER in the family the
    // query named (seated there by the rule) or provably out of it.
    domainDestination?.endpoint !== undefined ? DOMAIN_SEATED_WHY_NOTE : domainDestination?.note,
  );
  if (
    closureConsumer !== undefined
    && closureDefinitionSurface !== undefined
    && closureDefinitionSurface.path !== destinationEndpoint.path
  ) {
    ensureWiringEndpointSurface(
      surfaces,
      {
        token: closureConsumer.token,
        path: closureDefinitionSurface.path,
        role: structuralWiringDestinationRole(
          closureDefinitionSurface.path,
          asImpactSurface(closureDefinitionSurface.role),
        ) ?? "api",
      },
      workspace,
      cache,
      false,
    );
  }
  // When an unrelated same-name definition exists, the consumer's concrete
  // import/include edge outranks basename/query similarity for the producer.
  const importedSource = importedWiringSource(
    ensuredDestination?.surface,
    sourceToken!,
    walked,
    workspace,
    cache,
  );
  // D5 (2026-09-02): when the caller wrote the endpoint as `Class::method`,
  // the qualifier is part of the address. `workspaceCallableDefinitionPaths`
  // compares BARE names (definedCallableNames discards the qualifier), so every
  // sibling class with a same-named member looked like the same definition.
  // Resolve the anchor as a unit first; a bare token still falls through to the
  // flat lookup, keeping the `ambiguousUnlinkedSource` abstention below intact.
  const qualifiedSourceDefinitions = importedSource === undefined
    ? qualifiedAnchorDefinitionPathsForToken(sourceToken!, query, workspace, cache)
    : [];
  const sourceDefinitionPaths = importedSource !== undefined
    ? []
    : qualifiedSourceDefinitions.length > 0
      ? qualifiedSourceDefinitions
      : workspaceCallableDefinitionPaths(sourceToken!, walked, workspace, cache);
  const ambiguousUnlinkedSource = importedSource === undefined && sourceDefinitionPaths.length > 1;
  const uniqueDefinitionSource: WiringEndpoint | undefined = importedSource === undefined
    && sourceDefinitionPaths.length === 1
    ? {
        token: sourceToken!,
        path: sourceDefinitionPaths[0]!,
        role: hasCallableDeclarationSibling(
          sourceToken!,
          sourceDefinitionPaths[0]!,
          workspace,
          cache,
        )
          ? "contract"
          : structuralWiringSourceRole(
              sourceDefinitionPaths[0]!,
              classifySurface(sourceDefinitionPaths[0]!),
              walked,
            ),
      }
    : undefined;
  const selectedSourceEndpoint = importedSource
    ?? uniqueDefinitionSource
    ?? (ambiguousUnlinkedSource ? undefined : sourceEndpoint);
  const ensuredSource = selectedSourceEndpoint === undefined
    ? undefined
    : ensureWiringEndpointSurface(surfaces, selectedSourceEndpoint, workspace, cache, false);
  const missing: Array<"source" | "destination" | "insertion"> = [];
  if (ensuredSource === undefined) missing.push("source");
  if (ensuredDestination === undefined) missing.push("destination");
  const endpointsReady = missing.length === 0;

  const source = ensuredSource === undefined
    ? undefined
    : endpointFromSurface(
        sourceToken!,
        ensuredSource.surface,
        [
          "query-token",
          uniqueDefinitionSource !== undefined || ensuredSource.discovered
            ? "workspace-definition"
            : "located-surface",
        ],
      );
  const destination = ensuredDestination === undefined
    ? undefined
    : endpointFromSurface(
        wiringConsumerToken(query, ensuredDestination.surface, destinationEndpoint.token),
        ensuredDestination.surface,
        ["query-token", ensuredDestination.discovered ? "workspace-definition" : "located-surface"],
      );
  if (ensuredDestination !== undefined) {
    for (const token of tokens) {
      if (
        normIdent(token) === normIdent(sourceToken!)
        || normIdent(token) === normIdent(destinationToken!)
      ) {
        continue;
      }
      const importedSupport = importedWiringSource(
        ensuredDestination.surface,
        token,
        walked,
        workspace,
        cache,
      );
      if (
        importedSupport !== undefined
        && importedSupport.path !== source?.path
        && importedSupport.path !== destination?.path
      ) {
        ensureWiringEndpointSurface(
          surfaces,
          importedSupport,
          workspace,
          cache,
          false,
        );
      }
    }
  }
  if (ensuredDestination !== undefined) {
    const consumerBody = readCached(workspace, ensuredDestination.surface.path, cache)
      ?? ensuredDestination.surface.code
      ?? ensuredDestination.surface.code_unchanged
      ?? "";
    for (const calledName of calledCallableNames(consumerBody)) {
      if (normIdent(calledName) === normIdent(destinationEndpoint.token)) continue;
      const definitions = workspaceCallableDefinitionPaths(calledName, walked, workspace, cache);
      const candidates = definitions.length > 0
        ? definitions
        : workspaceCallableDeclarationPaths(calledName, walked, workspace, cache);
      if (candidates.length !== 1 || candidates[0] === ensuredDestination.surface.path) continue;
      const candidatePath = candidates[0]!;
      ensureWiringEndpointSurface(
        surfaces,
        {
          token: calledName,
          path: candidatePath,
          role: asImpactSurface(classifySurface(candidatePath)),
        },
        workspace,
        cache,
        false,
      );
    }
  }
  const endpointHandles = new Set([
    source?.handle,
    destination?.handle,
  ].filter((handle): handle is string => handle !== undefined));
  const endpointTokens = new Set([
    source?.token,
    destination?.token,
  ].filter((token): token is string => token !== undefined).map(normIdent));
  const destinationCode = relationCodeOnly(
    destination === undefined
      ? ""
      : readCached(workspace, destination.path, cache)
        ?? ensuredDestination?.surface.code
        ?? ensuredDestination?.surface.code_unchanged
        ?? "",
  );
  const supportingHandles = surfaces
    .filter((candidate) =>
      !endpointHandles.has(candidate.handle)
      && candidate.path !== source?.path
      && candidate.path !== destination?.path
    )
    .map((candidate) => {
      const names = [candidate.symbol, ...declaredCallableNames(servedSurfaceText(candidate))]
        .filter((name): name is string => Boolean(name))
        .filter((name) => !endpointTokens.has(normIdent(name)));
      const directlyCalled = names.some((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const call = new RegExp(`\\b${escaped}\\s*\\(([^)]*)\\)`).exec(destinationCode);
        return call !== null && call[1]!.trim().length > 0;
      });
      return { candidate, directlyCalled };
    })
    .filter(({ directlyCalled }) => directlyCalled)
    .sort((left, right) => left.candidate.path.localeCompare(right.candidate.path))
    // Recursive closure can serve a tighter slice of an adapter that is
    // already present. Semantic wiring support is file-based, so keep one
    // stable handle per implementation path instead of duplicating review
    // frontier entries for equivalent ranges.
    .filter(({ candidate }, index, all) =>
      all.findIndex(({ candidate: other }) => other.path === candidate.path) === index
    )
    .map(({ candidate }) => candidate.handle)
    .slice(0, 3);
  const supportingSurfaces = surfaces.filter((surface) =>
    supportingHandles.includes(surface.handle)
  );
  const sourceCalledDirectly = source !== undefined && (() => {
    const escaped = source.token.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
    return new RegExp("\\b" + escaped + "\\s*\\(").test(destinationCode);
  })();
  const adapterInsertion = supportingHandles.length > 0
    && hasEditGradeCallArgument(query, destinationCode, supportingSurfaces);
  // D3' (2026-09-05, live r10 follow-up): the two tests above both ask whether
  // the destination ALREADY calls something — a shape-chosen destination is
  // normally an existing consumer, and the edit tightens a call it already
  // makes. A destination the DOMAIN rule seated is the opposite case by
  // construction: the query named a module family precisely because the call
  // it wants does NOT exist there yet ("reuse the existing encoder"), so
  // demanding a pre-existing call would report `missing:["insertion"]` for
  // every re-seat — a SEMANTIC gap no further reading can close, which is
  // exactly the re-read loop the re-seat was meant to end. The re-seat is not
  // a guess: the family is a real multi-file module the query named, a
  // non-family query term corroborated this file, and the token below is the
  // callable in it the query's own words describe best — all of which is
  // strictly more grounding than `adapterInsertion`. It still has to BE a
  // callable (`hasCallableBody`, unchanged).
  //
  // Asked STATELESSLY, of the destination that actually stands, rather than of
  // this invocation's re-seat: `buildTaskWiringProfile` runs more than once per
  // request (the probe pass and the final pass), and by the second run the
  // re-seated destination is already retained as the pack's own
  // "wiring destination for …" surface — so `wiringDestinationDomainEndpoint`
  // correctly abstains (it is already in domain) and a provenance flag would
  // read false on exactly the profile that reaches the wire.
  const domainSeatedInsertion = destination !== undefined
    && (
      domainDestination?.endpoint !== undefined
      || ensuredDestination?.surface.why?.includes(DOMAIN_SEATED_WHY_NOTE) === true
    );
  const hasCallableInsertionSite = endpointsReady
    && destination !== undefined
    && ensuredDestination !== undefined
    && hasCallableBody(ensuredDestination.surface)
    && (sourceCalledDirectly || adapterInsertion || domainSeatedInsertion);
  if (endpointsReady && !hasCallableInsertionSite) missing.push("insertion");
  const ready = missing.length === 0;
  const evidenceGraph = buildWiringEvidenceGraph(source, destination, surfaces, workspace, cache);
  const evidenceIds = evidenceGraph?.relations.map((relation) => relation.id) ?? [];

  return {
    version: 1,
    status: ready ? "ready" : "needs-followup",
    connections: [{
      id: "w1",
      status: ready ? "ready" : "needs-followup",
      ...(source ? { source } : {}),
      ...(destination ? { destination } : {}),
      ...(hasCallableInsertionSite && destination ? { insertion_handle: destination.handle } : {}),
      supporting_handles: supportingHandles,
      confidence: ready ? 0.9 : 0.55,
      evidence: [
        "query-token",
        "closure-check",
        "project-family",
        ...(hasCallableInsertionSite ? ["callable-insertion-site" as const] : []),
        // D3': disclosed ONLY when the domain rule is what makes this the
        // insertion site. When the destination already calls the producer (or
        // an adapter), the plain proof above stands alone and the wire is
        // byte-identical.
        ...(hasCallableInsertionSite && domainSeatedInsertion && !sourceCalledDirectly && !adapterInsertion
          ? ["domain-insertion-site" as const]
          : []),
      ],
      ...(evidenceIds.length > 0 ? { evidence_ids: evidenceIds } : {}),
    }],
    missing,
    edit_frontier: hasCallableInsertionSite && destination ? [destination.handle] : [],
    review_frontier: [source?.handle, ...supportingHandles]
      .filter((handle): handle is string => handle !== undefined),
    ...(evidenceGraph !== undefined ? { evidence_graph: evidenceGraph } : {}),
  };
}

export function unqualifiedCallable(symbol: string): string {
  return symbol.split("::").at(-1) ?? symbol;
}

export function semanticTokenForPath(resolution: SemanticWiringResolution, relPath: string): string {
  const stem = (candidate: string): string => path.basename(candidate).replace(/\.[^.]+$/, "").toLowerCase();
  if (relPath === resolution.producer.path) return unqualifiedCallable(resolution.producer.symbol);
  if (stem(relPath) === stem(resolution.producer.path)) return resolution.producer.symbol.split("::")[0]!;
  if (relPath === resolution.adapter.path || stem(relPath) === stem(resolution.adapter.path)) {
    return unqualifiedCallable(resolution.adapter.symbol);
  }
  if (relPath === resolution.host.path) return resolution.host.callSymbol;
  if (stem(relPath) === stem(resolution.host.path)) return resolution.host.type;
  if (stem(relPath) === stem(resolution.carrier.path)) return resolution.carrier.type;
  if (relPath === resolution.consumer.path) return unqualifiedCallable(resolution.consumer.symbol);
  if (stem(relPath) === stem(resolution.consumer.path)) return resolution.consumer.owner;
  if (relPath === resolution.insertion.path) return unqualifiedCallable(resolution.insertion.symbol);
  return path.basename(relPath).replace(/\.[^.]+$/, "");
}

/** A 1-based inclusive line window inside a construction hub. */
export interface HubLineRange {
  start: number;
  end: number;
}

/** Sort + coalesce touching/overlapping windows into ascending disjoint ranges. */
export function mergeHubLineRanges(ranges: readonly HubLineRange[]): HubLineRange[] {
  const merged: HubLineRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * A2: the bounded LANDING REGION of a construct-receiver hub — one ±radius
 * window per WIRING ANCHOR (the hub lines `connections[0].required_action`'s
 * replacement has to land on: the producer entry, its publish site, and the
 * insertion site), merged, with the radius shrunk until the windows' VERBATIM
 * text fits HUB_EDIT_HUNK_MAX_BYTES.
 *
 * Every input is a signal the pack already resolved (`resolution.insertion.line`
 * / `resolution.host.producerEntryLine` / `producerPublishLine`), so "cheaply
 * locatable" is a property of the resolution, not of a search. Returns undefined
 * — meaning "keep today's behavior" — when no anchor is a real line of this file
 * or even the tightest radius does not fit. Nothing is ever inferred, widened on
 * a guess, or synthesized: the window is only ever real file lines.
 */
export function hubEditHunkRanges(
  lines: readonly string[],
  anchorLines: readonly number[],
): HubLineRange[] | undefined {
  const anchors = anchorLines.filter((line, index, all) =>
    Number.isInteger(line) && line >= 1 && line <= lines.length && all.indexOf(line) === index
  );
  if (anchors.length === 0) return undefined;
  for (const radius of HUB_EDIT_HUNK_RADII) {
    const merged = mergeHubLineRanges(anchors.map((anchor) => ({
      start: Math.max(1, anchor - radius),
      end: Math.min(lines.length, anchor + radius),
    })));
    const bytes = merged.reduce(
      (total, range) => total + Buffer.byteLength(lines.slice(range.start - 1, range.end).join("\n"), "utf8"),
      0,
    );
    if (bytes <= HUB_EDIT_HUNK_MAX_BYTES) return merged;
  }
  return undefined;
}

/**
 * A2: does comment elision MUTILATE the landing region? True means the bytes a
 * solver would copy out of the served body are a `/* doc elided L<a>-<b> *\/`
 * placeholder rather than file text — which `tl_edit_file`'s write guard refuses as
 * `elided-content`, forcing the same-handle re-slice measured 3× on T13.
 */
export function hubLandingRegionIsElided(
  lines: readonly string[],
  lang: string | undefined,
  hunks: readonly HubLineRange[],
): boolean {
  return hunks.some((range) => {
    const text = lines.slice(range.start - 1, range.end).join("\n");
    return elideDocComments(text, lang, range.start) !== text;
  });
}

/**
 * A2: render ONE served window with its landing-region sub-spans kept verbatim
 * and every other sub-span elided exactly as before.
 *
 * The single renderer both hub branches share, so "what is served verbatim" has
 * one definition. The verbatim span is the HUNK, never the whole window that
 * carries it: a window that merged with an anchored excerpt window still elides
 * its own doc comments outside the landing region.
 *
 * Splitting an elided segment at a hunk boundary is safe by construction —
 * formatCompress leaves an unclosed comment region "exactly as found", so a
 * doc comment straddling the boundary degrades to NOT being elided, never to
 * corrupted text.
 */
export function renderHubWindow(
  lines: readonly string[],
  lang: string | undefined,
  window: HubLineRange,
  hunks: readonly HubLineRange[] | undefined,
): string {
  const textOf = (start: number, end: number): string => lines.slice(start - 1, end).join("\n");
  const elided = (start: number, end: number): string =>
    start > end ? "" : elideDocComments(textOf(start, end), lang, start);
  const covering = (hunks ?? [])
    .filter((hunk) => hunk.start <= window.end && hunk.end >= window.start)
    .map((hunk) => ({ start: Math.max(hunk.start, window.start), end: Math.min(hunk.end, window.end) }))
    .sort((left, right) => left.start - right.start);
  if (covering.length === 0) return elided(window.start, window.end);
  const parts: string[] = [];
  let cursor = window.start;
  for (const hunk of covering) {
    if (hunk.start > cursor) parts.push(elided(cursor, hunk.start - 1));
    parts.push(textOf(Math.max(hunk.start, cursor), hunk.end));
    cursor = hunk.end + 1;
  }
  if (cursor <= window.end) parts.push(elided(cursor, window.end));
  return parts.filter((part) => part.length > 0).join("\n");
}

/**
 * A2: re-emit a WHOLE-file construct-receiver hub body with the landing region
 * kept verbatim and every other segment elided exactly as before.
 *
 * The sibling of the excerpt path: a hub small enough for the completeness bar
 * is served whole, but `centeredSliceForCap` still elides its doc comments, so
 * an anchor over the wiring site is the same unusable placeholder. Same rule,
 * same renderer, same cap; one contiguous window instead of anchored ones.
 *
 * Returns undefined when nothing would change or the rebuild costs more than
 * HUB_EDIT_HUNK_MAX_BYTES over the elided body — the caller then keeps today's
 * body untouched.
 */
export function wholeHubWithVerbatimLanding(
  text: string,
  relPath: string,
  elidedCode: string,
  hunks: readonly HubLineRange[],
): string | undefined {
  const lines = text.split(/\r?\n/);
  const lang = languageForPath(relPath);
  if (!hubLandingRegionIsElided(lines, lang, hunks)) return undefined;
  const rebuilt = renderHubWindow(lines, lang, { start: 1, end: lines.length }, mergeHubLineRanges(hunks));
  if (rebuilt.length === 0 || rebuilt === elidedCode) return undefined;
  const delta = Buffer.byteLength(rebuilt, "utf8") - Buffer.byteLength(elidedCode, "utf8");
  if (delta > HUB_EDIT_HUNK_MAX_BYTES) return undefined;
  return rebuilt;
}

/**
 * Build a construction-hub excerpt.
 *
 * A2 (v0.12): `edit_hunk_ranges` is present ONLY when the landing-region hunk
 * fired. It is SERVER-INTERNAL — the caller reads it to emit one trace line and
 * never copies it onto a surface, so it costs zero wire bytes. Its absence means
 * the excerpt is byte-for-byte the pre-A2 build.
 *
 * Exported for editHunkFrontier.spec.ts, which pins the A2 trigger and its
 * OFF-parity property (a non-matching hub keeps the pre-A2 body) without having
 * to reconstruct a whole semantic workspace for every cell.
 */
export function semanticConstructionHubExcerpt(
  source: string,
  relPath: string,
  anchorLines: readonly number[],
): { code: string; remaining_ranges: string[]; edit_hunk_ranges?: string[] } | undefined {
  const lines = source.split(/\r?\n/);
  // 2026-10-19 (DESIGN-v0.14-plan.md §20.26): split() leaves a phantom empty
  // element after a trailing newline, so every 6t-4/6t-5 T13 first pack
  // disclosed `478-504` for the 503-line tasks_init.cpp. countLines is the
  // line count every other read path uses.
  lines.length = Math.min(lines.length, countLines(source));
  if (lines.length === 0) return undefined;
  // Wave 4 (2026-07-24 T13 forensics): the globals center matched the FIRST
  // /global instances/i line — in real firmware hubs that is a mention inside
  // the file's top doc comment, so the excerpt never contained the actual
  // global-definition section and the model full-read the file natively.
  // Prefer a match that is immediately followed by definition-shaped code
  // (a section banner right above the instances), falling back to the first.
  const globalMatches = lines
    .map((line, index) => (/global instances/i.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const definitionFollows = (index: number): boolean =>
    lines.slice(index + 1, index + 6).some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0
        && !trimmed.startsWith("//")
        && !trimmed.startsWith("/*")
        && !trimmed.startsWith("*")
        && !trimmed.startsWith("#")
        && /[;={(]/.test(trimmed);
    });
  const globals = globalMatches.find(definitionFollows) ?? globalMatches[0] ?? -1;
  const centers = [
    ...(globals >= 0 ? [globals + 1] : []),
    ...anchorLines,
  ].filter((line, index, all) =>
    Number.isInteger(line) && line >= 1 && line <= lines.length && all.indexOf(line) === index
  );
  if (centers.length === 0) return undefined;

  const lang = languageForPath(relPath);
  // A2: the landing region, and whether comment elision would MUTILATE it. A
  // solver anchors its `search` on the bytes we served; when those bytes carry a
  // `/* doc elided L<a>-<b> */` marker the resulting edit is refused
  // `elided-content` and the only recovery is a same-handle re-slice (measured
  // 3× on T13, 2026-08-26). Serving the landing region VERBATIM removes the
  // refusal at its source instead of paying for the recovery.
  const editHunks = hubEditHunkRanges(lines, anchorLines);
  const hunkElided = editHunks !== undefined && hubLandingRegionIsElided(lines, lang, editHunks);

  const build = (
    radius: number,
    hunks?: readonly HubLineRange[],
  ): { code: string; merged: HubLineRange[] } => {
    const merged = mergeHubLineRanges([
      ...centers.map((center) => ({
        start: Math.max(1, center - radius),
        end: Math.min(lines.length, center + radius),
      })),
      ...(hunks ?? []),
    ]);
    const code = merged.map((range, index) => {
      const prefix = index === 0
        ? "// TL hub excerpt; omitted ranges listed in remaining (zoom: ONE tl_read_file {targets:[{handle}], content:\"full\"} beats repeated re-slices when you need most of the file)\n"
        : `// TL omitted lines before L${range.start}\n`;
      // A2: only the LANDING-REGION sub-span of a window is served verbatim —
      // the rest of that window keeps the elided representation it always had.
      return prefix + renderHubWindow(lines, lang, range, hunks);
    }).join("\n");
    return { code, merged };
  };

  // Budget 6KB (was 12KB): the definition-anchored globals center (above) adds
  // ~40 real lines over the old doc-comment center; without tightening, the
  // hub excerpt pushed the whole pack over the wire cap and the trim ladder
  // either collapsed it to a single surface or dropped review surfaces
  // (ekf.hpp) that carry unique files. With remaining_ranges now disclosed and
  // re-slice sanctioned, a leaner anchored excerpt plus zoom-on-demand beats a
  // fatter excerpt that evicts other evidence. Radius shrinks until it fits.
  // Wave 4 (2026-07-24 T13 forensics): the excerpt used to claim
  // remaining_ranges:[] ("graph-proved anchors, must not reopen"), hiding
  // the truncation — the model's actual edit landed OUTSIDE the excerpt
  // windows and it escaped to a native full-file Read to recover. Disclose
  // the true complement instead; a re-slice of this same handle is the
  // sanctioned (and far cheaper) recovery path.
  const finish = (
    built: { code: string; merged: HubLineRange[] },
    hunks?: readonly HubLineRange[],
  ): { code: string; remaining_ranges: string[]; edit_hunk_ranges?: string[] } => {
    const remaining: string[] = [];
    let cursor = 1;
    for (const range of built.merged) {
      if (range.start > cursor) remaining.push(`${cursor}-${range.start - 1}`);
      cursor = range.end + 1;
    }
    if (cursor <= lines.length) remaining.push(`${cursor}-${lines.length}`);
    return {
      code: built.code,
      remaining_ranges: remaining,
      ...(hunks !== undefined ? { edit_hunk_ranges: hunks.map((hunk) => `${hunk.start}-${hunk.end}`) } : {}),
    };
  };

  for (const radius of [32, 24, 18]) {
    const plain = build(radius);
    const plainBytes = Buffer.byteLength(plain.code, "utf8");
    // The radius ladder is UNCHANGED by A2: a radius whose plain build does not
    // fit is still skipped, so A2 never trades a tighter radius for a hunk.
    if (plainBytes > HUB_EXCERPT_BUDGET_BYTES) continue;
    // A2 TRIGGER (strict). The served evidence fails to cover the landing region
    // when the anchored windows do not CONTAIN it, or when what they contain is
    // not the file's own bytes (comment elision). Neither true ⇒ the pre-A2
    // build is returned unchanged, byte for byte.
    const uncovered = editHunks !== undefined
      && !editHunks.every((hunk) => plain.merged.some((range) => range.start <= hunk.start && range.end >= hunk.end));
    if (editHunks === undefined || (!hunkElided && !uncovered)) return finish(plain);
    const withHunk = build(radius, editHunks);
    const withHunkBytes = Buffer.byteLength(withHunk.code, "utf8");
    if (
      withHunkBytes - plainBytes <= HUB_EDIT_HUNK_MAX_BYTES
      && withHunkBytes <= HUB_EXCERPT_BUDGET_BYTES + HUB_EDIT_HUNK_MAX_BYTES
    ) {
      return finish(withHunk, editHunks);
    }
    // The landing region does not fit its cap here: keep the pre-A2 body rather
    // than widen the pack. The disclosed remaining_ranges + same-handle re-slice
    // stay the recovery path they have always been.
    return finish(plain);
  }
  return undefined;
}

export function buildSemanticEvidenceGraph(
  resolution: SemanticWiringResolution,
  source: TaskWiringEndpoint,
  destination: TaskWiringEndpoint,
  insertion: TaskPackSurface,
  adapter: TaskPackSurface,
  host: TaskPackSurface,
  carrier: TaskPackSurface,
): TaskEvidenceGraph {
  const sourceFileId = evidenceNodeId("file", source.path);
  const sourceSymbolId = evidenceNodeId("symbol", source.path, source.token);
  const consumerFileId = evidenceNodeId("file", destination.path);
  const consumerSymbolId = evidenceNodeId("symbol", destination.path, destination.token);
  const insertionFileId = evidenceNodeId("file", insertion.path);
  const insertionSymbol = unqualifiedCallable(resolution.insertion.symbol);
  const insertionSymbolId = evidenceNodeId("symbol", insertion.path, insertionSymbol);
  const producerEntryId = evidenceNodeId("symbol", insertion.path, resolution.host.producerEntry);
  const adapterFileId = evidenceNodeId("file", adapter.path);
  const adapterTargetId = evidenceNodeId("symbol", adapter.path, unqualifiedCallable(resolution.adapter.symbol));
  const hostFileId = evidenceNodeId("file", host.path);
  const hostSymbolId = evidenceNodeId("symbol", host.path, resolution.host.callSymbol);
  const carrierFileId = evidenceNodeId("file", carrier.path);
  const nodes: TaskEvidenceNode[] = [
    { id: sourceFileId, kind: "file", path: source.path, handle: source.handle, range: source.range, roles: ["producer"] },
    { id: sourceSymbolId, kind: "symbol", path: source.path, symbol: source.token, handle: source.handle, range: source.range, roles: ["producer"] },
    { id: consumerFileId, kind: "file", path: destination.path, handle: destination.handle, range: destination.range, roles: ["consumer"] },
    { id: consumerSymbolId, kind: "symbol", path: destination.path, symbol: destination.token, handle: destination.handle, range: destination.range, roles: ["consumer"] },
    { id: insertionFileId, kind: "file", path: insertion.path, handle: insertion.handle, range: insertion.range, roles: ["insertion"] },
    { id: insertionSymbolId, kind: "symbol", path: insertion.path, symbol: insertionSymbol, handle: insertion.handle, range: insertion.range, roles: ["insertion"] },
    { id: producerEntryId, kind: "symbol", path: insertion.path, symbol: resolution.host.producerEntry, handle: insertion.handle, range: insertion.range, roles: ["host"] },
    { id: adapterFileId, kind: "file", path: adapter.path, handle: adapter.handle, range: adapter.range, roles: ["adapter"] },
    { id: adapterTargetId, kind: "symbol", path: adapter.path, symbol: unqualifiedCallable(resolution.adapter.symbol), handle: adapter.handle, range: adapter.range, roles: ["adapter"] },
    { id: hostFileId, kind: "file", path: host.path, handle: host.handle, range: host.range, roles: ["host"] },
    { id: hostSymbolId, kind: "symbol", path: host.path, symbol: resolution.host.callSymbol, handle: host.handle, range: host.range, roles: ["host"] },
    { id: carrierFileId, kind: "file", path: carrier.path, handle: carrier.handle, range: carrier.range, roles: ["carrier"] },
  ];
  const relations: TaskEvidenceRelation[] = [];
  const add = (kind: TaskEvidenceRelationKind, from: string, to: string, confidence: number): void => {
    const id = evidenceRelationId(kind, from, to);
    if (!relations.some((relation) => relation.id === id)) {
      relations.push({ id, kind, from, to, provenance: "lexical", confidence });
    }
  };
  add("defines", sourceFileId, sourceSymbolId, 0.98);
  add("defines", consumerFileId, consumerSymbolId, 0.94);
  add("defines", insertionFileId, insertionSymbolId, 0.96);
  add("defines", insertionFileId, producerEntryId, 0.96);
  add("defines", adapterFileId, adapterTargetId, 0.98);
  add("defines", hostFileId, hostSymbolId, 0.94);
  add("imports", consumerFileId, adapterFileId, 0.98);
  if (resolution.consumer.adapterCallMode === "existing") {
    add("direct_calls", consumerSymbolId, adapterTargetId, 0.98);
  }
  add("direct_calls", insertionSymbolId, consumerSymbolId, 0.98);
  add("direct_calls", producerEntryId, hostSymbolId, 0.96);
  add("references", insertionSymbolId, carrierFileId, 0.9);
  add("references", consumerFileId, carrierFileId, 0.88);
  return { version: 1, nodes, relations };
}

/** Cap on compile_targets carried by the minimal harness-entry recipe (pack-time bytes). */
export const MAX_HARNESS_ENTRY_TARGETS = 4;

/**
 * The minimal `completion_proof.verification` a construct-receiver wiring pack
 * can honestly carry when full recipe enrichment is off: a runnable entry the
 * manifest already proved (a test's own Build/Compile marker, else a workspace
 * test entry) plus the targets it has to compile. Never a build-system FILE
 * path — required_action asks clients to EXECUTE this, so a non-command entry
 * would be a lie. Stays undefined unless a referencing test made the strategy
 * "harness".
 */
export function harnessEntryRecipe(
  manifest: VerificationManifest | undefined,
  editPaths: readonly string[],
): TaskVerificationRecipe | undefined {
  if (manifest === undefined || manifest.verify_strategy !== "harness") return undefined;
  // A SYNTHESIZED harness command carries <your_harness.*> placeholders — it
  // is authoring guidance, not an executable entry; advertising it here would
  // ask clients to EXECUTE a template (and its `source` is not a real path).
  const buildCommand = manifest.harness?.build_command_synthesized === true
    ? undefined
    : manifest.harness?.build_command;
  const entry = buildCommand?.text ?? manifest.toolchain?.test_entry;
  if (entry === undefined) return undefined;
  const compileTargets = [...new Set([
    ...editPaths,
    ...manifest.surfaces.filter((surface) => surface.role === "test").map((surface) => surface.path),
  ])].slice(0, MAX_HARNESS_ENTRY_TARGETS);
  // Same disclosure the full recipe makes: a mined command written for ITS own
  // test usually does not compile the files this task edits, so "it ran green"
  // is not proof of the wiring. Only checkable against a real command's text.
  const incomplete = buildCommand !== undefined
    && editPaths.some((rel) => !buildCommand.text.includes(path.posix.basename(rel)));
  return {
    compile_targets: compileTargets,
    ...(buildCommand !== undefined ? { cwd: path.posix.dirname(buildCommand.source) } : {}),
    entry,
    ...(incomplete ? { gaps: ["executable entry does not compile every edited implementation target"] } : {}),
  };
}

export function buildSemanticTaskWiringProfile(
  query: string,
  surfaces: TaskPackSurface[],
  workspace: string,
  cache: FileReadCache | undefined,
): TaskWiringProfile | undefined {
  const walked = walkCodeFiles(workspace, {}).map((file) => file.relPath);
  const scope = roleFillScope(surfaces) ?? ".";
  const resolution = resolveSemanticWiring(workspace, query, walked, scope || ".");
  if (resolution === undefined) return undefined;

  // Locator slices are optimized for the first lexical anchor and can point at
  // a declaration or an unrelated method in a multi-callable implementation.
  // Rebuild only the bounded semantic frontier so every role is sliced around
  // the implementation symbol that actually proves it.
  // A complete semantic graph supersedes the locator's provisional surfaces.
  // Keeping unrelated candidates (especially artifacts) consumes the bounded
  // surface budget and can turn a proven graph back into awaiting-input.
  surfaces.splice(0, surfaces.length);

  const ensure = (
    relPath: string,
    token: string,
    required: boolean,
    maxSurfaceBytes = 8192,
    completeUnderBytes = TINY_FILE_MAX_BYTES,
  ): TaskPackSurface | undefined => {
    const served = ensureWiringEndpointSurface(
      surfaces,
      { token, path: relPath, role: asImpactSurface(classifySurface(relPath)) },
      workspace,
      cache,
      required,
      MAX_SEMANTIC_WIRING_SURFACES,
      maxSurfaceBytes,
      completeUnderBytes,
      completeUnderBytes > TINY_FILE_MAX_BYTES ? WIRING_COMPLETE_SURFACE_LINES : TINY_FILE_MAX_LINES,
    )?.surface;
    if (served !== undefined) {
      served.required = required;
      served.why = required
        ? `semantic wiring edit frontier for ${token}`
        : `semantic wiring review evidence for ${token}`;
    }
    return served;
  };

  const isConstructReceiver = resolution.connectionMode === "construct-receiver";
  // B2a (2026-08-01 serving-completeness): a construct-receiver pack asks the
  // solver to CREATE the receiver — its three biggest REQUIRED surfaces were
  // exactly the ones it served as teasers. Live (2026-07-31-semantic-signal5-2,
  // T13): the wiring hub arrived as 4.7KB of 17.7KB, the produced class's header
  // as a 122-byte stub and the second edit site as 61 lines; all three solver
  // reps' FIRST post-pack act was `mode=full` of the hub, and two of three then
  // ran a 10-call / 72-77KB full-read cascade. Completeness is bought with a
  // bounded body budget — spending it here is strictly cheaper than the cascade.
  const completeBodyBudget = { left: isConstructReceiver ? CONSTRUCT_COMPLETE_EXTRA_BUDGET : 0 };
  // `reserveOnly` runs the budget draw WITHOUT returning a bar, so the hub can
  // claim its share before the frontier is walked in its own (carrier-first)
  // order; the second call for the same path then sees the reservation.
  const reserved = new Set<string>();
  const completeBarFor = (relPath: string, priority: boolean, reserveOnly = false): number => {
    if (!isConstructReceiver) return TINY_FILE_MAX_BYTES;
    const text = readCached(workspace, relPath, cache);
    if (text === undefined) return TINY_FILE_MAX_BYTES;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > WIRING_COMPLETE_SURFACE_BYTES) return TINY_FILE_MAX_BYTES;
    // A file the default tiny-file rule already serves whole is not an upgrade
    // — charging the budget for it would starve the files that ARE.
    if (bytes <= TINY_FILE_MAX_BYTES && Math.max(1, countLines(text)) <= TINY_FILE_MAX_LINES) {
      return TINY_FILE_MAX_BYTES;
    }
    if (reserved.has(relPath)) return reserveOnly ? TINY_FILE_MAX_BYTES : WIRING_COMPLETE_SURFACE_BYTES;
    // The produced class's declaration is the one never-refused draw: it is
    // small by nature (a header) and was arriving as a ~122-byte stub. Every
    // other surface — the construction hub included — draws on the bounded
    // extra budget, which is what keeps the pack under its transport ceiling.
    if (priority) {
      reserved.add(relPath);
      return WIRING_COMPLETE_SURFACE_BYTES;
    }
    if (bytes > completeBodyBudget.left) return TINY_FILE_MAX_BYTES;
    completeBodyBudget.left -= bytes;
    reserved.add(relPath);
    return reserveOnly ? TINY_FILE_MAX_BYTES : WIRING_COMPLETE_SURFACE_BYTES;
  };
  const reviewEvidenceBytes = isConstructReceiver ? 4096 : 8192;
  const sourceSurface = ensure(
    resolution.producer.path,
    unqualifiedCallable(resolution.producer.symbol),
    false,
    reviewEvidenceBytes,
  );
  const adapterSurface = ensure(
    resolution.adapter.path,
    unqualifiedCallable(resolution.adapter.symbol),
    false,
    reviewEvidenceBytes,
  );
  // B2a: the construction hub draws FIRST from the bounded extra budget (it is
  // the construction site and the measured full-read trigger), then every other
  // edit-frontier surface in frontier order.
  const editOrder = [...resolution.editPaths].sort((left, right) =>
    (left === resolution.insertion.path ? 0 : 1) - (right === resolution.insertion.path ? 0 : 1)
  );
  // EFF (TL_EFF_HUB_WHOLE, default OFF): the construction hub is a priority
  // draw like the produced class's header, so a hub above the extra budget
  // (T13: 19.6 KB against 10 KB) is still served whole rather than as a
  // skeleton every natively editing solver re-read in full.
  const hubWhole = isConstructReceiver && effHubWholeEnabled();
  for (const relPath of editOrder) {
    completeBarFor(relPath, hubWhole && relPath === resolution.insertion.path, true);
  }
  const editSurfaces = resolution.editPaths.map((relPath) => {
    const bar = completeBarFor(relPath, false);
    return ensure(
      relPath,
      semanticTokenForPath(resolution, relPath),
      true,
      bar > TINY_FILE_MAX_BYTES ? bar : MAX_SURFACE_CODE_BYTES,
      bar,
    );
  });
  // Review-only declarations still need a concrete body: a handle-only entry
  // makes a prepared pack claim more evidence than it actually delivered and
  // forces the agent to reopen discovery. Keep these slices deliberately
  // small so the complete semantic graph remains below the transport ceiling
  // without trimToCap stripping the bodies again — EXCEPT (B2a) the produced
  // class's own declaration, which a construct-receiver task must read in full
  // to construct and drive an instance. That one was the 122-byte stub.
  //
  // B2a completion (2026-09-30, T13 first-pack forensics): that exception was
  // documented but never wired — every review path, the produced class's
  // header included, still went through the 128-byte cap, and all solver reps
  // re-read ekf.hpp in full. A construct-receiver review DECLARATION (a
  // non-implementation file the tiny-file rule would serve whole anyway) is
  // now served whole: the produced class's own header as the never-refused
  // priority draw `completeBarFor` describes, every other one (the adapter's
  // parameter types, the construction host's API) only from what the edit
  // frontier left of the bounded CONSTRUCT_COMPLETE_EXTRA_BUDGET — edit sites
  // reserve first, so this never displaces an edit-surface completion. Larger
  // declarations and implementation files keep the 128-byte review window.
  const producerStem = path.posix.basename(resolution.producer.path).replace(/\.[^.]+$/, "").toLowerCase();
  const reviewBodyBytesFor = (relPath: string): number => {
    const stub = 128;
    if (!isConstructReceiver || isImplementationPath(relPath)) return stub;
    const text = readCached(workspace, relPath, cache);
    if (text === undefined) return stub;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > TINY_FILE_MAX_BYTES || Math.max(1, countLines(text)) > TINY_FILE_MAX_LINES) return stub;
    const producedClassDeclaration = path.posix.basename(relPath).replace(/\.[^.]+$/, "").toLowerCase() === producerStem;
    if (!producedClassDeclaration) {
      if (bytes > completeBodyBudget.left) return stub;
      completeBodyBudget.left -= bytes;
    }
    return TINY_FILE_MAX_BYTES;
  };
  const reviewSurfaces = resolution.reviewPaths.map((relPath) =>
    ensure(relPath, semanticTokenForPath(resolution, relPath), false, reviewBodyBytesFor(relPath))
  );
  if (
    sourceSurface === undefined
    || adapterSurface === undefined
    || editSurfaces.some((surface) => surface === undefined)
    || reviewSurfaces.some((surface) => surface === undefined)
  ) {
    return undefined;
  }
  sourceSurface.required = true;
  adapterSurface.required = true;
  // A constructed receiver may instead live inside the host object, whose
  // input handlers see each sample once (the resolver's required_action). Its
  // implementation is then review evidence, a window at the input handler,
  // and an alternate site for the receiver checks. Optional: added only while
  // the surface cap has room, so it never displaces a certified surface.
  const hostImplementationPath = resolution.host.implementationPath;
  const hostImplementationAnchor = resolution.host.implementationAnchor;
  const hostImplementationSurface = !isConstructReceiver
    || hostImplementationPath === undefined
    || hostImplementationAnchor === undefined
    ? undefined
    : surfaces.find((surface) => surface.path === hostImplementationPath)
      ?? (surfaces.length < MAX_SEMANTIC_WIRING_SURFACES
        ? ensure(hostImplementationPath, hostImplementationAnchor, false, reviewEvidenceBytes, 0)
        : undefined);
  const consumerSurface = surfaces.find((surface) => surface.path === resolution.consumer.path);
  const insertionSurface = surfaces.find((surface) => surface.path === resolution.insertion.path);
  const hostSurface = surfaces.find((surface) => surface.path === resolution.host.path);
  const carrierSurface = surfaces.find((surface) => surface.path === resolution.carrier.path);
  if (consumerSurface === undefined || insertionSurface === undefined || hostSurface === undefined || carrierSurface === undefined) {
    return undefined;
  }
  const insertionText = readCached(workspace, insertionSurface.path, cache);
  if (insertionText === undefined) return undefined;
  const insertionLines = [
    resolution.host.producerEntryLine,
    ...(resolution.host.producerPublishLine !== undefined ? [resolution.host.producerPublishLine] : []),
    resolution.insertion.line,
  ];
  const insertionLineCount = Math.max(1, countLines(insertionText));
  const insertionRange = resolution.connectionMode === "construct-receiver"
    ? `1-${insertionLineCount}`
    : `${Math.max(1, Math.min(...insertionLines) - 20)}-${Math.min(insertionLineCount, Math.max(...insertionLines) + 40)}`;
  // B2a: a construct-receiver hub that fits the completeness bar is served
  // WHOLE. The anchored excerpt (6KB of a 17.7KB hub, with honest
  // remaining_ranges) was still the single strongest trigger for a native
  // full-read: all three T13 reps opened with `mode=full` of this exact file.
  // Only a hub too big for the bar keeps the excerpt.
  const insertionBytes = Buffer.byteLength(insertionText, "utf8");
  const insertionWhole = isConstructReceiver
    && insertionBytes <= WIRING_COMPLETE_SURFACE_BYTES
    && (insertionBytes <= TINY_FILE_MAX_BYTES || reserved.has(resolution.insertion.path))
    ? centeredSliceForCap(
        workspace,
        insertionSurface.path,
        `1-${insertionLineCount}`,
        cache,
        undefined,
        WIRING_COMPLETE_SURFACE_BYTES,
      )
    : undefined;
  const insertionCode: { code: string; remaining_ranges: string[]; edit_hunk_ranges?: string[] } | undefined
    = insertionWhole !== undefined && insertionWhole.remaining_ranges.length === 0
    ? insertionWhole
    : resolution.connectionMode === "construct-receiver"
    ? semanticConstructionHubExcerpt(
        insertionText,
        insertionSurface.path,
        insertionLines,
      )
    : centeredSliceForCap(
        workspace,
        insertionSurface.path,
        insertionRange,
        cache,
        Math.round((Math.min(...insertionLines) + Math.max(...insertionLines)) / 2),
        8192,
      );
  // Wave 4: a construct-receiver hub excerpt with disclosed remaining_ranges
  // is served (content_completeness:"partial" below), not vetoed — the old
  // bail was dead code while the excerpt hard-claimed remaining_ranges:[] and
  // would otherwise discard the entire wiring pack over honest disclosure.
  if (insertionCode === undefined) return undefined;
  // A2 (v0.12): the whole-file sibling of the excerpt path. A hub inside the
  // completeness bar is served entire, but still comment-elided — so the exact
  // anchor over the wiring site can be the same `elided-content` placeholder.
  // Re-emit that one bounded landing window verbatim; everything outside it,
  // and every non-construct-receiver hub, is untouched.
  if (
    isConstructReceiver
    && insertionWhole !== undefined
    && insertionCode === insertionWhole
  ) {
    const wholeHunks = hubEditHunkRanges(insertionText.split(/\r?\n/), insertionLines);
    const rebuilt = wholeHunks === undefined
      ? undefined
      : wholeHubWithVerbatimLanding(insertionText, insertionSurface.path, insertionCode.code, wholeHunks);
    if (rebuilt !== undefined && wholeHunks !== undefined) {
      insertionCode.code = rebuilt;
      insertionCode.edit_hunk_ranges = wholeHunks.map((hunk) => `${hunk.start}-${hunk.end}`);
    }
  }
  insertionSurface.range = insertionRange;
  insertionSurface.handle = handleTable.upsert({
    kind: "range",
    path: insertionSurface.path,
    range: insertionRange,
    workspaceRoot: workspace,
  }).id;
  insertionSurface.code = insertionCode.code;
  insertionSurface.symbol = unqualifiedCallable(resolution.insertion.symbol);
  if (resolution.connectionMode === "construct-receiver") {
    insertionSurface.why = "semantic wiring receiver-construction hub; obey wiring.connections[0].required_action";
  }
  // A2 live engagement counter (trace-only, zero wire bytes). One line per FIRE,
  // so a probe can preregister `edit_hunk_frontier` occurrences per cell as the
  // discriminating signature instead of inferring engagement from cost.
  if (insertionCode.edit_hunk_ranges !== undefined && insertionCode.edit_hunk_ranges.length > 0) {
    trace(
      "edit_hunk_frontier",
      {
        path: insertionSurface.path,
        mode: resolution.connectionMode,
        hunks: insertionCode.edit_hunk_ranges.length,
        hunk_ranges: insertionCode.edit_hunk_ranges,
        anchor_lines: insertionLines,
        hub_bytes: insertionBytes,
        served_bytes: Buffer.byteLength(insertionCode.code, "utf8"),
      },
      workspace,
    );
  }
  if (insertionCode.remaining_ranges.length > 0) {
    if (resolution.connectionMode === "construct-receiver") {
      // 2026-07-25 honest-hub fix (supersedes the Wave-4 label suppression):
      // the excerpt IS partial content and now says so. What protects the
      // receiver-construction certificate is anchors_served — the evidence
      // graph proves every anchor line sits inside the served ranges, so the
      // readiness risk model exempts this surface from the
      // partial-surface-content factor instead of the label lying (which
      // trained solvers to distrust coverage and re-probe natively).
      insertionSurface.content_completeness = "partial";
      insertionSurface.anchors_served = true;
      insertionSurface.remaining_ranges = insertionCode.remaining_ranges;
    } else {
      insertionSurface.content_completeness = "partial";
      insertionSurface.remaining_ranges = insertionCode.remaining_ranges;
    }
  } else {
    delete insertionSurface.content_completeness;
    delete insertionSurface.remaining_ranges;
  }
  const source = endpointFromSurface(
    unqualifiedCallable(resolution.producer.symbol),
    sourceSurface,
    ["query-token", "workspace-definition", "project-family"],
  );
  const destination = endpointFromSurface(
    unqualifiedCallable(resolution.consumer.symbol),
    consumerSurface,
    ["query-token", "workspace-definition", "project-family"],
  );
  const graph = buildSemanticEvidenceGraph(
    resolution,
    source,
    destination,
    insertionSurface,
    adapterSurface,
    hostSurface,
    carrierSurface,
  );
  const editFrontier = resolution.editPaths
    .map((relPath) => surfaces.find((surface) => surface.path === relPath)?.handle)
    .filter((handle): handle is string => handle !== undefined);
  const reviewFrontier = reviewSurfaces
    .filter((surface): surface is TaskPackSurface => surface !== undefined)
    .map((surface) => surface.handle);
  if (
    hostImplementationSurface !== undefined
    && !editFrontier.includes(hostImplementationSurface.handle)
    && !reviewFrontier.includes(hostImplementationSurface.handle)
  ) {
    reviewFrontier.push(hostImplementationSurface.handle);
  }
  // R5 (2026-08-01, wont-fix): the K2 relevance gate's precise-diff
  // `changedIdentifiers` threading (server.ts buildVerificationBody) is
  // deliberately NOT wired here — no edit args exist at pack time, and this
  // call already anchors the kit on the producer/adapter symbols via
  // behaviorAnchors, which is the same signal with better provenance. The
  // edited-file-content proxy inside collectChangedIdentifiers covers the
  // rest; threading a second identifier list would add plumbing, not
  // precision.
  // A semantic wiring frontier is actionable only when every edit site has
  // been resolved, regardless of whether its receiver already exists or must
  // be constructed. This compact, server-internal completion contract forces
  // recipe discovery explicitly (it survived the deleted response-wide
  // TL_VERIFICATION_RECIPE experiment as the machinery's one real consumer);
  // only a recipe with a workspace-proven entry reaches the wire below.
  const completionManifest = buildVerificationManifest(workspace, resolution.editPaths, {
    forceRecipe: true,
    behaviorAnchors: [
      unqualifiedCallable(resolution.producer.symbol),
      unqualifiedCallable(resolution.adapter.symbol),
    ],
  });
  const completionRecipeRaw = completionManifest?.recipe;
  const completionRecipe = completionRecipeRaw?.entry === undefined
    ? undefined
    : {
      ...completionRecipeRaw,
      compile_targets: completionRecipeRaw.compile_targets
        .filter((target) =>
          resolution.editPaths.includes(target)
          || /(^|\/)(?:test|tests|__tests__)(\/|$)/.test(target)
        )
        .slice(0, 8),
      ...(completionRecipeRaw.assertion_refs !== undefined
        ? { assertion_refs: completionRecipeRaw.assertion_refs.slice(0, 2) }
        : {}),
      ...(completionRecipeRaw.contract_refs !== undefined
        ? { contract_refs: completionRecipeRaw.contract_refs.slice(0, 2) }
        : {}),
      ...(completionRecipeRaw.mock_controls !== undefined
        ? {
          mock_controls: completionRecipeRaw.mock_controls
            .filter((ref) => !/#.+_(?:H|HPP)$/.test(ref))
            .slice(0, 3),
        }
        : {}),
    };
  // required_action tells clients to execute completion_proof.verification.entry;
  // only a manifest with a workspace-proven runnable entry can satisfy that
  // demand, so a recipe containing only gaps never reaches this contract.
  const completionVerification = completionRecipe ?? harnessEntryRecipe(completionManifest, resolution.editPaths);
  const structuralChecks = resolution.structuralChecks?.map((check) => {
    const alternateHandles = (check.alternatePaths ?? [])
      .map((alternate) => surfaces.find((surface) => surface.path === alternate)?.handle)
      .filter((handle): handle is string => handle !== undefined);
    return {
      id: check.id,
      description: check.description,
      handle: surfaces.find((surface) => surface.path === check.path)!.handle,
      ...(alternateHandles.length > 0 ? { alternate_handles: alternateHandles } : {}),
      tokens: check.tokens,
    };
  });
  return {
    version: 1,
    strategy: "semantic-multihop",
    status: "ready",
    connections: [{
      id: "w1",
      status: "ready",
      mode: resolution.connectionMode,
      ...(resolution.requiredAction !== undefined ? { required_action: resolution.requiredAction } : {}),
      ...(resolution.receiverSearch !== undefined ? {
        receiver_search: {
          scope: resolution.receiverSearch.scope,
          files_scanned: resolution.receiverSearch.filesScanned,
          producer_type: resolution.receiverSearch.producerType,
          scope_complete: resolution.receiverSearch.scopeComplete,
          existing_receiver_found: resolution.receiverSearch.existingReceiverFound,
        },
      } : {}),
      ...(resolution.lifecycleSymbols !== undefined ? { lifecycle_symbols: resolution.lifecycleSymbols } : {}),
      ...(resolution.consumer.adapterCallMode === "construct" ? {
        consumer_call: {
          mode: "construct" as const,
          adapter_symbol: resolution.adapter.symbol,
          insertion_anchor: resolution.consumer.symbol,
          symbol: `${resolution.consumer.owner}::${resolution.consumer.constructionSymbol!}`,
        },
      } : {}),
      // Existing-receiver routes need not add receiver-construction checks,
      // but an independently discovered executable verification recipe is
      // still an actionable completion contract. Keep the required structural
      // checks carrier explicit (empty when none applies).
      ...(structuralChecks !== undefined || completionVerification !== undefined ? {
        completion_proof: {
          structural_checks: structuralChecks ?? [],
          ...(completionVerification !== undefined ? { verification: completionVerification } : {}),
        },
      } : {}),
      source,
      destination,
      insertion_handle: insertionSurface.handle,
      supporting_handles: reviewFrontier.filter((handle) => handle !== source.handle),
      confidence: 0.92,
      evidence: [
        "query-token",
        "workspace-definition",
        "project-family",
        "closure-check",
        "callable-insertion-site",
        ...(resolution.connectionMode === "construct-receiver" ? ["receiver-construction-site" as const] : []),
      ],
      evidence_ids: graph.relations.map((relation) => relation.id),
    }],
    missing: [],
    edit_frontier: editFrontier,
    review_frontier: reviewFrontier,
    evidence_graph: graph,
  };
}

export function buildTaskWiringProfile(
  query: string,
  surfaces: TaskPackSurface[],
  workspace: string,
  cache?: FileReadCache,
): TaskWiringProfile {
  // D10 (2026-08-14): the semantic resolver always runs first — `TL_SEMANTIC_WIRING`
  // is deleted. The legacy builder remains the fail-closed fallback for the case
  // where the resolver cannot certify a connection, not a flag-selected arm.
  const semantic = buildSemanticTaskWiringProfile(query, surfaces, workspace, cache);
  if (semantic !== undefined) return semantic;
  return buildLegacyTaskWiringProfile(query, surfaces, workspace, cache);
}

export function semanticCompletionCheckRecords(
  wiring: TaskWiringProfile | undefined,
  surfaces: readonly TaskPackResultSurface[],
): PackCheckRecord[] {
  const checks = wiring?.strategy === "semantic-multihop"
    ? wiring.connections[0]?.completion_proof?.structural_checks ?? []
    : [];
  return checks.map((check) => {
    const path = surfaces.find((surface) => surface.handle === check.handle)?.path;
    // An alternate whose surface is not served is dropped, never widened to
    // "any file": an unresolved alternate keeps the check as strict as its
    // primary file.
    const altGlobs = (check.alternate_handles ?? [])
      .map((handle) => surfaces.find((surface) => surface.handle === handle)?.path)
      .filter((alternate): alternate is string => alternate !== undefined && alternate !== path);
    const draft: Omit<PackCheckRecord, "id"> = {
      desc: check.description,
      ...(path !== undefined ? { glob: path } : {}),
      ...(path !== undefined && altGlobs.length > 0 ? { altGlobs } : {}),
      allTokens: check.tokens,
      role: "wiring",
    };
    return { id: deriveCheckId(draft), ...draft };
  });
}

export function pruneIrrelevantWiringImplementationSurfaces(result: TaskPackResult): void {
  if (result.wiring?.status !== "ready") return;
  const frontier = new Set([
    ...result.wiring.edit_frontier,
    ...result.wiring.review_frontier,
  ]);
  result.surfaces = result.surfaces.filter((surface) =>
    isArtifactTaskPackSurface(surface)
    || frontier.has(surface.handle)
    || !isImplementationPath(surface.path)
  );
}

export function obligationKindForRole(
  role: string,
  sourceHandle: string | undefined,
  destinationHandle: string | undefined,
  handle: string,
): TaskChangeObligationKind {
  if (handle === sourceHandle) return "source";
  if (handle === destinationHandle) return "integration";
  switch (role) {
    case "contract": return "definition";
    case "api": return "integration";
    case "domain": return "implementation";
    case "data": return "persistence";
    case "ui": return "presentation";
    case "style": return "style";
    case "config": return "configuration";
    case "doc": return "documentation";
    case "test": return "verification";
    default: return "implementation";
  }
}
