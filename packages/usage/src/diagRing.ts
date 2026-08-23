// diagRing.ts — the VS Code extension's diagnostics view and the MCP server
// share nothing at runtime (the extension is not on the server's stdio
// pipe), so "what did the last call do" can only cross that gap through a
// small file on disk. This module IS that file's schema, its exact key
// derivation, and the read/write functions. It is imported by
// @tokenlighten/mcp-server (the writer, via packages/usage) and by
// tokenlighten-vscode-extension (the reader, via the same package export) so
// both sides compute the SAME path from the SAME workspace root without any
// other coordination.
//
// Privacy: a ring entry carries only {at, tool, mode, kind, ms, ok,
// error_code, retry, field} — never a query string, file path, handle, or response/error
// message text. `mode`, `kind`, and `error_code` are always short enum-like
// tokens the caller has already validated against a known allowlist; this
// module re-validates defensively (type + length caps) before anything
// reaches disk.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** One call recorded in a workspace's diagnostics ring. */
export interface DiagRingCall {
  at: string;
  tool: string;
  mode?: string;
  kind?: string;
  ms: number;
  ok: boolean;
  error_code?: string;
  /** Refusal transition token, never explanatory text. */
  retry?: string;
  /** Refusal argument name only; never a value, path, or free text. */
  field?: string;
}

/** The whole ring file for one workspace. */
export interface DiagRingFile {
  v: 1;
  workspace_key: string;
  server_version: string;
  /** Exact build identity of the MCP server process, when available. */
  server_build?: string;
  pid: number;
  updated_at: string;
  calls: DiagRingCall[];
}

/** Ring capacity: only the most recent calls are kept, oldest evicted first. */
export const DIAG_RING_MAX_CALLS = 20;

/**
 * Fixed, homedir-relative location — deliberately NOT `defaultLogDir()` from
 * ./index.js, which honors TOKENLIGHTEN_HOME/TOKENLIGHTEN_LOG_HOME overrides
 * the extension has no way to learn about. The extension and the server must
 * resolve to the identical path with zero coordination, so this always uses
 * `os.homedir()` only — the same way on every platform, Windows included.
 */
export function defaultDiagDir(): string {
  return join(homedir(), ".tokenlighten", "diag");
}

/**
 * The ring file's key: the first 16 hex characters of the SHA-256 digest of
 * the workspace root's REAL (symlink-resolved) absolute path, taken with
 * `fs.realpathSync.native` and no salt. Deliberately unsalted — unlike the
 * usage log's workspaceId — because the extension must derive the identical
 * key from a cold start with no access to the server's `.privacy-salt` file
 * and no IPC channel to request one. The key never leaves the local
 * filesystem; it is a filename, not a shared or transmitted identifier.
 *
 * THE SAME FUNCTION must be used on both sides (server: via
 * @tokenlighten/usage; extension: the same package export) — do not
 * re-implement this derivation anywhere else.
 */
export function diagWorkspaceKey(workspaceRoot: string): string {
  const real = realpathSync.native(resolve(workspaceRoot));
  return createHash("sha256").update(real, "utf8").digest("hex").slice(0, 16);
}

export function diagRingFilePath(
  workspaceRoot: string,
  directory: string = defaultDiagDir(),
): string {
  return join(resolve(directory), `${diagWorkspaceKey(workspaceRoot)}.json`);
}

function ensurePrivateDiagDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("TokenLighten diagnostics destination must be a real directory");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
}

function sanitizeCall(call: DiagRingCall): DiagRingCall {
  const clean: DiagRingCall = {
    at: typeof call.at === "string" ? call.at : new Date().toISOString(),
    tool: typeof call.tool === "string" ? call.tool.slice(0, 32) : "unknown",
    ms: Number.isFinite(call.ms) ? Math.max(0, Math.round(call.ms)) : 0,
    ok: call.ok === true,
  };
  if (typeof call.mode === "string" && call.mode.length > 0 && call.mode.length <= 32) {
    clean.mode = call.mode;
  }
  if (typeof call.kind === "string" && call.kind.length > 0 && call.kind.length <= 64) {
    clean.kind = call.kind;
  }
  if (
    typeof call.error_code === "string"
    && call.error_code.length > 0
    && call.error_code.length <= 64
  ) {
    clean.error_code = call.error_code;
  }
  if (typeof call.retry === "string" && /^[a-z][a-z-]{0,31}$/.test(call.retry)) {
    clean.retry = call.retry;
  }
  if (typeof call.field === "string" && /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,63}$/.test(call.field)) {
    clean.field = call.field;
  }
  return clean;
}

function isDiagRingCall(value: unknown): value is DiagRingCall {
  if (!value || typeof value !== "object") return false;
  const call = value as Partial<DiagRingCall>;
  return typeof call.at === "string"
    && typeof call.tool === "string"
    && typeof call.ms === "number"
    && typeof call.ok === "boolean"
    && (call.mode === undefined || typeof call.mode === "string")
    && (call.kind === undefined || typeof call.kind === "string")
    && (call.error_code === undefined || typeof call.error_code === "string")
    && (call.retry === undefined || typeof call.retry === "string")
    && (call.field === undefined || typeof call.field === "string");
}

function isDiagRingFile(value: unknown): value is DiagRingFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<DiagRingFile>;
  return file.v === 1
    && typeof file.workspace_key === "string"
    && typeof file.server_version === "string"
    && (file.server_build === undefined || typeof file.server_build === "string")
    && typeof file.pid === "number"
    && typeof file.updated_at === "string"
    && Array.isArray(file.calls)
    && file.calls.every(isDiagRingCall);
}

/**
 * Best-effort read: a missing, corrupt, or foreign-shaped file yields
 * `null`, never a thrown error — this is a diagnostics aid, not a data
 * source anything else depends on.
 */
export function readDiagRingFile(
  workspaceRoot: string,
  directory: string = defaultDiagDir(),
): DiagRingFile | null {
  try {
    const filePath = diagRingFilePath(workspaceRoot, directory);
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isDiagRingFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Appends one call to the workspace's ring file, capped at
 * `DIAG_RING_MAX_CALLS`, written atomically (tmp file + rename) at mode
 * 0600 with no fsync. Swallows every error — a diagnostics mirror must
 * never affect an MCP call's outcome or add more than one small synchronous
 * write to its latency budget.
 *
 * Callers gate this the same way as the usage recorder (disabled by
 * TOKENLIGHTEN_USAGE_LOG=off / NODE_ENV=test) BEFORE calling it; this
 * function performs no gating of its own.
 *
 * Multi-writer note: two server processes bound to the same workspace root
 * (e.g. two VS Code windows) both read-modify-write this file. Each write is
 * atomic (never corrupt), but a race can lose one writer's entry — acceptable
 * for a best-effort "last calls" mirror, not for anything billing-relevant.
 */
export function recordDiagCall(options: {
  workspaceRoot: string;
  serverVersion: string;
  serverBuild?: string;
  call: DiagRingCall;
  directory?: string;
}): void {
  try {
    const directory = resolve(options.directory ?? defaultDiagDir());
    ensurePrivateDiagDir(directory);
    const key = diagWorkspaceKey(options.workspaceRoot);
    const filePath = join(directory, `${key}.json`);
    const existing = readDiagRingFile(options.workspaceRoot, directory);
    const calls = [...(existing?.calls ?? []), sanitizeCall(options.call)]
      .slice(-DIAG_RING_MAX_CALLS);
    const next: DiagRingFile = {
      v: 1,
      workspace_key: key,
      server_version: options.serverVersion,
      ...(typeof options.serverBuild === "string"
        && options.serverBuild.length > 0
        && options.serverBuild.length <= 128
        ? { server_build: options.serverBuild }
        : {}),
      pid: process.pid,
      updated_at: new Date().toISOString(),
      calls,
    };
    const tmpPath = join(directory, `.diag-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch {
    // Diagnostics mirror is best-effort and must never affect the MCP call outcome.
  }
}
