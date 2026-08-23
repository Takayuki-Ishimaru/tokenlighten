// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * @tokenlighten/skeleton-engine — library entry point.
 *
 * buildSkeleton(root, config) → RepoSkeleton
 *
 * Full spec: docs/components/03-ci-skeleton.md
 */

export type { SkeletonGeneratorOptions } from "./generator.js";

// Re-export the primary types and functions for library consumers.
export type { RepoSkeleton, RankedFile, ApiEndpoint, ModuleNode } from "@tokenlighten/types";
export { buildSkeleton } from "./application/buildSkeleton.js";
export type { BuildSkeletonOptions, BuildSkeletonResult } from "./application/buildSkeleton.js";
export { renderSkeleton } from "./render.js";
export { renderCompactSkeleton } from "./compact.js";
export { DEFAULT_IGNORE, DEFAULT_IGNORE_PATTERNS, createIgnoreMatcherSync, createPatternMatcherSync } from "./ignore.js";
export type { IgnoreMatcher } from "./ignore.js";
export type { SymbolKind, ChunkKind, IndexedChunkV1 } from "./chunker.js";
export type { SourceIndexManifestV1, IndexedFileV1, IndexedSymbolV1, DirectoryDigestV1 } from "./indexStore.js";
export { loadOrBuildSourceIndex, invalidateCachedWorkspaceFiles } from "./indexStore.js";
// V11-09 (Incremental Index / Graph Update v2): the coverage-disclosure
// accessor a downstream wave (B/C) wires into a served response — CRITICAL
// INVARIANT it exists to serve: partial coverage (any quarantined/failed
// file) must be visible so nothing downstream claims complete/absence over
// a file this manifest could not fully index. Wire-level consumption is
// that later wave's job; only the accessor + its type land now.
export { getManifestCoverageSummary } from "./indexStore.js";
export type { IndexedFileParseStatus, ManifestCoverageSummary } from "./indexStore.js";
// V11-09: bounded, explicitly-invocable self-heal (see consistencyScan.ts's
// doc comment). Exported so a future caller can invoke it directly without
// another skeleton-engine change; loadOrBuildSourceIndex already calls it
// internally, opportunistically, behind TL_INDEX_CONSISTENCY_SCAN.
export { runConsistencyScan } from "./consistencyScan.js";
export type { ConsistencyScanOptions, ConsistencyScanResult } from "./consistencyScan.js";
export { languageForPathWithContent, extractSymbolsRegex } from "./graph.js";
export type { ExtractedSymbol } from "./graph.js";
export { buildTlGraphFromManifest, writeGraphIfStale } from "./graphBuilder.js";
export { searchSymbols as searchIndexSymbols, isTestPath } from "./searchIndex.js";
export type { SearchInput, SearchContext, RankedLocation } from "./searchIndex.js";
