// applyEditsMulti.spec.ts — unit tests for the apply_edits_multi tool.
//
// Tests:
//   - all-or-nothing semantics (validation atomic)
//   - partial-failure rollback semantics (Phase 2 write failure)
//   - checkpoint_id emission on success
//   - duplicate path auto-merge (sequential, order-preserving, merged_paths note)
//   - write-not-enabled gate
//   - range-scoped replace-all escape recovery (whitespace-only needle
//     refusal, shared-class replace gating, raw-match precedence)

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyEditsMulti } from "../tools/applyEditsMulti.js";
import { shaOfText, shortSha } from "../util/handles.js";
import { toolOk } from "../server.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-aem-test-"));
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

describe("applyEditsMulti — all-or-nothing on validation failure", () => {
  it("does not write any files if one edit fails validation", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", `const a = "old";\n`);
    writeFile(ws, "b.ts", `const b = "old";\n`);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "a.ts", search: '"old"', replace: '"new"' },
          { path: "b.ts", search: "MISSING", replace: '"new"' },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(false);

    // Neither file should be modified.
    expect(readFile(ws, "a.ts")).toBe(`const a = "old";\n`);
    expect(readFile(ws, "b.ts")).toBe(`const b = "old";\n`);
  });

  it("does not write if search is ambiguous in any file", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "dup.ts", `const x = "foo";\nconst y = "foo";\n`);
    writeFile(ws, "ok.ts", `const z = "bar";\n`);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "dup.ts", search: '"foo"', replace: '"baz"' },
          { path: "ok.ts", search: '"bar"', replace: '"qux"' },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(false);
    expect(readFile(ws, "dup.ts")).toBe(`const x = "foo";\nconst y = "foo";\n`);
    expect(readFile(ws, "ok.ts")).toBe(`const z = "bar";\n`);
  });
});

describe("applyEditsMulti — safe indentation recovery", () => {
  it("keeps the batch atomic while recovering one unique range-scoped indentation mismatch", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "plain.ts", "export const state = \"before\";\n");
    writeFile(ws, "indented.ts", "export function value() {\n    return 1;\n}\n");

    const result = await applyEditsMulti(
      { edits: [
        { path: "plain.ts", search: '"before"', replace: '"after"' },
        { path: "indented.ts", range: "1-3", search: "\treturn 1;", replace: "\treturn 2;" },
      ] },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized_whitespace).toEqual(["indented.ts"]);
    expect(readFile(ws, "plain.ts")).toContain('"after"');
    expect(readFile(ws, "indented.ts")).toContain("    return 2;");
  });

  it("rejects an ambiguous indentation recovery without writing any batch item", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "plain.ts", "export const state = \"before\";\n");
    writeFile(ws, "ambiguous.ts", "  return value;\n    return value;\n");

    const result = await applyEditsMulti(
      { edits: [
        { path: "plain.ts", search: '"before"', replace: '"after"' },
        { path: "ambiguous.ts", range: "1-2", search: "\treturn value;", replace: "\treturn next;" },
      ] },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ambiguous");
    expect(readFile(ws, "plain.ts")).toContain('"before"');
    expect(readFile(ws, "ambiguous.ts")).toBe("  return value;\n    return value;\n");
  });
});

describe("applyEditsMulti — success path", () => {
  it("writes all files when all edits are valid", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", `const a = "hello";\n`);
    writeFile(ws, "b.ts", `const b = "world";\n`);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "a.ts", search: '"hello"', replace: '"goodbye"' },
          { path: "b.ts", search: '"world"', replace: '"earth"' },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "a.ts")).toContain('"goodbye"');
    expect(readFile(ws, "b.ts")).toContain('"earth"');
    if (result.ok) {
      expect(result.files).toHaveLength(2);
      expect(result.files[0]!.path).toBe("a.ts");
      expect(result.files[0]!.delta).toBeTruthy();
      expect(result.files[0]!.lines).toBeTruthy();
    }
  });

  it("checkpoint is a string or null (not undefined)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "c.ts", `const c = "one";\n`);

    const result = await applyEditsMulti(
      { edits: [{ path: "c.ts", search: '"one"', replace: '"two"' }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checkpoint === null || typeof result.checkpoint === "string").toBe(true);
    }
  });
});

describe("applyEditsMulti — duplicate path auto-merge", () => {
  it("merges two edits on the same path into one sequential per-file result instead of refusing", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "dup.ts", `const x = "a";\n`);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "dup.ts", search: '"a"', replace: '"b"' },
          { path: "dup.ts", search: '"b"', replace: '"c"' },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    // Second edit's search string ('"b"') only exists after the FIRST edit
    // applied — proves edit 2 ran against edit 1's OUTPUT, not a second
    // fresh disk read of the original '"a"' content.
    expect(readFile(ws, "dup.ts")).toBe(`const x = "c";\n`);
    if (result.ok) {
      // One result entry per DISTINCT path, not one per edits[] item.
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.path).toBe("dup.ts");
      expect(result.merged_paths).toEqual(["dup.ts"]);
    }
  });

  it("preserves the caller's edits[] order within a merged group (order-dependent chain)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "order.ts", `const n = 1;\n`);

    // Edit 2 depends on edit 1 having already run (searches for "step1").
    const result = await applyEditsMulti(
      {
        edits: [
          { path: "order.ts", search: "const n = 1;", replace: "const n = 1; // step1" },
          { path: "order.ts", search: "// step1", replace: "// step1 // step2" },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "order.ts")).toBe(`const n = 1; // step1 // step2\n`);
  });

  it("preserves a same-range dependent chain while rebasing the range end", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "same-range.ts", [
      "export function value(): string {",
      '  return "old";',
      "}",
    ].join("\n") + "\n");

    const result = await applyEditsMulti(
      {
        edits: [
          {
            path: "same-range.ts",
            range: "1-3",
            search: '  return "old";',
            replace: ['  const value = "new";', "  return value;"].join("\n"),
          },
          {
            path: "same-range.ts",
            range: "1-3",
            search: "  return value;",
            replace: "  return value.toUpperCase();",
          },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "same-range.ts")).toContain("return value.toUpperCase();");
  });

  it("does not merge distinct paths — merged_paths is absent when no path repeats", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a2.ts", `const a = "x";\n`);
    writeFile(ws, "b2.ts", `const b = "y";\n`);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "a2.ts", search: '"x"', replace: '"x2"' },
          { path: "b2.ts", search: '"y"', replace: '"y2"' },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files).toHaveLength(2);
      expect(result.merged_paths).toBeUndefined();
    }
  });

  it("a merged group's chained failure (2nd edit's search not found after 1st applied) still fails the WHOLE batch (all-or-nothing) and writes nothing", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "chainfail.ts", `const x = "a";\n`);
    writeFile(ws, "other.ts", `const y = "keep";\n`);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "chainfail.ts", search: '"a"', replace: '"b"' },
          // This search string never exists at any point in the chain.
          { path: "chainfail.ts", search: "MISSING_FOREVER", replace: '"c"' },
          { path: "other.ts", search: '"keep"', replace: '"changed"' },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-found");
      expect(result.path).toBe("chainfail.ts");
    }
    // Nothing written — including the unrelated file and the FIRST (valid) edit in the chain.
    expect(readFile(ws, "chainfail.ts")).toBe(`const x = "a";\n`);
    expect(readFile(ws, "other.ts")).toBe(`const y = "keep";\n`);
  });

  it("merges three edits on the same path (chain longer than two)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "triple.ts", `let v = 0;\n`);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "triple.ts", search: "let v = 0;", replace: "let v = 1;" },
          { path: "triple.ts", search: "let v = 1;", replace: "let v = 2;" },
          { path: "triple.ts", search: "let v = 2;", replace: "let v = 3;" },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "triple.ts")).toBe(`let v = 3;\n`);
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      expect(result.merged_paths).toEqual(["triple.ts"]);
    }
  });
});

describe("applyEditsMulti — write-not-enabled", () => {
  it("returns write-not-enabled error when allowWrite is false", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "x.ts", `const x = 1;\n`);

    const result = await applyEditsMulti(
      { edits: [{ path: "x.ts", search: "const x = 1;", replace: "const x = 2;" }] },
      ws,
      false,
      SESSION
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("write-not-enabled");
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2 rollback — all-or-nothing under write failure (POSIX only)
// ---------------------------------------------------------------------------

describe("applyEditsMulti — all-or-nothing under Phase 2 write failure", () => {
  it.skipIf(process.platform === "win32")(
    "rolls back written files when 2nd write fails due to read-only directory",
    async () => {
      const ws = mkWorkspace();
      // a/ — first file lives here (writable)
      writeFile(ws, "a/1.ts", `const one = "original";\n`);
      // b/ — second file lives here; we'll make it read-only AFTER Phase 1 validates
      // but BEFORE Phase 2 writes (we do this by having the file exist in a
      // separate sub-directory that we chmod 0o555 after validation passes).
      // Since atomicWrite writes a tmp file in the SAME directory as the target,
      // a read-only directory blocks the atomic tmp write.
      writeFile(ws, "b/2.ts", `const two = "original";\n`);
      writeFile(ws, "c/3.ts", `const three = "original";\n`);

      // Make b/ directory read-only to force write failure on the 2nd file.
      const bDir = path.join(ws, "b");
      fs.chmodSync(bDir, 0o555);

      let result: Awaited<ReturnType<typeof applyEditsMulti>>;
      try {
        result = await applyEditsMulti(
          {
            edits: [
              { path: "a/1.ts", search: '"original"', replace: '"modified"' },
              { path: "b/2.ts", search: '"original"', replace: '"modified"' },
              { path: "c/3.ts", search: '"original"', replace: '"modified"' },
            ],
          },
          ws,
          true,
          SESSION
        );
      } finally {
        // Restore writability before cleanup
        fs.chmodSync(bDir, 0o755);
      }

      // Batch must have failed
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("write-error");
      }

      // All files on disk must have ORIGINAL bytes
      expect(readFile(ws, "a/1.ts")).toBe(`const one = "original";\n`);
      expect(readFile(ws, "b/2.ts")).toBe(`const two = "original";\n`);
      // 3rd file was not attempted, so it should still have original content
      expect(readFile(ws, "c/3.ts")).toBe(`const three = "original";\n`);
    }
  );
});

// ---------------------------------------------------------------------------
// Envelope invariants
// ---------------------------------------------------------------------------

describe("applyEditsMulti — envelope invariants", () => {
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
    writeFile(ws, "d.ts", `const d = "before";\n`);

    const result = await applyEditsMulti(
      { edits: [{ path: "d.ts", search: '"before"', replace: '"after"' }] },
      ws,
      true,
      SESSION
    );

    const mcpBlock = toolOk(result);
    const serialized = JSON.stringify(mcpBlock);

    for (const k of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${k}"`);
    }
    expect(serialized).not.toMatch(/<!--\s*tokenlighten:meta/i);
  });

  it("failure result has no forbidden envelope keys", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "e.ts", `const e = 1;\n`);

    const result = await applyEditsMulti(
      { edits: [{ path: "e.ts", search: "MISSING", replace: "x" }] },
      ws,
      true,
      SESSION
    );

    const mcpBlock = toolOk(result);
    const serialized = JSON.stringify(mcpBlock);

    for (const k of FORBIDDEN_KEYS) {
      expect(serialized).not.toContain(`"${k}"`);
    }
    expect(serialized).not.toMatch(/<!--\s*tokenlighten:meta/i);
  });
});

describe("applyEditsMulti — range-scoped replace-all escape recovery", () => {
  it("REGRESSION: a literal `\\n` search must NOT unescape into a whitespace-only needle and rewrite every line break in the range", async () => {
    const ws = mkWorkspace();
    const original = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
    writeFile(ws, "code.ts", original);

    // search is the literal TWO characters `\` + `n`. Before the
    // whitespace-only gate, recovery unescaped it to a real newline and
    // split/join rewrote all 4 line breaks — collapsing the range to one
    // line while reporting success with normalized_escapes.
    const result = await applyEditsMulti(
      { edits: [{ path: "code.ts", range: "1-4", search: "\\n", replace: " /*X*/ " }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-found");
      expect(result.hint).toContain("whitespace-only");
    }
    expect(readFile(ws, "code.ts")).toBe(original);
  });

  it("other whitespace-only unescaped needles (`\\t`, `\\n\\n`, `\\r\\n`) are refused the same way", async () => {
    const ws = mkWorkspace();
    const original = "\tindent1\n\tindent2\n\nnext\n";
    writeFile(ws, "ws.ts", original);

    for (const search of ["\\t", "\\n\\n", "\\r\\n"]) {
      const result = await applyEditsMulti(
        { edits: [{ path: "ws.ts", range: "1-4", search, replace: "X" }] },
        ws,
        true,
        SESSION
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.hint).toContain("whitespace-only");
    }
    expect(readFile(ws, "ws.ts")).toBe(original);
  });

  it("a distinctive multi-char needle still recovers, replace-all across the range", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "multi.ts", "foo\nbar\nmiddle\nfoo\nbar\ntail\n");

    const result = await applyEditsMulti(
      { edits: [{ path: "multi.ts", range: "1-6", search: "foo\\nbar", replace: "FOOBAR" }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized_escapes).toEqual(["multi.ts"]);
    expect(readFile(ws, "multi.ts")).toBe("FOOBAR\nmiddle\nFOOBAR\ntail\n");
  });

  it("raw literal `\\n` TEXT present in the range still matches directly, with no recovery involved", async () => {
    const ws = mkWorkspace();
    // File content contains the literal two-char sequence `\` + `n` inside
    // string literals — the raw search matches it directly, so the
    // whitespace-only gate (which only guards the RECOVERY path) never runs
    // and replace-all applies to the literal text as-is.
    writeFile(ws, "raw.ts", 'const s = "a\\nb";\nconst t = "c\\nd";\n');

    const result = await applyEditsMulti(
      { edits: [{ path: "raw.ts", range: "1-2", search: "\\n", replace: "\\r" }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized_escapes).toBeUndefined();
    expect(readFile(ws, "raw.ts")).toBe('const s = "a\\rb";\nconst t = "c\\rd";\n');
  });

  it("replace-side escapes are unescaped only on shared-class evidence during range recovery", async () => {
    const ws = mkWorkspace();

    // Search recovers via \n; replace's only escape is \t (different class)
    // — it is written byte-for-byte as backslash-t, not as a real tab.
    writeFile(ws, "cls.ts", "alpha\nbeta\ngamma\n");
    const crossClass = await applyEditsMulti(
      { edits: [{ path: "cls.ts", range: "1-3", search: "alpha\\nbeta", replace: "X\\tY" }] },
      ws,
      true,
      SESSION
    );
    expect(crossClass.ok).toBe(true);
    if (crossClass.ok) expect(crossClass.normalized_escapes).toEqual(["cls.ts"]);
    expect(readFile(ws, "cls.ts")).toBe("X\\tY\ngamma\n");

    // Same class (\n on both sides): replace IS unescaped with the search.
    writeFile(ws, "cls2.ts", "alpha\nbeta\ngamma\n");
    const sameClass = await applyEditsMulti(
      { edits: [{ path: "cls2.ts", range: "1-3", search: "alpha\\nbeta", replace: "one\\ntwo" }] },
      ws,
      true,
      SESSION
    );
    expect(sameClass.ok).toBe(true);
    expect(readFile(ws, "cls2.ts")).toBe("one\ntwo\ngamma\n");
  });
});

// ---------------------------------------------------------------------------
// 2026-07-11c: comma-separated ranges ("160,195") are accepted as a synonym
// for the dash form (parseRangeEntry leniency) — agents that write comma
// ranges on reads write them on edit ranges too.
// ---------------------------------------------------------------------------

describe("applyEditsMulti — comma-form ranges (2026-07-11c)", () => {
  it("range-content replacement accepts a comma range (\"2,4\") as a synonym for \"2-4\"", async () => {
    const ws = mkWorkspace();
    const original = "line1\nline2\nline3\nline4\nline5\n";
    writeFile(ws, "items.ts", original);

    const result = await applyEditsMulti(
      { edits: [{ path: "items.ts", range: "2,4", search: "", replace: "", content: "REPLACED\n" }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "items.ts")).toBe("line1\nREPLACED\nline5\n");
  });

  it("range-scoped replace-all accepts a comma range (\"1,3\") as a synonym for \"1-3\"", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "words.ts", "foo one\nfoo two\nfoo three\nfoo four\n");

    const result = await applyEditsMulti(
      { edits: [{ path: "words.ts", range: "1,3", search: "foo", replace: "bar" }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "words.ts")).toBe("bar one\nbar two\nbar three\nfoo four\n");
  });

  it("a comma range with more than two bounds (\"1,2,3\") is still rejected as invalid", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "x.ts", "a\nb\nc\n");

    const result = await applyEditsMulti(
      { edits: [{ path: "x.ts", range: "1,2,3", search: "a", replace: "z" }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-input");
      expect(result.error).toContain("invalid range: 1,2,3");
    }
    expect(readFile(ws, "x.ts")).toBe("a\nb\nc\n");
  });
});

// ---------------------------------------------------------------------------
// 2026-07-12c batch fix: a range-LESS EditEntry ({path, search:"",
// replace:"", content}) is a WHOLE-FILE content replacement — the batch
// mirror of server.ts's single-edit FIX A (kind:"file" handle + content).
// server.ts's edits[] mapping loop only ever constructs this exact shape for
// a kind:"file" handle entry carrying content and no search/replace/range;
// these tests exercise applyEditStep's own logic directly, one layer below
// that resolution (mirrors argMatrix.spec.ts's own "defense-in-depth" direct
// EditEntry construction for the range-entry wipe guard).
// ---------------------------------------------------------------------------

describe("applyEditsMulti — whole-file content replacement (2026-07-12c batch fix)", () => {
  it("a range-less EditEntry {search:\"\", replace:\"\", content} replaces the ENTIRE file, not a search/replace or a silent no-op", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "whole.ts", "line1\nline2\nline3\n");

    const result = await applyEditsMulti(
      { edits: [{ path: "whole.ts", search: "", replace: "", content: "brand-new-body\n" }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "whole.ts")).toBe("brand-new-body\n");
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      expect(result.files[0]!.path).toBe("whole.ts");
      expect(result.files[0]!.delta).toBe("+1/-3");
      expect(result.files[0]!.lines).toBe("1");
    }
  });

  it("REGRESSION: without content, search:\"\" still refuses with the original empty-search error (this branch must not swallow the pre-existing refusal)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "empty.ts", "line1\nline2\n");

    const result = await applyEditsMulti(
      { edits: [{ path: "empty.ts", search: "", replace: "" }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("empty-search");
      expect(result.error).toContain("search string is empty");
    }
    expect(readFile(ws, "empty.ts")).toBe("line1\nline2\n");
  });

  it("merged group on the SAME path: a whole-file content replace followed by a normal search/replace applies the SECOND edit against the FIRST edit's output", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "chain.ts", "old body\n");

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "chain.ts", search: "", replace: "", content: "const target = 1;\n" },
          { path: "chain.ts", search: "target = 1", replace: "target = 2" },
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "chain.ts")).toBe("const target = 2;\n");
  });

  it("merged group on the SAME path, REVERSED order: a range-content shrink followed by a whole-file content replace uses the SHRUNK text's line count, not the original", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "shrink.ts", "line1\nline2\nline3\nline4\nline5\n");

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "shrink.ts", range: "1-2", search: "", replace: "", content: "shrunk\n" }, // 5 lines -> 4 lines
          { path: "shrink.ts", search: "", replace: "", content: "final\n" }, // whole-file, no range
        ],
      },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "shrink.ts")).toBe("final\n");
  });

  it("whole-file content replacement on an EMPTY file works (0 lines removed, no formatting edge case)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "empty-src.ts", "");

    const result = await applyEditsMulti(
      { edits: [{ path: "empty-src.ts", search: "", replace: "", content: "export const X = 1;\n" }] },
      ws,
      true,
      SESSION
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "empty-src.ts")).toBe("export const X = 1;\n");
    if (result.ok) {
      expect(result.files[0]!.delta).toBe("+1/-0");
    }
  });

  it("carries nearest-match forensics on a range-scoped not-found (2026-07-26 T09 R2)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/cfg.ts", "const m = {\n\tCRITICAL: 0,\n\tHIGH: 1,\n};\nrest();\n");
    // Content drift (wrong value), so indentation-equivalent recovery cannot
    // rescue it — the solver must SEE the actual bytes to correct the search.
    const result = await applyEditsMulti(
      { edits: [{ path: "src/cfg.ts", range: "1-4", search: "const m = {\n    CRITICAL: 0,\n    HIGH: 2,\n};", replace: "const m = {\n    CRITICAL: 9,\n};" }] },
      ws,
      true,
      SESSION
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-found");
      expect(result.nearest_match).toBeDefined();
      expect(result.nearest_match!.range).toBe("1-4");
      // Verbatim bytes: the real tab indentation is visible in the payload.
      expect(result.nearest_match!.code).toContain("\tCRITICAL: 0,");
    }
  });

  it("identifies a later failing item and its nearest bytes without partially writing", async () => {
    const ws = mkWorkspace();
    const original = [
      "const ready = false;",
      "/* Update health flags */",
      "const done = false;",
      "",
    ].join("\n");
    writeFile(ws, "src/runtime.ts", original);

    const result = await applyEditsMulti({
      edits: [
        {
          path: "src/runtime.ts",
          search: "const ready = false;",
          replace: "const ready = true;",
        },
        {
          path: "src/runtime.ts",
          search: "// Update health flags",
          replace: "// Update health and publish it",
        },
      ],
    }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not-found");
      expect(result.failed_item).toEqual({
        index: 1,
        path: "src/runtime.ts",
        search_preview: "// Update health flags",
      });
      expect(result.nearest_match?.code ?? result.actual?.code).toContain("/* Update health flags */");
    }
    expect(readFile(ws, "src/runtime.ts")).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// ANCHOR EDITS. An edits[] item may address its target by served handle + an
// explicit line `range` plus replacement `content`, instead of restating the
// served bytes in a long verbatim `search`. Motivation is output cost: the
// search string duplicates bytes the server already sent, and one measured
// bench run batched 90 edit items in a single call.
//
// Because an anchor edit carries no served bytes, it also carries no proof its
// line coordinates are still valid — so server.ts stamps the addressing
// handle's recorded sha onto the item as `anchorSha` (+ `anchorShaRange` when
// that sha covers a SLICE rather than the whole file) and applyEditsMulti
// verifies it against the pre-batch on-disk bytes before Phase 2 writes
// anything. These tests drive the engine directly, one layer below that
// resolution, the same way the whole-file-content tests above do.
// ---------------------------------------------------------------------------

/** sha a kind:"file" handle records (raw whole-file text). */
function wholeFileSha(text: string): string {
  return shaOfText(text);
}

/**
 * sha a kind:"range"/"symbol" handle records — must reproduce
 * tools/readCodeModes.ts resolveSlice exactly: split on /\r?\n/, take the
 * 1-based inclusive range, re-join with LF.
 */
function sliceSha(text: string, start: number, end: number): string {
  return shaOfText(text.split(/\r?\n/).slice(start - 1, end).join("\n"));
}

const FIVE_LINES = "line1\nline2\nline3\nline4\nline5\n";

describe("applyEditsMulti — anchor edits (handle + range + content)", () => {
  it("replaces exactly the anchored range with multi-line content and reports the applied span + delta", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "anchor.ts", FIVE_LINES);

    const result = await applyEditsMulti(
      {
        edits: [
          {
            path: "anchor.ts",
            search: "",
            replace: "",
            range: "2-3",
            content: "alpha\nbeta\ngamma\n",
            anchorSha: wholeFileSha(FIVE_LINES),
          },
        ],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    // Exactly lines 2-3 replaced; lines 1/4/5 byte-identical; LF preserved.
    expect(readFile(ws, "anchor.ts")).toBe("line1\nalpha\nbeta\ngamma\nline4\nline5\n");
    if (result.ok) {
      expect(result.files).toHaveLength(1);
      // Same EditFileResult shape a search edit produces: path, applied hunk
      // span, delta, and a fresh post-edit handle.
      expect(result.files[0]!.path).toBe("anchor.ts");
      expect(result.files[0]!.lines).toBe("2-4");
      expect(result.files[0]!.delta).toBe("+3/-2");
      expect(typeof result.files[0]!.handle).toBe("string");
    }
  });

  it("deletes the anchored range when content is the empty string", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "del.ts", FIVE_LINES);

    const result = await applyEditsMulti(
      {
        edits: [
          {
            path: "del.ts",
            search: "",
            replace: "",
            range: "2-3",
            content: "",
            anchorSha: wholeFileSha(FIVE_LINES),
          },
        ],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "del.ts")).toBe("line1\nline4\nline5\n");
    if (result.ok) {
      expect(result.files[0]!.delta).toBe("+0/-2");
    }
  });

  it("produces byte-identical output to the equivalent search/replace edit (trailing-newline + LF parity)", async () => {
    const anchorWs = mkWorkspace();
    const searchWs = mkWorkspace();
    writeFile(anchorWs, "parity.ts", FIVE_LINES);
    writeFile(searchWs, "parity.ts", FIVE_LINES);

    const viaAnchor = await applyEditsMulti(
      {
        edits: [{
          path: "parity.ts",
          search: "",
          replace: "",
          range: "2-3",
          content: "replaced\n",
          anchorSha: wholeFileSha(FIVE_LINES),
        }],
      },
      anchorWs,
      true,
      SESSION,
    );
    const viaSearch = await applyEditsMulti(
      { edits: [{ path: "parity.ts", search: "line2\nline3\n", replace: "replaced\n" }] },
      searchWs,
      true,
      SESSION,
    );

    expect(viaAnchor.ok).toBe(true);
    expect(viaSearch.ok).toBe(true);
    expect(readFile(anchorWs, "parity.ts")).toBe(readFile(searchWs, "parity.ts"));
    expect(readFile(anchorWs, "parity.ts")).toBe("line1\nreplaced\nline4\nline5\n");
  });

  it("applies when a SLICE handle's recorded sha still matches its own range", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "slice.ts", FIVE_LINES);

    const result = await applyEditsMulti(
      {
        edits: [{
          path: "slice.ts",
          search: "",
          replace: "",
          range: "3-3",
          content: "THREE\n",
          anchorSha: sliceSha(FIVE_LINES, 2, 4),
          anchorShaRange: "2-4",
        }],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "slice.ts")).toBe("line1\nline2\nTHREE\nline4\nline5\n");
  });

  it("does NOT false-stale when a slice handle's own range is untouched but the rest of the file changed", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "outside.ts", FIVE_LINES);
    const servedSliceSha = sliceSha(FIVE_LINES, 2, 4);
    // line5 rewritten AFTER the handle was served — outside the served slice,
    // and (crucially) lines 2-4 keep their line numbers, so the anchor is fine.
    writeFile(ws, "outside.ts", "line1\nline2\nline3\nline4\nCHANGED\n");

    const result = await applyEditsMulti(
      {
        edits: [{
          path: "outside.ts",
          search: "",
          replace: "",
          range: "3-3",
          content: "THREE\n",
          anchorSha: servedSliceSha,
          anchorShaRange: "2-4",
        }],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "outside.ts")).toBe("line1\nline2\nTHREE\nline4\nCHANGED\n");
  });
});

describe("applyEditsMulti — anchor edit CAS (served-content-stale)", () => {
  it("refuses with served-content-stale + current_sha + the CURRENT bytes at the anchored range, and writes nothing", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "cas.ts", FIVE_LINES);
    const servedSha = wholeFileSha(FIVE_LINES);

    // External change AFTER the handle was served: a line was inserted, so the
    // caller's "2-3" no longer names what it read.
    const drifted = "line0-inserted\nline1\nline2\nline3\nline4\nline5\n";
    writeFile(ws, "cas.ts", drifted);

    const result = await applyEditsMulti(
      {
        edits: [{
          path: "cas.ts",
          search: "",
          replace: "",
          range: "2-3",
          content: "WOULD-HAVE-CLOBBERED\n",
          anchorSha: servedSha,
        }],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("served-content-stale");
      expect(result.reason).toBe("served-content-stale");
      expect(result.path).toBe("cas.ts");
      // Both shas are reported so the caller can tell drift from a wrong handle.
      expect(result.current_sha).toBe(shortSha(wholeFileSha(drifted)));
      expect(result.served_sha).toBe(shortSha(servedSha));
      expect(result.failed_item).toEqual({ index: 0, path: "cas.ts", range: "2-3" });
      // The refreshed slice IS the re-anchoring material: the CURRENT bytes at
      // the requested range, so the retry needs no read.
      expect(result.nearest_match?.range).toBe("2-3");
      expect(result.nearest_match?.code).toBe("line1\nline2");
    }
    // Never write on a validation failure.
    expect(readFile(ws, "cas.ts")).toBe(drifted);
  });

  it("detects staleness for a SLICE handle when its own served range changed", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "casslice.ts", FIVE_LINES);
    const servedSliceSha = sliceSha(FIVE_LINES, 2, 4);
    const drifted = "line1\nline2\nEDITED-BY-SOMEONE-ELSE\nline4\nline5\n";
    writeFile(ws, "casslice.ts", drifted);

    const result = await applyEditsMulti(
      {
        edits: [{
          path: "casslice.ts",
          search: "",
          replace: "",
          range: "3-3",
          content: "MINE\n",
          anchorSha: servedSliceSha,
          anchorShaRange: "2-4",
        }],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("served-content-stale");
      expect(result.current_sha).toBe(shortSha(sliceSha(drifted, 2, 4)));
      // Refreshed slice covers the ANCHORED range (3-3), not the sha's range.
      expect(result.nearest_match?.range).toBe("3-3");
      expect(result.nearest_match?.code).toBe("EDITED-BY-SOMEONE-ELSE");
    }
    expect(readFile(ws, "casslice.ts")).toBe(drifted);
  });

  it("keeps the batch atomic: one stale anchor item leaves EVERY file in the batch untouched", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "clean.ts", `const clean = "old";\n`);
    writeFile(ws, "stale.ts", FIVE_LINES);
    const servedSha = wholeFileSha(FIVE_LINES);
    writeFile(ws, "stale.ts", "changed-underneath\n" + FIVE_LINES);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "clean.ts", search: '"old"', replace: '"new"' },
          {
            path: "stale.ts",
            search: "",
            replace: "",
            range: "1-2",
            content: "nope\n",
            anchorSha: servedSha,
          },
        ],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("served-content-stale");
      expect(result.failed_item?.index).toBe(1);
    }
    // clean.ts validated fine and is ordered FIRST, but Phase 1 refuses the
    // whole batch before Phase 2 runs — same all-or-nothing contract as the
    // search-not-found tests at the top of this file.
    expect(readFile(ws, "clean.ts")).toBe(`const clean = "old";\n`);
    expect(readFile(ws, "stale.ts")).toBe("changed-underneath\n" + FIVE_LINES);
  });

  it("an item WITHOUT anchorSha is not CAS-checked (the pre-existing {handle, content} shapes keep working)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "nocas.ts", FIVE_LINES);
    // No anchorSha: server.ts only stamps one when the ITEM supplied its own
    // explicit range, so shapes that resolve their span from the handle keep
    // their historical behavior (see editFileKindFileHandle.spec.ts's
    // same-handle-reused-twice case).
    const result = await applyEditsMulti(
      { edits: [{ path: "nocas.ts", search: "", replace: "", range: "2-3", content: "X\n" }] },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "nocas.ts")).toBe("line1\nX\nline4\nline5\n");
  });
});

describe("applyEditsMulti — anchor range bounds", () => {
  it("refuses an out-of-bounds anchor range with reason/file_line_count/current head and writes nothing", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "oob.ts", FIVE_LINES);

    const result = await applyEditsMulti(
      {
        edits: [{
          path: "oob.ts",
          search: "",
          replace: "",
          range: "9-12",
          content: "past-eof\n",
          anchorSha: wholeFileSha(FIVE_LINES),
        }],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // `code`/`error` keep their historical values; the rest is additive.
      expect(result.code).toBe("invalid-input");
      expect(result.error).toBe("range 9-12 is out of bounds (file has 5 lines)");
      expect(result.reason).toBe("range-out-of-bounds");
      expect(result.file_line_count).toBe(5);
      expect(result.actual?.range).toBe("1-5");
      expect(result.actual?.code).toBe("line1\nline2\nline3\nline4\nline5");
      expect(result.failed_item).toEqual({ index: 0, path: "oob.ts", range: "9-12" });
    }
    expect(readFile(ws, "oob.ts")).toBe(FIVE_LINES);
  });

  it("an anchor range at the exact EOF line is still in bounds", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "edge.ts", FIVE_LINES);

    const result = await applyEditsMulti(
      {
        edits: [{
          path: "edge.ts",
          search: "",
          replace: "",
          range: "5-5",
          content: "last\n",
          anchorSha: wholeFileSha(FIVE_LINES),
        }],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "edge.ts")).toBe("line1\nline2\nline3\nline4\nlast\n");
  });
});

describe("applyEditsMulti — anchor edits mixed with other shapes", () => {
  it("applies a search item and an anchor item in ONE batch, across two files", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "searchy.ts", `export const MODE = "old";\n`);
    writeFile(ws, "anchored.ts", FIVE_LINES);

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "searchy.ts", search: '"old"', replace: '"new"' },
          {
            path: "anchored.ts",
            search: "",
            replace: "",
            range: "2-4",
            content: "middle\n",
            anchorSha: wholeFileSha(FIVE_LINES),
          },
        ],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "searchy.ts")).toBe(`export const MODE = "new";\n`);
    expect(readFile(ws, "anchored.ts")).toBe("line1\nmiddle\nline5\n");
    if (result.ok) {
      expect(result.files.map((f) => f.path)).toEqual(["searchy.ts", "anchored.ts"]);
    }
  });

  it("two non-overlapping anchor items on the SAME file both apply against their shared pre-edit coordinates", async () => {
    const ws = mkWorkspace();
    const original = "a\nb\nc\nd\ne\nf\n";
    writeFile(ws, "two.ts", original);
    const served = wholeFileSha(original);

    const result = await applyEditsMulti(
      {
        edits: [
          // Top range listed FIRST but shrinking; the existing range-only
          // clustering applies distinct ranges bottom-to-top so the lower
          // range's coordinates cannot be staled by the upper edit.
          { path: "two.ts", search: "", replace: "", range: "1-2", content: "AB\n", anchorSha: served },
          { path: "two.ts", search: "", replace: "", range: "5-6", content: "EF\n", anchorSha: served },
        ],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "two.ts")).toBe("AB\nc\nd\nEF\n");
    if (result.ok) expect(result.merged_paths).toEqual(["two.ts"]);
  });
});

describe("applyEditsMulti — anchor edits respect existing gates", () => {
  it("refuses without --allow-write before doing any CAS or bounds work", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "gated.ts", FIVE_LINES);

    const result = await applyEditsMulti(
      {
        edits: [{
          path: "gated.ts",
          search: "",
          replace: "",
          range: "2-3",
          // Deliberately BOTH stale and out of bounds would-be errors are
          // irrelevant: the write gate must win, and must not leak file state.
          content: "nope\n",
          anchorSha: "sha256:deadbeef",
        }],
      },
      ws,
      false,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("write-not-enabled");
      expect(result.current_sha).toBeUndefined();
      expect(result.nearest_match).toBeUndefined();
    }
    expect(readFile(ws, "gated.ts")).toBe(FIVE_LINES);
  });

  it("REGRESSION: a range item with neither content nor a non-empty search still refuses instead of wiping the range", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "guard.ts", FIVE_LINES);

    const result = await applyEditsMulti(
      { edits: [{ path: "guard.ts", search: "", replace: "", range: "2-3", anchorSha: wholeFileSha(FIVE_LINES) }] },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid-input");
    expect(readFile(ws, "guard.ts")).toBe(FIVE_LINES);
  });

  it("REGRESSION: a secret-looking path is still refused for an anchor item", async () => {
    const ws = mkWorkspace();
    writeFile(ws, ".env", "TOKEN=abc\nOTHER=def\n");

    const result = await applyEditsMulti(
      {
        edits: [{
          path: ".env",
          search: "",
          replace: "",
          range: "1-1",
          content: "TOKEN=leaked\n",
          anchorSha: wholeFileSha("TOKEN=abc\nOTHER=def\n"),
        }],
      },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("secret-file");
    expect(readFile(ws, ".env")).toBe("TOKEN=abc\nOTHER=def\n");
  });
});
