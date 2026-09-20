import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  defaultClientCommandRunner,
  getClientStatuses,
  registerClients,
  unregisterClients,
  type ClientCommandRunner,
  type CommandResult,
} from "../commands/clients.js";
import { managedLauncherPath, type StableLauncher } from "../launcher.js";
import { writeInstallRecord } from "../installHome.js";
import type { TokenLightenRegistrationClient } from "@tokenlighten/types";

interface FakeEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function fixtureLauncher(): StableLauncher {
  const directory = join(tmpdir(), `tl-client-launcher-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const command = join(directory, process.platform === "win32" ? "tl.cmd" : "tl");
  writeFileSync(command, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  return { command, argsPrefix: [], env: {}, source: "managed-shim" };
}

function fakeVendor(initial: Partial<Record<TokenLightenRegistrationClient, FakeEntry>> = {}) {
  const entries = new Map<TokenLightenRegistrationClient, FakeEntry>(
    Object.entries(initial) as [TokenLightenRegistrationClient, FakeEntry][],
  );
  const calls: { command: string; args: string[] }[] = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;

  const result = (status: number, stdout = "", stderr = ""): CommandResult => ({
    status,
    stdout,
    stderr,
  });

  const runner: ClientCommandRunner = async (command, readonlyArgs) => {
    const args = [...readonlyArgs];
    calls.push({ command, args });
    if (args.length === 1 && args[0] === "version") {
      return result(0, "tl 0.9.0\n");
    }
    const client: TokenLightenRegistrationClient = command === "claude"
      ? "claude-code"
      : "codex";
    if (args.length === 1 && args[0] === "--version") {
      return result(0, `${command} 1.2.3\n`);
    }
    if (args[0] === "mcp" && args[1] === "get") {
      const entry = entries.get(client);
      return entry ? result(0, JSON.stringify(entry)) : result(1, "", "not found");
    }
    if (args[0] === "mcp" && (args[1] === "add" || args[1] === "add-json")) {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (client === "claude-code") {
        const payload = JSON.parse(args[3] ?? "{}") as FakeEntry;
        entries.set(client, payload);
      } else {
        const separator = args.indexOf("--");
        const env: Record<string, string> = {};
        for (let index = 3; index < separator; index += 1) {
          if (args[index] !== "--env") continue;
          const [key, ...value] = (args[index + 1] ?? "").split("=");
          if (key) env[key] = value.join("=");
          index += 1;
        }
        entries.set(client, {
          command: args[separator + 1] ?? "",
          args: args.slice(separator + 2),
          env,
        });
      }
      activeWrites -= 1;
      return result(0);
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 5));
      entries.delete(client);
      activeWrites -= 1;
      return result(0);
    }
    return result(2, "", "unexpected invocation");
  };

  return {
    calls,
    entries,
    runner,
    maxActiveWrites: () => maxActiveWrites,
  };
}

describe("tl clients engine — re-run classification without an injected launcher (regression B2)", () => {
  function fixtureInstallRecord(installHome: string, identity: { command: string; argsPrefix: string[] }) {
    writeInstallRecord(installHome, {
      schemaVersion: 1,
      version: "1.0.0",
      installed_by: "archive",
      runtime: { command: identity.command, env: { TOKENLIGHTEN_MANAGED: "1" }, source: "bundled-node" },
      identity: { command: identity.command, argsPrefix: identity.argsPrefix, env: { TOKENLIGHTEN_MANAGED: "1" } },
      write_posture: "allow-write",
      hosts: [],
      workspaces: [],
      installed_at: new Date().toISOString(),
      source_dir: installHome,
    });
  }

  it("copilot-cli: register -> status -> register again all read registered-managed from a REAL install.json, no injected launcher", async () => {
    const installHome = join(tmpdir(), `tl-b2-copilot-record-${randomUUID()}`);
    const homeDir = join(tmpdir(), `tl-b2-copilot-home-${randomUUID()}`);
    mkdirSync(join(homeDir, ".copilot"), { recursive: true });
    const nodePath = join(installHome, "bin", process.platform === "win32" ? "node.exe" : "node");
    const cliJsPath = join(installHome, "bin", "tl.js");
    fixtureInstallRecord(installHome, { command: nodePath, argsPrefix: [cliJsPath] });

    const first = await registerClients(["copilot-cli"], { installHome, homeDir });
    expect(first.ok).toBe(true);
    expect(first.clients[0]?.state).toBe("registered-managed");

    const status = await getClientStatuses(["copilot-cli"], { installHome, homeDir });
    expect(status.clients[0]?.state).toBe("registered-managed");

    const second = await registerClients(["copilot-cli"], { installHome, homeDir });
    expect(second.ok).toBe(true);
    expect(second.warnings.join(" ")).not.toMatch(/foreign/i);
    expect(second.clients[0]?.state).toBe("registered-managed");
  });

  it("a vendor-CLI host (codex): register -> status -> register again all read registered-managed from a REAL install.json, no injected launcher", async () => {
    const installHome = join(tmpdir(), `tl-b2-vendor-record-${randomUUID()}`);
    const homeDir = join(tmpdir(), `tl-b2-vendor-home-${randomUUID()}`);
    const nodePath = join(installHome, "bin", process.platform === "win32" ? "node.exe" : "node");
    const cliJsPath = join(installHome, "bin", "tl.js");
    fixtureInstallRecord(installHome, { command: nodePath, argsPrefix: [cliJsPath] });
    const vendor = fakeVendor();

    const first = await registerClients(["codex"], { installHome, homeDir, runner: vendor.runner });
    expect(first.ok).toBe(true);
    expect(first.clients[0]?.state).toBe("registered-managed");

    const status = await getClientStatuses(["codex"], { installHome, homeDir, runner: vendor.runner });
    expect(status.clients[0]?.state).toBe("registered-managed");

    const second = await registerClients(["codex"], { installHome, homeDir, runner: vendor.runner });
    expect(second.ok).toBe(true);
    expect(second.warnings.join(" ")).not.toMatch(/foreign/i);
    expect(second.clients[0]?.state).toBe("registered-managed");
  });
});

describe("tl clients engine", () => {
  it("spawns with argv boundaries intact and no shell interpretation", async () => {
    if (process.platform === "win32") return;
    const directory = join(tmpdir(), `tl runner space ${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "fake-client");
    writeFileSync(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    chmodSync(executable, 0o700);
    const args = ["space separated", "$(must-not-run)", ";", "--literal=value"];
    const result = await defaultClientCommandRunner(executable, args);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("pins Claude add/get argv and re-registers idempotently", async () => {
    const launcher = fixtureLauncher();
    const vendor = fakeVendor();
    const first = await registerClients(
      ["claude-code"],
      { runner: vendor.runner, launcher },
    );
    expect(first.ok).toBe(true);
    expect(first.clients[0]).toMatchObject({
      client: "claude-code",
      state: "registered-managed",
      launcherState: "launcher-ok",
    });

    const add = vendor.calls.find((call) => call.args[1] === "add-json");
    expect(add?.command).toBe("claude");
    expect(add?.args.slice(0, 3)).toEqual(["mcp", "add-json", "tokenlighten"]);
    expect(add?.args.slice(-2)).toEqual(["--scope", "user"]);
    const payload = JSON.parse(add?.args[3] ?? "{}") as FakeEntry;
    expect(payload).toEqual({
      type: "stdio",
      command: launcher.command,
      args: ["mcp", "start", "--stdio", "--allow-write"],
      env: {
        TOKENLIGHTEN_CLIENT: "claude-code",
        TOKENLIGHTEN_USAGE_LOG: "on",
        TOKENLIGHTEN_MANAGED: "1",
      },
    });
    expect(vendor.calls.some((call) =>
      call.command === "claude"
      && JSON.stringify(call.args) === JSON.stringify(["mcp", "get", "tokenlighten"])))
      .toBe(true);

    const second = await registerClients(
      ["claude-code"],
      { runner: vendor.runner, launcher },
    );
    expect(second.ok).toBe(true);
    expect(vendor.calls.filter((call) => call.args[1] === "add-json")).toHaveLength(2);
  });

  it("still classifies a registered entry with an extra --tool-surface code flag as registered-managed (prefix, not exact-tuple, ownership)", async () => {
    const launcher = fixtureLauncher();
    const managedWithToolSurface: FakeEntry = {
      command: launcher.command,
      args: [...launcher.argsPrefix, "mcp", "start", "--stdio", "--allow-write", "--tool-surface", "code"],
      env: {
        TOKENLIGHTEN_CLIENT: "codex",
        TOKENLIGHTEN_USAGE_LOG: "on",
        TOKENLIGHTEN_MANAGED: "1",
      },
    };
    const vendor = fakeVendor({ codex: managedWithToolSurface });
    const result = await getClientStatuses(["codex"], { runner: vendor.runner, launcher });
    expect(result.clients[0]).toMatchObject({
      client: "codex",
      state: "registered-managed",
    });
  });

  it("pins Codex argv and reports machine-readable status", async () => {
    const launcher = fixtureLauncher();
    const vendor = fakeVendor();
    const result = await registerClients(["codex"], {
      runner: vendor.runner,
      launcher,
    });
    expect(result).toMatchObject({
      schemaVersion: 1,
      action: "register",
      ok: true,
      changedClients: ["codex"],
      clients: [{ client: "codex", state: "registered-managed" }],
    });
    const add = vendor.calls.find((call) => call.args[1] === "add");
    expect(add).toEqual({
      command: "codex",
      args: [
        "mcp",
        "add",
        "tokenlighten",
        "--env",
        "TOKENLIGHTEN_CLIENT=codex",
        "--env",
        "TOKENLIGHTEN_USAGE_LOG=on",
        "--env",
        "TOKENLIGHTEN_MANAGED=1",
        "--",
        launcher.command,
        "mcp",
        "start",
        "--stdio",
        "--allow-write",
      ],
    });
    expect(vendor.calls.some((call) =>
      call.command === "codex"
      && JSON.stringify(call.args) === JSON.stringify(["mcp", "get", "tokenlighten", "--json"])))
      .toBe(true);
  });

  it("selects native only for bounded known-local work and fails closed otherwise", async () => {
    const { selectHostProfile } = await import("../commands/clients.js");
    const fileProbe = () => ({ isFile: true, size: 4096 });
    expect(selectHostProfile({
      request: "Update the timeout in this file",
      paths: ["src/config.ts"],
      fileProbe,
    })).toEqual({ profile: "native", reason: "known-local-single-site" });
    expect(selectHostProfile({
      request: "Find all references",
      paths: ["src/config.ts"],
      fileProbe,
    })).toEqual({ profile: "tl", reason: "cross-file-or-discovery" });
    expect(selectHostProfile({
      request: "Please help",
      paths: ["src/config.ts"],
      fileProbe,
    })).toEqual({ profile: "tl", reason: "ambiguous-request" });
    expect(selectHostProfile({
      request: "Edit this archive",
      paths: ["bundle.zip"],
      fileProbe,
    })).toEqual({ profile: "tl", reason: "artifact-or-wiring" });
    expect(selectHostProfile({
      request: "Update the matching label in both files",
      paths: ["src/a.ts", "src/b.ts"],
      fileProbe: () => ({ isFile: true, size: 8192 }),
    })).toEqual({ profile: "native", reason: "known-local-single-site" });
    expect(selectHostProfile({
      request: "Update the matching label in both files",
      paths: ["src/a.ts", "src/b.ts"],
      fileProbe: () => ({ isFile: true, size: 8193 }),
    })).toEqual({ profile: "tl", reason: "path-unknown" });
    expect(selectHostProfile({
      request: "Update src/a.ts, and explain the retry policy",
      paths: ["src/a.ts"],
      fileProbe,
    })).toEqual({ profile: "tl", reason: "multi-concern" });
    expect(selectHostProfile({
      request: "src/a.ts の値を確認してください。",
      paths: ["src/a.ts"],
      fileProbe,
    })).toEqual({ profile: "native", reason: "known-local-single-site" });
    expect(selectHostProfile({
      request: "Update the matching label in these files",
      paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      fileProbe,
    })).toEqual({ profile: "tl", reason: "path-unknown" });
  });

  it("keeps request selection plan-only until apply is explicit", async () => {
    const { selectClientProfile } = await import("../commands/clients.js");
    const runner: ClientCommandRunner = async () => ({
      status: null,
      stdout: "",
      stderr: "",
      errorCode: "ENOENT",
    });
    const result = await selectClientProfile(
      ["codex"],
      {
        request: "Update this file",
        paths: ["src/config.ts"],
        fileProbe: () => ({ isFile: true, size: 4096 }),
      },
      { runner, vendorConfigProbe: () => false },
    );
    expect(result).toMatchObject({
      selectedProfile: "native",
      selectionReason: "known-local-single-site",
      applied: false,
    });
  });

  it("native profile dry-run reports managed guide plan without mutation", async () => {
    const { injectAll } = await import("@tokenlighten/agents-md");
    const { setClientProfile } = await import("../commands/clients.js");
    const root = join(tmpdir(), `tl-native-guide-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    try {
      await injectAll({ repoRoot: root, force: true });
      const before = readFileSync(join(root, "AGENTS.md"), "utf8");
      const runner: ClientCommandRunner = async () => ({
        status: null,
        stdout: "",
        stderr: "",
        errorCode: "ENOENT",
      });
      const result = await setClientProfile(
        ["codex"],
        "native",
        { runner, vendorConfigProbe: () => false },
        true,
        root,
      );
      expect(result).toMatchObject({
        guideAction: "remove",
        guideRoot: root,
        profileReady: false,
      });
      // AGENTS.md + 6 stub targets (claude, copilot, cursor, cline,
      // continue, copilot-agent).
      expect(result.guidePlanned).toHaveLength(7);
      expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("native profile removes the managed MCP entry and all managed guide blocks", async () => {
    const { injectAll } = await import("@tokenlighten/agents-md");
    const { setClientProfile } = await import("../commands/clients.js");
    const root = join(tmpdir(), `tl-native-applied-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const launcher = fixtureLauncher();
    const vendor = fakeVendor();
    try {
      await injectAll({ repoRoot: root, force: true });
      const agents = join(root, "AGENTS.md");
      writeFileSync(agents, `user-owned prefix\n${readFileSync(agents, "utf8")}`, "utf8");
      await registerClients(["codex"], { runner: vendor.runner, launcher });
      const result = await setClientProfile(
        ["codex"],
        "native",
        { runner: vendor.runner, launcher },
        false,
        root,
      );
      expect(result).toMatchObject({
        ok: true,
        selectedProfile: "native",
        profileReady: true,
        changedClients: ["codex"],
      });
      expect(result.guideChanged).toHaveLength(7);
      expect(readFileSync(agents, "utf8")).toContain("user-owned prefix");
      expect(readFileSync(agents, "utf8"))
        .not.toContain("tokenlighten:mcp-instructions:start");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the managed MCP entry when guide removal fails closed", async () => {
    const { injectAll } = await import("@tokenlighten/agents-md");
    const { setClientProfile } = await import("../commands/clients.js");
    const root = join(tmpdir(), `tl-native-guide-failure-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const launcher = fixtureLauncher();
    const vendor = fakeVendor();
    try {
      await injectAll({ repoRoot: root, force: true });
      const agents = join(root, "AGENTS.md");
      writeFileSync(
        agents,
        readFileSync(agents, "utf8").replace(
          "<!-- tokenlighten:mcp-instructions:end -->",
          "<!-- malformed managed block -->",
        ),
        "utf8",
      );
      await registerClients(["codex"], { runner: vendor.runner, launcher });
      const callsBefore = vendor.calls.length;
      const result = await setClientProfile(
        ["codex"],
        "native",
        { runner: vendor.runner, launcher },
        false,
        root,
      );
      expect(result).toMatchObject({
        ok: false,
        selectedProfile: "native",
        profileReady: false,
        changedClients: [],
      });
      expect(result.guideErrors?.join("\n")).toContain("malformed-managed-block");
      expect(result.warnings.join("\n")).toContain(
        "managed MCP registration retained because guide removal did not complete",
      );
      expect(vendor.entries.has("codex")).toBe(true);
      expect(vendor.calls.slice(callsBefore).some((call) => call.args[1] === "remove")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does no write when a vendor CLI is absent and returns a manual snippet", async () => {
    const calls: string[][] = [];
    const runner: ClientCommandRunner = async (_command, args) => {
      calls.push([...args]);
      return { status: null, stdout: "", stderr: "", errorCode: "ENOENT" };
    };
    const homeDir = join(tmpdir(), `tl-absent-home-${randomUUID()}`);
    const result = await registerClients(["claude-code"], { runner, installHome: homeDir });
    expect(result.ok).toBe(false);
    expect(existsSync(managedLauncherPath({ installHome: homeDir }))).toBe(false);
    expect(result.changedClients).toEqual([]);
    expect(result.warnings[0]).toContain("vendor CLI is unavailable");
    expect(result.clients[0]).toMatchObject({
      state: "client-absent",
      launcherState: "unknown",
    });
    expect(result.clients[0]?.manualCommand).toContain("claude mcp add-json tokenlighten");
    expect(calls).toEqual([["--version"]]);
  });

  it("preserves a foreign entry unless force is explicit", async () => {
    const launcher = fixtureLauncher();
    const foreign: FakeEntry = {
      command: "/someone/else/tl",
      args: ["mcp", "start"],
      env: {},
    };
    const vendor = fakeVendor({ codex: foreign });
    const refused = await registerClients(
      ["codex"],
      { runner: vendor.runner, launcher },
    );
    expect(refused.ok).toBe(false);
    expect(refused.clients[0]?.state).toBe("registered-foreign");
    expect(vendor.calls.some((call) => call.args[1] === "add")).toBe(false);
    expect(vendor.entries.get("codex")).toEqual(foreign);

    const forced = await registerClients(
      ["codex"],
      { runner: vendor.runner, launcher },
      true,
    );
    expect(forced.ok).toBe(true);
    expect(forced.clients[0]?.state).toBe("registered-managed");
  });

  it("unregisters exactly managed entries and leaves foreign entries alone", async () => {
    const launcher = fixtureLauncher();
    const managed: FakeEntry = {
      command: launcher.command,
      args: ["mcp", "start", "--stdio", "--allow-write"],
      env: {
        TOKENLIGHTEN_CLIENT: "claude-code",
        TOKENLIGHTEN_USAGE_LOG: "on",
        TOKENLIGHTEN_MANAGED: "1",
      },
    };
    const foreign: FakeEntry = {
      command: "/foreign/tl",
      args: ["mcp", "start"],
      env: {},
    };
    const vendor = fakeVendor({ "claude-code": managed, codex: foreign });
    const result = await unregisterClients(
      ["claude-code", "codex"],
      { runner: vendor.runner, launcher },
    );
    expect(result.ok).toBe(false);
    expect(result.changedClients).toEqual(["claude-code"]);
    expect(vendor.entries.has("claude-code")).toBe(false);
    expect(vendor.entries.get("codex")).toEqual(foreign);
    expect(vendor.calls.some((call) =>
      call.command === "claude"
      && JSON.stringify(call.args) === JSON.stringify(["mcp", "remove", "tokenlighten", "--scope", "user"])))
      .toBe(true);
    expect(vendor.calls.some((call) =>
      call.command === "codex" && call.args[1] === "remove"))
      .toBe(false);
  });

  it("serializes concurrent vendor writes", async () => {
    const launcher = fixtureLauncher();
    const vendor = fakeVendor();
    await Promise.all([
      registerClients(["claude-code"], { runner: vendor.runner, launcher }),
      registerClients(["codex"], { runner: vendor.runner, launcher }),
    ]);
    expect(vendor.maxActiveWrites()).toBe(1);
  });

  it("classifies status without changing registration", async () => {
    const launcher = fixtureLauncher();
    const vendor = fakeVendor({
      codex: {
        command: launcher.command,
        args: ["mcp", "start", "--stdio", "--allow-write"],
        env: {
          TOKENLIGHTEN_CLIENT: "codex",
          TOKENLIGHTEN_USAGE_LOG: "on",
          TOKENLIGHTEN_MANAGED: "1",
        },
      },
    });
    const result = await getClientStatuses(["codex"], {
      runner: vendor.runner,
      launcher,
    });
    expect(result).toMatchObject({
      action: "status",
      ok: true,
      changedClients: [],
      clients: [{
        state: "registered-managed",
        launcherState: "launcher-ok",
        clientVersion: "codex 1.2.3",
      }],
    });
    expect(vendor.calls.every((call) =>
      call.args[1] !== "add" && call.args[1] !== "remove"))
      .toBe(true);
  });

  it("reports a local vendor config when the CLI is missing from PATH", async () => {
    const absentRunner: ClientCommandRunner = async () => ({
      status: null,
      stdout: "",
      stderr: "",
      errorCode: "ENOENT",
    });
    const homeDir = join(tmpdir(), `tl-vendor-config-${randomUUID()}`);

    const detected = await getClientStatuses(["codex"], {
      runner: absentRunner,
      homeDir,
      vendorConfigProbe: () => true,
    });
    expect(detected.clients[0]).toMatchObject({
      client: "codex",
      state: "client-absent",
      launcherState: "unknown",
      vendorConfigPresent: true,
    });
    expect(detected.clients[0]?.manualCommand).toContain("codex mcp add tokenlighten");
    expect(detected.clients[0]?.detail).toBe(
      "vendor CLI is not on PATH, but a local configuration for this client was found; "
      + "install the CLI or run the manual command",
    );

    const undetected = await getClientStatuses(["codex"], {
      runner: absentRunner,
      homeDir,
      vendorConfigProbe: () => false,
    });
    expect(undetected.clients[0]).toMatchObject({
      client: "codex",
      state: "client-absent",
      launcherState: "unknown",
      vendorConfigPresent: false,
    });
    expect(undetected.clients[0]?.manualCommand).toContain("codex mcp add tokenlighten");
    expect(undetected.clients[0]?.detail).toBe("ENOENT");
  });

  it("detects vendor config files on disk without a vendor CLI", async () => {
    const absentRunner: ClientCommandRunner = async () => ({
      status: null,
      stdout: "",
      stderr: "",
      errorCode: "ENOENT",
    });
    const homeDir = join(tmpdir(), `tl-vendor-home-${randomUUID()}`);
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(join(homeDir, ".codex", "config.toml"), "\n");

    const result = await getClientStatuses(["codex", "claude-code"], {
      runner: absentRunner,
      homeDir,
    });
    expect(result.clients[0]).toMatchObject({
      client: "codex",
      state: "client-absent",
      vendorConfigPresent: true,
    });
    expect(result.clients[1]).toMatchObject({
      client: "claude-code",
      state: "client-absent",
      vendorConfigPresent: false,
    });
  });

  it("carries vendorConfigPresent on clients whose CLI answers", async () => {
    const launcher = fixtureLauncher();
    const vendor = fakeVendor({
      codex: {
        command: launcher.command,
        args: ["mcp", "start", "--stdio", "--allow-write"],
        env: {
          TOKENLIGHTEN_CLIENT: "codex",
          TOKENLIGHTEN_USAGE_LOG: "on",
          TOKENLIGHTEN_MANAGED: "1",
        },
      },
    });
    const healthy = await getClientStatuses(["codex"], {
      runner: vendor.runner,
      launcher,
      vendorConfigProbe: () => true,
    });
    expect(healthy.clients[0]).toMatchObject({
      state: "registered-managed",
      launcherState: "launcher-ok",
      vendorConfigPresent: true,
    });
    expect(healthy.clients[0]?.detail).toBeUndefined();

    const missing = await getClientStatuses(["claude-code"], {
      runner: vendor.runner,
      launcher,
      vendorConfigProbe: () => false,
    });
    expect(missing.clients[0]).toMatchObject({
      state: "not-registered",
      vendorConfigPresent: false,
    });
  });
});

describe("tl clients engine — gemini (vendor CLI, no per-server get)", () => {
  function fakeGeminiRunner(settingsPath: string) {
    const calls: { command: string; args: string[] }[] = [];
    const readDoc = (): { mcpServers: Record<string, unknown> } => {
      if (!existsSync(settingsPath)) return { mcpServers: {} };
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { mcpServers?: Record<string, unknown> };
      return { mcpServers: parsed.mcpServers ?? {} };
    };
    const writeDoc = (doc: { mcpServers: Record<string, unknown> }): void => {
      mkdirSync(join(settingsPath, ".."), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(doc, null, 2));
    };
    const runner: ClientCommandRunner = async (command, readonlyArgs) => {
      const args = [...readonlyArgs];
      calls.push({ command, args });
      if (args.length === 1 && args[0] === "--version") return { status: 0, stdout: "0.5.0\n", stderr: "" };
      if (args.length === 1 && args[0] === "version") return { status: 0, stdout: "tl 0.9.0\n", stderr: "" };
      if (args[0] === "mcp" && args[1] === "add") {
        let i = 2;
        if (args[i] === "-s") i += 2;
        const env: Record<string, string> = {};
        while (args[i] === "-e") {
          const [key, ...value] = (args[i + 1] ?? "").split("=");
          if (key) env[key] = value.join("=");
          i += 2;
        }
        const name = args[i++] ?? "tokenlighten";
        const entryCommand = args[i++] ?? "";
        // Mirrors gemini-cli's own yargs middleware (packages/cli/src/
        // commands/mcp/add.ts, google-gemini/gemini-cli@main, verified
        // 2026-09-13): the final stored `args` is the positional `[args...]`
        // BEFORE a bare `--` concatenated with everything AFTER it, in that
        // order — not just "whatever comes after --".
        const dashDashIndex = args.indexOf("--", i);
        const positionalArgs = dashDashIndex >= 0 ? args.slice(i, dashDashIndex) : args.slice(i);
        const afterDashDash = dashDashIndex >= 0 ? args.slice(dashDashIndex + 1) : [];
        const entryArgs = [...positionalArgs, ...afterDashDash];
        const doc = readDoc();
        doc.mcpServers[name] = { command: entryCommand, args: entryArgs, env };
        writeDoc(doc);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "mcp" && args[1] === "remove") {
        const name = args[args.length - 1] ?? "tokenlighten";
        const doc = readDoc();
        delete doc.mcpServers[name];
        writeDoc(doc);
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 2, stdout: "", stderr: "unexpected invocation" };
    };
    return { calls, runner };
  }

  it("registers with -s user / -e env / a literal -- separator (docs/tools/mcp-server.md syntax)", async () => {
    const launcher = fixtureLauncher();
    const homeDir = join(tmpdir(), `tl-gemini-${randomUUID()}`);
    const settingsPath = join(homeDir, ".gemini", "settings.json");
    const gemini = fakeGeminiRunner(settingsPath);

    const result = await registerClients(["gemini"], { runner: gemini.runner, launcher, homeDir });
    expect(result.ok).toBe(true);
    expect(result.clients[0]).toMatchObject({ client: "gemini", state: "registered-managed" });

    const add = gemini.calls.find((call) => call.args[1] === "add");
    expect(add?.args.slice(0, 4)).toEqual(["mcp", "add", "-s", "user"]);
    expect(add?.args).toContain("--");
    expect(add?.args.some((value) => value.startsWith("-e"))).toBe(true);

    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(doc.mcpServers.tokenlighten.env.TOKENLIGHTEN_MANAGED).toBe("1");
    expect(doc.mcpServers.tokenlighten.args).toEqual([...launcher.argsPrefix, "mcp", "start", "--stdio", "--allow-write"]);
  });

  it("gemini registration mirrors the vendor's documented before/after -- split (non-flag args before, flags after)", async () => {
    const launcher = fixtureLauncher();
    const homeDir = join(tmpdir(), `tl-gemini-split-${randomUUID()}`);
    const settingsPath = join(homeDir, ".gemini", "settings.json");
    const gemini = fakeGeminiRunner(settingsPath);

    await registerClients(["gemini"], { runner: gemini.runner, launcher, homeDir });
    const add = gemini.calls.find((call) => call.args[1] === "add");
    const dashDashIndex = add?.args.indexOf("--") ?? -1;
    expect(dashDashIndex).toBeGreaterThan(0);
    const beforeDashDash = add?.args.slice(0, dashDashIndex) ?? [];
    const afterDashDash = add?.args.slice(dashDashIndex + 1) ?? [];
    // docs.tools/mcp-server.md's own example (`gemini mcp add python-server
    // python server.py -- --server-arg my-value`) keeps every non-flag token
    // before `--` and every flag-shaped token after it.
    expect(beforeDashDash.slice(-2)).toEqual([...launcher.argsPrefix, "mcp", "start"].slice(-2));
    expect(beforeDashDash.every((token) => !token.startsWith("--"))).toBe(true);
    expect(afterDashDash).toEqual(["--stdio", "--allow-write"]);
    // And the final stored args are unaffected by the split — same value as
    // the "no explicit split" assertion above.
    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(doc.mcpServers.tokenlighten.args).toEqual([...launcher.argsPrefix, "mcp", "start", "--stdio", "--allow-write"]);
  });

  it("reports not-registered when settings.json has no tokenlighten entry, and unregisters a managed one", async () => {
    const launcher = fixtureLauncher();
    const homeDir = join(tmpdir(), `tl-gemini-${randomUUID()}`);
    const settingsPath = join(homeDir, ".gemini", "settings.json");
    const gemini = fakeGeminiRunner(settingsPath);

    const before = await getClientStatuses(["gemini"], { runner: gemini.runner, launcher, homeDir });
    expect(before.clients[0]).toMatchObject({ client: "gemini", state: "not-registered" });

    await registerClients(["gemini"], { runner: gemini.runner, launcher, homeDir });
    const removed = await unregisterClients(["gemini"], { runner: gemini.runner, launcher, homeDir });
    expect(removed.ok).toBe(true);
    expect(removed.clients[0]).toMatchObject({ state: "not-registered" });
  });

  it("classifies an entry pointing at the pre-v0.14.3 legacy shim as registered-legacy, replaceable without --force", async () => {
    const launcher = fixtureLauncher();
    const homeDir = join(tmpdir(), `tl-gemini-legacy-${randomUUID()}`);
    const settingsPath = join(homeDir, ".gemini", "settings.json");
    const legacyShim = join(homeDir, ".tokenlighten", "bin", process.platform === "win32" ? "tl.cmd" : "tl");
    mkdirSync(join(homeDir, ".gemini"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: {
          tokenlighten: { command: legacyShim, args: ["mcp", "start", "--stdio"], env: { TOKENLIGHTEN_MANAGED: "1" } },
        },
      }, null, 2),
    );
    const gemini = fakeGeminiRunner(settingsPath);

    const status = await getClientStatuses(["gemini"], { runner: gemini.runner, launcher, homeDir });
    expect(status.clients[0]).toMatchObject({ client: "gemini", state: "registered-legacy" });

    // register/activate replace it WITHOUT --force.
    const registered = await registerClients(["gemini"], { runner: gemini.runner, launcher, homeDir }, false);
    expect(registered.ok).toBe(true);
    expect(registered.clients[0]).toMatchObject({ state: "registered-managed" });
    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(doc.mcpServers.tokenlighten.command).toBe(launcher.command);
  });
});

describe("tl clients engine — copilot-cli (config-file mechanism)", () => {
  function copilotConfigFor(homeDir: string): string {
    return join(homeDir, ".copilot", "mcp-config.json");
  }

  it("is client-absent when neither ~/.copilot exists nor 'copilot' is on PATH", async () => {
    const homeDir = join(tmpdir(), `tl-copilot-absent-${randomUUID()}`);
    mkdirSync(homeDir, { recursive: true });
    const result = await getClientStatuses(["copilot-cli"], { homeDir, pathEnv: "" });
    expect(result.clients[0]).toMatchObject({ client: "copilot-cli", state: "client-absent" });
    expect(result.clients[0]?.manualCommand).toBe("tl clients snippet --client copilot-cli");
  });

  it("registers the documented shape (type:local, tools:['*']) into ~/.copilot/mcp-config.json", async () => {
    const launcher = fixtureLauncher();
    const homeDir = join(tmpdir(), `tl-copilot-${randomUUID()}`);
    mkdirSync(join(homeDir, ".copilot"), { recursive: true });
    const configPath = copilotConfigFor(homeDir);

    const result = await registerClients(["copilot-cli"], { launcher, homeDir });
    expect(result.ok).toBe(true);
    expect(result.clients[0]).toMatchObject({ client: "copilot-cli", state: "registered-managed" });

    const doc = JSON.parse(readFileSync(configPath, "utf8"));
    expect(doc.mcpServers.tokenlighten).toMatchObject({
      type: "local",
      command: launcher.command,
      tools: ["*"],
    });
    expect(doc.mcpServers.tokenlighten.env.TOKENLIGHTEN_MANAGED).toBe("1");
  });

  it("reports registered-foreign for a non-managed entry and blocks register/unregister without --force", async () => {
    const launcher = fixtureLauncher();
    const homeDir = join(tmpdir(), `tl-copilot-foreign-${randomUUID()}`);
    mkdirSync(join(homeDir, ".copilot"), { recursive: true });
    const configPath = copilotConfigFor(homeDir);
    writeFileSync(configPath, JSON.stringify({ mcpServers: { tokenlighten: { type: "local", command: "someone-elses" } } }, null, 2));

    const status = await getClientStatuses(["copilot-cli"], { launcher, homeDir });
    expect(status.clients[0]).toMatchObject({ client: "copilot-cli", state: "registered-foreign" });

    const refused = await registerClients(["copilot-cli"], { launcher, homeDir }, false);
    expect(refused.ok).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.tokenlighten.command).toBe("someone-elses");

    const forced = await registerClients(["copilot-cli"], { launcher, homeDir }, true);
    expect(forced.ok).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.tokenlighten.command).toBe(launcher.command);
  });

  it("unregisters a managed entry, leaving the file's other keys untouched", async () => {
    const launcher = fixtureLauncher();
    const homeDir = join(tmpdir(), `tl-copilot-unreg-${randomUUID()}`);
    mkdirSync(join(homeDir, ".copilot"), { recursive: true });
    await registerClients(["copilot-cli"], { launcher, homeDir });
    const configPath = copilotConfigFor(homeDir);
    const before = JSON.parse(readFileSync(configPath, "utf8"));
    before.mcpServers.other = { command: "keep-me" };
    writeFileSync(configPath, JSON.stringify(before, null, 2));

    const result = await unregisterClients(["copilot-cli"], { launcher, homeDir });
    expect(result.ok).toBe(true);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.mcpServers.tokenlighten).toBeUndefined();
    expect(after.mcpServers.other).toEqual({ command: "keep-me" });
  });
});

describe("tl clients snippet", () => {
  it("returns the documented shapes for every registration client plus the snippet-only rows", async () => {
    const { buildClientSnippet } = await import("../commands/clients.js");
    const launcher = fixtureLauncher();

    const claudeCode = buildClientSnippet("claude-code", { launcher });
    expect(claudeCode.mechanism).toBe("vendor-cli");
    expect(claudeCode.json?.mcpServers).toBeDefined();
    expect(claudeCode.addCommand).toContain("claude mcp add-json");

    const codex = buildClientSnippet("codex", { launcher });
    expect(codex.json?.mcp_servers).toBeDefined();
    expect(codex.addCommand).toContain("codex mcp add");

    const gemini = buildClientSnippet("gemini", { launcher });
    expect(gemini.file).toBe("~/.gemini/settings.json");
    expect(gemini.addCommand).toContain("gemini mcp add");

    const copilotCli = buildClientSnippet("copilot-cli", { launcher, homeDir: "/home/example" });
    expect(copilotCli.mechanism).toBe("config-file");
    expect(copilotCli.file).toBe(join("/home/example", ".copilot", "mcp-config.json"));
    expect(copilotCli.addCommand).toBeUndefined();

    const vscodeUser = buildClientSnippet("vscode-user", { launcher });
    expect(vscodeUser.mechanism).toBe("snippet");
    expect((vscodeUser.json as { servers?: unknown })?.servers).toBeDefined();

    const zed = buildClientSnippet("zed", { launcher });
    expect((zed.json as { context_servers?: unknown })?.context_servers).toBeDefined();

    const opencode = buildClientSnippet("opencode", { launcher });
    expect((opencode.json as { mcp?: unknown })?.mcp).toBeDefined();

    const codexUser = buildClientSnippet("codex-user", { launcher });
    expect(codexUser.toml).toContain("[mcp_servers.tokenlighten]");

    const geminiSettings = buildClientSnippet("gemini-settings", { launcher });
    expect(geminiSettings.file).toBe("~/.gemini/settings.json");

    const generic = buildClientSnippet("generic", { launcher });
    expect(generic.client).toBe("generic");
    expect((generic.json as { mcpServers?: unknown })?.mcpServers).toBeDefined();
  });

  it("CLI dispatch reports an unknown --client as a handled error, not a crash", async () => {
    const { runClients } = await import("../commands/clients.js");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runClients(["snippet", "--client", "not-a-real-client"]);
    } finally {
      stderr.mockRestore();
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
