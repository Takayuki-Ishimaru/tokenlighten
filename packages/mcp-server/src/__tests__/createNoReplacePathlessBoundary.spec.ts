// createNoReplacePathlessBoundary.spec.ts — 2026-08-13 write-path hardening
// regressions. Both hardenings are §6.6 carve-outs from
// TL-V0.9-RELEASE-STRATEGY-2026-08-12.md:
//
//   1. create_file (tools/createFile.ts) existence check now uses lstat, not
//      stat, so a DANGLING symlink at the target — whose statSync-based
//      ENOENT was indistinguishable from "nothing there" — is refused like
//      any other pre-existing entry (CWE-59). Publish is now no-replace
//      (fs.linkSync, with a documented O_EXCL fallback) instead of
//      rename-always-replaces (CWE-367): a file that races into existence
//      between the check and the publish is refused, never clobbered.
//
//   2. pathless edit_code (write/pathlessEdit.ts) now runs the same
//      nestedWorkspaceCrossing post-selection check tools/renameSymbol.ts
//      uses for its own DISCOVERED targets, against the single candidate a
//      pathless edit resolves to, before delegating to searchReplaceEdit
//      (CWE-863): a unique match that resolves inside a nested linked
//      worktree is refused with the established workspace-boundary shape
//      instead of silently writing into a different workspace on its own
//      branch (the 2026-08-09 incident class) — the dispatch-level guard
//      (server.ts's workspaceRoutingRefusal) cannot see this because a
//      pathless call names no path.
//
// The nested-worktree fixtures mirror workspaceBoundary.spec.ts's recipe
// (real `git worktree add`, HOME-rooted tmpdir, a nested location OUTSIDE
// `.claude/` since that one is already excluded by DEFAULT_IGNORE) — read
// that file for why each fixture step is shaped the way it is.

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

import { createFile } from "../tools/createFile.js";
import { pathlessExactEdit, pathlessSymbolEdit } from "../write/pathlessEdit.js";
import { resetNestedWorkspaceCache } from "../write/workspaceBoundary.js";
import { resetTokenlightenIgnoreCache } from "../tools/walkRepo.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

const SESSION = "test-session";
const tmpDirs: string[] = [];

afterEach(() => {
  resetTokenlightenIgnoreCache();
  resetNestedWorkspaceCache();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Shared helpers — plain (non-git) workspaces, createFile.spec.ts's own recipe
// ---------------------------------------------------------------------------

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-cnrpb-test-"));
  tmpDirs.push(dir);
  return unsafeGuardedWorkspaceRootForTests(dir);
}

// ---------------------------------------------------------------------------
// Shared helpers — real git repos + nested linked worktrees
// (workspaceBoundary.spec.ts's recipe, verbatim)
// ---------------------------------------------------------------------------

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

function mkGitRepo(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-cnrpb-${label}-`)));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), label, "utf8");
  execFileSync("git", ["-C", dir, "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@test.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", dir, "commit", "-m", "init"], { stdio: "pipe" });
  return dir;
}

/**
 * A nested linked worktree at `relPath`, which must be a location the shared
 * walk-ignore rules do NOT already exclude (`.claude/` is — see
 * workspaceBoundary.spec.ts's renameSymbol fixture for why that specific
 * location is not the interesting case).
 */
function addNestedWorktreeAt(repo: string, relPath: string, branch: string): string {
  const target = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, target], { stdio: "pipe" });
  return fs.realpathSync(target);
}

// ---------------------------------------------------------------------------
// Item 1: createFile — no-replace hardening (CWE-59 / CWE-367)
// ---------------------------------------------------------------------------

describe("createFile — no-replace hardening (CWE-59/CWE-367)", () => {
  it("(a) refuses creation onto a DANGLING symlink; the link itself is left untouched", async () => {
    const ws = mkWorkspace();
    const missingTarget = path.join(ws, "does-not-exist.ts");
    const linkPath = path.join(ws, "dangling.ts");
    fs.symlinkSync(missingTarget, linkPath);

    const result = await createFile({ path: "dangling.ts", content: "evil\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("file_exists");
    // The link itself must still be exactly the same dangling symlink —
    // neither replaced with a regular file nor written through to wherever
    // it points.
    const st = fs.lstatSync(linkPath);
    expect(st.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkPath)).toBe(missingTarget);
    expect(fs.existsSync(missingTarget)).toBe(false);
  });

  it("(b) refuses creation onto a symlink pointing at an EXISTING file; the target is untouched", async () => {
    const ws = mkWorkspace();
    const outside = mkWorkspace();
    const victim = path.join(outside, "victim.ts");
    fs.writeFileSync(victim, "original\n", "utf8");
    fs.symlinkSync(victim, path.join(ws, "link.ts"));

    const result = await createFile({ path: "link.ts", content: "evil\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("file_exists");
    expect(fs.readFileSync(victim, "utf8")).toBe("original\n");
  });

  // Node's built-in `fs` ESM binding is non-configurable in this runtime
  // (vi.spyOn(fs, "linkSync") throws "Cannot redefine property" — see
  // locateTaskContext.spec.ts's identical note for readFileSync), so this
  // test uses vi.doMock("fs", ...) at module-registry level instead, plus a
  // fresh dynamic import of createFile.ts so it picks up the mocked module
  // instance. Only this test (and the fallback one below) needs that; every
  // other test in this file uses the plain top-level import undisturbed.
  it("(c) a file racing into existence between tmp-write and publish is refused, not clobbered", async () => {
    vi.resetModules();
    const racerContent = "RACER WON\n";
    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        linkSync: (src: string, dest: string) => {
          // A concurrent writer lands a file at the destination AFTER the
          // tmp file is written but BEFORE this call's own publish step —
          // exactly the window the old rename-based publish clobbered.
          actual.writeFileSync(dest, racerContent, "utf8");
          return actual.linkSync(src, dest);
        },
      };
    });

    try {
      const { createFile: createFileWithMockedFs } = await import("../tools/createFile.js");
      const ws = mkWorkspace();

      const result = await createFileWithMockedFs(
        { path: "race.ts", content: "loser content\n" },
        ws,
        true,
        SESSION,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("file_exists");
      // No-replace held: the racer's content survives untouched.
      expect(fs.readFileSync(path.join(ws, "race.ts"), "utf8")).toBe(racerContent);
    } finally {
      vi.doUnmock("fs");
      vi.resetModules();
    }
  });

  it("(d) an ordinary create still succeeds, response shape byte-identical to today (control)", async () => {
    const ws = mkWorkspace();
    const content = "export const control = true;\n";

    const result = await createFile({ path: "control.ts", content }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result).sort()).toEqual(["bytes", "ok", "path"]);
    expect(result.path).toBe("control.ts");
    expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(fs.readFileSync(path.join(ws, "control.ts"), "utf8")).toBe(content);
  });

  it("(bonus) reports bytes for multi-byte content too, unaffected by the publish-mechanism change", async () => {
    const ws = mkWorkspace();
    const content = "const emoji = '🎉';\n";

    const result = await createFile({ path: "emoji.ts", content }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(fs.readFileSync(path.join(ws, "emoji.ts"), "utf8")).toBe(content);
  });

  it("(bonus) falls back to a direct no-replace write, byte-identical success, when link() is unavailable", async () => {
    vi.resetModules();
    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        linkSync: () => {
          const err = new Error("simulated: link not supported on this filesystem") as NodeJS.ErrnoException;
          err.code = "ENOSYS";
          throw err;
        },
      };
    });

    try {
      const { createFile: createFileWithMockedFs } = await import("../tools/createFile.js");
      const ws = mkWorkspace();
      const content = "export const viaFallback = true;\n";

      const result = await createFileWithMockedFs({ path: "fallback.ts", content }, ws, true, SESSION);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result).sort()).toEqual(["bytes", "ok", "path"]);
      expect(result.path).toBe("fallback.ts");
      expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
      expect(fs.readFileSync(path.join(ws, "fallback.ts"), "utf8")).toBe(content);
    } finally {
      vi.doUnmock("fs");
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// Item 2: pathless edit_code — workspace-boundary post-check (CWE-863)
// ---------------------------------------------------------------------------

describe("pathlessExactEdit / pathlessSymbolEdit — workspace-boundary post-check (CWE-863)", () => {
  it("(e) a pathless EXACT edit whose unique match resolves inside a nested linked worktree is refused, not written", async () => {
    const repo = mkGitRepo("pxb-exact");
    const agent = addNestedWorktreeAt(repo, "wt/agent-exact", "tl-pxb-exact");
    resetNestedWorkspaceCache();

    // The marker exists ONLY inside the nested worktree's own working
    // copy — never in the outer repo — so the workspace-wide scan finds
    // exactly one occurrence. (If it existed in both trees, the pre-existing
    // ambiguity gate would fire first and this check would never run.)
    const markerFile = path.join(agent, "src", "nested.ts");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, 'export const x = "PXB_EXACT_MARKER";\n', "utf8");

    const result = await pathlessExactEdit(unsafeGuardedWorkspaceRootForTests(repo), true, SESSION, {
      search: '"PXB_EXACT_MARKER"',
      replace: '"REWRITTEN"',
    });

    expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-input");
    expect(result.reason).toBe("workspace-boundary");
    expect(result.nested_workspace).toBe(agent);
    expect(result.workspace).toBe(repo);
    expect(result.paths).toEqual(["wt/agent-exact/src/nested.ts"]);
    expect(String(result.next)).toContain(agent);

    // No write happened.
    expect(fs.readFileSync(markerFile, "utf8")).toBe('export const x = "PXB_EXACT_MARKER";\n');
  }, 30000);

  it("(f) the same pathless EXACT edit succeeds unchanged when there is no nested worktree (control)", async () => {
    const repo = mkGitRepo("pxb-exact-control");
    // Same non-ignored, worktree-shaped path, but with NO `git worktree add`
    // — proves the gate is keyed on an actually-registered live worktree,
    // not merely on directory naming/shape.
    const markerFile = path.join(repo, "wt", "agent-exact", "src", "nested.ts");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, 'export const x = "PXB_EXACT_CONTROL_MARKER";\n', "utf8");

    const result = await pathlessExactEdit(unsafeGuardedWorkspaceRootForTests(repo), true, SESSION, {
      search: '"PXB_EXACT_CONTROL_MARKER"',
      replace: '"REWRITTEN"',
    });

    expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
    if (!result.ok) return;
    // Byte-identical to the pre-existing (no-crossing) success shape: no
    // stray workspace-boundary field leaks onto an ordinary success.
    expect(Object.keys(result).sort()).toEqual(["delta", "lines", "ok", "path"]);
    expect(result.path).toBe("wt/agent-exact/src/nested.ts");
    expect(fs.readFileSync(markerFile, "utf8")).toContain("REWRITTEN");
  });

  it("a pathless SYMBOL edit whose unique match resolves inside a nested linked worktree is refused, not written", async () => {
    const repo = mkGitRepo("pxb-symbol");
    const agent = addNestedWorktreeAt(repo, "wt/agent-symbol", "tl-pxb-symbol");
    resetNestedWorkspaceCache();

    const markerFile = path.join(agent, "src", "nestedFn.ts");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(
      markerFile,
      [
        `export function pxbNestedFn(): string {`,
        `  return "PXB_SYMBOL_MARKER";`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const result = await pathlessSymbolEdit(unsafeGuardedWorkspaceRootForTests(repo), true, SESSION, {
      symbol: "pxbNestedFn",
      search: '"PXB_SYMBOL_MARKER"',
      replace: '"REWRITTEN"',
    });

    expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-input");
    expect(result.reason).toBe("workspace-boundary");
    expect(result.nested_workspace).toBe(agent);
    expect(result.workspace).toBe(repo);
    expect(result.paths).toEqual(["wt/agent-symbol/src/nestedFn.ts"]);

    expect(fs.readFileSync(markerFile, "utf8")).toContain("PXB_SYMBOL_MARKER");
    expect(fs.readFileSync(markerFile, "utf8")).not.toContain("REWRITTEN");
  }, 30000);

  it("the same pathless SYMBOL edit succeeds unchanged when there is no nested worktree (control)", async () => {
    const repo = mkGitRepo("pxb-symbol-control");
    const markerFile = path.join(repo, "wt", "agent-symbol", "src", "nestedFn.ts");
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(
      markerFile,
      [
        `export function pxbNestedFnControl(): string {`,
        `  return "PXB_SYMBOL_CONTROL_MARKER";`,
        `}`,
        ``,
      ].join("\n"),
      "utf8",
    );

    const result = await pathlessSymbolEdit(unsafeGuardedWorkspaceRootForTests(repo), true, SESSION, {
      symbol: "pxbNestedFnControl",
      search: '"PXB_SYMBOL_CONTROL_MARKER"',
      replace: '"REWRITTEN"',
    });

    expect(result.ok, JSON.stringify(result).slice(0, 400)).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result).sort()).toEqual(["delta", "lines", "ok", "path"]);
    expect(result.path).toBe("wt/agent-symbol/src/nestedFn.ts");
    expect(fs.readFileSync(markerFile, "utf8")).toContain("REWRITTEN");
  });
});
