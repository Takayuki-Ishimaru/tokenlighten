import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { setupWorkspace, runWorkspace, recordWorkspaceSetup, listWorkspaces, workspaceStatus } from "../commands/workspace.js";
import type { TokenLightenSetupClient } from "@tokenlighten/types";

const roots: string[] = [];
const clients: TokenLightenSetupClient[] = ["vscode", "claude-code", "codex"];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tl-permission1012-"));
  roots.push(root);
  return root;
}
function posture(root: string) {
  const vscode = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
  const claude = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  const codex = parse(readFileSync(join(root, ".codex/config.toml"), "utf8")) as any;
  return [vscode.servers.tokenlighten.args, claude.mcpServers.tokenlighten.args, codex.mcp_servers.tokenlighten.args]
    .map((args: string[]) => args.includes("--allow-write"));
}

describe("workspace setup preserves each client's write permission", () => {
  it.each([{ tail: [] }, { tail: [""] }, { tail: ["--json"] }])("rejects a missing or empty --clients value $tail before writing configuration", async ({ tail }) => {
    const root = fixture();
    const previousExitCode = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const versionCheck = vi.fn(() => "test");
    try {
      process.exitCode = undefined;
      await runWorkspace(["setup", "--root", root, "--clients", ...tail], {
        registryPath: join(root, "registry.toml"), installHome: join(root, "install"),
        launcher: { command: "tl", argsPrefix: [], env: {} }, versionCheck,
      });
      expect(process.exitCode).toBe(1);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--clients requires a value"));
      expect(versionCheck).not.toHaveBeenCalled();
      for (const file of [".vscode/mcp.json", ".mcp.json", ".codex/config.toml", "AGENTS.md", "registry.toml"]) {
        expect(existsSync(join(root, file))).toBe(false);
      }
    } finally {
      stderr.mockRestore(); stdout.mockRestore(); process.exitCode = previousExitCode;
    }
  });

  it("preserves the exact three-client CLI read-only choice on a flagless update and allows explicit re-enable", async () => {
    const root = fixture();
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
    const opts = { registryPath: join(root, "registry.toml"), installHome: join(root, "install"),
      launcher: { command: "tl", argsPrefix: [], env: {} }, versionCheck: () => "test" };
    try {
      await runWorkspace(["setup", "--root", root, "--clients", clients.join(","), "--read-only", "--json"], opts);
      expect(posture(root)).toEqual([false, false, false]);
      output = "";
      await runWorkspace(["setup", "--root", root, "--clients", clients.join(","), "--json"], opts);
      expect(JSON.parse(output).writeEnabled).toBe(false);
      expect(posture(root)).toEqual([false, false, false]);
      output = "";
      await runWorkspace(["setup", "--root", root, "--clients", clients.join(","), "--allow-write", "--json"], opts);
      expect(JSON.parse(output).writeEnabled).toBe(true);
      expect(posture(root)).toEqual([true, true, true]);
    } finally { stdout.mockRestore(); }
  });

  it("keeps the first-install write default, then preserves mixed client choices", async () => {
    const root = fixture();
    const initial = await setupWorkspace({ root, clients, schemaStamp: () => undefined });
    expect(initial.writeEnabled).toBe(true);
    expect(posture(root)).toEqual([true, true, true]);
    await setupWorkspace({ root, clients: ["codex"], writeEnabled: false, schemaStamp: () => undefined });
    const updated = await setupWorkspace({ root, clients, schemaStamp: () => undefined });
    expect(posture(root)).toEqual([true, true, false]);
    expect(updated.writeEnabled).toBe(false);
    expect(updated.writeEnabledByClient).toEqual({ vscode: true, "claude-code": true, codex: false });
  });

  it("uses the first-install default for a new client without changing an existing read-only client", async () => {
    const root = fixture();
    await setupWorkspace({ root, clients: ["codex"], writeEnabled: false, schemaStamp: () => undefined });
    await setupWorkspace({ root, clients, schemaStamp: () => undefined });
    expect(posture(root)).toEqual([true, true, false]);
  });

  it.each(["vscode", "codex"] as const)("retains mixed permissions in the registry and validates VS Code when %s is read-only", async readOnlyClient => {
    const root = fixture();
    const registryPath = join(root, "registry.toml");
    await setupWorkspace({ root, clients, schemaStamp: () => undefined });
    await setupWorkspace({ root, clients: [readOnlyClient], writeEnabled: false, schemaStamp: () => undefined });
    const updated = await setupWorkspace({ root, clients, schemaStamp: () => undefined });
    recordWorkspaceSetup(updated, registryPath);
    // Recording another workspace must preserve this entry's client map.
    recordWorkspaceSetup({ ...updated, workspaceRoot: fixture() }, registryPath);
    const registered = listWorkspaces(registryPath).workspaces.find(entry => entry.workspaceRoot === updated.workspaceRoot)!;
    expect(registered.writeEnabled).toBe(false);
    expect(registered.writeEnabledByClient).toEqual(updated.writeEnabledByClient);
    expect(workspaceStatus(root, registryPath)).toMatchObject({
      configured: true, reason: "ready", writeEnabled: readOnlyClient !== "vscode",
    });
  });

  it("leaves MCP permissions and settings untouched for rules-only", async () => {
    const root = fixture();
    await setupWorkspace({ root, clients, writeEnabled: false, schemaStamp: () => undefined });
    const files = [".vscode/mcp.json", ".mcp.json", ".codex/config.toml"];
    const before = files.map(file => readFileSync(join(root, file), "utf8"));
    await setupWorkspace({ root, clients, rulesOnly: true, writeEnabled: true });
    expect(files.map(file => readFileSync(join(root, file), "utf8"))).toEqual(before);
  });

  it("repairs a legacy entry with only startup settings without inferring a write grant", async () => {
    const root = fixture();
    writeFileSync(join(root, ".mcp.json"), '{"mcpServers":{"tokenlighten":{"alwaysLoad":false}}}');
    const result = await setupWorkspace({ root, clients: ["claude-code"], schemaStamp: () => undefined });
    const config = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.tokenlighten;
    expect(config.alwaysLoad).toBe(false);
    expect(config.args).not.toContain("--allow-write");
    expect(result.writeEnabled).toBe(false);
  });

  it.each(["malformed-json", "invalid-args"])("fails before changing any settings or rules for %s", async shape => {
    const root = fixture();
    await setupWorkspace({ root, clients, writeEnabled: false, schemaStamp: () => undefined });
    const damaged = shape === "malformed-json" ? "{" : '{"mcpServers":{"tokenlighten":{"args":[42]}}}';
    writeFileSync(join(root, ".mcp.json"), damaged);
    const files = [".vscode/mcp.json", ".mcp.json", ".codex/config.toml", "AGENTS.md"];
    const before = files.map(file => readFileSync(join(root, file), "utf8"));
    await expect(setupWorkspace({ root, clients, schemaStamp: () => undefined })).rejects.toThrow();
    expect(files.map(file => readFileSync(join(root, file), "utf8"))).toEqual(before);
    expect(existsSync(join(root, ".mcp.json"))).toBe(true);
  });
});
