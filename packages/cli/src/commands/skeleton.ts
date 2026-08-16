/**
 * tl skeleton build / check — delegate to @tokenlighten/skeleton-engine
 *
 * Lazy-requires skeleton-engine at runtime so that the CLI remains installable
 * without it. If the package is absent, prints an install hint.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { createRequire } from "module";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const SKELETON_USAGE = `\
Usage: tl skeleton <subcommand>

Subcommands:
  build [--out <path>] [--compact]   Generate .repo-skeleton.md for the current repo
  check                              Verify AGENTS.md skeleton block is up-to-date (CI gate)
`;

const SKELETON_BEGIN = "<!-- tokenlighten:skeleton:begin -->";
const SKELETON_END = "<!-- tokenlighten:skeleton:end -->";

/** Extract the skeleton block content from an AGENTS.md string.
 *  Returns the text between the sentinel comments, or null if sentinels are absent. */
function extractSkeletonBlock(agentsMd: string): string | null {
  const beginIdx = agentsMd.indexOf(SKELETON_BEGIN);
  const endIdx = agentsMd.indexOf(SKELETON_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return null;
  return agentsMd.slice(beginIdx + SKELETON_BEGIN.length, endIdx);
}

interface SkeletonBuildResult {
  skeleton: unknown;
  markdown: string;
  warnings: string[];
}

type SkeletonMod = {
  /** Legacy shape some skeleton-engine builds exposed; no longer shipped. */
  build?: (opts: Record<string, unknown>) => Promise<void>;
  /** Real signature: buildSkeleton(root = process.cwd(), opts?) — root is a plain string, not an options object. */
  buildSkeleton?: (root?: string, opts?: Record<string, unknown>) => Promise<SkeletonBuildResult>;
  /** Real signature: renderCompactSkeleton(skeleton, opts?) */
  renderCompactSkeleton?: (skeleton: unknown, opts?: Record<string, unknown>) => string;
};

async function loadSkeletonMod(): Promise<SkeletonMod> {
  try {
    const require = createRequire(import.meta.url);
    const modPath = require.resolve("@tokenlighten/skeleton-engine");
    return (await import(modPath)) as SkeletonMod;
  } catch {
    process.stderr.write(
      "tl skeleton: @tokenlighten/skeleton-engine not found.\n" +
        "Run: npm install -w @tokenlighten/skeleton-engine\n"
    );
    process.exit(1);
  }
}

export async function runSkeleton(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(SKELETON_USAGE);
    return;
  }

  if (sub === "build") {
    const skeletonMod = await loadSkeletonMod();

    if (typeof skeletonMod.buildSkeleton !== "function") {
      process.stderr.write(
        "tl skeleton: @tokenlighten/skeleton-engine has no exported 'buildSkeleton' function.\n"
      );
      process.exit(1);
    }

    // Parse --out flag and --compact flag
    const outIdx = rest.indexOf("--out");
    const outPath = outIdx !== -1 ? rest[outIdx + 1] : undefined;
    const compact = rest.includes("--compact");

    const cwd = process.cwd();
    const { skeleton, markdown } = await skeletonMod.buildSkeleton(cwd);
    const output =
      compact && typeof skeletonMod.renderCompactSkeleton === "function"
        ? skeletonMod.renderCompactSkeleton(skeleton)
        : markdown;

    const targetPath = outPath ?? join(cwd, ".repo-skeleton.md");
    writeFileSync(targetPath, output, "utf-8");
    process.stdout.write(`wrote  ${targetPath}\n`);
    return;
  }

  if (sub === "check") {
    const cwd = process.cwd();
    const agentsMdPath = join(cwd, "AGENTS.md");

    // AGENTS.md not found → exit 0 (user hasn't opted in yet)
    if (!existsSync(agentsMdPath)) {
      process.stdout.write(
        "tl skeleton check: AGENTS.md not found — run `tl agents-md write --for-target` first to enable check\n"
      );
      process.exit(0);
    }

    const agentsMd = readFileSync(agentsMdPath, "utf-8");
    const checkedInBlock = extractSkeletonBlock(agentsMd);

    if (checkedInBlock === null) {
      // AGENTS.md exists but has no skeleton sentinels → nothing to check
      process.stdout.write(
        "tl skeleton check: no skeleton sentinels found in AGENTS.md — skipping check\n"
      );
      process.exit(0);
    }

    // Build the current skeleton using compact mode (same output as agents-md write --for-target)
    const skeletonMod = await loadSkeletonMod();

    let freshBlock: string;

    if (
      typeof skeletonMod.buildSkeleton === "function" &&
      typeof skeletonMod.renderCompactSkeleton === "function"
    ) {
      // Preferred path: use dedicated build + render functions
      const { skeleton } = await skeletonMod.buildSkeleton(cwd);
      freshBlock = skeletonMod.renderCompactSkeleton(skeleton);
    } else if (typeof skeletonMod.build === "function") {
      // Fallback: call build with compact mode and capture output via a temp file
      const { tmpdir } = await import("os");
      const { randomBytes } = await import("crypto");
      const {
        readFileSync: rfs,
        unlinkSync,
        existsSync: exs,
      } = await import("fs");
      const tmpPath = join(
        tmpdir(),
        `tl-skeleton-check-${randomBytes(6).toString("hex")}.md`
      );
      try {
        await skeletonMod.build({ repoRoot: cwd, outputPath: tmpPath, compact: true });
        if (!exs(tmpPath)) {
          process.stderr.write(
            "tl skeleton check: skeleton engine did not produce output — cannot compare.\n"
          );
          process.exit(1);
        }
        const tmpContent = rfs(tmpPath, "utf-8");
        // Extract the block from the generated file (may or may not have sentinels)
        const extracted = extractSkeletonBlock(tmpContent);
        freshBlock = extracted !== null ? extracted : tmpContent;
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best-effort cleanup */
        }
      }
    } else {
      process.stderr.write(
        "tl skeleton: @tokenlighten/skeleton-engine has no usable exported function.\n"
      );
      process.exit(1);
    }

    // Byte-stable comparison of the skeleton block region
    if (freshBlock! !== checkedInBlock) {
      process.stderr.write(
        "tl skeleton check: AGENTS.md skeleton block is stale — run `tl agents-md write --for-target`\n"
      );
      process.exit(1);
    }

    process.stdout.write("tl skeleton check: fresh\n");
    process.exit(0);
  }

  process.stderr.write(`tl skeleton: unknown subcommand '${sub}'\n${SKELETON_USAGE}`);
  process.exit(1);
}
