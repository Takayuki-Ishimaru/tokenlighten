// firstPackMatrix.ts — test-only serial matrix runner shared by
// firstPackPrecisionEval.spec.ts (query x variant matrix) and
// firstPackMatrix.spec.ts (the runner's own contract tests).
//
// WHY IT EXISTS: the matrix mutates process.env and non-ALS module state, so
// every cell must run alone, and a Vitest timeout leaves the previous cell's
// promise still running. The runner therefore (a) awaits the previous cell's
// FULL settlement before starting the next one, (b) never abandons a promise
// (no Promise.race), and (c) records every planned cell so a partial run is
// reported as partial instead of silently passing or cascading.

export type MatrixCellStatus = "planned" | "running" | "passed" | "failed" | "not-run";

export interface MatrixCell {
  /** `${queryId}::${variant}` — the cell's identity in the tracker. */
  key: string;
  queryId: string;
  variant: string;
}

export interface MatrixCellRecord extends MatrixCell {
  status: MatrixCellStatus;
  detail?: string;
}

export interface MatrixSummary {
  planned: number;
  running: number;
  passed: number;
  failed: number;
  notRun: number;
  /** True only when every planned cell passed. */
  complete: boolean;
  cells: MatrixCellRecord[];
}

export interface MatrixRunnerOptions<M> {
  /** Runs one cell. Called with the previous cell fully settled. */
  run: (cell: MatrixCell, signal: AbortSignal | undefined) => M | Promise<M>;
  /** Binds the cell's cancellation signal (production: runWithRequestSignal). */
  bindSignal?: (signal: AbortSignal | undefined, fn: () => Promise<M>) => Promise<M>;
  /** A cell whose metrics carry an error is a FAILURE, not a success. */
  failureOf?: (metrics: M) => string | undefined;
  /** Observability hook: called once per cell when it settles. */
  onSettled?: (record: MatrixCellRecord, metrics: M | undefined) => void;
}

export function matrixCellKey(queryId: string, variant: string): string {
  return `${queryId}::${variant}`;
}

/**
 * Sequential tracker + runner for one matrix. `runCell` serializes on the
 * previously started cell so env/cache resets can never overlap it.
 */
export function createMatrixRunner<M>(cells: readonly MatrixCell[], options: MatrixRunnerOptions<M>) {
  const order: MatrixCell[] = [...cells];
  const records = new Map<string, MatrixCellRecord>();
  const metricsByKey = new Map<string, M>();
  for (const cell of order) {
    if (records.has(cell.key)) {
      throw new Error(`duplicate matrix cell planned: ${cell.queryId} :: ${cell.variant}`);
    }
    records.set(cell.key, { ...cell, status: "planned" });
  }

  let previous: Promise<void> = Promise.resolve();

  function record(key: string): MatrixCellRecord {
    const found = records.get(key);
    if (!found) throw new Error(`unknown matrix cell: ${key.replace("::", " :: ")}`);
    return found;
  }

  function settle(key: string, status: MatrixCellStatus, detail: string | undefined, metrics?: M): void {
    const found = record(key);
    found.status = status;
    if (detail !== undefined) found.detail = detail;
    if (metrics !== undefined) {
      metricsByKey.set(key, metrics);
      options.onSettled?.(found, metrics);
    } else {
      options.onSettled?.(found, undefined);
    }
  }

  /** A human-readable "query :: variant" prefix for every runner error. */
  function label(key: string): string {
    const found = record(key);
    return `${found.queryId} :: ${found.variant}`;
  }

  /** Awaiting this never rejects, even if the in-flight cell was canceled. */
  function drain(): Promise<void> {
    return previous;
  }

  /**
   * NOT async on purpose: the previous tail is captured and the new tail
   * assigned synchronously, so two immediate calls can never both see an idle
   * queue and start together.
   */
  function runCell(key: string, signal?: AbortSignal): Promise<M> {
    const found = record(key);
    if (found.status !== "planned") {
      const dup = Promise.reject(
        new Error(`${label(key)}: cell already ${found.status} — the matrix must measure each cell exactly once`),
      );
      dup.catch(empty);
      return dup;
    }
    const pending = previous.then(async () => {
      // A duplicate may have been queued before the first call started.
      if (found.status !== "planned") {
        throw new Error(`${label(key)}: cell already ${found.status} — the matrix must measure each cell exactly once`);
      }
      if (signal?.aborted) {
        settle(key, "not-run", "canceled before the cell started");
        throw new Error(`${label(key)}: not run — canceled before the cell started`);
      }
      settle(key, "running", undefined);
      try {
        const metrics = await (options.bindSignal && signal
          ? options.bindSignal(signal, () => Promise.resolve(options.run(found, signal)))
          : Promise.resolve(options.run(found, signal)));
        // A cancel that arrived while the body ran is a failure even when the
        // body still returned metrics: the cell never finished under its signal.
        const failure = signal?.aborted
          ? "canceled while the cell was running"
          : options.failureOf
            ? options.failureOf(metrics)
            : undefined;
        settle(key, failure === undefined ? "passed" : "failed", failure, metrics);
        if (failure !== undefined) throw new Error(`${label(key)}: ${failure}`);
        return metrics;
      } catch (err) {
        if (record(key).status === "running") {
          settle(key, "failed", err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    });
    // Tail includes this cell's state settlement, so `await drain()` can never
    // observe the record still "running".
    previous = pending.then(empty, empty);
    return pending;
  }

  function summary(): MatrixSummary {
    const cells: MatrixCellRecord[] = order.map((cell) => {
      const current = records.get(cell.key)!;
      return { ...current, status: current.status === "planned" ? "not-run" : current.status };
    });
    const count = (status: MatrixCellStatus) => cells.filter((c) => c.status === status).length;
    return {
      planned: cells.length,
      running: count("running"),
      passed: count("passed"),
      failed: count("failed"),
      notRun: count("not-run"),
      complete: cells.length > 0 && cells.every((c) => c.status === "passed"),
      cells,
    };
  }

  function metricsFor(key: string): M | undefined {
    return metricsByKey.get(key);
  }

  function allMetrics(): M[] {
    return order.map((cell) => metricsByKey.get(cell.key)).filter((m): m is M => m !== undefined);
  }

  /**
   * Gate for the per-query rollback comparisons: they are only meaningful when
   * EVERY variant cell of that query produced metrics. Otherwise the caller
   * marks them not-run with these blockers instead of failing on missing data.
   */
  function queryGate(queryId: string): { ready: boolean; blockers: string[] } {
    const blockers: string[] = [];
    for (const cell of order) {
      if (cell.queryId !== queryId) continue;
      const found = records.get(cell.key)!;
      if (found.status !== "passed") {
        blockers.push(`${cell.queryId} :: ${cell.variant} — ${found.status}${found.detail ? ` (${found.detail})` : ""}`);
      }
    }
    return { ready: blockers.length === 0, blockers };
  }

  return { runCell, drain, summary, metricsFor, allMetrics, queryGate, plannedKeys: () => order.map((c) => c.key) };
}

async function empty(): Promise<void> {}

export type ComparisonStatus = "passed" | "failed" | "not-run";

export interface ComparisonRecord {
  queryId: string;
  name: string;
  status: ComparisonStatus;
  detail?: string;
}

/** Collects per-query comparison outcomes for the final report. */
export function createComparisonLedger(planned: readonly { queryId: string; name: string }[] = []) {
  const key = (queryId: string, name: string) => JSON.stringify([queryId, name]);
  const records = new Map<string, ComparisonRecord>();
  for (const entry of planned) records.set(key(entry.queryId, entry.name), {
    ...entry, status: "not-run", detail: "matrix cells have not all completed",
  });
  return {
    record(queryId: string, name: string, status: ComparisonStatus, detail?: string): void {
      records.set(key(queryId, name), { queryId, name, status, ...(detail ? { detail } : {}) });
    },
    all(): ComparisonRecord[] {
      return [...records.values()].map((record) => ({ ...record }));
    },
  };
}

/**
 * Emits the report BEFORE cleanup, and cleans up even when reporting throws —
 * the report error still propagates so a broken report is never silent.
 */
export async function reportThenCleanup(report: () => void, cleanup: () => void): Promise<void> {
  let reportError: unknown;
  let reportFailed = false;
  try {
    await report();
  } catch (err) {
    reportFailed = true;
    reportError = err;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (!reportFailed) throw cleanupError;
  }
  if (reportFailed) throw reportError;
}
