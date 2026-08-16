/**
 * setup.spec.ts — tests for 'tl setup' command.
 *
 * Mocks readline/promises and child_process.spawn.
 * Does NOT actually run winget/brew/apt.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { PrereqStatus, PrereqId } from "../prereqs.js";

// ---------------------------------------------------------------------------
// Envelope ban guard
// ---------------------------------------------------------------------------

describe("envelope ban — setup.ts source must not contain meta envelope", () => {
  it("setup.ts source does not contain <!-- tokenlighten:meta", () => {
    const { readFileSync, existsSync } = require("fs");
    const { join } = require("path");
    const dir = typeof __dirname !== "undefined" ? __dirname : ".";
    const srcPath = join(dir, "..", "commands", "setup.ts");
    expect(existsSync(srcPath)).toBe(true);
    const src = readFileSync(srcPath, "utf-8") as string;
    expect(/<!--\s*tokenlighten:meta/i.test(src)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

// Control what detectPrereqs returns
let mockPrereqStatuses: PrereqStatus[] = [];

// Control readline answers (queue)
let rlAnswers: string[] = [];

// Track spawn calls
let spawnCalls: Array<{ cmd: string; args: string[] }> = [];
let spawnExitCode = 0;

vi.mock("../prereqs.js", async () => {
  return {
    detectPrereqs: vi.fn(async () => mockPrereqStatuses),
    buildPrereqContext: vi.fn(async () => ({
      isTTY: true,
      platform: "linux",
      pmAvailable: {
        winget: false,
        brew: false,
        apt: true,
        dnf: false,
        pacman: false,
        zypper: false,
      },
    })),
    pickInstallCommand: vi.fn(() => ({
      manager: "apt",
      args: ["install", "-y", "nodejs", "npm"],
      docUrl: "https://nodejs.org",
    })),
    ensurePrereqs: vi.fn(async () => {}),
    printManualCommands: vi.fn((_missing: PrereqStatus[], stream: NodeJS.WritableStream) => {
      stream.write("Install commands (run manually):\n");
    }),
  };
});

vi.mock("node:readline/promises", () => {
  return {
    createInterface: vi.fn(() => ({
      question: vi.fn(async () => {
        const ans = rlAnswers.shift() ?? "n";
        return ans;
      }),
      close: vi.fn(),
    })),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((...args: unknown[]) => {
      const [cmd, argv] = args as [string, string[]];
      spawnCalls.push({ cmd, args: argv });
      const listeners: Record<string, ((code: number) => void)[]> = {};
      const child = {
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(cb);
          // Trigger 'exit' asynchronously
          if (event === "exit") {
            setTimeout(() => cb(spawnExitCode), 0);
          }
        }),
      };
      return child;
    }),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatus(
  id: PrereqId,
  found: boolean,
  meetsMin: boolean,
  version: string | null = null,
  managerOverride?: "apt" | "winget" | "brew" | "unknown"
): PrereqStatus {
  const labels: Record<PrereqId, string> = { node: "Node.js", python: "Python", git: "Git" };
  const reqs: Record<PrereqId, string> = { node: ">=20", python: ">=3.11", git: ">=2" };
  const manager = managerOverride ?? "apt";
  return {
    id,
    label: labels[id],
    required: reqs[id],
    found,
    version,
    meetsMin,
    installCommand: found && meetsMin
      ? null
      : manager === "unknown"
        ? { manager: "unknown", args: [], docUrl: `https://${id}.org` }
        : { manager, args: ["install", "-y", id], docUrl: `https://${id}.org` },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  spawnCalls = [];
  rlAnswers = [];
  spawnExitCode = 0;
  mockPrereqStatuses = [];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetModules();
});

describe("runSetup — all prereqs OK", () => {
  it("exits without prompting when all prereqs are satisfied", async () => {
    mockPrereqStatuses = [
      makeStatus("node", true, true, "v22.5.0"),
      makeStatus("python", true, true, "Python 3.12.0"),
      makeStatus("git", true, true, "git version 2.42.0"),
    ];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await runSetup([]);
    } catch {
      // May not throw if no exit called
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    expect(spawnCalls).toHaveLength(0);
  });
});

describe("runSetup — non-interactive mode", () => {
  it("prints commands and exits 1 when isTTY=false", async () => {
    const { buildPrereqContext } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: false,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });

    mockPrereqStatuses = [
      makeStatus("python", false, false, null),
    ];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    try {
      await runSetup([]);
    } catch {
      // expected exit
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }

    expect(exitCode).toBe(1);
    expect(spawnCalls).toHaveLength(0);
    const output = stderrLines.join("\n");
    expect(output).toMatch(/non-interactive/i);
  });
});

describe("runSetup — interactive, user types Y", () => {
  it("spawns install for all missing prereqs when user types Y", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });

    // First call: missing; second call (re-check): all OK
    vi.mocked(detectPrereqs)
      .mockResolvedValueOnce([makeStatus("python", false, false, null)])
      .mockResolvedValueOnce([makeStatus("python", true, true, "Python 3.12.0")]);

    rlAnswers = ["y"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await runSetup([]);
    } catch {
      // may exit 0 or no throw
    } finally {
      exitSpy.mockRestore();
    }

    expect(spawnCalls.length).toBeGreaterThan(0);
    expect(exitCode).toBeUndefined(); // success path doesn't call exit(1)
  });
});

describe("runSetup — interactive, user types 'a' (alias for Y)", () => {
  it("spawns install for all missing prereqs when user types 'a'", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });

    vi.mocked(detectPrereqs)
      .mockResolvedValueOnce([makeStatus("python", false, false, null)])
      .mockResolvedValueOnce([makeStatus("python", true, true, "Python 3.12.0")]);

    rlAnswers = ["a"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await runSetup([]);
    } catch {
      // may exit
    } finally {
      exitSpy.mockRestore();
    }

    expect(spawnCalls.length).toBeGreaterThan(0);
    expect(exitCode).toBeUndefined();
  });
});

describe("runSetup — interactive, user types n", () => {
  it("does NOT spawn and exits 1 with manual hint", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });
    vi.mocked(detectPrereqs).mockResolvedValue([makeStatus("python", false, false, null)]);

    rlAnswers = ["n"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    try {
      await runSetup([]);
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
    }

    expect(spawnCalls).toHaveLength(0);
    expect(exitCode).toBe(1);
    const output = stderrLines.join("\n");
    expect(output).toMatch(/manually/i);
  });
});

describe("runSetup — interactive, user types 's' (alias for select)", () => {
  it("enters selective install when user types 's'", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });

    const missingItems = [
      makeStatus("node", false, false, null),
      makeStatus("python", false, false, null),
    ];

    vi.mocked(detectPrereqs)
      .mockResolvedValueOnce(missingItems)
      .mockResolvedValueOnce([
        makeStatus("node", true, true, "v22.0.0"),
        makeStatus("python", true, true, "Python 3.12.0"),
      ]);

    // 's' to trigger select, then select "1" (node only)
    rlAnswers = ["s", "1"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await runSetup([]);
    } catch {
      // may exit
    } finally {
      exitSpy.mockRestore();
    }

    // Should have spawned 1 install (node only)
    expect(spawnCalls).toHaveLength(1);
  });
});

describe("runSetup — interactive, user types 'select'", () => {
  it("only installs selected indices", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });

    const missingItems = [
      makeStatus("node", false, false, null),
      makeStatus("python", false, false, null),
      makeStatus("git", false, false, null),
    ];

    // First call returns all missing; re-check returns all found
    vi.mocked(detectPrereqs)
      .mockResolvedValueOnce(missingItems)
      .mockResolvedValueOnce([
        makeStatus("node", true, true, "v22.0.0"),
        makeStatus("python", false, false, null), // index 2 (git) installed
        makeStatus("git", true, true, "git version 2.42.0"),
      ]);

    // user selects indices 1 and 3 (node and git)
    rlAnswers = ["select", "1,3"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      await runSetup([]);
    } catch {
      // expected (may exit 1 due to python still missing after recheck)
    } finally {
      exitSpy.mockRestore();
    }

    // Should have spawned 2 installs (for node and git, indices 0 and 2 = "1,3")
    expect(spawnCalls).toHaveLength(2);
  });
});

describe("runSetup — install spawn exits non-zero", () => {
  it("reports failure and exits non-zero", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });
    vi.mocked(detectPrereqs).mockResolvedValue([makeStatus("python", false, false, null)]);

    spawnExitCode = 1; // apt exits with error
    rlAnswers = ["y"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    try {
      await runSetup([]);
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
    }

    // After failed install, _installAndVerify still does re-check and may
    // report "still missing". Exit should be 1.
    expect(exitCode).toBe(1);
    const output = stderrLines.join("\n");
    // Should mention failure or missing
    expect(output.toLowerCase()).toMatch(/install|missing|failed/);
  });
});

describe("runSetup — still missing after install (PATH not refreshed)", () => {
  it("exits 0 with PATH restart message when install succeeded but prereqs still missing", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });

    // Both calls return missing (install succeeded but PATH not updated)
    spawnExitCode = 0; // install "succeeds"
    vi.mocked(detectPrereqs).mockResolvedValue([makeStatus("python", false, false, null)]);

    rlAnswers = ["y"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    let exitCode: number | undefined;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    try {
      await runSetup([]);
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
    }

    // P1-2: PATH-not-refreshed → exit 0
    expect(exitCode).toBe(0);
    const output = stderrLines.join("\n");
    expect(output).toMatch(/restart.*terminal|PATH not yet/i);
  });
});

// ---------------------------------------------------------------------------
// Nit 4: _selectiveInstall input parsing
// ---------------------------------------------------------------------------

describe("_selectiveInstall — input parsing", () => {
  async function runSelectiveTest(
    missing: PrereqStatus[],
    selInput: string,
    recheckStatuses?: PrereqStatus[]
  ) {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });

    // Reset any leftover queued return values from previous tests before
    // configuring. vi.clearAllMocks() only clears call history (not the queue),
    // and the mock module persists through vi.resetModules() — so stale
    // mockResolvedValueOnce entries from earlier tests can bleed into this one.
    vi.mocked(detectPrereqs).mockReset();

    // First call returns missing; subsequent re-check
    const recheck = recheckStatuses ?? missing.map((s) => makeStatus(s.id, true, true, "v1.0.0"));
    vi.mocked(detectPrereqs)
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(recheck);

    rlAnswers = ["select", selInput];

    const { runSetup } = await import("../commands/setup.js");

    let exitCode: number | undefined;
    const stderrLines: string[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    try {
      await runSetup([]);
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
    }

    return { exitCode, output: stderrLines.join("\n"), spawnCount: spawnCalls.length };
  }

  beforeEach(() => {
    spawnCalls = [];
    rlAnswers = [];
    spawnExitCode = 0;
    mockPrereqStatuses = [];
    vi.clearAllMocks();
  });

  it("'1,3' selects items 1 and 3", async () => {
    vi.resetModules();
    const missing = [
      makeStatus("node", false, false, null),
      makeStatus("python", false, false, null),
      makeStatus("git", false, false, null),
    ];
    const { spawnCount } = await runSelectiveTest(missing, "1,3");
    expect(spawnCount).toBe(2);
  });

  it("'1 3' (space-separated) selects items 1 and 3", async () => {
    vi.resetModules();
    const missing = [
      makeStatus("node", false, false, null),
      makeStatus("python", false, false, null),
      makeStatus("git", false, false, null),
    ];
    const { spawnCount } = await runSelectiveTest(missing, "1 3");
    expect(spawnCount).toBe(2);
  });

  it("'1, 3' (comma+space) selects items 1 and 3", async () => {
    vi.resetModules();
    const missing = [
      makeStatus("node", false, false, null),
      makeStatus("python", false, false, null),
      makeStatus("git", false, false, null),
    ];
    const { spawnCount } = await runSelectiveTest(missing, "1, 3");
    expect(spawnCount).toBe(2);
  });

  it("'1, 5' with only 3 items → warns about invalid token 5, installs item 1", async () => {
    vi.resetModules();
    const missing = [
      makeStatus("node", false, false, null),
      makeStatus("python", false, false, null),
      makeStatus("git", false, false, null),
    ];
    const { output, spawnCount } = await runSelectiveTest(missing, "1, 5");
    expect(output).toMatch(/ignoring invalid|invalid.*5/i);
    expect(spawnCount).toBe(1);
  });

  it("'foo' (NaN) → warns about invalid token, exits with no install", async () => {
    vi.resetModules();
    const missing = [makeStatus("node", false, false, null)];
    const { output, exitCode, spawnCount } = await runSelectiveTest(missing, "foo");
    expect(output).toMatch(/ignoring invalid|invalid.*foo/i);
    expect(exitCode).toBe(1);
    expect(spawnCount).toBe(0);
  });

  it("empty input = cancel → exits 1 with no install", async () => {
    vi.resetModules();
    const missing = [makeStatus("node", false, false, null)];
    const { exitCode, spawnCount } = await runSelectiveTest(missing, "");
    expect(exitCode).toBe(1);
    expect(spawnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Nit 5: [i/N] progress counter in _installAndVerify (setup.ts)
// ---------------------------------------------------------------------------

describe("_installAndVerify — [i/N] progress counter", () => {
  it("writes [1/2] and [2/2] counters to stderr", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });

    // Reset any stale queued return values before configuring.
    vi.mocked(detectPrereqs).mockReset();
    vi.mocked(detectPrereqs)
      .mockResolvedValueOnce([
        makeStatus("node", false, false, null),
        makeStatus("git", false, false, null),
      ])
      .mockResolvedValueOnce([
        makeStatus("node", true, true, "v22.0.0"),
        makeStatus("git", true, true, "git version 2.42.0"),
      ]);

    rlAnswers = ["y"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    try {
      await runSetup([]);
    } catch {
      // may exit
    } finally {
      exitSpy.mockRestore();
    }

    const output = stderrLines.join("\n");
    expect(output).toMatch(/\[1\/2\]/);
    expect(output).toMatch(/\[2\/2\]/);
  });
});

// ---------------------------------------------------------------------------
// Adjacent UX hole B: managerLabel and unknown-PM bail
// ---------------------------------------------------------------------------

describe("runSetup — managerLabel correctness", () => {
  it("uses single manager name when all missing items share same PM", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: true, dnf: false, pacman: false, zypper: false },
    });
    vi.mocked(detectPrereqs).mockResolvedValue([
      makeStatus("node", false, false, null, "apt"),
      makeStatus("git", false, false, null, "apt"),
    ]);

    rlAnswers = ["n"];

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    const stderrLines: string[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    try {
      await runSetup([]);
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
    }

    const output = stderrLines.join("\n");
    // The prompt should mention 'apt' specifically (single manager)
    expect(output).toMatch(/apt/);
  });

  it("bails before prompt with exit 1 when any missing item has manager='unknown'", async () => {
    const { buildPrereqContext, detectPrereqs } = await import("../prereqs.js");
    vi.mocked(buildPrereqContext).mockResolvedValue({
      isTTY: true,
      platform: "linux",
      pmAvailable: { winget: false, brew: false, apt: false, dnf: false, pacman: false, zypper: false },
    });
    // Reset any stale queued values from prior tests before setting the default.
    vi.mocked(detectPrereqs).mockReset();
    vi.mocked(detectPrereqs).mockResolvedValue([
      makeStatus("node", false, false, null, "unknown"),
    ]);

    vi.resetModules();
    const { runSetup } = await import("../commands/setup.js");

    let exitCode: number | undefined;
    const stderrLines: string[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    try {
      await runSetup([]);
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
    }

    expect(exitCode).toBe(1);
    const output = stderrLines.join("\n");
    expect(output).toMatch(/no package manager|manually/i);
    // No spawn should have happened
    expect(spawnCalls).toHaveLength(0);
  });
});
