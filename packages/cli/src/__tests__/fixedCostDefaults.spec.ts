import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { setupWorkspace } from "../commands/workspace.js";
import { buildClientSnippet } from "../commands/clients.js";
import { injectAll, renderCanonicalBlock } from "@tokenlighten/agents-md";

const roots: string[] = [];
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "tl-fixed-cost-defaults-"));
  roots.push(root);
  return root;
}
const launcher = { command: "tl", argsPrefix: [], env: {} };
const schemaStamp = () => "deadbeefcafef00d";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("fixed-cost defaults across client delivery paths", () => {
  for (const toolSurface of [undefined, "full", "code"] as const) {
    it(`delivers compact guidance and native startup settings (${toolSurface ?? "unset"})`, async () => {
      const root = repo();
      await setupWorkspace({ root, launcher, schemaStamp, toolSurface });
      const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
      expect(agents).toContain("## TokenLighten MCP (compact)");
      expect(agents).toContain("edit.state_unknown");
      expect(agents).toContain("create:true");
      expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
      const copilot = readFileSync(join(root, ".github/copilot-instructions.md"), "utf8");
      expect(copilot).toContain("# TokenLighten MCP - GitHub Copilot");
      expect(copilot).toContain("create:true");
      expect(copilot).toContain("edit.state_unknown");
      const vscode = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
      const claude = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
      const codex = parse(readFileSync(join(root, ".codex/config.toml"), "utf8")) as any;
      expect(claude.mcpServers.tokenlighten.alwaysLoad).toBe(true);
      expect(codex.mcp_optional_startup_grace_ms).toBe(0);
      for (const entry of [vscode.servers.tokenlighten, claude.mcpServers.tokenlighten, codex.mcp_servers.tokenlighten]) {
        expect(entry.env.MCP_CONNECTION_NONBLOCKING).toBeUndefined();
        expect(entry.env.TL_EFF_LIGHT_ANSWER).toBeUndefined();
        expect(entry.args.includes("--tool-surface")).toBe(toolSurface !== undefined);
      }
      expect(vscode.servers.tokenlighten.alwaysLoad).toBeUndefined();
      expect(codex.mcp_servers.tokenlighten.alwaysLoad).toBeUndefined();
    });
  }

  it("preserves explicit full guidance, client startup overrides and unrelated settings on repeat setup", async () => {
    const root = repo();
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex/config.toml"), 'mcp_optional_startup_grace_ms = 250\nmodel = "custom-model"\n');
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
      tokenlighten: { alwaysLoad: false }, other: { command: "other", alwaysLoad: true },
    } }));
    const options = { root, launcher, schemaStamp, guideProfile: "full" as const };
    await setupWorkspace(options);
    await setupWorkspace(options);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(renderCanonicalBlock());
    const claude = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(claude.mcpServers.tokenlighten.alwaysLoad).toBe(false);
    expect(claude.mcpServers.other).toEqual({ command: "other", alwaysLoad: true });
    const codex = parse(readFileSync(join(root, ".codex/config.toml"), "utf8"));
    expect(codex.mcp_optional_startup_grace_ms).toBe(250);
    expect(codex.model).toBe("custom-model");
  });

  it("emits client-specific startup defaults in manual registration snippets", () => {
    const options = { launcher: { ...launcher, source: "managed-shim" as const } };
    const claude = buildClientSnippet("claude-code", options);
    const codex = buildClientSnippet("codex", options);
    expect(claude.json).toMatchObject({ mcpServers: { tokenlighten: { alwaysLoad: true } } });
    expect(codex.json).toMatchObject({ mcp_optional_startup_grace_ms: 0 });
    const userCodex = buildClientSnippet("codex-user", options);
    expect(userCodex.toml).toMatch(/^mcp_optional_startup_grace_ms = 0\n\n\[mcp_servers\.tokenlighten\]/);
  });

  it("uses compact on generator/update paths and allows full or medium explicitly", async () => {
    const root = repo();
    await injectAll({ repoRoot: root, targets: [], driftMode: "auto-rewrite" });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("TokenLighten MCP (compact)");
    for (const profile of ["full", "medium"] as const) {
      await injectAll({ repoRoot: root, targets: [], profile, driftMode: "auto-rewrite" });
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(renderCanonicalBlock("en", undefined, profile));
    }
  });
});
