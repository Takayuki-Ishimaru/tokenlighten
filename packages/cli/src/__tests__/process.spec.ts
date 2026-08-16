/**
 * process.spec.ts — tests for PID file management and MCP shutdown helpers.
 *
 * Coverage:
 *   - writePidFile / readPidFile / removePidFile round-trip
 *   - isPidAlive: alive and dead PIDs
 *   - stopMcp: SIGTERM-then-SIGKILL order verification
 *
 * Note: stopProxy and httpStatus/httpShutdown were removed in v0.4 (proxy gone).
 *
 * Envelope ban: no '<!-- tokenlighten:meta -->' in any output.
 *
 * Output policy: plain data — no meta envelope.
 * See docs/00-postmortem.md §2.2 for rationale.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Envelope ban guard
// ---------------------------------------------------------------------------

describe("envelope ban — process.ts source must not contain meta envelope", () => {
  it("process.ts source does not contain <!-- tokenlighten:meta", () => {
    const { readFileSync } = require("fs");
    const { join: pjoin } = require("path");
    const dir = typeof __dirname !== "undefined" ? __dirname : ".";
    const srcPath = pjoin(dir, "..", "process.ts");
    expect(existsSync(srcPath)).toBe(true);
    const src = readFileSync(srcPath, "utf-8") as string;
    expect(/<!--\s*tokenlighten:meta/i.test(src)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tl-proc-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// PID file round-trip
// ---------------------------------------------------------------------------

describe("writePidFile / readPidFile / removePidFile", () => {
  it("writes and reads a PID file with correct structure", async () => {
    const dir = makeTmpDir();
    const pidPath = join(dir, "test.pid");

    const { writePidFile, readPidFile } = await import("../process.js");

    const data = {
      pid: 12345,
      port: 4000,
      started_at_unix: 1700000000,
      command: "node mcp-server/dist/bin.js",
    };
    writePidFile(pidPath, data);

    const read = readPidFile(pidPath);
    expect(read).toEqual(data);

    rmSync(dir, { recursive: true });
  });

  it("returns null for a non-existent PID file", async () => {
    const { readPidFile } = await import("../process.js");
    const result = readPidFile("/tmp/__non_existent_tl_test__.pid");
    expect(result).toBeNull();
  });

  it("returns null for a corrupt PID file", async () => {
    const dir = makeTmpDir();
    const pidPath = join(dir, "corrupt.pid");
    writeFileSync(pidPath, "not json");

    const { readPidFile } = await import("../process.js");
    const result = readPidFile(pidPath);
    expect(result).toBeNull();

    rmSync(dir, { recursive: true });
  });

  it("removePidFile removes the file", async () => {
    const dir = makeTmpDir();
    const pidPath = join(dir, "to-remove.pid");

    const { writePidFile, removePidFile } = await import("../process.js");
    writePidFile(pidPath, {
      pid: 9999,
      started_at_unix: 1700000000,
      command: "test",
    });
    expect(existsSync(pidPath)).toBe(true);

    removePidFile(pidPath);
    expect(existsSync(pidPath)).toBe(false);

    rmSync(dir, { recursive: true });
  });

  it("removePidFile is a no-op on non-existent file", async () => {
    const { removePidFile } = await import("../process.js");
    expect(() => removePidFile("/tmp/__non_existent_tl_removepid__.pid")).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("writePidFile creates file with mode 0o600 on POSIX", async () => {
    const dir = makeTmpDir();
    const pidPath = join(dir, "mode-test.pid");

    const { writePidFile } = await import("../process.js");
    writePidFile(pidPath, {
      pid: 55555,
      started_at_unix: 1700000000,
      command: "test-command",
    });

    expect(existsSync(pidPath)).toBe(true);
    const st = statSync(pidPath);
    // Mask to permission bits only (last 9 bits).
    const mode = st.mode & 0o777;
    expect(mode).toBe(0o600);

    rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// isPidAlive
// ---------------------------------------------------------------------------

describe("isPidAlive", () => {
  it("returns true for the current process PID", async () => {
    const { isPidAlive } = await import("../process.js");
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns a boolean (does not throw) for an unlikely-to-exist PID", async () => {
    const { isPidAlive } = await import("../process.js");
    const result = isPidAlive(2147483646);
    expect(typeof result).toBe("boolean");
  });
});

describe("process identity matching", () => {
  it("uses the stable identity token instead of an unquoted display command on Windows", async () => {
    const { buildWindowsProcessIdentityScript } = await import("../process.js");
    const script = buildWindowsProcessIdentityScript({
      pid: 12345,
      started_at_unix: 1700000000,
      command: "C:\\Program Files\\nodejs\\node.exe C:\\My App\\bin.js",
      identity_token: "C:\\My App\\bin.js",
    });

    expect(script).toContain("$needle = 'C:\\My App\\bin.js'");
    expect(script).not.toContain("C:\\Program Files\\nodejs\\node.exe C:\\My App\\bin.js");
    expect(script).toContain("IndexOf($needle, [StringComparison]::OrdinalIgnoreCase)");
  });

  it("escapes apostrophes in the PowerShell identity literal", async () => {
    const { buildWindowsProcessIdentityScript } = await import("../process.js");
    const script = buildWindowsProcessIdentityScript({
      pid: 12345,
      started_at_unix: 1700000000,
      command: "node bin.js",
      identity_token: "C:\\O'Brien\\bin.js",
    });

    expect(script).toContain("$needle = 'C:\\O''Brien\\bin.js'");
  });

  it.runIf(process.platform === "win32")("matches the current Windows process by executable path", async () => {
    const { processMatchesPidFile } = await import("../process.js");
    expect(processMatchesPidFile({
      pid: process.pid,
      started_at_unix: Math.floor(Date.now() / 1000),
      command: `${process.execPath} deliberately-unquoted-path`,
      identity_token: process.execPath,
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stopMcp — SIGTERM-then-SIGKILL order
// ---------------------------------------------------------------------------

describe("stopMcp — shutdown sequence order", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes PID file after SIGTERM kills the process", async () => {
    const dir = makeTmpDir();
    const pidPath = join(dir, "mcp.pid");

    const { writePidFile, stopMcp } = await import("../process.js");
    writePidFile(pidPath, {
      pid: 99996,
      started_at_unix: 1700000000,
      command: "node bin.js",
    });

    let aliveCount = 0;
    const killMock = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        aliveCount++;
        // Process dies after SIGTERM is sent (after aliveCount > 1)
        if (aliveCount > 2) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        return true;
      }
      return true;
    });

    await stopMcp(pidPath, 99996, { verifyIdentity: () => true });

    expect(existsSync(pidPath)).toBe(false);
    // SIGTERM was sent
    const termCalls = killMock.mock.calls.filter(([, sig]) => sig === "SIGTERM");
    expect(termCalls.length).toBeGreaterThan(0);

    killMock.mockRestore();
    rmSync(dir, { recursive: true });
  });

  it("removes PID file even when process is already dead", async () => {
    const dir = makeTmpDir();
    const pidPath = join(dir, "mcp-dead.pid");

    const { writePidFile, stopMcp } = await import("../process.js");
    writePidFile(pidPath, {
      pid: 99995,
      started_at_unix: 1700000000,
      command: "node bin.js",
    });

    // Process already dead — signal 0 always throws
    const killMock = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    });

    await stopMcp(pidPath, 99995, { verifyIdentity: () => true });
    expect(existsSync(pidPath)).toBe(false);

    killMock.mockRestore();
    rmSync(dir, { recursive: true });
  });

  it("refuses to signal a live PID when process identity does not match", async () => {
    const dir = makeTmpDir();
    const pidPath = join(dir, "mcp-mismatch.pid");
    const { writePidFile, stopMcp } = await import("../process.js");
    writePidFile(pidPath, {
      pid: 99994,
      started_at_unix: 1700000000,
      command: "node expected-bin.js",
    });
    const killMock = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error("signal should not be sent");
    });

    await expect(
      stopMcp(pidPath, 99994, { verifyIdentity: () => false }),
    ).rejects.toThrow(/identity does not match/);
    expect(killMock.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(existsSync(pidPath)).toBe(true);

    killMock.mockRestore();
    rmSync(dir, { recursive: true });
  });
});
