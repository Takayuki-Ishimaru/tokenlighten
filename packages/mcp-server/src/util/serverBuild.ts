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

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shape of a dist/.build-stamp line (see scripts/write-build-stamp.mjs):
 * `<ISO of newest dist mtime>-<8..64 hex of the dist content sha256>`.
 * Anything else falls back to the optional source hash or single-file stat.
 */
const BUILD_STAMP_RE = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z-[0-9a-f]{8,64}$/;

/**
 * Derives a build identifier from a build stamp, an optional source tree hash,
 * or the mtime+size of the file backing
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
// The source tier is bounded and hashes names and bytes, never timestamps.
// A fixed ISO prefix keeps the existing wire shape while identical bytes stay stable.
function sourceBuildId(base: string, roots: readonly string[]): string {
  if (roots.length === 0 || roots.length > 128) throw new Error("invalid source roots");
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  const visit = (relative: string, depth: number): void => {
    if (depth > 32) throw new Error("source tree too deep");
    const parts = relative.split(/[\\/]/);
    if (isAbsolute(relative) || parts.some(part => !part || part === "." || part === "..")) throw new Error("invalid source path");
    let current = base;
    for (const part of parts) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error("source symlink");
    }
    const stat = lstatSync(current);
    if (stat.isDirectory()) {
      for (const child of readdirSync(current).sort()) visit(`${relative}/${child}`, depth + 1);
    } else if (stat.isFile()) {
      const key = parts.join("/");
      if (files.has(key)) return;
      if (files.size >= 10000 || stat.size > 100 * 1024 * 1024 - totalBytes) throw new Error("source tree too large");
      const bytes = readFileSync(current);
      totalBytes += bytes.length;
      if (totalBytes > 100 * 1024 * 1024) throw new Error("source tree too large");
      files.set(key, bytes);
    } else throw new Error("unsupported source entry");
  };
  for (const root of roots) visit(root, 0);
  const hash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    hash.update(`${Buffer.byteLength(name)}:`).update(name).update(`${bytes.length}:`).update(bytes);
  }
  return `1970-01-01T00:00:00.000Z-${hash.digest("hex")}`;
}

export function deriveServerBuildId(moduleUrl: string, sourceRoots?: readonly string[]): string | undefined {
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
    if (sourceRoots !== undefined) return sourceBuildId(dirname(filePath), sourceRoots);
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
export const SERVER_PACKAGE_VERSION_FALLBACK = "0.16.6";

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
