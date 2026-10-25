import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { setupWorkspace, currentMcpSchemaStamp } from "../commands/workspace.js";
import { renderPortableCodeBlock } from "@tokenlighten/agents-md";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const launcher = { command: "tl", argsPrefix: [], env: { KEEP_ME: "yes" } };
function entries(root: string): any[] {
  return [JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8")).servers.tokenlighten,
    JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.tokenlighten,
    (parse(readFileSync(join(root, ".codex/config.toml"), "utf8")) as any).mcp_servers.tokenlighten];
}
describe("portable workspace setup", () => {
  it("delivers the shared guide and gate to all three clients, preserving read-only permissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "tl-portable-setup-")); roots.push(root);
    const options = { root, launcher, schemaStamp: () => "deadbeefcafef00d", guideProfile: "portable" as const, toolSurface: "code" as const, writeEnabled: false };
    await setupWorkspace(options);
    for (const entry of entries(root)) {
      expect(entry.env.TL_PORTABLE_TOOLS).toBe("1");
      expect(entry.env.KEEP_ME).toBe("yes");
      expect(entry.args).not.toContain("--allow-write");
    }
    const guide = renderPortableCodeBlock();
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(guide);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(readFileSync(join(root, ".github/copilot-instructions.md"), "utf8")).toContain(guide);
    const agent = readFileSync(join(root, ".github/agents/tokenlighten-explore.agent.md"), "utf8");
    expect(agent).toContain("No writes, shell, or subagents");
    expect(agent).not.toContain("tokenlighten/tl_edit_file");
    const repeated = await setupWorkspace(options);
    expect(repeated.rulesWritten).toEqual([]);
    expect(readdirSync(root).some(file => file.includes(".bak"))).toBe(false);
    expect(launcher.env).toEqual({ KEEP_ME: "yes" });
    await setupWorkspace({ root, launcher, schemaStamp: () => "deadbeefcafef00d", guideProfile: "compact", toolSurface: "code" });
    for (const entry of entries(root)) {
      expect(entry.env.TL_PORTABLE_TOOLS).toBeUndefined();
      expect(entry.args).not.toContain("--allow-write");
    }
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("MCP (compact)");
  });
  it("stamps the actual portable schema rather than a cached default schema", () => {
    const normal = currentMcpSchemaStamp("code");
    const portable = currentMcpSchemaStamp("code", true);
    expect(normal).toMatch(/^[a-f0-9]{16}$/);
    expect(portable).toMatch(/^[a-f0-9]{16}$/);
    expect(portable).not.toBe(normal);
  });
});
