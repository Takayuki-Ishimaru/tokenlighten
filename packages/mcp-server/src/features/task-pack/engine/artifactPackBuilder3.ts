// artifactPackBuilder — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { ImpactSurface } from "@tokenlighten/types";
import type { MintedArtifactSurface } from "./packBasics2.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { ARTIFACT_EXT_SET } from "./packBasics2.js";
import { FileReadCache } from "./packBasics2.js";
import { HIGH_CONFIDENCE_THRESHOLD } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { attachArtifactBuildSections } from "./artifactPackBuilder2.js";
import { attachArtifactConsumerSurfaces } from "./artifactPackBuilder2.js";
import { attachPlanAids } from "./packTrimming2.js";
import { buildCreateTargetNote } from "./queryIntent4.js";
import { candidateToSurface } from "./surfaceMaterialization.js";
import { classifySurface } from "../../../util/impact.js";
import { countLines } from "../../../util/countLines.js";
import { dedupeTrimAndPersist } from "./packSettlement.js";
import { discoverArtifactBuildFiles } from "./artifactPackBuilder.js";
import { locateTaskContext } from "../../locator/locateTaskContext.js";
import { mintArtifactSurface } from "./packBasics2.js";
import { moduleShapedQueryTokens } from "./queryIntent4.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { queryNamedArtifactTargets } from "./artifactPackBuilder2.js";
import { readCached } from "./packBasics2.js";
import { resolveExplicitArtifactCreateTarget } from "./queryIntent4.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

/** DESIGN-v0.9 §8: one artifact extract + one implementation target, no crawl. */
export async function buildArtifactTaskPack(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): Promise<TaskPackResult | undefined> {
  const discovered = discoverArtifactBuildFiles(args, query, workspace);
  if (discovered.length === 0) return undefined;

  const artifacts = discovered
    .slice(0, MAX_SURFACES_DISTINCT)
    .map((file) => mintArtifactSurface(file, workspace, args))
    .filter((artifact): artifact is MintedArtifactSurface => artifact !== undefined);
  if (artifacts.length === 0) return undefined;

  const namedCodeFile = query.match(/\b[A-Za-z_$][A-Za-z0-9_$.-]*\.(?:c|cc|cpp|cxx|go|java|js|jsx|py|rs|ts|tsx)\b/i)?.[0];
  const namedCodeStem = namedCodeFile
    ? path.basename(namedCodeFile, path.extname(namedCodeFile))
    : undefined;
  const targetQuery = args.symbol ?? namedCodeStem ?? moduleShapedQueryTokens(query)[0] ?? query;
  const locatorPath = args.path && !ARTIFACT_EXT_SET.has(path.extname(args.path).toLowerCase())
    ? args.path
    : undefined;
  const locateResult = await locateTaskContext(workspace, {
    action: "locate",
    query: targetQuery,
    ...(locatorPath ? { path: locatorPath } : {}),
    ...(args.symbol ? { symbol: args.symbol } : {}),
    ...(args.lang ? { lang: args.lang } : {}),
    limit: Math.min(args.limit ?? MAX_SURFACES_DISTINCT, MAX_SURFACES_DISTINCT),
  });

  const cache = new FileReadCache();
  const fallbackCandidates: ImpactCandidate[] = !locateResult.hit
    ? (locateResult.candidateDetails ?? []).map((detail) => ({
        path: detail.path,
        line: detail.line,
        range: detail.range,
        ...(detail.symbol ? { symbol: detail.symbol } : {}),
        surface: detail.surface as ImpactSurface,
        why: detail.why,
        confidence: detail.confidence,
        handle: detail.handle,
      }))
    : [];
  const locatedPool: ImpactCandidate[] = locateResult.hit
    ? [...locateResult.primary, ...locateResult.related]
    : fallbackCandidates;
  const exactNamedPath = namedCodeFile
    ? walkCodeFiles(workspace, {}).find((file) =>
        path.basename(file.relPath).toLowerCase() === path.basename(namedCodeFile).toLowerCase()
      )?.relPath
    : undefined;
  const exactNamedContent = exactNamedPath ? readCached(workspace, exactNamedPath, cache) : undefined;
  const exactNamedCandidate: ImpactCandidate | undefined = exactNamedPath && exactNamedContent !== undefined
    ? {
        path: exactNamedPath,
        line: 1,
        range: `1-${countLines(exactNamedContent)}`,
        surface: classifySurface(exactNamedPath),
        why: "filename-match",
        confidence: 1,
        required: true,
      }
    : undefined;
  const candidatePool: ImpactCandidate[] = exactNamedCandidate
    ? [exactNamedCandidate, ...locatedPool.filter((candidate) => candidate.path !== exactNamedCandidate.path)]
    : locatedPool;
  const codeSurfaces: TaskPackSurface[] = [];
  const seenCodePaths = new Set<string>();
  const maxCodeSurfaces = Math.max(
    1,
    Math.min(3, MAX_SURFACES_DISTINCT - artifacts.length),
  );
  for (const candidate of candidatePool) {
    if (codeSurfaces.length >= maxCodeSurfaces) break;
    if (seenCodePaths.has(candidate.path)) continue;
    if (ARTIFACT_EXT_SET.has(path.extname(candidate.path).toLowerCase())) continue;
    const target = await candidateToSurface(
      {
        ...candidate,
        required: codeSurfaces.length === 0,
        confidence: Math.max(candidate.confidence, HIGH_CONFIDENCE_THRESHOLD),
      },
      workspace,
      [],
      query,
      cache,
    );
    if (typeof target.code !== "string" || target.code.length === 0) continue;
    seenCodePaths.add(target.path);
    codeSurfaces.push(target);
  }

  const createTarget = codeSurfaces.length === 0
    ? resolveExplicitArtifactCreateTarget(args, query, workspace)
    : undefined;
  const createNote = codeSurfaces.length === 0
    ? createTarget
      ? `create ${createTarget.path}; the parent directory is uniquely proved by existing package files`
      : buildCreateTargetNote(query, codeSurfaces, workspace)
    : undefined;
  const hasImplementationFrontier = codeSurfaces.length > 0 || createTarget !== undefined;
  const result: TaskPackResult = {
    mode: "task_pack",
    coverage: hasImplementationFrontier ? "focused" : "partial",
    coverage_reason: hasImplementationFrontier ? "single-site" : "missing-roles",
    surfaces: codeSurfaces,
    missing: [
      ...(hasImplementationFrontier ? [] : ["implementation-target"]),
      "artifact-section",
    ],
    route: {
      action: hasImplementationFrontier ? "edit_from_handles" : "locate_missing_surfaces",
      reason: createTarget
        ? "new-file target directory is uniquely proved; fetch bounded artifact sections before creating it"
        : codeSurfaces.length > 0
        ? "implementation target is handle-backed; fetch the bounded artifact section if it is not inlined"
        : "artifact build still needs an implementation target",
      max_additional_tl_calls: 1,
    },
    ...(createNote ? { create_note: createNote } : {}),
    ...(createTarget ? { create_target: createTarget } : {}),
    next: { tool: "tl_read_file", arguments: { mode: "artifact", handle: artifacts[0]!.surface.handle } },
  };
  (result.surfaces as TaskPackResultSurface[]).push(...artifacts.map((artifact) => artifact.surface));

  const bundle = await attachArtifactBuildSections(result, artifacts, query, args);
  if (bundle.complete && result.route && hasImplementationFrontier) {
    result.route = {
      action: "edit_from_handles",
      reason: bundle.truncated
        ? "bounded artifact previews and implementation frontier are bundled; edit without another discovery call"
        : "artifact sections and implementation frontier are bundled for editing",
      max_additional_tl_calls: 0,
    };
  }

  // Only for a target the request itself names (or a proved create target):
  // a locator's guess is still discovery, and its pack stays as small as it was.
  const primary = codeSurfaces[0];
  const consumerTarget = createTarget?.path
    ?? (primary !== undefined
      && queryNamedArtifactTargets(query).has(normIdent(path.basename(primary.path, path.extname(primary.path))))
      ? primary.path
      : undefined);
  if (consumerTarget !== undefined) {
    await attachArtifactConsumerSurfaces(result, workspace, cache, consumerTarget);
  }

  const finalResult = await dedupeTrimAndPersist(workspace, result, {
    protectedSurfaces: new Set(codeSurfaces),
    args,
    artifactSurfacesAlreadyAttached: true,
  });
  // V15-NBR/FUI (2026-09-29): same default-OFF prototypes as buildAnswer-
  // TaskPack/buildSeededTaskPack's tails — see frontierNeighbours.ts/
  // usageInventory.ts's module doc comments. No post-dedup surface mutation
  // follows in this builder, so this is its own final surface set.
  attachPlanAids(finalResult, workspace, query);
  return finalResult;
}

// ---------------------------------------------------------------------------
// A1: caller-supplied paths[] seeding.
//
// mode=pack already honors paths[]; task_pack silently ignored it, so an
// agent that handed task_pack the exact correct files got 0 of them back
// (the locator ran pathless instead and returned cross-fixture/host noise),
// then escaped to native reads. This builds surfaces DIRECTLY from the
// supplied paths — never dropping one, whatever the byte budget does to its
// embedded code — and runs the locator only to fill required roles the seeds
// did not cover, confined to the seeds' own common ancestor directory so it
// cannot reintroduce the same cross-project noise A1 exists to avoid.
// ---------------------------------------------------------------------------

/** Soft cap on how many seeded surfaces may carry embedded code; the rest go handle+skeleton-only. Mirrors MAX_SURFACES_DISTINCT (the same budget the locate path uses) but does NOT bound the seeded surface COUNT — every supplied path still gets a surface. */
export const MAX_SEEDED_CODE_SURFACES = MAX_SURFACES_DISTINCT;

/**
 * EXPERIMENT (TL_PACK_FAIR_TRIM): embed-attempt limit for caller-named paths
 * when trimToCap's water-filling pass shares the byte budget across them.
 * With the legacy limit (6) every 7th+ caller-named file came back body-less
 * no matter how much budget was left (live: 13 named targets -> 6 files at
 * 0 B, each re-requested in a later turn, and a round trip costs far more
 * than the bytes it saves). The byte cap + fair trim now do the bounding, so
 * the attempt limit only has to stop a pathological list.
 */
export const MAX_SEEDED_CODE_SURFACES_FAIR = 16;
