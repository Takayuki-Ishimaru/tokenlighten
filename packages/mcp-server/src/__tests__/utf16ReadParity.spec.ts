// utf16ReadParity.spec.ts — T1 (v0.13 review-fix wave): UTF-16 read parity.
//
// CONTEXT: findEncoding.spec.ts (2026-08-27, field-eval wave) already pins
// BOM-aware decoding for the search_files find/references path
// (findText.ts's readLinesCached -> util/textDecode.ts's decodeTextBuffer).
// A C-4 rehearsal run found that the SAME BOM-awareness was missing from the
// general read_file path (util/safePath.ts's readFileSafe and
// tools/readCodeSmallFile.ts's buildSmallFile both did an unconditional
// buf.toString("utf8")) — so a UTF-16LE/BE-BOM file read via read_file
// (path or handle) came back mis-decoded/mojibake, while the SAME file read
// via search_files find matched its content correctly. "Read the same file
// via any path, get the same content" (the FE evaluation's UTF-16 3-path
// scenario) did not hold.
//
// This suite pins the fix: read_file (path AND handle) and search_files find
// now decode a UTF-16LE/BE-BOM file THE SAME WAY (both call the ONE shared
// util/textDecode.ts decodeTextBuffer — no second decoder), and plain UTF-8
// (no BOM) content is byte-for-byte unaffected.

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { resetAll as resetAllSessions } from "../util/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

/** Dispatch-based tests (callTool) need a cwd checkCwdOrRefuse accepts — same HOME-rooted convention findEncoding.spec.ts / pi01HostCap.spec.ts use. */
function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-utf16parity-${tag}-`)));
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

/** UTF-16LE bytes with an FF FE BOM — same construction as findEncoding.spec.ts's utf16leWithBom. */
function utf16leWithBom(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
}

/** UTF-16BE bytes with an FE FF BOM — byte-swapped from Node's native LE encoder (no native BE encoding exists); same construction as findEncoding.spec.ts's utf16beWithBom. */
function utf16beWithBom(content: string): Buffer {
  const be = Buffer.from(content, "utf16le");
  be.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
}

afterAll(() => {
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

type Body = Record<string, unknown>;

async function call(tool: string, args: Record<string, unknown>): Promise<Body> {
  const result = await callTool(tool, args);
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  return JSON.parse(text) as Body;
}

/** First evidence[].body from a read.text response (mode=full/auto small-file serve). */
function firstBody(readResponse: Body): string {
  expect(readResponse["kind"], JSON.stringify(readResponse).slice(0, 300)).toBe("read.text");
  const evidence = readResponse["evidence"] as Array<Record<string, unknown>> | undefined;
  expect(evidence, JSON.stringify(readResponse).slice(0, 300)).toBeDefined();
  expect(evidence!.length).toBeGreaterThan(0);
  const body = evidence![0]!["body"];
  expect(typeof body).toBe("string");
  return body as string;
}

function firstHandle(readResponse: Body): string {
  const evidence = readResponse["evidence"] as Array<Record<string, unknown>>;
  const handle = evidence[0]!["handle"];
  expect(typeof handle).toBe("string");
  return handle as string;
}

/** entries[0].content from a read.batch response (mode=full with a `paths`/`handles` ARRAY input). */
function firstBatchContent(readResponse: Body): string {
  expect(readResponse["kind"], JSON.stringify(readResponse).slice(0, 300)).toBe("read.batch");
  const entries = readResponse["entries"] as Array<Record<string, unknown>> | undefined;
  expect(entries, JSON.stringify(readResponse).slice(0, 300)).toBeDefined();
  expect(entries!.length).toBeGreaterThan(0);
  const content = entries![0]!["content"];
  expect(typeof content).toBe("string");
  return content as string;
}

/** evidence[0].body from a read.task_pack response. */
function firstPackBody(readResponse: Body): string {
  expect(readResponse["kind"], JSON.stringify(readResponse).slice(0, 300)).toBe("read.task_pack");
  const evidence = readResponse["evidence"] as Array<Record<string, unknown>> | undefined;
  expect(evidence, JSON.stringify(readResponse).slice(0, 300)).toBeDefined();
  expect(evidence!.length).toBeGreaterThan(0);
  const body = evidence![0]!["body"];
  expect(typeof body).toBe("string");
  return body as string;
}

// ---------------------------------------------------------------------------
// T1b (v0.13, UTF-16 3-way read-parity wave): the SPECIFIC 3-way claim named
// by run_release_rehearsal.mjs's own utf16 scenario -- read_file path,
// read_file mode=task_pack, and read_file mode=full handles=[handle] (the
// PLURAL batch form) must all decode and serve a UTF-16 BOM file's content
// byte-for-byte identically, including its trailing newline.
//
// This is a DIFFERENT 3-way claim than the path/handle(singular)/find suite
// below: that trio already routed through buildFullServePayload (or the
// equivalent) and already agreed. The rehearsal's own utf16 scenario instead
// compares path / task_pack / handles=[...] (PLURAL), which found a real,
// live mismatch this suite did not cover: a bare-file handle resolved
// through the PLURAL handles=[...] batch path (server.ts) takes a different
// route than a singular handle= read (isSynthesizedFileRange ->
// resolveSlice's generic range-reconstruction, not buildFullServePayload),
// and task_pack's own evidence slicing (readCodeTaskPack.ts's sliceCode) is
// a THIRD, independent reconstruction -- both silently dropped the file's
// trailing newline when the served range exactly reached EOF (see
// util/countLines.ts's sliceLinesToText doc comment for the mechanism).
// Live-measured before the fix (2026-08-28): path served "...}\n" (55
// chars, CRLF-source PowerShell fixture matching the rehearsal's own) while
// task_pack and handles=[...] both served "...}" (54 chars, no trailing
// newline) -- three_way_consistent:false.
// ---------------------------------------------------------------------------

describe("UTF-16 3-way parity: read_file path / mode=task_pack / mode=full handles=[...]", () => {
  it("UTF-16LE (BOM): path, task_pack, and handles=[...] all serve identical, trailing-newline-terminated content", async () => {
    const ws = mkWorkspace("le3way-pack");
    const marker = "REHEARSAL_UTF16_3WAY_LE";
    // CRLF source ending in a trailing newline -- mirrors
    // run_release_rehearsal.mjs's own utf16Scenario fixture, the exact shape
    // that exposed the defect (a whole-file range landing precisely on EOF).
    const content = `function invokeMarker {\r\n  # ${marker}\r\n}\r\n`;
    writeBytes(ws, "utf16-fixture.ps1", utf16leWithBom(content));

    const pathRes = await call("read_file", { cwd: ws, mode: "full", paths: ["utf16-fixture.ps1"] });
    const pathContent = firstBatchContent(pathRes);
    expect(pathContent).toContain(marker);
    expect(pathContent.endsWith("\n")).toBe(true);
    const handle = (pathRes["entries"] as Array<Record<string, unknown>>)[0]!["handle"];
    expect(typeof handle).toBe("string");

    const packRes = await call("read_file", {
      cwd: ws,
      mode: "task_pack",
      query: "read the full contents of this file",
      paths: ["utf16-fixture.ps1"],
    });
    const packContent = firstPackBody(packRes);

    const handlesRes = await call("read_file", { cwd: ws, mode: "full", handles: [handle] });
    const handlesContent = firstBatchContent(handlesRes);

    expect(packContent, "task_pack evidence body must byte-match the path-read content, including the trailing newline").toBe(pathContent);
    expect(handlesContent, "handles=[...] batch content must byte-match the path-read content, including the trailing newline").toBe(pathContent);
  });

  it("UTF-16BE (BOM): path, task_pack, and handles=[...] all serve identical, trailing-newline-terminated content", async () => {
    const ws = mkWorkspace("be3way-pack");
    const marker = "REHEARSAL_UTF16_3WAY_BE";
    const content = `function invokeMarker {\r\n  # ${marker}\r\n}\r\n`;
    writeBytes(ws, "utf16-fixture.ps1", utf16beWithBom(content));

    const pathRes = await call("read_file", { cwd: ws, mode: "full", paths: ["utf16-fixture.ps1"] });
    const pathContent = firstBatchContent(pathRes);
    expect(pathContent).toContain(marker);
    expect(pathContent.endsWith("\n")).toBe(true);
    const handle = (pathRes["entries"] as Array<Record<string, unknown>>)[0]!["handle"];
    expect(typeof handle).toBe("string");

    const packRes = await call("read_file", {
      cwd: ws,
      mode: "task_pack",
      query: "read the full contents of this file",
      paths: ["utf16-fixture.ps1"],
    });
    const packContent = firstPackBody(packRes);

    const handlesRes = await call("read_file", { cwd: ws, mode: "full", handles: [handle] });
    const handlesContent = firstBatchContent(handlesRes);

    expect(packContent, "task_pack evidence body must byte-match the path-read content, including the trailing newline").toBe(pathContent);
    expect(handlesContent, "handles=[...] batch content must byte-match the path-read content, including the trailing newline").toBe(pathContent);
  });
});

// ---------------------------------------------------------------------------
// UTF-16LE (BOM) — the full 3-path parity claim, with Japanese content.
// ---------------------------------------------------------------------------

describe("UTF-16LE (BOM) read parity across read_file path / read_file handle / search_files find", () => {
  it("all three paths decode the same Japanese content, with no mojibake and no leaked BOM character", async () => {
    const ws = mkWorkspace("le3way");
    const content = 'export const greeting = "こんにちは世界"; // UTF-16 read parity fixture\n';
    writeBytes(ws, "src/greeting.ts", utf16leWithBom(content));

    // (i) read_file, path-addressed, mode=full.
    const pathRes = await call("read_file", { cwd: ws, mode: "full", path: "src/greeting.ts" });
    const pathBody = firstBody(pathRes);
    expect(pathBody).toContain("こんにちは世界");
    expect(pathBody).not.toContain("�"); // no undecodable-replacement-char mojibake
    expect(pathBody.charCodeAt(0)).not.toBe(0xfeff); // BOM stripped, not leaked as a leading char
    expect(pathBody.includes(String.fromCharCode(0))).toBe(false); // not raw UTF-16 bytes misread as UTF-8 (NUL-interleaved)
    // (ii) read_file, handle-addressed (the handle minted by the path read above).
    const handle = firstHandle(pathRes);
    const handleRes = await call("read_file", { cwd: ws, mode: "full", handle });
    const handleBody = firstBody(handleRes);
    expect(handleBody).toBe(pathBody); // byte-identical decode via the handle path

    // (iii) search_files find, for the Japanese substring itself.
    const findRes = await call("search_files", { action: "find", query: "こんにちは世界", cwd: ws });
    expect(findRes["kind"], JSON.stringify(findRes).slice(0, 300)).toBe("search.matches");
    const matches = findRes["matches"] as Body;
    expect(matches["absence"], JSON.stringify(matches).slice(0, 300)).toBeUndefined();
    const files = matches["files"] as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]!["path"]).toBe("src/greeting.ts");
    const snippets = files[0]!["snippets"] as string[];
    expect(snippets.some((s) => s.includes("こんにちは世界"))).toBe(true);
  });

  it("auto mode decodes the same tiny UTF-16LE (BOM) file identically to mode=full", async () => {
    const ws = mkWorkspace("le-auto");
    const content = 'export const greeting = "こんにちは世界";\n';
    writeBytes(ws, "src/greeting.ts", utf16leWithBom(content));

    const fullRes = await call("read_file", { cwd: ws, mode: "full", path: "src/greeting.ts" });
    const fullBody = firstBody(fullRes);

    const wsAuto = mkWorkspace("le-auto2");
    writeBytes(wsAuto, "src/greeting.ts", utf16leWithBom(content));
    const autoRes = await call("read_file", { cwd: wsAuto, path: "src/greeting.ts" }); // mode omitted -> auto
    const autoBody = firstBody(autoRes);

    expect(autoBody).toBe(fullBody);
  });
});

// ---------------------------------------------------------------------------
// UTF-16BE (BOM) — one case, per the wave instruction.
// ---------------------------------------------------------------------------

describe("UTF-16BE (BOM) read parity", () => {
  it("read_file path, read_file handle, and search_files find all decode the same Japanese content", async () => {
    const ws = mkWorkspace("be3way");
    const content = 'export const farewell = "さようなら"; // UTF-16BE read parity fixture\n';
    writeBytes(ws, "src/farewell.ts", utf16beWithBom(content));

    const pathRes = await call("read_file", { cwd: ws, mode: "full", path: "src/farewell.ts" });
    const pathBody = firstBody(pathRes);
    expect(pathBody).toContain("さようなら");
    expect(pathBody).not.toContain("�");
    expect(pathBody.charCodeAt(0)).not.toBe(0xfeff);

    const handle = firstHandle(pathRes);
    const handleRes = await call("read_file", { cwd: ws, mode: "full", handle });
    expect(firstBody(handleRes)).toBe(pathBody);

    const findRes = await call("search_files", { action: "find", query: "さようなら", cwd: ws });
    expect(findRes["kind"]).toBe("search.matches");
    const matches = findRes["matches"] as Body;
    expect(matches["absence"]).toBeUndefined();
    const files = matches["files"] as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]!["path"]).toBe("src/farewell.ts");
  });
});

// ---------------------------------------------------------------------------
// UTF-8 (no BOM) — existing behavior must be unchanged by the fix.
// ---------------------------------------------------------------------------

describe("UTF-8 (no BOM) read behavior is unchanged", () => {
  it("read_file path, read_file handle, and search_files find still decode plain UTF-8 (with Japanese content) identically", async () => {
    const ws = mkWorkspace("utf8plain");
    const content = 'export const greeting = "こんにちは世界"; // plain UTF-8, no BOM\n';
    writeUtf8(ws, "src/greeting.ts", content);

    const pathRes = await call("read_file", { cwd: ws, mode: "full", path: "src/greeting.ts" });
    const pathBody = firstBody(pathRes);
    expect(pathBody).toContain("こんにちは世界");

    const handle = firstHandle(pathRes);
    const handleRes = await call("read_file", { cwd: ws, mode: "full", handle });
    expect(firstBody(handleRes)).toBe(pathBody);

    const findRes = await call("search_files", { action: "find", query: "こんにちは世界", cwd: ws });
    expect(findRes["kind"]).toBe("search.matches");
    const matches = findRes["matches"] as Body;
    expect(matches["absence"]).toBeUndefined();
    const files = matches["files"] as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]!["path"]).toBe("src/greeting.ts");
  });

  it("a plain ASCII UTF-8 file (no BOM, no Japanese) round-trips byte-for-byte through read_file path and handle", async () => {
    const ws = mkWorkspace("utf8ascii");
    const content = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    writeUtf8(ws, "src/add.ts", content);

    const pathRes = await call("read_file", { cwd: ws, mode: "full", path: "src/add.ts" });
    const pathBody = firstBody(pathRes);
    expect(pathBody.replace(/\n+$/, "")).toBe(content.replace(/\n+$/, ""));

    const handle = firstHandle(pathRes);
    const handleRes = await call("read_file", { cwd: ws, mode: "full", handle });
    expect(firstBody(handleRes)).toBe(pathBody);
  });
});
