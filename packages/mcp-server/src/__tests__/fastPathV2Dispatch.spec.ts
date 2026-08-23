// fastPathV2Dispatch.spec.ts — V11-06 Known-Local Fast Path v2: dispatch
// integration. Covers the two real wiring points: tools/searchReplaceEdit.ts
// (the apply seam) and routing/classifier.ts (the advisory RouteDecision
// field) — plus the flag-off byte-identity invariant that makes both safe.

import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { searchReplaceEdit } from "../tools/searchReplaceEdit.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { classifyRoute } from "../routing/classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-fpv2-test-"));
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

let savedFlag: string | undefined;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  }
  if (savedFlag === undefined) delete process.env["TL_FAST_PATH_V2"];
  else process.env["TL_FAST_PATH_V2"] = savedFlag;
  savedFlag = undefined;
});

function setFlag(value: string | undefined): void {
  savedFlag = process.env["TL_FAST_PATH_V2"];
  if (value === undefined) delete process.env["TL_FAST_PATH_V2"];
  else process.env["TL_FAST_PATH_V2"] = value;
}

// ---------------------------------------------------------------------------
// searchReplaceEdit.ts — flag-off byte identity
// ---------------------------------------------------------------------------

describe("searchReplaceEdit — TL_FAST_PATH_V2 off", () => {
  it("an ordinary single-occurrence edit is unaffected — same success shape as before V11-06", async () => {
    setFlag(undefined);
    const ws = mkWorkspace();
    writeFile(ws, "hello.ts", 'export function greet() {\n  return "hello";\n}\n');

    const result = await searchReplaceEdit({ path: "hello.ts", search: '"hello"', replace: '"world"' }, ws, true);

    expect(result.ok).toBe(true);
    expect(readFile(ws, "hello.ts")).toContain('"world"');
  });

  it("an ambiguous match still refuses exactly as before — no V11-06 refusal shape leaks through", async () => {
    setFlag(undefined);
    const ws = mkWorkspace();
    writeFile(ws, "dup.ts", 'const a = "foo";\nconst b = "foo";\n');

    const result = await searchReplaceEdit({ path: "dup.ts", search: '"foo"', replace: '"bar"' }, ws, true);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// searchReplaceEdit.ts — flag ON, happy path unaffected
// ---------------------------------------------------------------------------

describe("searchReplaceEdit — TL_FAST_PATH_V2 on, happy path", () => {
  it("produces the SAME successful result as flag-off for an ordinary edit", async () => {
    setFlag("1");
    const ws = mkWorkspace();
    writeFile(ws, "hello.ts", 'export function greet() {\n  return "hello";\n}\n');

    const result = await searchReplaceEdit({ path: "hello.ts", search: '"hello"', replace: '"world"' }, ws, true);

    expect(result.ok).toBe(true);
    expect(readFile(ws, "hello.ts")).toContain('"world"');
    expect(readFile(ws, "hello.ts")).not.toContain('"hello"');
  });

  it("an ambiguous match still refuses via the EXISTING applySingleEdit path (selector never short-circuits a failure differently)", async () => {
    setFlag("1");
    const ws = mkWorkspace();
    writeFile(ws, "dup.ts", 'const a = "foo";\nconst b = "foo";\n');

    const result = await searchReplaceEdit({ path: "dup.ts", search: '"foo"', replace: '"bar"' }, ws, true);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("ambiguous");
  });

  it("a not-found search still refuses exactly as before", async () => {
    setFlag("1");
    const ws = mkWorkspace();
    writeFile(ws, "solo.ts", "const only = 1;\n");

    const result = await searchReplaceEdit({ path: "solo.ts", search: "NOPE", replace: "x" }, ws, true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// searchReplaceEdit.ts — fingerprint drift, end to end
// ---------------------------------------------------------------------------

describe("searchReplaceEdit — TL_FAST_PATH_V2 on, target fingerprint drift", () => {
  // Node's built-in `fs` ESM binding is non-configurable in this runtime
  // (vi.spyOn(fs, "readFileSync") throws "Cannot redefine property" — see
  // locateTaskContext.spec.ts's identical note), so this test uses
  // vi.doMock("fs", ...) at module-registry level plus a fresh dynamic
  // import, exactly like that suite.
  afterEach(() => {
    vi.doUnmock("fs");
    vi.resetModules();
  });

  it("a mutation between the initial read and the pre-apply re-verify ⇒ refusal, 0 wrong-target edits", async () => {
    vi.resetModules();
    const ws = mkWorkspace();
    writeFile(ws, "drift.ts", "const TARGET = 1;\n");
    setFlag("1");

    let driftReadCount = 0;
    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        readFileSync: (...args: Parameters<typeof import("fs").readFileSync>) => {
          const target = args[0];
          if (typeof target === "string" && target.endsWith("drift.ts")) {
            driftReadCount += 1;
            // 1st call: searchReplaceEdit's own initial read (selection time).
            // 2nd call: V11-06's pre-apply re-verify — simulate a concurrent
            // writer having mutated the file in between.
            if (driftReadCount === 2) {
              return "const TARGET = 999; // mutated concurrently\n";
            }
          }
          return (actual.readFileSync as (...a: typeof args) => ReturnType<typeof actual.readFileSync>)(...args);
        },
      };
    });

    const { searchReplaceEdit: searchReplaceEditMocked } = await import("../tools/searchReplaceEdit.js");
    const result = await searchReplaceEditMocked(
      { path: "drift.ts", search: "const TARGET = 1;", replace: "const TARGET = 2;" },
      ws,
      true,
    );

    expect(driftReadCount).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("hash-mismatch");
    expect(result.error).toContain("fingerprint drift");
    // current_sha: the SAME already-advertised display field
    // write/preconditions.ts's own expected-hash hash-mismatch carries —
    // round-trippable straight back as expectedSha, no native re-read.
    expect(result.current_sha).toMatch(/^sha256:[0-9a-f]{12,}$/);
    // 0 wrong-target edits: the write must never have happened.
    expect(readFile(ws, "drift.ts")).toBe("const TARGET = 1;\n");
  });

  it("no mutation between the two reads ⇒ the edit applies normally (the mock's pass-through path)", async () => {
    vi.resetModules();
    const ws = mkWorkspace();
    writeFile(ws, "stable.ts", "const TARGET = 1;\n");
    setFlag("1");

    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return { ...actual }; // no interception — proves the mock harness itself is not what makes drift fire
    });

    const { searchReplaceEdit: searchReplaceEditMocked } = await import("../tools/searchReplaceEdit.js");
    const result = await searchReplaceEditMocked(
      { path: "stable.ts", search: "const TARGET = 1;", replace: "const TARGET = 2;" },
      ws,
      true,
    );

    expect(result.ok).toBe(true);
    expect(readFile(ws, "stable.ts")).toBe("const TARGET = 2;\n");
  });
});

// ---------------------------------------------------------------------------
// Call-count accounting: flag-off adds ZERO reads (by construction — every
// V11-06 addition is behind `if (fastPathV2Enabled())`); flag-on adds
// exactly ONE same-process fs.readFileSync (the pre-apply fingerprint
// re-verify) even on the minimal single-line-literal path. That one extra
// read is a local disk read inside a single searchReplaceEdit() call, never
// an extra MCP round trip — the caller still gets exactly one edit_file
// response for one edit_file call, byte-identical in shape to flag-off.
// ---------------------------------------------------------------------------

describe("searchReplaceEdit — TL_FAST_PATH_V2 read call-count accounting", () => {
  afterEach(() => {
    vi.doUnmock("fs");
    vi.resetModules();
  });

  async function countReadsFor(flag: string | undefined, relPath: string, ws: string): Promise<number> {
    vi.resetModules();
    let reads = 0;
    vi.doMock("fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fs")>();
      return {
        ...actual,
        readFileSync: (...args: Parameters<typeof import("fs").readFileSync>) => {
          const target = args[0];
          if (typeof target === "string" && target.endsWith(relPath)) reads += 1;
          return (actual.readFileSync as (...a: typeof args) => ReturnType<typeof actual.readFileSync>)(...args);
        },
      };
    });
    setFlag(flag);
    const { searchReplaceEdit: mocked } = await import("../tools/searchReplaceEdit.js");
    const result = await mocked({ path: relPath, search: "const TARGET = 1;", replace: "const TARGET = 2;" }, ws as GuardedWorkspaceRoot, true);
    expect(result.ok).toBe(true);
    return reads;
  }

  it("flag off: exactly the pre-V11-06 read count (1) for a single-line literal edit", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "count-off.ts", "const TARGET = 1;\n");
    const reads = await countReadsFor(undefined, "count-off.ts", ws);
    expect(reads).toBe(1);
  });

  it("flag on: exactly ONE additional read (the pre-apply fingerprint re-verify) — 1 extra disk read, 0 extra MCP round trips", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "count-on.ts", "const TARGET = 1;\n");
    const reads = await countReadsFor("1", "count-on.ts", ws);
    expect(reads).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// routing/classifier.ts — advisory `guard` field
// ---------------------------------------------------------------------------

describe("classifyRoute — V11-06 advisory guard field", () => {
  afterEach(() => setFlag(undefined));

  it("flag off ⇒ no guard field at all", () => {
    setFlag(undefined);
    const decision = classifyRoute("edit_file", { path: "src/a.ts", search: "export function foo() {}", replace: "x" });
    expect(decision.guard).toBeUndefined();
  });

  it("flag on, explicit path + search/replace ⇒ guard present, reflecting the cheap signals", () => {
    setFlag("1");
    const decision = classifyRoute("edit_file", { path: "src/a.ts", search: "export function foo() {}", replace: "x" });
    expect(decision.guard).toBeDefined();
    expect(decision.guard?.verdict).toBe("not-local");
  });

  it("flag on, a CLEAN edit ⇒ guard present with verdict local", () => {
    setFlag("1");
    const decision = classifyRoute("edit_file", { path: "src/internal/helper.ts", search: "  x", replace: "  y" });
    expect(decision.guard).toEqual({ verdict: "local", reasons: [] });
  });

  it("flag on, handle-anchored edit with NO explicit path ⇒ guard is undefined, never guessed", () => {
    setFlag("1");
    const decision = classifyRoute("edit_file", { handle: "h_abc123", search: "x", replace: "y" });
    expect(decision.guard).toBeUndefined();
  });

  it("guard is PURELY ADDITIVE: route/reason are identical with the flag on vs off for the same call", () => {
    const args = { path: "src/a.ts", search: "export function foo() {}", replace: "x" };
    setFlag(undefined);
    const off = classifyRoute("edit_file", args);
    setFlag("1");
    const on = classifyRoute("edit_file", args);
    expect(on.route).toBe(off.route);
    expect(on.reason).toBe(off.reason);
  });
});
