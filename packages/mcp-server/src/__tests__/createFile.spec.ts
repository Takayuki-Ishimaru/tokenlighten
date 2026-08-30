// createFile.spec.ts — unit tests for the create_file tool.
//
// Tests:
//   - success: file created with correct content
//   - file_exists: rejects when file already exists
//   - path_escapes_root: rejects ".." traversal
//   - write_disabled: returns write_disabled when allowWrite=false
//   - mkdir-p: parent directories are created automatically

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createFile } from "../tools/createFile.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-cf-test-"));
  tmpDirs.push(dir);
  return unsafeGuardedWorkspaceRootForTests(dir);
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(workspace: string, rel: string): string {
  return fs.readFileSync(path.join(workspace, rel), "utf8");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

const SESSION = "test-session";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createFile — success", () => {
  it("creates a new file with the given content", async () => {
    const ws = mkWorkspace();
    const content = "export const x = 42;\n";

    const result = await createFile({ path: "src/x.ts", content }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe("src/x.ts");
    expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(readFile(ws, "src/x.ts")).toBe(content);
  });

  it("reports bytes correctly for multi-byte content", async () => {
    const ws = mkWorkspace();
    const content = "const emoji = '🎉';\n"; // multi-byte

    const result = await createFile({ path: "emoji.ts", content }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
    expect(readFile(ws, "emoji.ts")).toBe(content);
  });
});

describe("createFile — file_exists", () => {
  it("returns file_exists when the file already exists", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "existing.ts", "already here\n");

    const result = await createFile({ path: "existing.ts", content: "new content\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("file_exists");
    // Original file must be untouched.
    expect(readFile(ws, "existing.ts")).toBe("already here\n");
  });

  it("returns file_exists when the path is a directory", async () => {
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, "adir"), { recursive: true });

    const result = await createFile({ path: "adir", content: "content\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("file_exists");
  });
});

describe("createFile — path_escapes_root", () => {
  it("rejects paths with .. traversal", async () => {
    const ws = mkWorkspace();

    const result = await createFile({ path: "../escape.ts", content: "evil\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("path_escapes_root");
  });

  it("rejects deep .. traversal", async () => {
    const ws = mkWorkspace();

    const result = await createFile({ path: "a/../../secret.ts", content: "evil\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("path_escapes_root");
  });

  it("rejects an absolute path outside the workspace", async () => {
    const ws = mkWorkspace();
    const outside = mkWorkspace();
    const target = path.join(outside, "absolute_escape.ts");

    const result = await createFile({ path: target, content: "evil\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("path_escapes_root");
    expect(fs.existsSync(target)).toBe(false);
  });

  // 2026-08-07 (L1): the execution fence no longer makes an un-served create
  // target spend a re-pack, so createFile's own confinement is the ONLY thing
  // standing between a create and the filesystem. These pin the realpath walk
  // (createFile.ts's "verify the parent directory doesn't resolve outside
  // workspace" loop), which had no coverage at all before this wave — the
  // lexical prefix check above cannot see through a symlink.
  it("rejects a create through a symlinked directory that escapes the workspace", async () => {
    const ws = mkWorkspace();
    const outside = mkWorkspace();
    fs.mkdirSync(path.join(outside, "loot"), { recursive: true });
    fs.symlinkSync(path.join(outside, "loot"), path.join(ws, "escape"));

    const result = await createFile({ path: "escape/pwned.ts", content: "evil\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("path_escapes_root");
    expect(fs.existsSync(path.join(outside, "loot/pwned.ts"))).toBe(false);
  });

  it("rejects a create whose nearest EXISTING ancestor is an escaping symlink", async () => {
    // The walk climbs to the first ancestor that exists; a deep not-yet-created
    // sub-path under an escaping link must be caught at that ancestor rather
    // than mkdir-p'd into the foreign tree.
    const ws = mkWorkspace();
    const outside = mkWorkspace();
    fs.mkdirSync(path.join(outside, "loot"), { recursive: true });
    fs.symlinkSync(path.join(outside, "loot"), path.join(ws, "escape"));

    const result = await createFile({ path: "escape/deep/nested/pwned.ts", content: "evil\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("path_escapes_root");
    expect(fs.existsSync(path.join(outside, "loot/deep"))).toBe(false);
  });

  it("refuses to write THROUGH an existing symlink at the target path", async () => {
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

  it("still allows a symlinked directory that stays INSIDE the workspace", async () => {
    // The check is containment, not a blanket symlink ban: a link that resolves
    // back inside the workspace is ordinary workspace content.
    const ws = mkWorkspace();
    fs.mkdirSync(path.join(ws, "real"), { recursive: true });
    fs.symlinkSync(path.join(ws, "real"), path.join(ws, "alias"));

    const result = await createFile({ path: "alias/inside.ts", content: "ok\n" }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "real/inside.ts"), "utf8")).toBe("ok\n");
  });

  it("tolerates a workspace root that is itself reached through a symlink", async () => {
    // macOS hands out /var/folders/... paths whose realpath is /private/var/...
    // Comparing the un-realpath'd root against a realpath'd ancestor would
    // refuse every legitimate create in such a tree.
    const ws = mkWorkspace();
    const linkRoot = path.join(mkWorkspace(), "root-link");
    fs.symlinkSync(ws, linkRoot);

    const result = await createFile(
      { path: "pkg/mod.ts", content: "ok\n" },
      unsafeGuardedWorkspaceRootForTests(linkRoot),
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "pkg/mod.ts"), "utf8")).toBe("ok\n");
  });
});

describe("createFile — write_disabled", () => {
  it("returns write_disabled when allowWrite=false", async () => {
    const ws = mkWorkspace();

    const result = await createFile({ path: "new.ts", content: "content\n" }, ws, false, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("write_disabled");
    // File must NOT have been created.
    expect(fs.existsSync(path.join(ws, "new.ts"))).toBe(false);
  });

  it("gates on allowWrite BEFORE any path resolution or mkdir", async () => {
    // The write gate is the outermost check: no directory may appear, and no
    // escape may even be evaluated, when writes are disabled.
    const ws = mkWorkspace();

    const result = await createFile({ path: "a/b/c/new.ts", content: "content\n" }, ws, false, SESSION);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("write_disabled");
    expect(fs.existsSync(path.join(ws, "a"))).toBe(false);
  });

  // W3-4(c): the write-gate refusal must carry the SAME recognized A.7.1
  // code the five sibling write entry points already use
  // (`write-not-enabled`), so `refusalCodeOf` (protocol/refusal.ts) resolves
  // it correctly instead of falling through to `invalid-input` — see
  // createFile.ts's write-gate comment for the confirmed-live collision this
  // closes.
  it("carries the recognized write-not-enabled code alongside error", async () => {
    const ws = mkWorkspace();
    const result = await createFile({ path: "new.ts", content: "content\n" }, ws, false, SESSION);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("write-not-enabled");
  });
});

describe("createFile — mkdir-p", () => {
  it("creates nested parent directories automatically", async () => {
    const ws = mkWorkspace();
    const content = "const deep = true;\n";

    const result = await createFile(
      { path: "a/b/c/deep.ts", content },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFile(ws, "a/b/c/deep.ts")).toBe(content);
    // Parent dirs must exist.
    expect(fs.statSync(path.join(ws, "a/b/c")).isDirectory()).toBe(true);
  });
});
