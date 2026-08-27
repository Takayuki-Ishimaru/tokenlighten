import { spawn } from "node:child_process";
import { injectAll, removeAll } from "@tokenlighten/agents-md";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  TokenLightenClientRegistrationStatus,
  TokenLightenClientsResult,
  TokenLightenRegistrationClient,
  TokenLightenHostProfile,
  TokenLightenHostProfileReason as HostProfileReason,
  TokenLightenHostProfileSelection as HostProfileSelection,
  TokenLightenHostActivationInput as HostActivationInput,
  TokenLightenClientProfileResult as ClientProfileResult,
} from "@tokenlighten/types";
import {
  findExecutableOnPath,
  managedLauncherPath,
  resolveStableLauncher,
  type StableLauncher,
  type StableLauncherOptions,
} from "../launcher.js";
import { wantsHelp } from "../util/helpFlag.js";

const SERVER_ID = "tokenlighten";
const CLIENTS = ["claude-code", "codex"] as const;
const MCP_ARGS = ["mcp", "start", "--stdio", "--allow-write"] as const;
const MANAGED_ENV = {
  TOKENLIGHTEN_USAGE_LOG: "on",
  TOKENLIGHTEN_MANAGED: "1",
} as const;
const VENDOR_CONFIG_WITHOUT_CLI_DETAIL =
  "vendor CLI is not on PATH, but a local configuration for this client was found; "
  + "install the CLI or run the manual command";

const CLIENTS_USAGE = `\
Usage:
  tl clients status [--client claude-code,codex] [--json]
  tl clients activate [--client claude-code,codex] [--dry-run] [--json]
  tl clients select [--client claude-code,codex] --request TEXT [--path FILE]... [--apply] [--json]
  tl clients profile --client claude-code,codex --profile tl|native [--root DIR] [--dry-run] [--json]
  tl clients register --client claude-code,codex [--json] [--force]
  tl clients unregister --client claude-code,codex [--json] [--force]

activate registers only capability-confirmed hosts; --dry-run makes it plan-only.
select is plan-only unless --apply is supplied, and ambiguity selects TL.
profile native removes only TokenLighten-managed registrations and guide blocks;
foreign entries and user-owned guide text are preserved.
`;

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export type ClientCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult>;

export interface ClientsEngineOptions extends StableLauncherOptions {
  runner?: ClientCommandRunner;
  launcher?: StableLauncher;
  /** Injectable vendor-config detection; defaults to `defaultVendorConfigProbe`. */
  vendorConfigProbe?: (client: TokenLightenRegistrationClient) => boolean;
}


// Conservative hypothesis values from the registered eligibility rule. They are
// deliberately internal rather than advertised compatibility thresholds.
const LOCAL_FILE_BUDGET_BYTES = 16 * 1024;
const LOCAL_PATH_LIMIT = 2;
const DISCOVERY_SIGNAL = /\b(search|find|locate|trace|scan|references?|usages?|rename|across|project|repository|repo|dependencies|callers?|implementations?|all\s+files?)\b|検索|横断|参照|依存|全ファイル|リポジトリ|探(?:す|して|し)|呼び出し元|実装/iu;
const ARTIFACT_SIGNAL = /\b(artifact|archive|zip|tar|pdf|docx|xlsx|pptx|spreadsheet|presentation|wiring|wire|integration|end[- ]to[- ]end)\b|アーカイブ|成果物|表計算|プレゼン|配線|統合/iu;
const MULTI_CONCERN_SIGNAL = /(?:^|\s)(?:also|then|and also)(?:\s|$)|[;；]|,\s*(?:and\s+)?(?:add|update|change|fix|remove|document|test|explain|preserve)\b|(?:さらに|加えて|および)|(?:し、|して、).*(?:設定|テスト|文書|確認|更新|修正|追加)/iu;
const LOCAL_OPERATION_SIGNAL = /\b(read|show|explain|tell|check|inspect|edit|change|fix|update|replace|add|remove)\b|読む|表示|説明|確認|教え|直|修正|変更|更新|置換|追加|削除/iu;

/**
 * Conservative, host-side selector. It uses only request shape and filesystem
 * facts, never benchmark/task identifiers. Uncertainty deliberately selects TL.
 */
export function selectHostProfile(input: HostActivationInput): HostProfileSelection {
  const request = input.request?.trim() ?? "";
  const paths = [...new Set((input.paths ?? []).filter(Boolean))];
  if (!request) return { profile: "tl", reason: "ambiguous-request" };
  if (ARTIFACT_SIGNAL.test(request)) return { profile: "tl", reason: "artifact-or-wiring" };
  if (DISCOVERY_SIGNAL.test(request)) return { profile: "tl", reason: "cross-file-or-discovery" };
  if (MULTI_CONCERN_SIGNAL.test(request)) return { profile: "tl", reason: "multi-concern" };
  if (paths.length < 1 || paths.length > LOCAL_PATH_LIMIT) {
    return { profile: "tl", reason: "path-unknown" };
  }
  if (!LOCAL_OPERATION_SIGNAL.test(request)) {
    return { profile: "tl", reason: "ambiguous-request" };
  }

  const probe = input.fileProbe ?? ((path: string) => {
    try {
      const stat = statSync(path);
      return { isFile: stat.isFile(), size: stat.size };
    } catch {
      return undefined;
    }
  });
  let totalBytes = 0;
  for (const path of paths) {
    const file = probe(path);
    if (!file?.isFile || !Number.isSafeInteger(file.size) || file.size < 0) {
      return { profile: "tl", reason: "path-unknown" };
    }
    totalBytes += file.size;
    if (totalBytes > LOCAL_FILE_BUDGET_BYTES) {
      return { profile: "tl", reason: "path-unknown" };
    }
  }
  return { profile: "native", reason: "known-local-single-site" };
}

interface EntryShape {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

let writeQueue: Promise<void> = Promise.resolve();

function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

export const defaultClientCommandRunner: ClientCommandRunner = (
  command,
  args,
) => new Promise((resolve) => {
  const child = spawn(command, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    resolve({
      status: null,
      stdout,
      stderr,
      ...(error.code ? { errorCode: error.code } : {}),
    });
  });
  child.once("close", (status) => {
    resolve({ status, stdout, stderr });
  });
});

function vendorBinary(client: TokenLightenRegistrationClient): string {
  return client === "claude-code" ? "claude" : "codex";
}

function getArgs(client: TokenLightenRegistrationClient): string[] {
  return client === "claude-code"
    ? ["mcp", "get", SERVER_ID]
    : ["mcp", "get", SERVER_ID, "--json"];
}

function removeArgs(client: TokenLightenRegistrationClient): string[] {
  return client === "claude-code"
    ? ["mcp", "remove", SERVER_ID, "--scope", "user"]
    : ["mcp", "remove", SERVER_ID];
}

export function currentCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@tokenlighten/cli/package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeVersion(output: string): string | undefined {
  const value = output.trim().split(/\r?\n/, 1)[0]?.trim();
  return value || undefined;
}

function findEntryShape(value: unknown): EntryShape {
  const found: EntryShape = {};
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (found.command === undefined && typeof record["command"] === "string") {
      found.command = record["command"];
    }
    if (
      found.args === undefined
      && Array.isArray(record["args"])
      && record["args"].every((item) => typeof item === "string")
    ) {
      found.args = record["args"] as string[];
    }
    const envValue = record["env"] ?? record["environment"];
    if (found.env === undefined && envValue && typeof envValue === "object" && !Array.isArray(envValue)) {
      const env: Record<string, string> = {};
      for (const [key, item] of Object.entries(envValue as Record<string, unknown>)) {
        if (typeof item === "string") env[key] = item;
      }
      found.env = env;
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(value);
  return found;
}

function parseEntryShape(raw: string): EntryShape {
  try {
    return findEntryShape(JSON.parse(raw));
  } catch {
    const command = raw.match(/^\s*(?:Command|command)\s*[:=]\s*["']?([^"'\r\n,]+)["']?\s*$/mi)?.[1]?.trim();
    const argsLine = raw.match(/^\s*(?:Args|args)\s*[:=]\s*(.+)$/mi)?.[1];
    let args: string[] | undefined;
    if (argsLine) {
      try {
        const parsed: unknown = JSON.parse(argsLine);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
          args = parsed;
        }
      } catch {
        args = argsLine.trim().split(/\s+/).filter(Boolean);
      }
    }
    return {
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      env: {
        ...(raw.includes("TOKENLIGHTEN_MANAGED=1")
          || /TOKENLIGHTEN_MANAGED\s*[:=]\s*["']?1/.test(raw)
          ? { TOKENLIGHTEN_MANAGED: "1" }
          : {}),
      },
    };
  }
}

function sameArgs(actual: readonly string[] | undefined): boolean {
  return actual !== undefined
    && actual.length === MCP_ARGS.length
    && actual.every((value, index) => value === MCP_ARGS[index]);
}

function launcherState(command: string | undefined, pathEnv: string | undefined): "launcher-ok" | "dangling" | "unknown" {
  if (!command) return "unknown";
  const path = isAbsolute(command)
    ? command
    : findExecutableOnPath(command, { pathEnv });
  if (!path || !existsSync(path)) return "dangling";
  try {
    return statSync(path).isFile() ? "launcher-ok" : "dangling";
  } catch {
    return "dangling";
  }
}

function shellDisplay(value: string): string {
  return /^[A-Za-z0-9_./:\\-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function registrationPayload(
  client: TokenLightenRegistrationClient,
  launcher: StableLauncher,
): { args: string[]; manualCommand: string } {
  const env = {
    TOKENLIGHTEN_CLIENT: client,
    ...MANAGED_ENV,
  };
  if (client === "claude-code") {
    const payload = JSON.stringify({
      type: "stdio",
      command: launcher.command,
      args: [...launcher.argsPrefix, ...MCP_ARGS],
      env,
    });
    const args = ["mcp", "add-json", SERVER_ID, payload, "--scope", "user"];
    return {
      args,
      manualCommand: ["claude", ...args].map(shellDisplay).join(" "),
    };
  }
  const args = [
    "mcp",
    "add",
    SERVER_ID,
    "--env",
    `TOKENLIGHTEN_CLIENT=${client}`,
    "--env",
    `TOKENLIGHTEN_USAGE_LOG=${MANAGED_ENV.TOKENLIGHTEN_USAGE_LOG}`,
    "--env",
    `TOKENLIGHTEN_MANAGED=${MANAGED_ENV.TOKENLIGHTEN_MANAGED}`,
    "--",
    launcher.command,
    ...launcher.argsPrefix,
    ...MCP_ARGS,
  ];
  return {
    args,
    manualCommand: ["codex", ...args].map(shellDisplay).join(" "),
  };
}

function absentManualCommand(
  client: TokenLightenRegistrationClient,
  options: ClientsEngineOptions,
): string {
  const launcher: StableLauncher = options.launcher ?? {
    command: managedLauncherPath(options),
    argsPrefix: [],
    env: {},
    source: "managed-shim",
  };
  return registrationPayload(client, launcher).manualCommand;
}

function managedEntry(entry: EntryShape, raw: string, expectedCommand: string): boolean {
  const marker = entry.env?.["TOKENLIGHTEN_MANAGED"] === "1"
    || raw.includes("TOKENLIGHTEN_MANAGED=1")
    || /TOKENLIGHTEN_MANAGED\s*[:=]\s*["']?1/.test(raw);
  return marker && sameArgs(entry.args) && entry.command === expectedCommand;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Second presence signal. A client can be installed as an editor extension or
 * desktop app while its CLI never lands on PATH (Codex ships no CLI with the
 * VS Code extension), so a local vendor configuration is evidence the product
 * itself exists. Detection never throws.
 */
export function defaultVendorConfigProbe(
  client: TokenLightenRegistrationClient,
  homeDirOverride?: string,
): boolean {
  let home: string;
  try {
    home = homeDirOverride ?? homedir();
  } catch {
    return false;
  }
  if (!home) return false;
  try {
    return client === "codex"
      ? isFile(join(home, ".codex", "config.toml")) || isDirectory(join(home, ".codex"))
      : isFile(join(home, ".claude.json")) || isDirectory(join(home, ".claude"));
  } catch {
    return false;
  }
}

async function inspectClient(
  client: TokenLightenRegistrationClient,
  options: ClientsEngineOptions,
): Promise<TokenLightenClientRegistrationStatus> {
  const runner = options.runner ?? defaultClientCommandRunner;
  const probe = options.vendorConfigProbe
    ?? ((target: TokenLightenRegistrationClient) =>
      defaultVendorConfigProbe(target, options.homeDir));
  const vendorConfigPresent = probe(client);
  const binary = vendorBinary(client);
  const versionResult = await runner(binary, ["--version"]);
  if (versionResult.errorCode === "ENOENT" || versionResult.status === null) {
    return {
      client,
      state: "client-absent",
      launcherState: "unknown",
      vendorConfigPresent,
      manualCommand: absentManualCommand(client, options),
      detail: vendorConfigPresent
        ? VENDOR_CONFIG_WITHOUT_CLI_DETAIL
        : (versionResult.errorCode ?? "client executable is unavailable"),
    };
  }
  const clientVersion = normalizeVersion(versionResult.stdout || versionResult.stderr);
  const get = await runner(binary, getArgs(client));
  if (get.errorCode === "ENOENT") {
    return {
      client,
      state: "client-absent",
      launcherState: "unknown",
      vendorConfigPresent,
      ...(clientVersion ? { clientVersion } : {}),
      manualCommand: absentManualCommand(client, options),
      ...(vendorConfigPresent ? { detail: VENDOR_CONFIG_WITHOUT_CLI_DETAIL } : {}),
    };
  }
  if (get.status !== 0) {
    return {
      client,
      state: "not-registered",
      launcherState: "unknown",
      vendorConfigPresent,
      ...(clientVersion ? { clientVersion } : {}),
      detail: (get.stderr || get.stdout).trim() || undefined,
    };
  }

  const raw = get.stdout || get.stderr;
  const entry = parseEntryShape(raw);
  const expectedCommand = options.launcher?.command ?? managedLauncherPath(options);
  const state = managedEntry(entry, raw, expectedCommand)
    ? "registered-managed"
    : "registered-foreign";
  const registeredVersionResult = state === "registered-managed" && entry.command
    ? await runner(entry.command, ["version"])
    : undefined;
  const tokenLightenVersion = registeredVersionResult?.status === 0
    ? normalizeVersion(registeredVersionResult.stdout || registeredVersionResult.stderr)
    : undefined;
  return {
    client,
    state,
    launcherState: launcherState(entry.command, options.pathEnv),
    vendorConfigPresent,
    ...(clientVersion ? { clientVersion } : {}),
    ...(tokenLightenVersion ? { tokenLightenVersion } : {}),
    ...(entry.command ? { recordedCommand: entry.command } : {}),
    ...(state === "registered-foreign"
      ? { detail: `A foreign '${SERVER_ID}' entry already exists; use --force only after reviewing it.` }
      : {}),
  };
}

async function inspectClients(
  clients: readonly TokenLightenRegistrationClient[],
  options: ClientsEngineOptions,
): Promise<TokenLightenClientRegistrationStatus[]> {
  const statuses: TokenLightenClientRegistrationStatus[] = [];
  for (const client of clients) {
    statuses.push(await inspectClient(client, options));
  }
  return statuses;
}

export async function getClientStatuses(
  clients: readonly TokenLightenRegistrationClient[] = CLIENTS,
  options: ClientsEngineOptions = {},
): Promise<TokenLightenClientsResult> {
  return {
    schemaVersion: 1,
    action: "status",
    ok: true,
    clients: await inspectClients(clients, options),
    changedClients: [],
    warnings: [],
  };
}

async function registerClientsUnlocked(
  clients: readonly TokenLightenRegistrationClient[],
  options: ClientsEngineOptions,
  force: boolean,
): Promise<TokenLightenClientsResult> {
  const before = await inspectClients(clients, options);
  const actionable = before.filter((status) =>
    status.state !== "client-absent"
    && (status.state !== "registered-foreign" || force));
  const blocked = before.filter((status) =>
    status.state === "registered-foreign" && !force);
  const unavailable = before.filter((status) => status.state === "client-absent");
  const warnings = [
    ...blocked.map((status) =>
      `${status.client}: foreign '${SERVER_ID}' entry was not overwritten`),
    ...unavailable.map((status) =>
      `${status.client}: vendor CLI is unavailable; use the returned manual command`),
  ];
  if (actionable.length === 0) {
    return {
      schemaVersion: 1,
      action: "register",
      ok: blocked.length === 0 && unavailable.length === 0,
      clients: before,
      changedClients: [],
      warnings,
    };
  }

  let launcher: StableLauncher;
  try {
    launcher = options.launcher ?? resolveStableLauncher(options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 1,
      action: "register",
      ok: false,
      clients: before.map((status) =>
        actionable.some((item) => item.client === status.client)
          ? { ...status, detail }
          : status),
      changedClients: [],
      warnings: [...warnings, detail],
    };
  }

  const runner = options.runner ?? defaultClientCommandRunner;
  const changedClients: TokenLightenRegistrationClient[] = [];
  for (const status of actionable) {
    const invocation = registrationPayload(status.client, launcher);
    const result = await runner(vendorBinary(status.client), invocation.args);
    if (result.status === 0) {
      changedClients.push(status.client);
    } else {
      warnings.push(
        `${status.client}: registration failed: ${(result.stderr || result.stdout).trim() || result.errorCode || "unknown error"}`,
      );
    }
  }
  const after = await inspectClients(clients, { ...options, launcher });
  return {
    schemaVersion: 1,
    action: "register",
    ok: blocked.length === 0
      && unavailable.length === 0
      && changedClients.length === actionable.length
      && after.every((status) => status.state === "registered-managed"),
    clients: after,
    changedClients,
    warnings,
  };
}

export function registerClients(
  clients: readonly TokenLightenRegistrationClient[],
  options: ClientsEngineOptions = {},
  force = false,
): Promise<TokenLightenClientsResult> {
  return serializeWrite(() => registerClientsUnlocked(clients, options, force));
}

async function unregisterClientsUnlocked(
  clients: readonly TokenLightenRegistrationClient[],
  options: ClientsEngineOptions,
  force: boolean,
): Promise<TokenLightenClientsResult> {
  const before = await inspectClients(clients, options);
  const runner = options.runner ?? defaultClientCommandRunner;
  const changedClients: TokenLightenRegistrationClient[] = [];
  const warnings: string[] = [];
  let blocked = false;
  for (const status of before) {
    if (status.state === "registered-foreign" && !force) {
      blocked = true;
      warnings.push(`${status.client}: foreign '${SERVER_ID}' entry was not removed`);
      continue;
    }
    if (status.state !== "registered-managed"
      && !(status.state === "registered-foreign" && force)) {
      continue;
    }
    const result = await runner(vendorBinary(status.client), removeArgs(status.client));
    if (result.status === 0) {
      changedClients.push(status.client);
    } else {
      warnings.push(
        `${status.client}: unregister failed: ${(result.stderr || result.stdout).trim() || result.errorCode || "unknown error"}`,
      );
    }
  }
  const after = await inspectClients(clients, options);
  return {
    schemaVersion: 1,
    action: "unregister",
    ok: !blocked
      && warnings.length === 0
      && after.every((status) =>
        status.state === "client-absent" || status.state === "not-registered"),
    clients: after,
    changedClients,
    warnings,
  };
}

export function unregisterClients(
  clients: readonly TokenLightenRegistrationClient[],
  options: ClientsEngineOptions = {},
  force = false,
): Promise<TokenLightenClientsResult> {
  return serializeWrite(() => unregisterClientsUnlocked(clients, options, force));
}

function profileResult(
  action: "activate" | "select" | "profile",
  selectedProfile: TokenLightenHostProfile,
  selectionReason: HostProfileReason,
  applied: boolean,
  result: TokenLightenClientsResult,
  requestedProfile?: TokenLightenHostProfile,
): ClientProfileResult {
  return {
    schemaVersion: 1,
    action,
    ...(requestedProfile ? { requestedProfile } : {}),
    selectedProfile,
    selectionReason,
    applied,
    ok: result.ok,
    clients: result.clients,
    changedClients: result.changedClients,
    warnings: result.warnings,
  };
}

export async function setClientProfile(
  clients: readonly TokenLightenRegistrationClient[],
  profile: TokenLightenHostProfile,
  options: ClientsEngineOptions = {},
  dryRun = false,
  root = process.cwd(),
): Promise<ClientProfileResult> {
  if (dryRun) {
    const clientsResult = await getClientStatuses(clients, options);
    const guide = profile === "native"
      ? await removeAll({ repoRoot: root, dryRun: true })
      : { planned: ["AGENTS.md", "5 client guide stubs"], errors: [] };
    return {
      ...profileResult("profile", profile, "explicit", false, clientsResult, profile),
      guideRoot: root,
      guideAction: profile === "tl" ? "inject" : "remove",
      guideChanged: [],
      guidePlanned: guide.planned,
      guideErrors: guide.errors.map((item) => `${item.path}: ${item.reason}`),
      profileReady: false,
      ok: clientsResult.ok && guide.errors.length === 0,
    };
  }

  let guideChanged: string[] = [];
  let guidePlanned: string[] = [];
  let guideErrors: string[] = [];
  let clientsResult: TokenLightenClientsResult;

  if (profile === "native") {
    // Fail closed before touching guides when a foreign registration blocks the
    // managed profile transition. Then remove guides before MCP: if a guide
    // target is malformed or unsafe, the capability remains available instead
    // of leaving instructions that advertise an already-removed server.
    const before = await getClientStatuses(clients, options);
    const foreign = before.clients.filter((status) => status.state === "registered-foreign");
    if (foreign.length > 0) {
      const reason = "guide removal skipped because a foreign MCP entry blocks the managed native profile";
      clientsResult = {
        ...before,
        ok: false,
        warnings: [
          ...before.warnings,
          ...foreign.map((status) => `${status.client}: foreign '${SERVER_ID}' entry was not removed`),
        ],
      };
      guideErrors = [reason];
    } else {
      const removed = await removeAll({ repoRoot: root });
      guideChanged = removed.removed;
      guidePlanned = removed.planned;
      guideErrors = removed.errors.map((item) => `${item.path}: ${item.reason}`);
      clientsResult = guideErrors.length === 0
        ? await unregisterClients(clients, options)
        : {
            ...before,
            ok: false,
            warnings: [
              ...before.warnings,
              "managed MCP registration retained because guide removal did not complete",
            ],
          };
    }
  } else {
    // Register MCP before injecting guides so a registration failure can never
    // leave newly generated instructions advertising an unavailable server.
    clientsResult = await registerClients(clients, options);
    if (clientsResult.ok) {
      try {
        const injected = await injectAll({ repoRoot: root, driftMode: "auto-rewrite" });
        guideChanged = [...injected.wrote];
        guideErrors = injected.skipped
          .filter((item) => !["already-up-to-date"].includes(item.reason))
          .map((item) => `${item.path}: ${item.reason}`);
      } catch (error) {
        guideErrors = [`${root}: ${error instanceof Error ? error.message : String(error)}`];
      }
    } else {
      guideErrors = ["guide operation skipped because managed MCP profile change did not succeed"];
    }
  }

  const ready = clientsResult.ok && guideErrors.length === 0;
  return {
    ...profileResult("profile", profile, "explicit", true, clientsResult, profile),
    ok: ready,
    guideRoot: root,
    guideAction: profile === "tl" ? "inject" : "remove",
    guideChanged,
    guidePlanned,
    guideErrors,
    profileReady: ready,
    warnings: [...clientsResult.warnings, ...guideErrors],
  };
}

function capableClients(
  statuses: readonly TokenLightenClientRegistrationStatus[],
): TokenLightenRegistrationClient[] {
  return statuses
    .filter((status) => status.state !== "client-absent")
    .map((status) => status.client);
}

function mergeClientStatuses(
  requested: readonly TokenLightenClientRegistrationStatus[],
  changed: readonly TokenLightenClientRegistrationStatus[],
): TokenLightenClientRegistrationStatus[] {
  const byClient = new Map(changed.map((status) => [status.client, status]));
  return requested.map((status) => byClient.get(status.client) ?? status);
}

export async function activateClients(
  clients: readonly TokenLightenRegistrationClient[],
  options: ClientsEngineOptions = {},
  dryRun = false,
): Promise<ClientProfileResult> {
  const before = await getClientStatuses(clients, options);
  const capable = capableClients(before.clients);
  const skipped = before.clients
    .filter((status) => status.state === "client-absent")
    .map((status) => `${status.client}: skipped because the vendor CLI is unavailable`);
  if (dryRun || capable.length === 0) {
    return {
      schemaVersion: 1,
      action: "activate",
      selectedProfile: "tl",
      selectionReason: "host-capability",
      applied: false,
      ok: dryRun || capable.length > 0,
      clients: before.clients,
      changedClients: [],
      warnings: capable.length > 0
        ? skipped
        : ["No requested host exposes an available vendor CLI; no configuration was changed."],
    };
  }
  const changed = await registerClients(capable, options);
  return profileResult(
    "activate",
    "tl",
    "host-capability",
    true,
    {
      ...changed,
      clients: mergeClientStatuses(before.clients, changed.clients),
      warnings: [...changed.warnings, ...skipped],
    },
  );
}

export async function selectClientProfile(
  clients: readonly TokenLightenRegistrationClient[],
  input: HostActivationInput,
  options: ClientsEngineOptions = {},
  apply = false,
  root = process.cwd(),
): Promise<ClientProfileResult> {
  const selection = selectHostProfile(input);
  if (!apply) {
    return profileResult(
      "select",
      selection.profile,
      selection.reason,
      false,
      await getClientStatuses(clients, options),
    );
  }
  const before = await getClientStatuses(clients, options);
  const capable = capableClients(before.clients);
  if (capable.length === 0) {
    return {
      schemaVersion: 1,
      action: "select",
      selectedProfile: selection.profile,
      selectionReason: selection.reason,
      applied: false,
      ok: false,
      clients: before.clients,
      changedClients: [],
      warnings: ["No requested host exposes an available vendor CLI; no configuration was changed."],
    };
  }
  const changed = await setClientProfile(
    capable,
    selection.profile,
    options,
    false,
    root,
  );
  const skipped = before.clients
    .filter((status) => status.state === "client-absent")
    .map((status) => `${status.client}: skipped because the vendor CLI is unavailable`);
  return {
    ...changed,
    action: "select",
    selectedProfile: selection.profile,
    selectionReason: selection.reason,
    clients: mergeClientStatuses(before.clients, changed.clients),
    warnings: [...changed.warnings, ...skipped],
  };
}

function parseClients(args: readonly string[], required: boolean): TokenLightenRegistrationClient[] {
  const index = args.indexOf("--client");
  const raw = index >= 0 ? args[index + 1] : undefined;
  if (!raw) {
    if (required) throw new Error("--client is required");
    return [...CLIENTS];
  }
  const values = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  for (const value of values) {
    if (!CLIENTS.includes(value as TokenLightenRegistrationClient)) {
      throw new Error(`Unsupported client: ${value}`);
    }
  }
  return values as TokenLightenRegistrationClient[];
}

function writeHuman(result: TokenLightenClientsResult | ClientProfileResult): void {
  if ("selectedProfile" in result) {
    process.stdout.write(
      `profile: ${result.selectedProfile} (${result.selectionReason}); ${result.applied ? "applied" : "plan only"}\n`,
    );
    if (result.guideAction) {
      process.stdout.write(
        `guide: ${result.guideAction} at ${result.guideRoot}; ${result.profileReady ? "ready" : "not ready"}\n`,
      );
    }
  }
  for (const status of result.clients) {
    const version = status.clientVersion ? ` (${status.clientVersion})` : "";
    const launcher = status.launcherState === "unknown" ? "" : `, ${status.launcherState}`;
    process.stdout.write(`${status.client}${version}: ${status.state}${launcher}\n`);
    if (status.manualCommand) process.stdout.write(`  manual: ${status.manualCommand}\n`);
    if (status.detail) process.stdout.write(`  ${status.detail}\n`);
  }
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
}

export async function runClients(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (!subcommand || wantsHelp(args)) {
    process.stdout.write(CLIENTS_USAGE);
    return;
  }
  if (!["status", "activate", "select", "profile", "register", "unregister"].includes(subcommand)) {
    process.stderr.write(`tl clients: unknown subcommand '${subcommand}'\n${CLIENTS_USAGE}`);
    process.exitCode = 1;
    return;
  }

  try {
    const clients = parseClients(rest, !["status", "activate", "select"].includes(subcommand));
    const force = rest.includes("--force");
    const valueAfter = (flag: string): string | undefined => {
      const index = rest.indexOf(flag);
      return index >= 0 ? rest[index + 1] : undefined;
    };
    const valuesAfter = (flag: string): string[] => rest.flatMap(
      (value, index) => value === flag && rest[index + 1] ? [rest[index + 1]!] : [],
    );
    const rawProfile = valueAfter("--profile");
    if (subcommand === "profile" && rawProfile !== "tl" && rawProfile !== "native") {
      throw new Error("--profile must be 'tl' or 'native'");
    }
    const result = subcommand === "status"
      ? await getClientStatuses(clients)
      : subcommand === "activate"
        ? await activateClients(clients, {}, rest.includes("--dry-run"))
        : subcommand === "select"
          ? await selectClientProfile(
            clients,
            { request: valueAfter("--request"), paths: valuesAfter("--path") },
            {},
            rest.includes("--apply"),
          )
          : subcommand === "profile"
          ? await setClientProfile(
            clients,
            rawProfile as TokenLightenHostProfile,
            {},
            rest.includes("--dry-run"),
            valueAfter("--root") ?? process.cwd(),
          )
          : subcommand === "register"
            ? await registerClients(clients, {}, force)
            : await unregisterClients(clients, {}, force);
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      writeHuman(result);
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`tl clients: ${error instanceof Error ? error.message : String(error)}\n${CLIENTS_USAGE}`);
    process.exitCode = 1;
  }
}
