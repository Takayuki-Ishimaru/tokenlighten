/**
 * process.ts — PID file management and daemon shutdown helpers.
 *
 * PID file format (JSON, written via atomicWrite.ts):
 *   { pid: number, port?: number, started_at_unix: number, command: string,
 *     instance_id?: string, identity_token?: string }
 *
 * Shutdown order for each daemon type:
 *   mcp  : SIGTERM (5s, POSIX) / taskkill (Windows) → SIGKILL (1s)
 *
 * Design refs:
 *   - docs/components/06-platform-support.md §2.2 (graceful shutdown)
 *   - docs/components/05-vscode-extension.md §3.2.1 (spawn pattern)
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  lstatSync,
} from "fs";
import { dirname } from "path";
import { makeTmpPath, retryRename } from "./atomicWrite.js";
import { spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// PID file schema
// ---------------------------------------------------------------------------

export interface PidFileData {
  pid: number;
  port?: number;
  started_at_unix: number;
  command: string;
  instance_id?: string;
  identity_token?: string;
}

const MAX_PID_FILE_BYTES = 4096;

function isValidPidFileData(value: unknown): value is PidFileData {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (!Number.isSafeInteger(data["pid"]) || Number(data["pid"]) <= 0 || Number(data["pid"]) > 0x7fffffff) {
    return false;
  }
  if (
    !Number.isSafeInteger(data["started_at_unix"])
    || Number(data["started_at_unix"]) <= 0
    || Number(data["started_at_unix"]) > Math.floor(Date.now() / 1000) + 300
  ) {
    return false;
  }
  if (typeof data["command"] !== "string" || data["command"].length === 0 || data["command"].length > 2048) {
    return false;
  }
  if (
    data["port"] !== undefined
    && (!Number.isSafeInteger(data["port"]) || Number(data["port"]) < 1 || Number(data["port"]) > 65535)
  ) {
    return false;
  }
  if (
    data["instance_id"] !== undefined
    && (typeof data["instance_id"] !== "string" || !/^[a-f0-9]{32}$/.test(data["instance_id"]))
  ) {
    return false;
  }
  if (
    data["identity_token"] !== undefined
    && (
      typeof data["identity_token"] !== "string"
      || data["identity_token"].length === 0
      || data["identity_token"].length > 2048
      || /[\0\r\n]/.test(data["identity_token"])
    )
  ) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// PID file I/O
// ---------------------------------------------------------------------------

/**
 * Write a PID file atomically.
 * Creates parent directories (mode 0700) if necessary.
 */
export function writePidFile(pidPath: string, data: PidFileData): void {
  if (!isValidPidFileData(data)) throw new Error("Invalid PID file data");
  const dir = dirname(pidPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(pidPath) && lstatSync(pidPath).isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked PID file: ${pidPath}`);
  }

  const tmp = makeTmpPath(pidPath);
  writeFileSync(tmp, JSON.stringify(data), { encoding: "utf-8", mode: 0o600, flag: "wx" });
  retryRename(tmp, pidPath);
}

/**
 * Read and parse a PID file.
 * Returns null if the file does not exist or is unparseable.
 */
export function readPidFile(pidPath: string): PidFileData | null {
  if (!existsSync(pidPath)) return null;
  try {
    const stat = lstatSync(pidPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_PID_FILE_BYTES) return null;
    const raw = readFileSync(pidPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isValidPidFileData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remove a PID file if it exists (best-effort, no throw).
 */
export function removePidFile(pidPath: string): void {
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Process liveness check
// ---------------------------------------------------------------------------

/**
 * Check whether a process with the given PID is alive (signal 0).
 * Returns false if the PID does not exist; a permission-denied error
 * (EPERM) still counts as alive, since the process exists but cannot be
 * signalled.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means process exists but we can't signal it — still alive
    if (code === "EPERM") return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sleep helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Signal-based shutdown (POSIX / Windows fallback)
// ---------------------------------------------------------------------------

/**
 * Send SIGTERM to a process on POSIX, or taskkill /F /PID on Windows.
 * Returns true if the signal was delivered without error.
 */
function sendTermSignal(pid: number): boolean {
  if (process.platform === "win32") {
    const res = spawnSync("taskkill", ["/F", "/PID", String(pid)], { shell: false });
    return res.status === 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * Send SIGKILL to a process on POSIX, or taskkill /F /PID on Windows.
 * Returns true if the signal was delivered without error.
 */
function sendKillSignal(pid: number): boolean {
  if (process.platform === "win32") {
    const res = spawnSync("taskkill", ["/F", "/PID", String(pid)], { shell: false });
    return res.status === 0;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

export function buildWindowsProcessIdentityScript(data: PidFileData): string {
  const escapedIdentity = (data.identity_token ?? data.command).replace(/'/g, "''");
  return [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${data.pid}"`,
    "if ($null -eq $p) { exit 1 }",
    `$needle = '${escapedIdentity}'`,
    "if ([string]::IsNullOrEmpty($p.CommandLine) -or $p.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { exit 2 }",
  ].join("; ");
}

export function processMatchesPidFile(data: PidFileData): boolean {
  if (process.platform === "win32") {
    const script = buildWindowsProcessIdentityScript(data);
    return spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { shell: false, stdio: "ignore" },
    ).status === 0;
  }

  const result = spawnSync(
    "ps",
    ["eww", "-p", String(data.pid), "-o", "command="],
    { shell: false, encoding: "utf8" },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return false;
  const actual = result.stdout.trim();
  if (!actual.includes(data.command)) return false;
  return data.instance_id === undefined
    || actual.includes(`TOKENLIGHTEN_INSTANCE_ID=${data.instance_id}`);
}

// ---------------------------------------------------------------------------
// High-level shutdown routines
// ---------------------------------------------------------------------------

/**
 * Gracefully stop the MCP server daemon:
 *   1. SIGTERM / taskkill (on Windows)
 *   2. Wait up to 5s
 *   3. SIGKILL
 *
 * Removes the PID file on success.
 */
export async function stopMcp(
  pidPath: string,
  pid: number,
  options: { verifyIdentity?: (data: PidFileData) => boolean } = {},
): Promise<void> {
  const data = readPidFile(pidPath);
  if (!data || data.pid !== pid) {
    throw new Error(`Refusing to stop PID ${pid}: PID file is missing, invalid, or changed`);
  }
  if (!isPidAlive(pid)) {
    removePidFile(pidPath);
    return;
  }
  const verifyIdentity = options.verifyIdentity ?? processMatchesPidFile;
  if (!verifyIdentity(data)) {
    throw new Error(`Refusing to stop PID ${pid}: process identity does not match the PID file`);
  }

  // Step 1: SIGTERM (POSIX) or taskkill (Windows)
  sendTermSignal(pid);

  // Step 2: wait up to 5s
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      removePidFile(pidPath);
      return;
    }
    await sleep(100);
  }

  // Step 3: SIGKILL
  if (!verifyIdentity(data)) {
    throw new Error(`Refusing to force-kill PID ${pid}: process identity changed`);
  }
  sendKillSignal(pid);
  await sleep(1000);

  if (!isPidAlive(pid)) {
    removePidFile(pidPath);
    return;
  }

  // Process survived — remove PID file and warn
  removePidFile(pidPath);
  throw new Error(`Failed to stop MCP server (PID ${pid}): process still alive after SIGKILL`);
}
