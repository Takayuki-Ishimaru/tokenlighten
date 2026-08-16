import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import JSZip from "jszip";
import {
  TextReader,
  TextWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareOfficeDocument, protectOfficeDocument } from "../office/decrypt.js";
import { editArtifact } from "../write/artifactEdit.js";
import { unsafeGuardedWorkspaceRootForTests, type GuardedWorkspaceRoot } from "../write/guardedWorkspace.js";
import { ZIP_LIMITS } from "../office/zipPreflight.js";

const pdfMockState = vi.hoisted(() => ({
  filled: undefined as Record<string, unknown> | undefined,
  flattened: false,
}));

vi.mock("@libpdf/core", () => ({
  PDF: {
    load: vi.fn(async (bytes: Uint8Array) => ({
      isEncrypted: false,
      isAuthenticated: true,
      getForm: () => ({
        fill: (fields: Record<string, unknown>) => {
          pdfMockState.filled = fields;
          return { filled: Object.keys(fields), skipped: [] };
        },
        flatten: () => { pdfMockState.flattened = true; },
      }),
      setProtection: () => undefined,
      save: async () => bytes,
    })),
  },
}));

async function excelModule() {
  type Workbook = {
    xlsx: {
      load(data: Buffer): Promise<void>;
      writeBuffer(): Promise<ArrayBuffer | Uint8Array>;
    };
    addWorksheet(name: string): { getCell(ref: string): { value: unknown } };
    getWorksheet(name: string): { getCell(ref: string): { value: unknown } } | undefined;
  };
  type Module = { Workbook: new () => Workbook };
  const imported = await import("exceljs");
  const candidate = imported as unknown as Module & { default?: Module };
  return candidate.Workbook ? candidate : candidate.default!;
}

describe("structured password-protected artifact edits", () => {
  let workspace: GuardedWorkspaceRoot;

  beforeEach(() => {
    workspace = unsafeGuardedWorkspaceRootForTests(fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-edit-")));
    pdfMockState.filled = undefined;
    pdfMockState.flattened = false;
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("edits an XLSX cell and rotates its password", async () => {
    const ExcelJs = await excelModule();
    const workbook = new ExcelJs.Workbook();
    workbook.addWorksheet("Data").getCell("B2").value = "before";
    const plain = new Uint8Array(await workbook.xlsx.writeBuffer());
    const protectedInput = await protectOfficeDocument(plain, "office-secret");
    expect(protectedInput.ok).toBe(true);
    if (!protectedInput.ok) return;
    fs.writeFileSync(path.join(workspace, "book.xlsx"), protectedInput.bytes);

    const result = await editArtifact({
      path: "book.xlsx",
      artifact: {
        kind: "xlsx",
        cells: [{ sheet: "Data", cell: "B2", value: "after" }],
      },
      credentialPassword: "office-secret",
      outputPassword: "rotated-secret",
      outputCredentialSupplied: true,
    }, workspace, true, "test-session");

    expect(result).toMatchObject({
      ok: true,
      kind: "xlsx",
      changes: 1,
      encrypted: true,
    });
    const output = fs.readFileSync(path.join(workspace, "book.xlsx"));
    const oldCredential = await prepareOfficeDocument(output, "office-secret");
    expect(oldCredential.ok).toBe(false);
    const prepared = await prepareOfficeDocument(output, "rotated-secret");
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const verified = new ExcelJs.Workbook();
    await verified.xlsx.load(Buffer.from(prepared.bytes));
    expect(verified.getWorksheet("Data")?.getCell("B2").value).toBe("after");
  });

  it("replaces DOCX text split across runs and preserves encryption", async () => {
    type TestZip = {
      file(name: string, content: string): unknown;
      file(name: string): { async(type: "string"): Promise<string> } | null;
      generateAsync(options: { type: "uint8array" }): Promise<Uint8Array>;
    };
    const packageZip = new JSZip() as unknown as TestZip;
    packageZip.file("[Content_Types].xml", "<Types/>");
    packageZip.file(
      "word/document.xml",
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p></w:body></w:document>',
    );
    const plain = await packageZip.generateAsync({ type: "uint8array" });
    const protectedInput = await protectOfficeDocument(plain, "office-secret");
    expect(protectedInput.ok).toBe(true);
    if (!protectedInput.ok) return;
    fs.writeFileSync(path.join(workspace, "letter.docx"), protectedInput.bytes);

    const result = await editArtifact({
      path: "letter.docx",
      artifact: {
        kind: "docx",
        replacements: [{ search: "Hello world", replace: "Updated" }],
      },
      credentialPassword: "office-secret",
      outputCredentialSupplied: false,
    }, workspace, true, "test-session");

    expect(result).toMatchObject({ ok: true, kind: "docx", changes: 1, encrypted: true });
    const prepared = await prepareOfficeDocument(
      fs.readFileSync(path.join(workspace, "letter.docx")),
      "office-secret",
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const verifiedZip = await JSZip.loadAsync(prepared.bytes) as unknown as TestZip;
    const xml = await verifiedZip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Updated");
    expect(xml).not.toContain("Hello ");
  });

  it("replaces PPTX text split across runs and preserves encryption", async () => {
    type TestZip = {
      file(name: string, content: string): unknown;
      file(name: string): { async(type: "string"): Promise<string> } | null;
      generateAsync(options: { type: "uint8array" }): Promise<Uint8Array>;
    };
    const packageZip = new JSZip() as unknown as TestZip;
    packageZip.file("[Content_Types].xml", "<Types/>");
    packageZip.file(
      "ppt/slides/slide1.xml",
      '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Quarter </a:t></a:r><a:r><a:t>One</a:t></a:r></a:p></p:sld>',
    );
    const plain = await packageZip.generateAsync({ type: "uint8array" });
    const protectedInput = await protectOfficeDocument(plain, "office-secret");
    expect(protectedInput.ok).toBe(true);
    if (!protectedInput.ok) return;
    fs.writeFileSync(path.join(workspace, "deck.pptx"), protectedInput.bytes);

    const result = await editArtifact({
      path: "deck.pptx",
      artifact: {
        kind: "pptx",
        replacements: [{ search: "Quarter One", replace: "Quarter Two" }],
      },
      credentialPassword: "office-secret",
      outputCredentialSupplied: false,
    }, workspace, true, "test-session");

    expect(result).toMatchObject({ ok: true, kind: "pptx", changes: 1, encrypted: true });
    const prepared = await prepareOfficeDocument(
      fs.readFileSync(path.join(workspace, "deck.pptx")),
      "office-secret",
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const verifiedZip = await JSZip.loadAsync(prepared.bytes) as unknown as TestZip;
    const xml = await verifiedZip.file("ppt/slides/slide1.xml")!.async("string");
    expect(xml).toContain("Quarter Two");
    expect(xml).not.toContain("Quarter One");
  });

  it("rebuilds an encrypted ZIP with replace and add operations", async () => {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("secret.txt", new TextReader("before"), {
      password: "zip-secret",
      encryptionStrength: 3,
    });
    const input = await writer.close();
    fs.writeFileSync(path.join(workspace, "bundle.zip"), input);

    const result = await editArtifact({
      path: "bundle.zip",
      artifact: {
        kind: "zip",
        members: [
          { action: "replace", member: "secret.txt", content: "after" },
          { action: "add", member: "new.txt", content: "new value" },
        ],
      },
      credentialPassword: "zip-secret",
      outputCredentialSupplied: false,
    }, workspace, true, "test-session");

    expect(result).toMatchObject({ ok: true, kind: "zip", changes: 2, encrypted: true });
    const reader = new ZipReader(new Uint8ArrayReader(fs.readFileSync(path.join(workspace, "bundle.zip"))));
    const entries = await reader.getEntries();
    const secret = entries.find((entry) => entry.filename === "secret.txt");
    const added = entries.find((entry) => entry.filename === "new.txt");
    expect(secret && !secret.directory && secret.getData
      ? await secret.getData(new TextWriter(), { password: "zip-secret" })
      : undefined).toBe("after");
    expect(added && !added.directory && added.getData
      ? await added.getData(new TextWriter(), { password: "zip-secret" })
      : undefined).toBe("new value");
    await reader.close();
  });

  it("fills PDF form fields through the encrypted-capable PDF writer", async () => {
    const pdfBytes = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
    fs.writeFileSync(path.join(workspace, "form.pdf"), pdfBytes);

    const result = await editArtifact({
      path: "form.pdf",
      artifact: {
        kind: "pdf",
        form: { name: "Ada", approved: true },
        flatten: true,
      },
      outputCredentialSupplied: false,
    }, workspace, true, "test-session");

    expect(result).toMatchObject({ ok: true, kind: "pdf", changes: 2 });
    expect(pdfMockState.filled).toEqual({ name: "Ada", approved: true });
    expect(pdfMockState.flattened).toBe(true);
  });

  it("refuses writes when --allow-write is not enabled", async () => {
    const result = await editArtifact({
      path: "missing.xlsx",
      artifact: { kind: "xlsx", cells: [{ sheet: "Data", cell: "A1", value: "x" }] },
      outputCredentialSupplied: false,
    }, workspace, false, "test-session");

    expect(result).toMatchObject({ ok: false, code: "write-not-enabled" });
  });
});

// ---------------------------------------------------------------------------
// TL-SECURITY-REVIEW-2026-08-15 finding 4 (CWE-409/400): the DOCX/PPTX
// text-edit path used to load straight into JSZip and inflate every
// selected XML part into an aggregate Map with NO size checks at all —
// neither the shared office/zipPreflight.ts preflight (wired into every
// OTHER zip-container consumer) nor a per-part/cumulative cap on the
// actually-inflated text. __quotaOverridesForTest (mirrors office/pdf.ts's
// PdfExtractionQuotaOverrides) lets these tests trip the real per-part/
// cumulative logic with tiny fixtures instead of megabytes of real XML.
// ---------------------------------------------------------------------------
describe("editArtifact — OOXML edit-path ZIP-bomb guard (finding 4)", () => {
  let workspace: GuardedWorkspaceRoot;

  beforeEach(() => {
    workspace = unsafeGuardedWorkspaceRootForTests(
      fs.mkdtempSync(path.join(os.tmpdir(), "tl-artifact-edit-ooxml-guard-")),
    );
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  // Hand-built EOCD-only buffer (no real central directory backing it) —
  // enough to exercise preflightZip's EOCD prescan (finding 3), which now
  // gates this edit path too, without needing a genuinely huge archive.
  function buildEocdOnlyBuffer(totalEntries: number): Uint8Array {
    const buf = Buffer.alloc(22);
    buf.writeUInt32LE(0x06054b50, 0);
    buf.writeUInt16LE(0, 4);
    buf.writeUInt16LE(0, 6);
    buf.writeUInt16LE(totalEntries & 0xffff, 8);
    buf.writeUInt16LE(totalEntries & 0xffff, 10);
    buf.writeUInt32LE(0, 12);
    buf.writeUInt32LE(0, 16);
    buf.writeUInt16LE(0, 20);
    return new Uint8Array(buf);
  }

  it("runs the shared zip preflight before attempting to parse — rejects a ZIP whose EOCD claims too many entries", async () => {
    const bogus = buildEocdOnlyBuffer(ZIP_LIMITS.maxEntries + 1);
    fs.writeFileSync(path.join(workspace, "bomb.docx"), bogus);

    const result = await editArtifact({
      path: "bomb.docx",
      artifact: { kind: "docx", replacements: [{ search: "x", replace: "y" }] },
      outputCredentialSupplied: false,
    }, workspace, true, "test-session");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("docx-edit-failed");
    // "entries" only ever appears in the error text via the NEW preflight's
    // detail message — every OLD failure path here (JSZip throwing on a
    // malformed buffer, or a not-found search on an empty parts map) says
    // something else entirely, so this proves the preflight ran first.
    expect(result.error).toMatch(/entries/i);
  });

  it("a per-part inflation quota override rejects an oversized selected XML part", async () => {
    type TestZip = { file(name: string, content: string): unknown; generateAsync(o: { type: "uint8array" }): Promise<Uint8Array> };
    const packageZip = new JSZip() as unknown as TestZip;
    packageZip.file("[Content_Types].xml", "<Types/>");
    packageZip.file(
      "word/document.xml",
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>',
    );
    const bytes = await packageZip.generateAsync({ type: "uint8array" });
    fs.writeFileSync(path.join(workspace, "small.docx"), bytes);

    const result = await editArtifact({
      path: "small.docx",
      artifact: { kind: "docx", replacements: [{ search: "Hello world", replace: "Updated" }] },
      outputCredentialSupplied: false,
      __quotaOverridesForTest: { maxPartUncompressedBytes: 10 }, // the real part is well over 10 bytes
    }, workspace, true, "test-session");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("archive-member-too-large");
  });

  it("a cumulative inflation quota override rejects a total that only crosses the budget once a SECOND part is added", async () => {
    type TestZip = { file(name: string, content: string): unknown; generateAsync(o: { type: "uint8array" }): Promise<Uint8Array> };
    const packageZip = new JSZip() as unknown as TestZip;
    packageZip.file("[Content_Types].xml", "<Types/>");
    // Each part ~160-170 bytes; comfortably under the 1000-byte per-part
    // override below, but ~320-340 bytes summed — well past the 250-byte
    // cumulative override, and well past what either part alone would trip.
    packageZip.file(
      "word/document.xml",
      `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${"A".repeat(100)}</w:t></w:r></w:p></w:body></w:document>`,
    );
    packageZip.file(
      "word/header1.xml",
      `<w:hdr xmlns:w="urn:w"><w:p><w:r><w:t>${"B".repeat(100)}</w:t></w:r></w:p></w:hdr>`,
    );
    const bytes = await packageZip.generateAsync({ type: "uint8array" });
    fs.writeFileSync(path.join(workspace, "twopart.docx"), bytes);

    const result = await editArtifact({
      path: "twopart.docx",
      artifact: { kind: "docx", replacements: [{ search: "AAA", replace: "ZZZ" }] },
      outputCredentialSupplied: false,
      __quotaOverridesForTest: { maxPartUncompressedBytes: 1_000, maxTotalUncompressedBytes: 250 },
    }, workspace, true, "test-session");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("archive-expanded-too-large");
  });

  it("ordinary small docx edits are unaffected by the new preflight + quotas (real, non-overridden constants)", async () => {
    type TestZip = {
      file(name: string, content: string): unknown;
      file(name: string): { async(type: "string"): Promise<string> } | null;
      generateAsync(o: { type: "uint8array" }): Promise<Uint8Array>;
    };
    const packageZip = new JSZip() as unknown as TestZip;
    packageZip.file("[Content_Types].xml", "<Types/>");
    packageZip.file(
      "word/document.xml",
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>',
    );
    const bytes = await packageZip.generateAsync({ type: "uint8array" });
    fs.writeFileSync(path.join(workspace, "ordinary.docx"), bytes);

    const result = await editArtifact({
      path: "ordinary.docx",
      artifact: { kind: "docx", replacements: [{ search: "Hello world", replace: "Updated" }] },
      outputCredentialSupplied: false,
    }, workspace, true, "test-session");

    expect(result).toMatchObject({ ok: true, kind: "docx", changes: 1 });
    const verifiedZip = await JSZip.loadAsync(
      fs.readFileSync(path.join(workspace, "ordinary.docx")),
    ) as unknown as { file(name: string): { async(type: "string"): Promise<string> } | null };
    const xml = await verifiedZip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Updated");
  });
});
