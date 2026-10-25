import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import crossSpawn from "cross-spawn";
import {
  copilotGuideModeFromSettings,
  defaultGuideProfileForSurface,
  holdsOnlyManagedBlock,
  injectAll,
  parseJsonc,
  parseSentinelBlock,
  readWorkspaceSettings,
  STUB_TARGET_BY_ID,
  VALID_PROFILES,
} from "@tokenlighten/agents-md";
import type { CopilotGuideMode, GuideProfile } from "@tokenlighten/agents-md";
import type {
  CopilotGuideReport,
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
import { installCopilotSessionHook } from "../copilotSessionHooks.js";

const CLIENTS = new Set<TokenLightenSetupClient>([
  "vscode",
  "codex",
  "claude-code",
]);

const WORKSPACE_USAGE = `\
Usage:
  tl workspace setup [--root DIR] [--clients vscode,codex,claude-code] [--read-only | --allow-write] [--guide-profile full|medium|compact|portable] [--tool-surface code|full] [--copilot-inline-results raise|keep] [--copilot-guide standalone|agents-md|keep] [--copilot-session-context install|keep] [--rules-only] [--json]
  tl workspace status [--root DIR] [--json]
  tl workspace list [--json]

Setup creates AI rules and project-scoped MCP settings. Status verifies one
workspace without changing it. List reports every
workspace registered by setup on this machine for desktop-wide management.
TokenLighten write tools and local privacy-preserving usage logging are enabled
by default on first setup. Updates preserve each client's write permission.
Pass --read-only to disable writes or
--allow-write to select them explicitly. A manual 'tl mcp start' is read-only
unless --allow-write is supplied. The guide profile defaults to compact for all clients and tool
surfaces (an explicit --guide-profile always wins). Claude Code loads the
TokenLighten server upfront; Codex waits for its initial MCP tool catalog.
Existing explicit startup settings are preserved. With --clients including vscode,
--copilot-inline-results raise (default) raises GitHub Copilot's inline
tool-result limit in the workspace's .vscode/settings.json so Copilot can
read TokenLighten's answers; pass keep to leave that file untouched.
GitHub Copilot attaches AGENTS.md in full to every request:
--copilot-guide standalone (default) gives Copilot a compact, self-contained
TokenLighten guide in .github/copilot-instructions.md instead and, in
.vscode/settings.json, turns off chat.useAgentsMdFile while AGENTS.md holds
nothing but TokenLighten's block (a file with your own content stays
attached); Codex and Claude Code read the selected AGENTS.md profile. agents-md
has Copilot read AGENTS.md again (removing only the setting TokenLighten turned
off); keep touches no setting, and is the default under
--copilot-inline-results keep (that file stays untouched). A folder opened
through a .code-workspace file ignores that folder setting: setup names such a
file (it never edits one); set chat.useAgentsMdFile in the workspace file (the
VS Code extension does) or open the folder directly.
VS Code setup also installs a context-only SessionStart hook for ordinary
Agent sessions. It keeps every tool enabled and leaves hook permissions and
chat.useHooks unchanged. --copilot-session-context keep leaves these hook
files untouched. Existing or modified user hooks are always preserved.
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

// ---------------------------------------------------------------------------
// Copilot guide (VS Code Copilot standard-setup evaluation, 2026-10-02) — the
// two guide shapes are @tokenlighten/agents-md's copilotGuide.ts. GitHub
// Copilot Chat attaches AGENTS.md in full to EVERY request, and paying for the
// full TokenLighten guide at the cold start of each conversation was the
// dominant TokenLighten cost the evaluation measured. `standalone` (the
// default) turns that attachment off — in this workspace's own
// .vscode/settings.json, `chat.useAgentsMdFile` — ONLY while AGENTS.md holds
// nothing but TokenLighten's own block, and gives Copilot a compact,
// self-contained guide in .github/copilot-instructions.md, while AGENTS.md
// keeps the full guide for Codex and Claude Code (so the WP-C1 §3 constraint
// below still holds: what those clients read never changes). AGENTS.md with
// any content of the user's stays attached, a value the user wrote is never
// overridden, and the setting TokenLighten turned off is recorded in
// .tokenlighten/copilot-guide.json, so a later run (or the uninstall) removes
// exactly that — never a `false` the user wrote. `agents-md` restores the
// pointer shape (removing only TokenLighten's own setting); `keep` touches no
// setting and renders whichever guide the current settings imply.
//
// CLAUDE.md is never switched off (`chat.useClaudeMdFile`; verified
// 2026-10-02, VS Code 1.139.1): Copilot attaches it verbatim without
// expanding its `@AGENTS.md` import, the block TokenLighten writes there is
// ~280 B (about 70 tokens, not worth a switch), and `false` would also hide the
// user's own global ~/.claude/CLAUDE.md. An earlier build did write that key;
// the first non-`keep` run withdraws the `false` it recorded (see
// `ensureCopilotGuide`).
//
// VS Code registers `chat.useAgentsMdFile` window-scoped: when a folder is
// opened through a `.code-workspace` file, its own .vscode/settings.json value
// is ignored and only the workspace file's `settings` (or the user's) apply.
// Setup therefore NAMES the `.code-workspace` files that list this folder
// (`CopilotGuideReport.workspaceFiles`, `findCodeWorkspaceFiles`) and never
// edits one; the VS Code extension's "Apply Copilot guide to workspace file"
// command is what writes the workspace-level value.
// ---------------------------------------------------------------------------
export const COPILOT_GUIDE_VALUES = ["standalone", "agents-md", "keep"] as const;
export type CopilotGuideRequest = typeof COPILOT_GUIDE_VALUES[number];

export function isCopilotGuideRequest(value: string): value is CopilotGuideRequest {
  return (COPILOT_GUIDE_VALUES as readonly string[]).includes(value);
}

/** The Copilot guide request when none was given: "standalone", or "keep" when the caller asked to keep settings.json untouched (`--copilot-inline-results keep`). */
export function defaultCopilotGuideRequest(copilotInlineResults: CopilotInlineResultsMode | undefined): CopilotGuideRequest {
  return copilotInlineResults === "keep" ? "keep" : "standalone";
}

/** Copilot's switch for attaching AGENTS.md: the one attachment setting TokenLighten writes. */
export const COPILOT_AGENTS_MD_KEY = "chat.useAgentsMdFile";
/**
 * Legacy key an earlier build wrote beside the one above and TokenLighten no
 * longer writes: a record that still lists it is withdrawn on the next
 * non-`keep` run (`ensureCopilotGuide`) and by the uninstall.
 */
export const COPILOT_CLAUDE_MD_KEY = "chat.useClaudeMdFile";
/** The keys the record may list: the current one, and the legacy one an old record can still hold. */
const COPILOT_RECORDED_KEYS: ReadonlySet<string> = new Set([COPILOT_AGENTS_MD_KEY, COPILOT_CLAUDE_MD_KEY]);

function copilotGuideRecordPath(root: string): string {
  return join(root, ".tokenlighten", "copilot-guide.json");
}

/** The attachment settings TokenLighten itself turned off in this workspace (its own record); empty when unknown. */
function readOwnedCopilotSettings(root: string): Set<string> {
  const target = copilotGuideRecordPath(root);
  try {
    if (!existsSync(target) || lstatSync(target).isSymbolicLink()) return new Set();
    const parsed: unknown = JSON.parse(readFileSync(target, "utf8"));
    const listed = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["settings"]
      : undefined;
    return new Set(Array.isArray(listed)
      ? listed.filter((key): key is string => typeof key === "string" && COPILOT_RECORDED_KEYS.has(key))
      : []);
  } catch {
    return new Set();
  }
}

function writeOwnedCopilotSettings(root: string, owned: ReadonlySet<string>): void {
  const target = copilotGuideRecordPath(root);
  if (owned.size > 0) {
    writeJsonAtomic(root, target, { schemaVersion: 1, settings: [...owned].sort() });
    return;
  }
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) unlinkSync(target);
}

/**
 * True when `file` (workspace-relative) is absent or holds nothing but
 * TokenLighten's managed block; false when unreadable. A symlink is judged by
 * the regular file it resolves to inside the workspace (review 2026-10-02: an
 * `AGENTS.md -> CLAUDE.md` link is common, and Copilot attaches whatever it
 * points at), and is false when it leaves the workspace.
 */
function holdsOnlyTokenLightenGuide(root: string, file: string): boolean {
  const target = join(root, file);
  try {
    if (!existsSync(target)) return true;
    let source = target;
    if (lstatSync(target).isSymbolicLink()) {
      source = realpathSync(target);
      const rel = relative(realpathSync(root), source);
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    }
    if (!statSync(source).isFile()) return false;
    return holdsOnlyManagedBlock(readFileSync(source, "utf8"));
  } catch {
    return false;
  }
}

/** Why the guide Copilot reads differs from the one requested, when it does. */
function copilotGuideReason(
  request: CopilotGuideRequest,
  mode: CopilotGuideMode,
  finalAgentsMd: unknown,
  target: string,
): string | undefined {
  if (request === "standalone" && mode === "agents-md") {
    return finalAgentsMd === undefined
      ? "AGENTS.md has content outside TokenLighten's block, so Copilot keeps attaching it (with the full TokenLighten guide)"
      : `${COPILOT_AGENTS_MD_KEY} is ${JSON.stringify(finalAgentsMd)} in ${target}, so Copilot keeps attaching AGENTS.md`;
  }
  if (request === "agents-md" && mode === "standalone") {
    return `${COPILOT_AGENTS_MD_KEY} is false in ${target} and TokenLighten did not set it, so Copilot still does not attach AGENTS.md`;
  }
  return undefined;
}

/**
 * A settings.json in VS Code's own dialect (comments, trailing commas). The
 * safe merge never rewrites it, but the guide still follows what Copilot
 * reads from it (review 2026-10-02): the `"chat.useAgentsMdFile": false` the
 * manual advice asks for takes effect on the next run, instead of the run
 * reporting manual — and rendering the pointer — forever.
 */
function jsoncCopilotGuideResult(
  root: string,
  target: string,
  raw: string,
  request: CopilotGuideRequest,
): { report: CopilotGuideReport; mode: CopilotGuideMode } {
  let document: Record<string, unknown>;
  try {
    const parsed = parseJsonc(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    document = parsed as Record<string, unknown>;
  } catch {
    return manualCopilotGuideResult(target, `${target} is neither strict JSON nor VS Code's JSON with comments`);
  }
  const mode: CopilotGuideMode = document[COPILOT_AGENTS_MD_KEY] === false ? "standalone" : "agents-md";
  if (request !== "keep") {
    const owned = readOwnedCopilotSettings(root);
    const pending: string[] = [];
    if (request === "standalone" && holdsOnlyTokenLightenGuide(root, "AGENTS.md")) {
      if (document[COPILOT_AGENTS_MD_KEY] === undefined) pending.push(`add "${COPILOT_AGENTS_MD_KEY}": false`);
    } else if (document[COPILOT_AGENTS_MD_KEY] === false && owned.has(COPILOT_AGENTS_MD_KEY)) {
      pending.push(`remove "${COPILOT_AGENTS_MD_KEY}" (TokenLighten set it)`);
    }
    // The legacy key is only ever REMOVED, never added: the advice must not
    // send the user to turn CLAUDE.md off.
    if (document[COPILOT_CLAUDE_MD_KEY] === false && owned.has(COPILOT_CLAUDE_MD_KEY)) {
      pending.push(`remove "${COPILOT_CLAUDE_MD_KEY}" (an earlier TokenLighten set it)`);
    }
    // A recorded setting the user has since removed or changed is theirs now
    // (as in the strict-JSON path): drop it from the record, which is
    // TokenLighten's own strict-JSON file, though the settings file stays as is.
    const changed = [...owned].filter((key) => document[key] !== false);
    if (changed.length > 0) {
      for (const key of changed) owned.delete(key);
      try {
        writeOwnedCopilotSettings(root, owned);
      } catch {
        // Best-effort, as in the strict-JSON path.
      }
    }
    if (pending.length > 0) {
      return {
        report: {
          status: "manual",
          settingsFile: target,
          reason: `${target} has comments or trailing commas, which this safe merge never rewrites; ${pending.join(" and ")} by hand, then rerun setup`,
        },
        mode,
      };
    }
  }
  const reason = copilotGuideReason(request, mode, document[COPILOT_AGENTS_MD_KEY], target);
  return { report: { status: mode, settingsFile: target, ...(reason !== undefined ? { reason } : {}) }, mode };
}

function manualCopilotGuideResult(target: string, reason: string): { report: CopilotGuideReport; mode: CopilotGuideMode } {
  return {
    report: {
      status: "manual",
      settingsFile: target,
      reason: `${reason}; to give Copilot TokenLighten's compact guide instead of AGENTS.md, add "${COPILOT_AGENTS_MD_KEY}": false `
        + `to ${target} by hand while AGENTS.md holds only TokenLighten's block, then rerun setup`,
    },
    mode: "agents-md",
  };
}

/**
 * Applies `request` to this workspace's `.vscode/settings.json` (see the
 * section comment above) and returns the report plus the guide the Copilot
 * files must be rendered for: `standalone` exactly when Copilot ends up NOT
 * attaching AGENTS.md (the final `chat.useAgentsMdFile` is `false`, whoever
 * wrote it). Runs before the rules are written — their content depends on it.
 */
function ensureCopilotGuide(root: string, request: CopilotGuideRequest): { report: CopilotGuideReport; mode: CopilotGuideMode } {
  const target = copilotSettingsPath(root);
  try {
    assertInsideRoot(root, target);
    assertNotSymlink(target);
    assertNotSymlink(dirname(target));
  } catch (error) {
    return manualCopilotGuideResult(target, error instanceof Error ? error.message : String(error));
  }
  let raw = "";
  let document: Record<string, unknown> = {};
  const settingsExist = existsSync(target);
  if (settingsExist) {
    try {
      raw = readFileSync(target, "utf8");
    } catch (error) {
      return manualCopilotGuideResult(target, `could not read ${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsoncCopilotGuideResult(root, target, raw, request);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return manualCopilotGuideResult(target, `${target} does not contain a JSON object`);
    }
    document = parsed as Record<string, unknown>;
  }

  const written: string[] = [];
  const removed: string[] = [];
  if (request !== "keep") {
    const owned = readOwnedCopilotSettings(root);
    if (request === "standalone" && holdsOnlyTokenLightenGuide(root, "AGENTS.md")) {
      // Only ever ADDS the setting: a value the user wrote (an explicit
      // `true`, or a `false` that already does this) is left as it is.
      if (document[COPILOT_AGENTS_MD_KEY] === undefined) {
        document[COPILOT_AGENTS_MD_KEY] = false;
        owned.add(COPILOT_AGENTS_MD_KEY);
        written.push(COPILOT_AGENTS_MD_KEY);
      }
    } else if (document[COPILOT_AGENTS_MD_KEY] === false && owned.has(COPILOT_AGENTS_MD_KEY)) {
      // TokenLighten's own setting no longer applies: the file gained
      // content of the user's, or `agents-md` was asked for.
      delete document[COPILOT_AGENTS_MD_KEY];
      removed.push(COPILOT_AGENTS_MD_KEY);
    }
    // A recorded setting the user has since changed is theirs now.
    if (document[COPILOT_AGENTS_MD_KEY] !== false) owned.delete(COPILOT_AGENTS_MD_KEY);
    // Migration: an earlier build also turned CLAUDE.md's attachment off and
    // recorded it. None does any more, and the `false` hid the user's global
    // ~/.claude/CLAUDE.md too, so a recorded `false` is withdrawn now; a value
    // the user has changed since (or removed) is theirs and only leaves the record.
    if (owned.has(COPILOT_CLAUDE_MD_KEY)) {
      owned.delete(COPILOT_CLAUDE_MD_KEY);
      if (document[COPILOT_CLAUDE_MD_KEY] === false) {
        delete document[COPILOT_CLAUDE_MD_KEY];
        removed.push(COPILOT_CLAUDE_MD_KEY);
      }
    }
    if (written.length > 0 || removed.length > 0) {
      try {
        writeJsonAtomic(root, target, document, settingsExist
          ? { indent: detectIndentUnit(raw), trailingNewline: raw.length === 0 || raw.endsWith("\n") }
          : undefined);
      } catch (error) {
        return manualCopilotGuideResult(target, `could not write ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      writeOwnedCopilotSettings(root, owned);
    } catch {
      // Best-effort: without the record a later run treats these settings as
      // the user's and never removes them — the safe direction.
    }
  }

  const finalAgentsMd = document[COPILOT_AGENTS_MD_KEY];
  const mode: CopilotGuideMode = finalAgentsMd === false ? "standalone" : "agents-md";
  const reason = copilotGuideReason(request, mode, finalAgentsMd, target);
  return {
    report: {
      status: mode,
      settingsFile: target,
      ...(written.length > 0 ? { settingsWritten: written } : {}),
      ...(removed.length > 0 ? { settingsRemoved: removed } : {}),
      ...(reason !== undefined ? { reason } : {}),
    },
    mode,
  };
}

// Uninstall symmetry for the Copilot guide (called from install.ts's uninstall
// flow beside removeCopilotThresholdIfManaged): removes only the settings
// TokenLighten's own record names, and only while they still hold the `false`
// setup wrote; then the record itself. Best-effort and silent.
export function removeCopilotGuideSettingsIfManaged(root: string): void {
  releaseOwnedCopilotSettings(root);
}

/**
 * Removes every attachment setting TokenLighten recorded as its own that is
 * still `false`, then the record, and returns the keys removed. Best-effort
 * and silent — never blocks or warns (uninstall); a settings file it cannot
 * parse is left alone and keeps its record for a later run.
 */
function releaseOwnedCopilotSettings(root: string): string[] {
  const removed: string[] = [];
  try {
    const owned = readOwnedCopilotSettings(root);
    const target = copilotSettingsPath(root);
    if (owned.size > 0 && existsSync(target) && !lstatSync(target).isSymbolicLink()) {
      const raw = readFileSync(target, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const document = parsed as Record<string, unknown>;
        const dropped = [...owned].filter((key) => document[key] === false);
        for (const key of dropped) delete document[key];
        if (dropped.length > 0) {
          writeJsonAtomic(root, target, document, {
            indent: detectIndentUnit(raw),
            trailingNewline: raw.length === 0 || raw.endsWith("\n"),
          });
          removed.push(...dropped);
        }
      }
    }
    writeOwnedCopilotSettings(root, new Set());
  } catch {
    // Best-effort cleanup only.
  }
  return removed;
}

/**
 * Review 2026-10-02: Copilot's AGENTS.md attachment may stay off only while
 * Copilot's own file actually holds the compact guide. When injectAll could
 * not put it there (a hand-written TokenLighten note, a symlink, a case
 * collision, an oversized or unwritable file), TokenLighten gives its
 * settings back, so Copilot attaches AGENTS.md and its full guide again, and
 * reports why.
 */
function withdrawCopilotGuide(
  root: string,
  report: CopilotGuideReport,
  skipReason: string,
): { report: CopilotGuideReport; mode: CopilotGuideMode } {
  const writtenThisRun = new Set(report.settingsWritten ?? []);
  const removedEarlier = releaseOwnedCopilotSettings(root).filter((key) => !writtenThisRun.has(key));
  const mode = copilotGuideModeFromSettings(readWorkspaceSettings(root));
  const target = copilotSettingsPath(root);
  const file = STUB_TARGET_BY_ID["copilot"]?.file ?? ".github/copilot-instructions.md";
  return {
    mode,
    report: {
      status: "manual",
      settingsFile: target,
      ...(removedEarlier.length > 0 ? { settingsRemoved: removedEarlier } : {}),
      reason: mode === "standalone"
        ? `${file} could not take TokenLighten's compact guide (${skipReason}), and ${COPILOT_AGENTS_MD_KEY} is false in ${target}, so Copilot reads no TokenLighten guide until that file is fixed or the setting removed`
        : `${file} could not take TokenLighten's compact guide (${skipReason}), so Copilot keeps attaching AGENTS.md (with the full TokenLighten guide)`,
    },
  };
}

/** A `.code-workspace` file is a small JSON document; a larger one is not read. */
const MAX_CODE_WORKSPACE_FILE_BYTES = 1024 * 1024;
const CODE_WORKSPACE_SUFFIX = ".code-workspace";

/**
 * True when the `.code-workspace` file `file` lists the directory whose real
 * path is `realRoot` among its `folders[].path` entries, each resolved against
 * the file's own directory (an entry may be absolute, or reach `realRoot`
 * through a symlink). Read-only: anything unreadable, oversized, invalid or
 * shaped otherwise is simply not a match, and nothing is ever thrown.
 */
function codeWorkspaceListsFolder(file: string, realRoot: string): boolean {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_CODE_WORKSPACE_FILE_BYTES) return false;
    const parsed = parseJsonc(readFileSync(file, "utf8"));
    const folders = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["folders"]
      : undefined;
    if (!Array.isArray(folders)) return false;
    const base = dirname(file);
    return folders.some((entry: unknown) => {
      const path = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>)["path"] : undefined;
      if (typeof path !== "string") return false;
      try {
        return workspacePathsEqual(realpathSync(resolve(base, path)), realRoot);
      } catch {
        return false; // a folder entry that does not exist
      }
    });
  } catch {
    return false;
  }
}

/**
 * Absolute paths of the `.code-workspace` files in `root` and in its parent
 * directory (neither is searched recursively) that list `root` as a folder —
 * the files through which VS Code ignores this folder's own
 * `chat.useAgentsMdFile` (see the section comment above). Never edits one.
 */
function findCodeWorkspaceFiles(root: string): string[] {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return [];
  }
  const parent = dirname(root);
  const found: string[] = [];
  for (const directory of parent === root ? [root] : [root, parent]) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.toLowerCase().endsWith(CODE_WORKSPACE_SUFFIX)) continue;
      const file = join(directory, name);
      if (codeWorkspaceListsFolder(file, realRoot)) found.push(file);
    }
  }
  return found;
}

/** `report` plus the `.code-workspace` files that list `root`, when Copilot ends `standalone` and there are any. */
function withCodeWorkspaceFiles(root: string, report: CopilotGuideReport): CopilotGuideReport {
  if (report.status !== "standalone") return report;
  const workspaceFiles = findCodeWorkspaceFiles(root);
  return workspaceFiles.length > 0 ? { ...report, workspaceFiles } : report;
}

/** The note naming the `.code-workspace` files that make VS Code ignore this folder's setting; empty when there are none. */
function codeWorkspaceNote(workspaceRoot: string, report: CopilotGuideReport): string {
  const files = (report.workspaceFiles ?? []).map((file) => relative(workspaceRoot, file) || file);
  if (files.length === 0) return "";
  return ` — note: VS Code ignores this folder's ${COPILOT_AGENTS_MD_KEY} while the folder is opened through ${files.join(", ")}; `
    + "set it in that workspace file (the VS Code extension's \"TokenLighten: Apply Copilot guide to workspace file\" command does) "
    + "or open the folder directly";
}

export function formatCopilotGuideLine(
  workspaceRoot: string,
  report: CopilotGuideReport | undefined,
): string | undefined {
  if (!report) return undefined;
  const displayPath = report.settingsFile
    ? relative(workspaceRoot, report.settingsFile) || report.settingsFile
    : ".vscode/settings.json";
  const changes = [
    ...(report.settingsWritten ?? []).map((key) => `set "${key}": false`),
    ...(report.settingsRemoved ?? []).map((key) => `removed "${key}"`),
  ];
  const changed = changes.length > 0 ? `; ${changes.join(", ")} in ${displayPath}` : "";
  switch (report.status) {
    case "standalone":
      return `Copilot guide: compact, in .github/copilot-instructions.md (Copilot does not attach AGENTS.md${changed})`
        + (report.reason !== undefined ? ` — ${report.reason}` : "")
        + codeWorkspaceNote(workspaceRoot, report);
    case "agents-md":
      return `Copilot guide: AGENTS.md${changed}` + (report.reason !== undefined ? ` — ${report.reason}` : "");
    case "manual":
      return `Copilot guide: manual: ${report.reason ?? `see ${displayPath}`}`;
    default:
      return undefined;
  }
}

// Advice applies only to an explicitly selected full profile when Copilot
// attaches AGENTS.md. Compact is now the common default for every client.
export function formatGuideProfileAdviceLine(
  clients: readonly TokenLightenSetupClient[],
  effectiveGuideProfile: GuideProfile,
  copilotGuide?: CopilotGuideReport,
): string | undefined {
  if (!clients.includes("vscode") || effectiveGuideProfile !== "full") return undefined;
  if (copilotGuide?.status === "standalone") return undefined;
  return "note: GitHub Copilot attaches AGENTS.md in full to every request (~3k tokens for "
    + "the full TokenLighten block); a Copilot-only workspace may pass --guide-profile "
    + "compact (VS Code setting tokenlighten.guideProfile); Codex and Claude Code "
    + "also support the compact guide.";
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
export function currentMcpSchemaStamp(toolSurface?: ToolSurface, portableTools = false): string | undefined {
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
      { shell: false, encoding: "utf8", timeout: 30_000,
        ...(portableTools ? { env: { ...process.env, TL_PORTABLE_TOOLS: "1" } } : {}) },
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
  writeEnabled = true,
): Record<string, unknown> {
  return {
    command: launcher.command,
    args: [
      ...launcher.argsPrefix,
      "mcp",
      "start",
      "--stdio",
      ...(writeEnabled ? ["--allow-write"] : []),
      "--workspace",
      root,
      // DESIGN-v0.15 §8.2 (R7 Part B): omitted (not merely "full") when the
      // caller did not opt in — the DEFAULT generated config must stay
      // byte-for-byte identical to before this flag existed.
      ...(toolSurface !== undefined ? ["--tool-surface", toolSurface] : []),
    ],
    env: {
      ...launcher.env,
      // The ownership marker (DESIGN-v0.14-mcp-only-install.md R3, §4.6 C5/C6):
      // this run wrote the entry, so it is TokenLighten-managed whatever
      // launcher it names. A machine install's identity already carries it in
      // `launcher.env` (spread first, so its key position is unchanged); the
      // managed shim, a global `tl` and the bare fallback carry no env at all,
      // and the VS Code extension then neither withdrew its own provider copy
      // nor let its off switch reach the server (Copilot retest r3, 2026-10-02).
      TOKENLIGHTEN_MANAGED: "1",
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

/** Omitted permission flags preserve the entry being updated, per client. */
function existingClientWriteEnabled(root: string, client: TokenLightenSetupClient): boolean {
  const target = join(root, client === "vscode" ? ".vscode/mcp.json" : client === "codex" ? ".codex/config.toml" : ".mcp.json");
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  assertNotSymlink(dirname(target));
  const previous = client === "codex"
    ? getNestedKey(readConfig(target), "mcp_servers.tokenlighten")
    : objectMember(readJsonObject(target), client === "vscode" ? "servers" : "mcpServers")["tokenlighten"];
  if (previous === undefined) return true;
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) {
    throw new Error(`Expected a TokenLighten server object in ${target}`);
  }
  const args = (previous as Record<string, unknown>)["args"];
  // Older/manual entries may contain only host startup settings. No args
  // means no explicit write grant; repair the launcher conservatively.
  if (args === undefined) return false;
  if (!Array.isArray(args) || !args.every(arg => typeof arg === "string")) {
    throw new Error(`Cannot preserve TokenLighten write permission: expected string args in ${target}`);
  }
  return args.includes("--allow-write");
}

function configureVsCode(
  root: string,
  launcher: SetupLauncher,
  schemaStamp: string | undefined,
  toolSurface: ToolSurface | undefined,
  installHomeDefault: boolean,
  platform: NodeJS.Platform,
  linkTaskPackCeiling: boolean,
  writeEnabled: boolean,
): string {
  const target = join(root, ".vscode", "mcp.json");
  const document = readJsonObject(target);
  const servers = objectMember(document, "servers");
  const portable = portableIdentityFor(launcher, "vscode-user", installHomeDefault, platform);
  servers["tokenlighten"] = serverConfig(root, "vscode", portable, schemaStamp, toolSurface, linkTaskPackCeiling, writeEnabled);
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
  writeEnabled: boolean,
): string {
  const target = join(root, ".mcp.json");
  const document = readJsonObject(target);
  const servers = objectMember(document, "mcpServers");
  const portable = portableIdentityFor(launcher, "mcp-json", installHomeDefault, platform);
  const previous = servers["tokenlighten"];
  const alwaysLoad = previous && typeof previous === "object" && !Array.isArray(previous)
    && typeof (previous as Record<string, unknown>)["alwaysLoad"] === "boolean"
    ? (previous as Record<string, unknown>)["alwaysLoad"]
    : true;
  servers["tokenlighten"] = {
    type: "stdio",
    // This is a Claude CLIENT setting: a server env variable cannot make
    // the host wait. Only TL loads upfront; other servers stay deferred.
    alwaysLoad,
    ...serverConfig(root, "claude-code", portable, schemaStamp, toolSurface, false, writeEnabled),
  };
  writeJsonAtomic(root, target, document);
  return target;
}

function configureCodex(
  root: string,
  launcher: SetupLauncher,
  schemaStamp: string | undefined,
  toolSurface: ToolSurface | undefined,
  writeEnabled: boolean,
): string {
  const target = join(root, ".codex", "config.toml");
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  assertNotSymlink(dirname(target));
  const document = readConfig(target);
  // Codex's native startup control, rather than Claude-only server env.
  // Zero waits up to each server's startup timeout; it is not an infinite wait.
  if (document["mcp_optional_startup_grace_ms"] === undefined) {
    document["mcp_optional_startup_grace_ms"] = 0;
  }
  setNestedKey(document, "mcp_servers.tokenlighten", {
    command: launcher.command,
    args: [
      ...launcher.argsPrefix,
      "mcp",
      "start",
      "--stdio",
      ...(writeEnabled ? ["--allow-write"] : []),
      "--workspace",
      root,
      ...(toolSurface !== undefined ? ["--tool-surface", toolSurface] : []),
    ],
    env: {
      ...launcher.env,
      // Same ownership marker as `serverConfig` stamps.
      TOKENLIGHTEN_MANAGED: "1",
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
  /** Explicit permission override; omitted preserves existing entries, or enables writes on first setup. */
  writeEnabled?: boolean;
  /**
   * Guide profile to inject. Omitted defers to
   * `defaultGuideProfileForSurface(options.toolSurface)`: "compact" for
   * every client/tool surface. An explicit value always wins.
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
  /**
   * Which TokenLighten guide GitHub Copilot reads (the Copilot guide section
   * above). Default "standalone" — or "keep" under `copilotInlineResults:
   * "keep"`, whose promise is that settings.json stays untouched. Read only
   * when this run configures the vscode client.
   */
  copilotGuide?: CopilotGuideRequest;
  /** Ordinary Agent entry hint; keep leaves existing hook files untouched. */
  copilotSessionContext?: "install" | "keep";
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
  // Resolve every selected client's existing posture before writing any
  // rules/settings, so unreadable or malformed input cannot enable writes.
  const permissions = Object.fromEntries(clients.map(client => [client,
    options.writeEnabled ?? existingClientWriteEnabled(root, client)])) as Partial<Record<TokenLightenSetupClient, boolean>>;
  const writeEnabled = clients.length > 0 ? clients.every(client => permissions[client] === true) : options.writeEnabled ?? true;
  const mixedPermissions = clients.some(client => permissions[client] !== writeEnabled);

  // P2-3(1): options assembly — the effective profile couples to
  // toolSurface only when the caller left guideProfile unspecified; an
  // explicit guideProfile always wins. toolSurface is threaded into
  // injectAll (not just the profile) so a "code" surface actually elides
  // the Office/archive/credential prose the full/medium... templates wrap
  // in FULL_ONLY markers, matching the surface the generated client
  // configs below advertise.
  const effectiveGuideProfile = options.guideProfile ?? defaultGuideProfileForSurface(options.toolSurface);
  // Copilot standard-setup evaluation (2026-10-02): resolved BEFORE the rules
  // are written — the Copilot files' content depends on whether Copilot still
  // attaches AGENTS.md (see the Copilot guide section above).
  let copilotGuide = clients.includes("vscode")
    ? ensureCopilotGuide(root, options.copilotGuide ?? defaultCopilotGuideRequest(options.copilotInlineResults))
    : undefined;
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
    ...(copilotGuide !== undefined ? { copilotGuide: copilotGuide.mode } : {}),
  });
  let rulesWritten = rules.wrote;
  const copilotFile = STUB_TARGET_BY_ID["copilot"]?.file;
  const copilotSkip = copilotGuide?.mode === "standalone"
    ? rules.skipped.find((item) => item.path === copilotFile && item.reason !== "already-up-to-date")
    : undefined;
  if (copilotGuide !== undefined && copilotSkip !== undefined) {
    copilotGuide = withdrawCopilotGuide(root, copilotGuide.report, copilotSkip.reason);
    if (copilotGuide.mode === "agents-md") {
      // The exploration agent was just rendered for the standalone guide;
      // render it for the AGENTS.md Copilot attaches again.
      const agent = await injectAll({
        repoRoot: root,
        targets: ["copilot-agent"],
        driftMode: "auto-rewrite",
        profile: effectiveGuideProfile,
        ...(options.toolSurface !== undefined ? { toolSurface: options.toolSurface } : {}),
        copilotGuide: "agents-md",
      });
      rulesWritten = [...new Set([...rulesWritten, ...agent.wrote])];
    }
  }
  const configFilesWritten: string[] = [];
  const sessionWarnings: string[] = [];
  const baseLauncher = options.launcher ?? {
    command: "tl",
    argsPrefix: [],
    env: {},
  };
  const launcher = effectiveGuideProfile === "portable"
    ? { ...baseLauncher, env: { ...baseLauncher.env, TL_PORTABLE_TOOLS: "1" } }
    : baseLauncher;
  // Only worth computing when a client config is actually about to be
  // written — a rules-only setup (or an empty client list) never calls
  // configureVsCode/configureCodex/configureClaude, so skip the spawn.
  const schemaStamp = clients.length > 0
    ? (options.schemaStamp !== undefined ? options.schemaStamp() : currentMcpSchemaStamp(options.toolSurface, effectiveGuideProfile === "portable"))
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
      configFilesWritten.push(configureVsCode(root, launcher, schemaStamp, options.toolSurface, installHomeDefault, platform, linkTaskPackCeiling, permissions[client]!));
      if (options.copilotSessionContext !== "keep") {
        const sessionHook = installCopilotSessionHook(root);
        configFilesWritten.push(...sessionHook.files);
        sessionWarnings.push(...sessionHook.warnings.map(warning => `Copilot SessionStart: ${warning}`));
      }
    }
    if (client === "codex") {
      configFilesWritten.push(configureCodex(root, launcher, schemaStamp, options.toolSurface, permissions[client]!));
    }
    if (client === "claude-code") {
      configFilesWritten.push(configureClaude(root, launcher, schemaStamp, options.toolSurface, installHomeDefault, platform, permissions[client]!));
    }
  }
  return {
    schemaVersion: 1,
    workspaceRoot: root,
    clients,
    writeEnabled,
    ...(mixedPermissions ? { writeEnabledByClient: permissions } : {}),
    usageLoggingEnabled: true,
    rulesWritten,
    configFilesWritten,
    warnings: [...rules.drifted.map((item) => `Rule drift: ${item.path}`), ...sessionWarnings],
    copilotInlineResults,
    // `.code-workspace` files are looked up last, from the FINAL status: a
    // run that gave the settings back (`withdrawCopilotGuide`) ends `manual`.
    copilotGuide: copilotGuide !== undefined
      ? withCodeWorkspaceFiles(root, copilotGuide.report)
      : { status: "not-applicable" },
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
  const permissions = raw["writeEnabledByClient"];
  if (permissions !== undefined && (
    !permissions || typeof permissions !== "object" || Array.isArray(permissions)
    || !Object.entries(permissions).every(([client, enabled]) =>
      CLIENTS.has(client as TokenLightenSetupClient)
      && (raw["clients"] as string[]).includes(client)
      && typeof enabled === "boolean")
  )) return null;
  return {
    workspaceRoot: raw["workspaceRoot"],
    clients: raw["clients"] as TokenLightenSetupClient[],
    writeEnabled: raw["writeEnabled"],
    ...(permissions !== undefined ? { writeEnabledByClient: { ...permissions as Partial<Record<TokenLightenSetupClient, boolean>> } } : {}),
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
  const writeEnabled = entry.writeEnabledByClient?.vscode ?? entry.writeEnabled;
  if (
    !hasValidVsCodeServer(root, writeEnabled, entry.usageLoggingEnabled)
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
    writeEnabled,
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
    ...(result.writeEnabledByClient !== undefined ? { writeEnabledByClient: { ...result.writeEnabledByClient } } : {}),
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
      ...(parsed.writeEnabledByClient !== undefined ? { writeEnabledByClient: { ...parsed.writeEnabledByClient } } : {}),
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
  if (rest.includes("--clients") && (rawClients === undefined || rawClients.trim() === "" || rawClients.startsWith("--"))) {
    process.stderr.write("tl workspace: --clients requires a value (vscode,codex,claude-code)\n");
    process.exitCode = 1;
    return;
  }
  const clients = rawClients
    ? rawClients.split(",").map((item) => item.trim()) as TokenLightenSetupClient[]
    : undefined;
  const rulesOnly = rest.includes("--rules-only");
  const readOnly = rest.includes("--read-only");
  if (readOnly && rest.includes("--allow-write")) {
    process.stderr.write("tl workspace: choose either --read-only or --allow-write\n");
    process.exitCode = 1;
    return;
  }
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
  const rawCopilotGuide = valueAfter(rest, "--copilot-guide");
  const copilotGuide: CopilotGuideRequest | undefined =
    rawCopilotGuide !== undefined && isCopilotGuideRequest(rawCopilotGuide) ? rawCopilotGuide : undefined;
  if (rawCopilotGuide !== undefined && copilotGuide === undefined) {
    process.stderr.write(`tl workspace: unrecognized --copilot-guide value '${rawCopilotGuide}' (expected ${COPILOT_GUIDE_VALUES.join(" | ")})\n`);
    process.exitCode = 1;
    return;
  }
  const copilotSessionContext = valueAfter(rest, "--copilot-session-context");
  if (copilotSessionContext !== undefined && copilotSessionContext !== "install" && copilotSessionContext !== "keep") {
    process.stderr.write("tl workspace: --copilot-session-context expects install | keep\n");
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
    ...(readOnly ? { writeEnabled: false } : rest.includes("--allow-write") ? { writeEnabled: true } : {}),
    ...(guideProfile !== undefined ? { guideProfile } : {}),
    ...(toolSurface !== undefined ? { toolSurface } : {}),
    ...(copilotInlineResults !== undefined ? { copilotInlineResults } : {}),
    ...(copilotGuide !== undefined ? { copilotGuide } : {}),
    ...(copilotSessionContext !== undefined ? { copilotSessionContext } : {}),
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
  const copilotGuideLine = formatCopilotGuideLine(result.workspaceRoot, result.copilotGuide);
  const guideProfileAdviceLine = formatGuideProfileAdviceLine(result.clients, effectiveGuideProfile, result.copilotGuide);
  process.stdout.write(
    `TokenLighten is ready for ${result.clients.join(", ")}.\n`
      + `AI rules: ${result.rulesWritten.length} file(s)\n`
      + `MCP settings: ${result.configFilesWritten.length} file(s)\n`
      + (rulesOnly ? "Write tools: not configured (--rules-only)\n"
        : result.writeEnabledByClient !== undefined
          ? `Write tools: ${Object.entries(result.writeEnabledByClient).map(([client, enabled]) => `${client}=${enabled ? "enabled" : "disabled"}`).join(", ")}\n`
        : result.writeEnabled
          ? "Write tools: enabled in generated MCP settings (--allow-write); use --read-only to disable\n"
          : "Write tools: disabled in generated MCP settings (--read-only)\n")
      + "Usage log: local, content-free\n"
      + `guide_profile: ${effectiveGuideProfile}\n`
      + (serverBuild !== undefined ? "server_build: " + serverBuild + "\n" : "")
      + (copilotLine !== undefined ? copilotLine + "\n" : "")
      + (copilotGuideLine !== undefined ? copilotGuideLine + "\n" : "")
      + (guideProfileAdviceLine !== undefined ? guideProfileAdviceLine + "\n" : ""),
  );
}
