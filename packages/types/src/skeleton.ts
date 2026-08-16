/**
 * Types produced by the CI skeleton generator (`tl skeleton build`).
 * See docs/components/03-ci-skeleton.md for the full specification.
 */

/**
 * A single file entry ranked by PageRank-personalized scoring.
 * Corresponds to the "Top-ranked files" section of .repo-skeleton.md.
 */
export interface RankedFile {
  /** Workspace-relative POSIX path. */
  path: string;
  /**
   * Normalized PageRank score in [0, 1].
   * Higher = more central to the repo's import graph.
   */
  rank: number;
  /** Human-readable reasons this file ranked highly (e.g. "recently edited", "high in-degree"). */
  reasons: string[];
}

/**
 * A detected API endpoint extracted from handler source files.
 * Corresponds to the "API endpoints" section of .repo-skeleton.md.
 */
export interface ApiEndpoint {
  /** HTTP method in upper-case (e.g. "GET", "POST"). */
  method: string;
  /** Route path as declared in source (e.g. "/tl/status", "/users/:id"). */
  path: string;
  /** Workspace-relative POSIX path of the file containing the handler. */
  handlerFile: string;
  /** Name of the handler function or method. */
  handlerSymbol: string;
}

/**
 * A node in the module map tree.
 * Each node represents a directory or file with directed edges to its children.
 * Corresponds to the "Module map" section of .repo-skeleton.md.
 */
export interface ModuleNode {
  /** Workspace-relative POSIX path of this directory or file. */
  path: string;
  /**
   * Paths of immediate children (sub-directories or files).
   * Empty for leaf nodes (individual source files).
   */
  children: string[];
}

/**
 * Root object produced by `tl skeleton build`.
 * Serialized to `.tokenlighten/skeleton.md` (markdown) and optionally to
 * `.tokenlighten/skeleton.stats.json` (structured form).
 */
export interface RepoSkeleton {
  /** Schema version — always 1. */
  version: 1;
  /** Git commit SHA at the time of generation. */
  commit: string;
  /** PageRank-ranked files (≤ topN, default 40), sorted descending by rank. */
  topRanked: RankedFile[];
  /** API endpoints detected in handler files. */
  apiEndpoints: ApiEndpoint[];
  /** Flat list of module map nodes (directory tree nodes). */
  moduleMap: ModuleNode[];
  /**
   * File/glob patterns that were excluded from ranking (size cap, ignore rules, etc.).
   * Listed in the "Sources excluded" section of the markdown output.
   */
  excluded: string[];
}
