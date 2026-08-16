// resolveWorkspace.spec.ts — unit tests for per-call workspace-root resolution.
//
// These cover the pure decision logic only (acceptance rules + fallback). The
// end-to-end behaviour (server spawned in a worktree, per-call `cwd` override
// landing in the right tree) is covered by workspaceRoot.spec.ts.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isWorkspaceOverrideAccepted,
  resolveWorkspaceRoot,
  realpathWorkspaceRoot,
} from "../write/resolveWorkspace.js";

// Acceptance is rooted in the pinned repository. Other worktrees require either
// an exact repository-owned git worktree record or an explicit parent; the temp
// parent itself is never an accepted workspace.
const homeDirs: string[] = [];
const outsideDirs: string[] = [];

function mkHomeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".tl-rw-home-"));
  homeDirs.push(dir);
  return dir;
}

function mkOutsideDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-rw-out-"));
  outsideDirs.push(dir);
  return dir;
}

function registerWorktree(pinnedRoot: string, worktree: string, id = "cell-1"): void {
  const marker = path.join(worktree, ".git");
  fs.mkdirSync(marker, { recursive: true });
  const admin = path.join(pinnedRoot, ".git", "worktrees", id);
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, "gitdir"), marker + "\n");
}

function makeSealedBenchCell(
  pinnedRoot: string,
  overrides: { sealed?: string; sourceRoot?: string; baseHead?: string; cellPrefix?: string } = {},
): string {
  const parent = path.join(os.tmpdir(), "tl-bench-worktrees");
  fs.mkdirSync(parent, { recursive: true });
  const iter = "n10-v07-natural-onboarded-resolve-test";
  const cell = fs.mkdtempSync(path.join(
    parent,
    overrides.cellPrefix ?? `${iter}-T07-ledgerd-balance-credit-normal-rep0-a-`,
  ));
  outsideDirs.push(cell);
  fs.mkdirSync(path.join(cell, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cell, ".git", "config"), [
    '[tl "bench"]',
    `\tsealed = ${overrides.sealed ?? "1"}`,
    `\titer = ${iter}`,
    `\tsource-root = ${overrides.sourceRoot ?? pinnedRoot}`,
    `\tbase-head = ${overrides.baseHead ?? "a".repeat(40)}`,
    "",
  ].join("\n"));
  return cell;
}

afterEach(() => {
  for (const d of homeDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  for (const d of outsideDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("isWorkspaceOverrideAccepted", () => {
  it("rejects an unregistered directory inside $HOME", () => {
    const dir = mkHomeDir();
    expect(isWorkspaceOverrideAccepted(dir)).toBe(false);
  });

  it("rejects undefined / empty", () => {
    expect(isWorkspaceOverrideAccepted(undefined)).toBe(false);
    expect(isWorkspaceOverrideAccepted("")).toBe(false);
  });

  it("rejects a relative path", () => {
    expect(isWorkspaceOverrideAccepted("some/relative/dir")).toBe(false);
  });

  it("rejects a non-existent path", () => {
    const dir = mkHomeDir();
    expect(isWorkspaceOverrideAccepted(path.join(dir, "does-not-exist"))).toBe(false);
  });

  it("rejects a file (not a directory)", () => {
    const dir = mkHomeDir();
    const file = path.join(dir, "a-file.txt");
    fs.writeFileSync(file, "x");
    expect(isWorkspaceOverrideAccepted(file)).toBe(false);
  });

  it("rejects a directory outside $HOME (e.g. /var temp, /etc)", () => {
    const outside = mkOutsideDir();
    expect(isWorkspaceOverrideAccepted(outside)).toBe(false);
    expect(isWorkspaceOverrideAccepted("/etc")).toBe(false);
  });

  it("accepts only descendants of a direct child under an explicit allowed parent", () => {
    const parent = mkOutsideDir();
    const child = path.join(parent, "worktree-1");
    const nested = path.join(child, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    expect(isWorkspaceOverrideAccepted(parent, [parent])).toBe(false);
    expect(isWorkspaceOverrideAccepted(child, [parent])).toBe(true);
    expect(isWorkspaceOverrideAccepted(nested, [parent])).toBe(true);
    expect(isWorkspaceOverrideAccepted(mkOutsideDir(), [parent])).toBe(false);
  });

  it("accepts only the exact outside-HOME worktree registered by the pinned repository", () => {
    const pinned = mkHomeDir();
    const parent = mkOutsideDir();
    const worktree = path.join(parent, "signal5-cell");
    const nested = path.join(worktree, "packages", "app");
    const sibling = path.join(parent, "unregistered-cell");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(sibling);
    registerWorktree(pinned, worktree, "signal5-cell");

    expect(isWorkspaceOverrideAccepted(parent, [], pinned)).toBe(false);
    expect(isWorkspaceOverrideAccepted(worktree, [], pinned)).toBe(true);
    expect(isWorkspaceOverrideAccepted(nested, [], pinned)).toBe(true);
    expect(isWorkspaceOverrideAccepted(sibling, [], pinned)).toBe(false);

    fs.rmSync(path.join(worktree, ".git"), { recursive: true, force: true });
    expect(isWorkspaceOverrideAccepted(worktree, [], pinned)).toBe(false);
  });

  it("accepts a setup-certified standalone bench cell and its descendants", () => {
    const pinned = mkHomeDir();
    const cell = makeSealedBenchCell(pinned);
    const nested = path.join(cell, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });

    expect(isWorkspaceOverrideAccepted(cell, [], pinned)).toBe(true);
    expect(isWorkspaceOverrideAccepted(nested, [], pinned)).toBe(true);
  });

  it("rejects lookalike standalone cells without the complete source-bound certificate", () => {
    const pinned = mkHomeDir();
    const wrongSource = mkHomeDir();
    const unsealed = makeSealedBenchCell(pinned, { sealed: "0" });
    const foreign = makeSealedBenchCell(pinned, { sourceRoot: wrongSource });
    const incomplete = makeSealedBenchCell(pinned, { baseHead: "not-a-commit" });
    const wrongName = makeSealedBenchCell(pinned, { cellPrefix: "unowned-cell-" });

    expect(isWorkspaceOverrideAccepted(unsealed, [], pinned)).toBe(false);
    expect(isWorkspaceOverrideAccepted(foreign, [], pinned)).toBe(false);
    expect(isWorkspaceOverrideAccepted(incomplete, [], pinned)).toBe(false);
    expect(isWorkspaceOverrideAccepted(wrongName, [], pinned)).toBe(false);
  });

  it("rejects a child symlink whose real target escapes the allowed parent", () => {
    const parent = mkOutsideDir();
    const target = mkOutsideDir();
    const link = path.join(parent, "worktree-link");
    try {
      fs.symlinkSync(target, link, "dir");
      expect(isWorkspaceOverrideAccepted(link, [parent])).toBe(false);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EPERM" || e.code === "ENOTSUP") return;
      throw err;
    }
  });
});

describe("resolveWorkspaceRoot", () => {
  it("returns the realpath of a pinned-root descendant", () => {
    const pinned = mkHomeDir();
    const dir = path.join(pinned, "packages", "app");
    fs.mkdirSync(dir, { recursive: true });
    // resolveWorkspaceRoot now applies realpathSync so symlinked overrides
    // resolve to their canonical target — store and compare against that.
    const expected = fs.realpathSync(dir);
    expect(resolveWorkspaceRoot(dir, pinned)).toBe(expected);
  });

  it("falls back to the pinned root when no override is given", () => {
    expect(resolveWorkspaceRoot(undefined, "/fallback/root")).toBe("/fallback/root");
  });

  it("falls back to the pinned root when the override is unusable", () => {
    const outside = mkOutsideDir();
    expect(resolveWorkspaceRoot(outside, "/fallback/root")).toBe("/fallback/root");
    expect(resolveWorkspaceRoot("relative/dir", "/fallback/root")).toBe("/fallback/root");
  });

  it("returns an outside-HOME worktree when its parent is explicitly allowed", () => {
    const parent = mkOutsideDir();
    const child = path.join(parent, "worktree-1");
    fs.mkdirSync(child);
    expect(resolveWorkspaceRoot(child, "/fallback/root", [parent])).toBe(fs.realpathSync(child));
  });

  it("returns an outside-HOME worktree registered by the pinned repository without a parent grant", () => {
    const pinned = mkHomeDir();
    const parent = mkOutsideDir();
    const worktree = path.join(parent, "signal5-cell");
    fs.mkdirSync(worktree);
    registerWorktree(pinned, worktree, "signal5-cell");

    expect(resolveWorkspaceRoot(worktree, pinned)).toBe(fs.realpathSync(worktree));
  });

  it("resolves a symlinked registered worktree override to the real target path", () => {
    const pinned = mkHomeDir();
    const realDir = mkHomeDir();
    registerWorktree(pinned, realDir);
    const linkDir = path.join(os.homedir(), `.tl-rw-symlink-${Date.now()}`);
    try {
      fs.symlinkSync(realDir, linkDir);
      homeDirs.push(linkDir); // cleanup after test
      const result = resolveWorkspaceRoot(linkDir, pinned);
      // Must resolve to the canonical target, not the symlink path.
      expect(result).toBe(fs.realpathSync(realDir));
      expect(result).not.toBe(linkDir);
    } catch (err: unknown) {
      // Some environments don't support symlink creation; skip gracefully.
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EPERM" || e.code === "ENOTSUP") return;
      throw err;
    }
  });
});

describe("realpathWorkspaceRoot", () => {
  it("returns the realpath of an existing directory", () => {
    const dir = mkHomeDir();
    expect(realpathWorkspaceRoot(dir)).toBe(fs.realpathSync(dir));
  });

  it("falls back to the input path when the path does not exist", () => {
    const missing = path.join(os.homedir(), ".tl-rw-missing-does-not-exist-12345");
    expect(realpathWorkspaceRoot(missing)).toBe(missing);
  });
});
