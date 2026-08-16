// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * SkeletonGeneratorOptions — public options surface for buildSkeleton().
 *
 * Full spec: docs/components/03-ci-skeleton.md §4.1
 *
 * These mirror the `.tokenlighten.yaml` skeleton section keys so that
 * callers (CLI, CI scripts, programmatic use) share one options shape.
 */
export interface SkeletonGeneratorOptions {
  /** Root directory of the repository. Defaults to process.cwd(). */
  repoRoot?: string;

  /**
   * Output path for .tokenlighten/skeleton.md.
   * Default: <repoRoot>/.tokenlighten/skeleton.md
   */
  outputPath?: string;

  /**
   * Hard byte cap for the generated file.
   * Default: 65_536 (≈ 64 KiB, ≈ 16k tokens).
   * See docs/components/03-ci-skeleton.md §4.1.
   */
  maxTotalBytes?: number;

  /**
   * Maximum number of top-ranked files to include.
   * Default: 40 (matches Aider repomap default).
   */
  topN?: number;

  /**
   * PageRank damping factor.
   * Default: 0.85 (per proto/src/mcp/pagerank.ts and Aider experience values).
   */
  dampingFactor?: number;

  /**
   * PageRank iteration count.
   * Default: 20 (fixed cost, no convergence check — per spec §2.1).
   */
  maxIterations?: number;

  /**
   * How many recent git log entries to use for personalization.
   * Default: 50. Configurable via skeleton.recencyDepth in .tokenlighten.yaml.
   */
  recencyDepth?: number;

  /**
   * Extra patterns to add to the ignore matcher (in addition to defaults).
   */
  extraIgnorePatterns?: string[];

  /**
   * Skip the graph JSON cache; force a full rebuild.
   */
  noCache?: boolean;

  /**
   * Explicit git commit SHA. When provided, skips the `git rev-parse HEAD` call.
   * Useful in CI where the SHA is available as an env var.
   */
  commit?: string;
}
