// hostActivation.ts — the window-scoped off switch for a TokenLighten server
// that VS Code itself launched (2026-10-02).
//
// THE GAP. A workspace set up with `tl workspace setup` carries a managed
// `.vscode/mcp.json` entry, so VS Code — not the TokenLighten extension —
// launches this server. Neither `tokenlighten.enabled = false` nor the
// `tokenlighten.session.native` command reached it: the extension's MCP
// provider deliberately returns no definition for such a folder (two copies of
// one server collide inside VS Code), so it had no channel to a process it
// does not own, and a live Copilot session kept calling `tl_read_file` after
// both. This module is the server half of that channel.
//
// THE CONTRACT. The extension (packages/vscode-extension/src/
// hostActivation.ts) is the only writer. One file per workspace folder,
// `<workspace>/.tokenlighten/host-activation.json`:
//
//   { "schemaVersion": 1, "client": "vscode", "state": "disabled" | "native",
//     "ownerPid": <extension host pid>, "updatedAt": "<ISO-8601>" }
//
// The override is LIVE only while ALL of these hold: `ownerPid` is alive,
// `updatedAt` is no older than HOST_ACTIVATION_TTL_MS, and `updatedAt` is not
// more than HOST_ACTIVATION_FUTURE_SKEW_MS in the future (the writer and this
// server share one host and one clock, so a future-dated file is not from a
// live writer). So a window that crashed or was closed can never leave
// TokenLighten off, and the window-scoped native bypass ends with its window.
//
// A LIVE PID IS NOT AN OWNER. The probe `process.kill(pid, 0)` proves only that
// SOME process has that pid: init, an unrelated program, the extension host's
// pid after the OS handed it to something else, or the pid a teammate's
// committed file names. The extension therefore REFRESHES its file every
// HOST_ACTIVATION_HEARTBEAT_MS while it wants TokenLighten off, and a file
// nobody refreshes ages out by itself, with the same `list_changed` as a
// removed file. Keep the three timing constants equal to the extension's
// (hostActivation.spec.ts compares the two sources).
//
// WHO IT AFFECTS. Only a server that is the VS Code client BY ENVIRONMENT
// (TOKENLIGHTEN_CLIENT_ID or TOKENLIGHTEN_CLIENT equal to "vscode": the pair
// `tl workspace setup` writes into the VS Code entry and the extension's
// provider into its own). A Claude Code or Codex server on the same workspace
// never reads the file; that is a hard requirement, not a default.
//
// FAIL-OPEN. Whatever this module cannot positively establish — no file, a
// symlink, an oversize or malformed file, a field it does not know, a dead
// owner, a file nobody has refreshed — means "no override", and the server
// answers exactly as before. A file can only ever turn TokenLighten OFF for a
// window; it can never make a server do more.
//
// EFFECT, applied by both protocol legs (server.ts `handleRequest`, and
// mcp/transport/modernServerFactory.ts): `tools/list` is empty and
// `tools/call` is refused as JSON-RPC "method not found" — no TokenLighten wire
// refusal code is involved. The VS Code client's `initialize` declares
// `tools.listChanged`, and the transports call `startHostActivationWatch` so
// the host is told the moment the override starts or ends.
//
// This file has no server.ts import on purpose: callers pass the workspace
// root (server.ts's `activeRoot`), so the module stays a leaf of the import
// cycle server.ts <-> mcp/transport/*.

import * as fs from "node:fs";
import * as path from "node:path";

/** Directory, then file name, of the override under a workspace root. */
export const HOST_ACTIVATION_DIR = ".tokenlighten";
export const HOST_ACTIVATION_FILE = "host-activation.json";
/** A well-formed override is about 120 bytes; anything past this is not one. */
export const HOST_ACTIVATION_MAX_BYTES = 4096;
/** How often a connected VS Code server re-checks whether the override flipped. */
export const HOST_ACTIVATION_POLL_MS = 2000;
/**
 * How often the extension re-runs its sync while it wants TokenLighten off; a
 * sync rewrites its own file (fresh `updatedAt`) once that file is older than
 * half the TTL. Mirrors the extension's constant of the same name, which the
 * TTL below is sized on: the oldest a healthy file gets is the first heartbeat
 * past half the TTL (60 s with the numbers here), well inside the TTL.
 */
export const HOST_ACTIVATION_HEARTBEAT_MS = 30_000;
/** An override older than this (by its `updatedAt`) is not live, whatever its owner pid does. */
export const HOST_ACTIVATION_TTL_MS = 90_000;
/** An override dated further than this into the future is not live (same host, same clock). */
export const HOST_ACTIVATION_FUTURE_SKEW_MS = 60_000;
/** JSON-RPC "method not found": what a refused `tools/call` answers. */
export const HOST_ACTIVATION_ERROR_CODE = -32601;

export type HostActivationState = "disabled" | "native";

/** The parsed, validated file content. */
export interface HostActivationOverride {
  readonly state: HostActivationState;
  readonly ownerPid: number;
  readonly updatedAt: string;
}

/** A LIVE override: what a protocol leg acts on. */
export interface HostActivationBypass extends HostActivationOverride {
  /** The words a refusal uses for `state`. */
  readonly reason: string;
}

export interface HostActivationWatch {
  stop(): void;
}

const REASONS: Readonly<Record<HostActivationState, string>> = {
  disabled: "disabled by tokenlighten.enabled=false",
  native: "native session",
};

/** The exact key set a v1 file carries, sorted. */
const OVERRIDE_KEYS = ["client", "ownerPid", "schemaVersion", "state", "updatedAt"] as const;

export function hostActivationFilePath(root: string): string {
  return path.join(root, HOST_ACTIVATION_DIR, HOST_ACTIVATION_FILE);
}

/**
 * True when THIS server is the VS Code client by environment. Read at call
 * time (never cached), so a test can flip it. TOKENLIGHTEN_CLIENT is accepted
 * next to TOKENLIGHTEN_CLIENT_ID because a VS Code entry written by an older
 * `tl workspace setup` carries only the former.
 */
export function hostActivationClientApplies(): boolean {
  return process.env["TOKENLIGHTEN_CLIENT_ID"] === "vscode"
    || process.env["TOKENLIGHTEN_CLIENT"] === "vscode";
}

/**
 * The `initialize` result's `capabilities.tools` member: `{}` for every client
 * (byte-identical to before), `{ listChanged: true }` for the VS Code client
 * only, whose transport can announce a changed tool list.
 */
export function hostActivationToolsCapability(): { listChanged?: true } {
  return hostActivationClientApplies() ? { listChanged: true } : {};
}

function parseOverride(text: string): HostActivationOverride | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== OVERRIDE_KEYS.length || keys.some((key, index) => key !== OVERRIDE_KEYS[index])) {
    return undefined;
  }
  const { schemaVersion, client, state, ownerPid, updatedAt } = record;
  if (schemaVersion !== 1 || client !== "vscode") return undefined;
  if (state !== "disabled" && state !== "native") return undefined;
  if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) return undefined;
  if (
    typeof updatedAt !== "string"
    || updatedAt.length === 0
    || updatedAt.length > 64
    || Number.isNaN(Date.parse(updatedAt))
  ) {
    return undefined;
  }
  return { state, ownerPid, updatedAt };
}

interface LoadedOverride {
  readonly stamp: string;
  readonly override: HostActivationOverride | undefined;
}

// One entry is enough: a server watches exactly one workspace root.
let cached: { readonly file: string; readonly loaded: LoadedOverride } | undefined;
let lastIgnoredNote: string | undefined;

/** Test hook: forget the parsed-content cache and the once-per-file stderr note. */
export function resetHostActivationCacheForTest(): void {
  cached = undefined;
  lastIgnoredNote = undefined;
}

function stampOf(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** One stderr line per distinct (file state, reason): a bad file is visible without being chatty. */
function noteIgnored(target: string, stamp: string, why: string): void {
  const key = `${target}|${stamp}|${why}`;
  if (lastIgnoredNote === key) return;
  lastIgnoredNote = key;
  process.stderr.write(`[tl-mcp] host activation: ignoring ${target} (${why})\n`);
}

function loadOverrideFile(file: string, listed: fs.Stats): LoadedOverride | undefined {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW closes the window between the caller's lstat and this open on
    // POSIX; Windows has no such flag (the constant is undefined there), so the
    // lstat is the whole symlink check on that platform.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > HOST_ACTIVATION_MAX_BYTES) return undefined;
    // The path was swapped for another file between the lstat and the open.
    if (process.platform !== "win32" && (opened.ino !== listed.ino || opened.dev !== listed.dev)) return undefined;
    const buffer = Buffer.alloc(opened.size);
    let filled = 0;
    while (filled < buffer.length) {
      const read = fs.readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return { stamp: stampOf(opened), override: parseOverride(buffer.toString("utf8", 0, filled)) };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing left to do for a descriptor we only read
      }
    }
  }
}

/**
 * The validated override under `root`, whether or not its owner is alive; or
 * `undefined` for no file, anything unreadable, and anything malformed. Cheap
 * per call: two `lstat`s, and the parsed content is cached on the file's
 * (device, inode, size, mtime, ctime) stamp.
 */
export function readHostActivationOverride(root: string): HostActivationOverride | undefined {
  const dir = path.join(root, HOST_ACTIVATION_DIR);
  const file = path.join(dir, HOST_ACTIVATION_FILE);
  let listed: fs.Stats;
  try {
    // lstat, never stat: a symlinked directory or file is not followed.
    const dirStat = fs.lstatSync(dir);
    if (!dirStat.isDirectory()) {
      noteIgnored(dir, stampOf(dirStat), "not a real directory");
      return undefined;
    }
    listed = fs.lstatSync(file);
  } catch {
    return undefined; // no file (the usual case) or no access: no override
  }
  const stamp = stampOf(listed);
  if (!listed.isFile()) {
    noteIgnored(file, stamp, "not a regular file");
    return undefined;
  }
  if (listed.size > HOST_ACTIVATION_MAX_BYTES) {
    noteIgnored(file, stamp, `larger than ${HOST_ACTIVATION_MAX_BYTES} bytes`);
    return undefined;
  }
  if (cached !== undefined && cached.file === file && cached.loaded.stamp === stamp) {
    return cached.loaded.override;
  }
  const loaded = loadOverrideFile(file, listed);
  if (loaded === undefined) return undefined;
  cached = { file, loaded };
  if (loaded.override === undefined) noteIgnored(file, loaded.stamp, "malformed or unsupported content");
  return loaded.override;
}

/**
 * Whether SOME process has this pid: the extension host that wrote an override
 * if it still runs, but equally anything else the OS gave the number to — which
 * is why liveness alone never decides (see `hostActivationBypass`). EPERM means
 * the process exists but is not ours to signal: alive. ESRCH, and anything
 * else (an out-of-range pid), means dead.
 */
export function isHostOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

interface HostActivationEvaluation {
  /** The live override, or `undefined`. */
  readonly bypass: HostActivationBypass | undefined;
  /** Why there is none (for the log line of an override that ended); empty while there is one. */
  readonly why: string;
}

/**
 * The whole liveness rule. An override applies only while its `updatedAt` is no
 * older than HOST_ACTIVATION_TTL_MS, is not more than
 * HOST_ACTIVATION_FUTURE_SKEW_MS in the future, and its owner pid is alive.
 * The age arithmetic runs first, so an aged-out or future-dated file costs no
 * syscall; the pid probe runs on every call and only the file parse is cached.
 */
function evaluateHostActivation(root: string, nowMs: number): HostActivationEvaluation {
  if (!hostActivationClientApplies()) return { bypass: undefined, why: "not the VS Code client" };
  const override = readHostActivationOverride(root);
  if (override === undefined) return { bypass: undefined, why: "no valid override file" };
  const ageMs = nowMs - Date.parse(override.updatedAt);
  // `!(a <= b)`, not `a > b`: an age that is not a number is aged out, never live.
  if (!(ageMs <= HOST_ACTIVATION_TTL_MS)) {
    return { bypass: undefined, why: `not refreshed within ${HOST_ACTIVATION_TTL_MS / 1000} s` };
  }
  if (ageMs < -HOST_ACTIVATION_FUTURE_SKEW_MS) {
    return { bypass: undefined, why: `dated more than ${HOST_ACTIVATION_FUTURE_SKEW_MS / 1000} s in the future` };
  }
  if (!isHostOwnerAlive(override.ownerPid)) return { bypass: undefined, why: "owner process gone" };
  return { bypass: { ...override, reason: REASONS[override.state] }, why: "" };
}

/**
 * The live override that applies to THIS server, or `undefined`: not the VS
 * Code client by environment, no valid file, a file nobody has refreshed within
 * the TTL (or dated in the future), or an owner that is gone. `nowMs` is the
 * clock, a parameter so a test need not wait out the TTL.
 */
export function hostActivationBypass(root: string, nowMs: number = Date.now()): HostActivationBypass | undefined {
  return evaluateHostActivation(root, nowMs).bypass;
}

/** The `tools/call` refusal text, shared by both protocol legs. */
export function hostActivationToolNotFoundMessage(toolName: string, bypass: HostActivationBypass): string {
  return `Tool not found: ${toolName} (TokenLighten is turned off for this VS Code window: ${bypass.reason}; use the host's native tools)`;
}

/**
 * Polls whether the override is live and calls `onChange(live)` on every
 * transition (the baseline is the state at call time). A file that ages out is
 * a transition exactly like a removed one, and a refreshed file is not. The
 * timer is unref'd, so it never keeps the process alive, and a failing callback
 * never ends the watch. Returns `undefined`, with no timer at all, for a client
 * the override does not apply to. `clock` (milliseconds since the epoch) is a
 * parameter so a test can age an override without waiting out the TTL.
 */
export function startHostActivationWatch(
  root: string,
  onChange: (live: boolean) => void,
  intervalMs: number = HOST_ACTIVATION_POLL_MS,
  clock: () => number = Date.now,
): HostActivationWatch | undefined {
  if (!hostActivationClientApplies()) return undefined;
  let live = evaluateHostActivation(root, clock()).bypass !== undefined;
  const timer = setInterval(() => {
    try {
      const { bypass, why } = evaluateHostActivation(root, clock());
      if ((bypass !== undefined) === live) return;
      live = bypass !== undefined;
      process.stderr.write(
        bypass !== undefined
          ? `[tl-mcp] host activation: TokenLighten turned off for this VS Code window (${bypass.reason}; owner pid ${bypass.ownerPid})\n`
          : `[tl-mcp] host activation: override ended; TokenLighten tools restored (${why})\n`,
      );
      onChange(live);
    } catch {
      // A timer callback that throws would take the server down with it.
    }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
