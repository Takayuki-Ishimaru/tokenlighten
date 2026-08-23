// indexInvalidation.spec.ts — V10-10: a successful in-process write must be
// visible to the very next symbols/skeleton read in the SAME process.
//
// skeleton-engine's loadOrBuildSourceIndex keeps an in-process manifestMemo
// (a module-level singleton, shared by every caller in this process) so a
// long-lived server doesn't re-validate every file on every call. Without
// invalidateCachedWorkspaceFiles wired into the write path
// (write/atomicWrite.ts's writeExistingFileAtomic — the aggregation point
// every existing-file write funnels through — and the create/artifact
// success points that bypass it), a symbols read immediately following a
// successful write could still be served the PRE-edit manifest object
// straight from the memo, without ever re-reading the file it just changed.
//
// This spec proves the write -> read sequence sees fresh content end-to-end
// through mcp-server's own wiring, calling the real tool functions
// in-process (no server spawn needed — the point under test is the shared
// in-process module state, which a subprocess wouldn't even exercise the
// same way). See packages/skeleton-engine/src/__tests__/indexStore.spec.ts's
// "V10-10" tests for the lower-level proof (content-hash gate + memo
// invalidation) this spec builds on.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Spy on invalidateCachedWorkspaceFiles while keeping its real behavior
// (the mtime-driven behavioral tests below still need it to actually work).
// This is the DIRECT proof that the write path's wiring fires at all — the
// behavioral tests alone cannot rule out an accidental pass from an
// ordinary write's mtime bump busting the memo on its own, independent of
// whether invalidateCachedWorkspaceFiles was ever called.
const invalidateSpy = vi.hoisted(() => vi.fn());
vi.mock("@tokenlighten/skeleton-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tokenlighten/skeleton-engine")>();
  return {
    ...actual,
    invalidateCachedWorkspaceFiles: (...args: Parameters<typeof actual.invalidateCachedWorkspaceFiles>) => {
      invalidateSpy(...args);
      return actual.invalidateCachedWorkspaceFiles(...args);
    },
  };
});

import { searchReplaceEdit } from "../tools/searchReplaceEdit.js";
import { applyEditsMulti } from "../tools/applyEditsMulti.js";
import { createFile } from "../tools/createFile.js";
import { renameSymbol } from "../tools/renameSymbol.js";
import { searchSymbols } from "../tools/searchSymbols.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

const SESSION = "indexInvalidation-test-session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-index-invalidation-"));
  tmpDirs.push(dir);
  return unsafeGuardedWorkspaceRootForTests(dir);
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
  invalidateSpy.mockClear();
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("V10-10 — write path invalidates the in-process index for the very next read", () => {
  it("searchReplaceEdit (single edit_file path): a symbol rename is visible to an immediately-following searchSymbols call", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "export function oldName() { return 1; }\n");

    // Warm the in-process manifestMemo — mirrors a real server having
    // already answered at least one read for this workspace before the
    // edit below, which is exactly the scenario that used to go stale.
    const before = await searchSymbols({ query: "oldName" }, ws);
    expect(before.locations.map((l) => l.symbol)).toContain("oldName");

    const edit = await searchReplaceEdit(
      { path: "src/a.ts", search: "oldName", replace: "newName" },
      ws,
      true,
    );
    expect(edit.ok).toBe(true);

    // Same process, immediately after: a fresh symbols read must reflect
    // the rename, not the pre-edit manifestMemo entry.
    const afterOld = await searchSymbols({ query: "oldName" }, ws);
    expect(afterOld.locations.map((l) => l.symbol)).not.toContain("oldName");
    const afterNew = await searchSymbols({ query: "newName" }, ws);
    expect(afterNew.locations.map((l) => l.symbol)).toContain("newName");
  });

  it("applyEditsMulti (batch edit_file path): a batch edit is visible to an immediately-following searchSymbols call", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/b.ts", "export function beforeBatch() { return 1; }\n");

    await searchSymbols({ query: "beforeBatch" }, ws); // warm the memo

    const result = await applyEditsMulti(
      { edits: [{ path: "src/b.ts", search: "beforeBatch", replace: "afterBatch" }] },
      ws,
      true,
      SESSION,
    );
    expect(result.ok).toBe(true);

    const after = await searchSymbols({ query: "afterBatch" }, ws);
    expect(after.locations.map((l) => l.symbol)).toContain("afterBatch");
    const afterOld = await searchSymbols({ query: "beforeBatch" }, ws);
    expect(afterOld.locations.map((l) => l.symbol)).not.toContain("beforeBatch");
  });

  it("createFile: a brand-new file's symbol is visible to an immediately-following searchSymbols call", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/existing.ts", "export function existing() { return 1; }\n");

    // Warm the memo over the workspace as it exists BEFORE the new file.
    const before = await searchSymbols({ query: "brandNew" }, ws);
    expect(before.locations).toEqual([]);

    const created = await createFile(
      { path: "src/fresh.ts", content: "export function brandNew() { return 1; }\n" },
      ws,
      true,
      SESSION,
    );
    expect(created.ok).toBe(true);

    const after = await searchSymbols({ query: "brandNew" }, ws);
    expect(after.locations.map((l) => l.symbol)).toContain("brandNew");
  });

  it("renameSymbol (rename-symbol-references path): the rewritten name is visible to an immediately-following searchSymbols call", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/c.ts", "export function widgetHelper() { return widgetHelper; }\n");

    await searchSymbols({ query: "widgetHelper" }, ws); // warm the memo

    const result = await renameSymbol(
      { from: "widgetHelper", to: "gadgetHelper" },
      ws,
      true,
      SESSION,
    );
    expect(result.ok).toBe(true);

    const after = await searchSymbols({ query: "gadgetHelper" }, ws);
    expect(after.locations.map((l) => l.symbol)).toContain("gadgetHelper");
    const afterOld = await searchSymbols({ query: "widgetHelper" }, ws);
    expect(afterOld.locations.map((l) => l.symbol)).not.toContain("widgetHelper");
  });
});

describe("V10-10 — direct wiring proof (invalidateCachedWorkspaceFiles is actually called)", () => {
  // The behavioral tests above prove the OBSERVABLE outcome is correct, but
  // an ordinary write's mtime bump can itself bust the memo's stat
  // fingerprint — so passing there does not, on its own, prove
  // invalidateCachedWorkspaceFiles was ever invoked. These assert the call
  // directly, closing that gap.

  it("searchReplaceEdit calls invalidateCachedWorkspaceFiles(workspace, [path]) on a successful edit", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "export function xValue() { return 1; }\n");

    const result = await searchReplaceEdit({ path: "src/a.ts", search: "xValue", replace: "yValue" }, ws, true);
    expect(result.ok).toBe(true);

    expect(invalidateSpy).toHaveBeenCalled();
    const call = invalidateSpy.mock.calls.at(-1)!;
    expect(call[0]).toBe(fs.realpathSync(ws));
    expect(call[1]).toEqual(["src/a.ts"]);
  });

  it("searchReplaceEdit's create:true path (no existing mode to preserve) also calls invalidateCachedWorkspaceFiles", async () => {
    const ws = mkWorkspace();
    fs.mkdirSync(ws, { recursive: true });

    const result = await searchReplaceEdit(
      { path: "src/brand-new.ts", search: "", replace: "export function fresh() {}\n", allow_create: true },
      ws,
      true,
    );
    expect(result.ok).toBe(true);

    expect(invalidateSpy).toHaveBeenCalled();
    const call = invalidateSpy.mock.calls.at(-1)!;
    expect(call[1]).toEqual(["src/brand-new.ts"]);
  });

  it("applyEditsMulti calls invalidateCachedWorkspaceFiles once per touched file on a successful batch", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "export function a() { return 1; }\n");
    writeFile(ws, "src/b.ts", "export function b() { return 1; }\n");

    const result = await applyEditsMulti(
      {
        edits: [
          { path: "src/a.ts", search: "a()", replace: "aRenamed()" },
          { path: "src/b.ts", search: "b()", replace: "bRenamed()" },
        ],
      },
      ws,
      true,
      SESSION,
    );
    expect(result.ok).toBe(true);

    const touchedRelPaths = invalidateSpy.mock.calls.map((c) => (c[1] as string[])[0]).sort();
    expect(touchedRelPaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("createFile calls invalidateCachedWorkspaceFiles(workspace, [path]) on a successful create", async () => {
    const ws = mkWorkspace();
    fs.mkdirSync(ws, { recursive: true });

    const result = await createFile({ path: "src/new.ts", content: "export function n() {}\n" }, ws, true, SESSION);
    expect(result.ok).toBe(true);

    expect(invalidateSpy).toHaveBeenCalled();
    const call = invalidateSpy.mock.calls.at(-1)!;
    expect(call[1]).toEqual(["src/new.ts"]);
  });

  it("renameSymbol calls invalidateCachedWorkspaceFiles for every rewritten file", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/c.ts", "export function widgetHelper() { return widgetHelper; }\n");

    const result = await renameSymbol({ from: "widgetHelper", to: "gadgetHelper" }, ws, true, SESSION);
    expect(result.ok).toBe(true);

    const touchedRelPaths = invalidateSpy.mock.calls.map((c) => (c[1] as string[])[0]);
    expect(touchedRelPaths).toContain("src/c.ts");
  });

  it("a failed edit (write-disabled) never calls invalidateCachedWorkspaceFiles", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "export function x() {}\n");

    const result = await searchReplaceEdit({ path: "src/a.ts", search: "x", replace: "y" }, ws, false);
    expect(result.ok).toBe(false);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
