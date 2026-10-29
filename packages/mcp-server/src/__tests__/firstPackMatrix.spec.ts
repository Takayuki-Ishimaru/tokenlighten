// firstPackMatrix.spec.ts — contract tests for the test-only matrix runner
// used by firstPackPrecisionEval.spec.ts. No product code and no corpus here:
// the runner's guarantees (exactly-once cells, serialized env-like finally,
// canceled cells never executing, partial runs reported as partial, report
// before cleanup) must hold for injected fakes alone.

import { describe, it, expect } from "vitest";

import {
  createMatrixRunner,
  createComparisonLedger,
  matrixCellKey,
  reportThenCleanup,
  type MatrixCell,
} from "./helpers/firstPackMatrix.js";

interface FakeMetrics {
  error?: string;
}

function cells(queryIds: string[], variants: string[]): MatrixCell[] {
  const out: MatrixCell[] = [];
  for (const variant of variants) {
    for (const queryId of queryIds) out.push({ key: matrixCellKey(queryId, variant), queryId, variant });
  }
  return out;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeRunner(
  planned: MatrixCell[],
  body: (cell: MatrixCell) => Promise<FakeMetrics> | FakeMetrics,
  extra: { bindSignal?: (signal: AbortSignal | undefined, fn: () => Promise<FakeMetrics>) => Promise<FakeMetrics> } = {},
) {
  const started: string[] = [];
  const finished: string[] = [];
  const runner = createMatrixRunner<FakeMetrics>(planned, {
    run: async (cell) => {
      started.push(cell.key);
      const metrics = await body(cell);
      finished.push(cell.key);
      return metrics;
    },
    failureOf: (metrics) => (metrics.error !== undefined ? `runQuery returned error metrics (${metrics.error})` : undefined),
    ...extra,
  });
  return { runner, started, finished };
}

describe("firstPackMatrix runner", () => {
  it("success path: every planned cell runs exactly once and the matrix is complete", async () => {
    const planned = cells(["Q1", "Q2"], ["v1", "v2", "v3"]);
    const { runner, started, finished } = makeRunner(planned, () => ({}));
    for (const key of runner.plannedKeys()) await runner.runCell(key);

    expect(started).toHaveLength(planned.length);
    expect(new Set(started).size).toBe(planned.length);
    expect(finished).toEqual(started);
    const summary = runner.summary();
    expect(summary).toMatchObject({ planned: 6, passed: 6, failed: 0, notRun: 0, running: 0, complete: true });
    expect(runner.allMetrics()).toHaveLength(6);
    expect(runner.queryGate("Q1")).toEqual({ ready: true, blockers: [] });
  });

  it("a second run of a passed cell is refused: each cell is measured exactly once", async () => {
    const planned = cells(["Q1"], ["v1"]);
    const { runner, started } = makeRunner(planned, () => ({}));
    await runner.runCell(planned[0]!.key);
    await expect(runner.runCell(planned[0]!.key)).rejects.toThrow(/Q1 :: v1/);
    expect(started).toHaveLength(1);
  });

  it.each(["boom", ""])("metrics carrying error %j FAIL the cell and retain the measurement", async (error) => {
    const planned = cells(["Q1"], ["v1"]);
    const { runner } = makeRunner(planned, () => ({ error }));
    await expect(runner.runCell(planned[0]!.key)).rejects.toThrow("Q1 :: v1");
    const summary = runner.summary();
    expect(summary.passed).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.cells[0]!.status).toBe("failed");
    expect(runner.allMetrics()).toEqual([{ error }]);
    await expect(runner.runCell(planned[0]!.key)).rejects.toThrow(/already failed/);
  });

  it("rejection stops the comparisons of that query without a missing-result cascade", async () => {
    const planned = cells(["Q1", "Q2"], ["v1", "v2"]);
    const { runner } = makeRunner(planned, (cell) => (cell.key === matrixCellKey("Q1", "v2") ? Promise.reject(new Error("kaboom")) : {}));
    for (const key of runner.plannedKeys()) await runner.runCell(key).catch(() => undefined);

    const ledger = createComparisonLedger();
    const gateQ1 = runner.queryGate("Q1");
    expect(gateQ1.ready).toBe(false);
    expect(gateQ1.blockers.join("\n")).toContain("Q1 :: v2");
    for (const name of ["rollback:fp_off", "rollback:concern_recovery_off"]) {
      ledger.record("Q1", name, "not-run", gateQ1.blockers.join("; "));
    }
    const gateQ2 = runner.queryGate("Q2");
    expect(gateQ2.ready).toBe(true);
    const recorded = ledger.all();
    expect(recorded).toHaveLength(2);
    expect(recorded.every((r) => r.status === "not-run")).toBe(true);
    expect(recorded.every((r) => r.detail?.includes("Q1 :: v2"))).toBe(true);
  });

  it("an env-like finally settles BEFORE the next cell starts", async () => {
    const planned = cells(["Q1"], ["v1", "v2"]);
    const events: string[] = [];
    const fakeEnv: Record<string, string> = {};
    const { runner } = makeRunner(planned, async (cell) => {
      events.push(`start:${cell.key}`);
      fakeEnv["TL_FLAG"] = cell.variant;
      try {
        await Promise.resolve();
        events.push(`body:${cell.key}=${fakeEnv["TL_FLAG"]}`);
      } finally {
        delete fakeEnv["TL_FLAG"];
        events.push(`finally:${cell.key}`);
      }
      return {};
    });
    await runner.runCell(planned[0]!.key);
    await runner.runCell(planned[1]!.key);
    expect(events).toEqual([
      "start:Q1::v1",
      "body:Q1::v1=v1",
      "finally:Q1::v1",
      "start:Q1::v2",
      "body:Q1::v2=v2",
      "finally:Q1::v2",
    ]);
    expect(fakeEnv).toEqual({});
  });

  it("a slow cell is awaited to settlement before the next one starts (no race-and-abandon)", async () => {
    const planned = cells(["Q1"], ["v1", "v2"]);
    const began = deferred();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, started } = makeRunner(planned, async (cell) => {
      if (cell.key === planned[0]!.key) { began.resolve(); await gate; }
      return {};
    });
    const first = runner.runCell(planned[0]!.key);
    const second = runner.runCell(planned[1]!.key);
    await began.promise;
    expect(started).toEqual([planned[0]!.key]);
    release();
    await Promise.all([first, second]);
    expect(started).toEqual([planned[0]!.key, planned[1]!.key]);
  });

  it("afterEach-style drain settles a canceled in-flight cell before the next one", async () => {
    const planned = cells(["Q1"], ["v1", "v2"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let drained = false;
    const { runner, finished } = makeRunner(planned, async (cell) => {
      if (cell.key === planned[0]!.key) await gate;
      return {};
    });
    const first = runner.runCell(planned[0]!.key);
    const draining = runner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
    // drain() includes the cell's state settlement, so it can never be running.
    expect(runner.summary().cells[0]!.status).toBe("passed");
    await first;
    expect(finished).toContain(planned[0]!.key);
  });

  it("a cancel while the callback is blocked FAILS the cell even if it returns metrics", async () => {
    const planned = cells(["Q1"], ["v1", "v2"]);
    const controller = new AbortController();
    const began = deferred();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const fakeEnv: Record<string, string> = {};
    const runner = createMatrixRunner<FakeMetrics>(planned, {
      run: async (cell, signal) => {
        events.push(`start:${cell.key}`);
        fakeEnv["TL_FLAG"] = cell.variant;
        try {
          if (cell.key === planned[0]!.key) { began.resolve(); await gate; }
          expect(Boolean(signal?.aborted), cell.key).toBe(cell.key === planned[0]!.key);
          return {};
        } finally {
          delete fakeEnv["TL_FLAG"];
          events.push(`finally:${cell.key}`);
        }
      },
    });
    const first = runner.runCell(planned[0]!.key, controller.signal);
    first.catch(() => undefined);
    const second = runner.runCell(planned[1]!.key);
    second.catch(() => undefined);
    await began.promise;
    expect(events).toEqual(["start:Q1::v1"]);
    controller.abort();
    release();
    await Promise.all([first.catch(() => undefined), second]);
    expect(events).toEqual(["start:Q1::v1", "finally:Q1::v1", "start:Q1::v2", "finally:Q1::v2"]);
    expect(fakeEnv).toEqual({});
    const summary = runner.summary();
    expect(summary.cells[0]!.status).toBe("failed");
    expect(summary.cells[0]!.detail).toContain("canceled");
    expect(summary.cells[1]!.status).toBe("passed");
    expect(runner.queryGate("Q1").blockers.join(" ")).toContain("Q1 :: v1");
  });

  it("a canceled queued cell never executes and is reported not-run", async () => {
    const planned = cells(["Q1"], ["v1"]);
    const { runner, started } = makeRunner(planned, () => ({}));
    const controller = new AbortController();
    controller.abort();
    await expect(runner.runCell(planned[0]!.key, controller.signal)).rejects.toThrow(/Q1 :: v1/);
    expect(started).toEqual([]);
    const summary = runner.summary();
    expect(summary.notRun).toBe(1);
    expect(summary.cells[0]!.status).toBe("not-run");
  });

  it("the cell signal is bound for the whole cell body (runWithRequestSignal shape)", async () => {
    const planned = cells(["Q1"], ["v1"]);
    const seen: (boolean | undefined)[] = [];
    const { runner } = makeRunner(planned, () => ({}), {
      bindSignal: (signal, fn) => {
        seen.push(signal?.aborted);
        return fn();
      },
    });
    await runner.runCell(planned[0]!.key, new AbortController().signal);
    expect(seen).toEqual([false]);
  });

  it("every planned cell is represented, run or not, and never duplicated", async () => {
    const planned = cells(["Q1", "Q2"], ["v1", "v2"]);
    const { runner } = makeRunner(planned, () => ({}));
    await runner.runCell(matrixCellKey("Q1", "v1"));
    const summary = runner.summary();
    expect(summary.planned).toBe(4);
    expect(summary.passed).toBe(1);
    expect(summary.notRun).toBe(3);
    expect(summary.complete).toBe(false);
    expect(summary.cells.map((c) => c.key)).toEqual(planned.map((c) => c.key));
    expect(new Set(summary.cells.map((c) => c.key)).size).toBe(4);
    expect(summary.cells.filter((c) => c.status === "not-run")).toHaveLength(3);
  });

  it("two immediate requests for the same planned cell execute its body once", async () => {
    const planned = cells(["Q1"], ["v1"]);
    const { runner, started } = makeRunner(planned, () => ({}));
    const first = runner.runCell(planned[0]!.key);
    const duplicate = runner.runCell(planned[0]!.key);
    duplicate.catch(() => undefined);
    await first;
    await expect(duplicate).rejects.toThrow(/already passed/);
    expect(started).toHaveLength(1);
  });

  it("cancellation while queued never starts the second body", async () => {
    const planned = cells(["Q1"], ["v1", "v2"]);
    const began = deferred();
    const release = deferred();
    const { runner, started } = makeRunner(planned, async () => { began.resolve(); await release.promise; return {}; });
    const first = runner.runCell(planned[0]!.key);
    const controller = new AbortController();
    const second = runner.runCell(planned[1]!.key, controller.signal);
    second.catch(() => undefined);
    await began.promise;
    controller.abort();
    release.resolve();
    await first;
    await expect(second).rejects.toThrow(/canceled before/);
    await runner.drain();
    expect(started).toEqual([planned[0]!.key]);
    expect(runner.summary()).toMatchObject({ passed: 1, notRun: 1, complete: false });
  });

  it("preplanned comparisons retain not-run rows and update without duplicates", () => {
    const ledger = createComparisonLedger([{ queryId: "Q1", name: "floor" }, { queryId: "Q2", name: "floor" }]);
    ledger.record("Q1", "floor", "passed");
    expect(ledger.all()).toMatchObject([
      { queryId: "Q1", name: "floor", status: "passed" },
      { queryId: "Q2", name: "floor", status: "not-run" },
    ]);
  });

  it("waits for asynchronous reporting before cleanup and propagates a thrown undefined", async () => {
    const began = deferred();
    const release = deferred();
    const order: string[] = [];
    const reporting = reportThenCleanup(async () => {
      order.push("report-start"); began.resolve(); await release.promise; order.push("report-finish");
    }, () => { order.push("cleanup"); });
    await began.promise;
    expect(order).toEqual(["report-start"]);
    release.resolve();
    await reporting;
    expect(order).toEqual(["report-start", "report-finish", "cleanup"]);
    let cleaned = false;
    await expect(reportThenCleanup(() => { throw undefined; }, () => { cleaned = true; })).rejects.toBeUndefined();
    expect(cleaned).toBe(true);
  });

  it("planning the same cell twice is a validation error naming query + variant", () => {
    expect(() => createMatrixRunner<FakeMetrics>([...cells(["Q1"], ["v1"]), ...cells(["Q1"], ["v1"])], { run: () => ({}) })).toThrow(
      "Q1 :: v1",
    );
  });

  it("reporting runs before cleanup, and cleanup still runs when reporting throws", async () => {
    const order: string[] = [];
    await reportThenCleanup(
      () => order.push("report"),
      () => order.push("cleanup"),
    );
    expect(order).toEqual(["report", "cleanup"]);

    const order2: string[] = [];
    await expect(
      reportThenCleanup(
        () => {
          order2.push("report");
          throw new Error("report blew up");
        },
        () => order2.push("cleanup"),
      ),
    ).rejects.toThrow("report blew up");
    expect(order2).toEqual(["report", "cleanup"]);
  });
});
