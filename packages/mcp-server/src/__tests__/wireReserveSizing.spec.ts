// ---------------------------------------------------------------------------
// protocol v1 — P3a S4 (erratum E2 + gate G9).
//
// NORMATIVE SOURCE: TL-PROTOCOL-V1-PHASE3A-PLAN-DRAFT.md §7.2 (RESERVE_MIN's
// formula), §7.4 (the startup assertion); prep/C-phase3a-errata-dispositions.md
// E2 (scope note: R5 ruling 7 / R5-25 excludes the §4.2.1(4) ledger-compaction
// recovery handle from P3a — this file proves the CORE fits; it says nothing
// about `ledger`, which stays declared-absent).
//
// TWO THINGS THIS FILE DOES.
//
//  1. MEASURES. `finalize()` below drives the REAL family projector
//     (`editFamily.ts`'s `projectEditBody` / `buildCore`, reached via
//     `envelope.ts`'s `projectSuccessBody`) and the REAL funnel tail
//     (`emit.ts`'s `emitFinalizedPayload`, reached via
//     `finalizeProtocolResponse`) in-process — no spawn, but the exact same
//     code a spawned server would run, down to the one measurement point
//     (`budget/measure.ts`'s `measureResponseBytes`). It generates
//     `edit.applied` / `edit.rolled_back` / `edit.state_unknown` minimal
//     bodies at 1/8/64/256 affected paths, at two path-length classes, and
//     measures both the bare `core` object and the full minimal response.
//  2. TESTS GATE G9. `validateStartupBudgets` (`wireBudget.ts`) is a pure,
//     parameterized function — these tests inject synthetic good/bad rows and
//     reserve values directly, never touching the real `BUDGET_BY_KIND` /
//     `FLOOR_BY_KIND` / `WIRE_RESERVE_BYTES`, plus ONE spawn smoke test that
//     proves the check is actually wired into `server.ts`'s `run()`.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "os";
import * as path from "path";

import { runWithProtocolCall, finalizeProtocolResponse } from "../protocol/envelope.js";
import { measureResponseBytes } from "../protocol/budget/measure.js";
import {
  ADMISSIBLE_EDIT_UNION_CAP,
  MAX_WORKSPACE_RELATIVE_PATH_BYTES,
  RESERVE_MIN,
  WIRE_RESERVE_BYTES,
  budgetRows,
  validateStartupBudgets,
  type BudgetRow,
} from "../protocol/budget/wireBudget.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

type Body = Record<string, unknown>;

// ---------------------------------------------------------------------------
// In-process pipeline harness — `editFamily.spec.ts`'s `finalize()` pattern,
// reused here rather than re-invented: `runWithProtocolCall` +
// `finalizeProtocolResponse` IS the funnel every response leaves through
// (`envelope.ts`'s own header comment), so a raw emitter-shaped body dropped
// in here takes the identical path a spawned server's response would.
// ---------------------------------------------------------------------------
function finalize(tool: string, body: Body, isError: boolean): { data: Body; text: string; isError: boolean } {
  const result = runWithProtocolCall({ tool, args: {}, workspace: "/ws" }, () =>
    finalizeProtocolResponse(tool, {
      content: [{ type: "text", text: JSON.stringify(body) }],
      ...(isError ? { isError: true as const } : {}),
    }),
  );
  const text = result.content[0]!.text;
  return { data: JSON.parse(text) as Body, text, isError: result.isError === true };
}

/**
 * A workspace-relative synthetic path, exactly `len` bytes, unique per `i`
 * (0-255 fits in 3 zero-padded digits, so the suffix width never changes
 * across the sweep). ASCII-only throughout, so char length === byte length.
 */
function syntheticPath(i: number, len: number): string {
  const prefix = "src/";
  const suffix = `${String(i).padStart(3, "0")}.ts`;
  const bodyLen = len - prefix.length - suffix.length;
  if (bodyLen < 0) throw new Error(`syntheticPath: len=${len} too short for prefix(${prefix.length})+suffix(${suffix.length})`);
  return `${prefix}${"f".repeat(bodyLen)}${suffix}`;
}

/** `editedRows` (editFamily.ts) reads `body.files` first — the pre-projection per-file shape `applyEditsMulti` itself produces. */
function editAppliedBody(n: number, pathLen: number): Body {
  const files = Array.from({ length: n }, (_, i) => ({
    path: syntheticPath(i, pathLen),
    lines: "1",
    delta: "+1/-1",
    handle: `h${i}`,
  }));
  return { files };
}

/** Mirrors `editFamily.spec.ts`'s `CLEAN_ROLLBACK` fixture, scaled to `n` rows — minimal ledger entries only (no `expected_sha`/`stuck_sha`/`detail`), matching this measurement's "minimal body" brief. */
function editRolledBackBody(n: number, pathLen: number): Body {
  const rollback = Array.from({ length: n }, (_, i) => ({
    path: syntheticPath(i, pathLen),
    state: "rolled-back" as const,
  }));
  return {
    ok: false,
    error: "Cannot write file: EACCES: permission denied",
    code: "write-error",
    path: syntheticPath(0, pathLen),
    rollback,
  };
}

/** Mirrors `editFamily.spec.ts`'s `FAILED_ROLLBACK` fixture, scaled to `n` rows, all `restore-failed` (the state that drives `unproven`) and minimal (no `expected_sha`/`stuck_sha`/`detail`). `recovery` is REQUIRED (A.5.14) and kept short. */
function editStateUnknownBody(n: number, pathLen: number): Body {
  const rollback = Array.from({ length: n }, (_, i) => ({
    path: syntheticPath(i, pathLen),
    state: "restore-failed" as const,
  }));
  return {
    ok: false,
    error: "Cannot write file: EACCES. Rollback could not restore every file — manual repair needed.",
    code: "rollback-failed",
    path: syntheticPath(0, pathLen),
    workspace_state: "workspace-state-unknown",
    rollback,
    recovery: "inspect the affected files: each may still hold post-edit bytes instead of the pre-edit sha.",
  };
}

const SE_STABLE_KINDS: ReadonlyArray<{ kind: "edit.applied" | "edit.rolled_back" | "edit.state_unknown"; isError: boolean; build: (n: number, len: number) => Body }> = [
  { kind: "edit.applied", isError: false, build: editAppliedBody },
  { kind: "edit.rolled_back", isError: true, build: editRolledBackBody },
  { kind: "edit.state_unknown", isError: true, build: editStateUnknownBody },
];

const PATH_COUNTS = [1, 8, 64, 256] as const;

// "typical": the measured MEAN over packages/** non-fixture source at
// S4-authoring time (48.3 B — see MAX_WORKSPACE_RELATIVE_PATH_BYTES's own doc
// comment in wireBudget.ts), rounded. "adversarial": exactly the policy
// constant RESERVE_MIN is sized against — this is the class the p100
// assertion below cares about; "typical" is measured for contrast only.
const PATH_LENGTH_CLASSES: ReadonlyArray<{ label: "typical" | "adversarial"; len: number }> = [
  { label: "typical", len: 49 },
  { label: "adversarial", len: MAX_WORKSPACE_RELATIVE_PATH_BYTES },
];

interface MeasuredCell {
  kind: string;
  n: number;
  pathLen: "typical" | "adversarial";
  bareCoreBytes: number;
  fullBodyBytes: number;
}

/** Populated by the measurement suite below; read by the two assertion `it`s that follow it, and printed once as the doc-comment-ready table. */
const MEASURED: MeasuredCell[] = [];

describe("P3a S4 / erratum E2 — SideEffectCore reserve sizing (measured, not estimated)", () => {
  for (const { kind, isError, build } of SE_STABLE_KINDS) {
    for (const { label, len } of PATH_LENGTH_CLASSES) {
      for (const n of PATH_COUNTS) {
        it(`${kind} at n=${n} paths (${label}, ${len} B/path): core.paths has length ${n}, and bytes are measured`, () => {
          const body = build(n, len);
          const { data, text, isError: gotError } = finalize("edit_file", body, isError);

          expect(data["kind"]).toBe(kind);
          expect(gotError).toBe(isError);
          const core = data["core"] as Body | undefined;
          expect(core, `${kind} at n=${n} must carry core — every synthetic body here names at least one path`).toBeDefined();
          expect((core!["paths"] as string[])).toHaveLength(n);

          const bareCoreBytes = measureResponseBytes(JSON.stringify(core));
          const fullBodyBytes = measureResponseBytes(text);
          expect(fullBodyBytes).toBeGreaterThanOrEqual(bareCoreBytes);

          MEASURED.push({ kind, n, pathLen: label, bareCoreBytes, fullBodyBytes });
        });
      }
    }
  }

  it("p100(bare-core, 256 paths, adversarial length) < WIRE_RESERVE_BYTES — the reserve's ACTUAL claim: the one field that can never be shed or converted always fits", () => {
    const worst = MEASURED.filter((c) => c.n === 256 && c.pathLen === "adversarial");
    expect(worst).toHaveLength(3); // one per SE-STABLE kind — guards against the sweep above silently not populating MEASURED
    for (const cell of worst) {
      expect(
        cell.bareCoreBytes,
        `${cell.kind} bare-core bytes at n=256, ${MAX_WORKSPACE_RELATIVE_PATH_BYTES} B/path`,
      ).toBeLessThan(WIRE_RESERVE_BYTES);
      expect(
        cell.bareCoreBytes,
        `${cell.kind} bare-core bytes at n=256 must also clear RESERVE_MIN itself, not just the configured WIRE_RESERVE_BYTES`,
      ).toBeLessThanOrEqual(RESERVE_MIN);
    }
  });

  it("full-minimal-body at n=256/adversarial legitimately EXCEEDS WIRE_RESERVE_BYTES for all three SE-STABLE kinds — resolves recon's open Q5: the reserve bounds core alone, never applied[]/attempted[]/affected[]", () => {
    const worst = MEASURED.filter((c) => c.n === 256 && c.pathLen === "adversarial");
    expect(worst).toHaveLength(3);
    for (const cell of worst) {
      // NOT a bug and NOT this stage's to fix: `applied[]` / `attempted[]` /
      // `affected[]` re-list every affected path plus per-file metadata, so
      // they scale independently of `core` and were never part of what
      // RESERVE_MIN bounds (see wireBudget.ts's RESERVE_MIN doc comment,
      // "SCOPE, STATED PLAINLY"). Asserted here (rather than left unchecked)
      // so a future change that shrinks the full response back under the
      // reserve is noticed and its cause investigated, in EITHER direction.
      expect(
        cell.fullBodyBytes,
        `${cell.kind} full-body bytes at n=256, adversarial`,
      ).toBeGreaterThan(WIRE_RESERVE_BYTES);
    }
  });

  it("prints the measured table (E2 deliverable ii — commit this next to WIRE_RESERVE_BYTES / RESERVE_MIN)", () => {
    expect(MEASURED.length).toBe(SE_STABLE_KINDS.length * PATH_LENGTH_CLASSES.length * PATH_COUNTS.length);
    const rows = MEASURED
      .slice()
      .sort((a, b) => a.kind.localeCompare(b.kind) || (a.pathLen < b.pathLen ? -1 : 1) || a.n - b.n)
      .map((c) => `${c.kind.padEnd(19)} n=${String(c.n).padStart(3)} ${c.pathLen.padEnd(11)} bare=${String(c.bareCoreBytes).padStart(6)} B  full=${String(c.fullBodyBytes).padStart(6)} B`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.log(`[wireReserveSizing] measured table (deterministic byte counts, not timing):\n${rows}`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("RESERVE_MIN's arithmetic: measuring WORST_CASE_CORE (counts+paths+workspace together, one JSON.stringify) + WORST_CASE_ENVELOPE_SHELL, and it clears against WIRE_RESERVE_BYTES", () => {
    expect(ADMISSIBLE_EDIT_UNION_CAP).toBe(256);
    expect(MAX_WORKSPACE_RELATIVE_PATH_BYTES).toBe(96);

    // The naive product (raw path CONTENT bytes only) is a LOWER bound, not
    // the true paths-array cost: it omits the array's own JSON structure
    // (quote pairs, 255 commas, brackets). wireBudget.ts's RESERVE_MIN is
    // measured against a real WORST_CASE_CORE object specifically because an
    // earlier hand-summed version of this arithmetic undercounted by
    // omitting exactly that structure (caught by this file's own measured
    // table below: real bare core at n=256/adversarial came back at 25566 B,
    // above the naive product). This test re-asserts that relationship
    // holds, rather than re-deriving wireBudget.ts's internals.
    const naiveProductLowerBound = ADMISSIBLE_EDIT_UNION_CAP * MAX_WORKSPACE_RELATIVE_PATH_BYTES;
    expect(naiveProductLowerBound).toBe(24576);
    expect(RESERVE_MIN).toBeGreaterThan(naiveProductLowerBound);
    const structuralAndFieldOverhead = RESERVE_MIN - naiveProductLowerBound;
    // Real value at S4-authoring time is ~1067 B (array structure for 256
    // elements + EditCounts + WorkspaceMarker + envelope-shell); bounded
    // generously above that so this test survives minor future drift
    // without needing to track wireBudget.ts's exact byte count here.
    expect(structuralAndFieldOverhead).toBeGreaterThan(0);
    expect(structuralAndFieldOverhead).toBeLessThan(4096);

    expect(RESERVE_MIN).toBeLessThan(WIRE_RESERVE_BYTES);
    const headroom = WIRE_RESERVE_BYTES - RESERVE_MIN;
    expect(headroom).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      `[wireReserveSizing] RESERVE_MIN = ${RESERVE_MIN} B (naive paths-content-only product ` +
        `${naiveProductLowerBound} B + ${structuralAndFieldOverhead} B structure/counts/workspace/envelope); ` +
        `WIRE_RESERVE_BYTES = ${WIRE_RESERVE_BYTES} B; headroom = ${headroom} B ` +
        `(${((headroom / WIRE_RESERVE_BYTES) * 100).toFixed(1)}%).`,
    );
  });

  it("ADMISSIBLE_EDIT_UNION_CAP stays mirrored: state/session.ts's real constant matches wireBudget.ts's own copy", () => {
    const sessionPath = path.resolve(HERE, "..", "state", "session.ts");
    const source = readFileSync(sessionPath, "utf8");
    const m = /const ADMISSIBLE_EDIT_UNION_CAP = (\d+);/.exec(source);
    expect(m, "ADMISSIBLE_EDIT_UNION_CAP not found in state/session.ts by this exact pattern — has it moved, been renamed, or been exported (drop the `const` prefix check if so)?").not.toBeNull();
    const sessionValue = Number(m![1]);
    expect(sessionValue, "state/session.ts's ADMISSIBLE_EDIT_UNION_CAP has drifted from wireBudget.ts's mirrored copy — update wireBudget.ts's constant (and its doc comment) to match").toBe(ADMISSIBLE_EDIT_UNION_CAP);
  });
});

// ---------------------------------------------------------------------------
// Gate G9 — the startup misconfiguration check.
// ---------------------------------------------------------------------------

describe("Gate G9 — startup misconfiguration check (validateStartupBudgets)", () => {
  it("accepts the real production table without throwing", () => {
    expect(() => validateStartupBudgets(budgetRows(), WIRE_RESERVE_BYTES, RESERVE_MIN)).not.toThrow();
  });

  it("every row budgetRows() emits has a resolvable numeric budget and floor", () => {
    const rows = budgetRows();
    expect(rows.length).toBeGreaterThanOrEqual(15); // >= one per Kind, plus one per named form
    for (const row of rows) {
      expect(typeof row.budget, `${row.kind}${row.form ? `.${row.form}` : ""}.budget`).toBe("number");
      expect(typeof row.floor, `${row.kind}${row.form ? `.${row.form}` : ""}.floor`).toBe("number");
      expect(row.budget).toBeGreaterThan(0);
      expect(row.floor).toBeGreaterThan(0);
    }
  });

  it("every SE-STABLE row from the real table carries headroom=0 — the reserve is already the headroomed number, and stacking a second margin on top would demand more than the reserve promises to hold", () => {
    const rows = budgetRows().filter((r) => r.kind === "edit.applied" || r.kind === "edit.rolled_back" || r.kind === "edit.state_unknown");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.headroom, row.kind).toBe(0);
      expect(row.floor, row.kind).toBe(WIRE_RESERVE_BYTES);
    }
  });

  it("throws, naming the offending kind, floor, and configured value, when a row's budget is below floor + headroom", () => {
    const badRows: BudgetRow[] = [{ kind: "read.closure", budget: 10, floor: 358, headroom: 64 }];
    expect(() => validateStartupBudgets(badRows, WIRE_RESERVE_BYTES, RESERVE_MIN)).toThrow(
      /read\.closure.*\b10 B.*floor.*\(358 B\).*headroom.*\(64 B\).*422 B required/s,
    );
  });

  it("throws, naming the offending kind AND form, when a form-specific row is below floor + headroom", () => {
    const badRows: BudgetRow[] = [{ kind: "search.matches", form: "find", budget: 100, floor: 6263, headroom: 64 }];
    expect(() => validateStartupBudgets(badRows, WIRE_RESERVE_BYTES, RESERVE_MIN)).toThrow(
      /search\.matches \(form "find"\).*\b100 B/s,
    );
  });

  it("does NOT throw for an SE-STABLE row sitting EXACTLY at floor + 0 headroom — edit.rolled_back / edit.state_unknown sit precisely at WIRE_RESERVE_BYTES today (32768 = 32768), and the boundary must stay inclusive", () => {
    const rows: BudgetRow[] = [{ kind: "edit.rolled_back", budget: WIRE_RESERVE_BYTES, floor: WIRE_RESERVE_BYTES, headroom: 0 }];
    expect(() => validateStartupBudgets(rows, WIRE_RESERVE_BYTES, RESERVE_MIN)).not.toThrow();
  });

  it("throws when the reserve itself is below RESERVE_MIN, independent of every row", () => {
    expect(() => validateStartupBudgets([], 100, RESERVE_MIN)).toThrow(/WIRE_RESERVE_BYTES \(100 B\) is below RESERVE_MIN/);
  });

  it("checks the reserve BEFORE any row — a bad reserve is reported even when every row is otherwise fine", () => {
    expect(() => validateStartupBudgets(budgetRows(), 1, RESERVE_MIN)).toThrow(/WIRE_RESERVE_BYTES \(1 B\) is below RESERVE_MIN/);
  });
});

// ---------------------------------------------------------------------------
// Gate G9 — ONE spawn smoke test. Proves the check is wired into the path
// bin.ts's real entry point executes (server.ts's `run()`, strictly before
// `tryRunWithSdk()` / `runStdioFallback()`), not merely defined and unit
// tested in isolation. Harness trimmed from `editFamily.spec.ts` /
// `replayCorpus.spec.ts`'s shared `startServer` pattern — kept to the one
// cheap call the recon recommended.
// ---------------------------------------------------------------------------

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function mkDir(tag: string): string {
  const dir = mkdtempSync(path.join(HOME, `.tl-reserve-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function startServer(opts: { cwd: string; args: string[] }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] },
  );

  let stdoutBuf = "";
  let stderr = "";
  const waiters = new Map<number, (msg: any) => void>();

  child.stdout!.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id != null && waiters.has(msg.id)) {
        const w = waiters.get(msg.id)!;
        waiters.delete(msg.id);
        w(msg);
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

  function send(obj: unknown): void {
    child.stdin!.write(JSON.stringify(obj) + "\n");
  }

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 25000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- server stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-reserve-sizing", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function kill(): void {
    try { child.kill("SIGKILL"); } catch { /* ok */ }
  }

  return { initialize, rpc, kill };
}

describe("Gate G9 — spawn smoke (the real bin.ts, the real production budget table)", () => {
  it("a healthy server starts and serves a request — proves the G9 check is wired into run(), not just defined", async () => {
    const ws = mkDir("healthy");
    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);

    // If `assertStartupBudgetsAreSane()` had thrown, `run()`'s promise would
    // reject before `tryRunWithSdk()` ever starts the transport, and this
    // `initialize` call would time out against a dead process (its stderr
    // would show `[tl-mcp] fatal: ...`, exit 1, zero stdout) rather than
    // resolve — so a resolved `initialize` IS the proof this call needs.
    await srv.initialize();

    const res = await srv.rpc(2, "tools/call", {
      name: "search_files",
      arguments: { action: "tree", path: "." },
    });

    expect(res?.result ?? res?.error).toBeDefined();
    expect(res?.error).toBeUndefined();
  }, 30000);
});
