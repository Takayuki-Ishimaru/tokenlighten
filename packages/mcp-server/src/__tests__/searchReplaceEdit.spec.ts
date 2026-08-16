// searchReplaceEdit.spec.ts — unit tests for the search_replace_edit tool.
//
// Uses mkdtemp for all fixtures. Never writes to the repo root.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { searchReplaceEdit } from "../tools/searchReplaceEdit.js";
import { toolOk } from "../server.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-sre-test-"));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchReplaceEdit — single occurrence", () => {
  it("replaces the only occurrence", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "hello.ts", `export function greet() {\n  return "hello";\n}\n`);

    const result = await searchReplaceEdit(
      { path: "hello.ts", search: '"hello"', replace: '"world"' },
      ws,
      true
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "hello.ts")).toContain('"world"');
    expect(readFile(ws, "hello.ts")).not.toContain('"hello"');
  });
});

describe("searchReplaceEdit — ambiguous (>1 occurrence)", () => {
  it("returns error code 'ambiguous' when search matches multiple locations", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "dup.ts", `const a = "foo";\nconst b = "foo";\n`);

    const result = await searchReplaceEdit(
      { path: "dup.ts", search: '"foo"', replace: '"bar"' },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("ambiguous");
    }
    // File must NOT have been modified.
    expect(readFile(ws, "dup.ts")).toBe(`const a = "foo";\nconst b = "foo";\n`);
  });
});

describe("searchReplaceEdit — not-found", () => {
  it("returns error code 'not-found' when search string is absent", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src.ts", `const x = 1;\n`);

    const result = await searchReplaceEdit(
      { path: "src.ts", search: "THIS_DOES_NOT_EXIST", replace: "y" },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-found");
    }
  });
});

describe("searchReplaceEdit — allow_create", () => {
  it("creates a new file when allow_create:true and file absent", async () => {
    const ws = mkWorkspace();

    const result = await searchReplaceEdit(
      { path: "new-file.ts", search: "", replace: "export const x = 1;\n", allow_create: true },
      ws,
      true
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "new-file.ts")).toBe("export const x = 1;\n");
  });

  it("creates parent directories when allow_create:true", async () => {
    const ws = mkWorkspace();

    const result = await searchReplaceEdit(
      { path: "deep/nested/file.ts", search: "", replace: "hello", allow_create: true },
      ws,
      true
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "deep/nested/file.ts")).toBe("hello");
  });

  it("returns error when allow_create:true but search is not empty", async () => {
    const ws = mkWorkspace();

    const result = await searchReplaceEdit(
      { path: "nonexistent.ts", search: "something", replace: "other", allow_create: true },
      ws,
      true
    );

    // File doesn't exist + allow_create + non-empty search = error
    expect(result.ok).toBe(false);
    // FIX 2c: the hint must reference edit_file's ADVERTISED param name
    // (create:true), never the unadvertised engine-internal allow_create.
    if (!result.ok) {
      expect(result.error).toContain("create:true");
      expect(result.error).not.toContain("allow_create");
    }
  });

  it("returns not-found when file absent and allow_create not set", async () => {
    const ws = mkWorkspace();

    const result = await searchReplaceEdit(
      { path: "missing.ts", search: "x", replace: "y" },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-found");
      // FIX 2c: same rename as above — this is the exact hint a bench agent
      // hit via edit_file {path:<new file>, search:"", replace} and could
      // not act on, because allow_create is not in edit_file's schema.
      expect(result.error).toContain("create:true");
      expect(result.error).not.toContain("allow_create");
    }
  });

  // FIX 2f: empty search on an EXISTING file must still refuse — this is a
  // DIFFERENT gate (textEdit.ts's applySingleEdit "empty-search" code) from
  // the ENOENT/not-found path above, only reachable when the file already
  // exists. Confirms create:true/allow_create:true do not bypass it, and
  // that its hint text was also renamed (see textEdit.spec.ts's own module
  // if present; covered here since it is exercised through this engine).
  it("still refuses an empty search on an EXISTING file, with create:true wording (not allow_create)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "existing.ts", "export const existing = 1;\n");

    const result = await searchReplaceEdit(
      { path: "existing.ts", search: "", replace: "export const existing = 2;\n", allow_create: true },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("empty-search");
      expect(result.error).toContain("create:true");
      expect(result.error).not.toContain("allow_create");
    }
    // File must be untouched.
    expect(readFile(ws, "existing.ts")).toBe("export const existing = 1;\n");
  });
});

describe("searchReplaceEdit — 5 MB cap", () => {
  it("rejects files over 5 MB", async () => {
    const ws = mkWorkspace();
    const bigPath = path.join(ws, "big.txt");
    // Write slightly over 5 MB.
    const buf = Buffer.alloc(5 * 1024 * 1024 + 1, "a");
    fs.writeFileSync(bigPath, buf);

    const result = await searchReplaceEdit(
      { path: "big.txt", search: "aaa", replace: "bbb" },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("file-too-large");
    }
  });
});

describe("searchReplaceEdit — secret file rejection", () => {
  it("rejects .env files", async () => {
    const ws = mkWorkspace();
    writeFile(ws, ".env", "SECRET=hunter2\n");

    const result = await searchReplaceEdit(
      { path: ".env", search: "hunter2", replace: "newpassword" },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("secret-file");
    }
  });

  it("rejects id_rsa files", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "id_rsa", "-----BEGIN RSA PRIVATE KEY-----\n...\n");

    const result = await searchReplaceEdit(
      { path: "id_rsa", search: "...", replace: "xxx" },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("secret-file");
    }
  });
});

describe("searchReplaceEdit — write-not-enabled", () => {
  it("returns write-not-enabled when allowWrite is false", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src.ts", "const x = 1;\n");

    const result = await searchReplaceEdit(
      { path: "src.ts", search: "const x = 1;", replace: "const x = 2;" },
      ws,
      false
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("write-not-enabled");
    }
  });
});

// ---------------------------------------------------------------------------
// Realpath path-escape defense — symlink fixtures (POSIX only)
// ---------------------------------------------------------------------------

describe("searchReplaceEdit — symlink path-escape defense", () => {
  it.skipIf(process.platform === "win32")("rejects a file symlinked outside workspace", async () => {
    const ws = mkWorkspace();
    // Create a file outside the workspace to be the symlink target.
    const outside = mkWorkspace();
    writeFile(outside, "target.txt", "secret content\n");
    const outsideFile = path.join(outside, "target.txt");

    // Create a symlink inside the workspace pointing outside.
    const symlinkPath = path.join(ws, "evil.ts");
    fs.symlinkSync(outsideFile, symlinkPath);

    const result = await searchReplaceEdit(
      { path: "evil.ts", search: "secret", replace: "replaced" },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("path-escape");
    }
    // The outside file must not have been modified.
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("secret content\n");
  });
});

// ---------------------------------------------------------------------------
// Envelope invariant — all results from this tool must have no forbidden keys.
// ---------------------------------------------------------------------------

describe("searchReplaceEdit — envelope invariants", () => {
  const FORBIDDEN_KEYS = [
    "tokenlighten",
    "tokenlighten:meta",
    "meta",
    "next_action",
    "edit_candidates",
    "native_fallback_tool",
  ];

  it("successful result has no forbidden envelope keys", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "env.ts", `const a = "old";\n`);

    const result = await searchReplaceEdit(
      { path: "env.ts", search: '"old"', replace: '"new"' },
      ws,
      true
    );

    expect(result.ok).toBe(true);
    const mcpBlock = toolOk(result);
    const serialized = JSON.stringify(mcpBlock);

    for (const k of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${k}"`);
    }
    expect(serialized).not.toMatch(/<!--\s*tokenlighten:meta/i);
  });

  it("error result has no forbidden envelope keys", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "env2.ts", `const b = 1;\n`);

    const result = await searchReplaceEdit(
      { path: "env2.ts", search: "MISSING", replace: "x" },
      ws,
      true
    );

    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    for (const k of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${k}"`);
    }
    expect(serialized).not.toMatch(/<!--\s*tokenlighten:meta/i);
  });
});
