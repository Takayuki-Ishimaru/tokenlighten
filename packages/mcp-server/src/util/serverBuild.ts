/**
 * serverBuild.ts — filesystem-only build identity for the running MCP
 * server process (W3, 2026-07-30: dist build-id echo).
 *
 * Why: nothing today records which dist/ bytes a given MCP child process
 * actually loaded. An editor or CLI can hold a long-lived server process
 * open across a `npm run build`, so every response it serves afterward is
 * silently computed by STALE dispatch/schema logic with no external signal
 * that anything is wrong — a real forensic gap when diagnosing "why doesn't
 * this behave like the source I'm reading".
 *
 * Deliberately filesystem-only: no `git rev-parse` / `git log` shell-out.
 * A subprocess per server start is wasteful, and a git-derived id would go
 * silently wrong (or require extra error handling) in any checkout without
 * a `.git` present (e.g. an extracted npm tarball). mtime+size of the
 * dispatch module's own compiled (or, under tsx, source) file is cheap,
 * synchronous, and needs nothing but `fs.statSync`.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shape of a dist/.build-stamp line (see scripts/write-build-stamp.mjs):
 * `<ISO of newest dist mtime>-<8..64 hex of the dist content sha256>`.
 * Anything else falls back to the single-file stat fingerprint below.
 */
const BUILD_STAMP_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z-[0-9a-f]{8,64}$/;

/**
 * Derives a build identifier from the mtime+size of the file backing
 * `moduleUrl`. Pass the CALLER's own `import.meta.url` — server.ts's, in
 * practice, since that module holds the dispatch/schema logic this id is
 * meant to distinguish between builds; a util file that rarely changes
 * would make a poor proxy for "did the server's behavior change".
 *
 * Returns undefined if the stat fails (e.g. a packaging scheme with no real
 * on-disk file backing the module) — callers must treat that as "omit
 * server_build entirely", never as a placeholder/sentinel string.
 *
 * Not cached here: ES module top-level code runs exactly once per process,
 * so a caller that assigns the result to a module-level `const` already
 * gets once-per-process computation for free, with no separate cache flag
 * to keep in sync.
 */
export function deriveServerBuildId(moduleUrl: string): string | undefined {
  try {
    const filePath = fileURLToPath(moduleUrl);
    // Tier 1: the build stamp written next to the module by
    // scripts/write-build-stamp.mjs — a content hash over the whole dist
    // tree. The single-file stat below can survive an incremental tsc run
    // untouched (observed 2026-07-31: a fresh rebuild kept reporting the
    // pre-rebuild fingerprint), and it cannot tell an identical-content
    // rebuild from a code change; the hash answers both correctly. Under
    // tsx (running from src/) no stamp exists and the stat tier applies.
    try {
      const stamp = readFileSync(join(dirname(filePath), ".build-stamp"), "utf8").trim();
      if (BUILD_STAMP_RE.test(stamp)) return stamp;
    } catch {
      // no readable stamp — fall through to the stat fingerprint
    }
    const stat = statSync(filePath);
    return `${stat.mtime.toISOString()}-${stat.size}`;
  } catch {
    return undefined;
  }
}

const SERVER_PACKAGE_NAME = "@tokenlighten/mcp-server";

/**
 * Fallback when no owning package.json is reachable from the running module
 * (e.g. a single-file bundle that ships no manifest alongside the code).
 * serverPackageVersion.spec.ts pins this literal to the real package.json
 * version, so it cannot drift silently the way the previous hardcoded
 * serverInfo "0.2.0" did.
 */
export const SERVER_PACKAGE_VERSION_FALLBACK = "0.13.1";

/**
 * Resolve the running server's own package version by walking up from the
 * module location to the nearest package.json whose name matches this
 * package. Name-checked so a bundling host's own manifest is never
 * mistaken for ours; bounded walk so an unexpected layout degrades to the
 * pinned fallback instead of scanning the filesystem.
 */
export function deriveServerPackageVersion(moduleUrl: string): string {
  try {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let hops = 0; hops < 4; hops++) {
      try {
        const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name === SERVER_PACKAGE_NAME && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        // no parseable package.json at this level — keep walking up
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fileURLToPath failure (non-file module URL) — use the fallback
  }
  return SERVER_PACKAGE_VERSION_FALLBACK;
}
