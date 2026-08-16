// cwdRouting.spec.ts — integration tests for per-call cwd workspace routing.
//
// Verifies that all handlers pass the resolved workspace to their tool
// implementations, so a caller that supplies cwd=<worktree> gets results from
// the worktree rather than the server's pinned activeRoot.
//
// Tests:
//   - getCurrentDiff with cwd=worktree returns worktree diff (explore action=diff)
//   - getCurrentDiff alias (get_current_diff) with cwd=worktree returns worktree diff
//   - resolveWorkspaceRoot falls back to activeRoot when cwd is omitted
//
// NOTE: these tests exercise repository-owned Git worktree routing. Explicit
// outside-root parent grants are covered separately in serverSideFixesP2.spec.ts.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { getCurrentDiff } from "../tools/getCurrentDiff.js";
import { resolveWorkspaceRoot } from "../write/resolveWorkspace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];

function mkGitRepo(label: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-cwd-${label}-`));
  tmpDirs.push(dir);

  fs.writeFileSync(path.join(dir, "a.txt"), label, "utf8");

  execFileSync("git", ["-C", dir, "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-m", "init"], { stdio: "pipe" });

  return dir;
}

function mkRegisteredWorktree(repo: string, label: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `tl-cwd-${label}-`));
  fs.rmSync(target, { recursive: true, force: true });
  const branch = `tl-${label.toLowerCase()}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, target], {
    stdio: "ignore",
  });
  tmpDirs.push(target);
  return target;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cwd routing — explore action=diff / get_current_diff", () => {
  it("getCurrentDiff returns worktree diff when passed worktree workspace", async () => {
    const mainRepo = mkGitRepo("MAIN");
    const worktreeRepo = mkRegisteredWorktree(mainRepo, "WORKTREE");

    // Modify a.txt in worktree AFTER the initial commit so git diff HEAD shows content.
    fs.writeFileSync(path.join(worktreeRepo, "a.txt"), "WORKTREE-MODIFIED", "utf8");

    const worktreeWorkspace = resolveWorkspaceRoot(worktreeRepo, mainRepo);
    expect(worktreeWorkspace).toBe(fs.realpathSync(worktreeRepo));

    const result = await getCurrentDiff({}, worktreeWorkspace);

    expect(result.error).toBeUndefined();
    // The worktree diff should include a.txt (the modified file).
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    expect(result.files[0]!.path).toBe("a.txt");
    expect(result.files[0]!.status).toBe("modified");
  });

  it("getCurrentDiff returns main diff when cwd is omitted (falls back to activeRoot)", async () => {
    const mainRepo = mkGitRepo("MAIN");
    const worktreeRepo = mkGitRepo("WORKTREE");

    // Modify a.txt in main after commit so git diff HEAD shows content.
    fs.writeFileSync(path.join(mainRepo, "a.txt"), "MAIN-MODIFIED", "utf8");
    // Also modify worktree so if routing is wrong we'd see worktree content.
    fs.writeFileSync(path.join(worktreeRepo, "a.txt"), "WORKTREE-MODIFIED", "utf8");

    // cwd=undefined → falls back to mainRepo (activeRoot)
    const workspace = resolveWorkspaceRoot(undefined, mainRepo);
    expect(workspace).toBe(mainRepo);

    const result = await getCurrentDiff({}, workspace);

    expect(result.error).toBeUndefined();
    // The main diff should include a.txt (the modified file in main).
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    expect(result.files[0]!.path).toBe("a.txt");
    expect(result.files[0]!.status).toBe("modified");
  });

  it("resolveWorkspaceRoot accepts a registered Git worktree", () => {
    const mainRepo = mkGitRepo("MAIN");
    const worktreeRepo = mkRegisteredWorktree(mainRepo, "WORKTREE");

    const resolved = resolveWorkspaceRoot(worktreeRepo, mainRepo);
    expect(resolved).toBe(fs.realpathSync(worktreeRepo));
  });

  it("resolveWorkspaceRoot rejects an unrelated repository inside $HOME", () => {
    const mainRepo = mkGitRepo("MAIN");
    const unrelatedRepo = mkGitRepo("UNRELATED");

    const resolved = resolveWorkspaceRoot(unrelatedRepo, mainRepo);
    expect(resolved).toBe(path.resolve(mainRepo));
  });

  it("resolveWorkspaceRoot falls back when cwd is a non-existent path", () => {
    const mainRepo = mkGitRepo("MAIN");
    const bogus = path.join(HOME, "does-not-exist-" + Date.now());

    const resolved = resolveWorkspaceRoot(bogus, mainRepo);
    expect(resolved).toBe(mainRepo);
  });

  it("worktree diff is empty when no uncommitted changes exist in worktree", async () => {
    const mainRepo = mkGitRepo("MAIN");
    const worktreeRepo = mkRegisteredWorktree(mainRepo, "WORKTREE");

    // Modify main but NOT worktree — the workspace we pass is worktreeRepo.
    fs.writeFileSync(path.join(mainRepo, "a.txt"), "MAIN-MODIFIED", "utf8");

    const workspace = resolveWorkspaceRoot(worktreeRepo, mainRepo);
    const result = await getCurrentDiff({}, workspace);

    expect(result.error).toBeUndefined();
    expect(result.files).toEqual([]);
    expect(result.totalFiles).toBe(0);
  });
});
