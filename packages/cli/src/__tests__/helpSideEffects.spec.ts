// Regression coverage for a P0 UX/safety defect: TokenLighten's CLI is a
// hand-rolled argv parser, and every command dispatcher only checked its
// FIRST token against "--help"/"-h". A --help placed after a recognized
// subcommand (e.g. `tl workspace setup --help`) was silently dropped as an
// unrecognized trailing flag, so the real (often side-effecting) action ran
// instead of printing usage. See packages/cli/src/util/helpFlag.ts for the
// shared fix (`wantsHelp`), now checked at the top of every command entry
// point before any dispatch or side effect.
//
// index.ts's own top-level dispatch (`switch (command) { case "--help": ... }`)
// is unaffected: it matches a single exact token and was already correct
// regardless of what follows, so it needed no change and has no tests here.
//
// Each describe block below proves, for one hazardous subcommand:
//   1. `--help` and `-h` print usage, never call process.exit, leave
//      process.exitCode untouched, and cause no observable side effect.
//   2. The same invocation *without* the help flag still performs the real
//      action (a positive control, kept minimal/fast per command).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageWindowStart } from "@tokenlighten/usage";

import { wantsHelp } from "../util/helpFlag.js";
import { runWorkspace } from "../commands/workspace.js";
import { runAgents } from "../commands/agents.js";
import { runSkeleton } from "../commands/skeleton.js";
import { runLogs } from "../commands/logs.js";
import { runClients } from "../commands/clients.js";
import { runConfig } from "../commands/config.js";
import { runSetup } from "../commands/setup.js";
import { runMcp } from "../commands/mcp.js";
import { runInstallHooks } from "../commands/install-hooks.js";

// ─── shared test doubles ───────────────────────────────────────────────────

// `runClients` never accepts an injected runner -- it always resolves the
// real `defaultClientCommandRunner`, which shells out to the vendor
// `claude`/`codex` CLIs via node:child_process's `spawn`. Replace only
// `spawn` (every other export, e.g. execSync as used by skeleton-engine's
// git probing in the skeleton tests below, stays real) so "clients activate"
// can be exercised end-to-end -- proving the guard blocks it and proving the
// real path still dispatches -- without ever touching a real vendor CLI or
// this machine's real global MCP registration.
const spawnCalls = vi.hoisted(() => [] as { command: string; args: string[] }[]);
const spawnMock = vi.hoisted(() =>
  vi.fn((command: string, args: readonly string[], _options?: unknown) => {
    spawnCalls.push({ command, args: [...args] });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (enc: string) => void };
      stderr: EventEmitter & { setEncoding: (enc: string) => void };
    };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    // Every fake vendor binary is "absent": defaultClientCommandRunner's
    // error handler turns this into { status: null, errorCode: "ENOENT" },
    // which clients.ts already treats as an ordinary, harmless
    // "client-absent" state -- so the real (non-help) path can run to
    // completion without mutating anything.
    queueMicrotask(() => {
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    });
    return child as unknown as ChildProcess;
  }),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

// clients.ts and setup.ts both import spawn from "node:child_process" (mocked
// above); mcp.ts imports it from the bare "child_process" specifier instead
// (confirmed by reading mcp.ts's own imports, and by mcp.spec.ts's existing
// `vi.mock("child_process", ...)`). Vitest module mocks are matched by the
// exact specifier string a source file imports, so both are mocked
// explicitly here rather than assuming one aliases the other.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: spawnMock };
});

function captureStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

function stdoutText(spy: ReturnType<typeof captureStdout>): string {
  return spy.mock.calls.map((call) => String(call[0])).join("");
}

function stubExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`unexpected process.exit(${code ?? 0})`);
  }) as never);
}

let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  spawnCalls.length = 0;
});

afterEach(() => {
  process.exitCode = savedExitCode;
  vi.restoreAllMocks();
});

// ─── wantsHelp unit coverage ────────────────────────────────────────────────

describe("wantsHelp", () => {
  it("detects --help/-h anywhere in argv, and only those exact tokens", () => {
    expect(wantsHelp([])).toBe(false);
    expect(wantsHelp(["setup"])).toBe(false);
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["setup", "--root", "/tmp/x", "--help"])).toBe(true);
    expect(wantsHelp(["setup", "-h"])).toBe(true);
    expect(wantsHelp(["--helpful"])).toBe(false);
    expect(wantsHelp(["-hx"])).toBe(false);
  });
});

// ─── tl workspace setup --help / -h ────────────────────────────────────────

describe("tl workspace setup --help / -h", () => {
  let base: string;
  let root: string;
  let registryPath: string;
  const fixtureLauncher = { command: "tl-fixture", argsPrefix: [] as string[], env: {} as Record<string, string> };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tl-workspace-help-test-"));
    root = join(base, "workspace");
    registryPath = join(base, "registry", "config.toml");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it.each(["--help", "-h"])("setup %s prints usage and performs no setup", async (flag: string) => {
    const stdout = captureStdout();
    const exit = stubExit();
    await runWorkspace(["setup", "--root", root, "--rules-only", flag], {
      registryPath,
      launcher: fixtureLauncher,
    });
    expect(stdoutText(stdout)).toContain("tl workspace setup");
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(registryPath)).toBe(false);
  });

  it("positive control: setup with no --help really writes rules and records the registry", async () => {
    mkdirSync(root, { recursive: true });
    const stdout = captureStdout();
    await runWorkspace(["setup", "--root", root, "--rules-only"], {
      registryPath,
      launcher: fixtureLauncher,
    });
    void stdout;
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(existsSync(registryPath)).toBe(true);
  });
});

// ─── tl agents update --help / -h ──────────────────────────────────────────

describe("tl agents update --help / -h", () => {
  let sandbox: string;
  let origCwd: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "tl-agents-help-test-"));
    origCwd = process.cwd();
    process.chdir(sandbox);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it.each(["--help", "-h"])("update %s prints usage and writes no guide files", async (flag: string) => {
    const stdout = captureStdout();
    const exit = stubExit();
    await runAgents(["update", "--targets", "claude", flag]);
    expect(stdoutText(stdout)).toContain("Usage: tl agents <subcommand>");
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(false);
    expect(readdirSync(sandbox)).toEqual([]);
  });

  it("positive control: update with no --help really writes AGENTS.md", async () => {
    const stdout = captureStdout();
    await runAgents(["update", "--targets", "claude"]);
    void stdout;
    expect(existsSync(join(sandbox, "AGENTS.md"))).toBe(true);
  });
});

// ─── tl skeleton build --help / -h ─────────────────────────────────────────

describe("tl skeleton build --help / -h", () => {
  let sandbox: string;
  let origCwd: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "tl-skeleton-help-test-"));
    writeFileSync(join(sandbox, "index.js"), "module.exports = 1;\n");
    origCwd = process.cwd();
    process.chdir(sandbox);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it.each(["--help", "-h"])("build %s prints usage and writes no .repo-skeleton.md", async (flag: string) => {
    const before = readdirSync(sandbox).sort();
    const stdout = captureStdout();
    const exit = stubExit();
    await runSkeleton(["build", flag]);
    expect(stdoutText(stdout)).toContain("Usage: tl skeleton <subcommand>");
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(sandbox, ".repo-skeleton.md"))).toBe(false);
    expect(readdirSync(sandbox).sort()).toEqual(before);
  }, 30000);

  it("positive control: build with no --help really writes .repo-skeleton.md", async () => {
    const stdout = captureStdout();
    await runSkeleton(["build"]);
    void stdout;
    expect(existsSync(join(sandbox, ".repo-skeleton.md"))).toBe(true);
  }, 30000);
});

// ─── tl logs reset --help / -h ─────────────────────────────────────────────

describe("tl logs reset --help / -h", () => {
  let logDirectory: string;
  let origLogHome: string | undefined;

  beforeEach(() => {
    origLogHome = process.env["TOKENLIGHTEN_LOG_HOME"];
    logDirectory = join(tmpdir(), `tokenlighten-cli-logs-help-${randomUUID()}`);
    mkdirSync(logDirectory, { recursive: true });
    process.env["TOKENLIGHTEN_LOG_HOME"] = logDirectory;
  });

  afterEach(() => {
    if (origLogHome === undefined) delete process.env["TOKENLIGHTEN_LOG_HOME"];
    else process.env["TOKENLIGHTEN_LOG_HOME"] = origLogHome;
    rmSync(logDirectory, { recursive: true, force: true });
  });

  it.each(["--help", "-h"])("reset %s prints usage and does not reset the usage window", async (flag: string) => {
    const before = usageWindowStart(logDirectory);
    const stdout = captureStdout();
    const exit = stubExit();
    await runLogs(["reset", flag]);
    expect(stdoutText(stdout)).toContain("Usage: tl logs <summary|export|path|reset> [options]");
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(usageWindowStart(logDirectory)).toBe(before);
  });

  it("positive control: reset with no --help really resets the usage window", async () => {
    const before = usageWindowStart(logDirectory);
    const stdout = captureStdout();
    await runLogs(["reset"]);
    void stdout;
    const after = usageWindowStart(logDirectory);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});

// ─── tl clients activate --help / -h ───────────────────────────────────────

describe("tl clients activate --help / -h", () => {
  it.each(["--help", "-h"])("activate %s prints usage and spawns no vendor CLI", async (flag: string) => {
    const stdout = captureStdout();
    const exit = stubExit();
    await runClients(["activate", flag]);
    expect(stdoutText(stdout)).toContain("tl clients activate");
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(spawnCalls).toEqual([]);
  });

  it("positive control: activate with no --help really probes vendor CLIs", async () => {
    const stdout = captureStdout();
    await runClients(["activate"]);
    void stdout;
    expect(spawnCalls.length).toBeGreaterThan(0);
  });
});

// ─── tl config get / set --help / -h ───────────────────────────────────────

describe("tl config get / set --help / -h", () => {
  let configHome: string;
  let origConfigHome: string | undefined;

  beforeEach(() => {
    origConfigHome = process.env["TOKENLIGHTEN_CONFIG_HOME"];
    configHome = join(tmpdir(), `tl-config-help-test-${randomUUID()}`);
    process.env["TOKENLIGHTEN_CONFIG_HOME"] = configHome;
  });

  afterEach(() => {
    if (origConfigHome === undefined) delete process.env["TOKENLIGHTEN_CONFIG_HOME"];
    else process.env["TOKENLIGHTEN_CONFIG_HOME"] = origConfigHome;
    rmSync(configHome, { recursive: true, force: true });
  });

  it.each([
    ["get", "--help"],
    ["get", "-h"],
    ["set", "--help"],
    ["set", "-h"],
  ])("config %s %s prints usage, exits cleanly, and writes no config file", (sub: string, flag: string) => {
    const stdout = captureStdout();
    const exit = stubExit();
    runConfig([sub, flag]);
    expect(stdoutText(stdout)).toContain("Usage: tl config <subcommand>");
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(configHome)).toBe(false);
  });

  it("positive control: config set writes a value and config get reads it back", () => {
    const stdout = captureStdout();
    runConfig(["set", "probe.value", "42"]);
    runConfig(["get", "probe.value"]);
    expect(stdoutText(stdout)).toContain("probe.value = 42");
    expect(existsSync(join(configHome, "config.toml"))).toBe(true);
  });
});

// ─── tl setup --help / -h ──────────────────────────────────────────────────
//
// No positive control here: runSetup's real (non-help) path is fully
// interactive -- OS/package-manager detection, a readline prompt, and (on
// "yes") a real package-manager install via spawn -- and setup.spec.ts
// already exercises all of that exhaustively behind its own heavy mocks
// (../prereqs.js, node:readline/promises, node:child_process). Reusing that
// harness here would duplicate heavy setup for no new signal; a lighter,
// unmocked call risks hanging on a real readline prompt if this
// environment's stdin ever reports isTTY. The guard test below is the
// meaningful, hermetic proof: --help must never reach any of that, which it
// can't whether or not prereqs are satisfied on the machine running this.

describe("tl setup --help / -h", () => {
  it.each(["--help", "-h"])("setup %s prints usage and spawns no package manager", async (flag: string) => {
    const stdout = captureStdout();
    const exit = stubExit();
    await runSetup([flag]);
    expect(stdoutText(stdout)).toContain("Usage: tl setup [--check]");
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(spawnCalls).toEqual([]);
  });
});

// ─── tl mcp start --help / -h ──────────────────────────────────────────────

describe("tl mcp start --help / -h", () => {
  let runtimeHome: string;
  let origRuntimeHome: string | undefined;

  beforeEach(() => {
    origRuntimeHome = process.env["TOKENLIGHTEN_RUNTIME_HOME"];
    runtimeHome = join(tmpdir(), `tl-mcp-help-test-${randomUUID()}`);
    process.env["TOKENLIGHTEN_RUNTIME_HOME"] = runtimeHome;
  });

  afterEach(() => {
    if (origRuntimeHome === undefined) delete process.env["TOKENLIGHTEN_RUNTIME_HOME"];
    else process.env["TOKENLIGHTEN_RUNTIME_HOME"] = origRuntimeHome;
    rmSync(runtimeHome, { recursive: true, force: true });
  });

  it.each(["--help", "-h"])(
    "start %s prints usage, spawns no server, and writes no PID file",
    async (flag: string) => {
      const stdout = captureStdout();
      const exit = stubExit();
      await runMcp(["start", flag]);
      expect(stdoutText(stdout)).toContain("Usage: tl mcp <start|stop|status>");
      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(spawnCalls).toEqual([]);
      // mcpPidPath() resolves via resolvePath("runtime", ..., {ensureDir:true}),
      // so even the runtime directory itself must not have been created --
      // a stronger claim than "no PID file", since that call is the very
      // first thing start/stop/status do once past the guard.
      expect(existsSync(runtimeHome)).toBe(false);
    },
  );

  // Hermetic positive control: "status" reaches mcpPidPath() (which creates
  // the runtime dir as a side effect of ensureDir:true) and reports "down"
  // against a runtime home with no PID file -- all real code, no server
  // spawn, no mocking beyond the file-wide spawn mock above (which "status"
  // never calls). This proves the guard only blocks --help, not real
  // dispatch, without the risk of actually starting a server.
  it("positive control: status with no --help really reaches the status handler", async () => {
    const stdout = captureStdout();
    const exit = stubExit();
    await expect(runMcp(["status"])).rejects.toThrow("unexpected process.exit(1)");
    expect(stdoutText(stdout)).toContain(JSON.stringify({ status: "down" }));
    expect(exit).toHaveBeenCalledWith(1);
    expect(existsSync(runtimeHome)).toBe(true);
  });
});

// ─── tl install-hooks --help / -h ──────────────────────────────────────────

describe("tl install-hooks --help / -h", () => {
  let sandbox: string;
  let origCwd: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "tl-install-hooks-help-test-"));
    // Matches install-hooks.spec.ts's own makeSandbox(): a minimal git repo
    // structure with neither .husky nor lefthook.yml present, so
    // detectMode() resolves to "plain" (.git/hooks/pre-commit).
    mkdirSync(join(sandbox, ".git", "hooks"), { recursive: true });
    origCwd = process.cwd();
    process.chdir(sandbox);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it.each(["--help", "-h"])(
    "install-hooks %s prints usage and writes no hook file",
    async (flag: string) => {
      const before = readdirSync(join(sandbox, ".git", "hooks")).sort();
      const stdout = captureStdout();
      const exit = stubExit();
      await runInstallHooks([flag]);
      expect(stdoutText(stdout)).toContain("Usage: tl install-hooks [--uninstall]");
      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      expect(existsSync(join(sandbox, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(readdirSync(join(sandbox, ".git", "hooks")).sort()).toEqual(before);
    },
  );

  it("positive control: install-hooks with no --help really writes .git/hooks/pre-commit", async () => {
    const stdout = captureStdout();
    const exit = stubExit();
    await expect(runInstallHooks([])).rejects.toThrow("unexpected process.exit(0)");
    void stdout;
    expect(exit).toHaveBeenCalledWith(0);
    const hookPath = join(sandbox, ".git", "hooks", "pre-commit");
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, "utf-8")).toContain("tl skeleton check");
  });
});
