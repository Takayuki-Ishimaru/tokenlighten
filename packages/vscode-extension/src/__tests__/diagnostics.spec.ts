/**
 * diagnostics.spec.ts — the pure data-collection function behind the
 * "TokenLighten: Diagnostics" view. Exercised with real temp-directory
 * workspaces (no vscode mock needed — this module never imports vscode).
 * cli.js is mocked so tlVersion/serverLaunch come from a fixed stub instead
 * of a real `tl --version` subprocess spawn (cli.spec.ts already covers
 * that boundary).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { INSTRUCTIONS_VERSION } from "@tokenlighten/agents-md/version";
import { SENTINEL_END, SENTINEL_START } from "@tokenlighten/agents-md/sentinel";
import { recordDiagCall } from "@tokenlighten/usage/diag";

vi.mock("../cli.js", () => ({
  getTlVersion: () => "9.9.9-mock",
  getMcpLaunchConfig: (args: string[]) => ({ command: "mock-tl", args, env: {} }),
}));

import { collectDiagnostics, formatDiagnosticsText } from "../diagnostics.js";

function tmpWorkspace(prefix = "diagctx"): string {
  const dir = join(tmpdir(), `tokenlighten-${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function guideBlock(version: string): string {
  return `${SENTINEL_START}\n<!-- tl-instructions-version: ${version} -->\n# Guide\n${SENTINEL_END}\n`;
}

describe("collectDiagnostics — core fields", () => {
  it("reports extension/tl/node/server-launch fields from the given workspace root", () => {
    const root = tmpWorkspace();
    const snapshot = collectDiagnostics({
      extensionVersion: "1.2.3",
      workspaceRoot: root,
      writeEnabledSetting: true,
      usageLoggingEnabledSetting: null,
    });
    expect(snapshot.extensionVersion).toBe("1.2.3");
    expect(snapshot.tlVersion).toBe("9.9.9-mock");
    expect(snapshot.nodeExecutable).toBe(process.execPath);
    expect(snapshot.serverLaunch).toEqual({
      command: "mock-tl",
      args: ["mcp", "start", "--stdio", "--allow-write"],
    });
    expect(snapshot.workspaceRoot).toBe(root);
  });

  it("resolves the launch args without --allow-write when the workspace write setting is off or unknown", () => {
    const root = tmpWorkspace();
    for (const writeEnabledSetting of [false, null] as const) {
      const snapshot = collectDiagnostics({
        extensionVersion: "1.0.0",
        workspaceRoot: root,
        writeEnabledSetting,
        usageLoggingEnabledSetting: null,
      });
      expect(snapshot.serverLaunch.args).not.toContain("--allow-write");
      expect(snapshot.writeEnabledSetting).toBe(writeEnabledSetting);
    }
  });
});

describe("collectDiagnostics — registration detection", () => {
  it("reports each of .mcp.json / .vscode/mcp.json / .codex/config.toml independently, including --allow-write", () => {
    const root = tmpWorkspace();
    mkdirSync(join(root, ".vscode"), { recursive: true });
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          tokenlighten: { command: "tl", args: ["mcp", "start", "--stdio", "--allow-write"] },
        },
      }),
    );
    writeFileSync(
      join(root, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { tokenlighten: { command: "tl", args: ["mcp", "start", "--stdio"] } } }),
    );
    // .codex/config.toml intentionally absent.

    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: true,
      usageLoggingEnabledSetting: null,
    });

    expect(snapshot.registrations.claudeMcpJson).toEqual({
      path: join(root, ".mcp.json"),
      fileExists: true,
      hasTokenlighten: true,
      allowWrite: true,
    });
    expect(snapshot.registrations.vscodeMcpJson).toEqual({
      path: join(root, ".vscode", "mcp.json"),
      fileExists: true,
      hasTokenlighten: true,
      allowWrite: false,
    });
    expect(snapshot.registrations.codexConfigToml).toEqual({
      path: join(root, ".codex", "config.toml"),
      fileExists: false,
      hasTokenlighten: false,
      allowWrite: null,
    });
  });

  it("parses .codex/config.toml as real TOML and detects --allow-write in its args", () => {
    const root = tmpWorkspace();
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex", "config.toml"),
      [
        "[mcp_servers.tokenlighten]",
        'command = "tl"',
        'args = ["mcp", "start", "--stdio", "--allow-write"]',
        "enabled = true",
      ].join("\n"),
    );

    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: true,
      usageLoggingEnabledSetting: null,
    });

    expect(snapshot.registrations.codexConfigToml).toEqual({
      path: join(root, ".codex", "config.toml"),
      fileExists: true,
      hasTokenlighten: true,
      allowWrite: true,
    });
  });

  it("distinguishes a present file with no tokenlighten entry from a missing file", () => {
    const root = tmpWorkspace();
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {} }));

    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: null,
    });

    expect(snapshot.registrations.claudeMcpJson).toMatchObject({
      fileExists: true,
      hasTokenlighten: false,
      allowWrite: null,
    });
  });

  it("never throws on a malformed/corrupt registration file", () => {
    const root = tmpWorkspace();
    writeFileSync(join(root, ".mcp.json"), "{ not json");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "config.toml"), "this is not = valid [[[ toml");

    expect(() =>
      collectDiagnostics({
        extensionVersion: "1.0.0",
        workspaceRoot: root,
        writeEnabledSetting: null,
        usageLoggingEnabledSetting: null,
      }),
    ).not.toThrow();
  });
});

describe("collectDiagnostics — guide version parsing", () => {
  it("reads the installed INSTRUCTIONS_VERSION from AGENTS.md and matches it against the bundled constant", () => {
    const root = tmpWorkspace();
    writeFileSync(join(root, "AGENTS.md"), guideBlock(INSTRUCTIONS_VERSION));

    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: null,
    });

    expect(snapshot.guide).toEqual({
      installedVersion: INSTRUCTIONS_VERSION,
      bundledVersion: INSTRUCTIONS_VERSION,
      source: "AGENTS.md",
      upToDate: true,
    });
  });

  it("flags an older installed guide version as out of date", () => {
    const root = tmpWorkspace();
    writeFileSync(join(root, "AGENTS.md"), guideBlock("2020-01-01-v1-ancient"));

    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: null,
    });

    expect(snapshot.guide.installedVersion).toBe("2020-01-01-v1-ancient");
    expect(snapshot.guide.upToDate).toBe(false);
  });

  it("falls back to CLAUDE.md when AGENTS.md has no managed block", () => {
    const root = tmpWorkspace();
    writeFileSync(join(root, "CLAUDE.md"), guideBlock(INSTRUCTIONS_VERSION));

    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: null,
    });

    expect(snapshot.guide.source).toBe("CLAUDE.md");
    expect(snapshot.guide.installedVersion).toBe(INSTRUCTIONS_VERSION);
  });

  it("reports 'not installed' (null version and source) when neither file has a managed block", () => {
    const root = tmpWorkspace();
    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: null,
    });
    expect(snapshot.guide.installedVersion).toBeNull();
    expect(snapshot.guide.source).toBeNull();
    expect(snapshot.guide.bundledVersion).toBe(INSTRUCTIONS_VERSION);
    expect(snapshot.guide.upToDate).toBe(false);
  });
});

describe("collectDiagnostics — diagnostics ring file", () => {
  it("surfaces the ring file's calls when present", () => {
    const root = tmpWorkspace();
    const ringDirectory = tmpWorkspace("diagring");
    recordDiagCall({
      workspaceRoot: root,
      serverVersion: "0.11.0",
      serverBuild: "2026-08-22T08:54:46.000Z-6447649a",
      directory: ringDirectory,
      call: { at: "2026-08-22T00:00:00.000Z", tool: "read_file", mode: "task_pack", kind: "read.task_pack", ms: 10, ok: true },
    });

    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: true,
      ringDirectory,
    });

    expect(snapshot.ring.status).toBe("ok");
    expect(snapshot.ring.serverVersion).toBe("0.11.0");
    expect(snapshot.ring.serverBuild).toBe("2026-08-22T08:54:46.000Z-6447649a");
    expect(formatDiagnosticsText(snapshot, "en")).toContain(
      "Server build: 2026-08-22T08:54:46.000Z-6447649a",
    );
    expect(snapshot.ring.calls).toHaveLength(1);
    expect(snapshot.ring.calls[0]).toMatchObject({ tool: "read_file", mode: "task_pack", ok: true });
  });

  it("reports 'disabled' when the ring file is absent and usage logging is known to be off", () => {
    const root = tmpWorkspace();
    const ringDirectory = tmpWorkspace("diagring-empty");
    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: false,
      ringDirectory,
    });
    expect(snapshot.ring).toEqual({ status: "disabled", calls: [] });
  });

  it("reports 'empty' when the ring file is absent but usage logging is known to be on", () => {
    const root = tmpWorkspace();
    const ringDirectory = tmpWorkspace("diagring-empty2");
    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: true,
      ringDirectory,
    });
    expect(snapshot.ring).toEqual({ status: "empty", calls: [] });
  });

  it("reports 'unknown' when the ring file is absent and the usage-logging setting itself is unknown", () => {
    const root = tmpWorkspace();
    const ringDirectory = tmpWorkspace("diagring-empty3");
    const snapshot = collectDiagnostics({
      extensionVersion: "1.0.0",
      workspaceRoot: root,
      writeEnabledSetting: null,
      usageLoggingEnabledSetting: null,
      ringDirectory,
    });
    expect(snapshot.ring).toEqual({ status: "unknown", calls: [] });
  });
});

describe("formatDiagnosticsText", () => {
  it("produces a plain-text block containing every field, in the requested locale", () => {
    const root = tmpWorkspace();
    writeFileSync(join(root, "AGENTS.md"), guideBlock(INSTRUCTIONS_VERSION));
    const snapshot = collectDiagnostics({
      extensionVersion: "1.2.3",
      workspaceRoot: root,
      writeEnabledSetting: true,
      usageLoggingEnabledSetting: false,
    });

    const en = formatDiagnosticsText(snapshot, "en");
    expect(en).toContain("TokenLighten Diagnostics");
    expect(en).toContain("1.2.3");
    expect(en).toContain(root);
    expect(en).toContain("recording disabled");
    expect(en).not.toContain("undefined");

    const ja = formatDiagnosticsText(snapshot, "ja");
    expect(ja).toContain("TokenLighten 診断");
    expect(ja).toContain("記録は無効です");
  });
});
