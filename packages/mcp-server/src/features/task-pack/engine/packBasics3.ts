// packBasics — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { ArtifactTaskPackSurface } from "../model.js";
import type { DiscoveredArtifactFile } from "./packBasics2.js";
import type { TaskPackArgs } from "../model.js";
import { ARTIFACT_EXTS } from "../../../tools/walkRepo.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { artifactBuildRelevance } from "./artifactPackBuilder.js";
import { csvLookupEnabled } from "../../../util/flags.js";
import { discoverArtifactFiles } from "../../locator/locateTaskContext.js";
import { discoverNamedLargeCsvFiles } from "../../locator/locateTaskContext.js";
import { mintArtifactSurface } from "./packBasics2.js";
import { normalizePathEntry } from "./packBasics2.js";

/** Mint strict discovery-only surfaces through mode=artifact's file-handle shape. */
export function collectArtifactSurfaces(
  args: TaskPackArgs,
  workspace: string,
): ArtifactTaskPackSurface[] {
  const foundByPath = new Map<string, DiscoveredArtifactFile>();
  const query = args.query ?? args.symbol ?? "";
  const discoverSeed = (seed: string): DiscoveredArtifactFile[] => {
    const explicitArtifact = (ARTIFACT_EXTS as readonly string[])
      .includes(path.posix.extname(seed).toLowerCase());
    return discoverArtifactFiles(workspace, {
      path: seed,
      ...(explicitArtifact ? { includeAll: true } : { query }),
    });
  };
  if (args.paths !== undefined && args.paths.length > 0) {
    for (const entry of args.paths.map(normalizePathEntry)) {
      for (const file of discoverSeed(entry.path)) {
        foundByPath.set(file.relPath, file);
      }
    }
  } else if (args.path) {
    for (const file of discoverSeed(args.path)) foundByPath.set(file.relPath, file);
  } else {
    for (const file of discoverArtifactFiles(workspace, { query })) {
      foundByPath.set(file.relPath, file);
    }
    if (csvLookupEnabled()) {
      for (const file of discoverNamedLargeCsvFiles(workspace, query)) foundByPath.set(file.relPath, file);
    }
  }

  return [...foundByPath.values()]
    .sort((a, b) =>
      artifactBuildRelevance(b, args, query) - artifactBuildRelevance(a, args, query)
        || a.relPath.localeCompare(b.relPath)
    )
    .slice(0, MAX_SURFACES_DISTINCT)
    .map((file) => mintArtifactSurface(file, workspace, args)?.surface)
    .filter((surface): surface is ArtifactTaskPackSurface => surface !== undefined);
}
