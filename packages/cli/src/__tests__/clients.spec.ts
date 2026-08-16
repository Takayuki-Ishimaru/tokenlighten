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
import { describe, expect, it } from "vitest";
import {
  defaultClientCommandRunner,
  getClientStatuses,
  registerClients,
  unregisterClients,
  type ClientCommandRunner,
  type CommandResult,
} from "../commands/clients.js";
import { managedLauncherPath, type StableLauncher } from "../launcher.js";
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
      expect(result.guidePlanned).toHaveLength(6);
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
      expect(result.guideChanged).toHaveLength(6);
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
    const result = await registerClients(["claude-code"], { runner, homeDir });
    expect(result.ok).toBe(false);
    expect(existsSync(managedLauncherPath({ homeDir }))).toBe(false);
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
