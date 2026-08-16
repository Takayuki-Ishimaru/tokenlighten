/**
 * resolveWorkspace.ts — per-call workspace-root resolution for write tools.
 *
 * The MCP server resolves workspace-relative paths against a single root that is
 * pinned ONCE at startup (positional arg / TOKENLIGHTEN_ROOT / process.cwd();
 * see server.ts). That is fine for a one-repo session, but the same long-lived
 * process is frequently SHARED across git worktrees — e.g. a Claude Code session
 * plus its `isolation:'worktree'` subagents all talk to one stdio server. A
 * relative-path edit issued from a worktree subagent would then resolve against
 * the pinned (main) checkout and silently edit the WRONG tree — exactly the
 * failure the bench harness documents (bench/workflows/README.md "S3 isolation
 * caveat": "If you change the TL MCP server to honor a per-call workspace root,
 * this caveat goes away.").
 *
 * Fix: the write tools accept an optional `cwd` — the absolute path of the
 * caller's actual worktree. By default it must resolve inside the pinned
 * workspace root itself; no ambient directory such as the user's home dir is
 * trusted without explicit configuration. A worktree registered by the pinned
 * repository is also accepted automatically: the repository's own `.git/worktrees/<id>/gitdir`
 * record is the capability, so no broad temp-directory grant is needed. A
 * server operator may additionally name explicit worktree container
 * directories; only their children (never the container itself) are accepted.
 * Anything unusable falls back to the pinned root — a fallback, never an error,
 * so single-root callers that omit `cwd` are completely unaffected.
 *
 * Mirrors the prototype's `isCwdAccepted` / `safeResolveAt`
 * ("iter-5: cwd-aware resolution for worktree subagents", proto/src/mcp/server.ts).
 *
 * Pure module: no MCP/transport coupling, fully unit-testable.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** True when `child` is `base` itself or nested beneath it. */
function isWithin(child: string, base: string): boolean {
  return child === base || child.startsWith(base + path.sep);
}

/** Resolve an existing directory to its canonical path. */
export function realDirectory(candidate: string): string | undefined {
  try {
    const real = fs.realpathSync(candidate);
    return fs.statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the common git directory owned by a pinned checkout/worktree.
 *
 * Exported for workspaceBoundary.ts: the same `<common-git-dir>/worktrees/`
 * registry that proves a caller-supplied `cwd` is a legitimate worktree also
 * enumerates the worktrees nested INSIDE a root, which is what the write path
 * needs in order to treat them as foreign territory rather than ordinary
 * subdirectories.
 */
export function commonGitDirectory(workspaceRoot: string): string | undefined {
  const root = realDirectory(workspaceRoot);
  if (!root) return undefined;
  const dotGit = path.join(root, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) return fs.realpathSync(dotGit);
    if (!fs.statSync(dotGit).isFile()) return undefined;
    const marker = fs.readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/i.exec(marker);
    if (!match) return undefined;
    const adminDir = fs.realpathSync(
      path.isAbsolute(match[1]!) ? match[1]! : path.resolve(root, match[1]!),
    );
    const commonDirFile = path.join(adminDir, "commondir");
    if (fs.existsSync(commonDirFile)) {
      const common = fs.readFileSync(commonDirFile, "utf8").trim();
      if (!common) return undefined;
      return fs.realpathSync(path.resolve(adminDir, common));
    }
    return path.basename(path.dirname(adminDir)) === "worktrees"
      ? fs.realpathSync(path.dirname(path.dirname(adminDir)))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the exact registered worktree boundary containing `cwd`.
 *
 * Git writes `<common-git-dir>/worktrees/<id>/gitdir` when `git worktree add`
 * succeeds. That record points at the worktree's `.git` marker and remains the
 * repository-owned proof even when the benchmark seals the linked worktree by
 * replacing the marker with a standalone `.git` directory. We trust only
 * records under the pinned repository's own common git directory, require the
 * pointed-to `.git` marker to still exist, and compare canonical paths. A
 * sibling temp directory, the temp parent itself, or a symlink escape cannot
 * satisfy this check.
 */
export function registeredWorktreeRoot(
  cwd: string | undefined,
  pinnedRoot: string,
): string | undefined {
  if (!cwd || !path.isAbsolute(cwd)) return undefined;
  const real = realDirectory(cwd);
  const commonGitDir = commonGitDirectory(pinnedRoot);
  if (!real || !commonGitDir) return undefined;

  const worktreesDir = path.join(commonGitDir, "worktrees");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const adminDir = path.join(worktreesDir, entry.name);
    try {
      const raw = fs.readFileSync(path.join(adminDir, "gitdir"), "utf8").trim();
      if (!raw) continue;
      const gitMarker = path.isAbsolute(raw) ? raw : path.resolve(adminDir, raw);
      if (path.basename(gitMarker) !== ".git" || !fs.existsSync(gitMarker)) continue;
      const worktree = realDirectory(path.dirname(gitMarker));
      if (worktree && isWithin(real, worktree)) return worktree;
    } catch {
      // A stale/prunable worktree record is not a capability.
    }
  }
  return undefined;
}

/**
 * True when `real` is inside a direct child of an explicitly allowed parent.
 *
 * The parent itself is never a workspace. Its first path component is the
 * trust boundary (normally one isolated git worktree), while deeper cwd values
 * remain valid bases inside that boundary. Both sides are realpathed before
 * this check, so a child symlink cannot escape to an unrelated directory.
 */
function isInsideAllowedParentChild(real: string, allowedParent: string): boolean {
  const parentReal = realDirectory(allowedParent);
  if (!parentReal || real === parentReal || !isWithin(real, parentReal)) return false;
  const rel = path.relative(parentReal, real);
  const first = rel.split(path.sep)[0];
  return Boolean(first && first !== ".." && !path.isAbsolute(rel));
}

interface BenchCellConfig {
  sealed?: string;
  iter?: string;
  sourceRoot?: string;
  baseHead?: string;
}

function unquoteGitConfigValue(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

/** Read only the capability-bearing [tl "bench"] keys from a local config. */
function readBenchCellConfig(root: string): BenchCellConfig | undefined {
  const dotGit = path.join(root, ".git");
  try {
    // A sealed cell owns a real standalone repository. Do not accept a
    // symlink or linked-worktree .git file through this capability path.
    if (!fs.lstatSync(dotGit).isDirectory()) return undefined;
    const raw = fs.readFileSync(path.join(dotGit, "config"), "utf8");
    const out: BenchCellConfig = {};
    let inBenchSection = false;
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) {
        inBenchSection = /^\s*\[\s*tl\s+"bench"\s*\]\s*(?:[#;].*)?$/i.test(line);
        continue;
      }
      if (!inBenchSection) continue;
      const match = /^\s*([A-Za-z0-9-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      const value = unquoteGitConfigValue(match[2]!);
      if (match[1] === "sealed") out.sealed = value;
      else if (match[1] === "iter") out.iter = value;
      else if (match[1] === "source-root") out.sourceRoot = value;
      else if (match[1] === "base-head") out.baseHead = value;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Admit a completed, independently sealed benchmark cell without relying on
 * the source repository's linked-worktree registry.
 *
 * This is deliberately narrower than an implicit temp-directory allowlist:
 * the canonical path must be a direct cell under the fixed OS-temp parent,
 * the standalone repo must carry the setup transaction's seal/iter/base-head,
 * the cell name must be owned by that iter, and its source-root must resolve
 * to the server's pinned root.
 */
function sealedBenchCellRoot(real: string, pinnedRoot: string): string | undefined {
  const parent = realDirectory(path.join(os.tmpdir(), "tl-bench-worktrees"));
  const pinned = realDirectory(pinnedRoot);
  if (!parent || !pinned || real === parent || !isWithin(real, parent)) return undefined;
  const rel = path.relative(parent, real);
  const first = rel.split(path.sep)[0];
  if (!first || first === ".." || path.isAbsolute(rel)) return undefined;
  const cell = realDirectory(path.join(parent, first));
  if (!cell || !isWithin(real, cell)) return undefined;

  const config = readBenchCellConfig(cell);
  if (config?.sealed !== "1") return undefined;
  if (!config.iter || !/^n10-v07-[A-Za-z0-9_.-]+$/.test(config.iter)) return undefined;
  if (!path.basename(cell).startsWith(`${config.iter}-`)) return undefined;
  if (!config.baseHead || !/^[0-9a-f]{40,64}$/i.test(config.baseHead)) return undefined;
  const sourceRoot = config.sourceRoot ? realDirectory(config.sourceRoot) : undefined;
  return sourceRoot === pinned ? cell : undefined;
}

/**
 * Decide whether a caller-supplied `cwd` override is acceptable as a workspace
 * root. It must be:
 *   - an absolute path,
 *   - to an existing directory,
 *   - whose realpath is inside the pinned workspace root, or inside one direct
 *     child boundary beneath an explicitly configured allowed parent, or
 *     inside a worktree registered by the pinned repository.
 * The realpath checks reject `/`, `/etc`, unrelated `/var` directories, and
 * symlink escapes. An allowed parent is only a container: it is never accepted
 * as the workspace root itself.
 */
export function isWorkspaceOverrideAccepted(
  cwd: string | undefined,
  allowedParents: readonly string[] = [],
  pinnedRoot?: string,
): cwd is string {
  if (!cwd || !path.isAbsolute(cwd)) return false;
  const real = realDirectory(cwd);
  if (!real) return false;
  const pinned = pinnedRoot ? realDirectory(pinnedRoot) : undefined;
  if (pinned && isWithin(real, pinned)) return true;
  if (pinnedRoot && registeredWorktreeRoot(real, pinnedRoot)) return true;
  if (pinnedRoot && sealedBenchCellRoot(real, pinnedRoot)) return true;
  return allowedParents.some((parent) => isInsideAllowedParentChild(real, parent));
}

/**
 * Normalize a workspace root path via realpathSync, tolerating missing paths
 * by falling back to the input. Use sync to keep call sites synchronous.
 */
export function realpathWorkspaceRoot(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * Pick the workspace root a write call should resolve against: the validated
 * `cwd` override when acceptable, otherwise the server's pinned `fallbackRoot`.
 *
 * Returns an absolute, fully resolved (realpath) workspace root. Callers can
 * store this directly in a handle's `workspaceRoot` field — no further
 * normalization needed.
 *
 * This only chooses WHICH root; the per-file path-escape and symlink guards in
 * each write tool still run against whatever root this returns. A caller can
 * retarget only to the pinned workspace root itself, a worktree registered by
 * the pinned repository, or a child worktree under an operator-approved parent;
 * it cannot widen access beyond that workspace root.
 */
export function resolveWorkspaceRoot(
  cwd: string | undefined,
  fallbackRoot: string,
  allowedParents: readonly string[] = [],
): string {
  const chosen = isWorkspaceOverrideAccepted(cwd, allowedParents, fallbackRoot) ? path.resolve(cwd) : fallbackRoot;
  return realpathWorkspaceRoot(chosen);
}
