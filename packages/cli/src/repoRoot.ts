/**
 * repoRoot.ts — sentinel-based repository root resolution.
 *
 * Walks up from the current file's directory looking for sentinel paths.
 * Honours TOKENLIGHTEN_REPO_ROOT env override for CI / test environments.
 *
 * Output policy: plain data — no meta envelope.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

/**
 * Resolve the TokenLighten repository root.
 *
 * Resolution order:
 *  1. TOKENLIGHTEN_REPO_ROOT env variable (if set).
 *  2. Walk upward from this file's directory, looking for sentinel files.
 *
 * @param opts.sentinels - Relative paths to check at each ancestor directory.
 *   Defaults to the public CLI and MCP package manifests.
 * @throws Error if neither env variable nor sentinel is found within 12 levels.
 */
export function resolveRepoRoot(opts?: { sentinels?: string[] }): string {
  if (process.env["TOKENLIGHTEN_REPO_ROOT"]) {
    return path.resolve(process.env["TOKENLIGHTEN_REPO_ROOT"]);
  }
  const sentinels = opts?.sentinels ?? [
    "packages/cli/package.json",
    "packages/mcp-server/package.json",
  ];
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (sentinels.some((s) => fs.existsSync(path.join(dir, s)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "TokenLighten repo root not found (set TOKENLIGHTEN_REPO_ROOT)"
  );
}
