// `tl install` — DESIGN-v0.14-mcp-only-install.md §4.2, §4.6 (Phase A / §7).
//
// The one command `tl-setup <workspace>` runs under the hood. Stages the
// running bundle into `<installHome>/app/<version>`, regenerates the
// `bin/tl.js` indirection shim and the human-facing shim, writes
// `install.json` (the single source of truth — §4.6 C1), registers detected
// hosts, sets up requested workspaces, and verifies the result with a real
// MCP handshake before reporting success.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, resolve as resolvePathAbs } from "node:path";
import { fileURLToPath } from "node:url";
import { removeAll } from "@tokenlighten/agents-md";
import type {
  CopilotInlineResultsReport,
  InstallHostEntry,
  InstallHostMechanism,
  InstallIdentity,
  InstallRecord,
  InstallRuntimeSource,
  InstallSource,
  InstallWorkspaceEntry,
  ToolSurface,
  TokenLightenRegistrationClient,
} from "@tokenlighten/types";
import { makeTmpPath, retryRename } from "../atomicWrite.js";
import { readConfig, writeConfig } from "../config.js";
import {
  installAppDir,
  installAppRoot,
  installBinDir,
  installCliJsPath,
  installNodePath,
  isDefaultInstallHome,
  readInstallRecord,
  resolveInstallHome,
  upsertInstallApp,
  upsertInstallWorkspace,
  writeInstallRecord,
} from "../installHome.js";
import {
  legacyLauncherPath,
  managedLauncherPath,
  resolveStableLauncher,
  writeManagedLauncher,
} from "../launcher.js";
import { removeManagedEntry } from "../mcpConfigFile.js";
import { runMcpHandshake as defaultRunMcpHandshake, type McpHandshakeResult } from "../mcpHandshake.js";
import { readPidFile, isPidAlive, stopMcp } from "../process.js";
import { resolvePath } from "../paths.js";
import { wantsHelp } from "../util/helpFlag.js";
import {
  CLIENTS as ALL_REGISTRATION_CLIENTS,
  buildClientSnippet,
  currentCliVersion,
  getClientStatuses as defaultGetClientStatuses,
  mechanismForClient,
  registerClients as defaultRegisterClients,
  unregisterClients as defaultUnregisterClients,
  type ClientSnippetResult,
  type ClientsEngineOptions,
} from "./clients.js";
import { evaluateDoctorAsync as defaultEvaluateDoctor, type DoctorResult } from "./doctor.js";
import {
  COPILOT_INLINE_RESULTS_VALUES,
  COPILOT_RAISED_THRESHOLD_BYTES,
  COPILOT_SETTINGS_KEY,
  formatCopilotInlineResultsLine,
  isCopilotInlineResultsMode,
  recordWorkspaceSetup as defaultRecordWorkspaceSetup,
  removeCopilotThresholdIfManaged,
  setupWorkspace as defaultSetupWorkspace,
  workspacePathsEqual,
  type CopilotInlineResultsMode,
} from "./workspace.js";

const INSTALL_USAGE = `\
Usage:
  tl install [<workspace>...] [--workspace <path>]... [options]

Installs TokenLighten as a machine-scoped MCP server (no editor extension
required): stages the running bundle, regenerates the version-independent
host identity, registers detected AI-agent hosts, and sets up any given
workspace(s). Re-running this command upgrades in place.

Options:
  --workspace <path>       Workspace to set up (repeatable; positionals work too)
  --source <dir>           Bundle/source directory (default: directory of the running CLI)
  --clients <list>|auto|none   Which vendor-CLI hosts to register (default: auto)
  --read-only               Generated entries omit --allow-write
  --tool-surface code|full  Advertised tool surface for generated entries
  --guide-profile full|medium|compact
  --copilot-inline-results raise|keep
                             Raise (default) GitHub Copilot's inline tool-result
                             limit in each workspace's .vscode/settings.json, or
                             keep it untouched
  --home <dir>              Override the machine-install home
  --use <version>           Re-point bin/tl.js at an already-staged version
  --prune                   Remove staged app/<version> directories other than current
  --uninstall                Remove the machine install and managed host entries
  --dry-run                  Print the plan and exit 0 without writing anything
  --json                     Emit a structured JSON report
  --yes                      Skip the interactive confirmation (required outside a TTY)
  --force                    Overwrite foreign entries / re-stage identical build stamps
  --from-extension            This install is staged from the VS Code extension's bundle
  --dev                       This install is a source checkout (packages/cli/dist)
  --allow-root                 Allow running as root/uid 0 (POSIX only)

Exit codes:
  0   success (or --clients none, even with no host registered — that is
      the deliberate opt-out from host registration, not a failure)
  1   refused (bad args, non-TTY without --yes, aborted confirmation,
      root refusal, or --uninstall/--use/--prune found nothing to act on)
  2   installed, but no host ended up registered — a copy-paste snippet is
      printed instead (report.manualSnippets in --json)
  3   installed, but the post-install doctor/handshake verification failed
`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ParsedInstallArgs {
  workspaces: string[];
  source?: string;
  clientsMode: "auto" | "none" | string[];
  readOnly: boolean;
  toolSurface?: ToolSurface;
  guideProfile?: "full" | "medium" | "compact";
  /** Unchecked cast at parse time, same as toolSurface/guideProfile above —
   * `runInstall` validates the raw runtime string (via
   * `isCopilotInlineResultsMode`) and exits 1 on an unrecognized value
   * before this is ever read downstream. Undefined defaults to "raise". */
  copilotInlineResults?: CopilotInlineResultsMode;
  home?: string;
  use?: string;
  prune: boolean;
  uninstall: boolean;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  force: boolean;
  fromExtension: boolean;
  dev: boolean;
  allowRoot: boolean;
}

export function parseInstallArgs(args: readonly string[]): ParsedInstallArgs {
  const workspaces: string[] = [];
  let source: string | undefined;
  let clientsMode: "auto" | "none" | string[] = "auto";
  let readOnly = false;
  let toolSurface: ToolSurface | undefined;
  let guideProfile: "full" | "medium" | "compact" | undefined;
  let copilotInlineResults: CopilotInlineResultsMode | undefined;
  let home: string | undefined;
  let use: string | undefined;
  let prune = false;
  let uninstall = false;
  let dryRun = false;
  let json = false;
  let yes = false;
  let force = false;
  let fromExtension = false;
  let dev = false;
  let allowRoot = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    switch (arg) {
      case "--workspace":
        workspaces.push(args[++i] ?? "");
        break;
      case "--source":
        source = args[++i];
        break;
      case "--clients": {
        const value = args[++i] ?? "auto";
        clientsMode = value === "auto" || value === "none"
          ? value
          : value.split(",").map((v) => v.trim()).filter(Boolean);
        break;
      }
      case "--read-only":
        readOnly = true;
        break;
      case "--tool-surface":
        toolSurface = args[++i] as ToolSurface;
        break;
      case "--guide-profile":
        guideProfile = args[++i] as "full" | "medium" | "compact";
        break;
      case "--copilot-inline-results":
        copilotInlineResults = args[++i] as CopilotInlineResultsMode;
        break;
      case "--home":
        home = args[++i];
        break;
      case "--use":
        use = args[++i];
        break;
      case "--prune":
        prune = true;
        break;
      case "--uninstall":
        uninstall = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--json":
        json = true;
        break;
      case "--yes":
        yes = true;
        break;
      case "--force":
        force = true;
        break;
      case "--from-extension":
        fromExtension = true;
        break;
      case "--dev":
        dev = true;
        break;
      case "--allow-root":
        allowRoot = true;
        break;
      default:
        if (!arg.startsWith("--")) workspaces.push(arg);
        break;
    }
  }
  return {
    workspaces, source, clientsMode, readOnly, toolSurface, guideProfile, copilotInlineResults,
    home, use, prune, uninstall, dryRun, json, yes, force, fromExtension, dev, allowRoot,
  };
}

// ---------------------------------------------------------------------------
// Dependency injection seam (real implementations by default; tests override)
// ---------------------------------------------------------------------------

export interface InstallDeps {
  platform?: NodeJS.Platform;
  /**
   * Real OS-home basis for the pre-v0.14.3 `~/.tokenlighten/bin` legacy
   * shim and any other real-home lookup this command threads through to
   * `clients.ts`/`doctor.ts` (§4.6 C7). Defaults to `os.homedir()`; tests
   * inject an isolated path so a spec run can never reach — let alone
   * rewrite — the developer's actual home.
   */
  homeDir?: string;
  uid?: () => number | undefined;
  isTTY?: boolean;
  confirm?: (question: string) => Promise<string>;
  registerClients?: typeof defaultRegisterClients;
  unregisterClients?: typeof defaultUnregisterClients;
  getClientStatuses?: typeof defaultGetClientStatuses;
  setupWorkspace?: typeof defaultSetupWorkspace;
  /**
   * B5 fix (v0.14.3 pre-release wave): after each successful
   * `deps.setupWorkspace()` call in the workspace loop below, this also
   * records the workspace in the workspace REGISTRY (config.toml
   * `workspaces.entries` — the store `tl workspace status`/`list` and the
   * VS Code extension's `workspaceActivationState` probe actually read).
   * `tl workspace setup`'s own `runWorkspace()` already calls this; the
   * install-time loop used to upsert only `install.json`'s `workspaces[]`
   * (a different store) and never touched the registry, so a workspace set
   * up via `tl install --workspace`/`tl-setup`/`--from-extension` stayed
   * "not-registered" forever. Defaults to the real workspace.ts function;
   * tests inject a throwing stub to exercise the failure-warning path
   * without touching any real file.
   */
  recordWorkspaceSetup?: typeof defaultRecordWorkspaceSetup;
  /**
   * Registry file passed through to `recordWorkspaceSetup` above.
   * Deliberately NOT defaulted in `resolvedDeps()` — `undefined` is
   * forwarded as-is so `recordWorkspaceSetup`'s own default parameter
   * resolves it to the real `configFilePath()`, exactly like a real
   * install with no injected deps. Tests inject an isolated temp path so a
   * spec run can never write the developer's actual config.toml.
   */
  registryPath?: string;
  evaluateDoctor?: typeof defaultEvaluateDoctor;
  runMcpHandshake?: (options: {
    command: string;
    args: readonly string[];
    env?: Record<string, string>;
    cwd?: string;
    timeoutMs?: number;
  }) => Promise<McpHandshakeResult>;
  now?: () => string;
  execPath?: string;
  /** B1: `spawnSync("xattr", ["-d", "com.apple.quarantine", target])` on the
   * darwin-only post-copy quarantine clear. Injectable so a spec can assert
   * the call happens for `platform: "darwin"` and never otherwise, without
   * actually shelling out to `xattr`. */
  spawnSync?: typeof spawnSync;
  /** Best-effort removal used by `tl install --uninstall` (review B3):
   * tolerant of EPERM/EBUSY/EACCES/ENOTEMPTY on a file a host still has
   * open (Windows). Defaults to the real `rmSync`. */
  rmSync?: typeof rmSync;
  /** Windows only (review B3): schedules the detached retry loop that
   * finishes removing a locked `bin/` directory once every process
   * holding it open has exited. Injectable so specs can assert the exact
   * command line without actually spawning a background process. */
  spawnDetached?: (command: string, args: readonly string[]) => void;
  /** Windows only (review S5): best-effort removal of the copied runtime's
   * NTFS `Zone.Identifier` alternate data stream (Mark-of-the-Web) so a
   * runtime staged from a downloaded, Explorer-extracted archive isn't
   * blocked by Windows Defender/SmartScreen on every host spawn. */
  clearZoneIdentifier?: (streamPath: string) => void;
}

async function defaultConfirm(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim().toLowerCase();
  } finally {
    rl.close();
  }
}

function resolvedDeps(
  deps: InstallDeps,
): Required<Omit<InstallDeps, "confirm" | "registryPath">> & {
  confirm: (q: string) => Promise<string>;
  registryPath: string | undefined;
} {
  return {
    platform: deps.platform ?? process.platform,
    homeDir: deps.homeDir ?? homedir(),
    uid: deps.uid ?? (() => (typeof process.getuid === "function" ? process.getuid() : undefined)),
    isTTY: deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: deps.confirm ?? defaultConfirm,
    registerClients: deps.registerClients ?? defaultRegisterClients,
    unregisterClients: deps.unregisterClients ?? defaultUnregisterClients,
    getClientStatuses: deps.getClientStatuses ?? defaultGetClientStatuses,
    setupWorkspace: deps.setupWorkspace ?? defaultSetupWorkspace,
    recordWorkspaceSetup: deps.recordWorkspaceSetup ?? defaultRecordWorkspaceSetup,
    // Passed through as-is, never defaulted to configFilePath() here — see
    // the InstallDeps.registryPath doc comment above.
    registryPath: deps.registryPath,
    evaluateDoctor: deps.evaluateDoctor ?? defaultEvaluateDoctor,
    runMcpHandshake: deps.runMcpHandshake ?? defaultRunMcpHandshake,
    now: deps.now ?? (() => new Date().toISOString()),
    execPath: deps.execPath ?? process.execPath,
    spawnSync: deps.spawnSync ?? spawnSync,
    rmSync: deps.rmSync ?? rmSync,
    spawnDetached: deps.spawnDetached ?? defaultSpawnDetached,
    clearZoneIdentifier: deps.clearZoneIdentifier ?? defaultClearZoneIdentifier,
  };
}

// ---------------------------------------------------------------------------
// Source / version detection
// ---------------------------------------------------------------------------

function defaultSourceDir(): string {
  const argv1 = process.argv[1];
  if (argv1) return dirname(resolvePathAbs(argv1));
  return dirname(fileURLToPath(import.meta.url));
}

/** The checkout root for `--dev`: this compiled file lives at
 * `<checkout>/packages/cli/dist/commands/install.js`. */
function devCheckoutRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePathAbs(here, "..", "..", "..", "..");
}

function devCliEntry(): string {
  return join(devCheckoutRoot(), "packages", "cli", "dist", "index.js");
}

function resolveSourceVersion(sourceDir: string, dev: boolean): string {
  if (dev) return currentCliVersion();
  try {
    const pkgPath = join(sourceDir, "node_modules", "@tokenlighten", "cli", "package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // fall through
  }
  return "unknown";
}

// DESIGN-v0.14-mcp-only-install.md §4.6 C4 "the higher version wins" — a
// per-segment NUMERIC compare of two plain dotted version strings (e.g.
// "0.14.3" vs "0.14.10"): negative if `a` < `b`, positive if `a` > `b`,
// else 0. No semver package (AGENTS.md: no new dependency); no existing
// comparator was found elsewhere in this file or package (searched). An
// unparsable segment on either side collapses the whole comparison to 0 —
// `resolveSourceVersion` can return "unknown", and this must never claim
// an upgrade OR a downgrade from data it cannot read as a plain number.
function compareDottedVersions(a: string, b: string): number {
  const partsA = a.split(".");
  const partsB = b.split(".");
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const numA = Number(partsA[i] ?? "0");
    const numB = Number(partsB[i] ?? "0");
    if (!Number.isFinite(numA) || !Number.isFinite(numB)) return 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

interface ArchiveLayout {
  cliJs: string;
  runtimeNode: string;
}

function detectArchiveLayout(sourceDir: string, platform: NodeJS.Platform): ArchiveLayout | undefined {
  const cliJs = join(sourceDir, "tl-cli.js");
  const runtimeNode = join(sourceDir, "runtime", platform === "win32" ? "node.exe" : "node");
  if (existsSync(cliJs) && existsSync(runtimeNode)) return { cliJs, runtimeNode };
  return undefined;
}

// ---------------------------------------------------------------------------
// Staging: app/<version>, bin/node, bin/tl.js
// ---------------------------------------------------------------------------

const TOP_LEVEL_STAGE_EXCLUDES = new Set(["runtime", "tl-setup", "tl-setup.cmd", "README-INSTALL.md"]);

function copyRecursive(src: string, dest: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) return; // defensive: archive contents are plain files
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const child of readdirSync(src)) copyRecursive(join(src, child), join(dest, child));
    return;
  }
  if (st.isFile()) copyFileSync(src, dest);
}

function stageBundleTree(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (TOP_LEVEL_STAGE_EXCLUDES.has(entry.name)) continue;
    copyRecursive(join(sourceDir, entry.name), join(destDir, entry.name));
  }
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Copy the bundle tree into `app/<version>` via a tmp-dir + directory
 * rename, replacing an existing `app/<version>` only if its build stamp
 * (a hash of the source `tl-cli.js`) differs — design §4.2 step 2. */
function stageApp(home: string, version: string, sourceDir: string, force: boolean): { appDir: string; staged: boolean } {
  const appDir = installAppDir(home, version);
  const stamp = fileHash(join(sourceDir, "tl-cli.js"));
  const stampPath = join(appDir, ".tl-build-stamp");
  if (!force && existsSync(appDir) && existsSync(stampPath)) {
    try {
      if (readFileSync(stampPath, "utf8").trim() === stamp) return { appDir, staged: false };
    } catch {
      // fall through and re-stage
    }
  }
  mkdirSync(installAppRoot(home), { recursive: true, mode: 0o700 });
  const tmp = `${appDir}.tmp-${randomBytes(6).toString("hex")}`;
  stageBundleTree(sourceDir, tmp);
  writeFileSync(join(tmp, ".tl-build-stamp"), `${stamp}\n`, { encoding: "utf8" });
  // Review (d): never `rmSync` the existing app/<version> before the new one
  // is safely in place — a crash between the two used to leave app/<version>
  // missing entirely. Rename the old tree ASIDE first, swap the new one in,
  // then remove the aside; a crash between the rename-aside and the
  // rename-in is recoverable (the aside still holds the previous, working
  // tree byte-for-byte) instead of destructive.
  let aside: string | undefined;
  if (existsSync(appDir)) {
    aside = `${appDir}.old-${randomBytes(6).toString("hex")}`;
    renameSync(appDir, aside);
  }
  try {
    renameSync(tmp, appDir);
  } catch (error) {
    if (aside !== undefined && existsSync(aside) && !existsSync(appDir)) {
      try {
        renameSync(aside, appDir);
      } catch {
        // Best-effort recovery only; the original error is what we surface.
      }
    }
    throw error;
  }
  if (aside !== undefined) rmSync(aside, { recursive: true, force: true });
  return { appDir, staged: true };
}

/** Rename-swap copy of the bundled runtime into `bin/node`(.exe), keeping
 * `.old` for any process still running the previous binary — design §4.1. */
function stageRuntimeRenameSwap(
  home: string,
  sourceNode: string,
  platform: NodeJS.Platform,
  spawnSyncFn: typeof spawnSync = spawnSync,
  rmSyncFn: typeof rmSync = rmSync,
  clearZoneIdentifierFn: (streamPath: string) => void = defaultClearZoneIdentifier,
): string {
  const binDir = installBinDir(home);
  const target = installNodePath(home, platform);
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const next = `${target}.new`;
  rmSyncFn(next, { force: true });
  copyFileSync(sourceNode, next);
  if (platform !== "win32") chmodSync(next, 0o755);
  // Review B1 / DESIGN §4.1 / §8, nodejs/node#61430: libuv's uv_fs_copyfile
  // uses fcopyfile(..., COPYFILE_ALL) on Darwin, which copies extended
  // attributes too — a runtime downloaded via a browser and extracted with
  // Archive Utility (the Finder default) stamps com.apple.quarantine on the
  // archive, which propagates to every extracted file, so the COPY above
  // would inherit it and Gatekeeper would then block every host spawn of
  // this binary. Clear it on the copy only, only on darwin; a non-zero exit
  // (attribute never present) is expected and ignored.
  if (platform === "darwin") {
    spawnSyncFn("xattr", ["-d", "com.apple.quarantine", next], { stdio: "ignore" });
  }
  // Review S5: the Windows analogue of the darwin quarantine clear above —
  // Explorer stamps every file extracted from a downloaded zip with an NTFS
  // `Zone.Identifier` alternate data stream (Mark-of-the-Web); `copyFileSync`
  // copies the stream along with the rest of the file, so without this the
  // STAGED copy keeps MOTW and Defender/SmartScreen can block every host
  // spawn of it. Best-effort only: absence (the common case) errors, and
  // any other failure must never block the install.
  if (platform === "win32") {
    try {
      clearZoneIdentifierFn(`${next}:Zone.Identifier`);
    } catch {
      // ignored — see comment above
    }
  }
  let previousAsideName: string | undefined;
  if (existsSync(target)) {
    let old = `${target}.old`;
    try {
      rmSyncFn(old, { force: true });
    } catch {
      // Review B4: `old` (the FIXED `.old` name) is itself still locked — a
      // host spawned the PREVIOUS runtime generation from it and hasn't
      // exited yet. Renaming an open file is fine (probed on Windows: a
      // running exe can be renamed, only not deleted), so fall back to a
      // fresh unique aside name instead of blocking this upgrade on a
      // still-running earlier server.
      old = `${target}.old-${randomBytes(4).toString("hex")}`;
    }
    renameSync(target, old);
    previousAsideName = basename(old);
  }
  renameSync(next, target);
  // Best-effort: earlier generations' aside names become removable once
  // their host process finally exits; sweep them opportunistically so they
  // don't accumulate forever. Never blocks this upgrade, and never touches
  // the aside just created above (its host may still be exiting).
  sweepStaleRuntimeAsides(binDir, target, previousAsideName, rmSyncFn);
  return target;
}

function defaultClearZoneIdentifier(streamPath: string): void {
  unlinkSync(streamPath);
}

function defaultSpawnDetached(command: string, args: readonly string[]): void {
  try {
    // `windowsVerbatimArguments`: the only caller hands cmd.exe a complete,
    // already-quoted `/s /c "<command line>"`. Node's default argv quoting
    // would rewrite every inner `"` as `\"`, which cmd.exe does not
    // understand (it would hand rmdir a path that starts with a backslash
    // and quote — verified on a real Windows 11 box, 2026-09-18). A neutral
    // cwd keeps the helper from pinning a directory it is about to remove.
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
      cwd: process.env["SystemRoot"] ?? process.env["windir"] ?? undefined,
    });
    child.unref();
  } catch {
    // Best-effort only — the synchronous removal already reported any
    // leftovers; failing to schedule the retry loop just means the user
    // sees the "still in use" message without an automatic follow-up.
  }
}

// Review B4: opportunistic cleanup for `node(.exe).old*` aside names left
// behind by a run of `stageRuntimeRenameSwap` that could not reuse the fixed
// `.old` name (a still-running earlier generation had it locked). Every
// candidate is tried independently and failures are ignored — a still-locked
// aside is simply left for a future upgrade to retry.
function sweepStaleRuntimeAsides(
  binDir: string,
  target: string,
  justCreated: string | undefined,
  rmSyncFn: typeof rmSync,
): void {
  const targetName = basename(target);
  let entries: string[];
  try {
    entries = readdirSync(binDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === targetName || entry === justCreated || !entry.startsWith(`${targetName}.old`)) continue;
    try {
      rmSyncFn(join(binDir, entry), { force: true });
    } catch {
      // still locked; try again on a future upgrade
    }
  }
}

/** `--dev`: `bin/node` becomes a symlink (POSIX) or copy (win32) of the
 * running system node — design §4.6 C2. */
function stageDevRuntime(home: string, execPath: string, platform: NodeJS.Platform): string {
  const target = installNodePath(home, platform);
  mkdirSync(installBinDir(home), { recursive: true, mode: 0o700 });
  rmSync(target, { force: true });
  if (platform === "win32") {
    copyFileSync(execPath, target);
  } else {
    symlinkSync(execPath, target);
  }
  return target;
}

/** Generates the 3-line `bin/tl.js` indirection shim. `dist/index.js` (the
 * `--dev` target) is an ES module (`packages/cli/package.json` declares
 * `"type": "module"`), so a plain `require(target)` would throw
 * `ERR_REQUIRE_ESM`; the archive/vsix target (`tl-cli.js`, bundled by
 * `bundle-cli.mjs` with `format: "cjs"`) is CommonJS. A dynamic `import()`
 * loads BOTH shapes uniformly (Node wraps a CJS target's exports).
 *
 * Also: `process.argv[1]` must be reassigned to the real target's absolute
 * path BEFORE importing it. `packages/cli/src/index.ts`'s own `IS_MAIN`
 * guard (and the identical pattern in the bundled `tl-cli.js`) compares
 * `safeRealpath(process.argv[1])` against `safeRealpath(import.meta.url)`
 * to decide whether to run `main()` at all — left unset, `process.argv[1]`
 * stays `bin/tl.js`'s own path (that's what Node sets for the script named
 * on the command line), which never equals the target's path, so `main()`
 * would silently never run. `mainEntryImportSafety.spec.ts` covers the
 * dispatcher side of this contract; `install.spec.ts` proves this shim
 * actually reaches it end-to-end. */
export function generateTlJsShim(targetAbsPath: string): string {
  return [
    "#!/usr/bin/env node",
    `process.argv[1] = ${JSON.stringify(targetAbsPath)};`,
    'import(require("node:url").pathToFileURL(process.argv[1]).href);',
    "",
  ].join("\n");
}

// Review B6: `<home>/bin/tl.js` is CommonJS (it `require`s "node:url"), but
// carried no `package.json` of its own to say so. `app/<version>/package.json`
// (`{"type":"commonjs"}`, copied from the archive root by `stageBundleTree`)
// already protects the STAGED bundle's `tl-cli.js`; `bin/tl.js` sits one
// level up in `<home>/bin/` and needs its own marker for the identical
// reason — any ANCESTOR `package.json` with `"type":"module"` above the
// install home (a `--home` inside a JS project — the documented AppLocker
// workaround — or a stray `~/package.json`) would otherwise make Node parse
// `bin/tl.js` as ESM, and every host spawn would die with
// `ReferenceError: require is not defined in ES module scope`.
function writeCommonJsMarker(binDir: string): void {
  const markerPath = join(binDir, "package.json");
  const tmp = makeTmpPath(markerPath);
  writeFileSync(tmp, `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  retryRename(tmp, markerPath);
}

function writeTlJsShim(home: string, targetAbsPath: string): string {
  const target = installCliJsPath(home);
  const binDir = installBinDir(home);
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const tmp = makeTmpPath(target);
  writeFileSync(tmp, generateTlJsShim(targetAbsPath), { encoding: "utf8", mode: 0o755 });
  retryRename(tmp, target);
  writeCommonJsMarker(binDir);
  return target;
}

// ---------------------------------------------------------------------------
// Legacy shim migration (§4.6 C7) — the first v0.14.3 run of any entry point
// re-points every reachable managed entry (handled by §4.3's ownership
// relaxation to "registered-legacy", not here) and replaces the pre-v0.14.3
// `~/.tokenlighten/bin/tl` shim with a forwarder to the new managed shim.
// Deviation: this wave does NOT move the diag ring (`packages/usage`'s
// `~/.tokenlighten/diag`) — out of scope for `packages/cli` and `packages/
// types` (a sibling agent owns `packages/usage`); left for a follow-up.
// ---------------------------------------------------------------------------

function parseLegacyShimValue(content: string, varName: string): string | undefined {
  // POSIX shim: `VAR='...'` (single-quoted, `'"'"'` = an embedded quote).
  const posix = content.match(new RegExp(`${varName}=('(?:[^']|'"'"')*')`));
  if (posix?.[1]) {
    const inner = posix[1].slice(1, -1).replace(/'"'"'/g, "'");
    return inner.length > 0 ? inner : undefined;
  }
  // Windows shim: `set "VAR=..."`.
  const windows = content.match(new RegExp(`set "${varName}=([^"]*)"`));
  if (windows?.[1]) return windows[1].length > 0 ? windows[1] : undefined;
  return undefined;
}

/** The exact bytes of the forwarder this install writes over a pre-v0.14.3
 * legacy shim — shared by the writer and by uninstall's ownership check. */
function legacyForwarderBody(targetAbsPath: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `@echo off\r\ncall "${targetAbsPath}" %*\r\n`
    : `#!/bin/sh\nexec "${targetAbsPath}" "$@"\n`;
}

function writeLegacyForwarder(shimPath: string, targetAbsPath: string, platform: NodeJS.Platform): void {
  const body = legacyForwarderBody(targetAbsPath, platform);
  const tmp = makeTmpPath(shimPath);
  writeFileSync(tmp, body, { encoding: "utf8", mode: platform === "win32" ? 0o644 : 0o755 });
  retryRename(tmp, shimPath);
}

export interface LegacyShimMigration {
  shimPath: string;
  migrated: boolean;
  recordedCli?: string;
  recordedElectron?: string;
}

export interface LegacyShimDetection {
  shimPath: string;
  target: string;
  recordedCli?: string;
  recordedElectron?: string;
}

/* Read-only half of the legacy-shim migration (review S1): detects whether
 * `~/.tokenlighten/bin/tl(.cmd)` exists and looks like a TokenLighten
 * launcher, WITHOUT writing anything — `computePlan` uses this so the plan
 * (and `--dry-run`) can disclose the rewrite before it happens, not only
 * report it afterward. Returns undefined when there is nothing to migrate
 * (no legacy shim, or the file at that path isn't a TokenLighten launcher
 * at all). */
function detectLegacyShim(
  platform: NodeJS.Platform,
  installHome: string,
  homeDir: string,
): LegacyShimDetection | undefined {
  const shimPath = legacyLauncherPath({ platform, homeDir });
  if (!existsSync(shimPath)) return undefined;
  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  if (!content.includes("TokenLighten launcher")) return undefined;
  const recordedCli = parseLegacyShimValue(content, "TL_RECORDED");
  const recordedElectron = parseLegacyShimValue(content, "TL_ELECTRON");
  const target = managedLauncherPath({ installHome, platform });
  return {
    shimPath,
    target,
    ...(recordedCli ? { recordedCli } : {}),
    ...(recordedElectron ? { recordedElectron } : {}),
  };
}

/* Returns undefined when there is nothing to migrate (no legacy shim, or the
 * file at that path isn't a TokenLighten launcher at all). */
function migrateLegacyShim(
  platform: NodeJS.Platform,
  installHome: string,
  homeDir: string,
): LegacyShimMigration | undefined {
  const detected = detectLegacyShim(platform, installHome, homeDir);
  if (!detected) return undefined;
  const { shimPath, target, recordedCli, recordedElectron } = detected;
  try {
    writeLegacyForwarder(shimPath, target, platform);
    return { shimPath, migrated: true, ...(recordedCli ? { recordedCli } : {}), ...(recordedElectron ? { recordedElectron } : {}) };
  } catch {
    return { shimPath, migrated: false, ...(recordedCli ? { recordedCli } : {}), ...(recordedElectron ? { recordedElectron } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface InstallPlan {
  version: string;
  installedBy: InstallSource;
  sourceDir: string;
  installHome: string;
  appDir: string;
  runtimePath: string;
  writePosture: "allow-write" | "read-only";
  hostsToRegister: readonly TokenLightenRegistrationClient[];
  workspaces: readonly string[];
  /** Recorded workspaces that no longer exist on disk and were dropped. */
  workspaceWarnings: readonly string[];
  /** PID of a live `tl mcp start` background server this run will stop. */
  runningServerPid?: number;
  /** POSIX only: `ps` lines for host-spawned `tl.js mcp start` processes. */
  hostSpawnedProcesses: readonly string[];
  /** DESIGN-v0.14-mcp-only-install.md §4.6 C3/C4: present only for a
   * `--from-extension` run that kept an existing archive install's bundled
   * Node runtime instead of replacing it with Electron. */
  extensionDeferred?: {
    reason: "bundled-runtime-kept";
    extensionVersion: string;
    machineVersion: string;
    appUpgraded: boolean;
  };
  /** Review S1: disclosed BEFORE the rewrite happens (also in --dry-run) —
   * `migrateLegacyShim` performs the write described here, unchanged. */
  legacyShim?: { path: string; action: "migrate-to-forwarder"; target: string };
  /** Resolved from `--copilot-inline-results` (default "raise") — every
   * `--workspace` always gets the full per-workspace client set (§4.2),
   * so this alone (with `workspaces.length > 0`) decides whether
   * `formatPlan` discloses the pending `.vscode/settings.json` write. */
  copilotInlineResultsMode: CopilotInlineResultsMode;
}

function resolveInstalledBy(args: ParsedInstallArgs): InstallSource {
  if (args.fromExtension) return "vsix";
  if (args.dev) return "source";
  return "archive";
}

// DESIGN-v0.14-mcp-only-install.md §4.2 step 5 / §8: on POSIX, list any
// process a host spawned running this build (matched on the two possible
// entry-point basenames) so the report can print reload advice. Windows gets
// the advice text only (no reliable process-listing equivalent here).
function listHostSpawnedProcesses(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return [];
  try {
    const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5_000 });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /\btl(-cli)?\.js\s+mcp\s+start\b/.test(line));
  } catch {
    return [];
  }
}

async function computePlan(
  args: ParsedInstallArgs,
  deps: ReturnType<typeof resolvedDeps>,
): Promise<InstallPlan> {
  const installHome = resolveInstallHome({ home: args.home });
  // Read once, up front: both the C3/C4 coexistence decision below and the
  // §4.2 step 4 workspace-union fallback need the prior record.
  const priorRecord = readInstallRecord(installHome);
  const sourceDir = args.source ? resolvePathAbs(args.source) : defaultSourceDir();
  const extensionVersion = resolveSourceVersion(sourceDir, args.dev);

  // DESIGN-v0.14-mcp-only-install.md §4.6 C3: "an archive install replaces
  // an Electron runtime; a VSIX never replaces a bundled Node." Only kicks
  // in when a prior record PROVES a bundled-node runtime is still actually
  // there — a broken/missing bundled runtime self-heals back to today's
  // Electron staging via `resolveInstalledBy` below.
  const keepBundledRuntime = args.fromExtension
    && priorRecord?.runtime.source === "bundled-node"
    && existsSync(installNodePath(installHome, deps.platform));

  // C4: "the higher version wins; a downgrade needs --use or --force."
  let version = extensionVersion;
  let extensionDeferred: InstallPlan["extensionDeferred"];
  if (keepBundledRuntime && priorRecord) {
    const cmp = compareDottedVersions(extensionVersion, priorRecord.version);
    // `--force` is the documented way to restage a same or older version
    // (C4); the staged app and the recorded version must move TOGETHER —
    // pointing bin/tl.js at app/<extensionVersion> without staging it would
    // leave a launcher to a directory that does not exist.
    const appUpgraded = cmp > 0 || args.force;
    version = appUpgraded ? extensionVersion : priorRecord.version;
    extensionDeferred = {
      reason: "bundled-runtime-kept",
      extensionVersion,
      machineVersion: priorRecord.version,
      appUpgraded,
    };
  }

  const installedBy: InstallSource = keepBundledRuntime ? "archive" : resolveInstalledBy(args);
  const appDir = args.dev ? devCheckoutRoot() : installAppDir(installHome, version);
  const runtimePath = installedBy === "vsix"
    ? deps.execPath
    : installNodePath(installHome, deps.platform);

  let hostsToRegister: readonly TokenLightenRegistrationClient[] = [];
  if (args.clientsMode === "none") {
    hostsToRegister = [];
  } else if (args.clientsMode === "auto") {
    const statuses = await deps.getClientStatuses(undefined, { homeDir: deps.homeDir });
    hostsToRegister = statuses.clients
      .filter((status) => status.state !== "client-absent")
      .map((status) => status.client);
  } else {
    const registrationClients: readonly string[] = ALL_REGISTRATION_CLIENTS;
    hostsToRegister = args.clientsMode.filter(
      (client): client is TokenLightenRegistrationClient => registrationClients.includes(client),
    );
  }

  // DESIGN-v0.14-mcp-only-install.md §4.2 step 4 upgrade behaviour / C1
  // "every entry is derived from the record, no stale entries": the
  // workspace list is the UNION of any `--workspace` given THIS run and
  // every already-recorded workspace that still exists — not an either/or
  // on whether `--workspace` was passed, which used to silently drop an
  // earlier workspace's setup (stale identity in its `.vscode/mcp.json`)
  // whenever a later run named a DIFFERENT workspace explicitly (G1b).
  const workspaceWarnings: string[] = [];
  const recordedWorkspaces = (priorRecord?.workspaces ?? [])
    .map((entry) => entry.root)
    .filter((root) => !args.workspaces.some((given) => workspacePathsEqual(given, root, deps.platform)))
    .filter((root) => {
      const exists = existsSync(root) && lstatSync(root).isDirectory();
      if (!exists) workspaceWarnings.push(`recorded workspace no longer exists and was skipped: ${root}`);
      return exists;
    });
  const workspaces = [...args.workspaces, ...recordedWorkspaces];

  const pidPath = resolvePath("runtime", "mcp.pid");
  const pidData = readPidFile(pidPath);
  const runningServerPid = pidData && isPidAlive(pidData.pid) ? pidData.pid : undefined;

  // Review S1: detection only (no write) — surfaces the pending rewrite in
  // the plan/--dry-run BEFORE `performInstall` calls `migrateLegacyShim`.
  const legacyShimDetection = detectLegacyShim(deps.platform, installHome, deps.homeDir);

  return {
    version,
    installedBy,
    sourceDir,
    installHome,
    appDir,
    runtimePath,
    writePosture: args.readOnly ? "read-only" : "allow-write",
    hostsToRegister,
    workspaces,
    workspaceWarnings,
    ...(runningServerPid !== undefined ? { runningServerPid } : {}),
    hostSpawnedProcesses: listHostSpawnedProcesses(deps.platform),
    ...(legacyShimDetection
      ? { legacyShim: { path: legacyShimDetection.shimPath, action: "migrate-to-forwarder" as const, target: legacyShimDetection.target } }
      : {}),
    ...(extensionDeferred ? { extensionDeferred } : {}),
    copilotInlineResultsMode: args.copilotInlineResults ?? "raise",
  };
}

function formatPlan(plan: InstallPlan): string {
  const lines = [
    "TokenLighten install plan",
    "==========================",
    `Version:        ${plan.version} (${plan.installedBy})`,
    ...(plan.extensionDeferred
      ? [
        `Extension:      bundled Node kept (v${plan.extensionDeferred.machineVersion})`
          + (plan.extensionDeferred.appUpgraded
            ? `; app staged from the extension's v${plan.extensionDeferred.extensionVersion}`
            : `; extension's v${plan.extensionDeferred.extensionVersion} is not newer, nothing changed`),
      ]
      : []),
    `Source:         ${plan.sourceDir}`,
    `Install home:   ${plan.installHome}`,
    `App directory:  ${plan.appDir}`,
    `Runtime:        ${plan.runtimePath}`,
    `Write posture:  ${plan.writePosture}`,
    `Hosts:          ${plan.hostsToRegister.length > 0 ? plan.hostsToRegister.join(", ") : "(none)"}`,
    `Workspaces:     ${plan.workspaces.length > 0 ? plan.workspaces.join(", ") : "(none)"}`,
    ...(plan.legacyShim
      ? [`Legacy shim:    ${plan.legacyShim.path} -> forwarder to ${plan.legacyShim.target}`]
      : []),
    ...(plan.runningServerPid !== undefined
      ? [`Running server: PID ${plan.runningServerPid} will be stopped`]
      : []),
    ...(plan.hostSpawnedProcesses.length > 0
      ? [
        `Host-spawned processes: ${plan.hostSpawnedProcesses.length} found; `
          + "reload VS Code or restart agent sessions after upgrading to pick up the new version",
      ]
      : []),
    // Every `--workspace` always gets the full per-workspace client set
    // (§4.2), so vscode's config is written whenever there is a workspace
    // at all — this line is the user's consent for that write, shown
    // before the confirmation prompt, unless they opted out with
    // --copilot-inline-results keep.
    ...(plan.workspaces.length > 0 && plan.copilotInlineResultsMode !== "keep"
      ? [
        `Copilot inline results: will raise ${COPILOT_SETTINGS_KEY} to `
          + `${COPILOT_RAISED_THRESHOLD_BYTES} in each workspace's .vscode/settings.json `
          + "(pass --copilot-inline-results keep to skip)",
      ]
      : []),
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface InstallHostReport {
  client: string;
  mechanism: InstallHostMechanism;
  state: string;
  manualCommand?: string;
}

export interface InstallLegacyShimReport {
  path: string;
  migrated: boolean;
  recordedCli?: string;
  recordedElectron?: string;
}

export interface InstallWorkspaceReport {
  root: string;
  files: string[];
  guideBlock: boolean;
  copilotInlineResults?: CopilotInlineResultsReport;
}

export interface InstallVerifyReport {
  doctorOk: boolean;
  handshakeOk: boolean;
  serverName?: string;
  tools?: string[];
  error?: string;
}

export interface InstallReport {
  ok: boolean;
  version: string;
  installedBy: InstallSource;
  installHome: string;
  appDir: string;
  runtimePath: string;
  writePosture: "allow-write" | "read-only";
  hosts: InstallHostReport[];
  workspaces: InstallWorkspaceReport[];
  usageLogPath: string;
  uninstallCommand: string;
  verify?: InstallVerifyReport;
  legacyShim?: InstallLegacyShimReport;
  /** Review (c) "exit code 2": present exactly when no host ended in
   * "registered-managed" and `--clients none` was not explicitly requested
   * — a pasteable snippet per detected-but-unregistered host, plus a
   * generic fallback, since there is otherwise no vendor CLI to run for the
   * user. */
  manualSnippets?: ClientSnippetResult[];
  warnings: string[];
}

function usageLogPath(installHome: string): string {
  return join(installHome, "usage.log");
}

// Review B7: nothing puts `<home>/bin` on PATH (by design — R2), so a bare
// `tl install --uninstall`/`tl install --use <version>` is not runnable by
// an archive/vsix user — print the ABSOLUTE form instead. POSIX uses the
// managed human shim (`<home>/bin/tl`, itself a fallback chain that finds a
// working runtime); Windows invokes `node.exe`/`tl.js` directly rather than
// through `tl.cmd` to sidestep any shell-specific quoting around a `.cmd`.
function uninstallCommandFor(installHome: string, homeArg: string | undefined, platform: NodeJS.Platform): string {
  const homeFlag = homeArg ? ` --home ${homeArg}` : "";
  if (platform === "win32") {
    const nodePath = installNodePath(installHome, platform);
    const cliJsPath = installCliJsPath(installHome);
    return `"${nodePath}" "${cliJsPath}" install --uninstall${homeFlag}`;
  }
  const managed = managedLauncherPath({ installHome, platform });
  return `"${managed}" install --uninstall${homeFlag}`;
}

function writeReportHuman(report: InstallReport, write: (s: string) => void): void {
  write(`TokenLighten ${report.ok ? "installed" : "install"}: version ${report.version} (${report.installedBy})\n`);
  write(`  App:     ${report.appDir}\n`);
  write(`  Runtime: ${report.runtimePath}\n`);
  write(`  Write posture: ${report.writePosture}\n`);
  if (report.legacyShim) {
    write(
      `  legacy shim: ${report.legacyShim.path} — `
        + (report.legacyShim.migrated ? "migrated to a forwarder\n" : "migration failed, left in place\n"),
    );
  }
  for (const host of report.hosts) {
    write(`  host ${host.client}: ${host.state}${host.manualCommand ? ` (manual: ${host.manualCommand})` : ""}\n`);
  }
  for (const workspace of report.workspaces) {
    write(`  workspace ${workspace.root}: ${workspace.files.length} file(s), guide_block=${workspace.guideBlock}\n`);
    const copilotLine = formatCopilotInlineResultsLine(workspace.root, workspace.copilotInlineResults);
    if (copilotLine !== undefined) write(`    ${copilotLine}\n`);
  }
  if (report.verify) {
    write(`  verify: doctor=${report.verify.doctorOk ? "ok" : "FAIL"} handshake=${report.verify.handshakeOk ? "ok" : "FAIL"}${report.verify.error ? ` (${report.verify.error})` : ""}\n`);
  }
  if (report.manualSnippets && report.manualSnippets.length > 0) {
    write("  no host is registered yet; manual setup:\n");
    for (const snippet of report.manualSnippets) {
      write(
        `    ${snippet.client}: ${snippet.addCommand ?? `see 'tl clients snippet --client ${snippet.client} --json' for the entry`}\n`,
      );
    }
  }
  write(`  usage log: ${report.usageLogPath}\n`);
  write(`  uninstall: ${report.uninstallCommand}\n`);
  for (const warning of report.warnings) write(`warning: ${warning}\n`);
}

// ---------------------------------------------------------------------------
// Root refusal
// ---------------------------------------------------------------------------

function refusesAsRoot(args: ParsedInstallArgs, deps: ReturnType<typeof resolvedDeps>): boolean {
  if (deps.platform === "win32") return false;
  if (args.allowRoot) return false;
  return deps.uid() === 0;
}

// ---------------------------------------------------------------------------
// Main install flow
// ---------------------------------------------------------------------------

interface InstallOutcome {
  exitCode: number;
  report?: InstallReport;
  plan?: InstallPlan;
  message?: string;
  /** Review B3: paths `performUninstall` could not fully remove (Windows —
   * a host still has `bin/node.exe`/`node.exe.old` open) but scheduled for
   * automatic removal once released; `install.json` is still gone, so this
   * is a successful, resumable uninstall, not a failure. */
  pendingRemoval?: string[];
}

async function performUse(args: ParsedInstallArgs): Promise<InstallOutcome> {
  const installHome = resolveInstallHome({ home: args.home });
  const record = readInstallRecord(installHome);
  if (!record) {
    return { exitCode: 1, message: `No machine install found at ${installHome}; run 'tl install' first.` };
  }
  const version = args.use!;
  // Review item 9 / (c): look up the EXACT entry THIS version was staged
  // with (recorded at stage time in `record.apps[]`) instead of re-deriving
  // it from the CURRENT record's `installed_by` — the prior bug, since a
  // record whose `installed_by` had since become "source" (a later `--dev`
  // run) made `--use <archived-version>` point `bin/tl.js` at the bare
  // `app/<version>` directory instead of `app/<version>/tl-cli.js`,
  // producing `ERR_UNSUPPORTED_DIR_IMPORT` on every host spawn.
  const appEntry = record.apps?.find((entry) => entry.version === version);
  let targetEntry: string;
  if (appEntry) {
    if (!existsSync(appEntry.entry)) {
      return {
        exitCode: 1,
        message: `Recorded entry for version ${version} is missing on disk (${appEntry.entry}); nothing changed.`,
      };
    }
    targetEntry = appEntry.entry;
  } else {
    // Fallback for install.json written before `apps[]` existed: a plain
    // archive/vsix layout always has `app/<version>/tl-cli.js`.
    const appDir = installAppDir(installHome, version);
    if (!existsSync(appDir)) {
      return { exitCode: 1, message: `Unknown version '${version}': it was never staged under ${installHome}; nothing changed.` };
    }
    const candidateEntry = join(appDir, "tl-cli.js");
    if (!existsSync(candidateEntry)) {
      return {
        exitCode: 1,
        message: `Unknown version '${version}': app/${version} does not look like a staged archive/vsix bundle (missing tl-cli.js); nothing changed.`,
      };
    }
    targetEntry = candidateEntry;
  }
  writeTlJsShim(installHome, targetEntry);
  const updated: InstallRecord = { ...record, version };
  writeInstallRecord(installHome, updated);
  return {
    exitCode: 0,
    message: `Switched to version ${version} (${targetEntry}).`,
  };
}

async function performPrune(args: ParsedInstallArgs): Promise<InstallOutcome> {
  const installHome = resolveInstallHome({ home: args.home });
  const record = readInstallRecord(installHome);
  if (!record) {
    return { exitCode: 1, message: `No machine install found at ${installHome}.` };
  }
  const appRoot = installAppRoot(installHome);
  const removed: string[] = [];
  if (existsSync(appRoot)) {
    for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === record.version) continue;
      rmSync(join(appRoot, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  if (removed.length > 0 && record.apps) {
    writeInstallRecord(installHome, {
      ...record,
      apps: record.apps.filter((entry) => !removed.includes(entry.version)),
    });
  }
  return { exitCode: 0, message: `Pruned ${removed.length} version(s): ${removed.join(", ") || "(none)"}` };
}

// Review B4: removes the managed guide blocks (via `removeAll`, called by
// the caller) AND the workspace-scoped MCP entries `tl workspace setup`
// wrote (`.vscode/mcp.json`, `.mcp.json`, `.codex/config.toml`) for exactly
// one recorded workspace root. Foreign (non-TokenLighten) entries in those
// files are left in place and surfaced as a warning, matching
// `removeManagedEntry`'s own ownership rule.
function removeWorkspaceMcpEntries(root: string): { removed: string[]; warnings: string[] } {
  const removed: string[] = [];
  const warnings: string[] = [];

  const jsonTargets: Array<{ file: string; rootKey: string }> = [
    { file: join(root, ".vscode", "mcp.json"), rootKey: "servers" },
    { file: join(root, ".mcp.json"), rootKey: "mcpServers" },
  ];
  for (const target of jsonTargets) {
    if (!existsSync(target.file)) continue;
    const outcome = removeManagedEntry({ file: target.file, rootKey: target.rootKey, name: "tokenlighten" });
    if (outcome.ok) {
      if (outcome.action === "removed") removed.push(target.file);
    } else {
      warnings.push(`${target.file}: ${outcome.detail}`);
    }
  }

  // `.codex/config.toml` is TOML, outside `mcpConfigFile.ts`'s JSON-only
  // scope, so it's handled inline via the same `readConfig`/`writeConfig`
  // primitives `workspace.ts`'s own `configureCodex` writer uses.
  const codexTarget = join(root, ".codex", "config.toml");
  if (existsSync(codexTarget)) {
    try {
      const doc = readConfig(codexTarget);
      const mcpServers = doc["mcp_servers"];
      const entry = mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)
        ? (mcpServers as Record<string, unknown>)["tokenlighten"]
        : undefined;
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const env = (entry as Record<string, unknown>)["env"];
        const managed = Boolean(env)
          && typeof env === "object"
          && !Array.isArray(env)
          && (env as Record<string, unknown>)["TOKENLIGHTEN_MANAGED"] === "1";
        if (managed) {
          delete (mcpServers as Record<string, unknown>)["tokenlighten"];
          writeConfig(codexTarget, doc);
          removed.push(codexTarget);
        } else {
          warnings.push(`${codexTarget}: a non-managed 'tokenlighten' entry exists under 'mcp_servers'; left in place`);
        }
      }
    } catch (error) {
      warnings.push(`${codexTarget}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { removed, warnings };
}

// Review B3: swallow every removal failure — the caller decides what to do
// with a `false` return (collect it as a pending removal) instead of the
// whole uninstall throwing and leaving install.json (and everything else)
// in a half-removed state that still looks "installed".
/**
 * Uninstall's half of the legacy-shim migration (§4.6 C7): the first v0.14.3
 * run replaced the pre-v0.14.3 `~/.tokenlighten/bin/tl` shim with a forwarder
 * to THIS install's managed launcher, and once the install is gone that
 * forwarder dangles (found on a real Windows box, 2026-09-18: the release
 * notes promised the removal, the code never did it). Removed only when the
 * file is byte-for-byte the forwarder this install writes for this home —
 * never a foreign file, a real older launcher, or a forwarder that points at
 * a different install home. Never throws.
 */
function removeOwnLegacyForwarder(
  platform: NodeJS.Platform,
  installHome: string,
  homeDir: string,
  rmSyncFn: typeof rmSync,
): string | undefined {
  try {
    const shimPath = legacyLauncherPath({ platform, homeDir });
    if (!existsSync(shimPath)) return undefined;
    const expected = legacyForwarderBody(managedLauncherPath({ installHome, platform }), platform);
    if (readFileSync(shimPath, "utf8") !== expected) return undefined;
    rmSyncFn(shimPath, { force: true });
    return shimPath;
  } catch {
    return undefined;
  }
}

function removeTolerant(path: string, rmSyncFn: typeof rmSync): boolean {
  try {
    rmSyncFn(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const WINDOWS_RETRY_UNSAFE_CHARS = /[%"^&|<>!]/;

// Review B3: a DIFFERENT process than the one running this uninstall (so it
// survives past this process's own exit — the self-uninstall case) retries
// removing the leftover `bin/` directory roughly every 2 seconds for about a
// minute, then removes the install home too once it is empty. Detached,
// hidden, and unref'ed so it never keeps the CLI process alive or visible.
// Skips scheduling (report-only) when either path could break out of the
// quoted cmd.exe argument. `spawnDetachedFn` is injectable so specs can
// assert the exact command line without spawning a real background process.
function scheduleWindowsRetryRemoval(
  binDir: string,
  installHome: string,
  spawnDetachedFn: (command: string, args: readonly string[]) => void,
): boolean {
  if (WINDOWS_RETRY_UNSAFE_CHARS.test(binDir) || WINDOWS_RETRY_UNSAFE_CHARS.test(installHome)) {
    return false;
  }
  // Shape verified on a real Windows 11 box (2026-09-18). The if/else MUST be
  // the last, fully parenthesised command of the chain: in the earlier shape
  // (`… & if not exist "X" (…) & ping …`) cmd.exe made the trailing `& ping`
  // part of the IF body, so with the directory still locked the loop spun
  // through all 30 iterations in milliseconds and never waited.
  const loop = `for /l %n in (1,1,30) do (rmdir /s /q "${binDir}" >nul 2>&1`
    + ` & (if exist "${binDir}" (ping -n 3 127.0.0.1 >nul)`
    + ` else (rmdir "${installHome}" >nul 2>&1 & exit /b 0)))`;
  // `/s /c "<line>"`: cmd.exe strips exactly the first and the last quote and
  // runs the rest verbatim, so the inner quoted paths survive as written
  // (see defaultSpawnDetached's windowsVerbatimArguments note).
  spawnDetachedFn("cmd.exe", ["/d", "/s", "/c", `"${loop}"`]);
  return true;
}

async function performUninstall(
  args: ParsedInstallArgs,
  deps: ReturnType<typeof resolvedDeps>,
): Promise<InstallOutcome> {
  const installHome = resolveInstallHome({ home: args.home });
  const record = readInstallRecord(installHome);
  // Review B2: `install.json` absent OR unparsable (both collapse to
  // `readInstallRecord` returning undefined) means there is nothing proven
  // to be a TokenLighten install at this home — refuse before any `rmSync`,
  // rather than blindly deleting `<home>/bin` and `<home>/app` (which
  // `--home .`/`--home ~` could point at an unrelated directory).
  if (!record) {
    return {
      exitCode: 1,
      message: `No TokenLighten install found at ${installHome}; nothing removed.`,
    };
  }

  // --- Hosts: unregister only what we own (review B3) ---------------------
  // `setClientProfile(..., "native", ...)` used to fail closed and skip
  // `unregisterClients` entirely the moment ANY client was foreign, then
  // report success anyway while every host kept pointing at the
  // about-to-be-deleted `bin/node`. Call the engine's own unregister
  // directly instead: it removes only "registered-managed"/"registered-legacy"
  // entries (vendor CLIs via their own remove command, copilot-cli via
  // `removeManagedEntry`) and leaves "registered-foreign" ones untouched with
  // a warning — exactly the ownership rule the rest of `clients.ts` uses.
  // A resolved launcher (from the record we just confirmed exists) is
  // threaded through so registration-state classification matches the REAL
  // identity, not the human-facing shim path.
  const launcher = resolveStableLauncher({ installHome, homeDir: deps.homeDir, platform: deps.platform });
  const unregisterResult = await deps.unregisterClients(
    ALL_REGISTRATION_CLIENTS,
    { installHome, homeDir: deps.homeDir, launcher },
    false,
  );
  const stillOwned = unregisterResult.clients.filter(
    (status) => status.state === "registered-managed" || status.state === "registered-legacy",
  );
  if (stillOwned.length > 0) {
    const names = stillOwned.map((status) => status.client).join(", ");
    return {
      exitCode: 1,
      message: [
        `Uninstall aborted: could not remove TokenLighten's registration for ${names}.`,
        `bin/ and app/ were left in place at ${installHome} so ${names} keep a working server.`,
        ...unregisterResult.warnings,
      ].join("\n"),
    };
  }

  // --- Workspaces: guide blocks + workspace MCP entries (review B4) -------
  // Only the workspaces THIS install actually recorded — never
  // `process.cwd()` (the old `setClientProfile(..., root = process.cwd())`
  // default), which could strip a managed block from an unrelated
  // repository the caller happened to be standing in (e.g. the VS Code
  // extension's own process cwd).
  const workspaceWarnings: string[] = [];
  for (const workspace of record.workspaces) {
    if (!existsSync(workspace.root)) {
      workspaceWarnings.push(`recorded workspace no longer exists and was skipped: ${workspace.root}`);
      continue;
    }
    const removedGuide = await removeAll({ repoRoot: workspace.root });
    workspaceWarnings.push(
      ...removedGuide.errors.map((item) => `${workspace.root}: ${item.path}: ${item.reason}`),
    );
    const mcpEntries = removeWorkspaceMcpEntries(workspace.root);
    workspaceWarnings.push(...mcpEntries.warnings);
    // Uninstall symmetry for the Copilot inline-results setting: only ever
    // removes the key, and only when its value is exactly what setup wrote
    // (see removeCopilotThresholdIfManaged's own doc comment for why the
    // file itself is never deleted). Best-effort and silent, like the
    // legacy-forwarder removal below.
    removeCopilotThresholdIfManaged(workspace.root);
  }

  // The dangling legacy forwarder goes first: it is identified by the managed
  // launcher path of THIS home, independent of whether bin/ removal succeeds.
  removeOwnLegacyForwarder(deps.platform, installHome, deps.homeDir, deps.rmSync);

  // Review B3: tolerant removal — a host (or, for the self-uninstall command
  // review B7 prints, THIS process before it exits) can still have
  // `bin/node.exe`/`node.exe.old` open on Windows: renaming is fine there,
  // but deleting fails with EPERM/EBUSY until the handle is released. Remove
  // everything that can be removed and never throw; `install.json` is always
  // attempted regardless of the other two outcomes, so a half-removed
  // install never keeps claiming to be installed.
  const binDir = installBinDir(installHome);
  const appRoot = installAppRoot(installHome);
  const recordPath = join(installHome, "install.json");
  const pendingRemoval: string[] = [];
  if (!removeTolerant(binDir, deps.rmSync)) pendingRemoval.push(binDir);
  if (!removeTolerant(appRoot, deps.rmSync)) pendingRemoval.push(appRoot);
  removeTolerant(recordPath, deps.rmSync);

  let retryScheduled = false;
  if (pendingRemoval.includes(binDir) && deps.platform === "win32") {
    retryScheduled = scheduleWindowsRetryRemoval(binDir, installHome, deps.spawnDetached);
  }

  const pendingMessages = pendingRemoval.map((path) => {
    // Only promise what will really happen: the background retry exists on
    // Windows alone (and only for a path it can quote safely).
    const followUp = retryScheduled
      ? "it will be removed automatically once released (retried in the background for about a minute)"
      : "delete it yourself once it is released";
    return `${path}: still in use; close your AI hosts (VS Code, terminal agent sessions) — ${followUp}.`;
  });

  return {
    exitCode: 0,
    ...(pendingRemoval.length > 0 ? { pendingRemoval } : {}),
    message: [
      pendingRemoval.length > 0
        ? `Uninstalled TokenLighten from ${installHome} (some files are still in use).`
        : `Uninstalled TokenLighten from ${installHome}.`,
      ...pendingMessages,
      ...unregisterResult.warnings,
      ...workspaceWarnings,
    ].join("\n"),
  };
}

async function performInstall(
  args: ParsedInstallArgs,
  deps: ReturnType<typeof resolvedDeps>,
): Promise<InstallOutcome> {
  if (refusesAsRoot(args, deps)) {
    return {
      exitCode: 1,
      message: "Refusing to install while running as root/uid 0 (it would land in the administrator's profile). Pass --allow-root to override.",
    };
  }

  for (const workspace of args.workspaces) {
    const resolved = resolvePathAbs(workspace);
    if (!existsSync(resolved) || !lstatSync(resolved).isDirectory()) {
      return { exitCode: 1, message: `Workspace is not a directory: ${resolved}` };
    }
  }

  if (!args.fromExtension && !args.dev) {
    const sourceDir = args.source ? resolvePathAbs(args.source) : defaultSourceDir();
    if (!detectArchiveLayout(sourceDir, deps.platform)) {
      return {
        exitCode: 1,
        message: `Not an archive layout (missing tl-cli.js or runtime/node beside it): ${sourceDir}. Pass --dev or --from-extension for other install modes.`,
      };
    }
  }

  const plan = await computePlan(args, deps);

  if (args.dryRun) {
    return { exitCode: 0, plan };
  }

  if (!args.yes) {
    if (!deps.isTTY) {
      return { exitCode: 1, plan, message: "Non-interactive shell; pass --yes to proceed without a prompt." };
    }
    const answer = await deps.confirm(`${formatPlan(plan)}\nProceed? [y/N] `);
    if (answer !== "y" && answer !== "yes") {
      return { exitCode: 1, plan, message: "Aborted; nothing was changed." };
    }
  }

  // --- Legacy shim migration (§4.6 C7) ------------------------------------
  const legacyMigration = migrateLegacyShim(deps.platform, plan.installHome, deps.homeDir);

  // --- Stop a running background server (§4.2 step 2 / §8) ----------------
  if (plan.runningServerPid !== undefined) {
    try {
      await stopMcp(resolvePath("runtime", "mcp.pid"), plan.runningServerPid);
    } catch {
      // Best effort — an install proceeds even if the old server could not
      // be stopped cleanly; the report's warnings already named the PID.
    }
  }

  // --- Stage --------------------------------------------------------------
  let runtimeCommand: string;
  // DESIGN-v0.14-mcp-only-install.md R3: "one stable identity for hosts
  // AND allowlists" carries env TOKENLIGHTEN_MANAGED=1 — this identity
  // feeds both host registration (clients.ts adds its own MANAGED_ENV
  // independently) and the per-workspace launcher below, so the marker
  // must originate here to reach `.vscode/mcp.json`/`.mcp.json`/
  // `.codex/config.toml` (workspace.ts only spreads `launcher.env`, it
  // never stamps this marker itself).
  let runtimeEnv: Record<string, string> = { TOKENLIGHTEN_MANAGED: "1" };
  let runtimeSource: InstallRuntimeSource;
  let appDirForIdentity: string;
  let stagedEntryAbsPath: string;

  if (args.dev) {
    runtimeCommand = stageDevRuntime(plan.installHome, deps.execPath, deps.platform);
    runtimeSource = "system-node";
    appDirForIdentity = devCheckoutRoot();
    stagedEntryAbsPath = devCliEntry();
  } else if (args.fromExtension && plan.extensionDeferred) {
    // DESIGN-v0.14-mcp-only-install.md §4.6 C3/C4: computePlan already
    // proved the recorded runtime is still bundled-node AND present on
    // disk — keep that identity instead of staging Electron. A broken or
    // missing bundled runtime instead falls through to the plain
    // `args.fromExtension` (Electron) branch below (self-heal).
    runtimeCommand = installNodePath(plan.installHome, deps.platform);
    runtimeSource = "bundled-node";
    if (plan.extensionDeferred.appUpgraded) {
      // C4: the extension's bundled version is newer (or --force) — stage
      // its app tree exactly like any other upgrade, but the runtime
      // identity STAYS bundled Node (C3: a VSIX never replaces it).
      const sourceDir = args.source ? resolvePathAbs(args.source) : defaultSourceDir();
      const staged = stageApp(plan.installHome, plan.version, sourceDir, args.force);
      appDirForIdentity = staged.appDir;
      stagedEntryAbsPath = join(staged.appDir, "tl-cli.js");
    } else {
      // C4: same or older, no --force — never downgrade/restage; reuse
      // the existing staged app untouched (plan.appDir/plan.version
      // already reflect the KEPT machine version, not the extension's).
      appDirForIdentity = plan.appDir;
      stagedEntryAbsPath = join(plan.appDir, "tl-cli.js");
    }
  } else if (args.fromExtension) {
    const sourceDir = args.source ? resolvePathAbs(args.source) : defaultSourceDir();
    const staged = stageApp(plan.installHome, plan.version, sourceDir, args.force);
    appDirForIdentity = staged.appDir;
    stagedEntryAbsPath = join(staged.appDir, "tl-cli.js");
    runtimeCommand = deps.execPath;
    runtimeEnv = { ELECTRON_RUN_AS_NODE: "1", TOKENLIGHTEN_MANAGED: "1" };
    runtimeSource = "electron:vscode";
  } else {
    const sourceDir = args.source ? resolvePathAbs(args.source) : defaultSourceDir();
    const layout = detectArchiveLayout(sourceDir, deps.platform)!;
    const staged = stageApp(plan.installHome, plan.version, sourceDir, args.force);
    appDirForIdentity = staged.appDir;
    stagedEntryAbsPath = join(staged.appDir, "tl-cli.js");
    runtimeCommand = stageRuntimeRenameSwap(
      plan.installHome,
      layout.runtimeNode,
      deps.platform,
      deps.spawnSync,
      deps.rmSync,
      deps.clearZoneIdentifier,
    );
    runtimeSource = "bundled-node";
  }

  const cliJsPath = writeTlJsShim(plan.installHome, stagedEntryAbsPath);

  const identity: InstallIdentity = {
    command: runtimeCommand,
    argsPrefix: [cliJsPath],
    env: runtimeEnv,
  };

  // Human-facing shim — never spawned by hosts (design §4.1).
  try {
    writeManagedLauncher({
      installHome: plan.installHome,
      platform: deps.platform,
      cliPath: cliJsPath,
      runtimePath: runtimeSource === "electron:vscode" ? undefined : runtimeCommand,
      electronPath: runtimeSource === "electron:vscode" ? runtimeCommand : undefined,
      runtimeIsElectron: runtimeSource === "electron:vscode",
    });
  } catch {
    // The human shim is a convenience; a failure here must not fail the
    // machine install itself (host identities never spawn it).
  }

  const priorRecord = readInstallRecord(plan.installHome);
  let record: InstallRecord = {
    schemaVersion: 1,
    version: plan.version,
    installed_by: plan.installedBy,
    runtime: { command: runtimeCommand, env: runtimeEnv, source: runtimeSource },
    identity,
    write_posture: plan.writePosture,
    ...(args.toolSurface !== undefined ? { tool_surface: args.toolSurface } : {}),
    ...(args.guideProfile !== undefined ? { guide_profile: args.guideProfile } : {}),
    hosts: priorRecord?.hosts ?? [],
    workspaces: priorRecord?.workspaces ?? [],
    apps: priorRecord?.apps ?? [],
    installed_at: deps.now(),
    source_dir: args.fromExtension || !args.dev
      ? (args.source ? resolvePathAbs(args.source) : defaultSourceDir())
      : appDirForIdentity,
  };
  // Review item 9: record THIS version's exact launch entry so a later
  // `--use <version>` can re-point `bin/tl.js` at it directly instead of
  // re-deriving the shape from the record's (possibly since-changed)
  // `installed_by` — see `performUse`.
  record = upsertInstallApp(record, {
    version: plan.version,
    dir: appDirForIdentity,
    entry: stagedEntryAbsPath,
  });
  writeInstallRecord(plan.installHome, record);

  // --- Hosts ---------------------------------------------------------------
  const hostReports: InstallHostReport[] = [];
  const hostEntries: InstallHostEntry[] = [];
  if (plan.hostsToRegister.length > 0) {
    const engineOptions: ClientsEngineOptions = {
      installHome: plan.installHome,
      writePosture: plan.writePosture,
      homeDir: deps.homeDir,
    };
    const result = await deps.registerClients(plan.hostsToRegister, engineOptions, args.force);
    for (const status of result.clients) {
      hostReports.push({
        client: status.client,
        mechanism: mechanismForClient(status.client),
        state: status.state,
        ...(status.manualCommand ? { manualCommand: status.manualCommand } : {}),
      });
      hostEntries.push({
        client: status.client,
        mechanism: mechanismForClient(status.client),
        state: status.state,
        ...(status.manualCommand ? { file: status.manualCommand } : {}),
      });
    }
  }
  record = { ...record, hosts: hostEntries };
  writeInstallRecord(plan.installHome, record);

  // --- Workspaces ------------------------------------------------------------
  // DESIGN-v0.14-mcp-only-install.md §4.2: `--clients` governs ONLY
  // machine-wide host registration (`plan.hostsToRegister` above — vendor
  // CLIs / user-scope config files). Every `--workspace` always receives
  // the full per-workspace client set, exactly like `tl workspace setup`'s
  // own default (achieved here simply by not overriding `clients`/
  // `rulesOnly` at all) — deliberately decoupled from `args.clientsMode`.
  // v0.14.3 fix: `--clients none` used to also suppress `.vscode/mcp.json`,
  // `.mcp.json`, and `.codex/config.toml`, breaking
  // `--from-extension --clients none` (the VS Code extension's own call).
  const workspaceReports: InstallWorkspaceReport[] = [];
  const registryWarnings: string[] = [];
  for (const workspace of plan.workspaces) {
    const root = resolvePathAbs(workspace);
    const setupResult = await deps.setupWorkspace({
      root,
      launcher: { command: identity.command, argsPrefix: [...identity.argsPrefix], env: identity.env },
      installHomeDefault: isDefaultInstallHome({ home: args.home }),
      ...(args.toolSurface !== undefined ? { toolSurface: args.toolSurface } : {}),
      ...(args.guideProfile !== undefined ? { guideProfile: args.guideProfile } : {}),
      copilotInlineResults: plan.copilotInlineResultsMode,
    });
    const entry: InstallWorkspaceEntry = {
      root: setupResult.workspaceRoot,
      files: [...setupResult.rulesWritten, ...setupResult.configFilesWritten],
      guide_block: setupResult.rulesWritten.length > 0,
    };
    record = writeInstallRecordSafely(plan.installHome, upsertInstallWorkspace(record, entry));
    workspaceReports.push({
      root: entry.root,
      files: [...entry.files],
      guideBlock: entry.guide_block,
      ...(setupResult.copilotInlineResults ? { copilotInlineResults: setupResult.copilotInlineResults } : {}),
    });
    // B5 fix: install.json's workspaces[] (just upserted above) is a
    // different store from the workspace REGISTRY (config.toml
    // `workspaces.entries`) that `tl workspace status`/`list` and the VS
    // Code extension's activation probe actually read — `tl workspace
    // setup`'s own runWorkspace() writes both, this loop used to write only
    // the former. Never fail the install over a registry write failure
    // (same spirit as runWorkspace's own "workspace-registry-write-failed"
    // handling).
    try {
      deps.recordWorkspaceSetup(setupResult, deps.registryPath);
    } catch (error: unknown) {
      registryWarnings.push(
        `workspace ${setupResult.workspaceRoot}: setup succeeded but the workspace registry was not updated: ${String(error)}`,
      );
    }
  }

  // --- Verify ----------------------------------------------------------------
  const doctorResult: DoctorResult = await deps.evaluateDoctor({ development: false, homeDir: deps.homeDir });
  const handshakeCwd = plan.workspaces[0] ? resolvePathAbs(plan.workspaces[0]) : process.cwd();
  const handshake = await deps.runMcpHandshake({
    command: identity.command,
    args: [...identity.argsPrefix, "mcp", "start", "--stdio", "--no-prereq-check"],
    env: identity.env,
    cwd: handshakeCwd,
    timeoutMs: 20_000,
  });
  const verify: InstallVerifyReport = {
    doctorOk: doctorResult.ok,
    handshakeOk: handshake.ok
      && handshake.serverInfo?.name === "@tokenlighten/mcp-server"
      && Array.isArray(handshake.tools)
      && handshake.tools.length === 3,
    ...(handshake.serverInfo?.name ? { serverName: handshake.serverInfo.name } : {}),
    ...(handshake.tools ? { tools: handshake.tools } : {}),
    ...(handshake.error ? { error: handshake.error } : {}),
  };

  const verified = verify.doctorOk && verify.handshakeOk;
  // Review (c) "exit code 2 is unreachable as documented": the old gate
  // (`hostAttempted && !anyHostManaged`) was 0 whenever `--clients auto`
  // found no host at all, since `plan.hostsToRegister` (and therefore
  // `hostReports`) is empty in that case — the exact "no host was found to
  // register" scenario the docs say exits 2. Gate on the OUTCOME (is any
  // host actually managed now?) instead of on whether registration was
  // attempted, and treat `--clients none` as the one deliberate opt-out.
  const anyHostManaged = hostReports.some((host) => host.state === "registered-managed");
  const clientsNoneRequested = args.clientsMode === "none";
  const needsManualHostSetup = !clientsNoneRequested && !anyHostManaged;
  const exitCode = !verified ? 3 : (needsManualHostSetup ? 2 : 0);

  let manualSnippets: ClientSnippetResult[] | undefined;
  if (needsManualHostSetup) {
    const snippetOptions = {
      launcher: { command: identity.command, argsPrefix: [...identity.argsPrefix], env: identity.env, source: "bundled-runtime" as const },
      writePosture: plan.writePosture,
    };
    // `hostReports` is empty when `--clients auto` found no host at all (or
    // an explicit `--clients` list resolved to nothing) — fall back to every
    // advertised host so the user still gets a concrete snippet per client,
    // not just the generic one.
    const unmanagedClients: readonly TokenLightenRegistrationClient[] = hostReports.length > 0
      ? hostReports
        .filter((host) => host.state !== "registered-managed")
        .map((host) => host.client as TokenLightenRegistrationClient)
      : ALL_REGISTRATION_CLIENTS;
    manualSnippets = [
      ...unmanagedClients.map((client) => buildClientSnippet(client, snippetOptions)),
      buildClientSnippet("generic", snippetOptions),
    ];
  }

  const report: InstallReport = {
    ok: exitCode === 0,
    version: plan.version,
    installedBy: plan.installedBy,
    installHome: plan.installHome,
    appDir: appDirForIdentity,
    runtimePath: runtimeCommand,
    writePosture: plan.writePosture,
    hosts: hostReports,
    workspaces: workspaceReports,
    usageLogPath: usageLogPath(plan.installHome),
    uninstallCommand: uninstallCommandFor(plan.installHome, args.home, deps.platform),
    verify,
    ...(manualSnippets ? { manualSnippets } : {}),
    ...(legacyMigration
      ? {
        legacyShim: {
          path: legacyMigration.shimPath,
          migrated: legacyMigration.migrated,
          ...(legacyMigration.recordedCli ? { recordedCli: legacyMigration.recordedCli } : {}),
          ...(legacyMigration.recordedElectron ? { recordedElectron: legacyMigration.recordedElectron } : {}),
        },
      }
      : {}),
    warnings: [
      ...plan.workspaceWarnings,
      ...registryWarnings,
      ...(plan.hostSpawnedProcesses.length > 0
        ? [
          `host-spawned TokenLighten process(es) found: ${plan.hostSpawnedProcesses.length}; `
            + "reload VS Code or restart agent sessions to pick up the new version",
        ]
        : []),
      ...(legacyMigration && !legacyMigration.migrated
        ? [`legacy launcher migration failed for ${legacyMigration.shimPath}; left in place`]
        : []),
    ],
  };

  return { exitCode, report, plan };
}

function writeInstallRecordSafely(installHome: string, record: InstallRecord): InstallRecord {
  writeInstallRecord(installHome, record);
  return record;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runInstall(argv: string[], injectedDeps: InstallDeps = {}): Promise<void> {
  if (wantsHelp(argv)) {
    process.stdout.write(INSTALL_USAGE);
    return;
  }
  const args = parseInstallArgs(argv);
  // Mirrors --guide-profile/--tool-surface's validation style in `tl
  // workspace setup` (workspace.ts's runWorkspace): a clear stderr message
  // plus exit code 1, checked before any other flag-dependent work so a
  // typo never silently proceeds under the default "raise" behavior.
  if (
    args.copilotInlineResults !== undefined
    && !isCopilotInlineResultsMode(args.copilotInlineResults)
  ) {
    process.stderr.write(
      `tl install: unrecognized --copilot-inline-results value '${String(args.copilotInlineResults)}' (expected ${COPILOT_INLINE_RESULTS_VALUES.join(" | ")})\n`,
    );
    process.exitCode = 1;
    return;
  }
  const deps = resolvedDeps(injectedDeps);

  let outcome: InstallOutcome;
  if (args.use) {
    outcome = await performUse(args);
  } else if (args.prune) {
    outcome = await performPrune(args);
  } else if (args.uninstall) {
    outcome = await performUninstall(args, deps);
  } else {
    outcome = await performInstall(args, deps);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: outcome.exitCode === 0,
      exitCode: outcome.exitCode,
      ...(outcome.plan ? { plan: outcome.plan } : {}),
      ...(outcome.report ? { report: outcome.report } : {}),
      ...(outcome.message ? { message: outcome.message } : {}),
      ...(outcome.pendingRemoval ? { pendingRemoval: outcome.pendingRemoval } : {}),
    })}\n`);
  } else {
    if (args.dryRun && outcome.plan) {
      process.stdout.write(formatPlan(outcome.plan));
    }
    if (outcome.report) {
      writeReportHuman(outcome.report, (s) => process.stdout.write(s));
    }
    if (outcome.message) {
      (outcome.exitCode === 0 ? process.stdout : process.stderr).write(`${outcome.message}\n`);
    }
  }

  if (outcome.exitCode !== 0) {
    process.exitCode = outcome.exitCode;
  }
}
