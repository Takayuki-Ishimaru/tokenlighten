// MCP-only config-file writer — DESIGN-v0.14-mcp-only-install.md §4.3
// "Config-file writer" mechanism (NEW). Targets files whose entire purpose is
// MCP server registration (first host: GitHub Copilot CLI's
// `~/.copilot/mcp-config.json`; Phase B adds Cursor/Windsurf/Kiro/Amazon Q).
//
// Reuses the atomic-write primitive from `commands/workspace.ts` so every
// generated file on disk goes through one JSON-writing implementation, and
// never throws — every failure mode surfaces as a typed `refused` result so
// callers (the `clients` engine, `tl doctor`) can report a reason instead of
// catching an exception.

import { copyFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { objectMember, readJsonObject, writeJsonAtomic } from "./commands/workspace.js";

// Classifies a write-phase failure (from `objectMember`/`writeJsonAtomic`,
// called after `tryReadDocument` already succeeded) into a specific code
// instead of the previous catch-all "unsafe-path" — a missing parent
// directory, a symlinked parent/target, and a rootKey whose existing value
// isn't a JSON object are three distinct, actionable causes that "unsafe-path"
// used to conflate (review d: "the reported reason will mislead").
function classifyWriteFailure(error: unknown, file: string): McpConfigRefusalCode {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("symlink")) return "symlink-target";
  // `objectMember`'s own wording: `Expected '<key>' to be a JSON object`.
  if (/^Expected '.*' to be a JSON object$/.test(message)) return "not-json";
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if ((code === "ENOENT" || code === "ENOTDIR") && !existsSync(dirname(file))) {
    return "parent-missing";
  }
  return "unsafe-path";
}

export interface McpConfigFileTarget {
  /** Absolute path to the config file (e.g. `~/.copilot/mcp-config.json`). */
  file: string;
  /** Top-level key holding the map of server name -> entry (e.g. `"mcpServers"`). */
  rootKey: string;
  /** Server name/key under `rootKey` — always `"tokenlighten"` today. */
  name: string;
}

export interface ManagedEntryShape {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export type McpConfigRefusalCode =
  | "invalid-json"
  | "foreign-entry"
  | "unsafe-path"
  | "malformed-document"
  | "parent-missing"
  | "symlink-target"
  | "not-json";

export interface McpConfigRefusal {
  ok: false;
  refused: true;
  code: McpConfigRefusalCode;
  file: string;
  detail: string;
}

// Ownership mirrors `commands/clients.ts`'s `managedEntry()` rule: the
// `TOKENLIGHTEN_MANAGED=1` marker, plus (when the caller supplies one) an
// args-PREFIX match — a registered entry may carry trailing flags
// (`--allow-write`, `--tool-surface code`, ...) beyond the fixed prefix.
function isManagedEntry(
  entry: ManagedEntryShape | undefined,
  expectedArgsPrefix?: readonly string[],
): boolean {
  if (!entry) return false;
  if (entry.env?.["TOKENLIGHTEN_MANAGED"] !== "1") return false;
  if (!expectedArgsPrefix) return true;
  return Array.isArray(entry.args)
    && entry.args.length >= expectedArgsPrefix.length
    && expectedArgsPrefix.every((value, index) => entry.args?.[index] === value);
}

type DocumentRead =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; detail: string };

function tryReadDocument(file: string): DocumentRead {
  if (!existsSync(file)) return { ok: true, document: {} };
  try {
    // `readJsonObject` uses plain `JSON.parse`, which is already strict
    // (comments and trailing commas both throw) — exactly the refusal
    // condition the design calls for.
    return { ok: true, document: readJsonObject(file) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function invalidJsonRefusal(file: string, detail: string): McpConfigRefusal {
  return {
    ok: false,
    refused: true,
    code: "invalid-json",
    file,
    detail: `${file} is not valid JSON (comments and trailing commas are not supported): ${detail}`,
  };
}

export interface ReadManagedEntryResult {
  /** Whether an entry currently exists under `rootKey[name]`. */
  exists: boolean;
  /** Whether that entry is ours (only meaningful when `exists`). */
  managed: boolean;
  entry?: ManagedEntryShape;
  /** The file exists but failed strict JSON parsing. */
  parseError?: boolean;
}

export function readManagedEntry(
  target: McpConfigFileTarget,
  expectedArgsPrefix?: readonly string[],
): ReadManagedEntryResult {
  const read = tryReadDocument(target.file);
  if (!read.ok) return { exists: existsSync(target.file), managed: false, parseError: true };
  const rootValue = read.document[target.rootKey];
  const entryValue = rootValue && typeof rootValue === "object" && !Array.isArray(rootValue)
    ? (rootValue as Record<string, unknown>)[target.name]
    : undefined;
  if (!entryValue || typeof entryValue !== "object" || Array.isArray(entryValue)) {
    return { exists: false, managed: false };
  }
  const entry = entryValue as ManagedEntryShape;
  return { exists: true, managed: isManagedEntry(entry, expectedArgsPrefix), entry };
}

function backupFilePath(file: string): string {
  return `${file}.tl-backup`;
}

// Back up once — before the FIRST write this install has ever made to a
// pre-existing file. A `.tl-backup` that already exists holds the pristine
// pre-TokenLighten content, so a second run must never overwrite it with an
// already-modified copy.
function ensureBackup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const backup = backupFilePath(file);
  if (existsSync(backup)) return undefined;
  copyFileSync(file, backup);
  return backup;
}

export interface WriteManagedEntryOptions extends McpConfigFileTarget {
  entry: Record<string, unknown>;
  force?: boolean;
  expectedArgsPrefix?: readonly string[];
}

export type WriteManagedEntryResult =
  | { ok: true; action: "created" | "updated"; file: string; backupFile?: string }
  | McpConfigRefusal;

export function writeManagedEntry(options: WriteManagedEntryOptions): WriteManagedEntryResult {
  const read = tryReadDocument(options.file);
  if (!read.ok) return invalidJsonRefusal(options.file, read.detail);

  try {
    const document = read.document;
    const root = objectMember(document, options.rootKey);
    const existingRaw = root[options.name];
    const existing = existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)
      ? (existingRaw as ManagedEntryShape)
      : undefined;
    const action: "created" | "updated" = existingRaw === undefined ? "created" : "updated";
    if (existingRaw !== undefined && !options.force && !isManagedEntry(existing, options.expectedArgsPrefix)) {
      return {
        ok: false,
        refused: true,
        code: "foreign-entry",
        file: options.file,
        detail: `A non-managed '${options.name}' entry already exists under '${options.rootKey}' in ${options.file}; pass force to overwrite it.`,
      };
    }
    const backupFile = ensureBackup(options.file);
    // Reassigning an existing key's value preserves its original position —
    // "preserve other keys and key order" holds for both create and update.
    root[options.name] = options.entry;
    writeJsonAtomic(dirname(options.file), options.file, document);
    return { ok: true, action, file: options.file, ...(backupFile ? { backupFile } : {}) };
  } catch (error) {
    return {
      ok: false,
      refused: true,
      code: classifyWriteFailure(error, options.file),
      file: options.file,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface RemoveManagedEntryOptions extends McpConfigFileTarget {
  force?: boolean;
  expectedArgsPrefix?: readonly string[];
}

export type RemoveManagedEntryResult =
  | { ok: true; action: "removed" | "absent"; file: string }
  | McpConfigRefusal;

export function removeManagedEntry(options: RemoveManagedEntryOptions): RemoveManagedEntryResult {
  const read = tryReadDocument(options.file);
  if (!read.ok) return invalidJsonRefusal(options.file, read.detail);

  try {
    const document = read.document;
    const rootValue = document[options.rootKey];
    const root = rootValue && typeof rootValue === "object" && !Array.isArray(rootValue)
      ? (rootValue as Record<string, unknown>)
      : undefined;
    const existingRaw = root?.[options.name];
    if (existingRaw === undefined) {
      return { ok: true, action: "absent", file: options.file };
    }
    const existing = existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)
      ? (existingRaw as ManagedEntryShape)
      : undefined;
    if (!options.force && !isManagedEntry(existing, options.expectedArgsPrefix)) {
      return {
        ok: false,
        refused: true,
        code: "foreign-entry",
        file: options.file,
        detail: `A non-managed '${options.name}' entry exists under '${options.rootKey}' in ${options.file}; pass force to remove it.`,
      };
    }
    ensureBackup(options.file);
    delete (root as Record<string, unknown>)[options.name];
    writeJsonAtomic(dirname(options.file), options.file, document);
    return { ok: true, action: "removed", file: options.file };
  } catch (error) {
    return {
      ok: false,
      refused: true,
      code: classifyWriteFailure(error, options.file),
      file: options.file,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
