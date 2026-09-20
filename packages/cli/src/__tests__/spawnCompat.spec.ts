/**
 * spawnCompat.spec.ts — tests for the Windows `.cmd`/`.bat` spawn
 * compatibility helper (`resolveSpawnTarget`).
 *
 * Mocks `node:child_process.spawnSync` (used internally for `where`
 * resolution) so no real subprocess is spawned.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Envelope ban guard
// ---------------------------------------------------------------------------

describe("envelope ban — spawnCompat.ts source must not contain meta envelope", () => {
  it("spawnCompat.ts source does not contain <!-- tokenlighten:meta", () => {
    const { readFileSync, existsSync } = require("fs");
    const { join } = require("path");
    const dir = typeof __dirname !== "undefined" ? __dirname : ".";
    const srcPath = join(dir, "..", "spawnCompat.ts");
    expect(existsSync(srcPath)).toBe(true);
    const src = readFileSync(srcPath, "utf-8") as string;
    expect(/<!--\s*tokenlighten:meta/i.test(src)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `where` mock
// ---------------------------------------------------------------------------

// Map of bare command name → what `where <name>` should print on stdout.
const whereResultMap = new Map<string, string>();

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawnSync: vi.fn((cmd: string, args: string[]) => {
      if (cmd === "where") {
        const resolved = whereResultMap.get(args[0] ?? "");
        return resolved
          ? { status: 0, stdout: `${resolved}\r\n`, stderr: "" }
          : { status: 1, stdout: "", stderr: "INFO: could not find files\r\n" };
      }
      throw new Error(`unexpected spawnSync call in test: ${cmd}`);
    }),
  };
});

function setPlatform(value: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => Object.defineProperty(process, "platform", { value: original, configurable: true });
}

afterEach(() => {
  vi.clearAllMocks();
  whereResultMap.clear();
});

// ---------------------------------------------------------------------------
// Platform passthrough
// ---------------------------------------------------------------------------

describe("resolveSpawnTarget — non-Windows passthrough", () => {
  it("returns the original command/args unchanged on darwin, without calling `where`", async () => {
    const restore = setPlatform("darwin");
    try {
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const target = resolveSpawnTarget("claude", ["mcp", "get", "tokenlighten"]);
      expect(target).toEqual({ file: "claude", args: ["mcp", "get", "tokenlighten"] });
      expect(target.windowsVerbatimArguments).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("returns the original command/args unchanged on linux", async () => {
    const restore = setPlatform("linux");
    try {
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const target = resolveSpawnTarget("git", ["--version"]);
      expect(target).toEqual({ file: "git", args: ["--version"] });
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Windows batch-file detection
// ---------------------------------------------------------------------------

describe("resolveSpawnTarget — win32 batch-file detection", () => {
  it("wraps a bare command name that `where` resolves to a .cmd file", async () => {
    const restore = setPlatform("win32");
    try {
      whereResultMap.set("claude", "C:\\Users\\ishim\\AppData\\Roaming\\npm\\claude.cmd");
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const target = resolveSpawnTarget("claude", ["mcp", "get", "tokenlighten"]);
      expect(target.file).toBe(process.env["ComSpec"] ?? "cmd.exe");
      expect(target.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(target.windowsVerbatimArguments).toBe(true);
      expect(target.args).toHaveLength(4);
    } finally {
      restore();
    }
  });

  it("wraps a bare command name that `where` resolves to a .bat file", async () => {
    const restore = setPlatform("win32");
    try {
      whereResultMap.set("python3", "C:\\Users\\ishim\\.pyenv\\pyenv-win\\shims\\python3.bat");
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const target = resolveSpawnTarget("python3", ["-V"]);
      expect(target.file).toBe(process.env["ComSpec"] ?? "cmd.exe");
      expect(target.windowsVerbatimArguments).toBe(true);
    } finally {
      restore();
    }
  });

  it("passes through a bare command name that `where` resolves to a .exe file", async () => {
    const restore = setPlatform("win32");
    try {
      whereResultMap.set("node", "C:\\Program Files\\nodejs\\node.exe");
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const target = resolveSpawnTarget("node", ["-v"]);
      expect(target).toEqual({ file: "node", args: ["-v"] });
      expect(target.windowsVerbatimArguments).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("passes through when `where` cannot resolve the command at all (falls back to ENOENT via the real spawn)", async () => {
    const restore = setPlatform("win32");
    try {
      // No entry registered in whereResultMap → `where` reports not-found.
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const target = resolveSpawnTarget("totally-unknown-tool", ["--version"]);
      expect(target).toEqual({ file: "totally-unknown-tool", args: ["--version"] });
    } finally {
      restore();
    }
  });

  it("detects a batch file directly from an already-absolute path, without calling `where`", async () => {
    const restore = setPlatform("win32");
    try {
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const absoluteCmd = "C:\\Users\\ishim\\AppData\\Local\\Temp\\tl-install-json-home\\bin\\tl.cmd";
      const target = resolveSpawnTarget(absoluteCmd, ["version"]);
      expect(target.file).toBe(process.env["ComSpec"] ?? "cmd.exe");
      expect(target.windowsVerbatimArguments).toBe(true);
    } finally {
      restore();
    }
  });

  it("passes through an already-absolute .exe path without calling `where`", async () => {
    const restore = setPlatform("win32");
    try {
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const absoluteExe = "C:\\Program Files\\Git\\bin\\git.exe";
      const target = resolveSpawnTarget(absoluteExe, ["--version"]);
      expect(target).toEqual({ file: absoluteExe, args: ["--version"] });
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// cmd.exe quoting — spaces, &, %, embedded quotes
// ---------------------------------------------------------------------------

describe("resolveSpawnTarget — cmd.exe quoting of the wrapped command line", () => {
  async function wrap(command: string, args: string[]): Promise<string> {
    const restore = setPlatform("win32");
    try {
      whereResultMap.set(command, `C:\\bin\\${command}.cmd`);
      vi.resetModules();
      const { resolveSpawnTarget } = await import("../spawnCompat.js");
      const target = resolveSpawnTarget(command, args);
      return target.args[3] as string;
    } finally {
      restore();
    }
  }

  it("quotes a path argument containing spaces", async () => {
    const line = await wrap("claude", ["--config", "C:\\Program Files\\tl\\config.json"]);
    // Outer wrap + each token individually quoted.
    expect(line.startsWith("\"")).toBe(true);
    expect(line.endsWith("\"")).toBe(true);
    expect(line).toContain("\"C:\\Program Files\\tl\\config.json\"");
  });

  it("quotes (without corrupting) an argument containing &", async () => {
    const line = await wrap("claude", ["--message", "a & b"]);
    // `&` is neutralized by this token's OWN quotes — both for this
    // cmd.exe pass and for a `.cmd` target's `%*`-forwarded re-parse of
    // the same already-quoted text — so no extra escaping is needed or
    // applied.
    expect(line).toContain("\"a & b\"");
  });

  it("quotes (without corrupting) an argument containing %", async () => {
    const line = await wrap("claude", ["--label", "100%done"]);
    expect(line).toContain("\"100%done\"");
  });

  it("escapes an embedded double quote", async () => {
    const line = await wrap("claude", ["--name", "a\"b"]);
    // escapeArgvToken doubles the (zero-length, here) backslash run before
    // the embedded quote and escapes the quote itself with one backslash —
    // the standard MSVCRT argv-parsing convention every normal Windows
    // executable (including a `.cmd` shim's own `node ... %*` re-launch)
    // understands.
    expect(line).toContain("\"a\\\"b\"");
  });

  it("round-trips a plain argument with no special characters unchanged (just quoted)", async () => {
    const line = await wrap("claude", ["mcp", "get", "tokenlighten"]);
    expect(line).toContain("\"mcp\"");
    expect(line).toContain("\"get\"");
    expect(line).toContain("\"tokenlighten\"");
  });
});
