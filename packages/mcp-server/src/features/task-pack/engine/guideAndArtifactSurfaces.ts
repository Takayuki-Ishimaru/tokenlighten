// guideAndArtifactSurfaces — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { ArtifactBuildExtraction } from "./literalAndConcernSeeds.js";
import type { ArtifactTaskPackSection } from "../model.js";
import type { ArtifactTaskPackSectionEntry } from "../model.js";
import type { ArtifactTaskPackSurface } from "../model.js";
import type { ContinuationCall } from "./packBasics.js";
import type { GenericTaskPackFallback } from "./guideAndArtifactSurfaces2.js";
import type { MintedArtifactSurface } from "./packBasics2.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackResultSurface } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import type { TaskProfile } from "@tokenlighten/types";
import type { ToolCall } from "@tokenlighten/types";
import { ARTIFACT_EXT_SET } from "./packBasics2.js";
import { ARTIFACT_SURFACE_INLINE_CAP_BYTES } from "./packBasics2.js";
import { ARTIFACT_SURFACE_INLINE_TOTAL_BYTES } from "./packBasics2.js";
import { CSV_LOOKUP_SAMPLE_ROWS } from "./packBasics2.js";
import { CSV_SURFACE_SAMPLE_ROWS } from "./packBasics2.js";
import { MAX_INLINED_ARTIFACT_SURFACES } from "./packBasics2.js";
import { MAX_REMAINING_SECTION_IDS } from "./packBasics2.js";
import { MAX_SURFACES_DISTINCT } from "./packBasics2.js";
import { MAX_TASK_PACK_BYTES_ARTIFACT_BUNDLE } from "./packBasics.js";
import { SENTINEL_END } from "@tokenlighten/agents-md";
import { SENTINEL_START } from "@tokenlighten/agents-md";
import { artifactSectionEntryIds } from "../artifactSections.js";
import { boundedWorkspaceText } from "./seedAdmission.js";
import { capForResult } from "./packState.js";
import { codeTaskPackSurfaces } from "../artifactSections.js";
import { collectArtifactSurfaces } from "./packBasics3.js";
import { concernAnchorTokens } from "./roleAndConcernScope3.js";
import { concreteIdentifierTokens } from "./createAndWiringEndpoints2.js";
import { createScanContentCache } from "../../search/find/findText.js";
import { createWalkOmissions } from "../../../tools/walkRepo.js";
import { csvLookupAnswersRequest } from "../../../office/csvLookup.js";
import { csvLookupComplete } from "../artifactSections.js";
import { csvSampleEnabled } from "../../../util/flags.js";
import { currentSessionLane } from "../../../util/laneKey.js";
import { extractArtifactBuildSection } from "./artifactPackBuilder.js";
import { fitArtifactSectionToBytes } from "../artifactSections.js";
import { genericTextDiscoveryEnabled } from "../../../tools/walkRepo.js";
import { isArtifactTaskPackSurface } from "../artifactSections.js";
import { isDirectoryWithin } from "./seedResolution.js";
import { normalizePathEntry } from "./packBasics2.js";
import { orderedUniqueTokens } from "./roleAndConcernScope2.js";
import { plainCsvCutNote } from "../artifactSections.js";
import { plainCsvLookupNote } from "../artifactSections.js";
import { plainCsvSample } from "../artifactSections.js";
import { plainCsvSampleNote } from "../artifactSections.js";
import { queryWindowSectionNote } from "../artifactSections.js";
import { requestedArtifactKinds } from "./artifactPackBuilder.js";
import { scanLiteral } from "../../search/find/findText.js";
import { statReadTargetSync } from "../../../util/safePath.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";

export const AGENT_GUIDE_PRIORITY = new Map<string, number>([
  ["agents.md", 0],
  ["claude.md", 1],
]);

export function normalizedRequestPath(value: string): string {
  return value.replace(/\\\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
}

/**
 * Keep one same-directory agent guide by default so equivalent AGENTS/CLAUDE
 * sections do not consume two pack slots. Exact caller-named files remain
 * authoritative: naming both keeps both, while naming one makes it win.
 */
export function dedupeAgentGuideSurfaces(
  surfaces: TaskPackSurface[],
  args?: TaskPackArgs,
): TaskPackSurface[] {
  const explicitlyNamed = new Set<string>();
  if (args?.path) {
    const requested = normalizedRequestPath(args.path);
    if (AGENT_GUIDE_PRIORITY.has(path.posix.basename(requested))) explicitlyNamed.add(requested);
  }
  for (const entry of args?.paths?.map(normalizePathEntry) ?? []) {
    const requested = normalizedRequestPath(entry.path);
    if (AGENT_GUIDE_PRIORITY.has(path.posix.basename(requested))) explicitlyNamed.add(requested);
  }

  const groups = new Map<string, TaskPackSurface[]>();
  for (const surface of surfaces) {
    const normalized = normalizedRequestPath(surface.path);
    if (!AGENT_GUIDE_PRIORITY.has(path.posix.basename(normalized))) continue;
    const dir = path.posix.dirname(normalized);
    groups.set(dir, [...(groups.get(dir) ?? []), surface]);
  }

  const dropped = new Set<string>();
  for (const guides of groups.values()) {
    if (guides.length < 2) continue;
    const named = guides.filter((guide) => explicitlyNamed.has(normalizedRequestPath(guide.path)));
    const keep = new Set(
      (named.length > 0 ? named : [guides.reduce((best, guide) => {
        const bestRank = AGENT_GUIDE_PRIORITY.get(path.posix.basename(best.path.toLowerCase())) ?? 99;
        const rank = AGENT_GUIDE_PRIORITY.get(path.posix.basename(guide.path.toLowerCase())) ?? 99;
        return rank < bestRank ? guide : best;
      })]).map((guide) => guide.handle),
    );
    for (const guide of guides) if (!keep.has(guide.handle)) dropped.add(guide.handle);
  }
  return dropped.size === 0 ? surfaces : surfaces.filter((surface) => !dropped.has(surface.handle));
}

// ---------------------------------------------------------------------------
// FX-M Change A (TL_PACK_GUIDE_ELIDE, 2026-09-19): elide the redundant
// TokenLighten-managed guide block from a served agent-guide surface. Kept
// deliberately separate from dedupeAgentGuideSurfaces/AGENT_GUIDE_PRIORITY
// just above -- that logic keeps ONE guide surface per directory when two
// resolve there; this one shrinks whichever guide surface(s) DO end up
// served, regardless of how many there are.
// ---------------------------------------------------------------------------

/**
 * Basenames (case-insensitive) that qualify a surface for guide-block
 * elision regardless of directory, plus the exact repo-relative paths of the
 * per-host rule-file mirrors whose bare basenames ("tokenlighten.md",
 * "tokenlighten.mdc") are not distinctive enough to match on their own. ONE
 * constant, deliberately: a file that merely CONTAINS the sentinel text but
 * is not on this list (a spec/fixture in this very repo, for instance) must
 * never be elided.
 */
export const AGENT_GUIDE_ELIDE_BASENAMES: ReadonlySet<string> = new Set([
  "agents.md",
  "claude.md",
  "claude.local.md",
  "gemini.md",
]);

export const AGENT_GUIDE_ELIDE_PATHS: ReadonlySet<string> = new Set([
  ".github/copilot-instructions.md",
  ".cursor/rules/tokenlighten.mdc",
  ".clinerules/tokenlighten.md",
  ".continue/rules/tokenlighten.md",
]);

/** True when `rawPath` names a file this pre-pass may elide the managed block from. */
export function isAgentGuideElidePath(rawPath: string): boolean {
  const normalized = normalizedRequestPath(rawPath);
  if (AGENT_GUIDE_ELIDE_PATHS.has(normalized)) return true;
  return AGENT_GUIDE_ELIDE_BASENAMES.has(path.posix.basename(normalized));
}

// ---------------------------------------------------------------------------
// WP-S5 (B) (TL_IDENTIFIER_GROUNDING, 2026-09-20): TokenLighten's OWN managed
// guide text is never a discovery candidate.
// ---------------------------------------------------------------------------
//
// Measured on a live VS Code Copilot session: a read-only question about order
// cancellation came back `discover`, and the pack's own `next` re-packed the
// SAME query against `.github/agents/tokenlighten-explore.agent.md`,
// `.github/copilot-instructions.md` and `AGENTS.md`. Those files are TL's own
// injected instructions — they talk about "edit", "read", "targets", "paths",
// so a residual request-item's salient-word scan matches them for almost any
// request — and the HOST already puts that same text in the model's system
// prompt. Fetching it back as workspace "evidence" is a wasted turn by
// construction (the session paid one, ~210 mAIU, for junk).
//
// Detection reuses FX-M's list-plus-sentinel discipline on purpose. The list
// (this file's `AGENT_GUIDE_ELIDE_PATHS`/`_BASENAMES`, plus the sixth canonical
// agents-md stub target, `.github/agents/tokenlighten-explore.agent.md`) bounds
// WHICH files may be treated this way, so a spec or fixture in some repo that
// merely contains the sentinel text is never silently hidden from discovery;
// the SENTINEL then bounds WHICH LINES of such a file are TL's, so an AGENTS.md
// that also carries the project's own hand-written guidance keeps every line
// outside the managed block fully discoverable.
//
// The sixth target is kept in a separate constant rather than appended to
// `AGENT_GUIDE_ELIDE_PATHS`: that set is read by TL_PACK_GUIDE_ELIDE, a
// different flag with its own pinned behaviour, and this change must not move
// it.

/** The sixth canonical agents-md stub target (packages/agents-md/src/stubs.ts): a whole Copilot custom-agent file, not a managed block inside a pre-existing rules file, so FX-M's elide list never needed it. */
export const MANAGED_GUIDE_EXTRA_PATHS: ReadonlySet<string> = new Set([
  ".github/agents/tokenlighten-explore.agent.md",
]);

/** True when `rawPath` is one of the files the agents-md package writes a managed block into. */
export function isManagedGuidePath(rawPath: string): boolean {
  return isAgentGuideElidePath(rawPath) || MANAGED_GUIDE_EXTRA_PATHS.has(normalizedRequestPath(rawPath));
}

/**
 * The 1-based, inclusive line span of the TokenLighten-managed block in
 * `relPath`, or undefined when the file is not a managed-guide target or
 * carries no sentinel pair. Bounded, and memoized per (workspace, path) for the
 * life of the process: the block is written by `tl workspace setup`, not during
 * a task, and a stale verdict could only ever mis-size a discovery exclusion —
 * never a served byte, a range, or an absence claim.
 */
export const managedGuideBlockSpans = new Map<string, readonly [number, number] | null>();

export const MANAGED_GUIDE_SPAN_CACHE_CAP = 64;

export function managedGuideBlockSpan(workspace: string, relPath: string): readonly [number, number] | undefined {
  if (!isManagedGuidePath(relPath)) return undefined;
  const key = `${workspace}::${normalizedRequestPath(relPath)}`;
  const cached = managedGuideBlockSpans.get(key);
  if (cached !== undefined) return cached ?? undefined;
  let span: readonly [number, number] | null = null;
  const text = boundedWorkspaceText(workspace, relPath);
  if (text !== undefined) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => line.includes(SENTINEL_START));
    if (start >= 0) {
      const endOffset = lines.slice(start).findIndex((line) => line.includes(SENTINEL_END));
      span = [start + 1, endOffset >= 0 ? start + endOffset + 1 : lines.length];
    }
  }
  if (managedGuideBlockSpans.size >= MANAGED_GUIDE_SPAN_CACHE_CAP) {
    const oldest = managedGuideBlockSpans.keys().next().value as string | undefined;
    if (oldest !== undefined) managedGuideBlockSpans.delete(oldest);
  }
  managedGuideBlockSpans.set(key, span);
  return span ?? undefined;
}

export function resetManagedGuideBlockSpanCacheForTest(): void {
  managedGuideBlockSpans.clear();
}

/** Test hook for the (B) rule's boundary: which LINES of a managed-guide file are TokenLighten's own, and therefore unmatchable. `undefined` for any file this policy does not cover. */
export function managedGuideBlockSpanForTest(workspace: string, relPath: string): readonly [number, number] | undefined {
  return managedGuideBlockSpan(workspace, relPath);
}

/** True when a scan hit at `line` of `relPath` fell inside TokenLighten's own injected instructions — text the host already gave the model, so never evidence about the caller's repository. */
export function matchIsManagedGuideText(workspace: string, relPath: string, line: number | undefined): boolean {
  const span = managedGuideBlockSpan(workspace, relPath);
  if (span === undefined) return false;
  // A hit with no line (a filename-only match) in a managed-guide file is
  // attributed to the block: there is no line to place outside it.
  if (line === undefined) return true;
  return line >= span[0] && line <= span[1];
}

/** One elided-block outcome: the rewritten body plus the 0-based line offsets (within the ORIGINAL `code`) the marker replaced. */
export interface AgentGuideElisionResult {
  code: string;
  elidedLineCount: number;
  /** 0-based line offset, within the ORIGINAL `code`, of the first elided line. */
  elidedStartLineOffset: number;
  /** 0-based line offset, within the ORIGINAL `code`, of the last elided line (inclusive). */
  elidedEndLineOffset: number;
}

/**
 * Finds the managed block's start sentinel line in `code` and replaces its
 * INNER content (strictly between the sentinel lines) with one marker line,
 * when that inner content is longer than 3 lines. The sentinel lines
 * themselves are always kept.
 *
 * UNLIKE locateTaskContext.ts's own findManagedBlockLineRange (which fails
 * closed -- returns null -- on an unterminated start sentinel), a served
 * `code` body that carries only the START sentinel means the real block
 * continues past the served slice: this elides through the body's own last
 * line rather than declining to act, per this flag's design (the block is
 * redundant context either way, terminated or not).
 *
 * Returns undefined when there is no start sentinel, or the inner content is
 * too short (<=3 lines) to be worth eliding.
 */
export function elideAgentGuideManagedBlock(code: string): AgentGuideElisionResult | undefined {
  const lines = code.split("\n");
  // A `code` body that ends with "\n" (the normal case for a served line
  // range) splits into one TRAILING EMPTY-STRING artifact that is not a real
  // line -- e.g. "a\nb\n".split("\n") === ["a","b",""]. Excluded from the
  // "no end sentinel" fallback below via the same "-1" adjustment the legacy
  // halving loop already applies to this exact split() quirk
  // (`Math.ceil((lines.length - 1) / 2)`), so the reported elided-line count
  // is exact and the reconstructed body still ends on its own last line.
  const realLineCount = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

  let startIdx = -1;
  for (let i = 0; i < realLineCount; i++) {
    if (lines[i]!.includes(SENTINEL_START)) { startIdx = i; break; }
  }
  if (startIdx === -1) return undefined;

  let endIdx = -1;
  for (let i = startIdx + 1; i < realLineCount; i++) {
    if (lines[i]!.includes(SENTINEL_END)) { endIdx = i; break; }
  }

  const innerStart = startIdx + 1;
  // No end sentinel in the served body => the block runs off the end of what
  // was served; elide straight through the last REAL line (see doc comment
  // above) -- `lines.slice(innerEndExclusive)` below still naturally picks up
  // the trailing empty-string artifact (if any), so the reconstructed body's
  // own trailing newline is preserved either way.
  const innerEndExclusive = endIdx === -1 ? realLineCount : endIdx;
  const elidedLineCount = innerEndExclusive - innerStart;
  if (elidedLineCount <= 3) return undefined;

  const marker = `<!-- tokenlighten: managed guide block elided (${elidedLineCount} lines) - it is already in your instructions; zoom this handle to read it -->`;
  const newLines = [
    ...lines.slice(0, innerStart), // through & including the start sentinel line
    marker,
    ...lines.slice(innerEndExclusive), // the end sentinel line onward, if any; nothing otherwise
  ];
  return {
    code: newLines.join("\n"),
    elidedLineCount,
    elidedStartLineOffset: innerStart,
    elidedEndLineOffset: innerEndExclusive - 1,
  };
}

/**
 * Absolute "<start>-<end>" span covering the given 0-based, inclusive line
 * OFFSETS of a surface's `code`, anchored at `range`'s own start line.
 * Falls back to `range` unchanged when it is not the plain "<digits>-<digits>"
 * shape trimToCap's own Phase E already assumes for `remaining_ranges` --
 * the same "whole range" fallback that loop's `surf.remaining_ranges = ...`
 * line uses when it cannot express a finer-grained remainder.
 */
export function absoluteElidedSpan(range: string, offsetStart: number, offsetEnd: number): string {
  const match = /^(\d+)-(\d+)$/.exec(range);
  if (match === null) return range;
  const rangeStart = Number(match[1]);
  return `${rangeStart + offsetStart}-${rangeStart + offsetEnd}`;
}

/**
 * FX-M Change A entry point: elide the managed block of every eligible,
 * code-bearing agent-guide surface in `result`. Called from
 * dedupeTrimAndPersist immediately before trimToCap, gated on
 * TL_PACK_GUIDE_ELIDE -- see that flag's doc comment (util/flags.ts) for the
 * full rationale. Mutates surfaces in place; runs regardless of whether the
 * pack is currently over cap (the block is redundant context either way).
 *
 * Exported (not otherwise part of the public task-pack API) purely for direct
 * unit testing against constructed TaskPackResult values, the same rationale
 * trimToCap/dedupeAgentGuideSurfaces are already exported under -- the real
 * entry point remains dedupeTrimAndPersist/buildTaskPack.
 */
export function applyAgentGuideElision(result: TaskPackResult): void {
  for (const surf of codeTaskPackSurfaces(result.surfaces)) {
    if (typeof surf.code !== "string") continue;
    if (!isAgentGuideElidePath(surf.path)) continue;
    const elided = elideAgentGuideManagedBlock(surf.code);
    if (elided === undefined) continue;
    surf.code = elided.code;
    surf.content_completeness = "partial";
    const span = absoluteElidedSpan(surf.range, elided.elidedStartLineOffset, elided.elidedEndLineOffset);
    surf.remaining_ranges = [...new Set([...(surf.remaining_ranges ?? []), span])];
  }
}

// ---------------------------------------------------------------------------
// A1 (2026-07-30) — CONTENT-BEARING ARTIFACT SURFACES.
//
// collectArtifactSurfaces (above) attaches every resolved Office/PDF file as a
// discovery STUB: path + size + handle + an `extract` call string. For an
// artifact_build pack that is fine — attachArtifactBuildSections inlines the
// extraction beside it. For every OTHER profile it was the whole story: the T14
// two-deck audit resolved both .pptx decks, served ZERO slide text in a 2.9 KB
// response (~21 KB of pack budget unused), certified `awaiting-input`, and cost
// two extra round trips to read content the server had already located. The
// distributed guide's contract already says "artifact packs need content-bearing
// artifact_sections per source"; this is that contract, honored everywhere.
//
// WHY A PREFETCH: extraction is async (Office/PDF parsing) but the pack's shared
// exit — dedupeTrimAndPersist, which attaches the artifact surfaces and then
// computes coverage, readiness obligations, the evidence model and the execution
// contract — is synchronous. Inlining AFTER that exit would serve content beside
// a contract that still says "unresolved: artifact content, ask the user", i.e.
// worse than the round trip it saves. So the async entry point prefetches the
// extractions FIRST (gated on the args/query actually naming an artifact file,
// so a code-only task pays nothing) and the sync exit consumes them BEFORE any
// readiness decision. Module-level, workspace-keyed, overwritten per call and
// cleared in a `finally` — the same idiom lastPackFingerprints uses.
// ---------------------------------------------------------------------------

export interface PrefetchedArtifactSections {
  /** Pack-visible entries, already fitted to the per-artifact and total budgets. */
  entries: ArtifactTaskPackSectionEntry[];
  /** One `inlined[]` stamp per entry, same order. */
  stamps: string[];
  /** Normalized paths the caller named — trimToCap sheds these LAST. */
  callerNamed: Set<string>;
  /** The one named csv's lookup found every row this request asks for. */
  lookupAnswers: boolean;
  /** Those rows were attached to a read-only pack with no code surface, so nothing else is owed. */
  lookupClosedUniverse?: boolean;
}

export const artifactSectionPrefetch = new Map<string, PrefetchedArtifactSections>();

/**
 * Parallel packs on one workspace run in separate lanes, and a pack waits on I/O
 * between its prefetch and its attach, so a workspace-only key handed one lane the
 * section another lane's query selected.
 */
export function artifactPrefetchKey(workspace: string): string {
  return `${workspace}\0${currentSessionLane()}`;
}

/** Test/reset hook parity with the other module-level pack caches. */
export function resetArtifactSectionPrefetch(): void {
  artifactSectionPrefetch.clear();
}

/** Same compaction artifactBuildRelevance uses for its basename-in-query score. */
export function compactForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "");
}

export const ARTIFACT_EXT_IN_TEXT_RE = /\.(?:docx|xlsx|pptx|pdf|csv|tsv)\b/i;

/**
 * Cheap, I/O-FREE gate: could this request name an artifact file at all? A pack
 * for a pure code task must not pay an artifact walk or an Office parse, so the
 * prefetch runs only when the args carry an artifact-extension path, or the
 * query itself names an artifact file or an Office kind ("slide deck", "Excel").
 */
export function mayNameCallerArtifact(args: TaskPackArgs, query: string): boolean {
  const named = [
    ...(args.path !== undefined ? [args.path] : []),
    ...(args.paths ?? []).map(normalizePathEntry).map((entry) => entry.path),
  ];
  if (named.some((candidate) => ARTIFACT_EXT_SET.has(path.extname(candidate).toLowerCase()))) {
    return true;
  }
  return ARTIFACT_EXT_IN_TEXT_RE.test(query) || requestedArtifactKinds(query).length > 0;
}

/**
 * The artifacts this REQUEST named, as normalized paths. Deliberately narrow —
 * an artifact merely surfaced by query-token relevance stays a stub (that is the
 * candidate-ambiguity case the pack must not pre-commit to). Naming means one of:
 *   - the path appears in `paths[]` / `path` (exact caller identification), or
 *   - the file's basename, or its stem, appears verbatim in the query.
 */
export function callerNamedArtifacts(
  surfaces: readonly ArtifactTaskPackSurface[],
  args: TaskPackArgs,
  query: string,
): Set<string> {
  const explicit = new Set(
    [
      ...(args.path !== undefined ? [args.path] : []),
      ...(args.paths ?? []).map(normalizePathEntry).map((entry) => entry.path),
    ]
      .filter((candidate) => ARTIFACT_EXT_SET.has(path.extname(candidate).toLowerCase()))
      .map(normalizedRequestPath),
  );
  const compactQuery = compactForMatch(query);
  const named = new Set<string>();
  for (const surface of surfaces) {
    const normalized = normalizedRequestPath(surface.path);
    if (explicit.has(normalized)) {
      named.add(normalized);
      continue;
    }
    const basename = path.posix.basename(surface.path);
    const stem = basename.slice(0, basename.length - path.posix.extname(basename).length);
    const compactBase = compactForMatch(basename);
    const compactStem = compactForMatch(stem);
    if (
      (compactBase.length > 0 && compactQuery.includes(compactBase))
      || (compactStem.length >= 4 && compactQuery.includes(compactStem))
    ) {
      named.add(normalized);
    }
  }
  return named;
}

/**
 * Reconstruct the minted shape extractArtifactBuildSection needs, keeping the
 * surface's own handle.
 *
 * THE CREDENTIAL TRAVELS (2026-08-14). `collectArtifactSurfaces` returns the
 * plain `ArtifactTaskPackSurface`, which has no slot for a credential, so this
 * reconstruction dropped the pair `mintArtifactSurface` had already resolved —
 * and `extractArtifactBuildSection` then called `prepareOfficeDocument(bytes,
 * undefined)` on an ENCRYPTED workbook, failed to decrypt, and returned only
 * the `next` hint. Measured: the identical query over a PLAINTEXT .xlsx inlines
 * `artifact_sections` with the sheet's rows; over the encrypted copy with a
 * valid `credentialRef` it inlined nothing and the pack degraded to
 * `await_input:"no-grounded-call-remains"`. The password is never stored on the
 * surface and never serialized — it rides only this in-memory wrapper, which is
 * exactly what the `credentialRef` indirection exists to guarantee.
 */
export function remintPackArtifact(
  surface: ArtifactTaskPackSurface,
  workspace: string,
  args?: Pick<TaskPackArgs, "credentialRef" | "credentialPassword">,
): MintedArtifactSurface | undefined {
  try {
    const absPath = path.join(workspace, surface.path);
    statReadTargetSync(absPath, workspace);
    // served-bytes: not-served (artifact re-mint: shaOfBytes for the handle only)
    const bytes = fs.readFileSync(absPath);
    return {
      file: {
        relPath: surface.path,
        absPath,
        language: "default",
        ext: path.posix.extname(surface.path).toLowerCase(),
        kind: "artifact",
      },
      bytes,
      ...(args?.credentialRef !== undefined ? { credentialRef: args.credentialRef } : {}),
      ...(args?.credentialPassword !== undefined ? { credentialPassword: args.credentialPassword } : {}),
      surface,
    };
  } catch {
    return undefined;
  }
}

/** The logical row span a plain csv section's `remaining_sections` names, if any. */
export function csvRowsOf(remaining: readonly string[] | undefined): string | undefined {
  return /^rows (\d+-\d+)$/.exec(remaining?.[0] ?? "")?.[1];
}

/**
 * A logical row span of a csv. `kind` is what keeps it one: the wire form of a call
 * has no `mode`, and a `range` with no select field beside it is read as file lines.
 */
export function csvRowsSelector(artifactPath: string, rows: string): ToolCall["arguments"] {
  return { range: rows, kind: artifactPath.toLowerCase().endsWith(".tsv") ? "tsv" : "csv" };
}

/**
 * The exact ONE call that fetches the entries a bounded inline left out,
 * addressed through the artifact's own handle so the caller never re-finds it.
 * mode=artifact addresses docx by heading, pptx by slide number, pdf by page,
 * csv by logical row range (it ignores `sheet`, and would serve the head again);
 * an xlsx sheet has no sub-selector, so the whole sheet is named instead.
 */
export function remainingArtifactSectionsCall(
  surface: ArtifactTaskPackSurface,
  section: ArtifactTaskPackSection,
  remaining: readonly string[],
): ContinuationCall {
  const call = (extra: ToolCall["arguments"] = {}): ContinuationCall => ({
    tool: "tl_read_file",
    arguments: { mode: "artifact", handle: surface.handle, ...extra },
  });
  if ("sheet" in section && surface.artifactKind === "csv") {
    const rows = csvRowsOf(remaining);
    return call(rows !== undefined ? csvRowsSelector(surface.path, rows) : {});
  }
  if ("sheet" in section) return call({ sheet: section.sheet, as: "json" });
  if (section.kind === "docx") return call({ sections: remaining.slice(0, MAX_REMAINING_SECTION_IDS) });
  if (section.kind === "pptx") {
    const slides = remaining
      .map((id) => /^Slide\s+(\d+)/.exec(id)?.[1])
      .filter((slide): slide is string => slide !== undefined)
      .slice(0, MAX_REMAINING_SECTION_IDS);
    return call(slides.length > 0 ? { slides } : {});
  }
  const pages = remaining
    .map((id) => /^page-(\d+)$/.exec(id)?.[1])
    .filter((page): page is string => page !== undefined)
    .slice(0, MAX_REMAINING_SECTION_IDS);
  return call(pages.length > 0 ? { pages } : {});
}

/** Bound the id list so `remaining_sections` stays a pointer, not an inventory. */
export function boundedRemainingIds(remaining: readonly string[]): string[] {
  if (remaining.length <= MAX_REMAINING_SECTION_IDS) return [...remaining];
  return [
    ...remaining.slice(0, MAX_REMAINING_SECTION_IDS),
    `+${remaining.length - MAX_REMAINING_SECTION_IDS} more`,
  ];
}

/**
 * One pack-visible entry: the section fitted to `capBytes`, plus — only when the
 * fit had to cut something — the handle, the unserved ids, the exact one-call
 * follow-up, and a note saying what was cut.
 */
export function buildArtifactSectionEntry(
  surface: ArtifactTaskPackSurface,
  extracted: ArtifactTaskPackSection,
  capBytes: number,
  query: string,
): ArtifactTaskPackSectionEntry {
  const section = surface.artifactKind === "csv" && csvSampleEnabled()
    ? plainCsvSample(extracted, capBytes, csvLookupComplete(extracted) ? CSV_LOOKUP_SAMPLE_ROWS : CSV_SURFACE_SAMPLE_ROWS)
    : extracted;
  const fit = fitArtifactSectionToBytes(section, capBytes);
  const entry: ArtifactTaskPackSectionEntry = { path: surface.path, section: fit.section };
  if (!fit.partial) return entry;
  entry.content_completeness = "partial";
  entry.handle = surface.handle;
  if ("sheet" in fit.section && fit.section.query_window !== undefined) {
    // A3: `next` opens the request over the whole table. Rows this reply ends up
    // carrying in full are booked at the settle, so it does not repeat them; rows that
    // cannot be booked (a multi-line row, a shed body) it repeats, and it never skips one.
    const kind = surface.path.toLowerCase().endsWith(".tsv") ? "tsv" : "csv";
    entry.next = {
      tool: "tl_read_file",
      arguments: { targets: [{ path: surface.path }], select: { kind }, query },
    };
    entry.note = queryWindowSectionNote(fit.section);
    return entry;
  }
  if ("sheet" in section && "sheet" in fit.section && surface.artifactKind === "csv" && fit.remaining.length > 0) {
    entry.remaining_sections = boundedRemainingIds(fit.remaining);
    if (fit.section.lookup !== undefined) {
      // A complete lookup is what the request came for: `handle` still reads any other row.
      if (!csvLookupComplete(fit.section)) entry.next = remainingArtifactSectionsCall(surface, fit.section, fit.remaining);
      entry.note = plainCsvLookupNote(fit.section);
      return entry;
    }
    entry.next = remainingArtifactSectionsCall(surface, fit.section, fit.remaining);
    entry.note = section !== extracted && fit.section === section
      ? plainCsvSampleNote(fit.section)
      : plainCsvCutNote(section, fit.section, fit.section === section ? "" : ` (${ARTIFACT_SURFACE_INLINE_CAP_BYTES}B per-artifact inline cap)`);
    return entry;
  }
  if (fit.remaining.length > 0) {
    const served = artifactSectionEntryIds(fit.section).length;
    entry.remaining_sections = boundedRemainingIds(fit.remaining);
    entry.next = remainingArtifactSectionsCall(surface, fit.section, fit.remaining);
    entry.note = `inlined ${served} of ${served + fit.remaining.length} extracted sections`
      + ` (${ARTIFACT_SURFACE_INLINE_CAP_BYTES}B per-artifact inline cap); fetch the rest with next`;
  } else {
    entry.next = remainingArtifactSectionsCall(surface, fit.section, []);
    entry.note = "extraction was truncated at the extractor cap; fetch the full section with next";
  }
  return entry;
}

/**
 * Extract + budget-fit the caller-named artifacts of this request. Runs before
 * the pack is built (see the block comment above); stores nothing when the gate
 * fails, no artifact is caller-named, or every extraction came back empty.
 */
export async function prefetchArtifactSurfaceSections(
  args: TaskPackArgs,
  workspace: string,
): Promise<void> {
  const query = args.query ?? args.symbol ?? args.path ?? "";
  if (!mayNameCallerArtifact(args, query)) return;
  let surfaces: ArtifactTaskPackSurface[];
  try {
    surfaces = collectArtifactSurfaces(args, workspace);
  } catch {
    return;
  }
  if (surfaces.length === 0) return;
  const callerNamed = callerNamedArtifacts(surfaces, args, query);
  if (callerNamed.size === 0) return;
  const selected = surfaces
    .filter((surface) => callerNamed.has(normalizedRequestPath(surface.path)))
    .slice(0, MAX_INLINED_ARTIFACT_SURFACES);

  const entries: ArtifactTaskPackSectionEntry[] = [];
  const stamps: string[] = [];
  let usedBytes = 0;
  for (const surface of selected) {
    const remainingBudget = ARTIFACT_SURFACE_INLINE_TOTAL_BYTES - usedBytes;
    if (remainingBudget <= 0) break;
    const minted = remintPackArtifact(surface, workspace, args);
    if (minted === undefined) continue;
    let extraction: ArtifactBuildExtraction;
    try {
      extraction = await extractArtifactBuildSection(minted, query, { csvQueryWindowBytes: Math.min(ARTIFACT_SURFACE_INLINE_CAP_BYTES, remainingBudget), workspace });
    } catch {
      continue;
    }
    if (extraction.section === undefined || extraction.sectionId === undefined) continue;
    // Both budgets are measured over the WHOLE entry (path + honesty fields, not
    // just the section body), so the pack-visible total is what the caps promise.
    // The section is fitted twice at most: once to the nominal cap, then — if the
    // assembled entry's own overhead pushed it past the remaining total — again
    // to the cap minus that measured overhead.
    let entry = buildArtifactSectionEntry(
      surface,
      extraction.section,
      Math.min(ARTIFACT_SURFACE_INLINE_CAP_BYTES, remainingBudget),
      query,
    );
    let entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (entryBytes > remainingBudget) {
      const overhead = entryBytes - Buffer.byteLength(JSON.stringify(entry.section), "utf8");
      const retryCap = remainingBudget - overhead;
      if (retryCap <= 0) break;
      entry = buildArtifactSectionEntry(surface, extraction.section, retryCap, query);
      entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (entryBytes > remainingBudget) break;
    }
    entries.push(entry);
    stamps.push(`artifact-section:${surface.path}#${extraction.sectionId.slice(0, 120)}`);
    usedBytes += entryBytes;
  }
  if (entries.length === 0) return;
  artifactSectionPrefetch.set(artifactPrefetchKey(workspace), {
    entries,
    stamps,
    callerNamed,
    lookupAnswers: entries.length === 1 && csvLookupComplete(entries[0]!.section) && csvLookupAnswersRequest(stripPathSpans("", query)),
  });
}

/**
 * Inline the prefetched extractions into a pack that carries the matching
 * artifact SURFACES. Called from the shared pack exit BEFORE coverage/readiness
 * so the certificate is computed over the artifact content actually served.
 *
 * Skipped when the pack already carries artifact content (`section` /
 * `artifact_sections` — the artifact_build flow, which does its own bundling)
 * and for any entry whose artifact is not a surface of THIS pack: an `inlined[]`
 * stamp must stay verifiable against the same response (attachSupply §11.4).
 * The whole-pack ceiling is the artifact-bundle tier, the highest transport-safe
 * cap that exists, so artifact bodies can never push a pack past it.
 */
export function attachPrefetchedArtifactSections(result: TaskPackResult, workspace: string, profile: TaskProfile): void {
  if (result.pack_unchanged === true) return;
  if (result.section !== undefined || result.artifact_sections !== undefined) return;
  const prefetch = artifactSectionPrefetch.get(artifactPrefetchKey(workspace));
  if (prefetch === undefined || prefetch.entries.length === 0) return;
  const artifactPaths = new Set(
    (result.surfaces as TaskPackResultSurface[])
      .filter(isArtifactTaskPackSurface)
      .map((surface) => normalizedRequestPath(surface.path)),
  );
  const entries: ArtifactTaskPackSectionEntry[] = [];
  const stamps: string[] = [];
  for (const [index, entry] of prefetch.entries.entries()) {
    if (!artifactPaths.has(normalizedRequestPath(entry.path))) continue;
    const candidate: TaskPackResult = {
      ...result,
      artifact_sections: [...entries, entry],
      inlined: [...(result.inlined ?? []), ...stamps, prefetch.stamps[index]!],
    };
    const bytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes > Math.max(capForResult(candidate), MAX_TASK_PACK_BYTES_ARTIFACT_BUNDLE)) break;
    entries.push(entry);
    stamps.push(prefetch.stamps[index]!);
  }
  if (entries.length === 0) return;
  result.artifact_sections = entries;
  result.inlined = [...(result.inlined ?? []), ...stamps];
  // A read-only question a csv's own rows answer needs no code role. Without this the
  // default "contract, api" gap sends it on to a search for rows it already holds.
  prefetch.lookupClosedUniverse = prefetch.lookupAnswers && profile === "answer" && entries.length === 1 && codeTaskPackSurfaces(result.surfaces).length === 0;
  if (prefetch.lookupClosedUniverse) result.missing = [];
}

/**
 * "All the rows with X" names an open universe that this response has already closed:
 * the lookup read every row of the table the request named.
 */
export function csvLookupClosedUniverse(workspace: string | undefined): boolean {
  return workspace !== undefined && artifactSectionPrefetch.get(artifactPrefetchKey(workspace))?.lookupClosedUniverse === true;
}

/** Normalized paths of the artifacts THIS request named, for trimToCap's shed order. */
export function prefetchedCallerNamedArtifacts(workspace: string): ReadonlySet<string> {
  return artifactSectionPrefetch.get(artifactPrefetchKey(workspace))?.callerNamed ?? new Set<string>();
}

/**
 * Last-resort generic-text discovery for task_pack.
 *
 * This deliberately runs only after the semantic locator has produced no rich
 * or weak candidate. It therefore cannot perturb an already-resolved pack's
 * ranking, surface bytes, route, or call count. The walker may also return
 * tracked files for callers that request a union, so the server-issued
 * `generic-text` kind is the authority for this unknown/extensionless lane.
 */
export function discoverGenericTaskPackFallback(
  args: TaskPackArgs,
  query: string,
  workspace: string,
): GenericTaskPackFallback {
  if (!genericTextDiscoveryEnabled() || args.lang !== undefined) {
    return { attempted: false, paths: [] };
  }

  const omissions = createWalkOmissions();
  const files = walkCodeFiles(workspace, {
    ...(args.path ? { subPath: args.path } : {}),
    includeGenericText: true,
    respectGitignore: true,
    omissions,
  }).filter((file) => file.kind === "generic-text");

  // An exact caller path is stronger evidence than query wording. If it is a
  // policy-admissible generic text file, serve it directly even when the query
  // merely asks to inspect/read it and contains no literal from its body.
  if (args.path && !isDirectoryWithin(args.path, workspace)) {
    const explicitPath = normalizedRequestPath(args.path);
    const explicit = files.find((file) => file.relPath === explicitPath);
    if (explicit !== undefined) {
      return { attempted: true, paths: [explicit.relPath] };
    }
  }

  const probes = orderedUniqueTokens([
    ...(args.symbol ? [args.symbol] : []),
    ...concreteIdentifierTokens(query),
    ...concernAnchorTokens(query),
  ])
    .filter((token) => token.length >= 4)
    .slice(0, 6);
  if (files.length === 0 || probes.length === 0) {
    return { attempted: true, paths: [], ...(probes[0] ? { probe: probes[0] } : {}) };
  }

  const contentCache = createScanContentCache();
  const byPath = new Map<string, { probes: Set<string>; firstLine: number }>();
  for (const probe of probes) {
    const matches = scanLiteral(probe, workspace, {
      caseInsensitive: true,
      files,
      contentCache,
    });
    for (const match of matches) {
      const current = byPath.get(match.path) ?? { probes: new Set<string>(), firstLine: match.line };
      current.probes.add(probe.toLowerCase());
      current.firstLine = Math.min(current.firstLine, match.line);
      byPath.set(match.path, current);
    }
  }

  const paths = [...byPath.entries()]
    .sort((left, right) =>
      right[1].probes.size - left[1].probes.size
      || left[1].firstLine - right[1].firstLine
      || left[0].localeCompare(right[0])
    )
    .slice(0, MAX_SURFACES_DISTINCT)
    .map(([relPath]) => relPath);
  return { attempted: true, paths, probe: probes[0] };
}
