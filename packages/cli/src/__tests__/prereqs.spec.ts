/**
 * prereqs.spec.ts — tests for prerequisite detection and install-command resolution.
 *
 * Mocks child_process.spawnSync to avoid actually invoking system tools.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Envelope ban guard
// ---------------------------------------------------------------------------

describe("envelope ban — prereqs.ts source must not contain meta envelope", () => {
  it("prereqs.ts source does not contain <!-- tokenlighten:meta", () => {
    const { readFileSync, existsSync } = require("fs");
    const { join } = require("path");
    const dir = typeof __dirname !== "undefined" ? __dirname : ".";
    const srcPath = join(dir, "..", "prereqs.ts");
    expect(existsSync(srcPath)).toBe(true);
    const src = readFileSync(srcPath, "utf-8") as string;
    expect(/<!--\s*tokenlighten:meta/i.test(src)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spawnSync mock
// ---------------------------------------------------------------------------

type SpawnSyncResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

// Map of "<cmd> <args[0]>" → result
const spawnSyncResultMap = new Map<string, SpawnSyncResult>();

// Module-level spawn exit code for ensurePrereqs tests
let mockSpawnExitCode = 0;

// Module-level readline answer for ensurePrereqs tests
let mockRlAnswer = "y";

// Queued spawnSync overrides: a list of [key, result] pairs consumed in order
// when the same key is looked up. After queue is empty, falls back to spawnSyncResultMap.
const spawnSyncQueue: Array<{ key: string; result: SpawnSyncResult }> = [];

function mockSpawnSyncWithQueue(
  cmd: string,
  args: string[],
  _opts: unknown
): SpawnSyncResult {
  const key = `${cmd} ${args[0] ?? ""}`.trim();
  // Check queue first
  const qIdx = spawnSyncQueue.findIndex((q) => q.key === key);
  if (qIdx !== -1) {
    const [entry] = spawnSyncQueue.splice(qIdx, 1);
    return entry!.result;
  }
  return (
    spawnSyncResultMap.get(key) ?? {
      status: 1,
      stdout: "",
      stderr: "",
      error: new Error("ENOENT"),
    }
  );
}

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(async () => mockRlAnswer),
    close: vi.fn(),
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: vi.fn(mockSpawnSyncWithQueue),
    spawn: vi.fn((..._args: unknown[]) => {
      const listeners: Record<string, ((code: number) => void)[]> = {};
      return {
        on: vi.fn((event: string, cb: (code: number) => void) => {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(cb);
          if (event === "exit") setTimeout(() => cb(mockSpawnExitCode), 0);
        }),
      };
    }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
  spawnSyncResultMap.clear();
  spawnSyncQueue.length = 0;
  vi.resetModules();
  mockSpawnExitCode = 0;
  mockRlAnswer = "y";
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setSpawnResult(cmd: string, firstArg: string, result: SpawnSyncResult) {
  spawnSyncResultMap.set(`${cmd} ${firstArg}`.trim(), result);
}

// ---------------------------------------------------------------------------
// detectPrereqs — Node
// ---------------------------------------------------------------------------

describe("detectPrereqs — node", () => {
  it("node present v22.5.0 → found=true, meetsMin=true", async () => {
    setSpawnResult("node", "-v", { status: 0, stdout: "v22.5.0\n", stderr: "" });
    // pm probes
    setSpawnResult("which", "brew", { status: 0, stdout: "/usr/local/bin/brew\n", stderr: "" });

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["node"]);
    expect(s.found).toBe(true);
    expect(s.meetsMin).toBe(true);
    expect(s.version).toMatch(/22\.5\.0/);
  });

  it("node present v18.0.0 → found=true, meetsMin=false", async () => {
    setSpawnResult("node", "-v", { status: 0, stdout: "v18.0.0\n", stderr: "" });

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["node"]);
    expect(s.found).toBe(true);
    expect(s.meetsMin).toBe(false);
    expect(s.installCommand).not.toBeNull();
  });

  it("node absent (ENOENT) → found=false", async () => {
    // No entry for "node -v" → defaults to error

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["node"]);
    expect(s.found).toBe(false);
    expect(s.meetsMin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectPrereqs — Python
// ---------------------------------------------------------------------------

describe("detectPrereqs — python", () => {
  it("python3 on POSIX → found=true, meetsMin=true for 3.12", async () => {
    setSpawnResult("python3", "-V", { status: 0, stdout: "Python 3.12.1\n", stderr: "" });

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["python"]);
    expect(s.found).toBe(true);
    expect(s.meetsMin).toBe(true);
    expect(s.version).toContain("3.12.1");
  });

  it("python3 absent, python fallback → found=true, meetsMin=true", async () => {
    // python3 fails, python succeeds
    setSpawnResult("python3", "-V", { status: 1, stdout: "", stderr: "" });
    setSpawnResult("python", "-V", { status: 0, stdout: "Python 3.11.0\n", stderr: "" });

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["python"]);
    expect(s.found).toBe(true);
    expect(s.meetsMin).toBe(true);
  });

  it("returns the same fallback command that detection accepted", async () => {
    setSpawnResult("python", "-V", { status: 0, stdout: "Python 3.11.0\n", stderr: "" });

    vi.resetModules();
    const { resolvePythonCommand } = await import("../prereqs.js");
    expect(resolvePythonCommand()).toEqual({
      command: "python",
      argsPrefix: [],
      version: "Python 3.11.0",
      meetsMin: true,
    });
  });

  it("returns the Windows py launcher with its -3 prefix", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    setSpawnResult("py", "-3", { status: 0, stdout: "Python 3.12.2\n", stderr: "" });

    try {
      vi.resetModules();
      const { resolvePythonCommand } = await import("../prereqs.js");
      expect(resolvePythonCommand()).toEqual({
        command: "py",
        argsPrefix: ["-3"],
        version: "Python 3.12.2",
        meetsMin: true,
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("python version 3.10 → meetsMin=false", async () => {
    setSpawnResult("python3", "-V", { status: 0, stdout: "Python 3.10.0\n", stderr: "" });

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["python"]);
    expect(s.found).toBe(true);
    expect(s.meetsMin).toBe(false);
  });

  it("python not found at all → found=false", async () => {
    // No entries for python3/python/py → all default to error

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["python"]);
    expect(s.found).toBe(false);
    expect(s.meetsMin).toBe(false);
  });

  it("python version printed to stderr (older Python) → still detected", async () => {
    setSpawnResult("python3", "-V", { status: 0, stdout: "", stderr: "Python 3.12.0\n" });

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["python"]);
    expect(s.found).toBe(true);
    expect(s.version).toContain("3.12.0");
  });
});

// ---------------------------------------------------------------------------
// detectPrereqs — Git
// ---------------------------------------------------------------------------

describe("detectPrereqs — git", () => {
  it("git present 2.42.0 → found=true, meetsMin=true", async () => {
    setSpawnResult("git", "--version", { status: 0, stdout: "git version 2.42.0\n", stderr: "" });

    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["git"]);
    expect(s.found).toBe(true);
    expect(s.meetsMin).toBe(true);
  });

  it("git absent → found=false", async () => {
    vi.resetModules();
    const { detectPrereqs } = await import("../prereqs.js");
    const [s] = await detectPrereqs(["git"]);
    expect(s.found).toBe(false);
    expect(s.meetsMin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickInstallCommand
// ---------------------------------------------------------------------------

describe("pickInstallCommand", () => {
  // Map each PM to the platform where it is native
  const pmPlatform: Record<string, NodeJS.Platform> = {
    winget: "win32",
    brew: "darwin",
    apt: "linux",
    dnf: "linux",
    pacman: "linux",
    zypper: "linux",
  };

  const makeCtx = (pm: "winget" | "brew" | "apt" | "dnf" | "pacman" | "zypper" | "none") => ({
    isTTY: true,
    platform: (pm === "none" ? "linux" : pmPlatform[pm] ?? "linux") as NodeJS.Platform,
    pmAvailable: {
      winget: pm === "winget",
      brew: pm === "brew",
      apt: pm === "apt",
      dnf: pm === "dnf",
      pacman: pm === "pacman",
      zypper: pm === "zypper",
    },
  });

  it.each([
    ["node", "winget", "OpenJS.NodeJS.LTS"],
    ["node", "brew", "node@20"],
    ["node", "apt", "nodejs"],
    ["node", "dnf", "nodejs"],
    ["node", "pacman", "nodejs"],
    ["node", "zypper", "nodejs20"],
    ["python", "winget", "Python.Python.3.12"],
    ["python", "brew", "python@3.12"],
    ["python", "apt", "python3.12"],
    ["python", "dnf", "python3.12"],
    ["python", "pacman", "python"],
    ["python", "zypper", "python312"],
    ["git", "winget", "Git.Git"],
    ["git", "brew", "git"],
    ["git", "apt", "git"],
    ["git", "dnf", "git"],
    ["git", "pacman", "git"],
    ["git", "zypper", "git"],
  ] as [string, string, string][])("(%s, %s) contains '%s' in args", async (id, pm, expectedArg) => {
    vi.resetModules();
    const fsModule = await import("node:fs");
    // For linux PM tests, mock os-release to match the PM's distro
    if (pm === "apt") {
      vi.mocked(fsModule.readFileSync).mockReturnValue("ID=ubuntu\n");
    } else if (pm === "dnf") {
      vi.mocked(fsModule.readFileSync).mockReturnValue("ID=fedora\n");
    } else if (pm === "pacman") {
      vi.mocked(fsModule.readFileSync).mockReturnValue("ID=arch\n");
    } else if (pm === "zypper") {
      vi.mocked(fsModule.readFileSync).mockReturnValue("ID=opensuse\n");
    }
    vi.resetModules();
    const { pickInstallCommand } = await import("../prereqs.js");
    const ctx = makeCtx(pm as "winget" | "brew" | "apt" | "dnf" | "pacman" | "zypper");
    const ic = pickInstallCommand(id as "node" | "python" | "git", ctx);
    expect(ic).not.toBeNull();
    expect(ic!.manager).toBe(pm);
    expect(ic!.args.some((a) => a.includes(expectedArg))).toBe(true);
    vi.restoreAllMocks();
  });

  it("winget args include --silent for node", async () => {
    vi.resetModules();
    const { pickInstallCommand } = await import("../prereqs.js");
    const ctx = makeCtx("winget"); // makeCtx already sets platform: win32 for winget
    const ic = pickInstallCommand("node", ctx);
    expect(ic).not.toBeNull();
    expect(ic!.args).toContain("--silent");
  });

  it("winget args include --silent for python", async () => {
    vi.resetModules();
    const { pickInstallCommand } = await import("../prereqs.js");
    const ctx = makeCtx("winget");
    const ic = pickInstallCommand("python", ctx);
    expect(ic).not.toBeNull();
    expect(ic!.args).toContain("--silent");
  });

  it("winget args include --silent for git", async () => {
    vi.resetModules();
    const { pickInstallCommand } = await import("../prereqs.js");
    const ctx = makeCtx("winget");
    const ic = pickInstallCommand("git", ctx);
    expect(ic).not.toBeNull();
    expect(ic!.args).toContain("--silent");
  });

  it("unknown PM → InstallCommand with manager='unknown' and docUrl", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    vi.resetModules();
    const { pickInstallCommand } = await import("../prereqs.js");
    const ctx = makeCtx("none");
    const ic = pickInstallCommand("node", ctx);
    expect(ic).not.toBeNull();
    expect(ic!.manager).toBe("unknown");
    expect(ic!.docUrl).toBe("https://nodejs.org");
    expect(ic!.args).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("unknown PM for python → docUrl=https://www.python.org", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    vi.resetModules();
    const { pickInstallCommand } = await import("../prereqs.js");
    const ctx = makeCtx("none");
    const ic = pickInstallCommand("python", ctx);
    expect(ic!.docUrl).toBe("https://www.python.org");
    vi.restoreAllMocks();
  });

  it("unknown PM for git → docUrl=https://git-scm.com", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    vi.resetModules();
    const { pickInstallCommand } = await import("../prereqs.js");
    const ctx = makeCtx("none");
    const ic = pickInstallCommand("git", ctx);
    expect(ic!.docUrl).toBe("https://git-scm.com");
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// buildPrereqContext
// ---------------------------------------------------------------------------

describe("buildPrereqContext", () => {
  it("detects brew when which brew returns 0", async () => {
    setSpawnResult("which", "brew", { status: 0, stdout: "/opt/homebrew/bin/brew\n", stderr: "" });

    vi.resetModules();
    const { buildPrereqContext } = await import("../prereqs.js");
    const ctx = await buildPrereqContext();
    expect(ctx.pmAvailable.brew).toBe(true);
  });

  it("brew not found when which brew returns non-zero", async () => {
    // Default: not found

    vi.resetModules();
    const { buildPrereqContext } = await import("../prereqs.js");
    const ctx = await buildPrereqContext();
    expect(ctx.pmAvailable.brew).toBe(false);
  });

  it("detects apt when which apt returns 0", async () => {
    setSpawnResult("which", "apt", { status: 0, stdout: "/usr/bin/apt\n", stderr: "" });

    vi.resetModules();
    const { buildPrereqContext } = await import("../prereqs.js");
    const ctx = await buildPrereqContext();
    expect(ctx.pmAvailable.apt).toBe(true);
  });

  it("isTTY reflects process.stdin.isTTY", async () => {
    vi.resetModules();
    const { buildPrereqContext } = await import("../prereqs.js");
    const ctx = await buildPrereqContext();
    expect(typeof ctx.isTTY).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// readOsRelease — Nit 6
// ---------------------------------------------------------------------------

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

describe("readOsRelease", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ubuntu ID → returns 'apt'", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValue(
      'ID=ubuntu\nID_LIKE=debian\nVERSION="22.04 LTS"\n'
    );
    vi.resetModules();
    const { readOsRelease } = await import("../prereqs.js");
    expect(readOsRelease()).toBe("apt");
  });

  it("fedora ID → returns 'dnf'", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValue('ID=fedora\nVERSION_ID=38\n');
    vi.resetModules();
    const { readOsRelease } = await import("../prereqs.js");
    expect(readOsRelease()).toBe("dnf");
  });

  it("arch ID → returns 'pacman'", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValue('ID=arch\n');
    vi.resetModules();
    const { readOsRelease } = await import("../prereqs.js");
    expect(readOsRelease()).toBe("pacman");
  });

  it("opensuse ID → returns 'zypper'", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValue('ID=opensuse\n');
    vi.resetModules();
    const { readOsRelease } = await import("../prereqs.js");
    expect(readOsRelease()).toBe("zypper");
  });

  it("readFileSync throws → returns null", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.resetModules();
    const { readOsRelease } = await import("../prereqs.js");
    expect(readOsRelease()).toBeNull();
  });

  it("linuxmint ID → uses ID directly for 'apt'", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValue('ID=linuxmint\nID_LIKE=ubuntu debian\n');
    vi.resetModules();
    const { readOsRelease } = await import("../prereqs.js");
    // linuxmint matches directly via ID
    expect(readOsRelease()).toBe("apt");
  });
});

// ---------------------------------------------------------------------------
// platformPmPriority — Nit 6
// ---------------------------------------------------------------------------

describe("platformPmPriority", () => {
  const makeCtx = (platform: NodeJS.Platform, pmAvailable = {
    winget: false, brew: false, apt: false, dnf: false, pacman: false, zypper: false,
  }) => ({
    isTTY: true,
    platform,
    pmAvailable,
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("win32 → ['winget']", async () => {
    vi.resetModules();
    const { platformPmPriority } = await import("../prereqs.js");
    expect(platformPmPriority(makeCtx("win32"))).toEqual(["winget"]);
  });

  it("darwin → ['brew']", async () => {
    vi.resetModules();
    const { platformPmPriority } = await import("../prereqs.js");
    expect(platformPmPriority(makeCtx("darwin"))).toEqual(["brew"]);
  });

  it("linux + ubuntu os-release → ['apt', 'dnf', 'pacman', 'zypper']", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValue('ID=ubuntu\n');
    vi.resetModules();
    const { platformPmPriority } = await import("../prereqs.js");
    expect(platformPmPriority(makeCtx("linux"))).toEqual(["apt", "dnf", "pacman", "zypper"]);
  });

  it("linux + fedora os-release → ['dnf', 'apt', 'pacman', 'zypper']", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValue('ID=fedora\n');
    vi.resetModules();
    const { platformPmPriority } = await import("../prereqs.js");
    expect(platformPmPriority(makeCtx("linux"))).toEqual(["dnf", "apt", "pacman", "zypper"]);
  });

  it("linux + arch os-release → ['pacman', 'apt', 'dnf', 'zypper']", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockReturnValue('ID=arch\n');
    vi.resetModules();
    const { platformPmPriority } = await import("../prereqs.js");
    expect(platformPmPriority(makeCtx("linux"))).toEqual(["pacman", "apt", "dnf", "zypper"]);
  });

  it("linux + os-release throws → fallback ['apt', 'dnf', 'pacman', 'zypper']", async () => {
    const fsModule = await import("node:fs");
    vi.mocked(fsModule.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.resetModules();
    const { platformPmPriority } = await import("../prereqs.js");
    expect(platformPmPriority(makeCtx("linux"))).toEqual(["apt", "dnf", "pacman", "zypper"]);
  });
});

// ---------------------------------------------------------------------------
// ensurePrereqs — P1-1, P1-2
//
// Strategy: we test ensurePrereqs by controlling:
//   1. spawnSyncResultMap for detectPrereqs/buildPrereqContext (already mocked above)
//   2. vi.doMock for readline/promises and child_process.spawn (dynamic, not hoisted)
//   3. process.exit and process.stderr.write spies
// ---------------------------------------------------------------------------

describe("ensurePrereqs", () => {
  let stderrOutput: string[];
  let exitCode: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;

  beforeEach(() => {
    stderrOutput = [];
    exitCode = undefined;

    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((msg: unknown) => {
      stderrOutput.push(String(msg));
      return true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
  });

  afterEach(() => {
    exitSpy?.mockRestore?.();
    stderrSpy?.mockRestore?.();
    vi.restoreAllMocks();
  });

  /**
   * Helper: run ensurePrereqs with controlled spawn exit code and readline answer.
   *
   * Uses module-level mockSpawnExitCode, mockRlAnswer (consumed by hoisted vi.mock),
   * and spawnSyncQueue to control what detectPrereqs returns on each call.
   *
   * For two-phase behavior (first call: missing, second call: found), we put the
   * "found" result in spawnSyncQueue so the SECOND "node -v" call dequeues it,
   * while the first call reads from spawnSyncResultMap (which is set to "not found").
   */
  async function runEnsurePrereqs(opts: {
    rlAnswer?: string;
    spawnCode?: number;
    nodeFoundFirst?: boolean;
    nodeFoundSecond?: boolean;
    isTTY?: boolean;
  }) {
    const {
      rlAnswer = "y",
      spawnCode = 0,
      nodeFoundFirst = false,
      nodeFoundSecond = true,
      isTTY = true,
    } = opts;

    mockRlAnswer = rlAnswer;
    mockSpawnExitCode = spawnCode;

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true });

    // First detectPrereqs call: set spawnSyncResultMap for node -v
    spawnSyncResultMap.set("node -v",
      nodeFoundFirst
        ? { status: 0, stdout: "v22.0.0\n", stderr: "" }
        : { status: 1, stdout: "", stderr: "", error: new Error("ENOENT") }
    );
    // Ensure apt is available for buildPrereqContext
    spawnSyncResultMap.set("which apt", { status: 0, stdout: "/usr/bin/apt\n", stderr: "" });

    // Second detectPrereqs call (re-check after install): queue a different result
    // The queue-aware mock consumes from queue first, then falls back to map.
    // We need TWO "node -v" queue entries: one for the re-check spawnSync call,
    // plus one for any which/where probes inside buildPrereqContext.
    // Actually buildPrereqContext only calls spawnSync for PM probes (which/where),
    // not for node -v. So we only need one queue entry for "node -v".
    if (nodeFoundSecond) {
      spawnSyncQueue.push({
        key: "node -v",
        result: { status: 0, stdout: "v22.0.0\n", stderr: "" },
      });
    }
    // Note: when nodeFoundSecond=false, map still has "not found" so re-check returns missing

    vi.resetModules();
    const { ensurePrereqs } = await import("../prereqs.js");

    try {
      await ensurePrereqs(["node"]);
    } catch {
      // process.exit throws
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    }
  }

  it("P1-1: install exits 1 BUT re-detect finds node → success (no exit)", async () => {
    // Simulate winget idempotent: exits 1 but node is installed
    await runEnsurePrereqs({ spawnCode: 1, nodeFoundFirst: false, nodeFoundSecond: true, rlAnswer: "y" });
    // exitCode should be undefined (no exit called — returned normally)
    expect(exitCode).toBeUndefined();
  });

  it("P1-2: install exits 0 BUT re-detect still missing → exit 0 with PATH restart message", async () => {
    // Simulate successful install but PATH not refreshed
    await runEnsurePrereqs({ spawnCode: 0, nodeFoundFirst: false, nodeFoundSecond: false, rlAnswer: "y" });
    expect(exitCode).toBe(0);
    const output = stderrOutput.join("\n");
    expect(output).toMatch(/restart.*terminal|PATH not yet/i);
  });

  it("P1-C: install fails (exit 2) AND re-detect still missing → exit 1 with failure report", async () => {
    await runEnsurePrereqs({ spawnCode: 2, nodeFoundFirst: false, nodeFoundSecond: false, rlAnswer: "y" });
    expect(exitCode).toBe(1);
    const output = stderrOutput.join("\n");
    expect(output).toMatch(/still missing|failure|exit/i);
  });

  it("Nit 5: [i/N] progress counter appears in stderr for multi-prereq install", async () => {
    // Two prereqs missing: node and git; both found after install
    mockRlAnswer = "y";
    mockSpawnExitCode = 0;

    spawnSyncResultMap.set("node -v",        { status: 1, stdout: "", stderr: "", error: new Error("ENOENT") });
    spawnSyncResultMap.set("git --version",  { status: 1, stdout: "", stderr: "", error: new Error("ENOENT") });
    spawnSyncResultMap.set("which apt",      { status: 0, stdout: "/usr/bin/apt\n", stderr: "" });

    // Note: do NOT push re-check results to spawnSyncQueue here.
    // Queue entries are consumed by the FIRST detectPrereqs call (not the second),
    // so pushing "found" results to the queue would make the first call return
    // missing=[] and cause an early return before the install loop runs.
    // Instead, leave the map set to "not found" for both calls.
    // With mockSpawnExitCode=0 and no failed installs, the Result B path (exit 0)
    // is taken, which is fine — we only care that [i/N] counters appear in stderr.

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    vi.resetModules();
    const { ensurePrereqs } = await import("../prereqs.js");

    try {
      await ensurePrereqs(["node", "git"]);
    } catch {
      // may exit (Result B: exit 0, or Result C: exit 1 — both fine for this test)
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    }

    const output = stderrOutput.join("\n");
    expect(output).toMatch(/\[1\/2\]/);
    expect(output).toMatch(/\[2\/2\]/);
  });

  it("non-TTY: prints missing details + manual commands + exit 1", async () => {
    // Use runEnsurePrereqs with isTTY=false
    await runEnsurePrereqs({ isTTY: false, nodeFoundFirst: false, nodeFoundSecond: false });

    expect(exitCode).toBe(1);
    const output = stderrOutput.join("\n");
    expect(output).toMatch(/NOT FOUND|missing/i);
    expect(output).toMatch(/manually|tl setup/i);
  });
});
