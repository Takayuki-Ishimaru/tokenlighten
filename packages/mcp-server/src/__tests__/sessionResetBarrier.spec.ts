import { afterEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  reroot: vi.fn(() => "/next-workspace"),
  stop: vi.fn(),
  settled: vi.fn<() => Promise<void> | undefined>(),
  resetWarmup: vi.fn(),
}));
vi.mock("../server.js", () => ({ resetServerStateForSessionReset: seam.reroot }));
vi.mock("../util/startupWarmup.js", () => ({
  noteToolCallStarted: seam.stop,
  startupWarmupSettledForTest: seam.settled,
  resetStartupWarmupForTest: seam.resetWarmup,
}));

import { resetServerSessionForTests, TEST_RESET_STDERR_PREFIX } from "../testing/sessionReset.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  seam.settled.mockReset();
});

describe("test-session stderr barrier", () => {
  it("drains old warm-up before resetting its latch and emitting the barrier", async () => {
    let finish!: () => void;
    seam.settled.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const resetting = resetServerSessionForTests({ workspaceRoot: "/next-workspace", stderrBarrier: "tl-pool-reset-12" });
    await Promise.resolve();
    expect(seam.stop).toHaveBeenCalledOnce();
    expect(seam.resetWarmup).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    finish();
    await expect(resetting).resolves.toEqual({ reset: true, root: "/next-workspace" });
    expect(seam.resetWarmup).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(`${TEST_RESET_STDERR_PREFIX}tl-pool-reset-12\n`);
    expect(seam.resetWarmup.mock.invocationCallOrder[0]).toBeLessThan(stderr.mock.invocationCallOrder[0]!);
  });

  it.each(["", "bad\nmarker", "bad\rmarker", "\u001eother", "x".repeat(81), null, 4])(
    "rejects unsafe marker %j before changing session state",
    async (stderrBarrier) => {
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      await expect(resetServerSessionForTests({ workspaceRoot: "/next-workspace", stderrBarrier })).rejects.toThrow("params.stderrBarrier");
      expect(seam.reroot).not.toHaveBeenCalled();
      expect(seam.stop).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    },
  );

  it("keeps reset callers without a barrier silent", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(resetServerSessionForTests({ workspaceRoot: "/next-workspace" })).resolves.toEqual({ reset: true, root: "/next-workspace" });
    expect(stderr).not.toHaveBeenCalled();
  });
});
