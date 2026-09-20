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
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import crossSpawn from "cross-spawn";
import { defaultGuideProfileForSurface, injectAll, parseSentinelBlock, VALID_PROFILES } from "@tokenlighten/agents-md";
import type { GuideProfile } from "@tokenlighten/agents-md";
import type {
  CopilotInlineResultsReport,
  TokenLightenSetupClient,
  TokenLightenWorkspaceListResult,
  TokenLightenWorkspaceSetupResult,
  TokenLightenWorkspaceSummary,
  ToolSurface,
} from "@tokenlighten/types";
// DESIGN-v0.15 §8.2 (R7 Part B): value imports (not type-only) for the CLI's
// own --tool-surface validation.
import { TOOL_SURFACE_VALUES, isToolSurface } from "@tokenlighten/types";
import {
  getNestedKey,
  readConfig,
  setNestedKey,
  writeConfig,
} from "../config.js";
import { resolveStableLauncher } from "../launcher.js";
import {
  isDefaultInstallHome,
  readInstallRecord,
  resolveInstallHome,
  upsertInstallWorkspace,
  writeInstallRecord,
} from "../installHome.js";
import { configFilePath } from "../paths.js";
import { wantsHelp } from "../util/helpFlag.js";
import { resolveMcpBin } from "./mcp.js";

const CLIENTS = new Set<TokenLightenSetupClient>([
  "vscode",
  "codex",
  "claude-code",
]);

const WORKSPACE_USAGE = `\
Usage:
  tl workspace setup [--root DIR] [--clients vscode,codex,claude-code] [--guide-profile full|medium|compact] [--tool-surface code|full] [--copilot-inline-results raise|keep] [--rules-only] [--json]
  tl workspace status [--root DIR] [--json]
  tl workspace list [--json]

Setup creates AI rules and project-scoped MCP settings. Status verifies one
workspace without changing it. List reports every
workspace registered by setup on this machine for desktop-wide management.
TokenLighten write tools and local privacy-preserving usage logging are enabled
by default. With --tool-surface code and no explicit --guide-profile, the
guide profile defaults to compact instead of full (an explicit
--guide-profile always wins). GitHub Copilot attaches AGENTS.md in full to
every request (~3k tokens for the full TokenLighten block); a Copilot-only
workspace may pass --guide-profile compact (VS Code setting
tokenlighten.guideProfile); Codex and Claude Code users should keep full.
With --clients including vscode,
--copilot-inline-results raise (default) raises GitHub Copilot's inline
tool-result limit in the workspace's .vscode/settings.json so Copilot can
read TokenLighten's answers; pass keep to leave that file untouched.
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

/** Optional serialization style for `writeJsonAtomic` — lets a caller that
 * read an existing file reproduce its indentation unit and trailing-newline
 * convention instead of always normalizing to 2 spaces (used by the Copilot
 * settings.json merge below, which must not needlessly reformat a file it
 * did not create). Omitted entirely, behavior is unchanged: 2-space indent,
 * trailing newline. */
export interface JsonWriteStyle {
  indent?: string | number;
  trailingNewline?: boolean;
}

// Exported so `mcpConfigFile.ts` (DESIGN-v0.14-mcp-only-install.md §4.3
// "Config-file writer" mechanism) reuses the same atomic-write primitive
// instead of maintaining a second implementation.
export function writeJsonAtomic(
  root: string,
  target: string,
  value: Record<string, unknown>,
  style?: JsonWriteStyle,
): void {
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  const parent = dirname(target);
  assertNotSymlink(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary =
    `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const body = JSON.stringify(value, null, style?.indent ?? 2);
  const trailingNewline = style?.trailingNewline ?? true;
  writeFileSync(temporary, trailingNewline ? `${body}\n` : body, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, target);
}

export function readJsonObject(target: string): Record<string, unknown> {
  if (!existsSync(target)) return {};
  assertNotSymlink(target);
  const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${target}`);
  }
  return parsed as Record<string, unknown>;
}

export function objectMember(
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

// ---------------------------------------------------------------------------
// Copilot inline tool-result limit (VS Code GitHub Copilot Chat) — see the
// task's design note: Copilot's agent mode hides any MCP tool result whose
// text exceeds `github.copilot.chat.agent.largeToolResultsToDisk.thresholdBytes`
// (default 8192) from the model, replacing it with a "written to file"
// notice. Raising it in the workspace's `.vscode/settings.json` (paired with
// TOKENLIGHTEN_TASK_PACK_MAX_BYTES=0 in the generated VS Code MCP entry,
// which lifts TL's own client-profile ceiling) is what lets a VS Code
// Copilot agent actually read TokenLighten's answers instead of abandoning
// the tool. No mcp-server change is involved: TOKENLIGHTEN_TASK_PACK_MAX_BYTES=0
// is an existing, documented env override.
export const COPILOT_INLINE_RESULTS_VALUES = ["raise", "keep"] as const;
export type CopilotInlineResultsMode = typeof COPILOT_INLINE_RESULTS_VALUES[number];

export function isCopilotInlineResultsMode(value: string): value is CopilotInlineResultsMode {
  return (COPILOT_INLINE_RESULTS_VALUES as readonly string[]).includes(value);
}

export const COPILOT_SETTINGS_KEY = "github.copilot.chat.agent.largeToolResultsToDisk.thresholdBytes";
const COPILOT_ENABLED_KEY = "github.copilot.chat.agent.largeToolResultsToDisk.enabled";
export const COPILOT_RAISED_THRESHOLD_BYTES = 65536;
export const COPILOT_TASK_PACK_ENV_VAR = "TOKENLIGHTEN_TASK_PACK_MAX_BYTES";

function copilotSettingsPath(root: string): string {
  return join(root, ".vscode", "settings.json");
}

/** Shortest leading-whitespace run seen on any line — a simple, good-enough
 * sniff of whether a JSON file is 2-space, 4-space, or tab indented.
 * Defaults to 2 spaces when nothing is indented (new/minified file). */
function detectIndentUnit(raw: string): string | number {
  let best: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const match = /^[ \t]+/.exec(line);
    if (!match) continue;
    if (best === undefined || match[0].length < best.length) best = match[0];
  }
  return best ?? 2;
}

function manualCopilotReport(target: string, reason: string, previousThresholdBytes?: number): CopilotInlineResultsReport {
  return {
    status: "manual",
    settingsFile: target,
    thresholdBytes: COPILOT_RAISED_THRESHOLD_BYTES,
    ...(previousThresholdBytes !== undefined ? { previousThresholdBytes } : {}),
    reason: `${reason}; add "${COPILOT_SETTINGS_KEY}": ${COPILOT_RAISED_THRESHOLD_BYTES} to ${target} by hand`,
  };
}

/** Ensures `<root>/.vscode/settings.json` raises Copilot's inline
 * tool-result threshold — see the module header comment above. Never
 * throws: any content problem (JSONC, non-object, unreadable) or path
 * safety violation (outside root, symlinked) degrades to a `manual` report
 * instead of failing the surrounding `setupWorkspace()` call. */
function ensureCopilotSettings(root: string): CopilotInlineResultsReport {
  const target = copilotSettingsPath(root);
  try {
    assertInsideRoot(root, target);
    assertNotSymlink(target);
    assertNotSymlink(dirname(target));
  } catch (error) {
    return manualCopilotReport(target, error instanceof Error ? error.message : String(error));
  }

  if (!existsSync(target)) {
    try {
      writeJsonAtomic(root, target, { [COPILOT_SETTINGS_KEY]: COPILOT_RAISED_THRESHOLD_BYTES });
      return { status: "raised", settingsFile: target, thresholdBytes: COPILOT_RAISED_THRESHOLD_BYTES };
    } catch (error) {
      return manualCopilotReport(target, `could not create ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (error) {
    return manualCopilotReport(target, `could not read ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return manualCopilotReport(target, `${target} is not strict JSON (VS Code settings allow comments/trailing commas, which this safe merge does not parse)`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return manualCopilotReport(target, `${target} does not contain a JSON object`);
  }

  const document = parsed as Record<string, unknown>;
  const existingThreshold = document[COPILOT_SETTINGS_KEY];
  const previousThresholdBytes = typeof existingThreshold === "number" ? existingThreshold : undefined;
  const alreadySufficient =
    (previousThresholdBytes !== undefined && previousThresholdBytes >= COPILOT_RAISED_THRESHOLD_BYTES)
    || document[COPILOT_ENABLED_KEY] === false;
  if (alreadySufficient) {
    return {
      status: "already-sufficient",
      settingsFile: target,
      thresholdBytes: previousThresholdBytes ?? COPILOT_RAISED_THRESHOLD_BYTES,
    };
  }

  document[COPILOT_SETTINGS_KEY] = COPILOT_RAISED_THRESHOLD_BYTES;
  try {
    writeJsonAtomic(root, target, document, {
      indent: detectIndentUnit(raw),
      trailingNewline: raw.length === 0 || raw.endsWith("\n"),
    });
  } catch (error) {
    return manualCopilotReport(
      target,
      `could not write ${target}: ${error instanceof Error ? error.message : String(error)}`,
      previousThresholdBytes,
    );
  }
  return {
    status: "raised",
    settingsFile: target,
    thresholdBytes: COPILOT_RAISED_THRESHOLD_BYTES,
    ...(previousThresholdBytes !== undefined ? { previousThresholdBytes } : {}),
  };
}

// Uninstall symmetry (workspace.ts owns the key/constants; called from
// install.ts's uninstall flow). Only ever removes the key — per the task's
// own fallback rule ("if you cannot know [a file was TL-created], never
// delete the file") this never unlinks settings.json, even when the key
// removal leaves it at `{}`: there is no persisted marker of whether TL
// created the file, so proving that is impossible and deletion stays
// refused. Best-effort and silent: a JSONC file was never touched by setup
// either (it degrades to `manual`), so there is nothing to revert here.
export function removeCopilotThresholdIfManaged(root: string): void {
  const target = copilotSettingsPath(root);
  try {
    if (!existsSync(target) || lstatSync(target).isSymbolicLink()) return;
    const raw = readFileSync(target, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const document = parsed as Record<string, unknown>;
    if (document[COPILOT_SETTINGS_KEY] !== COPILOT_RAISED_THRESHOLD_BYTES) return;
    delete document[COPILOT_SETTINGS_KEY];
    writeJsonAtomic(root, target, document, {
      indent: detectIndentUnit(raw),
      trailingNewline: raw.length === 0 || raw.endsWith("\n"),
    });
  } catch {
    // Best-effort cleanup only — never block or warn during uninstall.
  }
}

/** Shared by `tl workspace setup`'s and `tl install`'s plain-text summaries.
 * Returns undefined (print nothing) for `not-applicable`, or a caller with
 * an odd/future status this build does not recognize. */
export function formatCopilotInlineResultsLine(
  workspaceRoot: string,
  report: CopilotInlineResultsReport | undefined,
): string | undefined {
  if (!report) return undefined;
  const displayPath = report.settingsFile
    ? relative(workspaceRoot, report.settingsFile) || report.settingsFile
    : ".vscode/settings.json";
  switch (report.status) {
    case "raised":
      return `Copilot inline results: raised to ${report.thresholdBytes ?? COPILOT_RAISED_THRESHOLD_BYTES} bytes (${displayPath})`;
    case "already-sufficient":
      return `Copilot inline results: already sufficient (${report.thresholdBytes ?? COPILOT_RAISED_THRESHOLD_BYTES} bytes, ${displayPath})`;
    case "kept":
      return "Copilot inline results: kept (Copilot hides tool results over 8 KB; re-run without --copilot-inline-results keep to raise)";
    case "manual":
      return `Copilot inline results: manual: ${report.reason ?? `add "${COPILOT_SETTINGS_KEY}": ${COPILOT_RAISED_THRESHOLD_BYTES} to ${displayPath}`}`;
    case "not-applicable":
      return undefined;
    default:
      return undefined;
  }
}

// GitHub Copilot Chat fixed-overhead reduction (WP-C1 §3): defaultGuideProfileForSurface's
// default must not change — AGENTS.md is a shared file, and Codex/Claude Code can be
// registered machine-wide with no per-workspace record, so TL cannot know a workspace is
// "VS Code only", and silently writing the compact block would change what those clients
// read too. This only makes the existing explicit opt-in (--guide-profile compact /
// tokenlighten.guideProfile) discoverable, in the human-readable setup summary alone —
// never in --json, which has no free-text notes field for it, and never a warning (the
// full profile is not wrong, just costlier for a Copilot-only workspace).
export function formatGuideProfileAdviceLine(
  clients: readonly TokenLightenSetupClient[],
  effectiveGuideProfile: GuideProfile,
): string | undefined {
  if (!clients.includes("vscode") || effectiveGuideProfile !== "full") return undefined;
  return "note: GitHub Copilot attaches AGENTS.md in full to every request (~3k tokens for "
    + "the full TokenLighten block); a Copilot-only workspace may pass --guide-profile "
    + "compact (VS Code setting tokenlighten.guideProfile); Codex and Claude Code users "
    + "should keep full.";
}

/**
 * Best-effort schema-content stamp for whatever @tokenlighten/mcp-server this
 * install resolves (packages/mcp-server/src/util/schemaStamp.ts). Written
 * into generated MCP client config as TOKENLIGHTEN_SCHEMA_STAMP purely so
 * that a genuine advertised-tool-schema change produces a genuine config
 * change: VS Code (and other hosts that reread this file rather than caching
 * a provider-side definition) treat any config value change as a
 * server-definition change and are willing to re-fetch/re-validate
 * tools/list instead of trusting a stale cached copy — see the matching
 * McpStdioServerDefinition.version mechanism in packages/vscode-extension's
 * mcpProvider.ts. The server itself never reads this variable.
 *
 * Best-effort by design: any failure (mcp-server not yet built, spawn error,
 * malformed output) silently omits the env var rather than failing setup —
 * rerunning `tl workspace setup` later picks up a real value once the
 * resolvable mcp-server can report one.
 */
export function currentMcpSchemaStamp(toolSurface?: ToolSurface): string | undefined {
  try {
    const bin = resolveMcpBin();
    if (!existsSync(bin)) return undefined;
    // DESIGN-v0.15 §8.2 (R7 Part B): the stamped surface must match the one
    // `serverConfig` embeds in the generated `args` below — otherwise
    // TOKENLIGHTEN_SCHEMA_STAMP silently describes the WRONG surface,
    // defeating the anti-wedge-cache mechanism specifically for a
    // `--tool-surface code` workspace (the report's own "concrete gap").
    const result = crossSpawn.sync(
      process.execPath,
      [bin, "--print-schema-stamp", ...(toolSurface !== undefined ? ["--tool-surface", toolSurface] : [])],
      { shell: false, encoding: "utf8", timeout: 30_000 },
    );
    if (result.error || result.status !== 0) return undefined;
    const first = String(result.stdout ?? "").trim().split(/\r?\n/, 1)[0] ?? "";
    return /^[0-9a-f]{16}$/.test(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

function serverConfig(
  root: string,
  client: "vscode" | "claude-code",
  launcher: SetupLauncher,
  schemaStamp: string | undefined,
  toolSurface: ToolSurface | undefined,
  // Only ever true for the vscode entry, and only when this run raised (or
  // found already sufficient) Copilot's inline tool-result limit — see
  // `ensureCopilotSettings`/`setupWorkspace` below. Never passed true for
  // "claude-code": Claude Code and Codex never get this env var.
  linkTaskPackCeiling = false,
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
      // DESIGN-v0.15 §8.2 (R7 Part B): omitted (not merely "full") when the
      // caller did not opt in — the DEFAULT generated config must stay
      // byte-for-byte identical to before this flag existed.
      ...(toolSurface !== undefined ? ["--tool-surface", toolSurface] : []),
    ],
    env: {
      ...launcher.env,
      TOKENLIGHTEN_CLIENT: client,
      TOKENLIGHTEN_USAGE_LOG: "on",
      ...(schemaStamp !== undefined ? { TOKENLIGHTEN_SCHEMA_STAMP: schemaStamp } : {}),
      // GitHub Copilot Chat fixed-overhead reduction (WP-C1): TOKENLIGHTEN_CLIENT_ID
      // pins the VS Code advertisement profile (protocol/clientAdvertisement.ts) even
      // on a transport leg that never threads a real clientInfo.name through to
      // resolvedClientId() — see that module's header. TL_TURN_ECONOMY is the
      // server's default-OFF umbrella flag (util/flags.ts's turnEconomyEnabled())
      // that turns on turn-economy serving policies for this host only. Both are
      // unconditional for vscode (not tied to linkTaskPackCeiling below) and never
      // set for "claude-code" — Claude Code's and Codex's paired bench must stay
      // byte-identical.
      ...(client === "vscode" ? { TOKENLIGHTEN_CLIENT_ID: "vscode", TL_TURN_ECONOMY: "1" } : {}),
      // Links VS Code's raised Copilot inline-result limit to TL's own
      // client-profile response ceiling (packages/mcp-server/src/protocol/
      // codec/clientProfile.ts): "0" is the existing, documented override
      // meaning "ignore the client-profile ceiling, use the type-specific
      // default". Regenerated from scratch on every setup run (this whole
      // env object is), so switching back to `keep`/`manual` on a re-run
      // drops it automatically — no separate removal step needed.
      ...(linkTaskPackCeiling ? { [COPILOT_TASK_PACK_ENV_VAR]: "0" } : {}),
    },
  };
}

// DESIGN-v0.14-mcp-only-install.md §4.6 C9 (portability): a committed
// `.vscode/mcp.json` or `.mcp.json` must work for a teammate on the same OS.
// Only meaningful when the install home is the platform *default* (no
// `--home`, no TOKENLIGHTEN_HOME/TOKENLIGHTEN_DATA_HOME override) — a custom
// home is inherently machine-specific and stays absolute. Substitutes ONLY
// the identity's two paths (`command` and `argsPrefix[0]`, i.e.
// `<home>/bin/node` and `<home>/bin/tl.js`); everything else (env,
// `--workspace <root>`, ...) is untouched.
function portableIdentity(
  launcher: SetupLauncher,
  varName: string,
  base: string | undefined,
): SetupLauncher {
  if (!base) return launcher;
  const substitute = (value: string): string =>
    value.startsWith(base) ? `${varName}${value.slice(base.length)}` : value;
  const first = launcher.argsPrefix[0];
  return {
    ...launcher,
    command: substitute(launcher.command),
    argsPrefix: first !== undefined
      ? [substitute(first), ...launcher.argsPrefix.slice(1)]
      : launcher.argsPrefix,
  };
}

function portableIdentityFor(
  launcher: SetupLauncher,
  form: "vscode-user" | "mcp-json",
  installHomeDefault: boolean,
  platform: NodeJS.Platform = process.platform,
): SetupLauncher {
  if (!installHomeDefault) return launcher;
  if (platform === "win32") {
    const varName = form === "vscode-user" ? "${env:LOCALAPPDATA}" : "${LOCALAPPDATA}";
    return portableIdentity(launcher, varName, process.env["LOCALAPPDATA"]);
  }
  const varName = form === "vscode-user" ? "${userHome}" : "${HOME}";
  let home: string | undefined;
  try {
    home = homedir();
  } catch {
    home = undefined;
  }
  return portableIdentity(launcher, varName, home);
}

function configureVsCode(
  root: string,
  launcher: SetupLauncher,
  schemaStamp: string | undefined,
  toolSurface: ToolSurface | undefined,
  installHomeDefault: boolean,
  platform: NodeJS.Platform,
  linkTaskPackCeiling: boolean,
): string {
  const target = join(root, ".vscode", "mcp.json");
  const document = readJsonObject(target);
  const servers = objectMember(document, "servers");
  const portable = portableIdentityFor(launcher, "vscode-user", installHomeDefault, platform);
  servers["tokenlighten"] = serverConfig(root, "vscode", portable, schemaStamp, toolSurface, linkTaskPackCeiling);
  writeJsonAtomic(root, target, document);
  return target;
}

function configureClaude(
  root: string,
  launcher: SetupLauncher,
  schemaStamp: string | undefined,
  toolSurface: ToolSurface | undefined,
  installHomeDefault: boolean,
  platform: NodeJS.Platform,
): string {
  const target = join(root, ".mcp.json");
  const document = readJsonObject(target);
  const servers = objectMember(document, "mcpServers");
  const portable = portableIdentityFor(launcher, "mcp-json", installHomeDefault, platform);
  servers["tokenlighten"] = {
    type: "stdio",
    ...serverConfig(root, "claude-code", portable, schemaStamp, toolSurface),
  };
  writeJsonAtomic(root, target, document);
  return target;
}

function configureCodex(
  root: string,
  launcher: SetupLauncher,
  schemaStamp: string | undefined,
  toolSurface: ToolSurface | undefined,
): string {
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
      ...(toolSurface !== undefined ? ["--tool-surface", toolSurface] : []),
    ],
    env: {
      ...launcher.env,
      TOKENLIGHTEN_CLIENT: "codex",
      TOKENLIGHTEN_USAGE_LOG: "on",
      ...(schemaStamp !== undefined ? { TOKENLIGHTEN_SCHEMA_STAMP: schemaStamp } : {}),
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
  /**
   * Guide profile to inject. Omitted defers to
   * `defaultGuideProfileForSurface(options.toolSurface)`: "full" unless
   * `toolSurface` is "code", in which case it is "compact" (P2-3(1),
   * v0.14.1 hands-on report — `--tool-surface code` used to still write the
   * full 12 KB guide because nothing coupled the two flags). An explicit
   * value here always wins over that default.
   */
  guideProfile?: GuideProfile;
  /**
   * Override for currentMcpSchemaStamp() — tests inject a deterministic
   * value here instead of spawning the real resolved mcp-server. Omitted
   * means the real best-effort resolve-and-spawn implementation.
   */
  schemaStamp?: () => string | undefined;
  /**
   * DESIGN-v0.15 §8.2 (R7 Part B): the tool surface generated client configs
   * should launch the server with. Omitted (the default) generates the
   * EXACT prior `args` array — no `--tool-surface` flag at all — so an
   * existing workspace's regenerated config is byte-for-byte unchanged.
   */
  toolSurface?: ToolSurface;
  /**
   * DESIGN-v0.14-mcp-only-install.md §4.6 C9: whether the launcher's install
   * home is the platform default (no `--home`/env override) — controls
   * whether `.vscode/mcp.json`/`.mcp.json` write the identity's two paths
   * as a host variable form. Defaults to `isDefaultInstallHome()` (the
   * standalone `tl workspace setup` case has no `--home` flag of its own).
   */
  installHomeDefault?: boolean;
  /** Test seam for §4.6 C9's win32/POSIX branch; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * VS Code GitHub Copilot Chat hides any MCP tool result over its own
   * inline-result threshold (default 8192 bytes) from the model. "raise"
   * (the default) ensures the workspace's `.vscode/settings.json` sets a
   * higher threshold and links TL's own response ceiling to it, whenever
   * this run configures the vscode client; "keep" leaves that file and the
   * link untouched. See `ensureCopilotSettings` below.
   */
  copilotInlineResults?: CopilotInlineResultsMode;
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

  // P2-3(1): options assembly — the effective profile couples to
  // toolSurface only when the caller left guideProfile unspecified; an
  // explicit guideProfile always wins. toolSurface is threaded into
  // injectAll (not just the profile) so a "code" surface actually elides
  // the Office/archive/credential prose the full/medium... templates wrap
  // in FULL_ONLY markers, matching the surface the generated client
  // configs below advertise.
  const effectiveGuideProfile = options.guideProfile ?? defaultGuideProfileForSurface(options.toolSurface);
  // "copilot-agent" (.github/agents/tokenlighten-explore.agent.md) is a VS
  // Code Copilot Chat custom-agent file whose `tools:` list names this
  // workspace's own ".vscode/mcp.json" "tokenlighten" server entry — it is
  // only meaningful, and only added here, while THIS run is configuring the
  // vscode client (never for --rules-only, and never for e.g. --clients
  // codex alone, both of which leave "vscode" out of `clients`).
  const rules = await injectAll({
    repoRoot: root,
    targets: clients.includes("vscode")
      ? ["claude", "copilot", "copilot-agent"]
      : ["claude", "copilot"],
    driftMode: "auto-rewrite",
    profile: effectiveGuideProfile,
    ...(options.toolSurface !== undefined ? { toolSurface: options.toolSurface } : {}),
  });
  const configFilesWritten: string[] = [];
  const launcher = options.launcher ?? {
    command: "tl",
    argsPrefix: [],
    env: {},
  };
  // Only worth computing when a client config is actually about to be
  // written — a rules-only setup (or an empty client list) never calls
  // configureVsCode/configureCodex/configureClaude, so skip the spawn.
  const schemaStamp = clients.length > 0
    ? (options.schemaStamp !== undefined ? options.schemaStamp() : currentMcpSchemaStamp(options.toolSurface))
    : undefined;
  const installHomeDefault = options.installHomeDefault ?? isDefaultInstallHome();
  const platform = options.platform ?? process.platform;

  // Resolved once, before configureVsCode runs, so its result can gate the
  // TOKENLIGHTEN_TASK_PACK_MAX_BYTES link in the SAME write. `not-applicable`
  // when this run does not configure vscode at all (rules-only, or a
  // `clients` list that omits it); `kept` skips touching settings.json
  // entirely when the caller opted out.
  const copilotMode = options.copilotInlineResults ?? "raise";
  const copilotInlineResults: CopilotInlineResultsReport = !clients.includes("vscode")
    ? { status: "not-applicable" }
    : copilotMode === "keep"
      ? { status: "kept" }
      : ensureCopilotSettings(root);
  const linkTaskPackCeiling = copilotInlineResults.status === "raised"
    || copilotInlineResults.status === "already-sufficient";

  for (const client of clients) {
    if (client === "vscode") {
      configFilesWritten.push(configureVsCode(root, launcher, schemaStamp, options.toolSurface, installHomeDefault, platform, linkTaskPackCeiling));
    }
    if (client === "codex") {
      configFilesWritten.push(configureCodex(root, launcher, schemaStamp, options.toolSurface));
    }
    if (client === "claude-code") {
      configFilesWritten.push(configureClaude(root, launcher, schemaStamp, options.toolSurface, installHomeDefault, platform));
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
    copilotInlineResults,
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

export function verifyLauncherVersion(launcher: SetupLauncher): string {
  const result = crossSpawn.sync(
    launcher.command,
    [...launcher.argsPrefix, "--version"],
    {
      shell: false,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...launcher.env },
    },
  );
  const output = String(result.stdout ?? "") + "\n" + String(result.stderr ?? "");
  const first = output.trim().split(/\r?\n/, 1)[0] ?? "";
  if (result.error || result.status !== 0 || first === "") {
    const detail = result.error?.message || first || ("exit " + String(result.status ?? "unknown"));
    throw new Error("Configured TokenLighten launcher failed --version self-check: " + detail);
  }
  return first.replace(/^v/, "");
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
  /** Only populated on the `--json` CLI path (`runWorkspace`), not by
   * `workspaceStatus()` itself — see `machineInstallSummary()` below. */
  machine_install?: MachineInstallSummary | null;
  /**
   * Whether CLAUDE.md at the workspace root currently contains a
   * TokenLighten-managed guide block. Natural delivery (AGENTS.md/CLAUDE.md
   * autoload) depends on this block; losing it is the largest measured cost
   * regression observed to date (see release-docs/getting-started.md).
   * Present whenever the workspace root itself could be resolved.
   */
  guidePresent?: boolean;
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

function hasManagedGuideBlock(root: string): boolean {
  const target = join(root, "CLAUDE.md");
  try {
    if (!existsSync(target) || lstatSync(target).isSymbolicLink()) {
      return false;
    }
    return parseSentinelBlock(readFileSync(target, "utf8")).block !== undefined;
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
  const guidePresent = hasManagedGuideBlock(root);
  let registry: TokenLightenWorkspaceListResult;
  try {
    registry = listWorkspaces(registryPath);
  } catch {
    return {
      schemaVersion: 1,
      workspaceRoot: root,
      configured: false,
      reason: "registry-unavailable",
      guidePresent,
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
      guidePresent,
    };
  }
  if (!entry.clients.includes("vscode")) {
    return {
      schemaVersion: 1,
      workspaceRoot: root,
      configured: false,
      reason: "vscode-not-registered",
      guidePresent,
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
      guidePresent,
    };
  }
  return {
    schemaVersion: 1,
    workspaceRoot: root,
    configured: true,
    reason: "ready",
    writeEnabled: entry.writeEnabled,
    usageLoggingEnabled: entry.usageLoggingEnabled,
    guidePresent,
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
  readonly versionCheck?: (launcher: SetupLauncher) => string;
  /** DESIGN-v0.14-mcp-only-install.md §4.6: when a machine install exists at
   * this home, a successful setup also upserts this workspace into
   * `install.json`'s `workspaces[]` (single source of truth, §4.6 C1).
   * Defaults to `resolveInstallHome()`. */
  readonly installHome?: string;
}

/** `tl workspace status --json`'s `machine_install` field (the VS Code
 * extension's C4 version-precedence check consumes this). */
export interface MachineInstallSummary {
  version: string;
  install_home: string;
  identity: { command: string; argsPrefix: string[]; env: Record<string, string> };
}

function machineInstallSummary(installHomeOverride?: string): MachineInstallSummary | null {
  const installHome = installHomeOverride ?? resolveInstallHome();
  const record = readInstallRecord(installHome);
  if (!record) return null;
  return {
    version: record.version,
    install_home: installHome,
    identity: {
      command: record.identity.command,
      argsPrefix: [...record.identity.argsPrefix],
      env: { ...record.identity.env },
    },
  };
}

/** Best-effort: record this workspace in `install.json` when a machine
 * install exists. Never throws — `tl workspace setup` remains usable from a
 * source checkout that never ran `tl install`, and a failure here must not
 * undo an otherwise-successful workspace setup. */
function recordWorkspaceInInstall(
  installHome: string,
  result: TokenLightenWorkspaceSetupResult,
): void {
  try {
    const record = readInstallRecord(installHome);
    if (!record) return;
    const files = [...result.rulesWritten, ...result.configFilesWritten];
    writeInstallRecord(
      installHome,
      upsertInstallWorkspace(record, {
        root: result.workspaceRoot,
        files,
        guide_block: result.rulesWritten.length > 0,
      }),
    );
  } catch {
    // best effort — workspace setup itself already succeeded
  }
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
  if (!sub || wantsHelp(args)) {
    process.stdout.write(WORKSPACE_USAGE);
    return;
  }
  if (sub === "status") {
    const result = workspaceStatus(
      valueAfter(rest, "--root") ?? process.cwd(),
    );
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        ...result,
        machine_install: machineInstallSummary(options.installHome),
      })}\n`);
      return;
    }
    process.stdout.write(
      result.configured
        ? `TokenLighten is configured for ${result.workspaceRoot}.\n`
        : `TokenLighten is not configured for ${result.workspaceRoot} (${result.reason}).\n`,
    );
    if (result.guidePresent === false) {
      process.stdout.write(
        "warning: no TokenLighten-managed guide block found in CLAUDE.md. "
          + "Natural delivery depends on this block; removing it is the "
          + "largest measured cost regression observed to date. Run "
          + "'tl workspace setup' to restore it.\n",
      );
    }
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
  const rulesOnly = rest.includes("--rules-only");
  const rawGuideProfile = valueAfter(rest, "--guide-profile");
  // B-F6(c): validate against the canonical VALID_PROFILES allowlist
  // (@tokenlighten/agents-md) instead of re-declaring the same three
  // literals here.
  const guideProfile: GuideProfile | undefined =
    rawGuideProfile !== undefined && VALID_PROFILES.includes(rawGuideProfile as GuideProfile)
      ? rawGuideProfile as GuideProfile
      : undefined;
  if (rawGuideProfile !== undefined && guideProfile === undefined) {
    // B-F6(b): this was a literal backslash-n (2 source characters) inside
    // the template literal, which prints as the two visible characters
    // "\n" rather than starting a new line. A single backslash before the
    // n is the real escape sequence.
    process.stderr.write(`tl workspace: unsupported guide profile '${rawGuideProfile}' (expected ${VALID_PROFILES.join(", ")})\n`);
    process.exitCode = 1;
    return;
  }
  const rawToolSurface = valueAfter(rest, "--tool-surface");
  const toolSurface: ToolSurface | undefined =
    rawToolSurface !== undefined && isToolSurface(rawToolSurface) ? rawToolSurface : undefined;
  if (rawToolSurface !== undefined && toolSurface === undefined) {
    process.stderr.write(`tl workspace: unrecognized --tool-surface value '${rawToolSurface}' (expected ${TOOL_SURFACE_VALUES.join(" | ")})\n`);
    process.exitCode = 1;
    return;
  }
  const rawCopilotInlineResults = valueAfter(rest, "--copilot-inline-results");
  const copilotInlineResults: CopilotInlineResultsMode | undefined =
    rawCopilotInlineResults !== undefined && isCopilotInlineResultsMode(rawCopilotInlineResults)
      ? rawCopilotInlineResults
      : undefined;
  if (rawCopilotInlineResults !== undefined && copilotInlineResults === undefined) {
    process.stderr.write(`tl workspace: unrecognized --copilot-inline-results value '${rawCopilotInlineResults}' (expected ${COPILOT_INLINE_RESULTS_VALUES.join(" | ")})\n`);
    process.exitCode = 1;
    return;
  }
  // P2-3(1): arg parsing — resolve the profile setupWorkspace() will
  // actually write so --json (and the plain-text summary) can report the
  // real outcome instead of silently omitting it whenever --guide-profile
  // was not passed. setupWorkspace() re-derives the identical value from
  // the same two inputs; this mirrors that derivation for reporting only
  // (an explicit --guide-profile still always wins, here and there).
  const effectiveGuideProfile = guideProfile ?? defaultGuideProfileForSurface(toolSurface);
  const launcher = options.launcher
    ?? resolveStableLauncher({ allowBareFallback: true, installHome: options.installHome });
  const serverBuild = rulesOnly
    ? undefined
    : (options.versionCheck ?? verifyLauncherVersion)(launcher);
  const result = await setupWorkspace({
    root: valueAfter(rest, "--root") ?? process.cwd(),
    ...(clients ? { clients } : {}),
    launcher,
    rulesOnly,
    ...(guideProfile !== undefined ? { guideProfile } : {}),
    ...(toolSurface !== undefined ? { toolSurface } : {}),
    ...(copilotInlineResults !== undefined ? { copilotInlineResults } : {}),
  });
  const registryTarget = options.registryPath ?? configFilePath();
  recordWorkspaceInInstall(options.installHome ?? resolveInstallHome(), result);
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
      guide_profile: effectiveGuideProfile,
      ...(serverBuild !== undefined ? { server_build: serverBuild } : {}),
      warnings: jsonWarnings(result, registryWarning),
    })}\n`);
    return;
  }
  const copilotLine = formatCopilotInlineResultsLine(result.workspaceRoot, result.copilotInlineResults);
  const guideProfileAdviceLine = formatGuideProfileAdviceLine(result.clients, effectiveGuideProfile);
  process.stdout.write(
    `TokenLighten is ready for ${result.clients.join(", ")}.\n`
      + `AI rules: ${result.rulesWritten.length} file(s)\n`
      + `MCP settings: ${result.configFilesWritten.length} file(s)\n`
      + "Write tools: enabled\n"
      + "Usage log: local, content-free\n"
      + `guide_profile: ${effectiveGuideProfile}\n`
      + (serverBuild !== undefined ? "server_build: " + serverBuild + "\n" : "")
      + (copilotLine !== undefined ? copilotLine + "\n" : "")
      + (guideProfileAdviceLine !== undefined ? guideProfileAdviceLine + "\n" : ""),
  );
}
