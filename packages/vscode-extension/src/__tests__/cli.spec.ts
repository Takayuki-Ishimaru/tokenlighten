/**
 * cli.spec.ts — unit tests for cli.ts
 *
 * Invariants verified:
 *   - shell:false is always passed to spawn
 *   - args are passed as an array (no PATH injection via string concatenation)
 *   - stdout/stderr/code are captured correctly
 *   - ENOENT returns code:null + stderr:'tl not found' (no UI prompt — §2.4)
 *   - findTlBinary() returns boolean
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockSpawn, mockSpawnSync, mockExistsSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockSpawnSync: vi.fn(),
  // Default: no packaged dist/tl-cli.js next to this compiled file — the
  // real state under vitest (it only ever exists under dist/, never src/)
  // and the dev/F5 layout this suite's pre-existing tests assume.
  mockExistsSync: vi.fn((_path: string) => false),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: (_key: string, def: unknown) => def }),
  },
}));

vi.mock("cross-spawn", () => ({
  default: Object.assign(mockSpawn, { sync: mockSpawnSync }),
}));

vi.mock("node:fs", () => ({ existsSync: mockExistsSync }));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { spawnTl, findTlBinary, getTlVersion } from "../cli.js";
import type { SpawnResult } from "../cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProc(opts: {
  stdout?: string;
  stderr?: string;
  code?: number;
  errorCode?: string;
}): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  setImmediate(() => {
    if (opts.errorCode) {
      const err: NodeJS.ErrnoException = new Error("spawn error");
      err.code = opts.errorCode;
      proc.emit("error", err);
      return;
    }
    if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
    proc.emit("close", opts.code ?? 0);
  });

  return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawnTl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it("passes shell:false to spawn", async () => {
    mockSpawn.mockReturnValue(makeProc({ stdout: "ok", code: 0 }));
    await spawnTl(["status"]);
    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { shell: boolean }];
    expect(options.shell).toBe(false);
  });

  it("passes args as array, not as a string", async () => {
    mockSpawn.mockReturnValue(makeProc({ stdout: "", code: 0 }));
    await spawnTl(["agents-md", "write", "--for-target"]);
    const [bin, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(typeof bin).toBe("string");
    expect(Array.isArray(args)).toBe(true);
    expect(args.slice(-3)).toEqual(["agents-md", "write", "--for-target"]);
  });

  it("captures stdout and stderr in result", async () => {
    mockSpawn.mockReturnValue(makeProc({ stdout: "hello", stderr: "warn", code: 0 }));
    const result: SpawnResult = await spawnTl(["skeleton", "build", "--compact"]);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("warn");
    expect(result.code).toBe(0);
  });

  it("returns non-zero exit code correctly", async () => {
    mockSpawn.mockReturnValue(makeProc({ stdout: "", stderr: "fail", code: 1 }));
    const result = await spawnTl(["skeleton", "build", "--compact"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("fail");
  });

  it("on ENOENT returns code:null and stderr:'tl not found' (no UI prompt)", async () => {
    mockSpawn.mockReturnValue(makeProc({ errorCode: "ENOENT" }));
    const result = await spawnTl(["status"]);
    expect(result.code).toBeNull();
    expect(result.stderr).toMatch(/tl not found/i);
  });

  it("does not inject PATH via single string command", async () => {
    mockSpawn.mockReturnValue(makeProc({ code: 0 }));
    await spawnTl(["skeleton", "build", "--compact"]);
    const [bin] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(bin).not.toMatch(/[;&|`$]/);
  });

  it("uses the bundled CLI in the dev/F5 layout when no packaged CLI exists", async () => {
    mockSpawn.mockReturnValue(makeProc({ code: 0 }));
    await spawnTl(["status"]);
    const [bin, args, options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(bin).toBe(process.execPath);
    expect(args[0]).toMatch(/packages[/\\]cli[/\\]dist[/\\]index\.js$/);
    expect(options.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });

  it("prefers the packaged dist/tl-cli.js over node_modules when it exists (simulated packaged .vsix layout)", async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith("tl-cli.js"));
    mockSpawn.mockReturnValue(makeProc({ code: 0 }));
    await spawnTl(["status"]);
    const [bin, args, options] = mockSpawn.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(bin).toBe(process.execPath);
    expect(args[0]).toMatch(/tl-cli\.js$/);
    // Never falls through to the node_modules dist/index.js path once the
    // packaged bundle is found.
    expect(args[0]).not.toMatch(/index\.js$/);
    expect(options.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });

  it("falls through to node_modules dist/index.js when no packaged tl-cli.js exists (simulated dev layout)", async () => {
    mockExistsSync.mockReturnValue(false);
    mockSpawn.mockReturnValue(makeProc({ code: 0 }));
    await spawnTl(["status"]);
    const [bin, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(bin).toBe(process.execPath);
    expect(args[0]).toMatch(/packages[/\\]cli[/\\]dist[/\\]index\.js$/);
  });
});

describe("TL CLI availability and version", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns the semantic version reported by the resolved CLI", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      error: undefined,
      stdout: "TokenLighten 0.9.1\n",
      stderr: "",
    });
    expect(getTlVersion()).toBe("0.9.1");
  });

  it("returns true when spawnSync exits with status 0", () => {
    mockSpawnSync.mockReturnValue({ status: 0, error: undefined });
    expect(findTlBinary()).toBe(true);
  });

  it("returns false when spawnSync throws", () => {
    mockSpawnSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(findTlBinary()).toBe(false);
  });
});
