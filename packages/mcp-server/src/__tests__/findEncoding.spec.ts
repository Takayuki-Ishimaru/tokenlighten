// findEncoding.spec.ts — BOM-aware decoding + no-BOM corruption guard for
// findText.ts's readLinesCached (the sole content-decode choke point behind
// scanLiteral, which every `find`/`queries[]` consumer shares).
//
// CONTEXT (2026-08-27, pre-release field-eval wave): readLinesCached used to
// call fs.readFileSync(absPath, "utf8") unconditionally — no BOM sniffing, no
// UTF-16 detection. A PowerShell .ps1 saved as UTF-16LE (a common Windows
// default) decodes into NUL-interleaved garbage under a blind UTF-8 read: a
// literal ASCII identifier inside it could never match, while the file was
// STILL counted into coverage.scanned — and a subsequent 0-match response
// could certify "absence is authoritative over every scanned file" (see
// buildAbsenceExtra's ABSENCE_NOTE). That is a false absence proof: grep or
// an editor's search would hit the token instantly. This suite pins the fix:
//   1. BOM-aware decoding for UTF-16LE / UTF-16BE / UTF-8-with-BOM.
//   2. A no-BOM NUL-corruption guard that keeps an undecodable file OUT of
//      coverage.scanned (and out of any absence certificate's authoritative
//      claim — mirrors the existing oversize/unreadable_dirs floor).
//   3. The same weakening on a per-term `queries[]` term_results entry.
//   4. Byte-identical behavior for ordinary UTF-8 content (no BOM, no NUL).

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildFindResponse,
  scanLiteral,
  createScanCoverage,
  FIND_ACTION_EXTRA_EXTS,
} from "../tools/findText.js";
import { findReferences } from "../tools/findReferences.js";
import { callTool } from "../server.js";
import { resetAll as resetAllSessions } from "../util/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

/** Dispatch-based tests (callTool) need a cwd checkCwdOrRefuse accepts — same HOME-rooted convention pi04TermAbsence.spec.ts / searchFamily.spec.ts use. Direct buildFindResponse/scanLiteral calls don't strictly need it, but sharing one helper keeps this file simple. */
function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-findenc-${tag}-`)));
  tmpDirs.push(root);
  return root;
}

function writeUtf8(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function writeBytes(root: string, rel: string, bytes: Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

/** UTF-16LE bytes with an FF FE BOM. */
function utf16leWithBom(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
}

/** UTF-16BE bytes with an FE FF BOM — byte-swapped from Node's native LE encoder (no native BE encoding exists). */
function utf16beWithBom(content: string): Buffer {
  const be = Buffer.from(content, "utf16le");
  be.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}

/** UTF-8 bytes with an EF BB BF BOM. */
function utf8WithBom(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, "utf8")]);
}

afterAll(() => {
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

type Body = Record<string, unknown>;

/** Wire-level `search_files action=find query=...` call (single token). */
async function findQuery(root: string, query: string): Promise<Body> {
  const result = await callTool("search_files", { action: "find", query, cwd: root });
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  const body = JSON.parse(text) as Body;
  expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("search.matches");
  const matches = body["matches"] as Body | undefined;
  expect(matches, JSON.stringify(body).slice(0, 300)).toBeDefined();
  return matches!;
}

/** Wire-level `search_files action=find queries=[...]` call (OR-set). */
async function findQueries(root: string, queries: string[]): Promise<Body> {
  const result = await callTool("search_files", { action: "find", queries, cwd: root });
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  const body = JSON.parse(text) as Body;
  expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("search.matches");
  const matches = body["matches"] as Body | undefined;
  expect(matches, JSON.stringify(body).slice(0, 300)).toBeDefined();
  return matches!;
}

// ---------------------------------------------------------------------------
// 1-2: BOM-aware decoding — UTF-16LE / UTF-16BE
// ---------------------------------------------------------------------------

describe("readLinesCached — BOM-aware decoding", () => {
  it("finds a literal identifier inside a UTF-16LE (BOM) .ps1 file", () => {
    const ws = mkWorkspace("le");
    const script = "function invokeNetUse {\r\n    net use $args[0]\r\n}\r\n";
    writeBytes(ws, "deploy.ps1", utf16leWithBom(script));

    const response = buildFindResponse({ query: "invokeNetUse" }, ws);

    expect(response.total_matches).toBe(1);
    expect(response.files[0]?.path).toBe("deploy.ps1");
    expect(response.files[0]?.lines).toEqual([1]);
    expect(response.absence).toBeUndefined();
  });

  it("finds a literal identifier inside a UTF-16BE (BOM) .ps1 file", () => {
    const ws = mkWorkspace("be");
    const script = "function invokeNetUse {\r\n    net use $args[0]\r\n}\r\n";
    writeBytes(ws, "deploy-be.ps1", utf16beWithBom(script));

    const response = buildFindResponse({ query: "invokeNetUse" }, ws);

    expect(response.total_matches).toBe(1);
    expect(response.files[0]?.path).toBe("deploy-be.ps1");
    expect(response.files[0]?.lines).toEqual([1]);
  });

  it("end-to-end via search_files action=find: a UTF-16LE .ps1 matches through the full dispatch path", async () => {
    const ws = mkWorkspace("le-wire");
    writeBytes(ws, "scripts/setup.ps1", utf16leWithBom("function invokeNetUse {\r\n}\r\n"));

    const matches = await findQuery(ws, "invokeNetUse");

    expect(matches["total_matches"]).toBe(1);
    const files = matches["files"] as Body[];
    expect(files[0]?.["path"]).toBe("scripts/setup.ps1");
    expect(files[0]?.["lines"]).toEqual([1]);
    expect(matches["absence"]).toBeUndefined();
  });

  it("UTF-8-BOM file matches, and the BOM does not corrupt line 1's column data", () => {
    const ws = mkWorkspace("utf8bom");
    writeBytes(ws, "src/config.ts", utf8WithBom("export const parseBomConfig = 1;\n"));

    const response = buildFindResponse({ query: "parseBomConfig" }, ws);

    expect(response.total_matches).toBe(1);
    expect(response.files[0]?.lines).toEqual([1]);
    // A leftover BOM would show up as a stray leading U+FEFF glued onto the
    // trimmed snippet; assert the snippet is byte-for-byte the clean line.
    expect(response.files[0]?.snippets?.[0]).toBe("export const parseBomConfig = 1;");
  });
});

// ---------------------------------------------------------------------------
// 4: no-BOM corruption guard — must never certify a false absence
// ---------------------------------------------------------------------------

describe("readLinesCached — no-BOM NUL-corruption guard", () => {
  it("a UTF-16-without-BOM .ps1 is excluded from coverage.scanned and tracked as undecodable, not silently mis-decoded", () => {
    const ws = mkWorkspace("nobom-coverage");
    // The exact real-world shape the defect names: UTF-16LE content with NO
    // BOM — every ASCII-range code unit interleaves a raw NUL byte.
    writeBytes(ws, "legacy.ps1", Buffer.from("function invokeNetUse {\r\n}\r\n", "utf16le"));

    const coverage = createScanCoverage();
    const hits = scanLiteral("invokeNetUse", ws, { extraExts: FIND_ACTION_EXTRA_EXTS, coverage });

    expect(hits).toHaveLength(0);
    expect(coverage.scanned.has("legacy.ps1")).toBe(false);
    expect(coverage.undecodable.has("legacy.ps1")).toBe(true);
  });

  it("wire-level: a 0-match response over an undecodable file carries NO unqualified authoritative absence, and discloses the omission", async () => {
    const ws = mkWorkspace("nobom-wire");
    writeBytes(ws, "legacy.ps1", Buffer.from("function invokeNetUse {\r\n}\r\n", "utf16le"));

    const matches = await findQuery(ws, "invokeNetUse");

    expect(matches["total_matches"]).toBe(0);
    // THE core assertion: no certificate — not even a caveated one — may
    // claim "absence is authoritative over every scanned file" while an
    // undecodable file could be hiding the token. Mirrors the existing
    // oversize/unreadable_dirs floor in buildAbsenceExtra.
    expect(matches["absence"]).toBeUndefined();
    const omitted = matches["omitted"] as Body | undefined;
    expect(omitted, JSON.stringify(matches).slice(0, 300)).toBeDefined();
    expect(omitted?.["undecodable"]).toBe(1);
  });

  it("per-term weakening: queries[] reports the undecodable-shadowed term as 'unknown', never falsely 'absent'", async () => {
    const ws = mkWorkspace("nobom-perterm");
    writeUtf8(ws, "src/present.ts", "export const presentTermEncodingCase = 1;\n");
    // A UTF-16-without-BOM sibling that COULD contain the second term, but
    // cannot be verified — its certificate must withhold ("unknown"), never
    // claim "absent" (F-W2D-1's oversize precedent, extended here).
    writeBytes(ws, "legacy.ps1", Buffer.from("const absentTermEncodingCase = 1;\r\n", "utf16le"));

    const matches = await findQueries(ws, ["presentTermEncodingCase", "absentTermEncodingCase"]);

    expect(matches["total_matches"]).toBeGreaterThan(0);
    const termResults = matches["term_results"] as Body[] | undefined;
    expect(Array.isArray(termResults), JSON.stringify(matches).slice(0, 300)).toBe(true);
    const present = (termResults as Body[]).find((t) => t["original"] === "presentTermEncodingCase");
    expect(present?.["status"]).toBe("matched");
    const shadowed = (termResults as Body[]).find((t) => t["original"] === "absentTermEncodingCase");
    expect(shadowed, JSON.stringify(termResults)).toBeDefined();
    expect(shadowed!["status"]).toBe("unknown");
    expect(shadowed!["scope"]).toEqual({ completeness: "partial" });
  });
});

// ---------------------------------------------------------------------------
// 5: existing UTF-8 behavior — byte-identical, no regression
// ---------------------------------------------------------------------------

describe("readLinesCached — unchanged plain UTF-8 behavior", () => {
  it("a plain UTF-8 file with no BOM decodes and matches exactly as before", () => {
    const ws = mkWorkspace("plain-utf8");
    writeUtf8(ws, "src/plain.ts", "export function parsePlainUtf8() {\n  return 1;\n}\n");

    const hits = scanLiteral("parsePlainUtf8", ws, {});

    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("src/plain.ts");
    expect(hits[0]?.line).toBe(1);
  });

  it("a UTF-8 file with real non-ASCII content (no BOM, no NUL bytes) still matches — the NUL probe must not misfire on high-bit-set UTF-8 bytes", () => {
    const ws = mkWorkspace("i18n-utf8");
    writeUtf8(ws, "src/i18n.ts", "// コメント\nexport const parseI18nToken = 1;\n");

    const hits = scanLiteral("parseI18nToken", ws, {});

    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// findReferences.ts adoption (2026-08-27 follow-up wave): the same
// exclude-and-disclose pattern as find, applied to search_files
// action=references. A UTF-16-BOM file's call sites must be found; an
// undecodable file must be excluded from scanned_files and disclosed via
// omitted.undecodable, and the absence certificate must withhold (never
// falsely claim "no references exist") while one is in scope.
// ---------------------------------------------------------------------------

describe("findReferences — BOM-aware decoding", () => {
  // .ts (not .ps1): findReferences's discovery walk uses walkCodeFiles's
  // DEFAULT tracked-extension set (no extraExts widening, unlike
  // findText.ts's action=find, which passes FIND_ACTION_EXTRA_EXTS) — a .ts
  // fixture keeps this test about the encoding guard, not about which
  // extensions that walk covers.
  it("finds a call site inside a UTF-16LE-BOM file", async () => {
    const ws = mkWorkspace("refs-utf16le");
    writeBytes(ws, "deploy.ts", utf16leWithBom("invokeNetUse();\r\n"));

    const result = await findReferences({ symbol: "invokeNetUse" }, ws);

    expect(result.total).toBe(1);
    expect(result.files[0]?.path).toBe("deploy.ts");
    expect(result.files[0]?.lines).toEqual([1]);
    expect(result.absence).toBeUndefined();
  });
});

describe("findReferences — no-BOM NUL-corruption guard", () => {
  it("an undecodable file is excluded from scanned_files, disclosed via omitted.undecodable, and claims no false absence", async () => {
    const ws = mkWorkspace("refs-undecodable");
    // No other file in scope: every reference to this symbol, if any exist,
    // could only be hiding inside the undecodable file.
    writeBytes(ws, "legacy.ts", Buffer.from("invokeNetUse();\r\n", "utf16le"));

    const result = await findReferences({ symbol: "invokeNetUse" }, ws);

    expect(result.total).toBe(0);
    // THE core assertion: no certificate — not even a caveated one — may
    // claim "no scanned file references this symbol" while an undecodable
    // file could be hiding it. Mirrors findText.ts's buildAbsenceExtra
    // oversize/unreadable_dirs floor.
    expect(result.absence).toBeUndefined();
    expect(result.omitted?.undecodable).toBe(1);
  });

  it("a real reference in a decodable file is still reported even when a sibling undecodable file is in scope (completeness never claimed over the latter)", async () => {
    const ws = mkWorkspace("refs-mixed");
    fs.writeFileSync(path.join(ws, "a.ts"), "invokeNetUse();\n", "utf8");
    writeBytes(ws, "legacy.ts", Buffer.from("invokeNetUse();\r\n", "utf16le"));

    const result = await findReferences({ symbol: "invokeNetUse" }, ws);

    expect(result.total).toBe(1);
    expect(result.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(result.omitted?.undecodable).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// find inventory completeness (task 4, 2026-08-27 follow-up wave): a
// truncated, multi-file match response must not claim an unqualified
// "exhaustive (100% of matches)" inventory note when an undecodable file
// also sits in scope — the SAME gap the absence-certificate fix closed,
// applied to attachInventory's completeness note.
// ---------------------------------------------------------------------------

describe("find inventory completeness — undecodable files must not read as an unqualified 'exhaustive' claim", () => {
  it("a truncated, multi-file match response discloses the undecodable exclusion in its inventory note", () => {
    const ws = mkWorkspace("inventory-gap");
    // Enough matched files/lines to force files[] snippet truncation
    // (fitFilesToCap/MAX_RESPONSE_BYTES), while staying well under the
    // by-directory rollup thresholds (INVENTORY_ROLLUP_FILE_THRESHOLD/
    // INVENTORY_ROLLUP_BYTES_THRESHOLD) — this exercises the non-rollup
    // "note" branch specifically.
    for (let i = 0; i < 20; i++) {
      const lines = Array.from(
        { length: 10 },
        (_, j) => `export const inventoryGapToken${i}_${j} = "padding text to push this response past the byte cap reliably";`,
      ).join("\n");
      writeUtf8(ws, `file${i}.ts`, lines + "\n");
    }
    // In scope, undecodable — never actually content-scanned.
    writeBytes(ws, "legacy.ps1", Buffer.from("const inventoryGapToken = 1;\r\n", "utf16le"));

    const response = buildFindResponse({ query: "inventoryGapToken" }, ws);

    expect(response.truncated).toBe(true);
    expect(response.inventory_complete).toBeDefined();
    expect(response.omitted?.undecodable).toBe(1);
    // The plain "exhaustive (100% of matches)" note never mentions
    // `omitted`; the WITH_OMITTED variant does — the discriminator proves
    // the qualified branch fired instead of the unqualified one.
    expect(String(response.note ?? "")).toContain("omitted");
  });
});
