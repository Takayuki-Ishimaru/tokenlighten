/**
 * exploreOffice.spec.ts — S1/C3: search_files action=office no longer
 * dead-ends with toolError("action=office was removed..."). It now extracts
 * office text directly (the same primitive read_file's office paths use:
 * readBytesSafe + extractOfficeText), so no doc path ends in a hard error.
 *
 * `action=office` stays a compat-only redirect: it is NOT added to the
 * advertised search_files action enum (schemaSize.spec.ts pins
 * ["find","symbols","references","diff","locate","tree"] unchanged).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { callTool, advertisedTools } from "../server.js";
import { resetAll } from "../util/session.js";
import { handleTable } from "../util/handles.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-exploreoffice-${tag}-`)));
  dirs.push(d);
  return d;
}

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

type JSZipFull = {
  file(name: string, data: string): void;
  generateAsync(opts: { type: "nodebuffer" }): Promise<Buffer>;
};

async function buildMinimalDocx(): Promise<Buffer> {
  const JSZipCtor = (await import("jszip")) as unknown as { default: new () => JSZipFull };
  const zip: JSZipFull = new JSZipCtor.default();

  const contentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Office Redirect Test</w:t></w:r></w:p>
<w:p><w:r><w:t>This document verifies explore action=office extracts real text.</w:t></w:r></w:p>
</w:body></w:document>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const wordRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  zip.file("_rels/.rels", relsXml);
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("word/document.xml", contentXml);
  zip.file("word/_rels/document.xml.rels", wordRelsXml);

  return zip.generateAsync({ type: "nodebuffer" });
}

describe("explore action=office — S1/C3 redirect (no more dead-end error)", () => {
  beforeEach(() => { resetAll(); handleTable.reset(); });
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("extracts real docx text instead of returning an error", async () => {
    const ws = mkWs("docx");
    const buf = await buildMinimalDocx();
    fs.writeFileSync(path.join(ws, "report.docx"), buf);

    const res = await callTool("search_files", { action: "office", path: "report.docx", cwd: ws });
    const body = parse(res);

    // Not an error result.
    expect(body["ok"]).not.toBe(false);
    expect(body["error"]).toBeUndefined();
    // Real extracted text, not the old dead-end message.
    const text = JSON.stringify(body);
    expect(text).not.toContain("action=office was removed");
    expect(text).toContain("Office Redirect Test");
  });

  it("missing path still returns a clean error (not a crash)", async () => {
    const ws = mkWs("nopath");
    const res = await callTool("search_files", { action: "office", cwd: ws });
    const body = parse(res);
    expect(body["kind"]).toBe("refusal");
  });

  it("action=office is NOT in the advertised explore action enum (compat redirect only)", async () => {
    const tools = advertisedTools() as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
    const exploreTool = tools.find((t) => t.name === "search_files");
    expect(exploreTool).toBeDefined();
    const actionProp = exploreTool?.inputSchema?.properties?.["action"] as { enum?: string[] } | undefined;
    expect(actionProp?.enum).toEqual(["find", "references", "diff", "tree"]);
    expect(actionProp?.enum).not.toContain("office");
  });
});

// D11: the "extract_office_text deprecated alias — description points at
// read_file (S1/C3b)" suite that stood here is DELETED with the alias. It
// source-inspected server.ts for the alias's `description:` string, because a
// hidden tool's schema had no wire path to assert against. There is no such
// schema now — the alias entry is gone — and its absence is pinned where it
// belongs: schemaSize.spec.ts (not advertised) and legacyAliasGating.spec.ts
// (not callable, under any env).
