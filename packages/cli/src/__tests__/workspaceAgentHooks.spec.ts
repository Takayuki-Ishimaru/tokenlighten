/**
 * workspaceAgentHooks.spec.ts — agent hooks through `tl workspace setup` and
 * `tl install`'s argument parsing (2026-11-03): the files each client
 * receives, the setup result, idempotency, removal. Default-on since
 * 2026-11-03: a setup run without a hook flag installs them for every client
 * it sets up, `--hooks` means the same, `--no-hooks` leaves every hook file
 * alone and `--remove-hooks` takes TokenLighten's entries out.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHooksReport } from "@tokenlighten/types";
import { agentHooksMode, runWorkspace as runWorkspaceCommand, setupWorkspace, type RunWorkspaceOptions } from "../commands/workspace.js";
import { parseInstallArgs } from "../commands/install.js";
import { AGENT_HOOKS_RECORD, CLAUDE_HOOK_SETTINGS, CODEX_HOOKS_FILE, COPILOT_HOOKS_FILE } from "../agentHooksSetup.js";

const roots: string[] = [];
function fixture(): string {
  const root = join(tmpdir(), `tokenlighten-hooks-ws-${randomUUID()}`);
  mkdirSync(join(root, ".git"), { recursive: true });
  roots.push(root);
  return root;
}
const isolatedInstallHome = join(tmpdir(), `tokenlighten-hooks-install-${randomUUID()}`);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(isolatedInstallHome, { recursive: true, force: true });
});

const launcher = { command: "tl", argsPrefix: [], env: {} };
/** Every file a setup run may write for agent hooks, the Copilot ownership record included. */
const HOOK_FILES = [CLAUDE_HOOK_SETTINGS, CODEX_HOOKS_FILE, COPILOT_HOOKS_FILE, AGENT_HOOKS_RECORD] as const;

/** Bytes and mtime of each hook file that exists, so "unchanged" means not even rewritten. */
function snapshot(root: string): Record<string, { text: string; mtimeMs: number } | undefined> {
  return Object.fromEntries(HOOK_FILES.map((file) => {
    const path = join(root, file);
    return [file, existsSync(path) ? { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs } : undefined];
  }));
}

interface SetupJson {
  workspaceRoot: string;
  clients: string[];
  agentHooks?: AgentHooksReport;
  warnings: Array<string | { code: string }>;
}

/** Runs `tl workspace setup` and returns what it printed and the exit code it set. */
async function setupCli(args: readonly string[], root: string): Promise<{ printed: string; errors: string; exitCode: number }> {
  let printed = "";
  let errors = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { printed += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { errors += String(chunk); return true; });
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  const options: RunWorkspaceOptions = { registryPath: join(root, "registry.toml"), installHome: isolatedInstallHome, launcher, versionCheck: () => "0.16.4-test" };
  try {
    await runWorkspaceCommand(["setup", "--root", root, ...args], options);
    return { printed, errors, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    process.exitCode = previousExit;
  }
}

async function setupJson(args: readonly string[], root: string): Promise<SetupJson> {
  const { printed, errors, exitCode } = await setupCli([...args, "--json"], root);
  expect(exitCode, errors).toBe(0);
  return JSON.parse(printed) as SetupJson;
}

/** The hook report with root-relative file paths, comparable across two workspaces. */
function portableReport(json: SetupJson): unknown {
  const report = json.agentHooks;
  if (report === undefined) return undefined;
  return {
    ...report,
    clients: report.clients.map((client) => ({ ...client, ...(client.file !== undefined ? { file: relative(json.workspaceRoot, client.file) } : {}) })),
  };
}

describe("setupWorkspace agent hooks (API)", () => {
  it("writes each selected client's hook file, reports them, and removes them again", async () => {
    const root = fixture();
    const result = await setupWorkspace({ root, clients: ["vscode", "codex", "claude-code"], launcher, schemaStamp: () => "stamp", agentHooks: "install", copilotInlineResults: "keep", copilotGuide: "keep" });
    expect(result.agentHooks?.action).toBe("installed");
    expect(result.agentHooks?.warnings).toEqual([]);
    for (const file of [CLAUDE_HOOK_SETTINGS, CODEX_HOOKS_FILE, COPILOT_HOOKS_FILE]) {
      expect(existsSync(join(root, file)), file).toBe(true);
      expect(result.configFilesWritten).toContain(join(root, file));
      expect(result.createdFiles).toContain(join(root, file));
    }
    expect(result.agentHooks?.clients.map((client) => client.client)).toEqual(["vscode", "codex", "claude-code"]);
    const claude = JSON.parse(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(claude.hooks)).toEqual(["PostToolUse", "PreCompact", "SessionStart"]);
    expect(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")).toContain("tl hook post-tool-use --client claude-code");
    // Omitted (what the CLI passes under --no-hooks): the hook files stay exactly as they are.
    const before = [CLAUDE_HOOK_SETTINGS, CODEX_HOOKS_FILE, COPILOT_HOOKS_FILE].map((file) => readFileSync(join(root, file), "utf8"));
    const plain = await setupWorkspace({ root, clients: ["vscode", "codex", "claude-code"], launcher, schemaStamp: () => "stamp", copilotInlineResults: "keep", copilotGuide: "keep" });
    expect(plain.agentHooks).toBeUndefined();
    expect([CLAUDE_HOOK_SETTINGS, CODEX_HOOKS_FILE, COPILOT_HOOKS_FILE].map((file) => readFileSync(join(root, file), "utf8"))).toEqual(before);
    const removed = await setupWorkspace({ root, clients: ["vscode", "codex", "claude-code"], launcher, schemaStamp: () => "stamp", agentHooks: "remove", copilotInlineResults: "keep", copilotGuide: "keep" });
    expect(removed.agentHooks?.action).toBe("removed");
    expect(existsSync(join(root, COPILOT_HOOKS_FILE))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8"))).toEqual({});
    expect(JSON.parse(readFileSync(join(root, CODEX_HOOKS_FILE), "utf8"))).toEqual({});
    expect([...(removed.agentHooks?.emptied ?? [])].sort()).toEqual([join(root, CLAUDE_HOOK_SETTINGS), join(root, CODEX_HOOKS_FILE)].sort());
  });

  it("names the launcher the way .mcp.json does: a portable identity carries no machine path", async () => {
    const root = fixture();
    const home = process.platform === "win32" ? process.env["LOCALAPPDATA"] : undefined;
    const base = home ?? "/home/dev/.local/share";
    const identity = { command: join(base, "tokenlighten", "bin", "node"), argsPrefix: [join(base, "tokenlighten", "bin", "tl.js")], env: {} };
    const result = await setupWorkspace({ root, clients: ["claude-code"], launcher: identity, schemaStamp: () => "stamp", agentHooks: "install", installHomeDefault: true, platform: process.platform });
    const text = readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8");
    if (process.platform === "win32" && home) {
      expect(text).toContain("${LOCALAPPDATA}/tokenlighten/bin/node");
      expect(text).not.toContain(home.replace(/\\/g, "/"));
    } else if (process.platform !== "win32") {
      // POSIX substitutes the real home; the fake base is not it, so the path stays as given.
      expect(text).toContain("/home/dev/.local/share/tokenlighten/bin/node");
    }
    expect(result.agentHooks?.clients[0]?.events).toEqual(["PostToolUse", "PreCompact", "SessionStart"]);
  });
});

describe("tl workspace setup: agent hooks are default-on (CLI)", () => {
  it("resolves the hook mode from the flags: install by default and under --hooks, nothing under --no-hooks", () => {
    expect(agentHooksMode([])).toBe("install");
    expect(agentHooksMode(["--hooks"])).toBe("install");
    expect(agentHooksMode(["--no-hooks"])).toBeUndefined();
    expect(agentHooksMode(["--remove-hooks"])).toBe("remove");
  });

  it("a run with no hook flag writes the hooks for every client it sets up, and only for those", async () => {
    const all = fixture();
    const json = await setupJson([], all);
    expect(json.clients).toEqual(["vscode", "codex", "claude-code"]);
    expect(json.agentHooks?.action).toBe("installed");
    expect(json.agentHooks?.warnings).toEqual([]);
    expect(json.agentHooks?.clients.map((client) => [client.client, client.events])).toEqual([
      ["vscode", ["postToolUse", "preCompact", "sessionStart"]],
      ["codex", ["PreCompact", "SessionStart"]],
      ["claude-code", ["PostToolUse", "PreCompact", "SessionStart"]],
    ]);
    for (const file of [CLAUDE_HOOK_SETTINGS, CODEX_HOOKS_FILE, COPILOT_HOOKS_FILE]) expect(existsSync(join(all, file)), file).toBe(true);
    const claude = readFileSync(join(all, CLAUDE_HOOK_SETTINGS), "utf8");
    expect(claude).toContain("tl hook post-tool-use --client claude-code");
    expect(claude).not.toMatch(/permissionDecision|"allow"/);

    // --clients narrows the hooks exactly as it narrows the other files.
    const two = fixture();
    const narrowed = await setupJson(["--clients", "claude-code,codex"], two);
    expect(narrowed.agentHooks?.clients.map((client) => client.client)).toEqual(["claude-code", "codex"]);
    expect(existsSync(join(two, CLAUDE_HOOK_SETTINGS))).toBe(true);
    expect(existsSync(join(two, CODEX_HOOKS_FILE))).toBe(true);
    expect(existsSync(join(two, COPILOT_HOOKS_FILE))).toBe(false);
    expect(existsSync(join(two, ".github"))).toBe(false);

    // --rules-only sets up no client, so no hook either.
    const rules = fixture();
    const rulesOnly = await setupJson(["--rules-only"], rules);
    expect(rulesOnly.agentHooks).toBeUndefined();
    expect(HOOK_FILES.filter((file) => existsSync(join(rules, file)))).toEqual([]);
  }, 120000);

  it("prints one line per client, keeps the not-available lines, and says how to opt out", async () => {
    const root = fixture();
    const { printed, exitCode } = await setupCli([], root);
    expect(exitCode).toBe(0);
    expect(printed).toContain(`Agent hooks (claude-code): PostToolUse, PreCompact, SessionStart in ${join(realpathSync(root), CLAUDE_HOOK_SETTINGS)}`);
    expect(printed).toContain("Agent hooks (codex): PreCompact, SessionStart in");
    expect(printed).toContain("Agent hooks (vscode): postToolUse, preCompact, sessionStart in");
    expect(printed).toContain("  not available for claude-code: compressing a failing run");
    expect(printed).toContain("  not available for codex: command rewrite");
    expect(printed).toContain("  not available for vscode: session-start source");
    expect(printed).toContain("Agent hooks: Copilot and Codex load them only once the folder is trusted, which setup does not do for you; --no-hooks skips them, --remove-hooks removes them");
    // Claude Code alone: no Codex/Copilot trust note, the opt-out stays.
    const claudeOnly = fixture();
    const single = await setupCli(["--clients", "claude-code"], claudeOnly);
    expect(single.printed).toContain("Agent hooks: --no-hooks skips them, --remove-hooks removes them");
  }, 120000);

  it("is idempotent: a re-run with no flag rewrites nothing and keeps the user's own entries", async () => {
    const root = fixture();
    const userClaude = { permissions: { allow: ["Bash(npm test)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    const userCodex = { hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 policy.py", timeout: 30 }] }] } };
    mkdirSync(join(root, ".claude"), { recursive: true });
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, CLAUDE_HOOK_SETTINGS), `${JSON.stringify(userClaude, null, 2)}\n`);
    writeFileSync(join(root, CODEX_HOOKS_FILE), `${JSON.stringify(userCodex, null, 2)}\n`);
    const first = await setupJson([], root);
    const afterFirst = snapshot(root);
    expect(Object.values(afterFirst).every((entry) => entry !== undefined)).toBe(true);
    const claude = JSON.parse(afterFirst[CLAUDE_HOOK_SETTINGS]!.text) as { permissions: unknown; hooks: Record<string, unknown[]> };
    expect(claude.permissions).toEqual(userClaude.permissions);
    expect(claude.hooks["Stop"]).toEqual(userClaude.hooks.Stop);
    expect(Object.keys(claude.hooks).sort()).toEqual(["PostToolUse", "PreCompact", "SessionStart", "Stop"]);
    const codex = JSON.parse(afterFirst[CODEX_HOOKS_FILE]!.text) as { hooks: Record<string, unknown[]> };
    expect(codex.hooks["PreToolUse"]).toEqual(userCodex.hooks.PreToolUse);

    const second = await setupJson([], root);
    expect(snapshot(root)).toEqual(afterFirst);
    expect(portableReport(second)).toEqual(portableReport(first));
    expect(second.agentHooks?.warnings).toEqual([]);
  }, 120000);

  it("--no-hooks writes no hook file, and leaves existing ones (TokenLighten's and hand-edited) exactly as they are", async () => {
    const fresh = fixture();
    const none = await setupJson(["--no-hooks"], fresh);
    expect(none.clients).toEqual(["vscode", "codex", "claude-code"]);
    expect(none.agentHooks).toBeUndefined();
    expect(HOOK_FILES.filter((file) => existsSync(join(fresh, file)))).toEqual([]);
    expect(existsSync(join(fresh, ".claude"))).toBe(false);

    const root = fixture();
    await setupJson([], root);
    // A hand-edited Copilot file and a user hook added next to TokenLighten's.
    writeFileSync(join(root, COPILOT_HOOKS_FILE), '{"version":1,"hooks":{}}\n');
    const claude = JSON.parse(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")) as { hooks: Record<string, unknown[]> };
    claude.hooks["Stop"] = [{ hooks: [{ type: "command", command: "say done" }] }];
    writeFileSync(join(root, CLAUDE_HOOK_SETTINGS), `${JSON.stringify(claude, null, 2)}\n`);
    const before = snapshot(root);
    const skipped = await setupJson(["--no-hooks"], root);
    expect(skipped.agentHooks).toBeUndefined();
    expect(JSON.stringify(skipped.warnings)).not.toContain("Agent hooks");
    expect(snapshot(root)).toEqual(before);
    // TokenLighten's own entries were not removed either.
    expect(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")).toContain("tl hook post-tool-use --client claude-code");
    expect(readFileSync(join(root, CODEX_HOOKS_FILE), "utf8")).toContain("tl hook pre-compact --client codex");
    // The default run that follows preserves the hand-edited file with a warning.
    const again = await setupJson([], root);
    expect(again.agentHooks?.warnings).toEqual([expect.stringContaining("edited by hand")]);
    expect(readFileSync(join(root, COPILOT_HOOKS_FILE), "utf8")).toBe('{"version":1,"hooks":{}}\n');
  }, 120000);

  it("--hooks behaves exactly like the default", async () => {
    const plain = fixture();
    const flagged = fixture();
    const byDefault = await setupJson([], plain);
    const explicit = await setupJson(["--hooks"], flagged);
    expect(portableReport(explicit)).toEqual(portableReport(byDefault));
    for (const file of HOOK_FILES) {
      expect(readFileSync(join(flagged, file), "utf8"), file).toBe(readFileSync(join(plain, file), "utf8"));
    }
    // And on a re-run it changes nothing either.
    const before = snapshot(flagged);
    await setupJson(["--hooks"], flagged);
    expect(snapshot(flagged)).toEqual(before);
  }, 120000);

  it("refuses more than one of --hooks, --no-hooks and --remove-hooks before writing anything", async () => {
    for (const pair of [["--hooks", "--remove-hooks"], ["--hooks", "--no-hooks"], ["--no-hooks", "--remove-hooks"]]) {
      const root = fixture();
      const { errors, exitCode } = await setupCli(["--clients", "claude-code", ...pair], root);
      expect(exitCode, pair.join(" ")).toBe(1);
      expect(errors).toContain("choose one of --hooks, --no-hooks, --remove-hooks");
      expect(existsSync(join(root, CLAUDE_HOOK_SETTINGS))).toBe(false);
      expect(existsSync(join(root, ".mcp.json"))).toBe(false);
    }
  });

  it("--remove-hooks takes TokenLighten's entries out and leaves the user's", async () => {
    const root = fixture();
    await setupJson(["--clients", "claude-code"], root);
    const settings = JSON.parse(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")) as { hooks: Record<string, unknown[]> };
    settings.hooks["Stop"] = [{ hooks: [{ type: "command", command: "say done" }] }];
    writeFileSync(join(root, CLAUDE_HOOK_SETTINGS), `${JSON.stringify(settings, null, 2)}\n`);
    const { printed, exitCode } = await setupCli(["--clients", "claude-code", "--remove-hooks"], root);
    expect(exitCode).toBe(0);
    expect(printed).toContain("Agent hooks (claude-code): removed from");
    expect(printed).not.toContain("--no-hooks skips them");
    expect(JSON.parse(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
  }, 60000);
});

describe("tl install: agent hook flags", () => {
  it("parses --hooks, --no-hooks and --remove-hooks; none of them is the default-on case", () => {
    expect(parseInstallArgs(["/ws"])).toMatchObject({ hooks: false, noHooks: false, removeHooks: false });
    expect(parseInstallArgs(["/ws", "--hooks"])).toMatchObject({ hooks: true, noHooks: false, removeHooks: false });
    expect(parseInstallArgs(["/ws", "--no-hooks"])).toMatchObject({ hooks: false, noHooks: true, removeHooks: false });
    expect(parseInstallArgs(["/ws", "--remove-hooks"])).toMatchObject({ hooks: false, noHooks: false, removeHooks: true });
    expect(parseInstallArgs(["/ws", "--no-hooks"]).workspaces).toEqual(["/ws"]);
  });
});
