import { spawn } from "node:child_process";
import { injectAll, removeAll } from "@tokenlighten/agents-md";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  TokenLightenClientRegistrationState,
  TokenLightenClientRegistrationStatus,
  TokenLightenClientsResult,
  TokenLightenRegistrationClient,
  TokenLightenHostProfile,
  TokenLightenHostProfileReason as HostProfileReason,
  TokenLightenHostProfileSelection as HostProfileSelection,
  TokenLightenHostActivationInput as HostActivationInput,
  TokenLightenClientProfileResult as ClientProfileResult,
  InstallHostMechanism,
} from "@tokenlighten/types";
import {
  findExecutableOnPath,
  legacyLauncherPath,
  managedLauncherPath,
  peekStableLauncher,
  resolveStableLauncher,
  type StableLauncher,
  type StableLauncherOptions,
} from "../launcher.js";
import {
  readManagedEntry,
  removeManagedEntry,
  writeManagedEntry,
} from "../mcpConfigFile.js";
import { wantsHelp } from "../util/helpFlag.js";
import { resolveSpawnTarget } from "../spawnCompat.js";

const SERVER_ID = "tokenlighten";
// DESIGN-v0.14-mcp-only-install.md §4.3 first wave: three vendor-CLI hosts
// (claude-code, codex, gemini) plus one config-file host (copilot-cli).
export const CLIENTS = ["claude-code", "codex", "gemini", "copilot-cli"] as const;
const COPILOT_CONFIG_ROOT_KEY = "mcpServers";
// DESIGN-v0.14-mcp-only-install.md §4.3/§4.6 C6: ownership is the managed
// marker plus a command match plus an args PREFIX match, not an exact tuple
// — the v0.14.3 identity's `argsPrefix` is `[<installHome>/bin/tl.js]`
// (non-empty), and a registered entry may carry trailing flags
// (`--allow-write`, `--tool-surface code`, …) beyond this fixed prefix.
const MCP_ARGS_PREFIX = ["mcp", "start", "--stdio"] as const;
const MANAGED_ENV = {
  TOKENLIGHTEN_USAGE_LOG: "on",
  TOKENLIGHTEN_MANAGED: "1",
} as const;
const VENDOR_CONFIG_WITHOUT_CLI_DETAIL =
  "vendor CLI is not on PATH, but a local configuration for this client was found; "
  + "install the CLI or run the manual command";

const CLIENTS_USAGE = `\
Usage:
  tl clients status [--client claude-code,codex,gemini,copilot-cli] [--json]
  tl clients activate [--client claude-code,codex,gemini,copilot-cli] [--dry-run] [--json]
  tl clients select [--client claude-code,codex,gemini,copilot-cli] --request TEXT [--path FILE]... [--apply] [--json]
  tl clients profile --client claude-code,codex,gemini,copilot-cli --profile tl|native [--root DIR] [--dry-run] [--json]
  tl clients register --client claude-code,codex,gemini,copilot-cli [--json] [--force]
  tl clients unregister --client claude-code,codex,gemini,copilot-cli [--json] [--force]
  tl clients snippet [--client claude-code,codex,gemini,copilot-cli,vscode-user,zed,opencode,codex-user,gemini-settings,generic] [--json]

activate registers only capability-confirmed hosts; --dry-run makes it plan-only.
select is plan-only unless --apply is supplied, and ambiguity selects TL.
profile native removes only TokenLighten-managed registrations and guide blocks;
foreign entries and user-owned guide text are preserved.
snippet always prints a pasteable entry, plus a one-line add command where a
vendor CLI exists; it never writes anything.
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
  /** DESIGN-v0.14-mcp-only-install.md §4.2 R7: `--read-only` omits
   * `--allow-write` from the generated args. Defaults to `"allow-write"`
   * (parity with today). */
  writePosture?: "allow-write" | "read-only";
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
  // Windows: `command` is frequently a vendor CLI's `.cmd` shim (npm-global
  // installs of claude/gemini/copilot/codex) or the `tl.cmd` launcher
  // recorded in a host's own config — Node refuses to exec either directly
  // without `shell:true` (`spawn EINVAL`). `resolveSpawnTarget` reroutes
  // through cmd.exe ONLY when `command` actually is a batch file; every
  // other platform/command passes through unchanged.
  const target = resolveSpawnTarget(command, args);
  const child = spawn(target.file, target.args, {
    // These commands manage user-level registrations. A workspace cwd makes
    // vendor CLIs resolve project MCP entries as if they were user entries.
    cwd: homedir(),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
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
  switch (client) {
    case "claude-code": return "claude";
    case "gemini": return "gemini";
    case "copilot-cli": return "copilot";
    case "codex": default: return "codex";
  }
}

// Only ever called for claude-code/codex (§4.3 "vendor CLI" clients that
// expose a single-server `get`); gemini has no such subcommand (only `mcp
// list`, parsed nowhere — status reads `~/.gemini/settings.json` directly,
// §4.3's documented storage location) and copilot-cli is a config-file host.
function getArgs(client: "claude-code" | "codex"): string[] {
  return client === "claude-code"
    ? ["mcp", "get", SERVER_ID]
    : ["mcp", "get", SERVER_ID, "--json"];
}

function removeArgs(client: "claude-code" | "codex" | "gemini"): string[] {
  switch (client) {
    case "claude-code": return ["mcp", "remove", SERVER_ID, "--scope", "user"];
    case "gemini": return ["mcp", "remove", "-s", "user", SERVER_ID];
    case "codex": default: return ["mcp", "remove", SERVER_ID];
  }
}

function geminiSettingsPath(homeDir: string): string {
  return join(homeDir, ".gemini", "settings.json");
}

// gemini's vendor CLI has no per-server `get` (only `add`/`list`/`remove`/
// `enable`/`disable` — verified against docs/tools/mcp-server.md,
// 2026-09-13); `mcp list` only prints a lossy "command: <str> (stdio)" line
// with no env. `add`/`list`/`remove` write and read `~/.gemini/settings.json`
// (user scope) directly, so status reads that file for full fidelity
// (command/args/env) instead of parsing `list` output.
function readGeminiEntry(options: ClientsEngineOptions): EntryShape {
  try {
    const home = options.homeDir ?? homedir();
    const raw = readFileSync(geminiSettingsPath(home), "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    const entry = parsed?.mcpServers?.[SERVER_ID];
    return entry ? findEntryShape(entry) : {};
  } catch {
    return {};
  }
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

function argsMatchPrefix(actual: readonly string[] | undefined, expectedPrefix: readonly string[]): boolean {
  return actual !== undefined
    && actual.length >= expectedPrefix.length
    && expectedPrefix.every((value, index) => actual[index] === value);
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
  client: "claude-code" | "codex" | "gemini",
  launcher: StableLauncher,
  writePosture: "allow-write" | "read-only" = "allow-write",
): { args: string[]; manualCommand: string } {
  const env = {
    TOKENLIGHTEN_CLIENT: client,
    ...MANAGED_ENV,
    ...launcher.env,
  };
  const postureArgs = writePosture === "allow-write" ? ["--allow-write"] : [];
  if (client === "claude-code") {
    const payload = JSON.stringify({
      type: "stdio",
      command: launcher.command,
      args: [...launcher.argsPrefix, ...MCP_ARGS_PREFIX, ...postureArgs],
      env,
    });
    const args = ["mcp", "add-json", SERVER_ID, payload, "--scope", "user"];
    return {
      args,
      manualCommand: ["claude", ...args].map(shellDisplay).join(" "),
    };
  }
  if (client === "gemini") {
    // docs/tools/mcp-server.md (2026-09-13): `gemini mcp add [options] <name>
    // <commandOrUrl> [args...]`, `-s/--scope`, `-e/--env`; flag-shaped
    // positional args need a literal `--` (yargs' end-of-options marker)
    // so `--stdio`/`--allow-write` aren't parsed as gemini's own flags.
    //
    // Verified 2026-09-13 against the actual gemini-cli source
    // (packages/cli/src/commands/mcp/add.ts, google-gemini/gemini-cli@main):
    // `add` declares `args` as a yargs variadic positional
    // (`add <name> <commandOrUrl> [args...]`) with
    // `unknown-options-as-args: true` + `populate--: true`, plus a
    // `.middleware()` that runs `argv.args = [...(argv.args ?? []),
    // ...(argv["--"] ?? [])]` before the handler — so the array gemini
    // actually stores in `~/.gemini/settings.json` is simply "the positional
    // args before `--`" concatenated with "everything after `--`", in that
    // order. That means putting every token after `--` (this file's
    // previous shape) and splitting non-flag tokens before `--`/flag-shaped
    // tokens after (this shape) produce byte-identical stored `args`; this
    // form is kept anyway because it mirrors the vendor's own documented
    // example exactly (`gemini mcp add python-server python server.py --
    // --server-arg my-value`: the non-flag positional before `--`, the
    // flag-shaped one after) — the safer choice if a future gemini-cli
    // release changes how `unknown-options-as-args` interacts with a bare
    // `--`. See `clients.spec.ts`'s "gemini ... mirrors the vendor's
    // documented before/after --split" test.
    const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const beforeDashDash = [...launcher.argsPrefix, ...MCP_ARGS_PREFIX.filter((token) => !token.startsWith("--"))];
    const afterDashDash = [...MCP_ARGS_PREFIX.filter((token) => token.startsWith("--")), ...postureArgs];
    const args = [
      "mcp",
      "add",
      "-s",
      "user",
      ...envArgs,
      SERVER_ID,
      launcher.command,
      ...beforeDashDash,
      "--",
      ...afterDashDash,
    ];
    return {
      args,
      manualCommand: ["gemini", ...args].map(shellDisplay).join(" "),
    };
  }
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const args = [
    "mcp",
    "add",
    SERVER_ID,
    ...envArgs,
    "--",
    launcher.command,
    ...launcher.argsPrefix,
    ...MCP_ARGS_PREFIX,
    ...postureArgs,
  ];
  return {
    args,
    manualCommand: ["codex", ...args].map(shellDisplay).join(" "),
  };
}

function absentManualCommand(
  client: "claude-code" | "codex" | "gemini",
  options: ClientsEngineOptions,
): string {
  const launcher: StableLauncher = options.launcher ?? {
    command: managedLauncherPath(options),
    argsPrefix: [],
    env: {},
    source: "managed-shim",
  };
  return registrationPayload(client, launcher, options.writePosture).manualCommand;
}

// DESIGN-v0.14-mcp-only-install.md §4.3 "Config-file writer" mechanism.
function copilotConfigPath(options: ClientsEngineOptions): string {
  return join(options.homeDir ?? homedir(), ".copilot", "mcp-config.json");
}

// Detection = "~/.copilot directory exists or `copilot` is on PATH" (design
// §4.3 first-wave row) — a second signal beyond the config file itself,
// mirroring `defaultVendorConfigProbe`'s reasoning for the vendor-CLI hosts.
function copilotCliDetected(options: ClientsEngineOptions): boolean {
  const home = options.homeDir ?? homedir();
  if (isDirectory(join(home, ".copilot"))) return true;
  return findExecutableOnPath("copilot", { pathEnv: options.pathEnv }) !== undefined;
}

function copilotEntry(
  launcher: StableLauncher,
  writePosture: "allow-write" | "read-only" = "allow-write",
): Record<string, unknown> {
  const postureArgs = writePosture === "allow-write" ? ["--allow-write"] : [];
  return {
    // docs.github.com/.../add-mcp-servers (2026-09-13): root key `mcpServers`,
    // `type: "local"`, `command`/`args`/`env`, `tools: ["*"]`.
    type: "local",
    command: launcher.command,
    args: [...launcher.argsPrefix, ...MCP_ARGS_PREFIX, ...postureArgs],
    env: { TOKENLIGHTEN_CLIENT: "copilot-cli", ...MANAGED_ENV, ...launcher.env },
    tools: ["*"],
  };
}

function managedEntry(
  entry: EntryShape,
  raw: string,
  expectedCommand: string,
  expectedArgsPrefix: readonly string[],
): boolean {
  const marker = entry.env?.["TOKENLIGHTEN_MANAGED"] === "1"
    || raw.includes("TOKENLIGHTEN_MANAGED=1")
    || /TOKENLIGHTEN_MANAGED\s*[:=]\s*["']?1/.test(raw);
  return marker && argsMatchPrefix(entry.args, expectedArgsPrefix) && entry.command === expectedCommand;
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
    switch (client) {
      case "codex":
        return isFile(join(home, ".codex", "config.toml")) || isDirectory(join(home, ".codex"));
      case "gemini":
        return isFile(geminiSettingsPath(home)) || isDirectory(join(home, ".gemini"));
      case "copilot-cli":
        return isDirectory(join(home, ".copilot"));
      case "claude-code":
      default:
        return isFile(join(home, ".claude.json")) || isDirectory(join(home, ".claude"));
    }
  } catch {
    return false;
  }
}

// DESIGN-v0.14-mcp-only-install.md §4.3: the mechanism table entry each
// client is registered through — drives `tl install`'s host report and
// `install.json`'s per-host `mechanism` field.
export function mechanismForClient(client: TokenLightenRegistrationClient): InstallHostMechanism {
  return client === "copilot-cli" ? "config-file" : "vendor-cli";
}

// DESIGN-v0.14-mcp-only-install.md §4.6 C7: ours, but stale — a vendor-CLI
// entry whose recorded command still points at the pre-v0.14.3
// `~/.tokenlighten/bin/tl` shim (by exact path or by living under its `bin/`
// directory) despite carrying the managed marker.
function isLegacyManagedEntry(
  entry: EntryShape,
  raw: string,
  options: ClientsEngineOptions,
): boolean {
  const marker = entry.env?.["TOKENLIGHTEN_MANAGED"] === "1"
    || raw.includes("TOKENLIGHTEN_MANAGED=1")
    || /TOKENLIGHTEN_MANAGED\s*[:=]\s*["']?1/.test(raw);
  if (!marker || !entry.command) return false;
  const home = options.homeDir ?? homedir();
  const legacyDir = join(home, ".tokenlighten", "bin");
  return entry.command === legacyLauncherPath({ homeDir: home, platform: options.platform })
    || entry.command.startsWith(legacyDir);
}

function classifyRegistrationState(
  entry: EntryShape,
  raw: string,
  expectedCommand: string,
  expectedArgsPrefix: readonly string[],
  options: ClientsEngineOptions,
): TokenLightenClientRegistrationState {
  if (managedEntry(entry, raw, expectedCommand, expectedArgsPrefix)) return "registered-managed";
  if (isLegacyManagedEntry(entry, raw, options)) return "registered-legacy";
  return "registered-foreign";
}

async function inspectCopilotCli(
  options: ClientsEngineOptions,
): Promise<TokenLightenClientRegistrationStatus> {
  const detected = copilotCliDetected(options);
  const file = copilotConfigPath(options);
  const expectedArgsPrefix = [...(options.launcher?.argsPrefix ?? []), ...MCP_ARGS_PREFIX];
  const read = readManagedEntry({ file, rootKey: COPILOT_CONFIG_ROOT_KEY, name: SERVER_ID }, expectedArgsPrefix);
  if (!detected) {
    return {
      client: "copilot-cli",
      state: "client-absent",
      launcherState: "unknown",
      vendorConfigPresent: read.exists,
      manualCommand: "tl clients snippet --client copilot-cli",
      detail: read.exists
        ? "a local configuration for this client was found, but Copilot CLI itself is unavailable"
        : "Copilot CLI is not installed (~/.copilot not found and 'copilot' is not on PATH)",
    };
  }
  if (read.parseError) {
    return {
      client: "copilot-cli",
      state: "not-registered",
      launcherState: "unknown",
      vendorConfigPresent: true,
      detail: `${file} could not be parsed as JSON`,
    };
  }
  if (!read.exists) {
    return {
      client: "copilot-cli",
      state: "not-registered",
      launcherState: "unknown",
      vendorConfigPresent: true,
    };
  }
  const state: TokenLightenClientRegistrationState = read.managed ? "registered-managed" : "registered-foreign";
  const entryCommand = read.entry?.command;
  const runner = options.runner ?? defaultClientCommandRunner;
  const registeredVersionResult = state === "registered-managed" && entryCommand
    ? await runner(entryCommand, ["version"])
    : undefined;
  const tokenLightenVersion = registeredVersionResult?.status === 0
    ? normalizeVersion(registeredVersionResult.stdout || registeredVersionResult.stderr)
    : undefined;
  return {
    client: "copilot-cli",
    state,
    launcherState: launcherState(entryCommand, options.pathEnv),
    vendorConfigPresent: true,
    ...(tokenLightenVersion ? { tokenLightenVersion } : {}),
    ...(entryCommand ? { recordedCommand: entryCommand } : {}),
    ...(state === "registered-foreign"
      ? { detail: `A foreign '${SERVER_ID}' entry already exists in ${file}; use --force only after reviewing it.` }
      : {}),
  };
}

async function inspectClient(
  client: TokenLightenRegistrationClient,
  options: ClientsEngineOptions,
): Promise<TokenLightenClientRegistrationStatus> {
  if (client === "copilot-cli") return inspectCopilotCli(options);

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

  if (client === "gemini") {
    const entry = readGeminiEntry(options);
    if (!entry.command) {
      return {
        client,
        state: "not-registered",
        launcherState: "unknown",
        vendorConfigPresent,
        ...(clientVersion ? { clientVersion } : {}),
      };
    }
    const raw = JSON.stringify(entry);
    const expectedCommand = options.launcher?.command ?? managedLauncherPath(options);
    const expectedArgsPrefix = [...(options.launcher?.argsPrefix ?? []), ...MCP_ARGS_PREFIX];
    const state = classifyRegistrationState(entry, raw, expectedCommand, expectedArgsPrefix, options);
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
  const expectedArgsPrefix = [...(options.launcher?.argsPrefix ?? []), ...MCP_ARGS_PREFIX];
  const state = classifyRegistrationState(entry, raw, expectedCommand, expectedArgsPrefix, options);
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
  // review B2: resolve the RECORDED machine identity once, centrally, for
  // every inspection call site (status/register/unregister alike) — never
  // via `resolveStableLauncher` (which would write a managed shim as a
  // side effect of a read-only status query). Without this, an unresolved
  // `options.launcher` falls back per-comparison to the human-facing shim
  // path with no args prefix, so a freshly registered entry (which used
  // the REAL `<home>/bin/node(.exe)` + `[<home>/bin/tl.js]` identity)
  // reads back as "registered-foreign" on every later status/re-register
  // call that doesn't happen to inject the same launcher explicitly.
  const launcher = options.launcher ?? peekStableLauncher(options);
  const effectiveOptions = launcher ? { ...options, launcher } : options;
  const statuses: TokenLightenClientRegistrationStatus[] = [];
  for (const client of clients) {
    statuses.push(await inspectClient(client, effectiveOptions));
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
    if (status.client === "copilot-cli") {
      const outcome = writeManagedEntry({
        file: copilotConfigPath(options),
        rootKey: COPILOT_CONFIG_ROOT_KEY,
        name: SERVER_ID,
        entry: copilotEntry(launcher, options.writePosture),
        force: true, // already gated above by the shared foreign/absent filter
        expectedArgsPrefix: [...launcher.argsPrefix, ...MCP_ARGS_PREFIX],
      });
      if (outcome.ok) {
        changedClients.push(status.client);
      } else {
        warnings.push(`${status.client}: registration failed: ${outcome.detail}`);
      }
      continue;
    }
    const invocation = registrationPayload(status.client, launcher, options.writePosture);
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
    // "registered-legacy" is ours (a stale pre-v0.14.3 registration) and is
    // removable just like "registered-managed" — no --force required.
    if (status.state !== "registered-managed"
      && status.state !== "registered-legacy"
      && !(status.state === "registered-foreign" && force)) {
      continue;
    }
    if (status.client === "copilot-cli") {
      const outcome = removeManagedEntry({
        file: copilotConfigPath(options),
        rootKey: COPILOT_CONFIG_ROOT_KEY,
        name: SERVER_ID,
        force: true, // already gated above
      });
      if (outcome.ok) {
        changedClients.push(status.client);
      } else {
        warnings.push(`${status.client}: unregister failed: ${outcome.detail}`);
      }
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

// DESIGN-v0.14-mcp-only-install.md §4.3 "Second wave"/"Snippet only" rows—
// hosts this design names but does not (yet) write to directly. Shapes are
// per the design table (§8 "Unverified host details" already flags Zed,
// Windsurf, and the VS Code user `mcp.json` Linux path as unverified).
const SNIPPET_ONLY_CLIENTS = [
  "vscode-user",
  "zed",
  "opencode",
  "codex-user",
  "gemini-settings",
  "generic",
] as const;
type SnippetOnlyClient = typeof SNIPPET_ONLY_CLIENTS[number];
export type ClientSnippetTarget = TokenLightenRegistrationClient | SnippetOnlyClient;

export interface ClientSnippetResult {
  client: ClientSnippetTarget;
  mechanism: InstallHostMechanism;
  file?: string;
  json?: Record<string, unknown>;
  toml?: string;
  addCommand?: string;
  note?: string;
}

function snippetEnv(client: string, launcher: StableLauncher): Record<string, string> {
  return { TOKENLIGHTEN_CLIENT: client, ...MANAGED_ENV, ...launcher.env };
}

function snippetArgs(launcher: StableLauncher, writePosture: "allow-write" | "read-only"): string[] {
  return [...launcher.argsPrefix, ...MCP_ARGS_PREFIX, ...(writePosture === "allow-write" ? ["--allow-write"] : [])];
}

/**
 * Builds a pasteable entry (and, where a vendor CLI exists, the one-line add
 * command) for any host in the §4.3 table — `tl clients snippet` never
 * writes anything, so this is safe to call for a client the machine does not
 * even have.
 */
export function buildClientSnippet(
  client: ClientSnippetTarget,
  options: ClientsEngineOptions = {},
): ClientSnippetResult {
  const launcher = options.launcher ?? resolveStableLauncher(options);
  const writePosture = options.writePosture ?? "allow-write";
  const args = snippetArgs(launcher, writePosture);

  switch (client) {
    case "claude-code": {
      const entry = { type: "stdio", command: launcher.command, args, env: snippetEnv("claude-code", launcher) };
      return {
        client,
        mechanism: "vendor-cli",
        json: { mcpServers: { [SERVER_ID]: entry } },
        addCommand: registrationPayload("claude-code", launcher, writePosture).manualCommand,
      };
    }
    case "codex": {
      const entry = { command: launcher.command, args, env: snippetEnv("codex", launcher) };
      return {
        client,
        mechanism: "vendor-cli",
        json: { mcp_servers: { [SERVER_ID]: entry } },
        addCommand: registrationPayload("codex", launcher, writePosture).manualCommand,
      };
    }
    case "gemini": {
      const entry = { command: launcher.command, args, env: snippetEnv("gemini", launcher) };
      return {
        client,
        mechanism: "vendor-cli",
        file: "~/.gemini/settings.json",
        json: { mcpServers: { [SERVER_ID]: entry } },
        addCommand: registrationPayload("gemini", launcher, writePosture).manualCommand,
      };
    }
    case "copilot-cli": {
      return {
        client,
        mechanism: "config-file",
        file: copilotConfigPath(options),
        json: { [COPILOT_CONFIG_ROOT_KEY]: { [SERVER_ID]: copilotEntry(launcher, writePosture) } },
      };
    }
    case "vscode-user": {
      const entry = { command: launcher.command, args, env: snippetEnv("vscode", launcher) };
      return {
        client,
        mechanism: "snippet",
        file: "<VS Code User dir>/mcp.json",
        json: { servers: { [SERVER_ID]: entry } },
        note: "Open with the 'MCP: Open User Configuration' command in VS Code.",
      };
    }
    case "zed": {
      const entry = { command: launcher.command, args, env: snippetEnv("zed", launcher) };
      return {
        client,
        mechanism: "snippet",
        file: "~/.config/zed/settings.json",
        json: { context_servers: { [SERVER_ID]: entry } },
        note: "Unverified against Zed's own docs (design §8); confirm the shape before relying on it.",
      };
    }
    case "opencode": {
      const entry = { command: launcher.command, args, env: snippetEnv("opencode", launcher) };
      return {
        client,
        mechanism: "snippet",
        file: "opencode.json",
        json: { mcp: { [SERVER_ID]: entry } },
      };
    }
    case "codex-user": {
      const env = snippetEnv("codex", launcher);
      const toml = [
        `[mcp_servers.${SERVER_ID}]`,
        `command = ${JSON.stringify(launcher.command)}`,
        `args = ${JSON.stringify(args)}`,
        `env = { ${Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`,
        "enabled = true",
        "",
      ].join("\n");
      return {
        client,
        mechanism: "snippet",
        file: "~/.codex/config.toml",
        toml,
        note: "TOML comments are lost on round-trip; absolute paths only — edit by hand.",
      };
    }
    case "gemini-settings": {
      const entry = { command: launcher.command, args, env: snippetEnv("gemini", launcher) };
      return {
        client,
        mechanism: "snippet",
        file: "~/.gemini/settings.json",
        json: { mcpServers: { [SERVER_ID]: entry } },
      };
    }
    case "generic":
    default: {
      const entry = { command: launcher.command, args, env: snippetEnv("generic", launcher) };
      return {
        client: "generic",
        mechanism: "snippet",
        json: { mcpServers: { [SERVER_ID]: entry } },
      };
    }
  }
}

function writeSnippetHuman(snippet: ClientSnippetResult): void {
  process.stdout.write(`client: ${snippet.client} (${snippet.mechanism})\n`);
  if (snippet.file) process.stdout.write(`file: ${snippet.file}\n`);
  if (snippet.json) process.stdout.write(`${JSON.stringify(snippet.json, null, 2)}\n`);
  if (snippet.toml) process.stdout.write(snippet.toml.endsWith("\n") ? snippet.toml : `${snippet.toml}\n`);
  if (snippet.addCommand) process.stdout.write(`add command: ${snippet.addCommand}\n`);
  if (snippet.note) process.stdout.write(`note: ${snippet.note}\n`);
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
  if (subcommand === "snippet") {
    try {
      const index = rest.indexOf("--client");
      const clientArg = (index >= 0 ? rest[index + 1] : undefined) ?? "generic";
      const allSnippetClients: readonly string[] = [...CLIENTS, ...SNIPPET_ONLY_CLIENTS];
      if (!allSnippetClients.includes(clientArg)) {
        throw new Error(`Unsupported snippet client: ${clientArg}`);
      }
      const snippet = buildClientSnippet(clientArg as ClientSnippetTarget);
      if (rest.includes("--json")) {
        process.stdout.write(`${JSON.stringify(snippet)}\n`);
      } else {
        writeSnippetHuman(snippet);
      }
    } catch (error) {
      process.stderr.write(`tl clients: ${error instanceof Error ? error.message : String(error)}\n${CLIENTS_USAGE}`);
      process.exitCode = 1;
    }
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
