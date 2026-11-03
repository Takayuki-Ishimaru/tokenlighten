// seedAdmission — extracted implementation; imports point to the owning modules.
import type { TaskPackArgs } from "../model.js";
import { artifactPrefetchKey } from "./guideAndArtifactSurfaces.js";
import { artifactSectionPrefetch } from "./guideAndArtifactSurfaces.js";
import { commandLiteralAnswerTarget } from "./anchorFocus.js";
import { needsQueryCandidateSelection } from "../queryCandidatePolicy.js";
import { queryNamedWorkspaceFiles } from "./queryIntent3.js";
import { queryNamesCreateTarget } from "./createAndWiringEndpoints.js";
import { shouldRedirectToOverview } from "./partialPackBuilder.js";

export function queryCandidateSelectionRequired(args: TaskPackArgs, workspace: string): boolean {
  // The default public query route owns this policy. Explicit legacy modes and
  // internal builder calls retain their established contract.
  if (args.queryCandidatePolicy !== "unanchored") return false;
  // Caller-selected scopes are intentional entry points, including directories.
  if (args.path !== undefined || (args.paths?.length ?? 0) > 0) return false;
  const query = args.query ?? "";
  // Reuse existing request grammar and actual command resolution, rather than
  // widening every project/class name or adding a second intent vocabulary.
  if (shouldRedirectToOverview(args, query)
    || commandLiteralAnswerTarget(query, workspace) !== undefined) return false;
  return needsQueryCandidateSelection(args, {
    namedFile: queryNamedWorkspaceFiles(query, workspace).length > 0
      || queryNamesCreateTarget(query, workspace),
    artifact: (artifactSectionPrefetch.get(artifactPrefetchKey(workspace))?.entries.length ?? 0) > 0,
  });
}
