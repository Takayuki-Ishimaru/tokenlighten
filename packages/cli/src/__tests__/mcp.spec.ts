/**
 * mcp.spec.ts — tests for 'tl mcp' command.
 *
 * Coverage:
 *   - spawn args: shell:false verified, argv array structure correct
 *   - --allow-write flag forwarded
 *   - Envelope ban: no meta envelope
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TEST_RUNTIME_HOME = join(tmpdir(), `tokenlighten-cli-test-${process.pid}`);

// ---------------------------------------------------------------------------
// ensurePrereqs mock
// ---------------------------------------------------------------------------

const mockEnsurePrereqs = vi.fn(async () => {});

vi.mock("../prereqs.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../prereqs.js")>();
  return {
    ...original,
    ensurePrereqs: mockEnsurePrereqs,
    detectPrereqs: vi.fn(async () => []),
    buildPrereqContext: vi.fn(async () => ({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    })),
  };
});

// ---------------------------------------------------------------------------
// Envelope ban guard
// ---------------------------------------------------------------------------

describe("envelope ban — mcp.ts source must not contain meta envelope", () => {
  it("mcp.ts source does not contain <!-- tokenlighten:meta", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    const dir = typeof __dirname !== "undefined" ? __dirname : ".";
    const srcPath = join(dir, "..", "commands", "mcp.ts");
    expect(existsSync(srcPath)).toBe(true);
    const src = readFileSync(srcPath, "utf-8") as string;
    expect(/<!--\s*tokenlighten:meta/i.test(src)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared mock setup
// ---------------------------------------------------------------------------

let lastSpawnCall: { cmd: string; argv: string[]; opts: Record<string, unknown> } | null = null;
let lastPidFileData: Record<string, unknown> | null = null;

vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    spawn: vi.fn((...args: unknown[]) => {
      const [cmd, argv, opts] = args as [string, string[], Record<string, unknown>];
      lastSpawnCall = { cmd, argv, opts };
      return {
        pid: 99002,
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (event === "exit") cb(0);
        }),
      };
    }),
  };
});

vi.mock("../process.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../process.js")>();
  return {
    ...original,
    writePidFile: vi.fn((_path: string, data: Record<string, unknown>) => {
      lastPidFileData = data;
    }),
    readPidFile: vi.fn().mockReturnValue(null),
    removePidFile: vi.fn(),
    isPidAlive: vi.fn().mockReturnValue(false),
    stopMcp: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp start — argv structure (shell:false)", () => {
  beforeEach(() => {
    lastSpawnCall = null;
    lastPidFileData = null;
    process.env["TOKENLIGHTEN_REPO_ROOT"] = "/fake/repo";
    process.env["TOKENLIGHTEN_RUNTIME_HOME"] = TEST_RUNTIME_HOME;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env["TOKENLIGHTEN_REPO_ROOT"];
    delete process.env["TOKENLIGHTEN_RUNTIME_HOME"];
  });

  it("uses shell:false when spawning the MCP server", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start"]).catch(() => {});

    expect(lastSpawnCall).not.toBeNull();
    expect(lastSpawnCall!.opts["shell"]).toBeFalsy();
  });

  it("includes --allow-write in argv when flag is set", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start", "--allow-write"]).catch(() => {});

    expect(lastSpawnCall).not.toBeNull();
    expect(lastSpawnCall!.argv).toContain("--allow-write");
  });

  it("does NOT include --allow-write in argv when flag is absent", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start"]).catch(() => {});

    expect(lastSpawnCall).not.toBeNull();
    expect(lastSpawnCall!.argv).not.toContain("--allow-write");
  });

  it("forwards repeatable --allowed-parent entries as argv pairs", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp([
      "start",
      "--allowed-parent", "/private/var/tmp/tl-bench-worktrees",
      "--allowed-parent", "/srv/tokenlighten-worktrees",
    ]).catch(() => {});

    expect(lastSpawnCall).not.toBeNull();
    expect(lastSpawnCall!.argv).toEqual(expect.arrayContaining([
      "--allowed-parent", "/private/var/tmp/tl-bench-worktrees",
      "/srv/tokenlighten-worktrees",
    ]));
    expect(lastSpawnCall!.argv.filter((arg) => arg === "--allowed-parent")).toHaveLength(2);
  });

  it("spawns via process.execPath (Node binary), not shell", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start"]).catch(() => {});

    expect(lastSpawnCall).not.toBeNull();
    // The command should be process.execPath (node binary)
    expect(lastSpawnCall!.cmd).toBe(process.execPath);
  });

  it("stores the MCP entry path as a quote-independent process identity token", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start"]).catch(() => {});

    expect(lastPidFileData).not.toBeNull();
    expect(lastPidFileData!["identity_token"]).toMatch(/mcp-server[/\\]dist[/\\]bin\.js$/);
  });
});

// ---------------------------------------------------------------------------
// Pre-flight: ensurePrereqs integration
// ---------------------------------------------------------------------------

describe("mcp start — ensurePrereqs pre-flight", () => {
  beforeEach(() => {
    lastSpawnCall = null;
    mockEnsurePrereqs.mockClear();
    process.env["TOKENLIGHTEN_REPO_ROOT"] = "/fake/repo";
    process.env["TOKENLIGHTEN_RUNTIME_HOME"] = TEST_RUNTIME_HOME;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env["TOKENLIGHTEN_REPO_ROOT"];
    delete process.env["TOKENLIGHTEN_RUNTIME_HOME"];
  });

  it("calls ensurePrereqs with ['node'] on start without --allow-write", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start"]).catch(() => {});

    expect(mockEnsurePrereqs).toHaveBeenCalledWith(
      expect.arrayContaining(["node"]),
      expect.anything()
    );
    expect(mockEnsurePrereqs).not.toHaveBeenCalledWith(
      expect.arrayContaining(["git"]),
      expect.anything()
    );
  });

  it("calls ensurePrereqs with ['git'] when --allow-write is set", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start", "--allow-write"]).catch(() => {});

    expect(mockEnsurePrereqs).toHaveBeenCalledWith(
      expect.arrayContaining(["git"]),
      expect.anything()
    );
  });

  it("passes noPrereqCheck=true when --no-prereq-check is present", async () => {
    vi.doMock("fs", async (importOriginal) => {
      const original = await importOriginal<typeof import("fs")>();
      return { ...original, existsSync: vi.fn().mockReturnValue(true) };
    });

    vi.resetModules();

    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start", "--no-prereq-check"]).catch(() => {});

    expect(mockEnsurePrereqs).toHaveBeenCalledWith(
      expect.anything(),
      true
    );
  });
});

// ---------------------------------------------------------------------------
// resolveMcpBin — primary (require.resolve) path never needs repo-root
// ---------------------------------------------------------------------------
//
// Regression coverage for making resolveMcpBin() self-contained:
// resolveRepoRoot() (a TokenLighten-repo-specific sentinel-file walk) used
// to be called UNCONDITIONALLY before resolveMcpBin, even when
// @tokenlighten/mcp-server resolves fine via node_modules — which made
// `tl mcp start` throw "TokenLighten repo root not found" in every
// environment lacking those sentinels, including this monorepo's own dev
// checkout (TOKENLIGHTEN_REPO_ROOT is only ever set in the describe blocks
// above to route AROUND that; this block deliberately leaves it unset).
// fs.existsSync is deliberately left real (not doMock'd like the blocks
// above) so require.resolve("@tokenlighten/mcp-server") resolving via this
// monorepo's actual node_modules hoisting is what proves the fix, not a
// mock standing in for it.
describe("mcp start — resolveMcpBin primary path (real require.resolve, no TOKENLIGHTEN_REPO_ROOT)", () => {
  beforeEach(() => {
    lastSpawnCall = null;
    lastPidFileData = null;
    delete process.env["TOKENLIGHTEN_REPO_ROOT"];
    process.env["TOKENLIGHTEN_RUNTIME_HOME"] = TEST_RUNTIME_HOME;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env["TOKENLIGHTEN_RUNTIME_HOME"];
  });

  it("spawns the real node_modules-resolved mcp-server bin.js without ever needing TOKENLIGHTEN_REPO_ROOT", async () => {
    vi.resetModules();
    const { runMcp } = await import("../commands/mcp.js");
    await runMcp(["start"]).catch(() => {});

    expect(lastSpawnCall).not.toBeNull();
    expect(lastPidFileData).not.toBeNull();
    expect(lastPidFileData!["identity_token"]).toMatch(/mcp-server[/\\]dist[/\\]bin\.js$/);
    // Resolved via the real @tokenlighten/mcp-server package, not the
    // /fake/repo fallback the describe blocks above exercise.
    expect(lastPidFileData!["identity_token"]).not.toMatch(/fake[/\\]repo/);
  });
});

// ---------------------------------------------------------------------------
// resolveMcpBin — actionable error when BOTH resolutions fail
// ---------------------------------------------------------------------------
//
// Regression coverage for hardening resolveMcpBin()'s fallback: when
// require.resolve("@tokenlighten/mcp-server") fails (a real consumer
// install missing the package) AND the monorepo sentinel-walk fallback
// (resolveRepoRoot()) ALSO fails (not a checkout of this monorepo),
// resolveMcpBin() used to let resolveRepoRoot()'s own "TokenLighten repo
// root not found (set TOKENLIGHTEN_REPO_ROOT)" error surface verbatim —
// meaningless outside this monorepo. It must instead throw an actionable
// error naming the missing package and the repair step.
describe("mcp start — resolveMcpBin actionable error (both resolutions fail)", () => {
  beforeEach(() => {
    lastSpawnCall = null;
    lastPidFileData = null;
    delete process.env["TOKENLIGHTEN_REPO_ROOT"];
    process.env["TOKENLIGHTEN_RUNTIME_HOME"] = TEST_RUNTIME_HOME;
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock("node:module");
    vi.doUnmock("../repoRoot.js");
    delete process.env["TOKENLIGHTEN_RUNTIME_HOME"];
  });

  it("throws an actionable error naming @tokenlighten/mcp-server and the repair step, not the sentinel-walk error", async () => {
    vi.doMock("node:module", async (importOriginal) => {
      const original = await importOriginal<typeof import("node:module")>();
      const fakeRequire = ((id: string) => {
        throw new Error(`unexpected require() call for '${id}' in test`);
      }) as unknown as NodeRequire;
      fakeRequire.resolve = ((id: string) => {
        const err = new Error(`Cannot find module '${id}'`) as NodeJS.ErrnoException;
        err.code = "MODULE_NOT_FOUND";
        throw err;
      }) as unknown as RequireResolve;
      return { ...original, createRequire: () => fakeRequire };
    });

    vi.doMock("../repoRoot.js", async (importOriginal) => {
      const original = await importOriginal<typeof import("../repoRoot.js")>();
      return {
        ...original,
        resolveRepoRoot: vi.fn(() => {
          throw new Error("TokenLighten repo root not found (set TOKENLIGHTEN_REPO_ROOT)");
        }),
      };
    });

    vi.resetModules();
    const { runMcp } = await import("../commands/mcp.js");

    let caught: unknown;
    try {
      await runMcp(["start"]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/@tokenlighten\/mcp-server/);
    expect(message).toMatch(/Reinstall @tokenlighten\/cli/);
    expect(message).toMatch(/npm install @tokenlighten\/mcp-server/);
    expect(message).not.toMatch(/TokenLighten repo root not found/);
    expect(lastSpawnCall).toBeNull();
  });
});
