import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import JSZip from "jszip";

import { prepareOfficeDocument, protectOfficeDocument } from "../office/decrypt.js";
import { looksLikeSecretFile } from "./secretScan.js";
import { makeTmpPath, retryRename } from "./atomicWrite.js";
import { batchCheckpoint } from "./checkpoint.js";
import type { GuardedWorkspaceRoot } from "./guardedWorkspace.js";
import { invalidateCachedWorkspaceFiles } from "@tokenlighten/skeleton-engine";
import { preflightZip, ZIP_LIMITS } from "../office/zipPreflight.js";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1_000;
const MAX_ZIP_MEMBER_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_MUTATIONS = 100;

type ArtifactKind = "xlsx" | "docx" | "pptx" | "pdf" | "zip";

export type ArtifactEditResult =
  | {
      ok: true;
      path: string;
      kind: ArtifactKind;
      changes: number;
      encrypted: boolean;
      sha: string;
    }
  | {
      ok: false;
      error: string;
      code: string;
      hint?: string;
    };

/**
 * TEST-ONLY seam (mirrors office/pdf.ts's PdfExtractionQuotaOverrides /
 * this codebase's established `{ maxBytes }`-style per-call cap override
 * convention): lets a regression test shrink the OOXML edit-path inflation
 * quotas (finding 4) without constructing megabytes of real XML content.
 * Never set by production callers.
 */
export interface OoxmlEditQuotaOverrides {
  maxPartUncompressedBytes?: number;
  maxTotalUncompressedBytes?: number;
}

interface ArtifactEditOptions {
  path: string;
  artifact: unknown;
  credentialPassword?: string;
  outputPassword?: string;
  outputCredentialSupplied: boolean;
  /** TEST-ONLY — see OoxmlEditQuotaOverrides. Never set by production callers. */
  __quotaOverridesForTest?: OoxmlEditQuotaOverrides;
}

interface ResolvedArtifact {
  kind: ArtifactKind;
  cells?: CellMutation[];
  replacements?: TextMutation[];
  form?: Record<string, string | number | boolean | string[]>;
  flatten?: boolean;
  members?: MemberMutation[];
}

interface CellMutation {
  sheet: string;
  cell: string;
  value?: string | number | boolean | null;
  formula?: string;
}

interface TextMutation {
  search: string;
  replace: string;
  all: boolean;
}

interface MemberMutation {
  action: "add" | "replace" | "delete";
  member: string;
  content?: string;
  sourcePath?: string;
}

interface BinaryTarget {
  abs: string;
  bytes: Uint8Array;
}

function fail(code: string, error: string, hint?: string): ArtifactEditResult {
  return { ok: false, code, error, ...(hint ? { hint } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArtifact(value: unknown): ResolvedArtifact | ArtifactEditResult {
  if (!isRecord(value)) {
    return fail("artifact-edit-invalid", "artifact must be an object.");
  }
  const kind = value["kind"];
  if (!["xlsx", "docx", "pptx", "pdf", "zip"].includes(String(kind))) {
    return fail("artifact-edit-invalid", "artifact.kind must be xlsx, docx, pptx, pdf, or zip.");
  }
  const parsed: ResolvedArtifact = { kind: String(kind) as ArtifactKind };

  if (parsed.kind === "xlsx") {
    if (!Array.isArray(value["cells"]) || value["cells"].length === 0) {
      return fail("artifact-edit-invalid", "artifact.cells must contain at least one XLSX cell edit.");
    }
    if (value["cells"].length > MAX_MUTATIONS) {
      return fail("artifact-edit-too-many-mutations", `artifact.cells accepts at most ${MAX_MUTATIONS} edits.`);
    }
    const cells: CellMutation[] = [];
    for (const raw of value["cells"]) {
      if (!isRecord(raw)) return fail("artifact-edit-invalid", "Each XLSX cell edit must be an object.");
      const sheet = typeof raw["sheet"] === "string" ? raw["sheet"] : "";
      const cell = typeof raw["cell"] === "string" ? raw["cell"].toUpperCase() : "";
      if (!sheet || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(cell)) {
        return fail("artifact-edit-invalid", "Each XLSX cell edit needs sheet and an A1-style cell.");
      }
      const hasFormula = typeof raw["formula"] === "string";
      const hasValue = Object.prototype.hasOwnProperty.call(raw, "value");
      if (hasFormula === hasValue) {
        return fail("artifact-edit-invalid", "Each XLSX cell edit needs exactly one of value or formula.");
      }
      const cellValue = raw["value"];
      if (
        hasValue
        && cellValue !== null
        && !["string", "number", "boolean"].includes(typeof cellValue)
      ) {
        return fail("artifact-edit-invalid", "XLSX cell values must be string, number, boolean, or null.");
      }
      cells.push({
        sheet,
        cell,
        ...(hasFormula ? { formula: String(raw["formula"]) } : { value: cellValue as CellMutation["value"] }),
      });
    }
    parsed.cells = cells;
  }

  if (parsed.kind === "docx" || parsed.kind === "pptx") {
    if (!Array.isArray(value["replacements"]) || value["replacements"].length === 0) {
      return fail("artifact-edit-invalid", "artifact.replacements must contain at least one text replacement.");
    }
    if (value["replacements"].length > MAX_MUTATIONS) {
      return fail("artifact-edit-too-many-mutations", `artifact.replacements accepts at most ${MAX_MUTATIONS} edits.`);
    }
    const replacements: TextMutation[] = [];
    for (const raw of value["replacements"]) {
      if (!isRecord(raw) || typeof raw["search"] !== "string" || raw["search"].length === 0) {
        return fail("artifact-edit-invalid", "Each replacement needs a non-empty search string.");
      }
      if (typeof raw["replace"] !== "string") {
        return fail("artifact-edit-invalid", "Each replacement needs a replace string.");
      }
      replacements.push({
        search: raw["search"],
        replace: raw["replace"],
        all: raw["all"] === true,
      });
    }
    parsed.replacements = replacements;
  }

  if (parsed.kind === "pdf") {
    if (!isRecord(value["form"]) || Object.keys(value["form"]).length === 0) {
      return fail("artifact-edit-invalid", "artifact.form must contain at least one PDF form field.");
    }
    if (Object.keys(value["form"]).length > MAX_MUTATIONS) {
      return fail("artifact-edit-too-many-mutations", `artifact.form accepts at most ${MAX_MUTATIONS} fields.`);
    }
    const form: Record<string, string | number | boolean | string[]> = {};
    for (const [name, fieldValue] of Object.entries(value["form"])) {
      const validArray = Array.isArray(fieldValue) && fieldValue.every((item) => typeof item === "string");
      if (!["string", "number", "boolean"].includes(typeof fieldValue) && !validArray) {
        return fail("artifact-edit-invalid", `Unsupported PDF form value for field "${name}".`);
      }
      form[name] = fieldValue as string | number | boolean | string[];
    }
    parsed.form = form;
    parsed.flatten = value["flatten"] === true;
  }

  if (parsed.kind === "zip") {
    if (!Array.isArray(value["members"]) || value["members"].length === 0) {
      return fail("artifact-edit-invalid", "artifact.members must contain at least one ZIP member edit.");
    }
    if (value["members"].length > MAX_MUTATIONS) {
      return fail("artifact-edit-too-many-mutations", `artifact.members accepts at most ${MAX_MUTATIONS} edits.`);
    }
    const members: MemberMutation[] = [];
    for (const raw of value["members"]) {
      if (!isRecord(raw) || !["add", "replace", "delete"].includes(String(raw["action"]))) {
        return fail("artifact-edit-invalid", "Each ZIP member edit needs action add, replace, or delete.");
      }
      const member = typeof raw["member"] === "string" ? normalizeMemberPath(raw["member"]) : undefined;
      if (!member) return fail("archive-member-path-invalid", "ZIP member paths must be relative and traversal-free.");
      const action = String(raw["action"]) as MemberMutation["action"];
      const content = typeof raw["content"] === "string" ? raw["content"] : undefined;
      const sourcePath = typeof raw["sourcePath"] === "string" ? raw["sourcePath"] : undefined;
      if (action !== "delete" && (content === undefined) === (sourcePath === undefined)) {
        return fail("artifact-edit-invalid", "ZIP add/replace needs exactly one of content or sourcePath.");
      }
      if (action === "delete" && (content !== undefined || sourcePath !== undefined)) {
        return fail("artifact-edit-invalid", "ZIP delete does not accept content or sourcePath.");
      }
      members.push({ action, member, ...(content !== undefined ? { content } : {}), ...(sourcePath ? { sourcePath } : {}) });
    }
    parsed.members = members;
  }

  return parsed;
}

function resolveBinaryTarget(relPath: string, workspace: string): BinaryTarget | ArtifactEditResult {
  if (!relPath) return fail("invalid-input", "path is required.");
  if (looksLikeSecretFile(relPath)) {
    return fail("secret-file", `Refusing to write to secret/credential file: ${relPath}`);
  }
  const workspaceAbs = path.resolve(workspace);
  const abs = path.resolve(workspace, relPath);
  if (abs !== workspaceAbs && !abs.startsWith(workspaceAbs + path.sep)) {
    return fail("path-escape", "path escapes workspace root.");
  }
  let workspaceReal = workspaceAbs;
  try { workspaceReal = fs.realpathSync(workspaceAbs); } catch { /* workspace resolution validates separately */ }
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(code === "ENOENT" ? "not-found" : "read-error", code === "ENOENT"
      ? `File not found: ${relPath}`
      : "Cannot read artifact.");
  }
  if (real !== workspaceReal && !real.startsWith(workspaceReal + path.sep)) {
    return fail("path-escape", "path escapes workspace root (symlink).");
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) return fail("invalid-input", "artifact path must be a file.");
  if (stat.size > MAX_INPUT_BYTES) {
    return fail("artifact-too-large", `Artifact exceeds ${MAX_INPUT_BYTES} bytes.`);
  }
  try {
    return { abs: real, bytes: fs.readFileSync(real) };
  } catch {
    return fail("read-error", "Cannot read artifact.");
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function atomicWriteBinary(abs: string, bytes: Uint8Array): ArtifactEditResult | undefined {
  if (bytes.byteLength > MAX_OUTPUT_BYTES) {
    return fail("artifact-output-too-large", `Edited artifact exceeds ${MAX_OUTPUT_BYTES} bytes.`);
  }
  const tmp = makeTmpPath(abs);
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    retryRename(tmp, abs);
    return undefined;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return fail("write-error", "Cannot write edited artifact.");
  }
}

async function editXlsx(bytes: Uint8Array, cells: CellMutation[]): Promise<Uint8Array | ArtifactEditResult> {
  type Cell = { value: unknown };
  type Worksheet = { getCell(ref: string): Cell };
  type Workbook = {
    xlsx: {
      load(data: Buffer): Promise<void>;
      writeBuffer(): Promise<ArrayBuffer | Uint8Array>;
    };
    getWorksheet(name: string): Worksheet | undefined;
  };
  type ExcelJsModule = { Workbook: new () => Workbook };
  const imported = await import("exceljs");
  const candidate = imported as unknown as ExcelJsModule & { default?: ExcelJsModule };
  const ExcelJs = candidate.Workbook ? candidate : candidate.default;
  if (!ExcelJs) return fail("xlsx-edit-unavailable", "XLSX editing support is unavailable.");
  const workbook = new ExcelJs.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes));
    for (const mutation of cells) {
      const sheet = workbook.getWorksheet(mutation.sheet);
      if (!sheet) return fail("xlsx-sheet-not-found", `Worksheet not found: ${mutation.sheet}`);
      sheet.getCell(mutation.cell).value = mutation.formula !== undefined
        ? { formula: mutation.formula }
        : mutation.value ?? null;
    }
    const output = new Uint8Array(await workbook.xlsx.writeBuffer());
    const verification = new ExcelJs.Workbook();
    await verification.xlsx.load(Buffer.from(output));
    return output;
  } catch {
    return fail("xlsx-edit-failed", "Could not edit or verify the XLSX workbook.");
  }
}

function decodeXmlText(value: string): string {
  return value.replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (match, hex, dec, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(String(hex), 16));
    if (dec) return String.fromCodePoint(Number.parseInt(String(dec), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" } as Record<string, string>)[String(named).toLowerCase()] ?? match;
  });
}

function encodeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface XmlTextNode {
  start: number;
  end: number;
  text: string;
}

function xmlTextNodes(paragraph: string, prefix: "w" | "a"): XmlTextNode[] {
  const nodes: XmlTextNode[] = [];
  const pattern = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${prefix}:t>`, "g");
  for (const match of paragraph.matchAll(pattern)) {
    const whole = match[0];
    const encoded = match[1] ?? "";
    const wholeIndex = match.index ?? 0;
    const contentOffset = whole.indexOf(encoded);
    nodes.push({
      start: wholeIndex + contentOffset,
      end: wholeIndex + contentOffset + encoded.length,
      text: decodeXmlText(encoded),
    });
  }
  return nodes;
}

function visibleParagraphText(paragraph: string, prefix: "w" | "a"): string {
  return xmlTextNodes(paragraph, prefix).map((node) => node.text).join("");
}

function replaceOneInParagraph(
  paragraph: string,
  prefix: "w" | "a",
  start: number,
  end: number,
  replacement: string,
): string | undefined {
  const nodes = xmlTextNodes(paragraph, prefix);
  let cursor = 0;
  let first = -1;
  let last = -1;
  let firstOffset = 0;
  let lastOffset = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const nodeStart = cursor;
    const nodeEnd = cursor + node.text.length;
    if (first === -1 && start >= nodeStart && start < nodeEnd) {
      first = index;
      firstOffset = start - nodeStart;
    }
    if (end > nodeStart && end <= nodeEnd) {
      last = index;
      lastOffset = end - nodeStart;
      break;
    }
    cursor = nodeEnd;
  }
  if (first < 0 || last < first) return undefined;

  const replacements = new Map<number, string>();
  if (first === last) {
    const text = nodes[first]!.text;
    replacements.set(first, text.slice(0, firstOffset) + replacement + text.slice(lastOffset));
  } else {
    replacements.set(first, nodes[first]!.text.slice(0, firstOffset) + replacement);
    for (let index = first + 1; index < last; index++) replacements.set(index, "");
    replacements.set(last, nodes[last]!.text.slice(lastOffset));
  }

  let output = paragraph;
  for (const [index, nextText] of [...replacements.entries()].sort((a, b) => b[0] - a[0])) {
    const node = nodes[index]!;
    output = output.slice(0, node.start) + encodeXmlText(nextText) + output.slice(node.end);
  }
  return output;
}

function findAll(text: string, search: string): number[] {
  const hits: number[] = [];
  let offset = 0;
  while (offset <= text.length - search.length) {
    const hit = text.indexOf(search, offset);
    if (hit < 0) break;
    hits.push(hit);
    offset = hit + Math.max(search.length, 1);
  }
  return hits;
}

function replaceInXmlParagraphs(
  xml: string,
  prefix: "w" | "a",
  mutation: TextMutation,
  replaceAll: boolean,
): { xml: string; changes: number } {
  const paragraphPattern = new RegExp(`<${prefix}:p(?:\\s[^>]*)?>[\\s\\S]*?<\\/${prefix}:p>`, "g");
  const paragraphs = [...xml.matchAll(paragraphPattern)];
  let changes = 0;
  let output = xml;
  for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
    const match = paragraphs[paragraphIndex]!;
    const original = match[0];
    const visible = visibleParagraphText(original, prefix);
    const hits = findAll(visible, mutation.search);
    if (hits.length === 0) continue;
    const selected = replaceAll ? hits : hits.slice(0, 1);
    let next = original;
    for (const hit of selected.sort((a, b) => b - a)) {
      const replaced = replaceOneInParagraph(next, prefix, hit, hit + mutation.search.length, mutation.replace);
      if (replaced !== undefined) {
        next = replaced;
        changes++;
      }
    }
    const start = match.index ?? 0;
    output = output.slice(0, start) + next + output.slice(start + original.length);
    if (!replaceAll && changes > 0) break;
  }
  return { xml: output, changes };
}

async function editOoxmlText(
  bytes: Uint8Array,
  kind: "docx" | "pptx",
  mutations: TextMutation[],
  quotaOverridesForTest?: OoxmlEditQuotaOverrides,
): Promise<{ bytes: Uint8Array; changes: number } | ArtifactEditResult> {
  // SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 4, CWE-409/400): this
  // path used to load straight into JSZip with none of the ZIP-bomb guards
  // every OTHER consumer of a zip container in this codebase gets — the
  // read side already runs preflightZip once per artifact before any
  // office/*.ts extractor touches the bytes (features/task-pack/
  // readCodeTaskPack.ts). Mirror that here before editing.
  const preflight = await preflightZip(bytes);
  if (!preflight.ok) {
    return fail(
      `${kind}-edit-failed`,
      `Could not open the ${kind.toUpperCase()} package: ${preflight.detail}`,
    );
  }
  type ZipPackage = {
    files: Record<string, unknown>;
    file(name: string): { async(type: "string"): Promise<string> } | null;
    file(name: string, data: string): unknown;
    generateAsync(options: { type: "uint8array"; compression: "DEFLATE" }): Promise<Uint8Array>;
  };
  let zip: ZipPackage;
  try {
    zip = await JSZip.loadAsync(bytes) as unknown as ZipPackage;
  } catch {
    return fail(`${kind}-edit-failed`, `Could not open the ${kind.toUpperCase()} package.`);
  }
  const prefix = kind === "docx" ? "w" : "a";
  const partNames = Object.keys(zip.files)
    .filter((name) => kind === "docx"
      ? /^word\/(document|header\d+|footer\d+)\.xml$/.test(name)
      : /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort();
  const parts = new Map<string, string>();
  // Per-part / cumulative inflation quotas — defense in depth alongside the
  // preflight above (which trusts the ZIP's declared metadata sizes):
  // abort the instant either is exceeded while actually inflating text,
  // rather than checking only after every selected part is materialized.
  // maxPartUncompressedBytes (16 MB) is zipPreflight's OWN per-OOXML-part
  // ceiling — reused verbatim rather than this file's stricter 10 MB
  // MAX_ZIP_MEMBER_BYTES, which is sized for the unrelated generic
  // editZip() member-replacement path (see ZIP_LIMITS' own comment on why
  // OOXML text parts get the more generous number). MAX_ZIP_TOTAL_BYTES (50
  // MB) is this file's existing aggregate-decompressed-bytes ceiling,
  // already used by editZip() for the same "whole edit operation" budget.
  const partBytesLimit = quotaOverridesForTest?.maxPartUncompressedBytes ?? ZIP_LIMITS.maxPartUncompressedBytes;
  const totalBytesLimit = quotaOverridesForTest?.maxTotalUncompressedBytes ?? MAX_ZIP_TOTAL_BYTES;
  let totalInflatedBytes = 0;
  for (const name of partNames) {
    const text = await zip.file(name)!.async("string");
    const partBytes = Buffer.byteLength(text, "utf8");
    if (partBytes > partBytesLimit) {
      return fail(
        "archive-member-too-large",
        `ZIP member exceeds ${partBytesLimit} bytes: ${name}`,
      );
    }
    totalInflatedBytes += partBytes;
    if (totalInflatedBytes > totalBytesLimit) {
      return fail("archive-expanded-too-large", `ZIP expanded content exceeds ${totalBytesLimit} bytes.`);
    }
    parts.set(name, text);
  }

  let totalChanges = 0;
  for (const mutation of mutations) {
    let occurrences = 0;
    for (const xml of parts.values()) {
      const paragraphPattern = new RegExp(`<${prefix}:p(?:\\s[^>]*)?>[\\s\\S]*?<\\/${prefix}:p>`, "g");
      for (const paragraph of xml.match(paragraphPattern) ?? []) {
        occurrences += findAll(visibleParagraphText(paragraph, prefix), mutation.search).length;
      }
    }
    if (occurrences === 0) {
      return fail("artifact-search-not-found", "Replacement search text was not found.");
    }
    if (!mutation.all && occurrences !== 1) {
      return fail("artifact-search-not-unique", `Replacement search text matched ${occurrences} locations; pass all:true to replace every match.`);
    }
    let remaining = mutation.all;
    for (const name of partNames) {
      const current = parts.get(name)!;
      const edited = replaceInXmlParagraphs(current, prefix, mutation, remaining);
      if (edited.changes > 0) {
        parts.set(name, edited.xml);
        totalChanges += edited.changes;
        if (!mutation.all) break;
      }
    }
  }
  for (const [name, xml] of parts) zip.file(name, xml);
  try {
    const output = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    await JSZip.loadAsync(output);
    return { bytes: output, changes: totalChanges };
  } catch {
    return fail(`${kind}-edit-failed`, `Could not save or verify the ${kind.toUpperCase()} package.`);
  }
}

function appearsEncryptedPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).includes(Buffer.from("/Encrypt"));
}

async function editPdfForm(
  bytes: Uint8Array,
  fields: Record<string, string | number | boolean | string[]>,
  flatten: boolean,
  password?: string,
  outputPassword?: string,
  outputCredentialSupplied = false,
): Promise<Uint8Array | ArtifactEditResult> {
  const wasEncrypted = appearsEncryptedPdf(bytes);
  type PdfForm = {
    fill(values: Record<string, string | number | boolean | string[]>): {
      filled: string[];
      skipped: string[];
    };
    flatten(options?: { skipSignatures?: boolean }): void;
  };
  type PdfDocument = {
    readonly isEncrypted: boolean;
    readonly isAuthenticated: boolean;
    getForm(): PdfForm | null;
    setProtection(options: {
      userPassword?: string;
      ownerPassword?: string;
      algorithm?: "AES-256";
    }): void;
    save(): Promise<Uint8Array | ArrayBuffer>;
  };
  type PdfModule = {
    PDF: {
      load(data: Uint8Array, options?: { credentials?: string }): Promise<PdfDocument>;
    };
  };
  try {
    const imported = await import("@libpdf/core") as unknown as PdfModule;
    const pdf = await imported.PDF.load(bytes, password !== undefined ? { credentials: password } : undefined);
    const form = pdf.getForm();
    if (!form) return fail("pdf-form-not-found", "The PDF does not contain an interactive form.");
    const fillResult = form.fill(fields);
    if (fillResult.skipped.length > 0) {
      return fail(
        "pdf-form-field-not-found",
        `PDF form fields were not found: ${fillResult.skipped.slice(0, 5).join(", ")}`,
      );
    }
    if (flatten) {
      form.flatten({ skipSignatures: true });
    }
    if (outputCredentialSupplied) {
      if (outputPassword === undefined || outputPassword.length === 0) {
        return fail("credential-not-found", "The output credential did not resolve to a password.");
      }
      pdf.setProtection({
        userPassword: outputPassword,
        ownerPassword: outputPassword,
        algorithm: "AES-256",
      });
    }
    const output = new Uint8Array(await pdf.save());
    const shouldBeEncrypted = wasEncrypted || outputCredentialSupplied;
    if (shouldBeEncrypted) {
      let encryptionMissing = false;
      try {
        const unauthenticated = await imported.PDF.load(output);
        encryptionMissing = !unauthenticated.isEncrypted || unauthenticated.isAuthenticated;
      } catch {
        // A parser that refuses encrypted input without credentials also proves
        // the output did not silently become plaintext.
      }
      if (encryptionMissing) {
        return fail("pdf-encryption-not-preserved", "PDF verification detected that password protection was not preserved.");
      }
      const authenticated = await imported.PDF.load(output, {
        credentials: outputCredentialSupplied ? outputPassword! : password ?? "",
      });
      if (!authenticated.isEncrypted || !authenticated.isAuthenticated) {
        return fail("pdf-verification-failed", "The edited PDF could not be authenticated with the output credential.");
      }
    } else {
      await imported.PDF.load(output);
    }
    return output;
  } catch {
    return fail("pdf-edit-failed", "Could not fill or verify the PDF form. Check the credential and field names.");
  }
}

function normalizeMemberPath(member: string): string | undefined {
  if (!member || member.includes("\0") || member.startsWith("/") || /^[A-Za-z]:[\\/]/.test(member)) return undefined;
  const normalized = member.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) return undefined;
  return normalized;
}

async function readSourceMemberBytes(
  mutation: MemberMutation,
  workspace: string,
): Promise<Uint8Array | ArtifactEditResult> {
  if (mutation.content !== undefined) return new TextEncoder().encode(mutation.content);
  const sourcePath = mutation.sourcePath ?? "";
  const workspaceAbs = path.resolve(workspace);
  const abs = path.resolve(workspace, sourcePath);
  if (abs !== workspaceAbs && !abs.startsWith(workspaceAbs + path.sep)) {
    return fail("path-escape", "ZIP sourcePath escapes workspace root.");
  }
  let workspaceReal = workspaceAbs;
  try { workspaceReal = fs.realpathSync(workspaceAbs); } catch { /* validated by caller */ }
  let real: string;
  try { real = fs.realpathSync(abs); } catch { return fail("not-found", `ZIP source file not found: ${sourcePath}`); }
  if (real !== workspaceReal && !real.startsWith(workspaceReal + path.sep)) {
    return fail("path-escape", "ZIP sourcePath escapes workspace root (symlink).");
  }
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX_ZIP_MEMBER_BYTES) {
    return fail("archive-member-too-large", `ZIP source member must be a file no larger than ${MAX_ZIP_MEMBER_BYTES} bytes.`);
  }
  return fs.readFileSync(real);
}

async function editZip(
  bytes: Uint8Array,
  mutations: MemberMutation[],
  workspace: string,
  inputPassword?: string,
  outputPassword?: string,
  outputCredentialSupplied = false,
): Promise<{ bytes: Uint8Array; changes: number; encrypted: boolean } | ArtifactEditResult> {
  const zipModule = await import("@zip.js/zip.js");
  const {
    ZipReader,
    ZipWriter,
    Uint8ArrayReader,
    Uint8ArrayWriter,
  } = zipModule;
  type StoredEntry = {
    name: string;
    data: Uint8Array;
    directory: boolean;
    encrypted: boolean;
    lastModDate?: Date;
  };
  const stored = new Map<string, StoredEntry>();
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_ZIP_ENTRIES) {
      return fail("archive-entry-limit", `ZIP contains more than ${MAX_ZIP_ENTRIES} entries.`);
    }
    let total = 0;
    for (const entry of entries) {
      const name = normalizeMemberPath(entry.filename.replace(/\/$/, ""));
      if (!name) return fail("archive-member-path-invalid", "ZIP contains an unsafe member path.");
      if (stored.has(name)) return fail("archive-duplicate-member", `ZIP contains duplicate member: ${name}`);
      let data = new Uint8Array();
      if (!entry.directory) {
        if (entry.uncompressedSize > MAX_ZIP_MEMBER_BYTES) {
          return fail("archive-member-too-large", `ZIP member exceeds ${MAX_ZIP_MEMBER_BYTES} bytes: ${name}`);
        }
        if (!entry.getData) return fail("archive-read-error", `Cannot read ZIP member: ${name}`);
        data = await entry.getData(new Uint8ArrayWriter(), {
          ...(entry.encrypted && inputPassword !== undefined ? { password: inputPassword } : {}),
          checkSignature: true,
          checkOverlappingEntry: true,
        });
        total += data.byteLength;
        if (total > MAX_ZIP_TOTAL_BYTES) {
          return fail("archive-expanded-too-large", `ZIP expanded content exceeds ${MAX_ZIP_TOTAL_BYTES} bytes.`);
        }
      }
      stored.set(name, {
        name,
        data,
        directory: entry.directory,
        encrypted: entry.encrypted,
        lastModDate: entry.lastModDate,
      });
    }
  } catch {
    return fail(
      inputPassword === undefined ? "archive-password-required" : "archive-password-invalid",
      inputPassword === undefined
        ? "The ZIP contains encrypted members."
        : "The resolved credential could not decrypt the ZIP.",
    );
  } finally {
    await reader.close().catch(() => undefined);
  }

  const anyEncrypted = [...stored.values()].some((entry) => entry.encrypted);
  let changes = 0;
  for (const mutation of mutations) {
    const existing = stored.get(mutation.member);
    if (mutation.action === "add" && existing) {
      return fail("archive-member-exists", `ZIP member already exists: ${mutation.member}`);
    }
    if ((mutation.action === "replace" || mutation.action === "delete") && !existing) {
      return fail("archive-member-not-found", `ZIP member not found: ${mutation.member}`);
    }
    if (mutation.action === "delete") {
      stored.delete(mutation.member);
      changes++;
      continue;
    }
    const data = await readSourceMemberBytes(mutation, workspace);
    if (!("byteLength" in data)) return data;
    if (data.byteLength > MAX_ZIP_MEMBER_BYTES) {
      return fail("archive-member-too-large", `ZIP member exceeds ${MAX_ZIP_MEMBER_BYTES} bytes: ${mutation.member}`);
    }
    stored.set(mutation.member, {
      name: mutation.member,
      data,
      directory: false,
      encrypted: outputCredentialSupplied || existing?.encrypted === true || (!existing && anyEncrypted),
      lastModDate: new Date(),
    });
    changes++;
  }

  const effectiveOutputPassword = outputCredentialSupplied ? outputPassword : inputPassword;
  if ((outputCredentialSupplied || [...stored.values()].some((entry) => entry.encrypted)) && effectiveOutputPassword === undefined) {
    return fail("archive-password-required", "A credential is required to preserve ZIP encryption.");
  }

  const writer = new ZipWriter(new Uint8ArrayWriter(), { bufferedWrite: true });
  try {
    for (const entry of stored.values()) {
      const encrypt = !entry.directory && (outputCredentialSupplied || entry.encrypted);
      await writer.add(
        entry.directory ? `${entry.name}/` : entry.name,
        entry.directory ? undefined : new Uint8ArrayReader(entry.data),
        {
          directory: entry.directory,
          ...(entry.lastModDate ? { lastModDate: entry.lastModDate } : {}),
          ...(encrypt ? { password: effectiveOutputPassword, encryptionStrength: 3 as const } : {}),
        },
      );
    }
    const output = await writer.close();
    if (output.byteLength > MAX_OUTPUT_BYTES) {
      return fail("artifact-output-too-large", `Edited ZIP exceeds ${MAX_OUTPUT_BYTES} bytes.`);
    }
    const verifyReader = new ZipReader(new Uint8ArrayReader(output));
    try {
      const verificationEntries = await verifyReader.getEntries();
      if (verificationEntries.length !== stored.size) {
        return fail("archive-verification-failed", "Edited ZIP entry count did not verify.");
      }
      for (const mutation of mutations) {
        if (mutation.action === "delete") continue;
        const entry = verificationEntries.find((candidate) => candidate.filename.replace(/\/$/, "") === mutation.member);
        if (!entry || entry.directory || !("getData" in entry)) {
          return fail("archive-verification-failed", `Edited ZIP member did not verify: ${mutation.member}`);
        }
        await entry.getData(new Uint8ArrayWriter(), {
          ...(entry.encrypted ? { password: effectiveOutputPassword } : {}),
          checkSignature: true,
        });
      }
    } finally {
      await verifyReader.close().catch(() => undefined);
    }
    return {
      bytes: output,
      changes,
      encrypted: outputCredentialSupplied || [...stored.values()].some((entry) => entry.encrypted),
    };
  } catch {
    return fail("archive-write-failed", "Could not rebuild or verify the ZIP archive.");
  }
}

export async function editArtifact(
  options: ArtifactEditOptions,
  workspace: GuardedWorkspaceRoot,
  allowWrite: boolean,
  sessionId: string,
): Promise<ArtifactEditResult> {
  if (!allowWrite) {
    return fail("write-not-enabled", "Write tools are disabled. Restart the server with --allow-write.");
  }
  const artifact = parseArtifact(options.artifact);
  if ("ok" in artifact) return artifact;
  const expectedExtension = `.${artifact.kind}`;
  if (!options.path.toLowerCase().endsWith(expectedExtension)) {
    return fail("artifact-kind-mismatch", `artifact.kind=${artifact.kind} does not match path extension.`);
  }
  const target = resolveBinaryTarget(options.path, workspace);
  if ("ok" in target) return target;

  let output: Uint8Array;
  let changes = 0;
  let encrypted = false;

  if (artifact.kind === "zip") {
    const zipResult = await editZip(
      target.bytes,
      artifact.members!,
      workspace,
      options.credentialPassword,
      options.outputPassword,
      options.outputCredentialSupplied,
    );
    if ("ok" in zipResult) return zipResult;
    output = zipResult.bytes;
    changes = zipResult.changes;
    encrypted = zipResult.encrypted;
  } else if (artifact.kind === "pdf") {
    const pdfResult = await editPdfForm(
      target.bytes,
      artifact.form!,
      artifact.flatten === true,
      options.credentialPassword,
      options.outputPassword,
      options.outputCredentialSupplied,
    );
    if ("ok" in pdfResult) return pdfResult;
    output = pdfResult;
    changes = Object.keys(artifact.form!).length;
    encrypted = appearsEncryptedPdf(output);
  } else {
    const prepared = await prepareOfficeDocument(target.bytes, options.credentialPassword);
    if (!prepared.ok) return fail(prepared.code, prepared.error, prepared.hint);
    encrypted = prepared.encrypted || options.outputCredentialSupplied;
    let editedPlain: Uint8Array;
    if (artifact.kind === "xlsx") {
      const xlsxResult = await editXlsx(prepared.bytes, artifact.cells!);
      if ("ok" in xlsxResult) return xlsxResult;
      editedPlain = xlsxResult;
      changes = artifact.cells!.length;
    } else {
      const ooxmlResult = await editOoxmlText(
        prepared.bytes,
        artifact.kind,
        artifact.replacements!,
        options.__quotaOverridesForTest,
      );
      if ("ok" in ooxmlResult) return ooxmlResult;
      editedPlain = ooxmlResult.bytes;
      changes = ooxmlResult.changes;
    }
    const effectiveOutputPassword = options.outputCredentialSupplied
      ? options.outputPassword
      : prepared.encrypted
        ? options.credentialPassword
        : undefined;
    if (encrypted) {
      if (effectiveOutputPassword === undefined) {
        return fail("office-password-required", "A credential is required to preserve Office encryption.");
      }
      const protectedResult = await protectOfficeDocument(editedPlain, effectiveOutputPassword);
      if (!protectedResult.ok) return fail(protectedResult.code, protectedResult.error);
      output = protectedResult.bytes;
      const verification = await prepareOfficeDocument(output, effectiveOutputPassword);
      if (!verification.ok) return fail("office-verification-failed", "Encrypted Office output could not be verified.");
    } else {
      output = editedPlain;
    }
  }

  const writeFailure = atomicWriteBinary(target.abs, output);
  if (writeFailure) return writeFailure;
  try { batchCheckpoint(workspace, [options.path], sessionId); } catch { /* non-fatal */ }
  // V10-10: binary/artifact writes (zip/xlsx/pdf/office) go through
  // atomicWriteBinary above, not writeExistingFileAtomic, so they are not
  // covered by that function's own index-invalidation call.
  try { invalidateCachedWorkspaceFiles(workspace, [options.path]); } catch { /* best-effort */ }
  return {
    ok: true,
    path: options.path,
    kind: artifact.kind,
    changes,
    encrypted,
    sha: sha256(output),
  };
}
