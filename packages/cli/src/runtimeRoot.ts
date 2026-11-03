/**
 * runtimeRoot.ts — which workspace a `tl run` log or a compaction marker
 * belongs to (2026-11-03).
 *
 * A hook runs with the host's cwd, which may be a subdirectory the agent
 * `cd`ed into, while the MCP server keys its state by the workspace root.
 * The lookup therefore prefers a root the host names (`CLAUDE_PROJECT_DIR`,
 * an environment variable rather than a payload shape, so it costs the other
 * hosts nothing), then the nearest ancestor TokenLighten has already set up
 * (its private `.tokenlighten/.runtime/` directory, which `tl workspace
 * setup` creates), then the nearest repository root (`.git`), and finally
 * the start directory itself. The user's home directory is never a
 * workspace: `~/.tokenlighten` is TokenLighten's own configuration directory,
 * not a workspace runtime, and nothing above it is one either.
 */

import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeHome(): string | undefined {
  try {
    return resolve(homedir());
  } catch {
    return undefined;
  }
}

export function findWorkspaceRoot(start: string, env: NodeJS.ProcessEnv = process.env): string {
  const named = env["CLAUDE_PROJECT_DIR"];
  if (named !== undefined && named !== "" && isAbsolute(named) && isDirectory(named)) return resolve(named);
  const origin = resolve(start);
  const home = safeHome();
  for (const sentinel of [join(".tokenlighten", ".runtime"), ".git"]) {
    let cursor = origin;
    for (;;) {
      if (cursor === home) break;
      if (existsSync(join(cursor, sentinel))) return cursor;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return origin;
}
