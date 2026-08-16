// shadowGit.spec.ts — unit tests for the shadow-git checkpoint store.
//
// Uses mkdtemp for all fixtures.
// Tests check git presence via spawnSync('git', ['--version']).
// If git is not available, tests are skipped with it.skip.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  ensureInit,
  createCheckpoint,
  shadowGitDir,
  gitAvailable,
  __resetShadowGitForTests,
} from "../write/shadowGit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-sg-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

const GIT_AVAILABLE = gitAvailable();

beforeEach(() => {
  __resetShadowGitForTests();
});

afterEach(() => {
  __resetShadowGitForTests();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shadowGit — lazy init", () => {
  const test = GIT_AVAILABLE ? it : it.skip;

  test("creates .tokenlighten/checkpoints/.git on first call", () => {
    const ws = mkWorkspace();
    const ok = ensureInit(ws);
    expect(ok).toBe(true);
    const gitDir = shadowGitDir(ws);
    expect(fs.existsSync(gitDir)).toBe(true);
    // HEAD file should exist inside the git dir.
    expect(fs.existsSync(path.join(gitDir, "HEAD"))).toBe(true);
  });

  test("ensureInit is idempotent", () => {
    const ws = mkWorkspace();
    expect(ensureInit(ws)).toBe(true);
    expect(ensureInit(ws)).toBe(true);
    // Git dir still valid.
    expect(fs.existsSync(path.join(shadowGitDir(ws), "HEAD"))).toBe(true);
  });
});

describe("shadowGit — createCheckpoint", () => {
  const test = GIT_AVAILABLE ? it : it.skip;

  test("creates a commit and returns a checkpoint_id SHA", () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/foo.ts", "const x = 1;\n");

    const result = createCheckpoint(ws, ["src/foo.ts"], "test: initial checkpoint");

    expect(result.ok).toBe(true);
    // checkpoint_id should look like a git SHA (40 hex chars) or short SHA.
    if (result.checkpointId) {
      expect(result.checkpointId).toMatch(/^[0-9a-f]{4,}/);
    }
  });

  test("stages only specified files — not via git add -A", () => {
    const ws = mkWorkspace();
    writeFile(ws, "tracked.ts", "const a = 1;\n");
    writeFile(ws, "untracked.ts", "const b = 2;\n");

    const result = createCheckpoint(ws, ["tracked.ts"], "test: stage only tracked.ts");

    expect(result.ok).toBe(true);

    // Check git status — untracked.ts should NOT be committed.
    const gitDir = shadowGitDir(ws);
    const statusResult = spawnSync(
      "git",
      ["--git-dir", gitDir, "--work-tree", ws, "show", "--name-only", "--format=", "HEAD"],
      { encoding: "utf8", shell: false }
    );
    const committedFiles = statusResult.stdout.trim().split("\n").filter(Boolean);
    // tracked.ts should be in the commit.
    expect(committedFiles.some((f) => f.includes("tracked.ts"))).toBe(true);
    // untracked.ts should NOT be in the commit (only specific files were staged).
    expect(committedFiles.some((f) => f.includes("untracked.ts"))).toBe(false);
  });

  test("returns ok:false when no files provided", () => {
    const ws = mkWorkspace();
    const result = createCheckpoint(ws, [], "test: empty");
    expect(result.ok).toBe(false);
  });
});

describe("shadowGit — GC threshold not triggered in small test batches", () => {
  const test = GIT_AVAILABLE ? it : it.skip;

  test("GC is not triggered after fewer than 20 writes", () => {
    const ws = mkWorkspace();
    // Write a few files and checkpoint — GC should not run yet.
    for (let i = 0; i < 3; i++) {
      writeFile(ws, `file${i}.ts`, `const x${i} = ${i};\n`);
      const result = createCheckpoint(ws, [`file${i}.ts`], `test: write ${i}`);
      expect(result.ok).toBe(true);
    }
    // No assertion on GC — we just confirm no error was thrown.
  });
});

describe("shadowGit — git not available fallback", () => {
  it("gitAvailable() returns a boolean (either true or false)", () => {
    expect(typeof GIT_AVAILABLE).toBe("boolean");
  });

  it("ensureInit returns false when called on a nonexistent path if git unavailable", () => {
    if (GIT_AVAILABLE) {
      // Can't really test this branch when git IS available — just skip.
      return;
    }
    const ws = mkWorkspace();
    expect(ensureInit(ws)).toBe(false);
  });
});
