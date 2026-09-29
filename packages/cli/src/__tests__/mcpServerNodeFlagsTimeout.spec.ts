/**
 * mcpServerNodeFlagsTimeout.spec.ts — regression for round-2 evaluation finding P2-17(c):
 * `serverNodeFlags`'s `--liftoff-only --version` probe used a 10 s `spawnSync` timeout. A runtime that
 * hangs instead of exiting non-zero on the flag (rather than one that is simply missing — ENOENT resolves
 * near-instantly and is covered by mcp.spec.ts) delayed `tl mcp start` by the full 10 s before falling back
 * to no flag. The timeout is now 3 s.
 *
 * A separate file (never edits mcp.spec.ts's shared spawn/fs mocks) because this test needs a REAL
 * executable on disk that spawnSync can actually exec and that hangs past the timeout.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("serverNodeFlags — bounded probe timeout", () => {
  it("falls back to no flag well under the old 10s timeout when the probed runtime hangs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-hang-probe-"));
    const script = join(dir, "hangs");
    try {
      writeFileSync(script, "#!/bin/sh\nsleep 30\n");
      chmodSync(script, 0o755);

      const { serverNodeFlags } = await import("../commands/mcp.js");
      const start = Date.now();
      expect(serverNodeFlags(script)).toEqual([]);
      const elapsedMs = Date.now() - start;

      // Actually hit the timeout (not a fast ENOENT-style failure) but nowhere near the old 10s bound.
      expect(elapsedMs).toBeGreaterThanOrEqual(2500);
      expect(elapsedMs).toBeLessThan(8000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
