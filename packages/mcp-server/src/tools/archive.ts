import { TextDecoder } from "node:util";

import type {
  ArchiveFailureCode,
  ArchiveFormat,
  ArchiveSelector,
  ReadFileArchiveEntry,
  ReadFileArchiveOutput,
  TaskDecision,
} from "@tokenlighten/types";

import { handleTable, shaOfBytes, shaOfText, shortSha } from "../util/handles.js";
import { isWalkIgnoredPath } from "./walkRepo.js";
import { eocdEntryCountPrescan } from "../office/zipPreflight.js";

export const ARCHIVE_LIMITS = {
  maxCompressedBytes: 25 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxEntries: 10_000,
  maxExpansionRatio: 100,
  maxMemberBytes: 16 * 1024 * 1024,
  maxScanBytes: 16 * 1024 * 1024,
  maxScanEntries: 64,
  maxManifestEntries: 200,
  maxSurfaceBytes: 16 * 1024,
  maxSurfaceLines: 140,
} as const;

export interface ArchiveFailure {
  ok: false;
  code: ArchiveFailureCode;
  error: string;
  path?: string;
  member?: string;
}

interface LibarchiveCompressedFile {
  name: string;
  size: number;
  lastModified: number;
  extract(): Promise<File>;
}

interface LibarchiveArrayEntry {
  path: string;
  file: LibarchiveCompressedFile;
}

interface LibarchiveReader {
  getFilesArray(): Promise<LibarchiveArrayEntry[]>;
  hasEncryptedData(): Promise<boolean | null>;
  usePassword(password: string): Promise<void>;
  close(): Promise<void>;
}

interface ArchiveEntry {
  member: string;
  file: LibarchiveCompressedFile;
  size: number;
  lastModified: number;
}

interface OpenedArchive {
  reader: LibarchiveReader;
  entries: ArchiveEntry[];
  format: ArchiveFormat;
  sha: string;
  totalBytes: number;
  warnings: string[];
  encrypted: boolean;
  passwordSupplied: boolean;
}

export interface ArchiveMemberText {
  outerPath: string;
  member: string;
  virtualPath: string;
  format: ArchiveFormat;
  archiveSha: string;
  content: string;
  bytes: Buffer;
  sha: string;
}

export type ArchiveManifestEntry = ReadFileArchiveEntry;
export type ArchiveManifest = ReadFileArchiveOutput;

export interface ArchiveTaskSurface {
  role: "unknown";
  handle: string;
  path: string;
  container_path: string;
  member_path: string;
  range: string;
  code: string;
  why: string;
  sha: string;
  content_completeness?: "partial";
  remaining_ranges?: string[];
}

export interface ArchiveTaskPack {
  mode: "task_pack";
  coverage: "complete" | "partial";
  surfaces: ArchiveTaskSurface[];
  missing: string[];
  archive: {
    path: string;
    format: ArchiveFormat;
    sha: string;
    total_entries: number;
    scanned_entries: number;
    omitted_entries: number;
    read_only: true;
  };
  route: {
    action: "answer_from_surfaces" | "narrow_archive_query";
    reason: string;
    max_additional_tl_calls: number;
  };
  task_profile: "answer" | "generic";
  execution_contract: {
    phase: "prepared" | "discovery";
    unresolved: string[];
    allowed: Array<"read" | "search" | "edit">;
    required_action?: string;
  };
  warnings: string[];
}

/**
 * P0a §6.1 for the ARCHIVE wire family (2026-08-13).
 *
 * Archive packs are built outside the code task-pack pipeline: they carry
 * their own route union (`answer_from_surfaces` / `narrow_archive_query`) and
 * an already-lean execution contract with no `typestate`, so the canonical
 * `canonicalTaskDecisionInvariantViolations` oracle cannot read them. They
 * are nonetheless required to satisfy the same rule — route, contract, and
 * call budget must be projections of ONE decision — so they get their own
 * compact oracle instead of an unchecked exemption. Both fields are derived
 * from the single `prepared` boolean above, so this holds by construction;
 * the point is that a future edit that breaks the correspondence fails a test
 * rather than shipping a self-contradicting archive response.
 */
export function archiveTaskPackInvariantViolations(pack: ArchiveTaskPack): string[] {
  const violations: string[] = [];
  const contract = pack.execution_contract;
  const prepared = contract.phase === "prepared";
  const terminalRoute = pack.route.action === "answer_from_surfaces";
  if (prepared !== terminalRoute) {
    violations.push("archive-route-must-match-contract-phase");
  }
  if (prepared) {
    if (pack.route.max_additional_tl_calls !== 0) violations.push("archive-prepared-forbids-discovery-budget");
    if (contract.unresolved.length > 0) violations.push("archive-prepared-forbids-unresolved");
    if (contract.allowed.some((action) => action === "read" || action === "search")) {
      violations.push("archive-prepared-forbids-read-search");
    }
    if (contract.required_action === undefined) violations.push("archive-prepared-requires-required-action");
  } else {
    if (pack.route.max_additional_tl_calls < 1) violations.push("archive-discovery-requires-one-call");
    if (contract.unresolved.length === 0) violations.push("archive-discovery-requires-unresolved");
    if (!contract.allowed.includes("read") || !contract.allowed.includes("search")) {
      violations.push("archive-discovery-requires-read-search");
    }
    if (contract.required_action !== undefined) violations.push("archive-discovery-forbids-required-action");
  }
  return violations;
}

/**
 * A.3 / §2.1 for the ARCHIVE wire family — the ONE decision (P3a S2b, 2026-08-14).
 *
 * WHY IT LIVES HERE. `server.ts`'s `projectTaskPackWire` derives the wire
 * decision through `deriveCanonicalTaskDecision`, which reads
 * `contract.typestate.phase`; an archive contract is a different, typestate-less
 * shape, so that projection yields `undefined` and the archive pack shipped
 * `read.task_pack` WITH NO `decision` — a member missing a field §4.3 declares
 * required and `ReadTaskPackResult` types non-optional. C2-3 recorded the gap
 * outright ("it emits no `decision` yet") rather than fabricating one; this is
 * the fix it handed off, and it belongs beside `archiveTaskPackInvariantViolations`
 * for the same reason that oracle does: the archive family proves the
 * one-decision rule with its own compact projector instead of taking an
 * unchecked exemption.
 *
 * PROJECTION OF THE SAME BOOLEAN. `route`, `execution_contract` and this
 * decision are all functions of `buildArchiveTaskPack`'s single `prepared`
 * flag, so P0a §6.1's "route, contract and call budget are projections of ONE
 * decision" extends to the wire verdict by construction rather than by
 * agreement.
 *
 * WHY THESE TWO ARMS, AND NOT THE OTHER THREE:
 *
 *  - `act.answer` / `act.edit` are UNAUTHORABLE here, not merely unchosen.
 *    Both require a `CertificateRef` (§2.1.1, D-2), and an archive pack
 *    registers no execution fence — `projectTaskPackWire` is wire-only by
 *    design. A minted id would name a certificate `state/session.ts` cannot
 *    match, so a caller's `challenge` against it would be refused: a dead end
 *    wearing a transition's label. `act.edit` fails a second way — every
 *    archive surface is a read-only virtual member, so there is no writable
 *    frontier for its non-empty `frontier` to hold.
 *
 *  - `done` would claim `semantic_closure.state === "closed"`
 *    (`canonicalDecision.ts:130`). Nothing in an archive scan proves the task
 *    closed; it proves the EVIDENCE is served, which is a different statement.
 *
 * So `prepared` maps to exactly what the mainline pack emits in the same
 * situation — required surfaces served, no certificate, no grounded next call.
 * That branch is `readCodeTaskPack.ts`'s `grantServedTerminal`
 * (:14554, :14591-14592), whose contract-declared code is
 * `act-on-served-evidence` and whose prose is this pack's `required_action`
 * almost verbatim ("act on the served evidence"). Matching it is the preference
 * order's first rung: the archive pack says what its non-archive equivalent
 * says, rather than inventing an archive-only verdict.
 *
 * The discovery arm carries the one call that actually closes its gap. Both of
 * its causes — a scan that found no query evidence, and one that omitted
 * entries — leave the caller unable to choose the `archive.prefix`/`member`
 * the route asks for, because it does not know what members exist. The manifest
 * is that inventory, it is executable NOW with arguments this pack already
 * holds (F5: no placeholder, no template), and it is the same recovery the
 * neighbouring `archive-read-only-container` refusal already names.
 *
 * NO `gaps`. `CapabilityGap` reports a SEMANTIC gap; "the scan matched nothing"
 * and "the scan was truncated" are delivery facts, which is precisely what
 * `TaskDecision`'s own doc says the absence of `gaps` means.
 */
export function archiveTaskDecision(pack: ArchiveTaskPack): TaskDecision {
  if (pack.execution_contract.phase === "prepared") {
    return { kind: "await_input", code: "act-on-served-evidence" };
  }
  return {
    kind: "discover",
    next: {
      tool: "read_file",
      arguments: { mode: "archive", archive: { path: pack.archive.path } },
    },
  };
}

export interface ArchiveFindResult {
  query: string;
  files: Array<{
    path: string;
    member: string;
    lines: number[];
    snippets: string[];
    handle: string;
    range: string;
    context: string;
  }>;
  total_files: number;
  total_matches: number;
  truncated: boolean;
  literal: true;
  archive_scope: {
    path: string;
    format: ArchiveFormat;
    entries: number;
    scanned_entries: number;
    omitted_entries: number;
  };
  absence?: {
    scanned_files: number;
    tokens: string[];
    conclusion: string;
  };
  warnings: string[];
}

const ARCHIVE_EXT_RE = /\.(?:zip|tar|tgz|7z|rar)$/i;
const TAR_GZ_EXT_RE = /\.tar\.gz$/i;
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rs",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".kt", ".kts",
  ".cs", ".php", ".rb", ".css", ".scss", ".less", ".md", ".markdown", ".txt",
  ".rst", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".csv", ".tsv", ".log", ".xml", ".properties", ".sql", ".proto", ".sh", ".bat",
  ".ps1", ".gradle", ".graphql", ".gql", ".tf",
]);
const QUERY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "file", "files",
  "archive", "inside", "please", "explain", "find",
]);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

export function isSupportedArchivePath(filePath: string): boolean {
  return TAR_GZ_EXT_RE.test(filePath) || ARCHIVE_EXT_RE.test(filePath);
}

export function virtualArchivePath(outerPath: string, member: string): string {
  return `${outerPath}!/${member}`;
}

export function splitArchiveVirtualPath(filePath: string): { outerPath: string; member: string } | undefined {
  const delimiter = filePath.indexOf("!/");
  if (delimiter <= 0) return undefined;
  const outerPath = filePath.slice(0, delimiter);
  if (!isSupportedArchivePath(outerPath)) return undefined;
  const normalized = normalizeMemberPath(filePath.slice(delimiter + 2));
  return normalized.ok ? { outerPath, member: normalized.member } : undefined;
}

export function selectorFromArgs(args: Record<string, unknown>): ArchiveSelector | undefined {
  const raw = args["archive"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const path = typeof value["path"] === "string" ? value["path"].trim() : "";
  if (!path) return undefined;
  return {
    path,
    ...(typeof value["member"] === "string" && value["member"].length > 0 ? { member: value["member"] } : {}),
    ...(typeof value["prefix"] === "string" && value["prefix"].length > 0 ? { prefix: value["prefix"] } : {}),
  };
}

export function archivePathFromTaskPaths(paths: unknown): string | undefined {
  if (!Array.isArray(paths) || paths.length !== 1) return undefined;
  const item = paths[0];
  const candidate = typeof item === "string"
    ? item
    : item && typeof item === "object"
      ? String((item as Record<string, unknown>)["path"] ?? "")
      : "";
  return isSupportedArchivePath(candidate) ? candidate : undefined;
}

function archiveFormat(bytes: Uint8Array, filePath: string): ArchiveFormat | undefined {
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc &&
    bytes[3] === 0xaf && bytes[4] === 0x27 && bytes[5] === 0x1c
  ) return "7z";
  if (
    bytes.length >= 7 &&
    bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 &&
    bytes[3] === 0x21 && bytes[4] === 0x1a && bytes[5] === 0x07
  ) return "rar";
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "tar.gz";
  if (
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  ) return "zip";
  const ustar = bytes.length >= 262
    ? Buffer.from(bytes.subarray(257, 262)).toString("ascii")
    : "";
  if (ustar === "ustar" || /\.tar$/i.test(filePath)) return "tar";
  if (TAR_GZ_EXT_RE.test(filePath) || /\.tgz$/i.test(filePath)) return "tar.gz";
  if (/\.7z$/i.test(filePath)) return "7z";
  if (/\.rar$/i.test(filePath)) return "rar";
  if (/\.zip$/i.test(filePath)) return "zip";
  return undefined;
}

function normalizeMemberPath(raw: string): { ok: true; member: string } | { ok: false; reason: string } {
  if (!raw || raw.includes("\0")) return { ok: false, reason: "empty or NUL-containing member path" };
  const slash = raw.replace(/\\/g, "/").normalize("NFC");
  if (slash.startsWith("/") || /^[A-Za-z]:\//.test(slash)) {
    return { ok: false, reason: "absolute archive member path" };
  }
  const parts: string[] = [];
  for (const part of slash.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return { ok: false, reason: "parent traversal archive member path" };
    parts.push(part);
  }
  if (parts.length === 0) return { ok: false, reason: "empty normalized member path" };
  return { ok: true, member: parts.join("/") };
}

function failure(code: ArchiveFailureCode, error: string, path?: string, member?: string): ArchiveFailure {
  return {
    ok: false,
    code,
    error,
    ...(path ? { path } : {}),
    ...(member ? { member } : {}),
  };
}

async function openArchive(
  bytes: Uint8Array,
  outerPath: string,
  workspace: string,
  password?: string,
): Promise<{ ok: true; data: OpenedArchive } | ArchiveFailure> {
  if (!isSupportedArchivePath(outerPath)) {
    return failure("archive-unsupported", `unsupported archive path: ${outerPath}`, outerPath);
  }
  if (bytes.length > ARCHIVE_LIMITS.maxCompressedBytes) {
    return failure(
      "archive-too-large",
      `compressed bytes ${bytes.length} exceed ${ARCHIVE_LIMITS.maxCompressedBytes}`,
      outerPath,
    );
  }
  const format = archiveFormat(bytes, outerPath);
  if (!format) return failure("archive-unsupported", `unsupported archive format: ${outerPath}`, outerPath);

  // SECURITY (TL-SECURITY-REVIEW-2026-08-15 finding 3, CWE-400): for the zip
  // format specifically, run the same cheap EOCD prescan office/zipPreflight
  // .ts uses before its own full parse — reject an obviously-over-limit
  // entry count BEFORE libarchive's Archive.open()/getFilesArray() below
  // materializes full metadata for every entry. tar/tar.gz/7z/rar have no
  // equivalent lightweight, format-specific prescan available here; for
  // those the maxCompressedBytes check above (already front-loaded) and the
  // mid-loop cumulative-size abort further down remain the guards.
  if (format === "zip") {
    const prescan = eocdEntryCountPrescan(bytes, ARCHIVE_LIMITS.maxEntries);
    if (!prescan.ok) {
      return failure("archive-too-many-entries", prescan.detail, outerPath);
    }
  }

  let reader: LibarchiveReader | undefined;
  let encrypted = false;
  try {
    const { Archive } = await import("libarchive.js/dist/libarchive-node.mjs");
    reader = await Archive.open(new Blob([Uint8Array.from(bytes)])) as LibarchiveReader;
    if (password !== undefined) await reader.usePassword(password);
    encrypted = await reader.hasEncryptedData() === true;
    if (encrypted && password === undefined) {
      await reader.close();
      return failure(
        "archive-encrypted",
        "archive is password-protected; configure credentialRef to read it",
        outerPath,
      );
    }
    const listed = await reader.getFilesArray();
    if (listed.length > ARCHIVE_LIMITS.maxEntries) {
      await reader.close();
      return failure(
        "archive-too-many-entries",
        `entries ${listed.length} exceed ${ARCHIVE_LIMITS.maxEntries}`,
        outerPath,
      );
    }

    const entries: ArchiveEntry[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    let ignored = 0;
    for (const listedEntry of listed) {
      const normalized = normalizeMemberPath(`${listedEntry.path}${listedEntry.file.name}`);
      if (!normalized.ok) {
        await reader.close();
        return failure("archive-unsafe-path", normalized.reason, outerPath);
      }
      if (seen.has(normalized.member)) {
        await reader.close();
        return failure(
          "archive-unsafe-path",
          `duplicate normalized member path: ${normalized.member}`,
          outerPath,
          normalized.member,
        );
      }
      seen.add(normalized.member);
      const virtualPath = virtualArchivePath(outerPath, normalized.member);
      if (isWalkIgnoredPath(workspace, virtualPath)) {
        ignored += 1;
        continue;
      }
      const size = Number(listedEntry.file.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        await reader.close();
        return failure("archive-corrupt", `invalid member size: ${normalized.member}`, outerPath, normalized.member);
      }
      totalBytes += size;
      if (totalBytes > ARCHIVE_LIMITS.maxUncompressedBytes) {
        await reader.close();
        return failure(
          "archive-too-large",
          `uncompressed bytes exceed ${ARCHIVE_LIMITS.maxUncompressedBytes}`,
          outerPath,
        );
      }
      entries.push({
        member: normalized.member,
        file: listedEntry.file,
        size,
        lastModified: Number(listedEntry.file.lastModified) || 0,
      });
    }
    if (bytes.length > 0 && totalBytes / bytes.length > ARCHIVE_LIMITS.maxExpansionRatio) {
      await reader.close();
      return failure(
        "archive-bomb",
        `expansion ratio ${(totalBytes / bytes.length).toFixed(1)} exceeds ${ARCHIVE_LIMITS.maxExpansionRatio}`,
        outerPath,
      );
    }
    return {
      ok: true,
      data: {
        reader,
        entries,
        format,
        sha: shaOfBytes(bytes),
        totalBytes,
        warnings: ignored > 0 ? [`${ignored} archive member(s) excluded by ignore rules`] : [],
        encrypted,
        passwordSupplied: password !== undefined,
      },
    };
  } catch (error) {
    try {
      await reader?.close();
    } catch {
      // Preserve the primary archive error.
    }
    const message = error instanceof Error ? error.message : String(error);
    const unsupportedEncryption =
      /encrypted data is not currently supported|unsupported encryption/i.test(message);
    const passwordFailure = /passphrase|password|decrypt|encrypted/i.test(message);
    if (unsupportedEncryption) {
      return failure(
        "archive-encryption-unsupported",
        `encrypted ${format} archives are not supported by the active archive backend`,
        outerPath,
      );
    }
    if (password !== undefined && (encrypted || passwordFailure)) {
      return failure(
        "archive-password-invalid",
        "the resolved credential did not unlock the archive",
        outerPath,
      );
    }
    if (password === undefined && passwordFailure) {
      return failure(
        "archive-encrypted",
        "archive is password-protected; configure credentialRef to read it",
        outerPath,
      );
    }
    return failure("archive-corrupt", message.slice(0, 300), outerPath);
  }
}

function isLikelyTextMember(member: string): boolean {
  const lower = member.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && TEXT_EXTS.has(lower.slice(dot));
}

function decodeStrictText(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

async function extractEntry(
  _opened: OpenedArchive,
  entry: ArchiveEntry,
  outerPath: string,
): Promise<{ ok: true; bytes: Buffer; content?: string } | ArchiveFailure> {
  if (entry.size > ARCHIVE_LIMITS.maxMemberBytes) {
    return failure(
      "archive-member-too-large",
      `member bytes ${entry.size} exceed ${ARCHIVE_LIMITS.maxMemberBytes}`,
      outerPath,
      entry.member,
    );
  }
  try {
    const file = await entry.file.extract();
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length !== entry.size) {
      return failure(
        "archive-corrupt",
        `member size changed while extracting ${entry.member}: listed ${entry.size}, got ${bytes.length}`,
        outerPath,
        entry.member,
      );
    }
    return { ok: true, bytes, content: decodeStrictText(bytes) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/encrypted data is not currently supported|unsupported encryption/i.test(message)) {
      return failure(
        "archive-encryption-unsupported",
        `encrypted ${_opened.format} archives are not supported by the active archive backend`,
        outerPath,
        entry.member,
      );
    }
    if (_opened.encrypted && _opened.passwordSupplied) {
      return failure(
        "archive-password-invalid",
        "the resolved credential did not unlock the archive member",
        outerPath,
        entry.member,
      );
    }
    return failure(
      "archive-corrupt",
      message.slice(0, 300),
      outerPath,
      entry.member,
    );
  }
}

export async function readArchiveMember(
  bytes: Uint8Array,
  outerPath: string,
  member: string,
  workspace: string,
  password?: string,
): Promise<{ ok: true; data: ArchiveMemberText } | ArchiveFailure> {
  const normalized = normalizeMemberPath(member);
  if (!normalized.ok) return failure("archive-unsafe-path", normalized.reason, outerPath, member);
  const opened = await openArchive(bytes, outerPath, workspace, password);
  if (!opened.ok) return opened;
  try {
    const entry = opened.data.entries.find((candidate) => candidate.member === normalized.member);
    if (!entry) return failure("archive-entry-not-found", `archive member not found: ${normalized.member}`, outerPath, normalized.member);
    const extracted = await extractEntry(opened.data, entry, outerPath);
    if (!extracted.ok) return extracted;
    if (extracted.content === undefined) {
      return failure("archive-entry-binary", `archive member is binary or invalid UTF-8: ${normalized.member}`, outerPath, normalized.member);
    }
    return {
      ok: true,
      data: {
        outerPath,
        member: normalized.member,
        virtualPath: virtualArchivePath(outerPath, normalized.member),
        format: opened.data.format,
        archiveSha: opened.data.sha,
        content: extracted.content,
        bytes: extracted.bytes,
        sha: shaOfText(extracted.content),
      },
    };
  } finally {
    await opened.data.reader.close();
  }
}

export async function buildArchiveManifest(
  bytes: Uint8Array,
  outerPath: string,
  workspace: string,
  prefix?: string,
  password?: string,
): Promise<{ ok: true; data: ArchiveManifest } | ArchiveFailure> {
  const opened = await openArchive(bytes, outerPath, workspace, password);
  if (!opened.ok) return opened;
  try {
    const normalizedPrefix = prefix
      ? normalizeMemberPath(prefix.replace(/\/+$/, "")).ok
        ? (normalizeMemberPath(prefix.replace(/\/+$/, "")) as { ok: true; member: string }).member
        : prefix
      : undefined;
    const selected = normalizedPrefix
      ? opened.data.entries.filter((entry) => entry.member === normalizedPrefix || entry.member.startsWith(`${normalizedPrefix}/`))
      : opened.data.entries;
    const visible = selected.slice(0, ARCHIVE_LIMITS.maxManifestEntries);
    const entries = visible.map((entry) => {
      const virtualPath = virtualArchivePath(outerPath, entry.member);
      const handle = handleTable.upsert({
        kind: "file",
        path: virtualPath,
        workspaceRoot: workspace,
      });
      return {
        member: entry.member,
        virtual_path: virtualPath,
        kind: isLikelyTextMember(entry.member) ? "text" as const : "unknown" as const,
        size: entry.size,
        last_modified: entry.lastModified,
        handle: handle.id,
      };
    });
    const outerHandle = handleTable.upsert({
      kind: "file",
      path: outerPath,
      workspaceRoot: workspace,
      sha: opened.data.sha,
    });
    return {
      ok: true,
      data: {
        mode: "archive",
        kind: "archive",
        format: opened.data.format,
        path: outerPath,
        handle: outerHandle.id,
        sha: shortSha(opened.data.sha),
        entries,
        total_entries: selected.length,
        total_uncompressed_bytes: selected.reduce((sum, entry) => sum + entry.size, 0),
        truncated: entries.length < selected.length,
        warnings: opened.data.warnings,
        read_only: true,
      },
    };
  } finally {
    await opened.data.reader.close();
  }
}

function queryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  // Keep Latin identifiers separate from adjacent Japanese text
  // ("ZIP内のzip" -> "zip", "zip") so archive evidence ranking works for
  // multilingual prompts. Japanese runs remain useful for literal prose hits.
  const raw = [
    ...(lower.match(/[a-z0-9_.$-]{2,}/g) ?? []),
    ...(lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) ?? []),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw) {
    if (QUERY_STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 16) break;
  }
  return out;
}

function countMatches(text: string, token: string): number {
  let count = 0;
  let from = 0;
  while (count < 100) {
    const index = text.indexOf(token, from);
    if (index < 0) break;
    count += 1;
    from = index + Math.max(1, token.length);
  }
  return count;
}

function evidenceWindow(
  content: string,
  tokens: string[],
): { code: string; range: string; partial: boolean; remaining: string[]; lines: number[]; snippets: string[] } {
  const lines = content.split(/\r?\n/);
  const matching: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]!.toLowerCase();
    if (tokens.some((token) => lower.includes(token))) matching.push(i);
  }
  let start = 0;
  if (lines.length > ARCHIVE_LIMITS.maxSurfaceLines && matching.length > 0) {
    let bestScore = -1;
    for (const candidate of matching) {
      const candidateStart = Math.max(0, candidate - 20);
      const candidateEnd = Math.min(lines.length, candidateStart + ARCHIVE_LIMITS.maxSurfaceLines);
      const score = matching.filter((line) => line >= candidateStart && line < candidateEnd).length;
      if (score > bestScore) {
        bestScore = score;
        start = candidateStart;
      }
    }
  }
  const end = Math.min(lines.length, start + ARCHIVE_LIMITS.maxSurfaceLines);
  const range = `${start + 1}-${Math.max(start + 1, end)}`;
  const code = lines.slice(start, end).join("\n");
  const partial = start > 0 || end < lines.length;
  const remaining: string[] = [];
  if (start > 0) remaining.push(`1-${start}`);
  if (end < lines.length) remaining.push(`${end + 1}-${lines.length}`);
  const servedMatches = matching.filter((line) => line >= start && line < end).slice(0, 20);
  return {
    code,
    range,
    partial,
    remaining,
    lines: servedMatches.map((line) => line + 1),
    snippets: servedMatches.map((line) => lines[line]!.trim().slice(0, 160)),
  };
}

interface ScannedArchiveEntry {
  entry: ArchiveEntry;
  content: string;
  sha: string;
  score: number;
  window: ReturnType<typeof evidenceWindow>;
}

async function scanArchive(
  opened: OpenedArchive,
  outerPath: string,
  query: string,
): Promise<{ scanned: ScannedArchiveEntry[]; scannedEntries: number; omittedEntries: number; warnings: string[] }> {
  const tokens = queryTokens(query);
  const candidates = opened.entries
    .filter((entry) => isLikelyTextMember(entry.member) && entry.size <= ARCHIVE_LIMITS.maxMemberBytes)
    .sort((a, b) => {
      const aPath = a.member.toLowerCase();
      const bPath = b.member.toLowerCase();
      const aScore = tokens.reduce((score, token) => score + (aPath.includes(token) ? 20 : 0), 0);
      const bScore = tokens.reduce((score, token) => score + (bPath.includes(token) ? 20 : 0), 0);
      return bScore - aScore || a.member.localeCompare(b.member);
    });
  const scanned: ScannedArchiveEntry[] = [];
  let scannedEntries = 0;
  let scannedBytes = 0;
  for (const entry of candidates) {
    if (scannedEntries >= ARCHIVE_LIMITS.maxScanEntries) break;
    if (scannedBytes + entry.size > ARCHIVE_LIMITS.maxScanBytes) break;
    const extracted = await extractEntry(opened, entry, outerPath);
    scannedEntries += 1;
    scannedBytes += entry.size;
    if (!extracted.ok || extracted.content === undefined) continue;
    const lowerPath = entry.member.toLowerCase();
    const lowerContent = extracted.content.toLowerCase();
    const score = tokens.length === 0
      ? 1
      : tokens.reduce((sum, token) => (
          sum +
          (lowerPath.includes(token) ? 25 : 0) +
          Math.min(20, countMatches(lowerContent, token) * 2)
        ), 0);
    if (score <= 0) continue;
    scanned.push({
      entry,
      content: extracted.content,
      sha: shaOfText(extracted.content),
      score,
      window: evidenceWindow(extracted.content, tokens),
    });
  }
  scanned.sort((a, b) => b.score - a.score || a.entry.member.localeCompare(b.entry.member));
  const omittedEntries = Math.max(0, candidates.length - scannedEntries);
  return {
    scanned,
    scannedEntries,
    omittedEntries,
    warnings: omittedEntries > 0
      ? [`${omittedEntries} candidate archive member(s) were not scanned because of archive scan limits`]
      : [],
  };
}

export async function buildArchiveTaskPack(
  bytes: Uint8Array,
  outerPath: string,
  query: string,
  workspace: string,
  taskProfile: "answer" | "generic" = "generic",
  password?: string,
): Promise<{ ok: true; data: ArchiveTaskPack } | ArchiveFailure> {
  const opened = await openArchive(bytes, outerPath, workspace, password);
  if (!opened.ok) return opened;
  try {
    const scan = await scanArchive(opened.data, outerPath, query);
    const surfaces: ArchiveTaskSurface[] = [];
    let responseBytes = 0;
    const topScore = scan.scanned[0]?.score ?? 0;
    const evidenceFloor = Math.max(4, Math.ceil(topScore * 0.1));
    for (const candidate of scan.scanned.filter((entry) => entry.score >= evidenceFloor)) {
      const virtualPath = virtualArchivePath(outerPath, candidate.entry.member);
      const handle = handleTable.upsert({
        kind: "range",
        path: virtualPath,
        range: candidate.window.range,
        workspaceRoot: workspace,
        sha: candidate.sha,
      });
      const surface: ArchiveTaskSurface = {
        role: "unknown",
        handle: handle.id,
        path: virtualPath,
        container_path: outerPath,
        member_path: candidate.entry.member,
        range: candidate.window.range,
        code: candidate.window.code,
        why: `archive query evidence; score=${candidate.score}`,
        sha: shortSha(candidate.sha),
        ...(candidate.window.partial
          ? {
              content_completeness: "partial",
              remaining_ranges: candidate.window.remaining,
            }
          : {}),
      };
      const bytesForSurface = Buffer.byteLength(JSON.stringify(surface), "utf8");
      if (surfaces.length > 0 && responseBytes + bytesForSurface > ARCHIVE_LIMITS.maxSurfaceBytes) break;
      surfaces.push(surface);
      responseBytes += bytesForSurface;
      if (surfaces.length >= 3) break;
    }
    const complete = scan.omittedEntries === 0;
    const prepared = surfaces.length > 0 && complete;
    return {
      ok: true,
      data: {
        mode: "task_pack",
        coverage: complete ? "complete" : "partial",
        surfaces,
        missing: surfaces.length === 0 ? ["archive-query-evidence"] : [],
        archive: {
          path: outerPath,
          format: opened.data.format,
          sha: shortSha(opened.data.sha),
          total_entries: opened.data.entries.length,
          scanned_entries: scan.scannedEntries,
          omitted_entries: scan.omittedEntries,
          read_only: true,
        },
        route: {
          action: prepared ? "answer_from_surfaces" : "narrow_archive_query",
          reason: prepared
            ? "archive evidence is resident; answer from served member slices"
            : "archive scan was incomplete or found no evidence; narrow with archive.prefix/member",
          max_additional_tl_calls: prepared ? 0 : 1,
        },
        task_profile: taskProfile,
        execution_contract: {
          phase: prepared ? "prepared" : "discovery",
          unresolved: prepared ? [] : ["archive-query-evidence"],
          allowed: prepared
            ? taskProfile === "generic" ? ["edit"] : []
            : ["read", "search"],
          ...(prepared
            ? {
                required_action: taskProfile === "answer"
                  ? "Answer from the served archive member slices; archive members are read-only."
                  : "Use the served evidence to edit only non-archive targets; archive members are read-only.",
              }
            : {}),
        },
        warnings: [...opened.data.warnings, ...scan.warnings],
      },
    };
  } finally {
    await opened.data.reader.close();
  }
}

export async function findInArchive(
  bytes: Uint8Array,
  outerPath: string,
  query: string,
  workspace: string,
  password?: string,
): Promise<{ ok: true; data: ArchiveFindResult } | ArchiveFailure> {
  const opened = await openArchive(bytes, outerPath, workspace, password);
  if (!opened.ok) return opened;
  try {
    const scan = await scanArchive(opened.data, outerPath, query);
    const files = scan.scanned.slice(0, 20).map((candidate) => {
      const virtualPath = virtualArchivePath(outerPath, candidate.entry.member);
      const handle = handleTable.upsert({
        kind: "range",
        path: virtualPath,
        range: candidate.window.range,
        workspaceRoot: workspace,
        sha: candidate.sha,
      });
      return {
        path: virtualPath,
        member: candidate.entry.member,
        lines: candidate.window.lines,
        snippets: candidate.window.snippets,
        handle: handle.id,
        range: candidate.window.range,
        context: candidate.window.code,
      };
    });
    const totalMatches = files.reduce((sum, file) => sum + file.lines.length, 0);
    const complete = scan.omittedEntries === 0;
    const tokens = queryTokens(query);
    return {
      ok: true,
      data: {
        query,
        files,
        total_files: files.length,
        total_matches: totalMatches,
        truncated: !complete || scan.scanned.length > files.length,
        literal: true,
        archive_scope: {
          path: outerPath,
          format: opened.data.format,
          entries: opened.data.entries.length,
          scanned_entries: scan.scannedEntries,
          omitted_entries: scan.omittedEntries,
        },
        ...(files.length === 0 && complete
          ? {
              absence: {
                scanned_files: scan.scannedEntries,
                tokens,
                conclusion: `no scanned text member in ${outerPath} contains the query evidence`,
              },
            }
          : {}),
        warnings: [...opened.data.warnings, ...scan.warnings],
      },
    };
  } finally {
    await opened.data.reader.close();
  }
}

export async function archiveTree(
  bytes: Uint8Array,
  outerPath: string,
  workspace: string,
  prefix?: string,
  password?: string,
): Promise<{ ok: true; data: { root: string; tree: string; truncated: boolean; total_entries: number; format: ArchiveFormat; warnings: string[] } } | ArchiveFailure> {
  const manifest = await buildArchiveManifest(bytes, outerPath, workspace, prefix, password);
  if (!manifest.ok) return manifest;
  const tree = manifest.data.entries.map((entry) => entry.member).join("\n");
  return {
    ok: true,
    data: {
      root: `${outerPath}!/`,
      tree,
      truncated: manifest.data.truncated,
      total_entries: manifest.data.total_entries,
      format: manifest.data.format,
      warnings: manifest.data.warnings,
    },
  };
}
