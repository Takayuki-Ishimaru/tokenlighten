// wiringEvidence — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ImpactSurface } from "@tokenlighten/types";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { WiringCheckDraft } from "./createAndWiringEndpoints2.js";
import type { WiringEndpoint } from "./createAndWiringEndpoints2.js";
import { FileReadCache } from "./packBasics2.js";
import { READINESS_PROBE_MAX_BYTES } from "./changeAndReadinessEvidence2.js";
import { READINESS_PROBE_MAX_FILES } from "./changeAndReadinessEvidence2.js";
import { WIRING_DEST_ROLE_RANK } from "./createAndWiringEndpoints2.js";
import { WIRING_PROXIMITY_LINES } from "./createAndWiringEndpoints2.js";
import { asImpactSurface } from "./wiringEvidence2.js";
import { bestMappedWiringDest } from "./createAndWiringEndpoints.js";
import { buildAnswerImportEvidenceGraph } from "./wiringEvidence3.js";
import { classifySurface } from "../../../util/impact.js";
import { concreteIdentifierTokens } from "./createAndWiringEndpoints2.js";
import { definedCallableNames } from "./wiringEvidence3.js";
import { explicitWiringRoles } from "./createAndWiringEndpoints2.js";
import { findWiringDestFallback } from "./createAndWiringEndpoints.js";
import { findWiringSourceFallback } from "./createAndWiringEndpoints.js";
import { inferCallableSymbol } from "./readinessFalsification.js";
import { isEligibleWiringSourceRole } from "./createAndWiringEndpoints2.js";
import { isImplementationPath } from "./changeAndReadinessEvidence2.js";
import { isUnderAncestor } from "./seedResolution.js";
import { isWiringIdentifierShape } from "./createAndWiringEndpoints2.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { primaryEnumContextRows } from "../auxiliaryEnumContextIntegration.js";
import { readCached } from "./packBasics2.js";
import { relationCodeOnly } from "./wiringEvidence3.js";
import { requiresRelatedAnswerContext } from "./answerCandidates.js";
import { roleFillScope } from "./roleAndConcernScope.js";
import { servedBodySurfaces } from "./wiringEvidence2.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { structuralWiringDestinationRole } from "./createAndWiringEndpoints2.js";
import { structuralWiringSourceRole } from "./createAndWiringEndpoints2.js";
import { surfaceIndexForToken } from "./createAndWiringEndpoints2.js";
import { tokenizeForEpoch } from "../../../state/session.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { wiringCandidateTokens } from "./createAndWiringEndpoints2.js";
import { wiringSourceAlreadyResolved } from "./createAndWiringEndpoints2.js";
import { workspaceCallableDefinitionPaths } from "./wiringEvidence2.js";

export function buildWiringCooccurrenceCheck(
  query: string,
  surfaces: TaskPackSurface[],
  workspace: string,
): WiringCheckDraft | undefined {
  if (surfaces.length === 0) return undefined;
  const walked = walkCodeFiles(workspace, {}).map((f) => f.relPath);
  const tokens = wiringCandidateTokens(query, walked, surfaces);
  if (tokens.length < 2) return undefined;

  const explicitRoles = explicitWiringRoles(query);
  if (explicitRoles.source !== undefined && explicitRoles.consumer !== undefined) {
    const sourcePaths = workspaceCallableDefinitionPaths(
      explicitRoles.source, walked, workspace, undefined,
    );
    const consumerPaths = workspaceCallableDefinitionPaths(
      explicitRoles.consumer, walked, workspace, undefined,
    );
    if (
      sourcePaths.length >= 1
      && consumerPaths.length === 1
      && sourcePaths[0] !== consumerPaths[0]
    ) {
      const consumerPath = consumerPaths[0]!;
      return {
        desc: "wiring: " + explicitRoles.source
          + " must feed " + explicitRoles.consumer
          + " through " + (explicitRoles.adapter ?? "the existing adapter"),
        tokens: [explicitRoles.source, explicitRoles.consumer],
        proximity: WIRING_PROXIMITY_LINES,
        glob: consumerPath,
        role: structuralWiringDestinationRole(
          consumerPath,
          classifySurface(consumerPath),
        ) ?? "api",
        sourceDir: path.dirname(sourcePaths[0]!),
      };
    }
  }

  // Map each concrete token (in QUERY ORDER) to the FIRST surface whose symbol
  // or path basename contains it (normalized). Keep the surface index so we can
  // require the two ends to be different surfaces with different roles.
  type Mapped = { token: string; surfIdx: number };
  const mapped: Mapped[] = [];
  for (const tok of tokens) {
    const idx = surfaceIndexForToken(tok, surfaces);
    if (idx !== -1) mapped.push({ token: tok, surfIdx: idx });
  }

  const isDestRole = (role: string): boolean => WIRING_DEST_ROLE_RANK[role] !== undefined;

  // ROLE-AWARE pairing (2026-07-11b): the old "source = first-mapped token"
  // rule made the pair DIRECTION depend on query word order — a query that
  // mentions the integration layer first ("… uplink … PLL …") put the
  // api-side token in the source slot, leaving only domain/contract tokens
  // as destinations, i.e. exactly the inverted born-dead shape ("… must
  // reach the filter in its own header") the destination gate exists to prevent. Wiring
  // has an inherent direction: a signal flows FROM domain/contract code
  // INTO the executable integration layer. So the source is the
  // strongest mapped token on a NON-{api,ui} surface: caller-spelled
  // identifiers first, then domain/contract roles, with query order as the
  // deterministic tie-break.
  //
  // 2026-07-12b: when NO mapped token qualifies as that source — `mapped` is
  // empty, or every mapped token is itself dest-role — the OLD code fell
  // back to `mapped[0]` regardless of role (a dest-role token could become
  // `source`, inverting direction) or, if `mapped` was empty outright,
  // bailed before the destination-side workspace fallback below ever ran.
  // Both were the SAME root gap: a served surface was required for the
  // source end even though the destination end had had a workspace fallback
  // since 2026-07-10b. The mapped-source fast path (this branch) is
  // untouched; the two-sided fallback composition lives in the else branch.
  const concreteTokenSet = new Set([
    ...concreteIdentifierTokens(query).map(normIdent),
    ...tokens.filter(isWiringIdentifierShape).map(normIdent),
  ]);
  const hasUnmappedConcrete = tokens.some((token) =>
    concreteTokenSet.has(normIdent(token)) && surfaceIndexForToken(token, surfaces) === -1
  );
  const sourceRoleRank = (role: string): number => {
    if (role === "domain") return 0;
    if (role === "contract" || role === "data") return 1;
    if (role === "config") return 2;
    return 3;
  };
  const callableTokenRank = (entry: Mapped): number => {
    const escaped = entry.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const body = surfaces[entry.surfIdx]!.code ?? "";
    return new RegExp(`\\b${escaped}\\s*\\(`).test(body) ? 0 : 1;
  };
  const sourceTokenRank = (entry: Mapped): number =>
    // A short acronym commonly names the owning type/subsystem while the
    // adjacent callable is the actual producer endpoint (QKF isHealthy).
    // Longer identifiers remain in query order, preserving explicit class
    // endpoints such as EstimatorCore.
    /^[A-Z][A-Z0-9_]{2,3}$/.test(entry.token) ? 1 : 0;
  const definitionBackedSource = (entry: Mapped): boolean => {
    const surface = surfaces[entry.surfIdx]!;
    const token = normIdent(entry.token);
    const symbol = normIdent(surface.symbol ?? "");
    const basename = normIdent(path.basename(surface.path, path.extname(surface.path)));
    return (symbol.length > 0 && (symbol === token || symbol.includes(token)))
      || (basename.length >= 4 && (basename === token || basename.includes(token)))
      || definedCallableNames(servedSurfaceText(surface))
        .some((name) => normIdent(name) === token);
  };
  const mappedSourceEntry = mapped
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      isEligibleWiringSourceRole(surfaces[entry.surfIdx]!.role)
      // Body co-occurrence alone is not a producer definition. In particular,
      // local variables such as `normalSide` must not become cross-file
      // wiring sources merely because the task query and edit body mention
      // them. Fall through to the workspace definition lookup instead.
      && definitionBackedSource(entry)
      && (!hasUnmappedConcrete || concreteTokenSet.has(normIdent(entry.token)))
    )
    .sort((a, b) => {
      const aConcrete = concreteTokenSet.has(normIdent(a.entry.token)) ? 0 : 1;
      const bConcrete = concreteTokenSet.has(normIdent(b.entry.token)) ? 0 : 1;
      return aConcrete - bConcrete
        || sourceTokenRank(a.entry) - sourceTokenRank(b.entry)
        || sourceRoleRank(structuralWiringSourceRole(
          surfaces[a.entry.surfIdx]!.path,
          asImpactSurface(surfaces[a.entry.surfIdx]!.role),
          walked,
        )) - sourceRoleRank(structuralWiringSourceRole(
          surfaces[b.entry.surfIdx]!.path,
          asImpactSurface(surfaces[b.entry.surfIdx]!.role),
          walked,
        ))
        || a.index - b.index;
    })[0]?.entry;

  // Compact, human-readable form of the wiring source's directory for the
  // check's `desc` string: at most the last 2 path segments, so `desc` stays
  // within closureTracking.ts's MAX_DESC_CHARS budget even for deeply-nested
  // source paths. "." (a workspace-root source file) reads as "the workspace
  // root" rather than a bare, easy-to-miss dot. Display-only — satisfaction
  // (closureTracking.ts's isUnderSourceDir) always compares the FULL
  // `sourceDir` field, never this shortened form.
  const shortSourceDirFor = (dir: string): string => {
    if (dir === "" || dir === ".") return "the workspace root";
    const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length <= 2 ? parts.join("/") : parts.slice(-2).join("/");
  };

  const earlyFamilyScope = roleFillScope(surfaces);
  const earlyInFamily = (candidatePath: string): boolean =>
    earlyFamilyScope === "" || earlyFamilyScope === "."
      ? true
      : earlyFamilyScope !== null && isUnderAncestor(candidatePath, earlyFamilyScope);
  const workspaceSource = earlyFamilyScope === null
    ? undefined
    : findWiringSourceFallback(tokens, surfaces, walked, earlyInFamily, workspace);
  const mappedSourceQueryIndex = mappedSourceEntry === undefined
    ? Number.MAX_SAFE_INTEGER
    : tokens.findIndex((token) => normIdent(token) === normIdent(mappedSourceEntry.token));
  const workspaceSourceQueryIndex = workspaceSource === undefined
    ? Number.MAX_SAFE_INTEGER
    : tokens.findIndex((token) => normIdent(token) === normIdent(workspaceSource.token));
  const mappedSourceDefinesToken = mappedSourceEntry !== undefined
    && definedCallableNames(servedSurfaceText(surfaces[mappedSourceEntry.surfIdx]!))
      .some((name) => normIdent(name) === normIdent(mappedSourceEntry.token));
  const workspaceSourceDefinesToken = workspaceSource !== undefined
    && definedCallableNames(readCached(workspace, workspaceSource.path) ?? "")
      .some((name) => normIdent(name) === normIdent(workspaceSource.token));
  if (
    workspaceSource !== undefined
    && (
      (workspaceSourceDefinesToken && !mappedSourceDefinesToken)
      || (
        workspaceSourceDefinesToken === mappedSourceDefinesToken
        && (
          workspaceSourceQueryIndex < mappedSourceQueryIndex
          || (
            workspaceSourceQueryIndex === mappedSourceQueryIndex
            && !mappedSourceDefinesToken
          )
        )
      )
    )
  ) {
    const destination = bestMappedWiringDest(workspaceSource, mapped, surfaces)
      ?? findWiringDestFallback(workspaceSource, tokens, surfaces, walked, earlyInFamily);
    if (destination === undefined || normIdent(workspaceSource.token) === normIdent(destination.token)) {
      return undefined;
    }
    if (wiringSourceAlreadyResolved(workspaceSource.token, workspaceSource.path, workspace, undefined, destination.path)) {
      return undefined;
    }
    return {
      desc: `wiring: ${workspaceSource.token} must be consumed in non-comment code outside ${shortSourceDirFor(path.dirname(workspaceSource.path))} — e.g. in ${path.basename(destination.path)}`,
      tokens: [workspaceSource.token, destination.token],
      proximity: WIRING_PROXIMITY_LINES,
      glob: destination.path,
      role: destination.role,
      sourceDir: path.dirname(workspaceSource.path),
    };
  }

  if (mappedSourceEntry !== undefined) {
    const source = mappedSourceEntry;
    const destCandidates = mapped
      .map((cand, i) => ({
        cand,
        i,
        role: structuralWiringDestinationRole(
          surfaces[cand.surfIdx]!.path,
          asImpactSurface(surfaces[cand.surfIdx]!.role),
        ),
      }))
      .filter(({ cand, role }) =>
        cand.surfIdx !== source.surfIdx &&
        !isUnderAncestor(
          surfaces[cand.surfIdx]!.path,
          path.dirname(surfaces[source.surfIdx]!.path),
        ) &&
        role !== undefined &&
        role !== surfaces[source.surfIdx]!.role &&
        // Hard destination-role gate — see WIRING_DEST_ROLE_RANK.
        isDestRole(role),
      );
    destCandidates.sort((a, b) => {
      const ra = WIRING_DEST_ROLE_RANK[a.role!] ?? 9;
      const rb = WIRING_DEST_ROLE_RANK[b.role!] ?? 9;
      if (ra !== rb) return ra - rb;
      const callableDelta = callableTokenRank(a.cand) - callableTokenRank(b.cand);
      if (callableDelta !== 0) return callableDelta;
      return b.i - a.i;
    });
    const dest: Mapped | undefined = destCandidates[0]?.cand;
    if (dest !== undefined && normIdent(source.token) !== normIdent(dest.token)) {
      const destPath = surfaces[dest.surfIdx]!.path;
      if (wiringSourceAlreadyResolved(source.token, surfaces[source.surfIdx]!.path, workspace, undefined, destPath)) {
        return undefined;
      }
      return {
        desc: `wiring: ${source.token} must be consumed in non-comment code outside ${shortSourceDirFor(path.dirname(surfaces[source.surfIdx]!.path))} — e.g. in ${path.basename(destPath)}`,
        tokens: [source.token, dest.token],
        proximity: WIRING_PROXIMITY_LINES,
        glob: destPath,
        role: structuralWiringDestinationRole(
          destPath,
          asImpactSurface(surfaces[dest.surfIdx]!.role),
        ),
        sourceDir: path.dirname(surfaces[source.surfIdx]!.path),
      };
    }

    // 2026-07-11a: the fallback's destination walk was WORKSPACE-WIDE, so
    // registered checks pointed at the bench harness's own code, mcp-server's
    // test fixtures, and sibling projects (live: 5/5 registrations outside
    // the fixture, all born-dead). A wiring destination must live in the SAME
    // project family as the located surfaces: single-root packs scope to that
    // root, multi-root packs to their common ancestor (roleFillScope — the
    // exact discipline the required-role fill already uses), and with no
    // family anchor at all the fallback stays silent rather than guessing
    // across the workspace. "" (single-project workspace) keeps the walk
    // unscoped, which is then genuinely in-family.
    const familyScope = roleFillScope(surfaces);
    if (familyScope === null) return undefined;
    const inFamily = (p: string): boolean =>
      familyScope === "" || familyScope === "." ? true : isUnderAncestor(p, familyScope);
    const srcEndpoint: WiringEndpoint = {
      token: source.token,
      path: surfaces[source.surfIdx]!.path,
      role: surfaces[source.surfIdx]!.role as ImpactSurface,
    };
    const best = findWiringDestFallback(srcEndpoint, tokens, surfaces, walked, inFamily);
    if (best !== undefined && !wiringSourceAlreadyResolved(srcEndpoint.token, srcEndpoint.path, workspace, undefined, best.path)) {
      return {
        desc: `wiring: ${srcEndpoint.token} must be consumed in non-comment code outside ${shortSourceDirFor(path.dirname(srcEndpoint.path))} — e.g. in ${path.basename(best.path)}`,
        tokens: [srcEndpoint.token, best.token],
        proximity: WIRING_PROXIMITY_LINES,
        glob: best.path,
        role: best.role,
        sourceDir: path.dirname(srcEndpoint.path),
      };
    }
    return undefined;
  }

  // 2026-07-12b: neither endpoint is served — or the ONLY served endpoint is
  // itself dest-role (the live dir-seeded shape: the locator's surfaces missed
  // both the domain source and the consumer destination; see
  // findWiringSourceFallback's doc comment for the concrete repro). Resolve
  // SOURCE against the workspace too, under the identical conservatisms as
  // the destination fallback, then feed it into the SAME destination
  // resolution the mapped-source branch above uses (a mapped dest-role
  // surface first, else the workspace) — composing the two fallback
  // directions instead of re-deriving the pairing rules a third time.
  const familyScope = roleFillScope(surfaces);
  if (familyScope === null) return undefined;
  const inFamily = (p: string): boolean =>
    familyScope === "" || familyScope === "." ? true : isUnderAncestor(p, familyScope);

  const source = findWiringSourceFallback(tokens, surfaces, walked, inFamily, workspace);
  if (source === undefined) return undefined;

  const dest = bestMappedWiringDest(source, mapped, surfaces)
    ?? findWiringDestFallback(source, tokens, surfaces, walked, inFamily);
  if (dest === undefined) return undefined;
  if (normIdent(source.token) === normIdent(dest.token)) return undefined;
  if (wiringSourceAlreadyResolved(source.token, source.path, workspace, undefined, dest.path)) return undefined;

  return {
    desc: `wiring: ${source.token} must be consumed in non-comment code outside ${shortSourceDirFor(path.dirname(source.path))} — e.g. in ${path.basename(dest.path)}`,
    tokens: [source.token, dest.token],
    proximity: WIRING_PROXIMITY_LINES,
    glob: dest.path,
    role: dest.role,
    sourceDir: path.dirname(source.path),
  };
}

/**
 * FX-J (2026-09-03) — THE ONE ANSWER to "which surfaces does this response
 * actually ship bytes for", computed over the FINAL pack object, after every
 * shedding phase (`trimToCap` Phase E's body strip, Phase F's whole-surface
 * splice, and the SF pre-booking seam's withholding).
 *
 * FX-K (2026-09-03, round-15 finding 1) — this is now the projection for BOTH
 * flag states. Round-15 demonstrated the pre-trim booking end to end on the
 * shipped default path: `budget.bytes` is an advertised `tl_read_file` input, so
 * one production call can ship a Phase-E-stripped survivor with no body and
 * `limit.cause:"capped"`, and the next `tl_edit_file` by path lands
 * `edit.applied` against a file whose bytes the response never sent (a
 * never-packed control refuses at the same fence). Gap (o)'s
 * "Phase-E-on-survivor は本番入口から到達不能" was false. The invariant is now
 * unconditional: NO WRITE AUTHORITY WITHOUT SHIPPED BYTES.
 *
 * Every booking producer routes through this: the served-range ledger, the
 * edit gate's admissible union, the cumulative served-surface log (and
 * therefore the next pack's `priorEpochActionFrontier` and its certificate
 * `action_frontier`), the certified working set, and the served pack record.
 * One function so the next producer added downstream cannot disagree with the
 * others about what shipped — round-14 found three independently-derived
 * answers to this question, two of them wrong.
 *
 * `hasServedCode` (not `code !== undefined`) is deliberate: a
 * `code_unchanged` restatement is a legitimate "you already hold these exact
 * bytes" claim, and demotion never applies to one (`demotionEligibleNow`
 * refuses a surface carrying `code_unchanged`).
 */
export function shippedSurfaces(result: TaskPackResult): TaskPackSurface[] {
  // v0.16.0 release verification (T22): the auxiliary enum-context exclusion
  // lives HERE, in the one projection, so the booking pass keeps its single
  // `const shipped = shippedSurfaces(returned);` form and the answer pack's
  // post-augmenter re-booking (the second call site) cannot disagree with it
  // about which rows are primary. Auxiliary rows do not become cumulative role
  // coverage, a certified working set or primary edit bookings; their exact
  // served range is captured on another path (`recordPackServedRanges`) and
  // `captureServedPack` retains their actual source.
  return primaryEnumContextRows(servedBodySurfaces(result));
}

/** One bounded definition -> direct-call hop to a concrete consumer body. */
export function workspaceCallConsumer(
  definitionSurface: TaskPackSurface | undefined,
  walked: ReadonlyArray<string>,
  workspace: string,
  cache: FileReadCache | undefined,
  familyScope: string | null,
  query: string,
): WiringEndpoint | undefined {
  if (definitionSurface === undefined || familyScope === null) return undefined;
  const definition = readCached(workspace, definitionSurface.path, cache)
    ?? definitionSurface.code
    ?? definitionSurface.code_unchanged
    ?? "";
  const callables = definedCallableNames(definition);
  if (callables.length === 0) return undefined;
  const queryTerms = tokenizeForEpoch(query).filter((term) => term.length >= 4).slice(0, 32);
  const candidates: Array<WiringEndpoint & { score: number }> = [];
  let filesRead = 0;
  let bytesRead = 0;
  for (const relPath of walked) {
    if (filesRead >= READINESS_PROBE_MAX_FILES || bytesRead >= READINESS_PROBE_MAX_BYTES) break;
    if (relPath === definitionSurface.path || !isImplementationPath(relPath)) continue;
    if (familyScope !== "" && familyScope !== "." && !isUnderAncestor(relPath, familyScope)) continue;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    filesRead++;
    bytesRead += Buffer.byteLength(content, "utf8");
    const code = relationCodeOnly(content);
    for (const callable of callables) {
      const escaped = callable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`\\b${escaped}\\s*\\(`).exec(code);
      if (match === null) continue;
      const prefix = code.slice(0, match.index);
      const line = prefix.split(/\r?\n/).length;
      const bodyNorm = normIdent(code);
      const pathNorm = normIdent(relPath);
      const contextScore = queryTerms.filter((term) =>
        bodyNorm.includes(normIdent(term)) || pathNorm.includes(normIdent(term))
      ).length;
      candidates.push({
        token: callable,
        path: relPath,
        role: structuralWiringDestinationRole(relPath, classifySurface(relPath)) ?? "api",
        score: 10 + contextScore * 2 + (inferCallableSymbol(content, line) ? 2 : 0),
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  if (candidates.length === 0) return undefined;
  if (candidates[1] !== undefined && candidates[1]!.score === candidates[0]!.score) return undefined;
  const { score: _score, ...endpoint } = candidates[0]!;
  return endpoint;
}

export function attachAnswerImportEvidenceGraph(
  result: TaskPackResult,
  query: string,
  workspace: string,
  cache: FileReadCache | undefined,
): void {
  if (!requiresRelatedAnswerContext(query) || result.wiring !== undefined) return;
  const graph = buildAnswerImportEvidenceGraph(result.surfaces, workspace, cache);
  if (graph === undefined) return;
  // This graph attests to an observed answer relationship only.  It is not a
  // writable wiring contract, so keep the answer profile and its route intact.
  result.wiring = {
    version: 1,
    status: "needs-followup",
    connections: [],
    missing: [],
    edit_frontier: [],
    review_frontier: [],
    evidence_graph: graph,
    note: "read-only graph over exact imports between served answer surfaces",
  };
}
