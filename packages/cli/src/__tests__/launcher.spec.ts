import {
  chmodSync,
  existsSync,
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
  legacyLauncherPath,
  peekStableLauncher,
  resolveStableLauncher,
  writeManagedLauncher,
} from "../launcher.js";
import { setupWorkspace, verifyLauncherVersion } from "../commands/workspace.js";
import { formatVersionWithBuild } from "../commands/version.js";
import { writeInstallRecord } from "../installHome.js";

function temporaryRoot(label: string): string {
  const root = join(tmpdir(), `tokenlighten-${label}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("stable launcher", () => {
  it("writes an executable fixed-path POSIX shim under <installHome>/bin, runtime tried first", () => {
    if (process.platform === "win32") return;
    const installHome = temporaryRoot("install-home");
    const cliPath = join(installHome, "bin", "tl.js");
    const electronPath = join(installHome, "app", "electron");
    const runtimePath = join(installHome, "bin", "node");
    mkdirSync(join(installHome, "bin"), { recursive: true });
    mkdirSync(join(installHome, "app"), { recursive: true });
    writeFileSync(cliPath, "export {};\n");
    writeFileSync(electronPath, "#!/bin/sh\nexit 0\n");
    chmodSync(electronPath, 0o700);
    writeFileSync(runtimePath, "#!/bin/sh\nexit 0\n");
    chmodSync(runtimePath, 0o700);

    const launcher = writeManagedLauncher({
      installHome,
      cliPath,
      electronPath,
      runtimePath,
      platform: "linux",
    });
    expect(launcher).toEqual({
      command: join(installHome, "bin", "tl"),
      argsPrefix: [],
      env: {},
      source: "managed-shim",
    });
    expect(launcher.command).toBe(managedLauncherPath({ installHome }));
    const body = readFileSync(launcher.command, "utf8");
    expect(body).toContain('TOKENLIGHTEN_CLI_PATH');
    expect(body).toContain(cliPath);
    expect(body).toContain('command -v tl');
    expect(body).toContain(electronPath);
    expect(body).toContain(runtimePath);
    expect(body).toContain('ELECTRON_RUN_AS_NODE=1');
    // Runtime is tried FIRST, ahead of every other tier.
    const runtimeIdx = body.indexOf('TL_RUNTIME');
    const cliPathEnvIdx = body.indexOf('TOKENLIGHTEN_CLI_PATH');
    const recordedNodeIdx = body.indexOf('exec node "$TL_RECORDED"');
    const electronIdx = body.indexOf('TL_ELECTRON');
    const globalIdx = body.indexOf('TL_GLOBAL=');
    expect(runtimeIdx).toBeGreaterThanOrEqual(0);
    expect(runtimeIdx).toBeLessThan(cliPathEnvIdx);
    expect(cliPathEnvIdx).toBeLessThan(recordedNodeIdx);
    expect(recordedNodeIdx).toBeLessThan(electronIdx);
    expect(electronIdx).toBeLessThan(globalIdx);
  });

  it("writes a runtime-first shim without ELECTRON_RUN_AS_NODE when the runtime is plain node", () => {
    if (process.platform === "win32") return;
    const installHome = temporaryRoot("install-home-plain-runtime");
    const runtimePath = join(installHome, "bin", "node");
    mkdirSync(join(installHome, "bin"), { recursive: true });
    writeFileSync(runtimePath, "#!/bin/sh\nexit 0\n");
    chmodSync(runtimePath, 0o700);

    const launcher = writeManagedLauncher({
      installHome,
      runtimePath,
      runtimeIsElectron: false,
      platform: "linux",
    });
    const body = readFileSync(launcher.command, "utf8");
    expect(body).toContain(`exec "$TL_RUNTIME" "$TL_RECORDED" "$@"`);
    expect(body.indexOf('ELECTRON_RUN_AS_NODE=1 exec "$TL_RUNTIME"')).toBe(-1);
  });

  it("both shims (POSIX and Windows) share the same fallback order: runtime -> TOKENLIGHTEN_CLI_PATH -> recorded+node -> electron -> global tl", () => {
    const posixHome = temporaryRoot("order-posix");
    const windowsHome = temporaryRoot("order-windows");
    const cliPath = join(posixHome, "bin", "tl.js");
    const cliPathWin = join(windowsHome, "bin", "tl.js");
    mkdirSync(join(posixHome, "bin"), { recursive: true });
    mkdirSync(join(windowsHome, "bin"), { recursive: true });
    writeFileSync(cliPath, "export {};\n");
    writeFileSync(cliPathWin, "export {};\n");

    const posix = writeManagedLauncher({ installHome: posixHome, cliPath, platform: "linux" });
    const windows = writeManagedLauncher({ installHome: windowsHome, cliPath: cliPathWin, platform: "win32" });
    const posixBody = readFileSync(posix.command, "utf8");
    const windowsBody = readFileSync(windows.command, "utf8");

    const posixOrder = [
      posixBody.indexOf("TL_RUNTIME"),
      posixBody.indexOf("TOKENLIGHTEN_CLI_PATH"),
      posixBody.indexOf('exec node "$TL_RECORDED"'),
      posixBody.indexOf("TL_ELECTRON"),
      posixBody.indexOf("TL_GLOBAL="),
    ];
    const windowsOrder = [
      windowsBody.indexOf("TL_RUNTIME"),
      windowsBody.indexOf("TOKENLIGHTEN_CLI_PATH"),
      windowsBody.indexOf('node "%TL_RECORDED%" %*'),
      windowsBody.indexOf("TL_ELECTRON"),
      windowsBody.indexOf("where tl"),
    ];
    for (const idx of [...posixOrder, ...windowsOrder]) expect(idx).toBeGreaterThanOrEqual(0);
    // Each tier strictly precedes the next, on BOTH platforms — the two
    // shims no longer disagree about whether global `tl` or Electron comes
    // first (pre-v0.14.3: POSIX tried Electron before global tl, Windows
    // the reverse).
    for (const order of [posixOrder, windowsOrder]) {
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).toBeGreaterThan(order[i - 1]!);
      }
    }
  });

  it("legacyLauncherPath still resolves the pre-v0.14.3 ~/.tokenlighten/bin location", () => {
    const homeDir = temporaryRoot("legacy-home");
    expect(legacyLauncherPath({ homeDir, platform: "linux" }))
      .toBe(join(homeDir, ".tokenlighten", "bin", "tl"));
    expect(legacyLauncherPath({ homeDir, platform: "win32" }))
      .toBe(join(homeDir, ".tokenlighten", "bin", "tl.cmd"));
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
    const installHome = temporaryRoot("launcher-fallback-home");
    const outside = temporaryRoot("launcher-outside");
    const globalBin = join(temporaryRoot("launcher-path"), "tl");
    writeFileSync(globalBin, "#!/bin/sh\nexit 0\n");
    chmodSync(globalBin, 0o700);
    mkdirSync(installHome, { recursive: true });
    symlinkSync(outside, join(installHome, "bin"));

    const launcher = resolveStableLauncher({
      installHome,
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
    const installHome = temporaryRoot("launcher-config-home");
    const root = temporaryRoot("launcher-workspace");
    const cliPath = join(installHome, "volatile-extension", "cli.js");
    mkdirSync(join(installHome, "volatile-extension"), { recursive: true });
    writeFileSync(cliPath, "export {};\n");

    const launcher = resolveStableLauncher({
      installHome,
      cliPath,
      platform: process.platform,
    });
    // This fixture's installHome is an arbitrary temp directory, never the
    // real default install home -- say so explicitly (workspaceSetup.spec.ts
    // models the same explicit-override pattern) instead of falling through
    // to setupWorkspace's own isDefaultInstallHome() default, which on win32
    // can report this path as "default" purely because os.tmpdir() happens
    // to live under %LOCALAPPDATA%, triggering host-variable templating this
    // test isn't exercising.
    await setupWorkspace({
      root,
      clients: ["vscode", "claude-code"],
      launcher,
      installHomeDefault: false,
    });

    const vscode = readFileSync(join(root, ".vscode", "mcp.json"), "utf8");
    const claude = readFileSync(join(root, ".mcp.json"), "utf8");
    // mcp.json/.mcp.json are JSON files: a Windows path embeds backslashes
    // that JSON.stringify doubles, so compare against the escaped form.
    const expectedLauncherPath = JSON.stringify(managedLauncherPath({ installHome }));
    expect(vscode).toContain(expectedLauncherPath);
    expect(claude).toContain(expectedLauncherPath);
    expect(vscode).not.toContain(cliPath);
    expect(claude).not.toContain(cliPath);
    expect(vscode).not.toContain(process.execPath);
    expect(claude).not.toContain(process.execPath);
    expect(vscode).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(claude).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("peekStableLauncher returns the recorded identity without writing anything (review B2)", () => {
    const installHome = temporaryRoot("peek-launcher-recorded");
    const nodePath = join(installHome, "bin", "node");
    const cliJsPath = join(installHome, "bin", "tl.js");
    writeInstallRecord(installHome, {
      schemaVersion: 1,
      version: "1.0.0",
      installed_by: "archive",
      runtime: { command: nodePath, env: { TOKENLIGHTEN_MANAGED: "1" }, source: "bundled-node" },
      identity: { command: nodePath, argsPrefix: [cliJsPath], env: { TOKENLIGHTEN_MANAGED: "1" } },
      write_posture: "allow-write",
      hosts: [],
      workspaces: [],
      installed_at: new Date().toISOString(),
      source_dir: installHome,
    });

    const peeked = peekStableLauncher({ installHome, platform: "linux" });
    expect(peeked).toEqual({
      command: nodePath,
      argsPrefix: [cliJsPath],
      env: { TOKENLIGHTEN_MANAGED: "1" },
      source: "bundled-runtime",
    });
    // Read-only: must never create the human-facing managed shim as a side
    // effect of a status query — that is `resolveStableLauncher`'s job.
    expect(existsSync(managedLauncherPath({ installHome, platform: "linux" }))).toBe(false);
  });

  it("peekStableLauncher returns undefined and writes nothing when there is no install record", () => {
    const installHome = temporaryRoot("peek-launcher-absent");
    const peeked = peekStableLauncher({ installHome, platform: "linux" });
    expect(peeked).toBeUndefined();
    expect(existsSync(join(installHome, "bin"))).toBe(false);
  });
});
