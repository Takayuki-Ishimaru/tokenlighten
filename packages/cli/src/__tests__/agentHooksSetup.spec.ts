/**
 * agentHooksSetup.spec.ts — the hook installer per client: merge without
 * overwriting user entries, idempotent re-runs, removal that leaves
 * user-owned entries alone, and no machine path where setup avoids one
 * (2026-11-03). Claude Code and Copilot get a post-tool-use hook (output
 * compression after the run) instead of the earlier pre-tool-use rewrite, and
 * a re-run replaces what an earlier install wrote.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_HOOKS_RECORD,
  CLAUDE_HOOK_SETTINGS,
  CODEX_HOOKS_FILE,
  COPILOT_HOOKS_FILE,
  installAgentHooks,
  isTokenLightenHookCommand,
  removeAgentHooks,
  renderHookCommand,
} from "../agentHooksSetup.js";

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tl-hooks-setup-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const TL = { command: "tl", argsPrefix: [] as string[] };
const read = (root: string, file: string): Record<string, unknown> => JSON.parse(readFileSync(join(root, file), "utf8")) as Record<string, unknown>;
const put = (root: string, file: string, body: string): void => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), body);
};

describe("Claude Code — .claude/settings.json", () => {
  it("writes PostToolUse (Bash), PreCompact and SessionStart with the documented shape, no PreToolUse and never an allow decision", () => {
    const root = fixture();
    const report = installAgentHooks(root, { clients: ["claude-code"], launcher: TL });
    expect(report.warnings).toEqual([]);
    expect(report.clients[0]).toMatchObject({ client: "claude-code", file: join(root, CLAUDE_HOOK_SETTINGS), events: ["PostToolUse", "PreCompact", "SessionStart"] });
    expect(report.clients[0]!.unsupported).toEqual([expect.stringContaining("PostToolUseFailure")]);
    const settings = read(root, CLAUDE_HOOK_SETTINGS) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> };
    expect(Object.keys(settings.hooks)).toEqual(["PostToolUse", "PreCompact", "SessionStart"]);
    expect(settings.hooks.PostToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "tl hook post-tool-use --client claude-code", timeout: 20 }] }]);
    expect(settings.hooks.PreCompact).toEqual([{ hooks: [{ type: "command", command: "tl hook pre-compact --client claude-code", timeout: 10 }] }]);
    expect(settings.hooks.SessionStart).toEqual([{ matcher: "clear|compact", hooks: [{ type: "command", command: "tl hook session-start --client claude-code", timeout: 10 }] }]);
    expect(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")).not.toContain("allow");
  });

  it("merges into an existing file, keeps user keys and user hooks, and is idempotent", () => {
    const root = fixture();
    const user = {
      permissions: { allow: ["Bash(npm test:*)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./scripts/audit.sh", timeout: 5 }] }],
        PreCompact: [{ hooks: [{ type: "command", command: "echo compacting" }] }],
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      },
    };
    put(root, CLAUDE_HOOK_SETTINGS, `${JSON.stringify(user, null, 4)}\n`);
    installAgentHooks(root, { clients: ["claude-code"], launcher: TL });
    const first = readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8");
    const settings = JSON.parse(first) as typeof user & { hooks: Record<string, unknown[]> };
    expect(settings.permissions).toEqual(user.permissions);
    expect(settings.hooks.PreToolUse).toEqual(user.hooks.PreToolUse);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PreCompact[0]).toEqual(user.hooks.PreCompact[0]);
    expect(settings.hooks.PreCompact).toHaveLength(2);
    expect(settings.hooks.Stop).toEqual(user.hooks.Stop);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    // The user's 4-space indentation is kept.
    expect(first).toContain('\n    "permissions"');
    installAgentHooks(root, { clients: ["claude-code"], launcher: TL });
    expect(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")).toBe(first);
    // A launcher change replaces TokenLighten's own group, still exactly one.
    installAgentHooks(root, { clients: ["claude-code"], launcher: { command: "${HOME}/.local/share/tokenlighten/bin/node", argsPrefix: ["${HOME}/.local/share/tokenlighten/bin/tl.js"] } });
    const upgraded = read(root, CLAUDE_HOOK_SETTINGS) as { hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(upgraded.hooks.PostToolUse).toHaveLength(1);
    expect(upgraded.hooks.PostToolUse[0]!.hooks[0]!.command)
      .toBe('"${HOME}/.local/share/tokenlighten/bin/node" "${HOME}/.local/share/tokenlighten/bin/tl.js" hook post-tool-use --client claude-code');
  });

  it("replaces the PreToolUse group an earlier install wrote with the PostToolUse group, keeps the user's, and is idempotent", () => {
    const root = fixture();
    const portable = '"${HOME}/.local/share/tokenlighten/bin/node" "${HOME}/.local/share/tokenlighten/bin/tl.js"';
    const earlier = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/audit.sh", timeout: 5 }] },
          { matcher: "Bash", hooks: [{ type: "command", command: `${portable} hook pre-tool-use --client claude-code`, timeout: 20 }] },
        ],
        PreCompact: [{ hooks: [{ type: "command", command: `${portable} hook pre-compact --client claude-code`, timeout: 10 }] }],
        SessionStart: [{ matcher: "clear|compact", hooks: [{ type: "command", command: `${portable} hook session-start --client claude-code`, timeout: 10 }] }],
      },
    };
    put(root, CLAUDE_HOOK_SETTINGS, `${JSON.stringify(earlier, null, 2)}\n`);
    expect(installAgentHooks(root, { clients: ["claude-code"], launcher: TL }).warnings).toEqual([]);
    const first = readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8");
    const settings = JSON.parse(first) as { permissions: unknown; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(settings.permissions).toEqual(earlier.permissions);
    expect(settings.hooks["PreToolUse"]).toEqual([earlier.hooks.PreToolUse[0]]);
    expect(settings.hooks["PostToolUse"]).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "tl hook post-tool-use --client claude-code", timeout: 20 }] }]);
    expect(first).not.toContain("pre-tool-use");
    expect(settings.hooks["PreCompact"]!.map((group) => group.hooks[0]!.command)).toEqual(["tl hook pre-compact --client claude-code"]);
    installAgentHooks(root, { clients: ["claude-code"], launcher: TL });
    expect(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")).toBe(first);
    // An earlier install alone: the PreToolUse key goes with its only group.
    const only = fixture();
    put(only, CLAUDE_HOOK_SETTINGS, JSON.stringify({ hooks: { PreToolUse: [earlier.hooks.PreToolUse[1]] } }));
    installAgentHooks(only, { clients: ["claude-code"], launcher: TL });
    expect(Object.keys((read(only, CLAUDE_HOOK_SETTINGS) as { hooks: Record<string, unknown> }).hooks)).toEqual(["PostToolUse", "PreCompact", "SessionStart"]);
  });

  it("removes only TokenLighten's entries and reports a file it emptied", () => {
    const root = fixture();
    put(root, CLAUDE_HOOK_SETTINGS, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }] }, model: "opus" }));
    installAgentHooks(root, { clients: ["claude-code"], launcher: TL });
    const removal = removeAgentHooks(root, ["claude-code"]);
    expect(removal.warnings).toEqual([]);
    expect(removal.emptied).toEqual([]);
    expect(read(root, CLAUDE_HOOK_SETTINGS)).toEqual({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }] }, model: "opus" });
    const fresh = fixture();
    installAgentHooks(fresh, { clients: ["claude-code"], launcher: TL });
    const emptiedRemoval = removeAgentHooks(fresh, ["claude-code"]);
    expect(emptiedRemoval.emptied).toEqual([join(fresh, CLAUDE_HOOK_SETTINGS)]);
    expect(read(fresh, CLAUDE_HOOK_SETTINGS)).toEqual({});
    expect(removeAgentHooks(fixture(), ["claude-code"])).toMatchObject({ action: "removed", warnings: [], emptied: [] });
  });

  it("preserves a file it cannot parse and says so", () => {
    const root = fixture();
    put(root, CLAUDE_HOOK_SETTINGS, "{ // jsonc\n}\n");
    const report = installAgentHooks(root, { clients: ["claude-code"], launcher: TL });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("claude-code hooks");
    expect(readFileSync(join(root, CLAUDE_HOOK_SETTINGS), "utf8")).toBe("{ // jsonc\n}\n");
  });
});

describe("Codex — .codex/hooks.json", () => {
  it("writes PreCompact and SessionStart only, merged with user groups, and removes cleanly", () => {
    const root = fixture();
    put(root, CODEX_HOOKS_FILE, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 policy.py", timeout: 30 }] }] } }, null, 2));
    const report = installAgentHooks(root, { clients: ["codex"], launcher: TL });
    expect(report.clients[0]).toMatchObject({ client: "codex", events: ["PreCompact", "SessionStart"] });
    expect(report.clients[0]!.unsupported[0]).toContain("command rewrite");
    const hooks = (read(root, CODEX_HOOKS_FILE) as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks.PreToolUse).toEqual([{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 policy.py", timeout: 30 }] }]);
    expect(hooks.PreCompact).toEqual([{ hooks: [{ type: "command", command: "tl hook pre-compact --client codex", timeout: 10 }] }]);
    expect(hooks.SessionStart).toEqual([{ matcher: "clear|compact", hooks: [{ type: "command", command: "tl hook session-start --client codex", timeout: 10 }] }]);
    const before = readFileSync(join(root, CODEX_HOOKS_FILE), "utf8");
    installAgentHooks(root, { clients: ["codex"], launcher: TL });
    expect(readFileSync(join(root, CODEX_HOOKS_FILE), "utf8")).toBe(before);
    removeAgentHooks(root, ["codex"]);
    expect(read(root, CODEX_HOOKS_FILE)).toEqual({ hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "python3 policy.py", timeout: 30 }] }] } });
  });
});

describe("Copilot CLI / VS Code — .github/hooks/tokenlighten-hooks.json", () => {
  it("writes its own flat file (postToolUse, no preToolUse) with bash and powershell forms that always exit 0, and records ownership", () => {
    const root = fixture();
    put(root, ".github/hooks/user.json", '{"version":1,"hooks":{"sessionStart":[]}}');
    const report = installAgentHooks(root, { clients: ["vscode"], launcher: TL });
    expect(report.warnings).toEqual([]);
    expect(report.clients[0]).toMatchObject({ client: "vscode", file: join(root, COPILOT_HOOKS_FILE), events: ["postToolUse", "preCompact", "sessionStart"] });
    const file = read(root, COPILOT_HOOKS_FILE) as { version: number; hooks: Record<string, Array<Record<string, unknown>>> };
    expect(file.version).toBe(1);
    expect(Object.keys(file.hooks)).toEqual(["postToolUse", "preCompact", "sessionStart"]);
    expect(file.hooks.postToolUse).toEqual([{
      type: "command",
      matcher: "bash|powershell|run_in_terminal",
      bash: "tl hook post-tool-use --client copilot || exit 0",
      powershell: "tl hook post-tool-use --client copilot; exit 0",
      timeoutSec: 20,
    }]);
    expect(readFileSync(join(root, COPILOT_HOOKS_FILE), "utf8")).not.toContain("pre-tool-use");
    expect(file.hooks.preCompact[0]).toMatchObject({ bash: "tl hook pre-compact --client copilot || exit 0", timeoutSec: 10 });
    expect(file.hooks.sessionStart[0]).toMatchObject({ bash: "tl hook session-start --client copilot || exit 0" });
    expect(readFileSync(join(root, COPILOT_HOOKS_FILE), "utf8")).not.toContain("permissionDecision");
    expect(existsSync(join(root, AGENT_HOOKS_RECORD))).toBe(true);
    const before = readFileSync(join(root, COPILOT_HOOKS_FILE), "utf8");
    installAgentHooks(root, { clients: ["vscode"], launcher: TL });
    expect(readFileSync(join(root, COPILOT_HOOKS_FILE), "utf8")).toBe(before);
    expect(readFileSync(join(root, ".github/hooks/user.json"), "utf8")).toBe('{"version":1,"hooks":{"sessionStart":[]}}');
    expect(removeAgentHooks(root, ["vscode"]).warnings).toEqual([]);
    expect(existsSync(join(root, COPILOT_HOOKS_FILE))).toBe(false);
    expect(existsSync(join(root, AGENT_HOOKS_RECORD))).toBe(false);
    expect(readFileSync(join(root, ".github/hooks/user.json"), "utf8")).toBe('{"version":1,"hooks":{"sessionStart":[]}}');
  });

  it("preserves a hand-edited or foreign file with a warning, on install and on removal", () => {
    const root = fixture();
    installAgentHooks(root, { clients: ["vscode"], launcher: TL });
    writeFileSync(join(root, COPILOT_HOOKS_FILE), '{"version":1,"hooks":{}}\n');
    const report = installAgentHooks(root, { clients: ["vscode"], launcher: TL });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("edited by hand");
    expect(readFileSync(join(root, COPILOT_HOOKS_FILE), "utf8")).toBe('{"version":1,"hooks":{}}\n');
    const removal = removeAgentHooks(root, ["vscode"]);
    expect(removal.warnings).toHaveLength(1);
    expect(existsSync(join(root, COPILOT_HOOKS_FILE))).toBe(true);
    const foreign = fixture();
    put(foreign, COPILOT_HOOKS_FILE, "{}");
    expect(installAgentHooks(foreign, { clients: ["vscode"], launcher: TL }).warnings[0]).toContain("preserved");
    expect(readFileSync(join(foreign, COPILOT_HOOKS_FILE), "utf8")).toBe("{}");
  });

  it("updates an owned file when the rendering changes (upgrade), without touching other hook files", () => {
    const root = fixture();
    installAgentHooks(root, { clients: ["vscode"], launcher: TL });
    const portable = { command: "${LOCALAPPDATA}\\tokenlighten\\bin\\node.exe", argsPrefix: ["${LOCALAPPDATA}\\tokenlighten\\bin\\tl.js"] };
    expect(installAgentHooks(root, { clients: ["vscode"], launcher: portable }).warnings).toEqual([]);
    const entry = (read(root, COPILOT_HOOKS_FILE) as { hooks: { postToolUse: Array<{ bash: string; powershell: string }> } }).hooks.postToolUse[0]!;
    expect(entry.bash).toBe('"${LOCALAPPDATA}/tokenlighten/bin/node.exe" "${LOCALAPPDATA}/tokenlighten/bin/tl.js" hook post-tool-use --client copilot || exit 0');
    expect(entry.powershell).toBe('& "$env:LOCALAPPDATA/tokenlighten/bin/node.exe" "$env:LOCALAPPDATA/tokenlighten/bin/tl.js" hook post-tool-use --client copilot; exit 0');
    expect(removeAgentHooks(root, ["vscode"]).warnings).toEqual([]);
    expect(existsSync(join(root, COPILOT_HOOKS_FILE))).toBe(false);
  });

  it("replaces a setup-owned file from the earlier preToolUse rendering, and is idempotent afterwards", () => {
    const root = fixture();
    const entry = (event: string, timeoutSec: number, matcher?: string): Record<string, unknown> => ({
      type: "command",
      ...(matcher !== undefined ? { matcher } : {}),
      bash: `tl hook ${event} --client copilot || exit 0`,
      powershell: `tl hook ${event} --client copilot; exit 0`,
      timeoutSec,
    });
    // Exactly what setup wrote before 2026-11-03, recorded as setup-owned.
    const earlier = `${JSON.stringify({ version: 1, hooks: {
      preToolUse: [entry("pre-tool-use", 20, "bash|powershell|run_in_terminal")],
      preCompact: [entry("pre-compact", 10)],
      sessionStart: [entry("session-start", 10)],
    } }, null, 2)}\n`;
    put(root, COPILOT_HOOKS_FILE, earlier);
    put(root, AGENT_HOOKS_RECORD, JSON.stringify({ schemaVersion: 1, files: { [COPILOT_HOOKS_FILE]: createHash("sha256").update(earlier).digest("hex") } }));
    const report = installAgentHooks(root, { clients: ["vscode"], launcher: TL });
    expect(report.warnings).toEqual([]);
    const file = read(root, COPILOT_HOOKS_FILE) as { hooks: Record<string, Array<Record<string, unknown>>> };
    expect(Object.keys(file.hooks)).toEqual(["postToolUse", "preCompact", "sessionStart"]);
    expect(file.hooks["postToolUse"]![0]).toMatchObject({ bash: "tl hook post-tool-use --client copilot || exit 0", matcher: "bash|powershell|run_in_terminal" });
    const after = readFileSync(join(root, COPILOT_HOOKS_FILE), "utf8");
    expect(installAgentHooks(root, { clients: ["vscode"], launcher: TL }).warnings).toEqual([]);
    expect(readFileSync(join(root, COPILOT_HOOKS_FILE), "utf8")).toBe(after);
    // The record now names the new rendering, so removal still recognises the file as setup's.
    expect(removeAgentHooks(root, ["vscode"]).warnings).toEqual([]);
    expect(existsSync(join(root, COPILOT_HOOKS_FILE))).toBe(false);
  });
});

describe("command rendering and ownership test", () => {
  it("renders the launcher the way .mcp.json names it, with no machine path for a portable identity", () => {
    expect(renderHookCommand(TL, "pre-compact", "codex")).toEqual({ bash: "tl hook pre-compact --client codex", powershell: "tl hook pre-compact --client codex" });
    const posix = renderHookCommand({ command: "${HOME}/.local/share/tokenlighten/bin/node", argsPrefix: ["${HOME}/.local/share/tokenlighten/bin/tl.js"] }, "session-start", "claude-code");
    expect(posix.bash).toBe('"${HOME}/.local/share/tokenlighten/bin/node" "${HOME}/.local/share/tokenlighten/bin/tl.js" hook session-start --client claude-code');
    expect(posix.powershell).toBe('& "$env:HOME/.local/share/tokenlighten/bin/node" "$env:HOME/.local/share/tokenlighten/bin/tl.js" hook session-start --client claude-code');
    const spaced = renderHookCommand({ command: "C:\\Program Files\\nodejs\\node.exe", argsPrefix: ["C:\\tl\\bin\\tl.js"] }, "pre-tool-use", "copilot");
    expect(spaced.bash).toBe('"C:/Program Files/nodejs/node.exe" C:/tl/bin/tl.js hook pre-tool-use --client copilot');
    expect(spaced.powershell).toBe("& 'C:/Program Files/nodejs/node.exe' C:/tl/bin/tl.js hook pre-tool-use --client copilot");
  });

  it("recognises exactly TokenLighten's hook commands", () => {
    expect(isTokenLightenHookCommand("tl hook pre-tool-use --client claude-code")).toBe(true);
    expect(isTokenLightenHookCommand("tl hook post-tool-use --client claude-code")).toBe(true);
    expect(isTokenLightenHookCommand('"${LOCALAPPDATA}/tokenlighten/bin/node.exe" "${LOCALAPPDATA}/tokenlighten/bin/tl.js" hook post-tool-use --client copilot || exit 0')).toBe(true);
    expect(isTokenLightenHookCommand('"${HOME}/x/bin/node" "${HOME}/x/bin/tl.js" hook pre-compact --client codex')).toBe(true);
    expect(isTokenLightenHookCommand("tl hook session-start --client copilot || exit 0")).toBe(true);
    expect(isTokenLightenHookCommand("./scripts/tl-audit.sh hook pre-tool-use")).toBe(false);
    expect(isTokenLightenHookCommand("tl run -- npm test")).toBe(false);
    expect(isTokenLightenHookCommand("tl hook something-else")).toBe(false);
    expect(isTokenLightenHookCommand(42)).toBe(false);
  });
});
