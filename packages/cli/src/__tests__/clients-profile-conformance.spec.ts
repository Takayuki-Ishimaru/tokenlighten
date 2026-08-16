import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { injectAll } from "@tokenlighten/agents-md";
import { advertisedTools } from "@tokenlighten/mcp-server";
import { type TokenLightenRegistrationClient } from "@tokenlighten/types";
import {
  registerClients,
  setClientProfile,
  type ClientCommandRunner,
  type CommandResult,
} from "../commands/clients.js";
import type { StableLauncher } from "../launcher.js";

const START = "<!-- tokenlighten:mcp-instructions:start -->";
const END = "<!-- tokenlighten:mcp-instructions:end -->";
const GUIDE_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/tokenlighten.mdc",
  ".clinerules/tokenlighten.md",
  ".continue/rules/tokenlighten.md",
] as const;

// The guide-freeze pin. Phase 1 froze the managed guide at v66 so no wave
// could bump it ahead of the wire; protocol v1 P2 / C2-12 is the item defined
// to LIFT that freeze (§6.3: "the guide and the wire are one contract — one
// bump, no v66-compatible mode"), so the pin moves to v67 and the negative
// assertion below now guards against the RETIRED version resurfacing.
// Deliberately still a literal: the point is to fail on an unintended bump.
const FROZEN_GUIDE_VERSION = "2026-08-15-v67-protocol-v1-kinds";
const RETIRED_GUIDE_VERSION = "2026-08-13-v66-prepared-receipt-honesty";

// Measured from the real advertised schema at test runtime -- never a
// literal. A schema change moves this number automatically, so the
// fixed-tax arithmetic below cannot drift the way a hand-pinned baseline
// (the round-3 5,096 constant) did the moment C-6 grew the schema to
// 7,054 B. schemaSize.spec.ts remains the sole ceiling authority.
const MEASURED_ADVERTISED_SCHEMA_BYTES = Buffer.byteLength(
  JSON.stringify(advertisedTools()),
  "utf8",
);

function measureConfigTax(
  root: string,
  entries: ReadonlyMap<TokenLightenRegistrationClient, FakeEntry>,
): {
  tokenLightenEntryPresent: boolean;
  vendorEntryBytes: number;
  advertisedSchemaBytes: number;
  managedBlockCount: number;
  managedGuideBytes: number;
  fixedTaxBytes: number;
} {
  const entry = entries.get("codex");
  let managedBlockCount = 0;
  let managedGuideBytes = 0;

  for (const relativePath of GUIDE_PATHS) {
    const path = join(root, relativePath);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    let offset = 0;
    while (true) {
      const start = content.indexOf(START, offset);
      if (start < 0) break;
      const interiorStart = start + START.length;
      const end = content.indexOf(END, interiorStart);
      if (end < 0) throw new Error(`unterminated managed block in ${relativePath}`);
      managedBlockCount += 1;
      managedGuideBytes += Buffer.byteLength(
        content.slice(interiorStart, end),
        "utf8",
      );
      offset = end + END.length;
    }
  }

  const advertisedSchemaBytes = entry ? MEASURED_ADVERTISED_SCHEMA_BYTES : 0;
  return {
    tokenLightenEntryPresent: entry !== undefined,
    vendorEntryBytes: entry ? Buffer.byteLength(JSON.stringify(entry), "utf8") : 0,
    advertisedSchemaBytes,
    managedBlockCount,
    managedGuideBytes,
    fixedTaxBytes: advertisedSchemaBytes + managedGuideBytes,
  };
}

function configMeasurementVendor(): {
  entries: Map<TokenLightenRegistrationClient, FakeEntry>;
  runner: ClientCommandRunner;
} {
  const entries = new Map<TokenLightenRegistrationClient, FakeEntry>();
  const result = (status: number, stdout = "", stderr = ""): CommandResult => ({
    status,
    stdout,
    stderr,
  });
  const runner: ClientCommandRunner = async (command, readonlyArgs) => {
    const args = [...readonlyArgs];
    if (args.length === 1 && args[0] === "version") {
      return result(0, "tl 0.9.0\n");
    }
    if (args.length === 1 && args[0] === "--version") {
      return result(0, `${command} 1.2.3\n`);
    }
    if (args[0] === "mcp" && args[1] === "get") {
      const entry = entries.get("codex");
      return entry ? result(0, JSON.stringify(entry)) : result(1, "", "not found");
    }
    if (args[0] === "mcp" && args[1] === "add") {
      const separator = args.indexOf("--");
      const env: Record<string, string> = {};
      for (let index = 3; index < separator; index += 1) {
        if (args[index] !== "--env") continue;
        const [key, ...value] = (args[index + 1] ?? "").split("=");
        if (key) env[key] = value.join("=");
        index += 1;
      }
      entries.set("codex", {
        command: args[separator + 1] ?? "",
        args: args.slice(separator + 2),
        env,
      });
      return result(0);
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      entries.delete("codex");
      return result(0);
    }
    return result(2, "", "unexpected invocation");
  };
  return { entries, runner };
}

describe("X-3 config-only negative control", () => {
  it("measures zero fixed tax for native and a positive schema plus guide tax for tl", async () => {
    const root = join(tmpdir(), `tl-config-measurement-${randomUUID()}`);
    const launcherPath = join(root, ".bin", process.platform === "win32" ? "tl.cmd" : "tl");
    mkdirSync(dirname(launcherPath), { recursive: true });
    writeFileSync(
      launcherPath,
      process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    );
    const launcher: StableLauncher = {
      command: launcherPath,
      argsPrefix: [],
      env: {},
      source: "managed-shim",
    };
    const vendor = configMeasurementVendor();

    try {
      const neverInstalled = measureConfigTax(root, vendor.entries);
      expect(neverInstalled).toEqual({
        tokenLightenEntryPresent: false,
        vendorEntryBytes: 0,
        advertisedSchemaBytes: 0,
        managedBlockCount: 0,
        managedGuideBytes: 0,
        fixedTaxBytes: 0,
      });

      const tl = await setClientProfile(
        ["codex"],
        "tl",
        { runner: vendor.runner, launcher },
        false,
        root,
      );
      expect(tl).toMatchObject({ ok: true, profileReady: true });

      const active = measureConfigTax(root, vendor.entries);
      expect(active.tokenLightenEntryPresent).toBe(true);
      expect(active.vendorEntryBytes).toBeGreaterThan(0);
      expect(active.advertisedSchemaBytes).toBe(MEASURED_ADVERTISED_SCHEMA_BYTES);
      expect(active.advertisedSchemaBytes).toBeGreaterThan(0);
      expect(active.managedBlockCount).toBe(GUIDE_PATHS.length);
      expect(active.managedGuideBytes).toBeGreaterThan(0);
      expect(active.fixedTaxBytes).toBe(
        active.advertisedSchemaBytes + active.managedGuideBytes,
      );
      for (const relativePath of GUIDE_PATHS) {
        const content = readFileSync(join(root, relativePath), "utf8");
        expect(content).toContain(FROZEN_GUIDE_VERSION);
        expect(content).not.toContain(RETIRED_GUIDE_VERSION);
      }

      const native = await setClientProfile(
        ["codex"],
        "native",
        { runner: vendor.runner, launcher },
        false,
        root,
      );
      expect(native).toMatchObject({ ok: true, profileReady: true });
      expect(measureConfigTax(root, vendor.entries)).toEqual(neverInstalled);

      const emptyBlockRoot = join(root, "empty-block-control");
      mkdirSync(emptyBlockRoot, { recursive: true });
      writeFileSync(join(emptyBlockRoot, "AGENTS.md"), `${START}${END}`);
      const emptyBlock = measureConfigTax(emptyBlockRoot, vendor.entries);
      expect(emptyBlock.managedGuideBytes).toBe(0);
      expect(emptyBlock.managedBlockCount).toBe(1);
      expect(emptyBlock).not.toEqual(neverInstalled);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface FakeEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface FakeVendorOptions {
  initial?: Partial<Record<TokenLightenRegistrationClient, FakeEntry>>;
  onAdd?: () => void;
  onRemove?: () => void;
}

function fixtureRoot(label: string): string {
  const root = join(tmpdir(), `tl-profile-conformance-${label}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function fixtureLauncher(root: string): StableLauncher {
  const directory = join(root, ".launcher");
  mkdirSync(directory, { recursive: true });
  const command = join(directory, process.platform === "win32" ? "tl.cmd" : "tl");
  writeFileSync(
    command,
    process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
  );
  return { command, argsPrefix: [], env: {}, source: "managed-shim" };
}

function guidePath(root: string, relative: string): string {
  return join(root, relative);
}

function writeUserGuides(root: string): Map<string, { prefix: string; suffix: string }> {
  const boundaries = new Map<string, { prefix: string; suffix: string }>();
  for (const [index, relative] of GUIDE_PATHS.entries()) {
    const path = guidePath(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    const prefix = `user-prefix-${index}\n`;
    const suffix = `user-suffix-${index}\n`;
    writeFileSync(path, prefix + suffix);
    boundaries.set(relative, { prefix, suffix });
  }
  return boundaries;
}

function snapshotGuides(root: string): Map<string, string> {
  return new Map(
    GUIDE_PATHS.map((relative) => [
      relative,
      readFileSync(guidePath(root, relative), "utf8"),
    ]),
  );
}

function expectNoManagedBlocks(root: string): void {
  for (const relative of GUIDE_PATHS) {
    const path = guidePath(root, relative);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    expect(text, relative).not.toContain(START);
    expect(text, relative).not.toContain(END);
  }
}

function expectManagedBlocks(root: string): void {
  for (const relative of GUIDE_PATHS) {
    const text = readFileSync(guidePath(root, relative), "utf8");
    expect(text, relative).toContain(START);
    expect(text, relative).toContain(END);
  }
}

function expectUserBoundaries(
  root: string,
  boundaries: ReadonlyMap<string, { prefix: string; suffix: string }>,
): void {
  for (const [relative, boundary] of boundaries) {
    const text = readFileSync(guidePath(root, relative), "utf8");
    expect(text.split(boundary.prefix), relative).toHaveLength(2);
    expect(text.split(boundary.suffix), relative).toHaveLength(2);
  }
}

function fakeVendor(options: FakeVendorOptions = {}) {
  const entries = new Map<TokenLightenRegistrationClient, FakeEntry>(
    Object.entries(options.initial ?? {}) as [TokenLightenRegistrationClient, FakeEntry][],
  );
  const calls: { command: string; args: string[] }[] = [];
  const control = { failAdd: false, failRemove: false };
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
      options.onAdd?.();
      if (control.failAdd) return result(1, "", "injected add failure");
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
      return result(0);
    }
    if (args[0] === "mcp" && args[1] === "remove") {
      options.onRemove?.();
      if (control.failRemove) return result(1, "", "injected remove failure");
      entries.delete(client);
      return result(0);
    }
    return result(2, "", "unexpected invocation");
  };

  return { calls, control, entries, runner };
}

describe("tl clients profile config-boundary conformance", () => {
  it("fails closed on a foreign entry before touching any guide", async () => {
    const root = fixtureRoot("foreign");
    const launcher = fixtureLauncher(root);
    const boundaries = writeUserGuides(root);
    try {
      await injectAll({ repoRoot: root, force: true });
      const before = snapshotGuides(root);
      const foreign: FakeEntry = {
        command: "/foreign/tl",
        args: ["mcp", "start"],
        env: {},
      };
      const vendor = fakeVendor({ initial: { codex: foreign } });

      const profile = await setClientProfile(
        ["codex"],
        "native",
        { runner: vendor.runner, launcher },
        false,
        root,
      );

      expect(profile).toMatchObject({
        ok: false,
        profileReady: false,
        changedClients: [],
      });
      expect(snapshotGuides(root)).toEqual(before);
      expectUserBoundaries(root, boundaries);
      expect(vendor.entries.get("codex")).toEqual(foreign);
      expect(vendor.calls.some((call) => call.args[1] === "remove")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes every guide before unregistering and preserves all user boundaries", async () => {
    const root = fixtureRoot("native-order");
    const launcher = fixtureLauncher(root);
    const boundaries = writeUserGuides(root);
    let removeObserved = false;
    try {
      await injectAll({ repoRoot: root, force: true });
      expectManagedBlocks(root);
      expectUserBoundaries(root, boundaries);
      const vendor = fakeVendor({
        onRemove: () => {
          removeObserved = true;
          expectNoManagedBlocks(root);
          expectUserBoundaries(root, boundaries);
        },
      });
      await registerClients(["codex"], { runner: vendor.runner, launcher });

      const profile = await setClientProfile(
        ["codex"],
        "native",
        { runner: vendor.runner, launcher },
        false,
        root,
      );

      expect(removeObserved).toBe(true);
      expect(profile).toMatchObject({
        ok: true,
        profileReady: true,
        changedClients: ["codex"],
      });
      expect(profile.guideChanged).toHaveLength(6);
      expect(vendor.entries.has("codex")).toBe(false);
      expectNoManagedBlocks(root);
      expectUserBoundaries(root, boundaries);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects a duplicate sentinel and never unregisters after partial guide removal", async () => {
    const root = fixtureRoot("duplicate");
    const launcher = fixtureLauncher(root);
    try {
      await injectAll({ repoRoot: root, force: true });
      const agents = guidePath(root, "AGENTS.md");
      const malformed = `${readFileSync(agents, "utf8")}\n${START}\n`;
      writeFileSync(agents, malformed);
      const vendor = fakeVendor();
      await registerClients(["codex"], { runner: vendor.runner, launcher });
      const callsBefore = vendor.calls.length;

      const profile = await setClientProfile(
        ["codex"],
        "native",
        { runner: vendor.runner, launcher },
        false,
        root,
      );

      expect(profile).toMatchObject({
        ok: false,
        profileReady: false,
        changedClients: [],
      });
      expect(profile.guideErrors?.join("\n")).toContain("malformed-managed-block");
      expect(readFileSync(agents, "utf8")).toBe(malformed);
      expect(profile.guideChanged).toHaveLength(5);
      expect(vendor.entries.has("codex")).toBe(true);
      expect(vendor.calls.slice(callsBefore).some((call) => call.args[1] === "remove"))
        .toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not report ready when unregister fails after guide removal", async () => {
    const root = fixtureRoot("unregister-failure");
    const launcher = fixtureLauncher(root);
    let removeObserved = false;
    try {
      await injectAll({ repoRoot: root, force: true });
      const vendor = fakeVendor({
        onRemove: () => {
          removeObserved = true;
          expectNoManagedBlocks(root);
        },
      });
      await registerClients(["codex"], { runner: vendor.runner, launcher });
      vendor.control.failRemove = true;

      const profile = await setClientProfile(
        ["codex"],
        "native",
        { runner: vendor.runner, launcher },
        false,
        root,
      );

      expect(removeObserved).toBe(true);
      expect(profile).toMatchObject({ ok: false, profileReady: false });
      expect(profile.warnings.join("\n")).toContain("unregister failed");
      expect(vendor.entries.has("codex")).toBe(true);
      expectNoManagedBlocks(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers MCP before injecting all guides and preserves their user boundaries", async () => {
    const root = fixtureRoot("tl-order");
    const launcher = fixtureLauncher(root);
    const boundaries = writeUserGuides(root);
    let addObserved = false;
    try {
      const vendor = fakeVendor({
        onAdd: () => {
          addObserved = true;
          expectNoManagedBlocks(root);
          expectUserBoundaries(root, boundaries);
        },
      });

      const profile = await setClientProfile(
        ["codex"],
        "tl",
        { runner: vendor.runner, launcher },
        false,
        root,
      );

      expect(addObserved).toBe(true);
      expect(profile).toMatchObject({
        ok: true,
        profileReady: true,
        changedClients: ["codex"],
      });
      expect(profile.guideChanged).toHaveLength(6);
      expect(vendor.entries.has("codex")).toBe(true);
      expectManagedBlocks(root);
      expectUserBoundaries(root, boundaries);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not inject guides when MCP registration fails", async () => {
    const root = fixtureRoot("register-failure");
    const launcher = fixtureLauncher(root);
    const boundaries = writeUserGuides(root);
    const before = snapshotGuides(root);
    try {
      const vendor = fakeVendor();
      vendor.control.failAdd = true;

      const profile = await setClientProfile(
        ["codex"],
        "tl",
        { runner: vendor.runner, launcher },
        false,
        root,
      );

      expect(profile).toMatchObject({
        ok: false,
        profileReady: false,
        changedClients: [],
      });
      expect(profile.guideErrors).toEqual([
        "guide operation skipped because managed MCP profile change did not succeed",
      ]);
      expect(snapshotGuides(root)).toEqual(before);
      expectUserBoundaries(root, boundaries);
      expectNoManagedBlocks(root);
      expect(vendor.entries.has("codex")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the registered MCP entry when guide injection rejects duplicate sentinels", async () => {
    const root = fixtureRoot("inject-failure");
    const launcher = fixtureLauncher(root);
    const agents = guidePath(root, "AGENTS.md");
    mkdirSync(dirname(agents), { recursive: true });
    const malformed = `user-owned\n${START}\nfirst\n${START}\nsecond\n${END}\n`;
    writeFileSync(agents, malformed);
    try {
      const vendor = fakeVendor();

      const profile = await setClientProfile(
        ["codex"],
        "tl",
        { runner: vendor.runner, launcher },
        false,
        root,
      );

      expect(profile).toMatchObject({ ok: false, profileReady: false });
      expect(profile.guideErrors?.join("\n"))
        .toContain("malformed sentinels (start=2, end=1)");
      expect(readFileSync(agents, "utf8")).toBe(malformed);
      expect(vendor.entries.has("codex")).toBe(true);
      expect(profile.guideChanged).toHaveLength(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins profileReady when an absent CLI leaves vendor config presence unverified", async () => {
    const root = fixtureRoot("ready-current-semantics");
    try {
      await injectAll({ repoRoot: root, force: true });
      const runner: ClientCommandRunner = async () => ({
        status: null,
        stdout: "",
        stderr: "",
        errorCode: "ENOENT",
      });

      const profile = await setClientProfile(
        ["codex"],
        "native",
        { runner, vendorConfigProbe: () => true },
        false,
        root,
      );

      expect(profile).toMatchObject({
        ok: true,
        profileReady: true,
        changedClients: [],
        clients: [{
          state: "client-absent",
          vendorConfigPresent: true,
        }],
      });
      expectNoManagedBlocks(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
