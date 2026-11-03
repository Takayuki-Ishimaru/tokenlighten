/**
 * agentHooksSetup.ts — writes and removes TokenLighten's agent hooks in each
 * host's own configuration file (2026-11-03). Default-on since 2026-11-03:
 * `tl install` and `tl workspace setup` install them for every client they
 * set up (`--hooks` is the explicit spelling of that default); `--no-hooks`
 * leaves every hook file alone; `--remove-hooks` and `tl install
 * --uninstall` take TokenLighten's entries out again.
 *
 * Per client:
 * - claude-code: `.claude/settings.json` (shared, committable). Merged: the
 *   file's other keys and every hook entry whose command is not TokenLighten's
 *   `… hook <event> --client …` are kept byte-for-byte in meaning; TokenLighten's
 *   own groups are replaced, so a re-run changes nothing. Test/build output
 *   is compressed on PostToolUse (`Bash`), after the command ran as written;
 *   no PreToolUse group is written any more, and a re-run removes the one an
 *   earlier install wrote (2026-11-03: its `updatedInput` + `ask` rewrite was
 *   denied in Claude Code `-p` runs and prompted interactively, and without a
 *   decision the user's allow rules no longer matched the rewritten command).
 * - codex: `.codex/hooks.json`, the same nested matcher-group shape and the
 *   same merge. PreToolUse is not written (Codex rewrites a command only
 *   with an auto-approval TokenLighten never grants).
 * - vscode (Copilot CLI and VS Code): `.github/hooks/tokenlighten-hooks.json`,
 *   a file of its own in the flat Copilot shape. Ownership is a sha256 record
 *   in `.tokenlighten/agent-hooks-owned.json`: a file whose digest is neither
 *   the recorded one nor the current rendering was edited by hand and is
 *   preserved with a warning; a setup-owned file from an earlier rendering is
 *   replaced. Test/build output is compressed on postToolUse (`modifiedResult`)
 *   instead of the earlier preToolUse rewrite (2026-11-03: Copilot CLI 1.0.105
 *   `-p` denied the rewritten command, "Denied, no one to approve", even with
 *   `--allow-tool shell`).
 *
 * Commands are rendered from the launcher identity the same way `.mcp.json`
 * is: a plain `tl` when that is the launcher, else the portable
 * `${HOME}`/`${LOCALAPPDATA}` form the caller already substituted, so the
 * files carry no machine path the existing setup avoids. Copilot's entries
 * get a `bash` and a `powershell` form, each ending in `exit 0`: a failing
 * hook must never cost the agent its command or its result.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { AgentHooksClientReport, AgentHooksReport, TokenLightenSetupClient } from "@tokenlighten/types";
import { createDirectoryMode, createFileMode, existingFileMode, keepExistingFileMode, type FileVisibility } from "./fileMode.js";

export const CLAUDE_HOOK_SETTINGS = ".claude/settings.json";
export const CODEX_HOOKS_FILE = ".codex/hooks.json";
export const COPILOT_HOOKS_FILE = ".github/hooks/tokenlighten-hooks.json";
export const AGENT_HOOKS_RECORD = ".tokenlighten/agent-hooks-owned.json";

/**
 * Seconds a host waits for one hook; `tl` is a Node start plus a few stats
 * (post-tool-use also writes one log and ranks the output).
 */
const TOOL_HOOK_TIMEOUT_S = 20;
const MARKER_TIMEOUT_S = 10;

export interface HookLauncher {
  command: string;
  argsPrefix: readonly string[];
}

const TL_HOOK_COMMAND = /(^|[\s"'/\\])tl(\.js|\.cmd)?["']?\s+hook\s+(pre-tool-use|post-tool-use|pre-compact|post-compact|session-start)(\s|$)/;

/** True for a command string TokenLighten's installer rendered (any launcher form). */
export function isTokenLightenHookCommand(command: unknown): boolean {
  return typeof command === "string" && TL_HOOK_COMMAND.test(command);
}

// ---------------------------------------------------------------------------
// Command rendering
// ---------------------------------------------------------------------------

const BARE_TOKEN = /^[A-Za-z0-9_./:=-]+$/;

function bashPart(part: string): string {
  const slashed = part.replace(/\\/g, "/");
  if (BARE_TOKEN.test(slashed)) return slashed;
  // `${HOME}` must expand, so `$` stays; the rest of the double-quote specials are escaped.
  return `"${slashed.replace(/(["`])/g, "\\$1")}"`;
}

function powershellPart(part: string): string {
  const slashed = part.replace(/\\/g, "/");
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(slashed)) {
    const expanded = slashed.replace(/`/g, "``").replace(/"/g, "`\"")
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "$env:$1");
    return `"${expanded}"`;
  }
  if (BARE_TOKEN.test(slashed)) return slashed;
  return `'${slashed.replace(/'/g, "''")}'`;
}

export interface RenderedHookCommand { bash: string; powershell: string }

/** Both shell forms of `<launcher> hook <event> --client <client>`. */
export function renderHookCommand(launcher: HookLauncher, event: string, client: string): RenderedHookCommand {
  const parts = [launcher.command, ...launcher.argsPrefix];
  const tail = ["hook", event, "--client", client];
  const bash = [...parts.map(bashPart), ...tail].join(" ");
  const powershellParts = parts.map(powershellPart);
  const powershell = `${powershellParts.length === 1 && BARE_TOKEN.test(powershellParts[0]!) ? "" : "& "}${[...powershellParts, ...tail].join(" ")}`;
  return { bash, powershell };
}

// ---------------------------------------------------------------------------
// Renderings per client
// ---------------------------------------------------------------------------

type HookGroup = { matcher?: string; hooks: Array<{ type: "command"; command: string; timeout: number }> };

function nestedGroup(command: string, timeout: number, matcher?: string): HookGroup {
  return { ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] };
}

/**
 * Claude Code: `hooks.<Event>` → matcher groups (https://code.claude.com/docs/en/hooks).
 * PostToolUse, not PreToolUse (2026-11-03; see the module header).
 */
export function renderClaudeHookGroups(launcher: HookLauncher): Record<string, HookGroup[]> {
  const cmd = (event: string): string => renderHookCommand(launcher, event, "claude-code").bash;
  return {
    PostToolUse: [nestedGroup(cmd("post-tool-use"), TOOL_HOOK_TIMEOUT_S, "Bash")],
    PreCompact: [nestedGroup(cmd("pre-compact"), MARKER_TIMEOUT_S)],
    SessionStart: [nestedGroup(cmd("session-start"), MARKER_TIMEOUT_S, "clear|compact")],
  };
}

/** Codex: the same nested shape; no PreToolUse (see the module header). */
export function renderCodexHookGroups(launcher: HookLauncher): Record<string, HookGroup[]> {
  const cmd = (event: string): string => renderHookCommand(launcher, event, "codex").bash;
  return {
    PreCompact: [nestedGroup(cmd("pre-compact"), MARKER_TIMEOUT_S)],
    SessionStart: [nestedGroup(cmd("session-start"), MARKER_TIMEOUT_S, "clear|compact")],
  };
}

/** Copilot CLI / VS Code: `{version:1, hooks:{<event>:[entries]}}`, flat entries with per-shell commands. */
export function renderCopilotHooksFile(launcher: HookLauncher): Record<string, unknown> {
  const entry = (event: string, timeoutSec: number, matcher?: string): Record<string, unknown> => {
    const rendered = renderHookCommand(launcher, event, "copilot");
    return {
      type: "command",
      ...(matcher !== undefined ? { matcher } : {}),
      // A failing or missing `tl` must not cost the agent anything: preToolUse is
      // fail-closed there, and a postToolUse failure is logged as a hook error.
      bash: `${rendered.bash} || exit 0`,
      powershell: `${rendered.powershell}; exit 0`,
      timeoutSec,
    };
  };
  return {
    version: 1,
    hooks: {
      // Copilot CLI's shell tools are `bash` and, on Windows, `powershell`;
      // `run_in_terminal` is VS Code's. postToolUse, not preToolUse
      // (2026-11-03): the output is compressed after the command ran as written.
      postToolUse: [entry("post-tool-use", TOOL_HOOK_TIMEOUT_S, "bash|powershell|run_in_terminal")],
      preCompact: [entry("pre-compact", MARKER_TIMEOUT_S)],
      sessionStart: [entry("session-start", MARKER_TIMEOUT_S)],
    },
  };
}

/** What each client's documented contract does not offer; reported, never faked. */
export const UNSUPPORTED_BY_CLIENT: Readonly<Record<TokenLightenSetupClient, readonly string[]>> = {
  // 2026-11-03, live with Claude Code 2.1.309: a non-zero exit fires
  // PostToolUseFailure, which can add context but not replace the output.
  "claude-code": ["compressing a failing run (a non-zero exit reaches PostToolUseFailure, which cannot replace output): run `tl run -- <command>` by hand"],
  codex: ["command rewrite (updatedInput needs permissionDecision allow): run `tl run -- <command>` by hand"],
  vscode: ["session-start source for compaction (preCompact covers it)"],
};

// ---------------------------------------------------------------------------
// File helpers (leaf: no import from workspace.ts, which imports this module)
// ---------------------------------------------------------------------------

function assertInsideRoot(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to write outside the selected workspace: ${target}`);
  }
}

function assertNotSymlink(target: string): void {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to replace symlinked setup file: ${target}`);
  }
}

interface JsonStyle { indent: string; trailingNewline: boolean }

function detectStyle(text: string | undefined): JsonStyle {
  if (text === undefined) return { indent: "  ", trailingNewline: true };
  const match = /\n([ \t]+)"/.exec(text);
  return { indent: match?.[1] ?? "  ", trailingNewline: text.endsWith("\n") };
}

function readJsonFile(root: string, target: string): { document: Record<string, unknown>; text?: string } {
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  if (!existsSync(target)) return { document: {} };
  const text = readFileSync(target, "utf8");
  const parsed: unknown = text.trim() === "" ? {} : JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected a JSON object in ${target}`);
  return { document: parsed as Record<string, unknown>, text };
}

function writeFileReplacing(root: string, target: string, body: string, visibility: FileVisibility): void {
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  assertNotSymlink(dirname(target));
  mkdirSync(dirname(target), { recursive: true, mode: createDirectoryMode(visibility) });
  const temporary = join(dirname(target), `.tl-hooks-${randomBytes(6).toString("hex")}.tmp`);
  const previousMode = existingFileMode(target);
  writeFileSync(temporary, body, { encoding: "utf8", mode: createFileMode(visibility) });
  keepExistingFileMode(temporary, previousMode);
  try {
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function serialize(document: Record<string, unknown>, style: JsonStyle): string {
  return `${JSON.stringify(document, null, style.indent)}${style.trailingNewline ? "\n" : ""}`;
}

const digest = (body: string): string => createHash("sha256").update(body).digest("hex");

// ---------------------------------------------------------------------------
// Nested (Claude Code / Codex) merge
// ---------------------------------------------------------------------------

function isHookEntryOurs(entry: unknown): boolean {
  return !!entry && typeof entry === "object" && isTokenLightenHookCommand((entry as Record<string, unknown>)["command"]);
}

/**
 * Removes TokenLighten's entries from one event's groups: a group left with
 * no hooks goes; a user group that somehow carries one of ours keeps its own
 * hooks. Returns the surviving groups.
 */
function withoutOurGroups(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) { kept.push(group); continue; }
    const record = group as Record<string, unknown>;
    if (!Array.isArray(record["hooks"])) { kept.push(group); continue; }
    const hooks = record["hooks"].filter((hook) => !isHookEntryOurs(hook));
    if (hooks.length === 0) continue;
    kept.push(hooks.length === record["hooks"].length ? group : { ...record, hooks });
  }
  return kept;
}

/** `true` when the document changed. */
function mergeNestedHooks(document: Record<string, unknown>, ours: Record<string, HookGroup[]> | undefined, managedEvents: readonly string[]): boolean {
  const before = JSON.stringify(document);
  const hooksValue = document["hooks"];
  const hooks: Record<string, unknown> = hooksValue && typeof hooksValue === "object" && !Array.isArray(hooksValue)
    ? hooksValue as Record<string, unknown>
    : {};
  if (hooksValue !== undefined && hooks !== hooksValue) throw new Error("Expected 'hooks' to be a JSON object");
  for (const event of managedEvents) {
    const kept = withoutOurGroups(hooks[event]);
    const next = ours !== undefined && ours[event] !== undefined ? [...kept, ...ours[event]!] : kept;
    if (next.length === 0) delete hooks[event];
    else hooks[event] = next;
  }
  if (Object.keys(hooks).length === 0) delete document["hooks"];
  else document["hooks"] = hooks;
  return JSON.stringify(document) !== before;
}

/**
 * Events whose TokenLighten groups setup replaces or removes. PreToolUse stays
 * managed although Claude Code no longer gets one, so a re-run takes out the
 * group an earlier install wrote (2026-11-03).
 */
const NESTED_EVENTS = ["PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SessionStart"] as const;

function installNested(root: string, file: string, ours: Record<string, HookGroup[]>): { file: string; events: string[] } {
  const target = join(root, file);
  const { document, text } = readJsonFile(root, target);
  if (mergeNestedHooks(document, ours, NESTED_EVENTS)) writeFileReplacing(root, target, serialize(document, detectStyle(text)), "shared");
  return { file: target, events: Object.keys(ours) };
}

function removeNested(root: string, file: string, emptied: string[]): string | undefined {
  const target = join(root, file);
  if (!existsSync(target)) return undefined;
  const { document, text } = readJsonFile(root, target);
  if (!mergeNestedHooks(document, undefined, NESTED_EVENTS)) return undefined;
  writeFileReplacing(root, target, serialize(document, detectStyle(text)), "shared");
  if (Object.keys(document).length === 0) emptied.push(target);
  return target;
}

// ---------------------------------------------------------------------------
// Copilot file (own file + ownership record)
// ---------------------------------------------------------------------------

type OwnershipRecord = { schemaVersion: 1; files: Record<string, string> };

function readRecord(root: string): OwnershipRecord {
  const target = join(root, AGENT_HOOKS_RECORD);
  try {
    const { document } = readJsonFile(root, target);
    const files = document["files"];
    if (document["schemaVersion"] === 1 && files && typeof files === "object" && !Array.isArray(files)
      && Object.values(files as Record<string, unknown>).every((value) => typeof value === "string")) {
      return { schemaVersion: 1, files: { ...(files as Record<string, string>) } };
    }
  } catch { /* an unreadable record claims nothing */ }
  return { schemaVersion: 1, files: {} };
}

function writeRecord(root: string, record: OwnershipRecord): void {
  const target = join(root, AGENT_HOOKS_RECORD);
  if (Object.keys(record.files).length === 0) {
    if (existsSync(target)) { assertNotSymlink(target); unlinkSync(target); }
    return;
  }
  const body = serialize(record, { indent: "  ", trailingNewline: true });
  // A re-run changes nothing (2026-11-03, default-on): an identical record is not rewritten.
  if (existsSync(target)) {
    assertNotSymlink(target);
    if (readFileSync(target, "utf8") === body) return;
  }
  writeFileReplacing(root, target, body, "private");
}

function installCopilot(root: string, launcher: HookLauncher, warnings: string[]): { file?: string; events: string[] } {
  const target = join(root, COPILOT_HOOKS_FILE);
  const rendered = renderCopilotHooksFile(launcher);
  const body = serialize(rendered, { indent: "  ", trailingNewline: true });
  const record = readRecord(root);
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  if (existsSync(target)) {
    const current = readFileSync(target, "utf8");
    const owned = record.files[COPILOT_HOOKS_FILE];
    if (current !== body && digest(current) !== owned) {
      warnings.push(`Copilot hooks: ${target} was edited by hand and is preserved; remove it to let setup write it, or pass --no-hooks`);
      return { events: [] };
    }
    if (current !== body) writeFileReplacing(root, target, body, "shared");
  } else {
    writeFileReplacing(root, target, body, "shared");
  }
  record.files[COPILOT_HOOKS_FILE] = digest(body);
  writeRecord(root, record);
  return { file: target, events: Object.keys((rendered["hooks"] as Record<string, unknown>)) };
}

function removeCopilot(root: string, warnings: string[]): string | undefined {
  const target = join(root, COPILOT_HOOKS_FILE);
  const record = readRecord(root);
  const owned = record.files[COPILOT_HOOKS_FILE];
  if (!existsSync(target)) {
    if (owned !== undefined) { delete record.files[COPILOT_HOOKS_FILE]; writeRecord(root, record); }
    return undefined;
  }
  assertInsideRoot(root, target);
  assertNotSymlink(target);
  if (owned === undefined || digest(readFileSync(target, "utf8")) !== owned) {
    warnings.push(`Copilot hooks: ${target} is not the file setup wrote and is preserved`);
    return undefined;
  }
  unlinkSync(target);
  delete record.files[COPILOT_HOOKS_FILE];
  writeRecord(root, record);
  return target;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InstallAgentHooksOptions {
  clients: readonly TokenLightenSetupClient[];
  /** The launcher as it should appear in shared files (already portable where setup makes it so). */
  launcher: HookLauncher;
}

export function installAgentHooks(root: string, options: InstallAgentHooksOptions): AgentHooksReport {
  const warnings: string[] = [];
  const clients: AgentHooksClientReport[] = [];
  for (const client of options.clients) {
    try {
      if (client === "claude-code") {
        const outcome = installNested(root, CLAUDE_HOOK_SETTINGS, renderClaudeHookGroups(options.launcher));
        clients.push({ client, file: outcome.file, events: outcome.events, unsupported: UNSUPPORTED_BY_CLIENT[client] });
      } else if (client === "codex") {
        const outcome = installNested(root, CODEX_HOOKS_FILE, renderCodexHookGroups(options.launcher));
        clients.push({ client, file: outcome.file, events: outcome.events, unsupported: UNSUPPORTED_BY_CLIENT[client] });
      } else {
        const outcome = installCopilot(root, options.launcher, warnings);
        clients.push({ client, ...(outcome.file !== undefined ? { file: outcome.file } : {}), events: outcome.events, unsupported: UNSUPPORTED_BY_CLIENT[client] });
      }
    } catch (error) {
      warnings.push(`${client} hooks: ${String((error as Error).message ?? error)}`);
      clients.push({ client, events: [], unsupported: UNSUPPORTED_BY_CLIENT[client] });
    }
  }
  return { action: "installed", clients, emptied: [], warnings };
}

export function removeAgentHooks(root: string, clients: readonly TokenLightenSetupClient[] = ["vscode", "codex", "claude-code"]): AgentHooksReport {
  const warnings: string[] = [];
  const emptied: string[] = [];
  const reports: AgentHooksClientReport[] = [];
  for (const client of clients) {
    try {
      const file = client === "claude-code" ? removeNested(root, CLAUDE_HOOK_SETTINGS, emptied)
        : client === "codex" ? removeNested(root, CODEX_HOOKS_FILE, emptied)
        : removeCopilot(root, warnings);
      reports.push({ client, ...(file !== undefined ? { file } : {}), events: [], unsupported: UNSUPPORTED_BY_CLIENT[client] });
    } catch (error) {
      warnings.push(`${client} hooks: ${String((error as Error).message ?? error)}`);
      reports.push({ client, events: [], unsupported: UNSUPPORTED_BY_CLIENT[client] });
    }
  }
  return { action: "removed", clients: reports, emptied, warnings };
}
