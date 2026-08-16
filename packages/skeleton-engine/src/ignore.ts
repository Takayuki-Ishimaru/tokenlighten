// Plain data only — no meta envelope, no 'tokenlighten:meta' wrappers.
// Reason: docs/00-postmortem.md §2.2

/**
 * Ignore matcher for CI skeleton: combines .gitignore semantics with
 * .tokenlightenignore and configurable exclude patterns.
 *
 * Ported from proto/src/core/ignore.ts — VSCode coupling removed.
 * Uses the 'ignore' npm package for .gitignore semantics.
 */

import ignore from "ignore";
import { join } from "node:path";
import { readRegularFileUtf8 } from "./readGuard.js";

/**
 * Built-in default ignore patterns used when no .tokenlightenignore is found.
 * .tokenlightenignore (if present) ADDS to these defaults, not replaces them.
 * Named DEFAULT_IGNORE for testability and named export contract.
 */
export const DEFAULT_IGNORE: string[] = [
  // Package and build output
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "out/",
  "coverage/",
  ".turbo/",
  ".claude/",
  "target/",
  "third_party/",
  "vendor/",
  // Project-specific noise directories
  "proto/",
  "benchmark/",
  "samples/",
  "eval/",
  "release/",
  "outputs/",
  // Bench-planted buggy mirrors — exclude narrow path so real user _buggy/ folders are unaffected
  "bench/fixtures/_buggy/",
  // VCS and env
  ".git/",
  ".cache/",
  ".DS_Store",
  ".env",
  ".env.*",
  // TokenLighten's own cache/index output — MUST stay excluded so
  // .tokenlighten/cache/source-index.v1.json and .tokenlighten/index/
  // tl-graph.json don't get self-indexed on the NEXT loadOrBuildSourceIndex
  // run. Previously latent (no .json/.md/... extension had a recognized
  // language, so walk() skipped them regardless); became a real bug once
  // TEXT_EXTS (graph.ts) added .json as a text-bearing, enumerable
  // extension — a second index run would otherwise pick up its own
  // previous cache output as new textOnly entries, growing without bound.
  ".tokenlighten/",
  // Lockfiles
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "*-lock.yaml",
  "yarn.lock",
  // Generated / minified
  "**/*.min.js",
  "**/*.min.css",
  "*.map",
  "*.snap",
  "generated/",
  "*.generated.*",
  "*.pb.*",
  "*.d.ts.map",
  "__generated__/",
];

/**
 * @deprecated Use DEFAULT_IGNORE instead.
 * Kept for backwards compatibility — points to the same array.
 */
export const DEFAULT_IGNORE_PATTERNS: string[] = DEFAULT_IGNORE;

const PROTECTED_IGNORE: string[] = [
  "node_modules/",
  ".git/",
  ".tokenlighten/",
  "third_party/",
  "vendor/",
  "bench/fixtures/_buggy/",
  ".env",
  ".env.*",
];

export interface IgnoreMatcher {
  ignores(relPath: string): boolean;
}

/**
 * Normalize a path for the 'ignore' package:
 * - convert backslashes to forward slashes (Windows compat),
 * - strip leading "./" or "/" so path is workspace-relative.
 * Returns "" for paths that normalize to empty.
 */
function normalizePath(relPath: string): string {
  let p = relPath.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.startsWith("/")) p = p.slice(1);
  return p;
}

/**
 * Build an ignore matcher from default patterns plus optional extras.
 * Reads .gitignore and .tokenlightenignore from the repo root if present.
 */
export async function createIgnoreMatcher(
  root: string,
  extraPatterns?: string[],
): Promise<IgnoreMatcher> {
  const protectedDefaults = ignore().add(PROTECTED_IGNORE);
  const ig = ignore().add(DEFAULT_IGNORE);

  // Load .gitignore if present (best-effort).
  try {
    const gitignoreText = await readRegularFileUtf8(join(root, ".gitignore"));
    ig.add(gitignoreText);
  } catch {
    // No .gitignore — continue.
  }

  // Load .tokenlightenignore if present (best-effort).
  try {
    const tlignoreText = await readRegularFileUtf8(join(root, ".tokenlightenignore"));
    ig.add(tlignoreText);
  } catch {
    // No .tokenlightenignore — continue.
  }

  if (extraPatterns && extraPatterns.length > 0) {
    ig.add(extraPatterns);
  }

  return {
    ignores(relPath: string): boolean {
      const p = normalizePath(relPath);
      if (p === "") return false;
      return protectedDefaults.ignores(p) || ig.ignores(p);
    },
  };
}

/**
 * Synchronous variant for use without async context.
 * Does NOT read .gitignore or .tokenlightenignore from disk.
 */
export function createIgnoreMatcherSync(extraPatterns?: string[]): IgnoreMatcher {
  const protectedDefaults = ignore().add(PROTECTED_IGNORE);
  const ig = ignore().add(DEFAULT_IGNORE);
  if (extraPatterns && extraPatterns.length > 0) ig.add(extraPatterns);

  return {
    ignores(relPath: string): boolean {
      const p = normalizePath(relPath);
      if (p === "") return false;
      return protectedDefaults.ignores(p) || ig.ignores(p);
    },
  };
}

/**
 * Matcher over ONLY the given patterns — DEFAULT_IGNORE is not baked in.
 * Callers that must attribute an exclusion to a specific rule family
 * (heuristic defaults vs .gitignore vs user .tokenlightenignore) build one
 * matcher per layer instead of a single merged one.
 */
export function createPatternMatcherSync(patterns: string[]): IgnoreMatcher {
  const ig = ignore();
  if (patterns.length > 0) ig.add(patterns);

  return {
    ignores(relPath: string): boolean {
      const p = normalizePath(relPath);
      if (p === "") return false;
      return ig.ignores(p);
    },
  };
}
