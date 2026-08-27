// writeEncodingGuard.spec.ts — write-path fail-closed encoding guard
// (v0.12.0, 2026-08-27).
//
// CONTEXT: every write-path tool used to read its target file via
// fs.readFileSync(path, "utf8") unconditionally, exactly like findText.ts's
// original readLinesCached defect. For a READ this just misses matches; for
// a WRITE it is worse — a UTF-16 file's bytes decode into invalid UTF-8
// sequences that Node's decoder lossily replaces with U+FFFD (REPLACEMENT
// CHARACTER), and writing that string back as UTF-8 PERMANENTLY CORRUPTS
// the file (the substitution cannot be mapped back to the original bytes).
// Full UTF-16 round-trip editing is explicitly out of scope for this
// release: refusal (code "unsupported-encoding") is the correct behavior.
//
// Every guarded entry is exercised against BOTH:
//   (a) a UTF-16LE-BOM file (the util/textDecode.ts "utf16le" risk tag)
//   (b) a BOM-less NUL-probe file — a UTF-16LE file saved WITHOUT a BOM,
//       the exact real-world shape from the read-side defect report (a
//       PowerShell .ps1 saved as UTF-16LE, the common Windows default)
// asserting refusal AND that the file's on-disk bytes are byte-for-byte
// UNCHANGED (the corruption-prevention floor this guard exists for).

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { replaceRangeContent, replaceAllInRange } from "../write/rangeEdit.js";
import { searchReplaceEdit } from "../tools/searchReplaceEdit.js";
import { applyEditsMulti } from "../tools/applyEditsMulti.js";
import { readAndEdit } from "../tools/readAndEdit.js";
import { renameSymbol } from "../tools/renameSymbol.js";
import { writeExistingFileAtomic, AtomicWriteError } from "../write/atomicWrite.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";

const tmpDirs: string[] = [];

function mkWorkspace(): GuardedWorkspaceRoot {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-weg-test-"));
  tmpDirs.push(dir);
  return unsafeGuardedWorkspaceRootForTests(dir);
}

function writeBytes(workspace: string, rel: string, bytes: Buffer): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function readBytes(workspace: string, rel: string): Buffer {
  return fs.readFileSync(path.join(workspace, rel));
}

/** UTF-16LE bytes with an FF FE BOM. */
function utf16leWithBom(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
}

/** UTF-16LE bytes with NO BOM — the no-BOM NUL-probe-failure shape. */
function utf16leNoBom(content: string): Buffer {
  return Buffer.from(content, "utf16le");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

const SESSION = "test-session";
const SCRIPT_TEXT = "function invokeNetUse {\r\n    net use $args[0]\r\n}\r\n";

// ---------------------------------------------------------------------------
// rangeEdit.ts — replaceRangeContent / replaceAllInRange
// ---------------------------------------------------------------------------

describe("write-path encoding guard — rangeEdit.replaceRangeContent", () => {
  it("refuses a UTF-16LE-BOM file with code 'unsupported-encoding', bytes unchanged", () => {
    const ws = mkWorkspace();
    const original = utf16leWithBom(SCRIPT_TEXT);
    writeBytes(ws, "deploy.ps1", original);

    const result = replaceRangeContent({ path: "deploy.ps1", range: "1-1", content: "x\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "deploy.ps1").equals(original)).toBe(true);
  });

  it("refuses a BOM-less NUL-probe (UTF-16LE-without-BOM) file, bytes unchanged", () => {
    const ws = mkWorkspace();
    const original = utf16leNoBom(SCRIPT_TEXT);
    writeBytes(ws, "legacy.ps1", original);

    const result = replaceRangeContent({ path: "legacy.ps1", range: "1-1", content: "x\n" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "legacy.ps1").equals(original)).toBe(true);
  });
});

describe("write-path encoding guard — rangeEdit.replaceAllInRange", () => {
  it("refuses a UTF-16LE-BOM file with code 'unsupported-encoding', bytes unchanged", () => {
    const ws = mkWorkspace();
    const original = utf16leWithBom(SCRIPT_TEXT);
    writeBytes(ws, "deploy.ps1", original);

    const result = replaceAllInRange({ path: "deploy.ps1", range: "1-1", search: "invokeNetUse", replace: "x" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "deploy.ps1").equals(original)).toBe(true);
  });

  it("refuses a BOM-less NUL-probe file, bytes unchanged", () => {
    const ws = mkWorkspace();
    const original = utf16leNoBom(SCRIPT_TEXT);
    writeBytes(ws, "legacy.ps1", original);

    const result = replaceAllInRange({ path: "legacy.ps1", range: "1-1", search: "invokeNetUse", replace: "x" }, ws, true, SESSION);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "legacy.ps1").equals(original)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// searchReplaceEdit.ts
// ---------------------------------------------------------------------------

describe("write-path encoding guard — searchReplaceEdit", () => {
  it("refuses a UTF-16LE-BOM file, bytes unchanged", async () => {
    const ws = mkWorkspace();
    const original = utf16leWithBom(SCRIPT_TEXT);
    writeBytes(ws, "deploy.ps1", original);

    const result = await searchReplaceEdit({ path: "deploy.ps1", search: "invokeNetUse", replace: "x" }, ws, true);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "deploy.ps1").equals(original)).toBe(true);
  });

  it("refuses a BOM-less NUL-probe file, bytes unchanged", async () => {
    const ws = mkWorkspace();
    const original = utf16leNoBom(SCRIPT_TEXT);
    writeBytes(ws, "legacy.ps1", original);

    const result = await searchReplaceEdit({ path: "legacy.ps1", search: "invokeNetUse", replace: "x" }, ws, true);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "legacy.ps1").equals(original)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyEditsMulti.ts — Phase 1 validation must refuse BEFORE any write, and
// (all-or-nothing) leave every OTHER file in the batch untouched too.
// ---------------------------------------------------------------------------

describe("write-path encoding guard — applyEditsMulti", () => {
  it("refuses a batch containing a UTF-16LE-BOM entry; no file in the batch is written", async () => {
    const ws = mkWorkspace();
    const badOriginal = utf16leWithBom(SCRIPT_TEXT);
    writeBytes(ws, "deploy.ps1", badOriginal);
    fs.writeFileSync(path.join(ws, "clean.ts"), 'export const a = "old";\n', "utf8");

    const result = await applyEditsMulti(
      { edits: [{ path: "clean.ts", search: '"old"', replace: '"new"' }, { path: "deploy.ps1", search: "invokeNetUse", replace: "x" }] },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "deploy.ps1").equals(badOriginal)).toBe(true);
    expect(fs.readFileSync(path.join(ws, "clean.ts"), "utf8")).toBe('export const a = "old";\n');
  });

  it("refuses a batch containing a BOM-less NUL-probe entry; no file in the batch is written", async () => {
    const ws = mkWorkspace();
    const badOriginal = utf16leNoBom(SCRIPT_TEXT);
    writeBytes(ws, "legacy.ps1", badOriginal);
    fs.writeFileSync(path.join(ws, "clean.ts"), 'export const a = "old";\n', "utf8");

    const result = await applyEditsMulti(
      { edits: [{ path: "clean.ts", search: '"old"', replace: '"new"' }, { path: "legacy.ps1", search: "invokeNetUse", replace: "x" }] },
      ws,
      true,
      SESSION,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "legacy.ps1").equals(badOriginal)).toBe(true);
    expect(fs.readFileSync(path.join(ws, "clean.ts"), "utf8")).toBe('export const a = "old";\n');
  });
});

// ---------------------------------------------------------------------------
// readAndEdit.ts
// ---------------------------------------------------------------------------

describe("write-path encoding guard — readAndEdit", () => {
  it("refuses a UTF-16LE-BOM file, bytes unchanged", async () => {
    const ws = mkWorkspace();
    const original = utf16leWithBom(SCRIPT_TEXT);
    writeBytes(ws, "deploy.ps1", original);

    const result = await readAndEdit({ path: "deploy.ps1", symbol: "invokeNetUse", search: "net use", replace: "x" }, ws, true);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "deploy.ps1").equals(original)).toBe(true);
  });

  it("refuses a BOM-less NUL-probe file, bytes unchanged", async () => {
    const ws = mkWorkspace();
    const original = utf16leNoBom(SCRIPT_TEXT);
    writeBytes(ws, "legacy.ps1", original);

    const result = await readAndEdit({ path: "legacy.ps1", symbol: "invokeNetUse", search: "net use", replace: "x" }, ws, true);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported-encoding");
    expect(readBytes(ws, "legacy.ps1").equals(original)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renameSymbol.ts — per-file skip (disclosed), not a whole-call refusal: a
// workspace-wide rename must still succeed everywhere else.
// ---------------------------------------------------------------------------

describe("write-path encoding guard — renameSymbol", () => {
  // .ts (not .ps1): renameSymbol's discovery walk uses walkCodeFiles's
  // DEFAULT tracked-extension set (no extraExts widening, unlike
  // findText.ts's FIND_ACTION_EXTRA_EXTS) — a .ts fixture keeps this test
  // about the encoding guard, not about which extensions that walk covers.
  it("skips a UTF-16LE-BOM file (disclosed, reason 'unsupported-encoding'), bytes unchanged, other files still renamed", async () => {
    const ws = mkWorkspace();
    const original = utf16leWithBom("const findById = 1;\r\n");
    writeBytes(ws, "legacy.ts", original);
    fs.writeFileSync(path.join(ws, "a.ts"), "const r = findById(1);\n", "utf8");

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toContainEqual({ path: "legacy.ts", reason: "unsupported-encoding" });
    expect(readBytes(ws, "legacy.ts").equals(original)).toBe(true);
    expect(fs.readFileSync(path.join(ws, "a.ts"), "utf8")).toBe("const r = getById(1);\n");
  });

  it("skips a BOM-less NUL-probe file the same way", async () => {
    const ws = mkWorkspace();
    const original = utf16leNoBom("const findById = 1;\r\n");
    writeBytes(ws, "legacy.ts", original);
    fs.writeFileSync(path.join(ws, "a.ts"), "const r = findById(1);\n", "utf8");

    const result = await renameSymbol({ from: "findById", to: "getById" }, ws, true, SESSION);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skipped).toContainEqual({ path: "legacy.ts", reason: "unsupported-encoding" });
    expect(readBytes(ws, "legacy.ts").equals(original)).toBe(true);
    expect(fs.readFileSync(path.join(ws, "a.ts"), "utf8")).toBe("const r = getById(1);\n");
  });
});

// ---------------------------------------------------------------------------
// atomicWrite.ts — last-resort backstop. Every production caller above is
// already guarded at its OWN read point, so this only fires for a caller
// (present or future) that reaches writeExistingFileAtomic without one.
// Exercised directly since no production caller can reach it with NUL
// content anymore — this pins the backstop itself, not an integration path.
// ---------------------------------------------------------------------------

describe("write-path encoding guard — atomicWrite backstop", () => {
  it("throws AtomicWriteError and does not create/modify the target when content contains a raw NUL character", () => {
    const ws = mkWorkspace();
    const abs = path.join(ws, "target.txt");
    fs.writeFileSync(abs, "original\n", "utf8");

    const corrupted = "line one\n" + String.fromCharCode(0) + "line two\n";

    expect(() => writeExistingFileAtomic(abs, corrupted, undefined)).toThrow(AtomicWriteError);
    expect(fs.readFileSync(abs, "utf8")).toBe("original\n");
    // No stray temp file left behind (makeTmpPath's cleanup-on-throw path).
    const siblings = fs.readdirSync(ws);
    expect(siblings).toEqual(["target.txt"]);
  });
});
