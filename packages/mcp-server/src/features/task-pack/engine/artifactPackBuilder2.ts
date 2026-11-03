// artifactPackBuilder — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { ArtifactBuildExtraction } from "./literalAndConcernSeeds.js";
import type { ArtifactTaskPackSection } from "../model.js";
import type { ContinuationCall } from "./packBasics.js";
import type { MintedArtifactSurface } from "./packBasics2.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { ARTIFACT_CONSUMER_RESERVE_BYTES } from "../artifactConsumers.js";
import { ARTIFACT_CONSUMER_TOTAL_BYTES } from "../artifactConsumers.js";
import { ARTIFACT_EXT_SET } from "./packBasics2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_INLINED_ARTIFACT_SURFACES } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { artifactBuildRelevance } from "./artifactPackBuilder.js";
import { artifactNamedByQuery } from "./artifactPackBuilder.js";
import { artifactSectionCandidates } from "../artifactSections.js";
import { artifactSectionText } from "../artifactConsumers.js";
import { capForResult } from "./packState.js";
import { classifySurface } from "../../../util/impact.js";
import { commonDirectory } from "../artifactConsumers.js";
import { extractArtifactBuildSection } from "./artifactPackBuilder.js";
import { fitsInCap } from "./packTrimming2.js";
import { handleTable } from "../../../util/handles.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { languageForPath } from "../../../util/languages.js";
import { markArtifactConsumerSurface } from "../artifactConsumers.js";
import { moduleShapedQueryTokens } from "./queryIntent4.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { normalizePathEntry } from "./packBasics2.js";
import { normalizedRequestPath } from "./guideAndArtifactSurfaces.js";
import { packWireBytes } from "./packTrimming.js";
import { packageRootOf } from "../artifactConsumers.js";
import { planArtifactConsumers } from "../artifactConsumers.js";
import { readCached } from "./packBasics2.js";
import { requestedArtifactKinds } from "./artifactPackBuilder.js";
import { safeResolve } from "../../../util/safePath.js";
import { sliceCode } from "./packBasics2.js";
import { symbolCollectorSupports } from "../../../symbols/collectSymbols.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

export function selectArtifactBuildInputs(
  artifacts: readonly MintedArtifactSurface[],
  query: string,
  args: TaskPackArgs,
): MintedArtifactSurface[] {
  const explicitlyNamed = [
    ...(args.path ? [args.path] : []),
    ...(args.paths ?? []).map(normalizePathEntry).map((entry) => entry.path),
  ]
    .map(normalizedRequestPath)
    .filter((artifactPath) => ARTIFACT_EXT_SET.has(path.extname(artifactPath).toLowerCase()));
  if (explicitlyNamed.length > 0) {
    const byPath = new Map(
      artifacts.map((artifact) => [
        normalizedRequestPath(artifact.surface.path),
        artifact,
      ] as const),
    );
    const selected: MintedArtifactSurface[] = [];
    const seen = new Set<string>();
    for (const artifactPath of explicitlyNamed) {
      if (seen.has(artifactPath)) continue;
      const artifact = byPath.get(artifactPath);
      if (artifact !== undefined) {
        selected.push(artifact);
        seen.add(artifactPath);
      }
    }
    if (selected.length > 0) return selected.slice(0, 4);
  }

  const ranked = [...artifacts].sort((a, b) =>
    artifactBuildRelevance(b.file, args, query) - artifactBuildRelevance(a.file, args, query)
      || a.surface.path.localeCompare(b.surface.path)
  );
  const requested = requestedArtifactKinds(query);
  const byKind = requested
    .map((kind) => ranked.find((artifact) => artifact.surface.artifactKind === kind))
    .filter((artifact): artifact is MintedArtifactSurface => artifact !== undefined);
  // B2f (2026-08-01 serving-completeness): the kind-based pick takes at most ONE
  // artifact per requested KIND, so a task naming two independent inputs of the
  // same kind lost one of them. Live defect (2026-07-31-semantic-signal5-2,
  // T10): the occupation-code workbook was already a listed pack SURFACE with an
  // `extract` hint, yet artifact_requirements named only the rate table and the
  // methodology doc — so every rep paid one extra mode=artifact call for an
  // input axis the task text had spelled out. Any artifact the QUERY names by
  // token is an input axis and joins the requirement set, whatever its kind.
  const selected = [...byKind];
  const chosen = new Set(selected.map((artifact) => artifact.surface.path));
  for (const artifact of ranked) {
    if (selected.length >= MAX_INLINED_ARTIFACT_SURFACES) break;
    if (chosen.has(artifact.surface.path)) continue;
    if (!artifactNamedByQuery(artifact.file, query)) continue;
    selected.push(artifact);
    chosen.add(artifact.surface.path);
  }
  if (selected.length > 0) return selected;
  return requested.length === 0 ? ranked.slice(0, 1) : [];
}

export interface ExtractedArtifactSection {
  artifact: MintedArtifactSurface;
  extraction: ArtifactBuildExtraction & { section: ArtifactTaskPackSection; sectionId: string };
}

export function artifactSectionStamp(item: ExtractedArtifactSection): string {
  return `artifact-section:${item.artifact.surface.path}#${item.extraction.sectionId.slice(0, 120)}`;
}

export function fitArtifactSections(
  result: TaskPackResult,
  extracted: readonly ExtractedArtifactSection[],
): Array<{ path: string; section: ArtifactTaskPackSection }> | undefined {
  const variants = extracted.map((item) => artifactSectionCandidates(item.extraction.section));
  let fitted: Array<{ path: string; section: ArtifactTaskPackSection }> | undefined;
  const visit = (index: number, selected: ArtifactTaskPackSection[]): void => {
    if (fitted !== undefined) return;
    if (index < variants.length) {
      for (const section of variants[index] ?? []) visit(index + 1, [...selected, section]);
      return;
    }
    const bundled = selected.map((section, itemIndex) => ({
      path: extracted[itemIndex]!.artifact.surface.path,
      section,
    }));
    const inlined = extracted.map(artifactSectionStamp);
    const candidate: TaskPackResult = bundled.length === 1
      ? { ...result, section: bundled[0]!.section, inlined }
      : { ...result, artifact_sections: bundled, inlined };
    delete candidate.next;
    if (fitsInCap(candidate)) fitted = bundled;
  };
  visit(0, []);
  return fitted;
}

export async function attachArtifactBuildSections(
  result: TaskPackResult,
  artifacts: readonly MintedArtifactSurface[],
  query: string,
  args: TaskPackArgs,
): Promise<{ complete: boolean; truncated: boolean }> {
  const selected = selectArtifactBuildInputs(artifacts, query, args);
  result.artifact_requirements = selected.map((artifact) => artifact.surface.path);
  const extracted: ExtractedArtifactSection[] = [];
  let firstMissingNext: ContinuationCall | undefined;
  for (const artifact of selected) {
    const extraction = await extractArtifactBuildSection(artifact, query);
    if (extraction.section && extraction.sectionId) {
      extracted.push({
        artifact,
        extraction: extraction as ArtifactBuildExtraction & {
          section: ArtifactTaskPackSection;
          sectionId: string;
        },
      });
    } else if (firstMissingNext === undefined) {
      firstMissingNext = extraction.next;
    }
  }

  const requiredCount = Math.max(1, selected.length);
  let fitted = extracted.length > 0 ? fitArtifactSections(result, extracted) : undefined;
  // B2f: step DOWN one section at a time instead of collapsing straight to one.
  // With three named input axes (T10: rate table + occupation codes +
  // methodology) the all-or-one fallback threw away two small sheets to keep a
  // single large one; the small ones are exactly what fits.
  for (let take = extracted.length - 1; fitted === undefined && take >= 1; take--) {
    fitted = fitArtifactSections(result, extracted.slice(0, take));
  }
  if (fitted === undefined || fitted.length === 0) {
    if (firstMissingNext) result.next = firstMissingNext;
    return { complete: false, truncated: false };
  }

  const attached = extracted.slice(0, fitted.length);
  result.inlined = attached.map(artifactSectionStamp);
  if (fitted.length === 1) {
    result.section = fitted[0]!.section;
    delete result.artifact_sections;
  } else {
    result.artifact_sections = fitted;
    delete result.section;
  }
  const complete = fitted.length >= requiredCount && selected.length >= requiredCount;
  if (complete) {
    result.missing = result.missing.filter((item) => item !== "artifact-section");
    delete result.next;
  } else {
    result.next = firstMissingNext ?? extracted[fitted.length]?.extraction.next ?? result.next;
  }
  return {
    complete,
    truncated: fitted.some(({ section }) => section.truncated),
  };
}

export function bundledArtifactPaths(result: TaskPackResult): string[] {
  if (result.artifact_sections) return result.artifact_sections.map(({ path: artifactPath }) => artifactPath);
  if (!result.section) return [];
  const stamped = (result.inlined ?? [])
    .map((stamp) => stamp.match(/^artifact-section:(.+)#/)?.[1])
    .filter((artifactPath): artifactPath is string => artifactPath !== undefined)
    .slice(0, 1);
  if (stamped.length > 0) return stamped;
  return result.surfaces
    .filter(isArtifactTaskPackSurface)
    .map((surface) => surface.path)
    .slice(0, 1);
}

export function hasRequiredArtifactSections(result: TaskPackResult, query: string): boolean {
  const bundled = bundledArtifactPaths(result);
  if (bundled.length === 0) return false;
  const sectionsByPath = new Map(
    result.artifact_sections?.map(({ path: artifactPath, section }) => [
      normalizedRequestPath(artifactPath),
      section,
    ] as const) ?? [],
  );
  if (result.section !== undefined && bundled[0] !== undefined) {
    sectionsByPath.set(normalizedRequestPath(bundled[0]), result.section);
  }
  const meaningful = (section: ArtifactTaskPackSection | undefined): boolean => {
    if (section === undefined) return false;
    if ("sheet" in section) return section.columns.length > 0 && section.rows.length > 0;
    if (section.kind === "docx") {
      return section.sections.reduce((total, item) => total + item.text.trim().length, 0) >= 80;
    }
    if (section.kind === "pptx") {
      return section.slides.reduce((total, item) => total + item.text.trim().length, 0) >= 80;
    }
    return section.pages.reduce((total, item) => total + item.text.trim().length, 0) >= 80;
  };
  const exactRequirements = result.artifact_requirements?.map(normalizedRequestPath) ?? [];
  if (exactRequirements.length > 0) {
    return exactRequirements.every((artifactPath) => meaningful(sectionsByPath.get(artifactPath)));
  }
  const required = requestedArtifactKinds(query);
  if (required.length === 0) return true;
  return required.every((kind) =>
    [...sectionsByPath.entries()].some(([artifactPath, section]) =>
      path.extname(artifactPath).toLowerCase().slice(1) === kind && meaningful(section)
    )
  );
}

/** File stems the request names as an artifact pack's implementation target: its module-shaped tokens and code file names. */
export function queryNamedArtifactTargets(query: string): Set<string> {
  return new Set([
    ...moduleShapedQueryTokens(query).map(normIdent),
    ...(query.match(/[A-Za-z_$][A-Za-z0-9_$.-]*\.(?:c|cc|cpp|cxx|go|java|js|jsx|py|rs|ts|tsx)\b/gi) ?? [])
      .map((fileName) => normIdent(path.basename(fileName, path.extname(fileName)))),
  ]);
}

/**
 * Artifact consumers (artifactConsumers.ts, v0.16 6t-7 T10): the workspace
 * code that already loads or names this pack's required artifacts, as optional
 * windows between the implementation target and the artifact stubs, inside the
 * pack's spare budget. `trimToCap` sheds them first.
 */
export async function attachArtifactConsumerSurfaces(
  result: TaskPackResult,
  workspace: string,
  cache: FileReadCache,
  editTarget: string | undefined,
): Promise<void> {
  const requirements = result.artifact_requirements ?? [];
  if (editTarget === undefined || requirements.length === 0) return;
  if (!symbolCollectorSupports(languageForPath(editTarget) ?? "")) return;
  const sections = result.artifact_sections
    ?? (result.section !== undefined
      ? bundledArtifactPaths(result).slice(0, 1).map((artifactPath) => ({ path: artifactPath, section: result.section! }))
      : []);
  if (sections.length === 0) return;
  // The whole pack is measured with each consumer file added, so the budget
  // is the pack's own: at most ARTIFACT_CONSUMER_TOTAL_BYTES more, and always
  // ARTIFACT_CONSUMER_RESERVE_BYTES under the cap.
  const baseBytes = packWireBytes(result);
  const ceiling = Math.min(
    baseBytes + ARTIFACT_CONSUMER_TOTAL_BYTES,
    capForResult(result) - ARTIFACT_CONSUMER_RESERVE_BYTES,
  );
  if (ceiling <= baseBytes) return;
  const scanRoot = commonDirectory([editTarget, ...requirements]);
  const taken = new Set([editTarget, ...result.surfaces.map((surface) => surface.path)].map(normalizedRequestPath));
  const files = walkCodeFiles(workspace, { ...(scanRoot !== "" ? { subPath: scanRoot } : {}), respectGitignore: true })
    .filter((file) => file.kind === undefined
      && !taken.has(file.relPath)
      && symbolCollectorSupports(languageForPath(file.relPath) ?? ""))
    .map((file) => file.relPath);
  const plans = await planArtifactConsumers({
    editTarget,
    artifacts: requirements,
    servedTexts: sections.map(({ path: artifactPath, section }) => ({
      artifact: artifactPath,
      text: artifactSectionText(section),
    })),
    files,
    packageRoot: packageRootOf(editTarget, scanRoot, (relPath) => {
      const abs = safeResolve(relPath, workspace);
      return abs !== undefined && fs.existsSync(abs);
    }),
    read: (relPath) => readCached(workspace, relPath, cache),
    language: (relPath) => languageForPath(relPath),
    isTest: (relPath) => classifySurface(relPath) === "test",
    symbols: async (relPath, text, language) => (await cache.parsedSymbols(text, language, relPath)) ?? [],
    displayBytes: (relPath, start, end, keepComments) => {
      const code = sliceCode(workspace, relPath, `${start}-${end}`, cache, MAX_SURFACE_CODE_BYTES, keepComments === true);
      return code === undefined ? undefined : Buffer.byteLength(code, "utf8");
    },
  });
  const consumers: TaskPackSurface[] = [];
  for (const plan of plans) {
    const drafts: TaskPackSurface[] = [];
    for (const window of plan.windows) {
      const range = `${window.start}-${window.end}`;
      const code = sliceCode(workspace, plan.path, range, cache, MAX_SURFACE_CODE_BYTES, window.whole === true);
      if (code === undefined) continue;
      drafts.push({
        role: classifySurface(plan.path),
        // Measured with a placeholder of a real handle's length; minted below
        // only for the drafts that fit.
        handle: "h0000000000",
        path: plan.path,
        range,
        required: false,
        ...(drafts.length === 0 ? { why: plan.why } : {}),
        code,
      });
    }
    if (drafts.length === 0) continue;
    if (packWireBytes({ ...result, surfaces: [...result.surfaces, ...consumers, ...drafts] }) > ceiling) continue;
    for (const draft of drafts) {
      draft.handle = handleTable.upsert({
        kind: "range",
        path: draft.path,
        range: draft.range,
        workspaceRoot: workspace,
      }).id;
      markArtifactConsumerSurface(draft);
      consumers.push(draft);
    }
  }
  if (consumers.length === 0) return;
  const firstArtifact = result.surfaces.findIndex((surface) => isArtifactTaskPackSurface(surface));
  (result.surfaces as TaskPackResultSurface[])
    .splice(firstArtifact === -1 ? result.surfaces.length : firstArtifact, 0, ...consumers);
}
