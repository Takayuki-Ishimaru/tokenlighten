// workspaceBoundary.spec.ts — nested linked-worktree detection and the
// crossing predicate that the write path's F1/F3 guards are built on.
//
// The 2026-08-09 root-mismatch incident had two independent causes; both are
// answered by this module, so both are pinned here at the unit level:
//   - AMBIGUITY: `<root>/.claude/worktrees/<agent-id>` is a different logical
//     workspace, so a root that contains one cannot silently be "the" tree.
//   - CROSSING: a path that traverses INTO such a worktree is not a
//     subdirectory of the root, even though it is a lexical descendant of it.
//
// These tests create REAL `git worktree add` worktrees; anything less would
// not exercise the `<common-git-dir>/worktrees/<id>/gitdir` registry the scan
// reads.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import {
  nestedWorkspaceCrossing,
  nestedWorkspaceRoots,
  resetNestedWorkspaceCache,
  workspaceIsAmbiguous,
} from "../write/workspaceBoundary.js";
import { renameSymbol } from "../tools/renameSymbol.js";
import { unsafeGuardedWorkspaceRootForTests } from "../write/guardedWorkspace.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];

function mkGitRepo(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-wsb-${label}-`)));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), label, "utf8");
  execFileSync("git", ["-C", dir, "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-m", "init"], { stdio: "pipe" });
  return dir;
}

/** The real topology: a linked worktree NESTED inside the main checkout. */
function addNestedWorktree(repo: string, agentId: string): string {
  const target = path.join(repo, ".claude", "worktrees", agentId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", `tl-${agentId}`, target], {
    stdio: "pipe",
  });
  return fs.realpathSync(target);
}

/** A linked worktree of the same repo that lives OUTSIDE it (bench-cell shape). */
function addSiblingWorktree(repo: string, label: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `tl-wsb-${label}-`));
  fs.rmSync(target, { recursive: true, force: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", `tl-${label}`, target], {
    stdio: "pipe",
  });
  tmpDirs.push(target);
  return fs.realpathSync(target);
}

afterEach(() => {
  resetNestedWorkspaceCache();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("workspaceBoundary — nested workspace detection", () => {
  it("reports nothing for a plain checkout with no linked worktrees", () => {
    const repo = mkGitRepo("plain");
    expect(nestedWorkspaceRoots(repo)).toEqual([]);
    expect(workspaceIsAmbiguous(repo)).toBe(false);
  });

  it("reports nothing for a directory that is not a git repository at all", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-wsb-nogit-")));
    tmpDirs.push(dir);
    expect(nestedWorkspaceRoots(dir)).toEqual([]);
  });

  it("finds a linked worktree nested at .claude/worktrees/<agent-id>", () => {
    const repo = mkGitRepo("nested");
    const agent = addNestedWorktree(repo, "agent-x");
    resetNestedWorkspaceCache();
    expect(nestedWorkspaceRoots(repo)).toEqual([agent]);
    expect(workspaceIsAmbiguous(repo)).toBe(true);
  });

  it("ignores a linked worktree that lives OUTSIDE the root (bench-cell shape)", () => {
    const repo = mkGitRepo("sibling");
    addSiblingWorktree(repo, "cell");
    resetNestedWorkspaceCache();
    // Registered, live, same repo — but not reachable by a relative path from
    // `repo`, so it is not a nesting hazard and must not make the root
    // ambiguous (this is exactly the bench topology, which must stay on the
    // zero-change fast path).
    expect(nestedWorkspaceRoots(repo)).toEqual([]);
  });

  it("reports nothing when scanning the nested worktree itself", () => {
    const repo = mkGitRepo("selfscan");
    const agent = addNestedWorktree(repo, "agent-y");
    resetNestedWorkspaceCache();
    // Nothing is nested inside the worktree, so a server rooted there is
    // unambiguous — the whole point of the "relative to the EFFECTIVE
    // workspace" framing.
    expect(nestedWorkspaceRoots(agent)).toEqual([]);
    expect(workspaceIsAmbiguous(agent)).toBe(false);
  });

  it("invalidates its cache when a worktree appears or disappears", () => {
    const repo = mkGitRepo("cache");
    expect(nestedWorkspaceRoots(repo)).toEqual([]);

    const agent = addNestedWorktree(repo, "agent-z");
    // First registry creation cannot be caught by an mtime check (there was no
    // registry directory to watch), so the explicit reset stands in for the
    // TTL that covers it in production.
    resetNestedWorkspaceCache();
    expect(nestedWorkspaceRoots(repo)).toEqual([agent]);

    // Removal, on the other hand, mutates the registry directory — the cached
    // scan must notice WITHOUT any reset.
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", agent], { stdio: "pipe" });
    expect(nestedWorkspaceRoots(repo)).toEqual([]);
  });

  it("drops a registry record whose worktree directory was deleted by hand", () => {
    const repo = mkGitRepo("stale");
    const agent = addNestedWorktree(repo, "agent-stale");
    resetNestedWorkspaceCache();
    expect(nestedWorkspaceRoots(repo)).toEqual([agent]);

    fs.rmSync(agent, { recursive: true, force: true });
    resetNestedWorkspaceCache();
    // The admin record survives `rm -rf` — a prunable, not a live, workspace.
    expect(nestedWorkspaceRoots(repo)).toEqual([]);
  });
});

describe("workspaceBoundary — crossing predicate", () => {
  it("flags a relative path that traverses into a nested worktree", () => {
    const repo = mkGitRepo("cross");
    const agent = addNestedWorktree(repo, "agent-c");
    resetNestedWorkspaceCache();
    expect(nestedWorkspaceCrossing(".claude/worktrees/agent-c/a.txt", repo)).toBe(agent);
    expect(nestedWorkspaceCrossing(".claude/worktrees/agent-c", repo)).toBe(agent);
  });

  it("flags the same target given absolutely", () => {
    const repo = mkGitRepo("crossabs");
    const agent = addNestedWorktree(repo, "agent-abs");
    resetNestedWorkspaceCache();
    expect(nestedWorkspaceCrossing(path.join(agent, "a.txt"), repo)).toBe(agent);
  });

  it("leaves ordinary in-root targets alone", () => {
    const repo = mkGitRepo("inroot");
    addNestedWorktree(repo, "agent-i");
    resetNestedWorkspaceCache();
    expect(nestedWorkspaceCrossing("a.txt", repo)).toBeUndefined();
    expect(nestedWorkspaceCrossing(".claude/settings.json", repo)).toBeUndefined();
    // A sibling directory whose name merely PREFIXES the worktree path.
    expect(nestedWorkspaceCrossing(".claude/worktrees/agent-i-notes.md", repo)).toBeUndefined();
  });

  it("allows every target inside the nested worktree when IT is the workspace", () => {
    const repo = mkGitRepo("asws");
    const agent = addNestedWorktree(repo, "agent-w");
    resetNestedWorkspaceCache();
    expect(nestedWorkspaceCrossing("a.txt", agent)).toBeUndefined();
    expect(nestedWorkspaceCrossing(path.join(agent, "a.txt"), agent)).toBeUndefined();
  });
});

describe("workspaceBoundary — renameSymbol's DISCOVERED targets", () => {
  it("skips a nested worktree's files instead of rewriting them, and says so", async () => {
    // `.claude/worktrees/` is already outside the walk (DEFAULT_IGNORE), so
    // the hazard only shows at ANY OTHER nesting location — which is exactly
    // why a rename cannot rely on the ignore list for correctness here.
    const repo = mkGitRepo("rename");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src/a.ts"),
      "export function oldName(): number { return oldName.length; }\n",
      "utf8",
    );
    execFileSync("git", ["-C", repo, "add", "."], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "commit", "-m", "src"], { stdio: "pipe" });

    const other = path.join(repo, "wt", "agent-rename");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "tl-rename", other], { stdio: "pipe" });
    resetNestedWorkspaceCache();

    const result = await renameSymbol(
      { from: "oldName", to: "newName" },
      unsafeGuardedWorkspaceRootForTests(repo),
      true,
      "test-session",
    );
    expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
    if (!result.ok) return;

    expect(result.changed_files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(result.skipped).toContainEqual({ path: "wt/agent-rename/src/a.ts", reason: "other-workspace" });
    expect(fs.readFileSync(path.join(repo, "src/a.ts"), "utf8")).toContain("newName");
    expect(fs.readFileSync(path.join(other, "src/a.ts"), "utf8")).toContain("oldName");
  }, 30000);
});
