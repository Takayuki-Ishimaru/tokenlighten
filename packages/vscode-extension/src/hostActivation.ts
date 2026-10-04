// Plain data output — no meta envelope. See docs/00-postmortem.md §2.2.
//
// hostActivation.ts — the extension half of the window-scoped TokenLighten off
// switch (2026-10-02). The server half, with the whole contract, the reading
// rules and the reasons behind them, is packages/mcp-server/src/mcp/
// hostActivation.ts.
//
// THE GAP. A workspace set up with `tl workspace setup` has a managed
// `.vscode/mcp.json` entry, so VS Code — not this extension — launches the
// TokenLighten server, and mcpProvider.ts (which returns no definition for such
// a folder) cannot stop it. `tokenlighten.enabled = false` and the
// `tokenlighten.session.native` command therefore never reached it: a real
// Copilot session kept calling `tl_read_file` after both. This module hands the
// server a per-folder override file it can see:
//
//   <folder>/.tokenlighten/host-activation.json
//   { "schemaVersion": 1, "client": "vscode", "state": "disabled" | "native",
//     "ownerPid": <this extension host's pid>, "updatedAt": "<ISO-8601>" }
//
// The file means something only while `ownerPid` runs AND the file is fresh
// (`updatedAt` no older than HOST_ACTIVATION_TTL_MS, and none more than
// HOST_ACTIVATION_FUTURE_SKEW_MS in the future), so a window that crashed leaves
// nothing behind that switches TokenLighten off, and the native bypass (which is
// window-scoped, never persisted) ends with its window. A live pid alone proves
// nothing — the OS reuses pids, and a file committed to a repository names
// someone else's — so freshness is what shows a writer still exists.
//
// HEARTBEAT. While any managed folder wants a state, the sync re-runs every
// HOST_ACTIVATION_HEARTBEAT_MS, and a sync REWRITES this window's own file (fresh
// `updatedAt`) once it is older than half the TTL. That also puts back a file
// another window removed: two windows on one folder share the one file, last
// writer wins, and each window's next heartbeat re-asserts its own state. The
// timer is registered by `registerHostActivation`, exists only while there is
// something to keep fresh, and is cleared on deactivate.
//
// WHAT IS WRITTEN WHERE. For every workspace folder whose `.vscode/mcp.json`
// is TokenLighten-managed (the only folders where VS Code, not this extension,
// owns the server): `native` while the session bypass is on, else `disabled`
// while `tokenlighten.enabled` is false for that folder (resource-scoped), else
// no file. A folder that is not managed never gets a `.tokenlighten/` created
// by this module — its server is the provider's, and the provider simply
// returns no definition (mcpProvider.ts).
//
// WHAT IS REMOVED. Only a file this window owns (`ownerPid === process.pid`) or
// a STALE one: owner gone, not refreshed within the TTL, or dated beyond the
// skew in the future — exactly the files the server ignores, so removing one never
// switches off a live window. A fresh file of another live window is never
// touched.
//
// Everything here is best effort and synchronous: a failure is reported once
// on the console and never thrown into VS Code.
//
// IMPORT-CYCLE NOTE: mcpProvider.ts imports `syncHostActivationOverrides` from
// here (its `setNativeSessionBypass`), and this file reads the bypass flag back
// from mcpProvider.ts. Both bindings are used only inside function bodies at
// call time, never while a module evaluates, so the cycle is safe — the same
// arrangement the server's transports use with server.ts.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import * as vscode from "vscode";
import { nativeSessionBypassEnabled } from "./mcpProvider.js";
import { vscodeMcpJsonManaged } from "./workspaceState.js";

export type HostActivationState = "disabled" | "native";

/**
 * How often the sync re-runs while any managed folder wants a state. Keep the
 * three timing constants equal to the server's (packages/mcp-server/src/mcp/
 * hostActivation.ts); hostActivation.spec.ts compares the two sources.
 */
export const HOST_ACTIVATION_HEARTBEAT_MS = 30_000;
/** An override older than this (by its `updatedAt`) is not live, whatever its owner pid does. */
export const HOST_ACTIVATION_TTL_MS = 90_000;
/** An override dated further than this into the future is not live (same host, same clock). */
export const HOST_ACTIVATION_FUTURE_SKEW_MS = 60_000;

interface OverrideRecord {
  readonly schemaVersion: 1;
  readonly client: "vscode";
  readonly state: HostActivationState;
  readonly ownerPid: number;
  readonly updatedAt: string;
}

const OVERRIDE_DIR = ".tokenlighten";
const OVERRIDE_FILE = "host-activation.json";
/** The server ignores anything larger; a v1 record is about 120 bytes. */
const MAX_BYTES = 4096;
/** The exact key set of a v1 record, sorted — the server accepts nothing else. */
const RECORD_KEYS = ["client", "ownerPid", "schemaVersion", "state", "updatedAt"] as const;

/** Workspace folder roots this window has written an override into, so a folder it stops hosting is cleaned. */
const written = new Set<string>();
/** Failures already reported, so a persistent problem is one console line, not one per sync. */
const reported = new Set<string>();

export function hostActivationOverridePath(root: string): string {
  return join(root, OVERRIDE_DIR, OVERRIDE_FILE);
}

function reportFailure(action: string, root: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // Keyed on the errno code, not the message: a message names the random temp
  // file of that attempt, so it would never repeat.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const key = `${action}|${root}|${code ?? message}`;
  if (reported.has(key)) return;
  if (reported.size >= 64) reported.clear();
  reported.add(key);
  console.warn(`TokenLighten: could not ${action} for ${root}: ${message}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Whether the process that wrote an override still runs; EPERM means it exists but is not ours to signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** The same validation the server applies (mcp-server's hostActivation.ts), so a file this module treats as valid is one the server honors. */
function parseRecord(text: string): OverrideRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) return undefined;
  const { schemaVersion, client, state, ownerPid, updatedAt } = record;
  if (schemaVersion !== 1 || client !== "vscode") return undefined;
  if (state !== "disabled" && state !== "native") return undefined;
  if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) return undefined;
  if (typeof updatedAt !== "string" || updatedAt.length === 0 || updatedAt.length > 64 || Number.isNaN(Date.parse(updatedAt))) {
    return undefined;
  }
  return { schemaVersion, client, state, ownerPid, updatedAt };
}

interface ReadOverride {
  readonly record: OverrideRecord;
  readonly stat: Stats;
}

/** The valid record in `file` and the identity of the file it came from; `undefined` for a missing, symlinked, oversize or invalid file. */
function readOverride(file: string): ReadOverride | undefined {
  let fd: number | undefined;
  try {
    const listed = lstatSync(file);
    if (!listed.isFile() || listed.size > MAX_BYTES) return undefined;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(opened.size);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    const record = parseRecord(buffer.toString("utf8", 0, filled));
    return record === undefined ? undefined : { record, stat: opened };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // a descriptor opened only to read
      }
    }
  }
}

/** `lstat`, never `stat`: a symlinked `.tokenlighten` is not a directory this module will use. */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Milliseconds since `record` was stamped; negative when it is dated in the future. */
function ageOf(record: OverrideRecord, nowMs: number): number {
  return nowMs - Date.parse(record.updatedAt);
}

/**
 * The server's liveness rule, inverted: a record is stale when it was not
 * refreshed within the TTL, when it is dated beyond the skew in the future, or
 * when its owner is gone. A stale record is one the server ignores whoever's pid
 * it names, so removing it can never switch off a live window. (`!(a <= b)`:
 * an age that is not a number is stale.)
 */
function isStale(record: OverrideRecord, nowMs: number): boolean {
  const ageMs = ageOf(record, nowMs);
  if (!(ageMs <= HOST_ACTIVATION_TTL_MS) || ageMs < -HOST_ACTIVATION_FUTURE_SKEW_MS) return true;
  return !isProcessAlive(record.ownerPid);
}

/**
 * This window's own record is rewritten once it is older than half the TTL — or
 * dated so far ahead that the server ignores it (the clock stepped back).
 */
function needsRefresh(record: OverrideRecord, nowMs: number): boolean {
  const ageMs = ageOf(record, nowMs);
  return !(ageMs <= HOST_ACTIVATION_TTL_MS / 2) || ageMs < -HOST_ACTIVATION_FUTURE_SKEW_MS;
}

/**
 * Removes the override under `root` when this window owns it — or, with
 * `includeStale`, when it is stale (owner gone, not refreshed within the TTL, or
 * dated beyond the skew in the future). Never touches a fresh file whose live
 * owner is another window.
 */
function removeOverride(root: string, includeStale: boolean): void {
  if (!isRealDirectory(join(root, OVERRIDE_DIR))) return;
  const file = hostActivationOverridePath(root);
  const found = readOverride(file);
  if (found === undefined) return;
  const ours = found.record.ownerPid === process.pid;
  if (!ours && !(includeStale && isStale(found.record, Date.now()))) return;
  try {
    // Another window may have replaced the file since it was read; delete only
    // the file that was judged. (Windows file ids are not reliable here, so the
    // check is POSIX-only; the window it narrows is a few microseconds.)
    if (process.platform !== "win32") {
      const now = lstatSync(file);
      if (now.ino !== found.stat.ino || now.dev !== found.stat.dev) return;
    }
    unlinkSync(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Atomically (temp file in the same directory, then rename) writes this
 * window's override. Returns false, writing nothing, when a symlink or a
 * non-directory stands where `.tokenlighten` or the file should be. A file this
 * window wrote with the same state is left alone only while it is fresh: once
 * it is older than half the TTL it is rewritten with a new `updatedAt`, which
 * is the heartbeat.
 */
function writeOverride(root: string, state: HostActivationState): boolean {
  const dir = join(root, OVERRIDE_DIR);
  const target = hostActivationOverridePath(root);
  let dirStat: Stats | undefined;
  try {
    dirStat = lstatSync(dir);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (dirStat === undefined) mkdirSync(dir);
  else if (!dirStat.isDirectory()) return false;

  try {
    if (!lstatSync(target).isFile()) return false;
    const current = readOverride(target);
    if (
      current !== undefined
      && current.record.ownerPid === process.pid
      && current.record.state === state
      && !needsRefresh(current.record, Date.now())
    ) {
      return true;
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const record: OverrideRecord = {
    schemaVersion: 1,
    client: "vscode",
    state,
    ownerPid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  const temp = join(dir, `.host-activation.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: "wx" });
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // the temp file never existed, or is already gone
    }
    throw error;
  }
  return true;
}

/** `native` while the session bypass is on, else `disabled` while `tokenlighten.enabled` is false for this folder, else nothing. */
function desiredState(folder: vscode.WorkspaceFolder): HostActivationState | undefined {
  if (nativeSessionBypassEnabled()) return "native";
  let enabled: unknown = true;
  try {
    enabled = vscode.workspace.getConfiguration("tokenlighten", folder.uri).get<boolean>("enabled", true);
  } catch {
    // An odd host without a configuration service: never switch TokenLighten off on a guess.
  }
  return enabled === false ? "disabled" : undefined;
}

/**
 * Brings one folder in line with `desired`. True when this window wants that
 * folder's server off (a managed folder with a desired state), whether or not
 * the write succeeded — that is what the heartbeat keeps fresh.
 */
function syncFolder(root: string, desired: HostActivationState | undefined): boolean {
  // A folder VS Code does not launch the server for gets nothing created here.
  if (desired === undefined || !vscodeMcpJsonManaged(root)) {
    removeOverride(root, true);
    written.delete(root);
    return false;
  }
  if (writeOverride(root, desired)) written.add(root);
  return true;
}

/** The heartbeat timer; present only while some managed folder wants a state. */
let heartbeat: ReturnType<typeof setInterval> | undefined;

function stopHeartbeat(): void {
  if (heartbeat === undefined) return;
  clearInterval(heartbeat);
  heartbeat = undefined;
}

function updateHeartbeat(maintaining: boolean): void {
  if (!maintaining) {
    stopHeartbeat();
    return;
  }
  if (heartbeat !== undefined) return;
  heartbeat = setInterval(syncHostActivationOverrides, HOST_ACTIVATION_HEARTBEAT_MS);
  // Never the reason the extension host (or a test worker) stays alive.
  heartbeat.unref?.();
}

/**
 * Brings every workspace folder's override in line with the window's state:
 * writes this window's file where it wants TokenLighten off (and rewrites it
 * once it is older than half the TTL), removes its own or a stale one where it
 * does not, and starts or stops the heartbeat. Idempotent and never throws.
 */
export function syncHostActivationOverrides(): void {
  let folders: readonly vscode.WorkspaceFolder[] = [];
  try {
    folders = vscode.workspace.workspaceFolders ?? [];
  } catch (error) {
    reportFailure("read the workspace folders", "", error);
    return;
  }
  const current = new Set<string>();
  let maintaining = false;
  for (const folder of folders) {
    const scheme = (folder.uri as { scheme?: unknown }).scheme;
    if (typeof scheme === "string" && scheme !== "file") continue; // a virtual file system has no override file
    const root = folder.uri.fsPath;
    current.add(root);
    let desired: HostActivationState | undefined;
    try {
      desired = desiredState(folder);
      if (syncFolder(root, desired)) maintaining = true;
    } catch (error) {
      reportFailure("update the host activation override", root, error);
      // The next heartbeat retries a write that failed.
      if (desired !== undefined) maintaining = true;
    }
  }
  // A folder this window wrote into and no longer hosts must not stay switched off for whoever opens it next.
  for (const root of [...written]) {
    if (current.has(root)) continue;
    try {
      removeOverride(root, false);
    } catch (error) {
      reportFailure("remove the host activation override", root, error);
    }
    written.delete(root);
  }
  updateHeartbeat(maintaining);
}

/** Removes every override this window owns and stops the heartbeat; called when the extension deactivates. Never throws. */
export function removeOwnHostActivationOverrides(): void {
  stopHeartbeat();
  const roots = new Set(written);
  try {
    for (const folder of vscode.workspace.workspaceFolders ?? []) roots.add(folder.uri.fsPath);
  } catch {
    // deactivating without a workspace service: only the recorded roots remain
  }
  for (const root of roots) {
    try {
      removeOverride(root, false);
    } catch (error) {
      reportFailure("remove the host activation override", root, error);
    }
  }
  written.clear();
}

/**
 * Syncs now, and again whenever `tokenlighten.enabled` or the workspace folders
 * change, and on the heartbeat while any managed folder wants a state. The
 * heartbeat is a disposable: it is cleared when the subscriptions are disposed
 * and when `removeOwnHostActivationOverrides` runs.
 */
export function registerHostActivation(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tokenlighten.enabled")) syncHostActivationOverrides();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => syncHostActivationOverrides()),
    { dispose: stopHeartbeat },
  );
  syncHostActivationOverrides();
}
