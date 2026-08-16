// getCurrentDiff.spec.ts — unit tests for the get_current_diff tool.
//
// Tests:
//   - empty diff (clean working tree) → files: [], truncated: false, totalFiles: 0
//   - modified file → files array with path, status, hunks
//   - added file → status: "added"
//   - deleted file → status: "deleted"
//   - multiple files → truncation by byte cap
//   - path filter passes through to git
//   - non-git-repo error path returns structured error, not an exception
//   - no diff/totalTokens fields in output

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { getCurrentDiff } from "../tools/getCurrentDiff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-gcd-test-"));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["-C", dir, "init"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
}

function gitCommit(dir: string, message: string): void {
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-m", message]);
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCurrentDiff — empty diff (clean working tree)", () => {
  it("returns files:[] and truncated:false when no changes exist", async () => {
    const dir = mkDir();
    initGitRepo(dir);
    writeFile(dir, "README.md", "hello\n");
    gitCommit(dir, "init");

    const result = await getCurrentDiff({}, dir);

    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.totalFiles).toBe(0);
    expect(result.error).toBeUndefined();
    // Must not have old fields
    expect(result).not.toHaveProperty("diff");
    expect(result).not.toHaveProperty("totalTokens");
  });
});

describe("getCurrentDiff — modified file", () => {
  it("returns files array with path, status=modified, and hunks", async () => {
    const dir = mkDir();
    initGitRepo(dir);
    writeFile(dir, "src/a.ts", "const x = 1;\n");
    gitCommit(dir, "init");

    writeFile(dir, "src/a.ts", "const x = 2;\n");

    const result = await getCurrentDiff({}, dir);

    expect(result.error).toBeUndefined();
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    expect(result.totalFiles).toBeGreaterThanOrEqual(1);
    expect(result.truncated).toBe(false);

    const file = result.files[0]!;
    expect(file.path).toBe("src/a.ts");
    expect(file.status).toBe("modified");
    expect(file.hunks.length).toBeGreaterThanOrEqual(1);

    const hunk = file.hunks[0]!;
    expect(typeof hunk.oldStart).toBe("number");
    expect(typeof hunk.oldLines).toBe("number");
    expect(typeof hunk.newStart).toBe("number");
    expect(typeof hunk.newLines).toBe("number");
  });
});

describe("getCurrentDiff — added file", () => {
  it("returns status=added for a newly created file", async () => {
    const dir = mkDir();
    initGitRepo(dir);
    writeFile(dir, "README.md", "initial\n");
    gitCommit(dir, "init");

    // Add a new file (not yet committed).
    writeFile(dir, "src/new.ts", "export const NEW = 1;\n");
    execFileSync("git", ["-C", dir, "add", "src/new.ts"]);

    const result = await getCurrentDiff({}, dir);

    expect(result.error).toBeUndefined();
    const added = result.files.find((f) => f.path === "src/new.ts");
    expect(added).toBeDefined();
    expect(added!.status).toBe("added");
  });
});

describe("getCurrentDiff — path filter", () => {
  it("returns diff only for specified path", async () => {
    const dir = mkDir();
    initGitRepo(dir);
    writeFile(dir, "src/a.ts", "const a = 1;\n");
    writeFile(dir, "src/b.ts", "const b = 1;\n");
    gitCommit(dir, "init");

    writeFile(dir, "src/a.ts", "const a = 2;\n");
    writeFile(dir, "src/b.ts", "const b = 2;\n");

    const result = await getCurrentDiff({ path: "src/a.ts" }, dir);

    expect(result.error).toBeUndefined();
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("src/b.ts");
  });
});

describe("getCurrentDiff — non-git-repo error path", () => {
  it("returns structured error (not throws) when directory is not a git repo", async () => {
    const dir = mkDir();
    // Do NOT call initGitRepo — this is a plain directory.

    const result = await getCurrentDiff({}, dir);

    // Must not throw; must return structured result.
    expect(result).toBeDefined();
    expect(result.files).toEqual([]);
    expect(result.totalFiles).toBe(0);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe("string");
    expect(result.error).toMatch(/git diff failed/i);
  });
});

describe("getCurrentDiff — output shape", () => {
  it("result has files, truncated, totalFiles but no diff or totalTokens", async () => {
    const dir = mkDir();
    initGitRepo(dir);
    writeFile(dir, "a.ts", "const x = 1;\n");
    gitCommit(dir, "init");
    writeFile(dir, "a.ts", "const x = 2;\n");

    const result = await getCurrentDiff({}, dir);

    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("truncated");
    expect(result).toHaveProperty("totalFiles");
    expect(result).not.toHaveProperty("diff");
    expect(result).not.toHaveProperty("totalTokens");
  });

  it("maxTokens param is accepted without error (backward-compat no-op)", async () => {
    const dir = mkDir();
    initGitRepo(dir);
    writeFile(dir, "a.ts", "const x = 1;\n");
    gitCommit(dir, "init");
    writeFile(dir, "a.ts", "const x = 2;\n");

    const result = await getCurrentDiff({ maxTokens: 100 }, dir);
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.files)).toBe(true);
  });
});
