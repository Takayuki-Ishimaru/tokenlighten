import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import { findTlBinary, spawnTl } from "./cli.js";

export type WorkspaceActivationState =
  | "ready"
  | "disabled"
  | "untrusted"
  | "no-workspace"
  | "unavailable"
  | "not-configured";

export interface WorkspaceMcpSettings {
  writeEnabled: boolean;
  usageLoggingEnabled: boolean;
}

/** Version-independent host identity for a machine-scoped `tl install`
 * (DESIGN-v0.14-mcp-only-install.md §4.6 C2/C5) — mirrors
 * `@tokenlighten/types`' `InstallIdentity` without a cross-package
 * dependency (this file already keeps its own local mirror of the CLI's
 * status-probe shape, matching `StatusProbeResult` below). */
export interface MachineInstallIdentity {
  command: string;
  argsPrefix: readonly string[];
  env: Record<string, string>;
}

export interface MachineInstallInfo {
  version: string;
  installHome: string;
  identity: MachineInstallIdentity;
}

interface StatusProbeResult extends WorkspaceMcpSettings {
  schemaVersion: 1;
  workspaceRoot: string;
  configured: boolean;
  /** `null` when the CLI omits the field (older `tl`) or reports no
   * machine-scoped install for this host — always tolerated, never
   * required, per DESIGN-v0.14-mcp-only-install.md §4.6. */
  machineInstall: MachineInstallInfo | null;
}

let cachedRoot: string | undefined;
let cachedConfigured = false;
let cachedSettings: WorkspaceMcpSettings | undefined;
let cachedMachineInstall: MachineInstallInfo | null = null;
const listeners = new Set<() => void>();

function canonicalWorkspacePath(value: string): string {
  const canonical = resolve(value);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function prerequisiteState(): WorkspaceActivationState | null {
  const configuration = vscode.workspace.getConfiguration(
    "tokenlighten",
    vscode.workspace.workspaceFolders?.[0]?.uri,
  );
  if (!configuration.get<boolean>("enabled", true)) return "disabled";
  if (!vscode.workspace.isTrusted) return "untrusted";
  if (!workspaceRoot()) return "no-workspace";
  if (!findTlBinary()) return "unavailable";
  return null;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function setWorkspaceConfigured(
  root: string,
  configured: boolean,
  settings?: WorkspaceMcpSettings,
  machineInstall?: MachineInstallInfo | null,
): void {
  const nextRoot = canonicalWorkspacePath(root);
  const nextSettings = configured
    ? settings ?? { writeEnabled: true, usageLoggingEnabled: true }
    : undefined;
  const nextMachineInstall = machineInstall ?? null;
  const changed =
    cachedRoot !== nextRoot
    || cachedConfigured !== configured
    || cachedSettings?.writeEnabled !== nextSettings?.writeEnabled
    || cachedSettings?.usageLoggingEnabled !== nextSettings?.usageLoggingEnabled
    || JSON.stringify(cachedMachineInstall) !== JSON.stringify(nextMachineInstall);
  cachedRoot = nextRoot;
  cachedConfigured = configured;
  cachedSettings = nextSettings;
  cachedMachineInstall = nextMachineInstall;
  if (changed) notify();
}

export function invalidateWorkspaceConfigured(): void {
  const changed = cachedRoot !== undefined || cachedConfigured || cachedMachineInstall !== null;
  cachedRoot = undefined;
  cachedConfigured = false;
  cachedSettings = undefined;
  cachedMachineInstall = null;
  if (changed) notify();
}

export function onWorkspaceSetupStateChanged(
  listener: () => void,
): vscode.Disposable {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

export function workspaceMcpSettingsCached(): WorkspaceMcpSettings | null {
  return workspaceActivationStateCached() === "ready" && cachedSettings
    ? { ...cachedSettings }
    : null;
}

/**
 * The machine-scoped `tl install` identity last reported by `tl workspace
 * status --json` for the CURRENT workspace root, or `null` when no probe
 * has matched this root yet or the CLI reported none. Unlike
 * {@link workspaceMcpSettingsCached}, this is available for a workspace
 * that has never been "set up" — DESIGN-v0.14-mcp-only-install.md §4.6 C5:
 * the MCP provider's fallback definition for a never-set-up workspace uses
 * this identity when present, instead of always assuming today's
 * bundled-CLI-under-Electron invocation.
 */
export function machineInstallCached(): MachineInstallInfo | null {
  const root = workspaceRoot();
  if (!root || cachedRoot !== canonicalWorkspacePath(root)) return null;
  return cachedMachineInstall;
}

/**
 * Reads `<root>/.vscode/mcp.json` directly (no CLI spawn) and reports
 * whether it carries a managed TokenLighten entry
 * (`servers.tokenlighten.env.TOKENLIGHTEN_MANAGED === "1"`, written by
 * `tl workspace setup` / `tl install`). DESIGN-v0.14-mcp-only-install.md
 * §4.6 C5: the MCP provider must return no definition whenever this is
 * true — the workspace file already carries a live definition and VS
 * Code's collision policy would otherwise silently disable one copy
 * without saying why (vscode#334069). Symlink-guarded and fail-closed to
 * `false` on any read/parse error, matching diagnostics.ts's
 * `registrationStatus()` convention for the same file.
 */
export function vscodeMcpJsonManaged(root: string): boolean {
  try {
    const path = join(root, ".vscode", "mcp.json");
    if (!existsSync(path)) return false;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const servers = (parsed as Record<string, unknown>)["servers"];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return false;
    const entry = (servers as Record<string, unknown>)["tokenlighten"];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const env = (entry as Record<string, unknown>)["env"];
    if (!env || typeof env !== "object" || Array.isArray(env)) return false;
    return (env as Record<string, unknown>)["TOKENLIGHTEN_MANAGED"] === "1";
  } catch {
    return false;
  }
}

export function workspaceActivationStateCached(): WorkspaceActivationState {
  const prerequisite = prerequisiteState();
  if (prerequisite) return prerequisite;
  const root = workspaceRoot();
  if (
    !root
    || cachedRoot !== canonicalWorkspacePath(root)
    || !cachedConfigured
  ) {
    return "not-configured";
  }
  return "ready";
}

/**
 * Parses an optional `machine_install` field. Malformed or absent input
 * (older `tl`, or a host with no machine-scoped install) degrades to
 * `null` WITHOUT invalidating the rest of the probe — this field is
 * additive, never required (see `StatusProbeResult.machineInstall`'s
 * comment).
 */
function parseMachineInstall(value: unknown): MachineInstallInfo | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const version = obj["version"];
  const installHome = obj["install_home"];
  const identity = obj["identity"];
  if (typeof version !== "string" || typeof installHome !== "string") return null;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const identityObj = identity as Record<string, unknown>;
  const command = identityObj["command"];
  const argsPrefix = identityObj["argsPrefix"];
  const env = identityObj["env"];
  if (typeof command !== "string") return null;
  if (!Array.isArray(argsPrefix) || !argsPrefix.every((entry) => typeof entry === "string")) return null;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  const envObj = env as Record<string, unknown>;
  if (!Object.values(envObj).every((entry) => typeof entry === "string")) return null;
  return {
    version,
    installHome,
    identity: {
      command,
      argsPrefix: argsPrefix as string[],
      env: envObj as Record<string, string>,
    },
  };
}

function parseStatusProbe(
  stdout: string,
  root: string,
): StatusProbeResult | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const result = value as Record<string, unknown>;
    if (
      result["schemaVersion"] !== 1
      || typeof result["workspaceRoot"] !== "string"
      || typeof result["configured"] !== "boolean"
      || result["configured"] === true
        && (typeof result["writeEnabled"] !== "boolean"
          || typeof result["usageLoggingEnabled"] !== "boolean")
      || canonicalWorkspacePath(result["workspaceRoot"])
        !== canonicalWorkspacePath(root)
    ) {
      return null;
    }
    return {
      ...(result as unknown as StatusProbeResult),
      machineInstall: parseMachineInstall(result["machine_install"]),
    };
  } catch {
    return null;
  }
}

export async function workspaceActivationState(): Promise<WorkspaceActivationState> {
  const prerequisite = prerequisiteState();
  if (prerequisite) return prerequisite;
  const root = workspaceRoot();
  if (!root) return "no-workspace";
  const result = await spawnTl(
    ["workspace", "status", "--root", root, "--json"],
    { cwd: root },
  );
  const status = result.code === 0 ? parseStatusProbe(result.stdout, root) : null;
  setWorkspaceConfigured(
    root,
    status?.configured === true,
    status?.configured === true
      ? {
          writeEnabled: status.writeEnabled,
          usageLoggingEnabled: status.usageLoggingEnabled,
        }
      : undefined,
    status?.machineInstall ?? null,
  );
  return status?.configured === true ? "ready" : "not-configured";
}
