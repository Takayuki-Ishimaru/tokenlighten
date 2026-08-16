/**
 * workspaceBoundary.ts — nested linked-worktree awareness for the write path.
 *
 * A linked git worktree is a GIT metadata boundary, not a filesystem boundary,
 * and the agent harnesses this server serves place subagent worktrees INSIDE
 * the main checkout's own tree (`<root>/.claude/worktrees/<agent-id>`). Two
 * distinct hazards follow, both confirmed live on 2026-08-09:
 *
 *  1. AMBIGUITY. With such a worktree present, "the workspace" is genuinely
 *     under-determined for a call that never named one: the server's pinned
 *     root and each nested worktree are different logical workspaces with
 *     different branches checked out. A cwd-less write silently resolved
 *     against the pinned root and reported plain success — four files landed
 *     in the shared checkout while the calling agent believed it was editing
 *     its own worktree.
 *  2. CROSSING. `safeResolve`/the per-tool containment checks verify only that
 *     a target is a lexical DESCENDANT of the resolved root. A nested
 *     worktree's tracked files trivially satisfy that, so a relative path
 *     containing `.claude/worktrees/<other-agent>/...` mutates a DIFFERENT
 *     workspace even when the caller declared its own `cwd` correctly.
 *
 * This module answers both questions from the repository's OWN worktree
 * registry (`<common-git-dir>/worktrees/<id>/gitdir` — the same capability
 * `registeredWorktreeRoot` trusts), never by walking the filesystem, so the
 * cost is O(registered worktrees) and independent of repo size. Results are
 * cached per root and revalidated by the registry directory's mtime plus a
 * short TTL, so the overwhelmingly common single-root case costs at most one
 * cached `stat` — and zero syscalls when the root owns no worktree registry
 * at all.
 *
 * Pure module: no MCP/transport coupling, fully unit-testable.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import * as path from "path";

import { isWithin } from "../util/safePath.js";
import { commonGitDirectory, realDirectory } from "./resolveWorkspace.js";

/**
 * How long a scan result stays trusted without re-deriving the registry path.
 * Short enough that a worktree created (or a whole `.git/worktrees` registry
 * brought into being) between two calls is picked up within one interaction,
 * long enough that a batch of writes in the same turn pays for one scan.
 */
const CACHE_TTL_MS = 2000;

/**
 * Hard cap on how many nested worktrees a single scan reports. The list rides
 * refusal payloads as `cwd_candidates`; a machine with dozens of live agent
 * worktrees must not turn one refusal into kilobytes of candidates.
 */
export const MAX_NESTED_WORKSPACES = 8;

interface NestedScan {
  /** Canonical roots of live linked worktrees nested strictly inside the scanned root. */
  roots: string[];
  /** `<common-git-dir>/worktrees` when it exists — the mtime revalidation anchor. */
  worktreesDir: string | undefined;
  worktreesMtimeMs: number;
  expiresAt: number;
}

const scanCache = new Map<string, NestedScan>();

/** Test hook: drop every cached scan (also used when a fixture mutates worktrees mid-test). */
export function resetNestedWorkspaceCache(): void {
  scanCache.clear();
}

function emptyScan(worktreesDir: string | undefined, mtimeMs: number, now: number): NestedScan {
  return { roots: [], worktreesDir, worktreesMtimeMs: mtimeMs, expiresAt: now + CACHE_TTL_MS };
}

function scanNestedWorkspaces(root: string): NestedScan {
  const now = Date.now();
  const real = realDirectory(root);
  if (!real) return emptyScan(undefined, 0, now);
  const commonGitDir = commonGitDirectory(real);
  if (!commonGitDir) return emptyScan(undefined, 0, now);

  const worktreesDir = path.join(commonGitDir, "worktrees");
  let mtimeMs: number;
  try {
    const stat = statSync(worktreesDir);
    if (!stat.isDirectory()) return emptyScan(undefined, 0, now);
    mtimeMs = stat.mtimeMs;
  } catch {
    // No registry: this root owns no linked worktrees at all.
    return emptyScan(undefined, 0, now);
  }

  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(worktreesDir, { withFileTypes: true });
  } catch {
    return emptyScan(worktreesDir, mtimeMs, now);
  }

  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const adminDir = path.join(worktreesDir, entry.name);
    try {
      const raw = readFileSync(path.join(adminDir, "gitdir"), "utf8").trim();
      if (!raw) continue;
      const marker = path.isAbsolute(raw) ? raw : path.resolve(adminDir, raw);
      // A pruned/stale record is not a live workspace.
      if (path.basename(marker) !== ".git" || !existsSync(marker)) continue;
      const worktree = realDirectory(path.dirname(marker));
      // Strictly INSIDE: the scanned root itself is never its own foreign
      // territory, and a sibling/tmpdir worktree (bench cells live there) is
      // unreachable by a relative path from this root, so neither is nesting.
      if (!worktree || worktree === real || !isWithin(worktree, real)) continue;
      if (!roots.includes(worktree)) roots.push(worktree);
    } catch {
      // A stale or unreadable worktree record is not a capability.
    }
  }
  roots.sort();
  return {
    roots: roots.slice(0, MAX_NESTED_WORKSPACES),
    worktreesDir,
    worktreesMtimeMs: mtimeMs,
    expiresAt: now + CACHE_TTL_MS,
  };
}

/**
 * Canonical roots of live linked worktrees of the SAME repository that are
 * nested strictly inside `root`. Empty for a plain checkout, for a non-git
 * directory, and for a worktree that itself contains no further worktrees —
 * i.e. for every unambiguous workspace.
 *
 * Cached: within the TTL a root whose repository owns a worktree registry
 * costs one `stat` (the registry directory's mtime changes whenever a worktree
 * is added or removed), and a root with no registry at all costs nothing.
 */
export function nestedWorkspaceRoots(root: string): string[] {
  const hit = scanCache.get(root);
  if (hit !== undefined && Date.now() < hit.expiresAt) {
    if (hit.worktreesDir === undefined) return hit.roots;
    try {
      if (statSync(hit.worktreesDir).mtimeMs === hit.worktreesMtimeMs) return hit.roots;
    } catch {
      // The registry vanished — fall through and rescan.
    }
  }
  const fresh = scanNestedWorkspaces(root);
  scanCache.set(root, fresh);
  return fresh.roots;
}

/**
 * True when `workspace` physically contains at least one other live workspace,
 * i.e. when "which tree did you mean?" has more than one honest answer. This
 * is the ambiguity predicate the undeclared-workspace write guard keys on, and
 * the single gate that keeps every single-root deployment byte-identical.
 */
export function workspaceIsAmbiguous(workspace: string): boolean {
  return nestedWorkspaceRoots(workspace).length > 0;
}

/**
 * The nested workspace a target lands in, or undefined when the target stays
 * inside `workspace` itself. `target` may be workspace-relative or absolute;
 * either way it is compared lexically against canonical nested roots, matching
 * the containment checks it is meant to reinforce.
 *
 * Note the asymmetry this deliberately encodes: when `workspace` IS a nested
 * worktree, nothing is nested inside it, so every target in its own tree is
 * allowed. The question is only ever "does this write cross INTO a different
 * workspace", never "is this path under some worktree somewhere".
 */
export function nestedWorkspaceCrossing(target: string, workspace: string): string | undefined {
  const nested = nestedWorkspaceRoots(workspace);
  if (nested.length === 0) return undefined;
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  for (const root of nested) {
    if (isWithin(abs, root)) return root;
  }
  return undefined;
}
