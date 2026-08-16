import { resolve } from "node:path";
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

interface StatusProbeResult extends WorkspaceMcpSettings {
  schemaVersion: 1;
  workspaceRoot: string;
  configured: boolean;
}

let cachedRoot: string | undefined;
let cachedConfigured = false;
let cachedSettings: WorkspaceMcpSettings | undefined;
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
): void {
  const nextRoot = canonicalWorkspacePath(root);
  const nextSettings = configured
    ? settings ?? { writeEnabled: true, usageLoggingEnabled: true }
    : undefined;
  const changed =
    cachedRoot !== nextRoot
    || cachedConfigured !== configured
    || cachedSettings?.writeEnabled !== nextSettings?.writeEnabled
    || cachedSettings?.usageLoggingEnabled !== nextSettings?.usageLoggingEnabled;
  cachedRoot = nextRoot;
  cachedConfigured = configured;
  cachedSettings = nextSettings;
  if (changed) notify();
}

export function invalidateWorkspaceConfigured(): void {
  const changed = cachedRoot !== undefined || cachedConfigured;
  cachedRoot = undefined;
  cachedConfigured = false;
  cachedSettings = undefined;
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
    return result as unknown as StatusProbeResult;
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
  );
  return status?.configured === true ? "ready" : "not-configured";
}
