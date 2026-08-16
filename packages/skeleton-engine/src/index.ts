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
export { loadOrBuildSourceIndex } from "./indexStore.js";
export { languageForPathWithContent, extractSymbolsRegex } from "./graph.js";
export type { ExtractedSymbol } from "./graph.js";
export { buildTlGraphFromManifest, writeGraphIfStale } from "./graphBuilder.js";
export { searchSymbols as searchIndexSymbols, isTestPath } from "./searchIndex.js";
export type { SearchInput, SearchContext, RankedLocation } from "./searchIndex.js";
