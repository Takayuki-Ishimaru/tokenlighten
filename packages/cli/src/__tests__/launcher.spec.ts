import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  managedLauncherPath,
  resolveStableLauncher,
  writeManagedLauncher,
} from "../launcher.js";
import { setupWorkspace, verifyLauncherVersion } from "../commands/workspace.js";
import { formatVersionWithBuild } from "../commands/version.js";

function temporaryRoot(label: string): string {
  const root = join(tmpdir(), `tokenlighten-${label}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("stable launcher", () => {
  it("writes an executable fixed-path POSIX shim with every fallback tier", () => {
    if (process.platform === "win32") return;
    const homeDir = temporaryRoot("launcher-home");
    const cliPath = join(homeDir, "recorded", "index.js");
    const electronPath = join(homeDir, "app", "electron");
    mkdirSync(join(homeDir, "recorded"), { recursive: true });
    mkdirSync(join(homeDir, "app"), { recursive: true });
    writeFileSync(cliPath, "export {};\n");
    writeFileSync(electronPath, "#!/bin/sh\nexit 0\n");
    chmodSync(electronPath, 0o700);

    const launcher = writeManagedLauncher({
      homeDir,
      cliPath,
      electronPath,
      platform: "linux",
    });
    expect(launcher).toEqual({
      command: join(homeDir, ".tokenlighten", "bin", "tl"),
      argsPrefix: [],
      env: {},
      source: "managed-shim",
    });
    const body = readFileSync(launcher.command, "utf8");
    expect(body).toContain('TOKENLIGHTEN_CLI_PATH');
    expect(body).toContain(cliPath);
    expect(body).toContain('command -v tl');
    expect(body).toContain(electronPath);
    expect(body).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(body.indexOf("ELECTRON_RUN_AS_NODE=1 exec")).toBeLessThan(body.indexOf("TL_GLOBAL="));
  });

  it("formats and executes the launcher build self-check", () => {
    expect(formatVersionWithBuild("0.11.1", "2026-08-22T08:54:46.000Z-6447649abcdef"))
      .toBe("0.11.1+6447649a");
    const root = temporaryRoot("launcher-version");
    const script = join(root, "version.cjs");
    writeFileSync(script, 'process.stdout.write("0.11.1+6447649a\\n");\n');
    expect(verifyLauncherVersion({
      command: process.execPath,
      argsPrefix: [script],
      env: {},
    })).toBe("0.11.1+6447649a");
  });

  it("executes a managed Windows .cmd launcher build self-check", () => {
    if (process.platform !== "win32") return;
    const root = temporaryRoot("launcher-version-windows");
    const script = join(root, "version.cjs");
    const command = join(root, "tl.cmd");
    writeFileSync(script, 'process.stdout.write("0.11.1+windows1\\n");\n');
    writeFileSync(command, [
      "@echo off",
      `"${process.execPath}" "${script}" %*`,
      "",
    ].join("\r\n"));
    expect(verifyLauncherVersion({
      command,
      argsPrefix: [],
      env: {},
    })).toBe("0.11.1+windows1");
  });

  it("falls back to an absolute npm-global executable if the shim path is unsafe", () => {
    if (process.platform === "win32") return;
    const homeDir = temporaryRoot("launcher-fallback-home");
    const outside = temporaryRoot("launcher-outside");
    const globalBin = join(temporaryRoot("launcher-path"), "tl");
    writeFileSync(globalBin, "#!/bin/sh\nexit 0\n");
    chmodSync(globalBin, 0o700);
    mkdirSync(join(homeDir, ".tokenlighten"), { recursive: true });
    symlinkSync(outside, join(homeDir, ".tokenlighten", "bin"));

    const launcher = resolveStableLauncher({
      homeDir,
      platform: "linux",
      pathEnv: join(globalBin, ".."),
    });
    expect(launcher).toEqual({
      command: globalBin,
      argsPrefix: [],
      env: {},
      source: "npm-global",
    });
  });

  it("persists only the stable shim path in workspace settings", async () => {
    const homeDir = temporaryRoot("launcher-config-home");
    const root = temporaryRoot("launcher-workspace");
    const cliPath = join(homeDir, "volatile-extension", "cli.js");
    mkdirSync(join(homeDir, "volatile-extension"), { recursive: true });
    writeFileSync(cliPath, "export {};\n");

    const launcher = resolveStableLauncher({
      homeDir,
      cliPath,
      platform: process.platform,
    });
    await setupWorkspace({
      root,
      clients: ["vscode", "claude-code"],
      launcher,
    });

    const vscode = readFileSync(join(root, ".vscode", "mcp.json"), "utf8");
    const claude = readFileSync(join(root, ".mcp.json"), "utf8");
    expect(vscode).toContain(managedLauncherPath({ homeDir }));
    expect(claude).toContain(managedLauncherPath({ homeDir }));
    expect(vscode).not.toContain(cliPath);
    expect(claude).not.toContain(cliPath);
    expect(vscode).not.toContain(process.execPath);
    expect(claude).not.toContain(process.execPath);
    expect(vscode).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(claude).not.toContain("ELECTRON_RUN_AS_NODE");
  });
});
