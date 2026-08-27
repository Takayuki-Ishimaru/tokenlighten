import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";
import {
  listWorkspaces,
  recordWorkspaceSetup,
  runWorkspace,
  setupWorkspace,
  workspacePathsEqual,
  workspaceStatus,
} from "../commands/workspace.js";

describe("workspace setup", () => {
  it("creates rules and full-access MCP settings for every supported app", async () => {
    const root = join(tmpdir(), `tokenlighten-setup-${randomUUID()}`);
    mkdirSync(join(root, ".vscode"), { recursive: true });
    writeFileSync(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { existing: { command: "existing" } } }),
    );

    const result = await setupWorkspace({
      root,
      clients: ["vscode", "codex", "claude-code"],
    });

    expect(result).toMatchObject({
      clients: ["vscode", "codex", "claude-code"],
      writeEnabled: true,
      usageLoggingEnabled: true,
    });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
      "TokenLighten MCP",
    );
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain(
      "tokenlighten",
    );
    expect(
      readFileSync(join(root, ".github", "copilot-instructions.md"), "utf8"),
    ).toContain("tokenlighten");

    const vscode = JSON.parse(
      readFileSync(join(root, ".vscode", "mcp.json"), "utf8"),
    ) as {
      servers: Record<string, { args: string[]; env: Record<string, string> }>;
    };
    expect(vscode.servers["existing"]).toBeDefined();
    expect(vscode.servers["tokenlighten"]).toMatchObject({
      args: [
        "mcp",
        "start",
        "--stdio",
        "--allow-write",
        "--workspace",
        result.workspaceRoot,
      ],
      env: {
        TOKENLIGHTEN_CLIENT: "vscode",
        TOKENLIGHTEN_USAGE_LOG: "on",
      },
    });

    const claude = JSON.parse(
      readFileSync(join(root, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { type: string; args: string[] }>;
    };
    expect(claude.mcpServers["tokenlighten"]).toMatchObject({
      type: "stdio",
      args: [
        "mcp",
        "start",
        "--stdio",
        "--allow-write",
        "--workspace",
        result.workspaceRoot,
      ],
    });

    const codex = parse(
      readFileSync(join(root, ".codex", "config.toml"), "utf8"),
    ) as {
      mcp_servers: Record<string, {
        args: string[];
        enabled: boolean;
        env: Record<string, string>;
      }>;
    };
    expect(codex.mcp_servers["tokenlighten"]).toMatchObject({
      args: [
        "mcp",
        "start",
        "--stdio",
        "--allow-write",
        "--workspace",
        result.workspaceRoot,
      ],
      enabled: true,
      env: {
        TOKENLIGHTEN_CLIENT: "codex",
        TOKENLIGHTEN_USAGE_LOG: "on",
      },
    });
  });

  it("repairs stale managed rules and MCP settings when setup is rerun", async () => {
    const root = join(tmpdir(), `tokenlighten-repair-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    await setupWorkspace({ root, clients: ["vscode"] });

    writeFileSync(join(root, "AGENTS.md"), "stale rules\n");
    writeFileSync(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify({
        servers: {
          existing: { command: "existing" },
          tokenlighten: { command: "broken", args: [] },
        },
      }),
    );

    const result = await setupWorkspace({ root, clients: ["vscode"] });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("TokenLighten MCP");
    const vscode = JSON.parse(
      readFileSync(join(root, ".vscode", "mcp.json"), "utf8"),
    ) as { servers: Record<string, { command: string; args: string[] }> };
    expect(vscode.servers["existing"]).toBeDefined();
    expect(vscode.servers["tokenlighten"]).toMatchObject({
      command: "tl",
      args: [
        "mcp",
        "start",
        "--stdio",
        "--allow-write",
        "--workspace",
        result.workspaceRoot,
      ],
    });
  });

  it("supports rules-only setup for the VS Code definition provider", async () => {
    const root = join(tmpdir(), `tokenlighten-rules-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const result = await setupWorkspace({ root, rulesOnly: true });
    expect(result.clients).toEqual([]);
    expect(result.configFilesWritten).toEqual([]);
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(root, ".github", "copilot-instructions.md"))).toBe(true);
    expect(existsSync(join(root, ".vscode", "mcp.json"))).toBe(false);
  });

  it("records and lists every desktop-managed workspace without duplicates", () => {
    const registryRoot = join(
      tmpdir(),
      `tokenlighten-workspace-registry-${randomUUID()}`,
    );
    const registryPath = join(registryRoot, "config.toml");
    const firstRoot = join(registryRoot, "a");
    const secondRoot = join(registryRoot, "b");

    recordWorkspaceSetup({
      schemaVersion: 1,
      workspaceRoot: secondRoot,
      clients: ["vscode"],
      writeEnabled: true,
      usageLoggingEnabled: true,
      rulesWritten: [],
      configFilesWritten: [join(secondRoot, ".vscode", "mcp.json")],
      warnings: [],
    }, registryPath, "2026-08-10T01:00:00.000Z");
    recordWorkspaceSetup({
      schemaVersion: 1,
      workspaceRoot: firstRoot,
      clients: ["codex", "claude-code"],
      writeEnabled: true,
      usageLoggingEnabled: true,
      rulesWritten: [],
      configFilesWritten: [join(firstRoot, ".codex", "config.toml")],
      warnings: [],
    }, registryPath, "2026-08-10T02:00:00.000Z");
    recordWorkspaceSetup({
      schemaVersion: 1,
      workspaceRoot: secondRoot,
      clients: ["vscode", "codex"],
      writeEnabled: true,
      usageLoggingEnabled: true,
      rulesWritten: [],
      configFilesWritten: [join(secondRoot, ".vscode", "mcp.json")],
      warnings: [],
    }, registryPath, "2026-08-10T03:00:00.000Z");

    expect(listWorkspaces(registryPath)).toEqual({
      schemaVersion: 1,
      workspaces: [
        expect.objectContaining({
          workspaceRoot: firstRoot,
          clients: ["codex", "claude-code"],
        }),
        expect.objectContaining({
          workspaceRoot: secondRoot,
          clients: ["vscode", "codex"],
          updatedAt: "2026-08-10T03:00:00.000Z",
        }),
      ],
    });
  });

  it("requires registry and VS Code config write/usage settings to match", async () => {
    const registryRoot = join(
      tmpdir(),
      `tokenlighten-workspace-status-${randomUUID()}`,
    );
    const registryPath = join(registryRoot, "config.toml");
    const root = join(registryRoot, "workspace");
    mkdirSync(root, { recursive: true });
    const setup = await setupWorkspace({ root, clients: ["vscode"] });
    recordWorkspaceSetup(setup, registryPath);

    expect(workspaceStatus(root, registryPath)).toMatchObject({
      workspaceRoot: setup.workspaceRoot,
      configured: true,
      reason: "ready",
      writeEnabled: true,
      usageLoggingEnabled: true,
    });

    const vscodePath = join(root, ".vscode", "mcp.json");
    const document = JSON.parse(readFileSync(vscodePath, "utf8")) as {
      servers: {
        tokenlighten: { args: string[]; env: Record<string, string> };
      };
    };
    document.servers.tokenlighten.args =
      document.servers.tokenlighten.args.filter((arg) => arg !== "--allow-write");
    writeFileSync(vscodePath, JSON.stringify(document));
    expect(workspaceStatus(root, registryPath)).toMatchObject({
      configured: false,
      reason: "vscode-config-invalid",
    });

    document.servers.tokenlighten.env["TOKENLIGHTEN_USAGE_LOG"] = "off";
    writeFileSync(vscodePath, JSON.stringify(document));
    recordWorkspaceSetup({
      ...setup,
      writeEnabled: false,
      usageLoggingEnabled: false,
    }, registryPath);
    expect(workspaceStatus(root, registryPath)).toMatchObject({
      configured: true,
      reason: "ready",
      writeEnabled: false,
      usageLoggingEnabled: false,
    });
  });

  it("reports whether the CLAUDE.md managed guide block is present", async () => {
    const registryRoot = join(
      tmpdir(),
      `tokenlighten-workspace-guide-${randomUUID()}`,
    );
    const registryPath = join(registryRoot, "config.toml");
    const root = join(registryRoot, "workspace");
    mkdirSync(root, { recursive: true });
    const setup = await setupWorkspace({ root, clients: ["vscode"] });
    recordWorkspaceSetup(setup, registryPath);

    expect(workspaceStatus(root, registryPath)).toMatchObject({
      configured: true,
      reason: "ready",
      guidePresent: true,
    });

    writeFileSync(join(root, "CLAUDE.md"), "# No managed guide here\n");
    expect(workspaceStatus(root, registryPath)).toMatchObject({
      configured: true,
      reason: "ready",
      guidePresent: false,
    });
  });

  it("compares canonical Windows workspace paths case-insensitively", () => {
    expect(workspacePathsEqual(
      "C:\\Users\\Example\\Workspace",
      "c:\\users\\example\\workspace\\",
      "win32",
    )).toBe(true);
    expect(workspacePathsEqual(
      "C:\\Users\\Example\\Workspace",
      "C:\\Users\\Example\\Other",
      "win32",
    )).toBe(false);
  });

  it("emits an exact machine-readable warning when registry recording fails", async () => {
    const root = join(tmpdir(), `tokenlighten-workspace-warning-${randomUUID()}`);
    const registryBlocker = join(root, "registry-blocker");
    const registryPath = join(registryBlocker, "config.toml");
    mkdirSync(root, { recursive: true });
    writeFileSync(registryBlocker, "not a directory\n");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await runWorkspace([
        "setup",
        "--root",
        root,
        "--rules-only",
        "--json",
      ], {
        registryPath,
        launcher: { command: "tl", argsPrefix: [], env: {} },
      });

      expect(stdout).toHaveBeenCalledTimes(1);
      const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as {
        schemaVersion: number;
        workspaceRoot: string;
        warnings: unknown[];
      };
      expect(output).toMatchObject({
        schemaVersion: 1,
        workspaceRoot: realpathSync(root),
      });
      expect(output.warnings).toEqual([{
        code: "workspace-registry-write-failed",
        target: registryPath,
        recovery: "Fix registry access, then rerun 'tl workspace setup' for this workspace.",
      }]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
        "setup succeeded but the workspace registry was not updated",
      ));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("reports the verified launcher build in JSON setup output", async () => {
    const root = join(tmpdir(), "tokenlighten-self-check-" + randomUUID());
    mkdirSync(root, { recursive: true });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runWorkspace([
        "setup", "--root", root, "--clients", "vscode", "--json",
      ], {
        registryPath: join(root, "registry.toml"),
        launcher: { command: "verified-tl", argsPrefix: [], env: {} },
        versionCheck: () => "0.11.1+6447649a",
      });
      const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as { server_build?: string };
      expect(output.server_build).toBe("0.11.1+6447649a");
    } finally {
      stdout.mockRestore();
    }
  });

  it("preserves registry entries this build cannot parse", () => {
    const registryRoot = join(
      tmpdir(),
      `tokenlighten-workspace-passthrough-${randomUUID()}`,
    );
    mkdirSync(registryRoot, { recursive: true });
    const registryPath = join(registryRoot, "config.toml");
    writeFileSync(registryPath, [
      "[[workspaces.entries]]",
      'workspaceRoot = "/future-workspace"',
      "schemaVersion = 99",
      'futureField = "preserve-me"',
      "[workspaces.entries.future]",
      'mode = "opaque"',
      "",
    ].join("\n"));

    recordWorkspaceSetup({
      schemaVersion: 1,
      workspaceRoot: join(registryRoot, "known"),
      clients: ["vscode"],
      writeEnabled: true,
      usageLoggingEnabled: true,
      rulesWritten: [],
      configFilesWritten: [],
      warnings: [],
    }, registryPath, "2026-08-11T00:00:00.000Z");

    const stored = parse(readFileSync(registryPath, "utf8")) as {
      workspaces: { entries: Array<Record<string, unknown>> };
    };
    const future = stored.workspaces.entries.find(
      (entry) => entry["workspaceRoot"] === "/future-workspace",
    );
    expect(future).toEqual({
      workspaceRoot: "/future-workspace",
      schemaVersion: 99,
      futureField: "preserve-me",
      future: { mode: "opaque" },
    });
    expect(
      stored.workspaces.entries.map((entry) => entry["workspaceRoot"]),
    ).toContain(join(registryRoot, "known"));
    expect(
      listWorkspaces(registryPath).workspaces.map((entry) => entry.workspaceRoot),
    ).toEqual([join(registryRoot, "known")]);
  });
});
