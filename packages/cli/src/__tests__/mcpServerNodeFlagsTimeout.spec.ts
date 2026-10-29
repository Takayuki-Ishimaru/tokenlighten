/**
 * mcpServerNodeFlagsTimeout.spec.ts — regression for round-2 evaluation finding P2-17(c):
 * `serverNodeFlags`'s `--liftoff-only --version` probe used a 10 s `spawnSync` timeout. A runtime that
 * hangs instead of exiting non-zero on the flag (rather than one that is simply missing — ENOENT resolves
 * near-instantly and is covered by mcp.spec.ts) delayed `tl mcp start` by the full 10 s before falling back
 * to no flag. The timeout is now 3 s.
 *
 * A separate file (never edits mcp.spec.ts's shared spawn/fs mocks) because this test needs a REAL
 * child process that really hangs past the timeout. A POSIX shell fixture is
 * not executable on Windows, so the probe seam runs a hanging Node child.
 */
import { describe, it, expect, vi } from "vitest";

const probe = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  probe.spawn.mockImplementation((_file, _args, options) => actual.spawnSync(
    process.execPath, ["-e", "setTimeout(() => {}, 30000)"], options,
  ));
  return { ...actual, spawnSync: probe.spawn };
});

describe("serverNodeFlags — bounded probe timeout", () => {
  it("falls back to no flag well under the old 10s timeout when the probed runtime hangs", async () => {
    const { serverNodeFlags } = await import("../commands/mcp.js");
    const start = Date.now();
    expect(serverNodeFlags(process.execPath)).toEqual([]);
    const elapsedMs = Date.now() - start;
    expect(probe.spawn).toHaveBeenCalledWith(process.execPath, ["--liftoff-only", "--version"],
      expect.objectContaining({ shell: false, timeout: 3000 }));

    // Actually hit the timeout (not a fast ENOENT-style failure) but nowhere near the old 10s bound.
    expect(elapsedMs).toBeGreaterThanOrEqual(2500);
    expect(elapsedMs).toBeLessThan(8000);
  }, 15_000);
});
