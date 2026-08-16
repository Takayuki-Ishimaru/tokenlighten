import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { injectAll } from "@tokenlighten/agents-md";
import type {
  TokenLightenSetupClient,
  TokenLightenWorkspaceListResult,
  TokenLightenWorkspaceSetupResult,
  TokenLightenWorkspaceSummary,
} from "@tokenlighten/types";
import {
  getNestedKey,
  readConfig,
  setNestedKey,
  writeConfig,
} from "../config.js";
import { resolveStableLauncher } from "../launcher.js";
import { configFilePath } from "../paths.js";

const CLIENTS = new Set<TokenLightenSetupClient>([
  "vscode",
  "codex",
  "claude-code",
]);

const WORKSPACE_USAGE = `\
Usage:
  tl workspace setup [--root DIR] [--clients vscode,codex,claude-code] [--rules-only] [--json]
  tl workspace status [--root DIR] [--json]
  tl workspace list [--json]

Setup creates AI rules and project-scoped MCP settings. Status verifies one
workspace without changing it. List reports every
workspace registered by setup on this machine for desktop-wide management.
TokenLighten write tools and local privacy-preserving usage logging are enabled
by default.
`;

function assertInsideRoot(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Refusing to write outside the selected workspace");
  }
}

function assertNotSymlink(target: string): void {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked setup file: ${target}`);
  }
}

function writeJsonAtomic(
  root: string,
  target: string,
  value: Record<string, unknown>,
): void {
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  const parent = dirname(target);
  assertNotSymlink(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary =
    `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, target);
}

function readJsonObject(target: string): Record<string, unknown> {
  if (!existsSync(target)) return {};
  assertNotSymlink(target);
  const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${target}`);
  }
  return parsed as Record<string, unknown>;
}

function objectMember(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = parent[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    parent[key] = created;
    return created;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected '${key}' to be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function serverConfig(
  root: string,
  client: "vscode" | "claude-code",
  launcher: SetupLauncher,
): Record<string, unknown> {
  return {
    command: launcher.command,
    args: [
      ...launcher.argsPrefix,
      "mcp",
      "start",
      "--stdio",
      "--allow-write",
      "--workspace",
      root,
    ],
    env: {
      ...launcher.env,
      TOKENLIGHTEN_CLIENT: client,
      TOKENLIGHTEN_USAGE_LOG: "on",
    },
  };
}

function configureVsCode(root: string, launcher: SetupLauncher): string {
  const target = join(root, ".vscode", "mcp.json");
  const document = readJsonObject(target);
  const servers = objectMember(document, "servers");
  servers["tokenlighten"] = serverConfig(root, "vscode", launcher);
  writeJsonAtomic(root, target, document);
  return target;
}

function configureClaude(root: string, launcher: SetupLauncher): string {
  const target = join(root, ".mcp.json");
  const document = readJsonObject(target);
  const servers = objectMember(document, "mcpServers");
  servers["tokenlighten"] = {
    type: "stdio",
    ...serverConfig(root, "claude-code", launcher),
  };
  writeJsonAtomic(root, target, document);
  return target;
}

function configureCodex(root: string, launcher: SetupLauncher): string {
  const target = join(root, ".codex", "config.toml");
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  assertNotSymlink(dirname(target));
  const document = readConfig(target);
  setNestedKey(document, "mcp_servers.tokenlighten", {
    command: launcher.command,
    args: [
      ...launcher.argsPrefix,
      "mcp",
      "start",
      "--stdio",
      "--allow-write",
      "--workspace",
      root,
    ],
    env: {
      ...launcher.env,
      TOKENLIGHTEN_CLIENT: "codex",
      TOKENLIGHTEN_USAGE_LOG: "on",
    },
    enabled: true,
  });
  writeConfig(target, document);
  return target;
}

export async function setupWorkspace(options: {
  root: string;
  clients?: readonly TokenLightenSetupClient[];
  launcher?: SetupLauncher;
  rulesOnly?: boolean;
}): Promise<TokenLightenWorkspaceSetupResult> {
  const requestedRoot = resolve(options.root);
  if (!existsSync(requestedRoot) || !lstatSync(requestedRoot).isDirectory()) {
    throw new Error(`Workspace folder does not exist: ${requestedRoot}`);
  }
  const root = realpathSync(requestedRoot);
  const clients = options.rulesOnly
    ? []
    : options.clients && options.clients.length > 0
      ? [...new Set(options.clients)]
      : ["vscode", "codex", "claude-code"] satisfies TokenLightenSetupClient[];
  for (const client of clients) {
    if (!CLIENTS.has(client)) throw new Error(`Unsupported client: ${client}`);
  }

  const rules = await injectAll({
    repoRoot: root,
    targets: ["claude", "copilot"],
    driftMode: "auto-rewrite",
  });
  const configFilesWritten: string[] = [];
  const launcher = options.launcher ?? {
    command: "tl",
    argsPrefix: [],
    env: {},
  };
  for (const client of clients) {
    if (client === "vscode") {
      configFilesWritten.push(configureVsCode(root, launcher));
    }
    if (client === "codex") {
      configFilesWritten.push(configureCodex(root, launcher));
    }
    if (client === "claude-code") {
      configFilesWritten.push(configureClaude(root, launcher));
    }
  }
  return {
    schemaVersion: 1,
    workspaceRoot: root,
    clients,
    writeEnabled: true,
    usageLoggingEnabled: true,
    rulesWritten: rules.wrote,
    configFilesWritten,
    warnings: rules.drifted.map((item) => `Rule drift: ${item.path}`),
  };
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export interface SetupLauncher {
  command: string;
  argsPrefix: string[];
  env: Record<string, string>;
}

function parseWorkspaceSummary(value: unknown): TokenLightenWorkspaceSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw["workspaceRoot"] !== "string"
    || !Array.isArray(raw["clients"])
    || !raw["clients"].every(
      (client) => typeof client === "string"
        && CLIENTS.has(client as TokenLightenSetupClient),
    )
    || typeof raw["writeEnabled"] !== "boolean"
    || typeof raw["usageLoggingEnabled"] !== "boolean"
    || !Array.isArray(raw["configFilesWritten"])
    || !raw["configFilesWritten"].every((item) => typeof item === "string")
    || typeof raw["updatedAt"] !== "string"
  ) {
    return null;
  }
  return {
    workspaceRoot: raw["workspaceRoot"],
    clients: raw["clients"] as TokenLightenSetupClient[],
    writeEnabled: raw["writeEnabled"],
    usageLoggingEnabled: raw["usageLoggingEnabled"],
    configFilesWritten: raw["configFilesWritten"] as string[],
    updatedAt: raw["updatedAt"],
  };
}

export function listWorkspaces(
  registryPath = configFilePath(),
): TokenLightenWorkspaceListResult {
  const stored = getNestedKey(readConfig(registryPath), "workspaces.entries");
  const workspaces = Array.isArray(stored)
    ? stored
      .map((entry) => parseWorkspaceSummary(entry))
      .filter((entry): entry is TokenLightenWorkspaceSummary => entry !== null)
      .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot))
    : [];
  return { schemaVersion: 1, workspaces };
}

export type WorkspaceStatusReason =
  | "ready"
  | "workspace-missing"
  | "registry-unavailable"
  | "not-registered"
  | "vscode-not-registered"
  | "vscode-config-invalid";

export interface WorkspaceStatusResult {
  schemaVersion: 1;
  workspaceRoot: string;
  configured: boolean;
  reason: WorkspaceStatusReason;
  writeEnabled?: boolean;
  usageLoggingEnabled?: boolean;
}

export function workspacePathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
  }
  return resolve(left) === resolve(right);
}

function existingWorkspacePathsEqual(left: string, right: string): boolean {
  try {
    if (
      !existsSync(left)
      || !existsSync(right)
      || !lstatSync(left).isDirectory()
      || !lstatSync(right).isDirectory()
    ) {
      return false;
    }
    return workspacePathsEqual(realpathSync(left), realpathSync(right));
  } catch {
    return false;
  }
}

function hasValidVsCodeServer(
  root: string,
  writeEnabled: boolean,
  usageLoggingEnabled: boolean,
): boolean {
  const target = join(root, ".vscode", "mcp.json");
  try {
    if (
      !existsSync(target)
      || lstatSync(target).isSymbolicLink()
      || lstatSync(dirname(target)).isSymbolicLink()
    ) {
      return false;
    }
    const document = readJsonObject(target);
    const servers = document["servers"];
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return false;
    }
    const server = (servers as Record<string, unknown>)["tokenlighten"];
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      return false;
    }
    const raw = server as Record<string, unknown>;
    const args = raw["args"];
    const env = raw["env"];
    if (
      !Array.isArray(args)
      || !args.every((value) => typeof value === "string")
      || !env
      || typeof env !== "object"
      || Array.isArray(env)
    ) {
      return false;
    }
    const stringArgs = args as string[];
    const workspaceIndex = stringArgs.indexOf("--workspace");
    const configuredRoot = stringArgs[workspaceIndex + 1];
    const variables = env as Record<string, unknown>;
    return stringArgs.includes("mcp")
      && stringArgs.includes("start")
      && stringArgs.includes("--stdio")
      && stringArgs.includes("--allow-write") === writeEnabled
      && workspaceIndex >= 0
      && typeof configuredRoot === "string"
      && existingWorkspacePathsEqual(configuredRoot, root)
      && variables["TOKENLIGHTEN_CLIENT"] === "vscode"
      && variables["TOKENLIGHTEN_USAGE_LOG"] === (usageLoggingEnabled ? "on" : "off");
  } catch {
    return false;
  }
}

export function workspaceStatus(
  requestedRoot: string,
  registryPath = configFilePath(),
): WorkspaceStatusResult {
  const fallbackRoot = resolve(requestedRoot);
  if (!existsSync(fallbackRoot) || !lstatSync(fallbackRoot).isDirectory()) {
    return {
      schemaVersion: 1,
      workspaceRoot: fallbackRoot,
      configured: false,
      reason: "workspace-missing",
    };
  }
  const root = realpathSync(fallbackRoot);
  let registry: TokenLightenWorkspaceListResult;
  try {
    registry = listWorkspaces(registryPath);
  } catch {
    return {
      schemaVersion: 1,
      workspaceRoot: root,
      configured: false,
      reason: "registry-unavailable",
    };
  }
  const entry = registry.workspaces.find(
    (workspace) => existingWorkspacePathsEqual(workspace.workspaceRoot, root),
  );
  if (!entry) {
    return {
      schemaVersion: 1,
      workspaceRoot: root,
      configured: false,
      reason: "not-registered",
    };
  }
  if (!entry.clients.includes("vscode")) {
    return {
      schemaVersion: 1,
      workspaceRoot: root,
      configured: false,
      reason: "vscode-not-registered",
    };
  }
  if (
    !hasValidVsCodeServer(root, entry.writeEnabled, entry.usageLoggingEnabled)
  ) {
    return {
      schemaVersion: 1,
      workspaceRoot: root,
      configured: false,
      reason: "vscode-config-invalid",
    };
  }
  return {
    schemaVersion: 1,
    workspaceRoot: root,
    configured: true,
    reason: "ready",
    writeEnabled: entry.writeEnabled,
    usageLoggingEnabled: entry.usageLoggingEnabled,
  };
}

function workspaceRootOf(entry: unknown): string {
  const raw = entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)["workspaceRoot"]
    : undefined;
  return typeof raw === "string" ? raw : "";
}

type WorkspaceSetupRegistration = Omit<
  TokenLightenWorkspaceSetupResult,
  "writeEnabled" | "usageLoggingEnabled"
> & {
  readonly writeEnabled: boolean;
  readonly usageLoggingEnabled: boolean;
};

export function recordWorkspaceSetup(
  result: WorkspaceSetupRegistration,
  registryPath = configFilePath(),
  updatedAt = new Date().toISOString(),
): void {
  const document = readConfig(registryPath);
  const stored = getNestedKey(document, "workspaces.entries");
  const own = {
    workspaceRoot: result.workspaceRoot,
    clients: [...result.clients],
    writeEnabled: result.writeEnabled,
    usageLoggingEnabled: result.usageLoggingEnabled,
    configFilesWritten: [...result.configFilesWritten],
    updatedAt,
  };
  // Entries this build cannot parse are preserved verbatim: a newer
  // TokenLighten may have written them, and rewriting only what this build
  // understands would silently delete that data.
  const entries: unknown[] = [];
  let replaced = false;
  for (const entry of Array.isArray(stored) ? stored : []) {
    const parsed = parseWorkspaceSummary(entry);
    if (parsed === null) {
      entries.push(entry);
      continue;
    }
    if (parsed.workspaceRoot === result.workspaceRoot) {
      if (!replaced) {
        entries.push(own);
        replaced = true;
      }
      continue;
    }
    entries.push({
      workspaceRoot: parsed.workspaceRoot,
      clients: [...parsed.clients],
      writeEnabled: parsed.writeEnabled,
      usageLoggingEnabled: parsed.usageLoggingEnabled,
      configFilesWritten: [...parsed.configFilesWritten],
      updatedAt: parsed.updatedAt,
    });
  }
  if (!replaced) entries.push(own);
  entries.sort((left, right) =>
    workspaceRootOf(left).localeCompare(workspaceRootOf(right)),
  );
  setNestedKey(
    document,
    "workspaces.entries",
    entries as Parameters<typeof setNestedKey>[2],
  );
  writeConfig(registryPath, document);
}

export interface WorkspaceSetupJsonWarning {
  readonly code: "workspace-rule-drift" | "workspace-registry-write-failed";
  readonly target: string;
  readonly recovery: string;
}

export interface RunWorkspaceOptions {
  readonly registryPath?: string;
  readonly launcher?: SetupLauncher;
}

function jsonWarnings(
  result: TokenLightenWorkspaceSetupResult,
  registryWarning?: WorkspaceSetupJsonWarning,
): WorkspaceSetupJsonWarning[] {
  const warnings: WorkspaceSetupJsonWarning[] = result.warnings.map((warning) => ({
    code: "workspace-rule-drift",
    target: warning.startsWith("Rule drift: ")
      ? warning.slice("Rule drift: ".length)
      : result.workspaceRoot,
    recovery: "Review the managed rule file, then rerun workspace setup.",
  }));
  if (registryWarning) warnings.push(registryWarning);
  return warnings;
}

export async function runWorkspace(
  args: string[],
  options: RunWorkspaceOptions = {},
): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(WORKSPACE_USAGE);
    return;
  }
  if (sub === "status") {
    const result = workspaceStatus(
      valueAfter(rest, "--root") ?? process.cwd(),
    );
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    process.stdout.write(
      result.configured
        ? `TokenLighten is configured for ${result.workspaceRoot}.\n`
        : `TokenLighten is not configured for ${result.workspaceRoot} (${result.reason}).\n`,
    );
    return;
  }
  if (sub === "list") {
    const result = listWorkspaces();
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (result.workspaces.length === 0) {
      process.stdout.write("No TokenLighten workspaces are registered.\n");
      return;
    }
    for (const workspace of result.workspaces) {
      process.stdout.write(
        `${workspace.workspaceRoot} [${workspace.clients.join(", ") || "rules only"}]\n`,
      );
    }
    return;
  }
  if (sub !== "setup") {
    process.stderr.write(`tl workspace: unknown subcommand '${sub}'\n${WORKSPACE_USAGE}`);
    process.exitCode = 1;
    return;
  }
  const rawClients = valueAfter(rest, "--clients");
  const clients = rawClients
    ? rawClients.split(",").map((item) => item.trim()) as TokenLightenSetupClient[]
    : undefined;
  const result = await setupWorkspace({
    root: valueAfter(rest, "--root") ?? process.cwd(),
    ...(clients ? { clients } : {}),
    launcher: options.launcher
      ?? resolveStableLauncher({ allowBareFallback: true }),
    rulesOnly: rest.includes("--rules-only"),
  });
  const registryTarget = options.registryPath ?? configFilePath();
  let registryWarning: WorkspaceSetupJsonWarning | undefined;
  try {
    recordWorkspaceSetup(result, registryTarget);
  } catch (error: unknown) {
    registryWarning = {
      code: "workspace-registry-write-failed",
      target: registryTarget,
      recovery: "Fix registry access, then rerun 'tl workspace setup' for this workspace.",
    };
    process.stderr.write(
      `tl workspace: setup succeeded but the workspace registry was not updated: ${String(error)}\n`,
    );
  }
  if (rest.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      ...result,
      warnings: jsonWarnings(result, registryWarning),
    })}\n`);
    return;
  }
  process.stdout.write(
    `TokenLighten is ready for ${result.clients.join(", ")}.\n`
      + `AI rules: ${result.rulesWritten.length} file(s)\n`
      + `MCP settings: ${result.configFilesWritten.length} file(s)\n`
      + "Write tools: enabled\n"
      + "Usage log: local, content-free\n",
  );
}
