/**
 * owedRowsFit.spec.ts — codex-copilot-proxy r18 T03 (2026-10-23): the choice a
 * structure map makes between owing the members its first page does not hold as
 * their ROWS or as their WHOLE bodies, end to end (spawned dev server; the
 * synthetic `OrderDesk` of helpers/owedRowsDesk.ts, whose owed steps are 22
 * lines of arithmetic that call nothing, then the lines a row serves, two more
 * lines of arithmetic between them).
 *
 * The rule (readCodeTaskPack.ts `owedRowsFitOnePage`): rows only when they, after
 * coalescing, are ONE continuation page under the client's cap, with the pack's
 * size preview's headroom to spare; otherwise the members are owed whole, exactly
 * as every map owed them before rows (the planner with no options). A rows
 * continuation that does not fit is the worse outcome — the preview cuts it, and
 * the chain is longer than the whole bodies' — so the sweep below asserts that
 * wherever the rows branch is taken, its continuation IS one act.answer.
 *
 * T03 is the real case on both sides of the rule (t03OwedRows.spec.ts); the rules
 * the rows follow are memberRows.spec.ts and structureMap.spec.ts.
 *
 * 2026-10-23 (independent review of T03 A/B, F5): the estimate reads the address of
 * each owed row off the row as the continuation serializes it (not a constant that
 * contradicted its own measurement) and counts the `why` of a Java loop guard's
 * review note on the row that holds the guard; the function-level cases pin both,
 * and the guarded desk (`writeOwedRowsDesk(…, guards)`) sweeps the boundary with
 * those notes on the page.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ConfigName, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { OWED_ROWS_DESK_FILE, OWED_ROWS_DESK_FILLER_RE, OWED_ROWS_DESK_QUERY, writeOwedRowsDesk, type OwedRowsDesk } from "./helpers/owedRowsDesk.js";
import { owedRowsFitOnePage, type StructureMapRowNote } from "../features/task-pack/readCodeTaskPack.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const CEILING = 18_432;
const COPILOT_ENV = { TOKENLIGHTEN_CLIENT_ID: "copilot-cli", TOKENLIGHTEN_CLIENT: "copilot-cli", TOKENLIGHTEN_TOOL_SURFACE: "full", TL_LEGACY_INPUT: "refuse" };
const TASK = { epoch: "new", profile: "answer" };

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try { await rmDirWithRetry(dir); } catch { /* best-effort cleanup */ }
  }
});

interface Reply { readonly body: any; readonly bytes: number }
interface Run { readonly replies: Reply[]; readonly desk: OwedRowsDesk; readonly served: Map<number, string> }

/** The desk of `steps` steps, asked for its map, followed from the first call to the act.answer. */
async function run(steps: number, config: ConfigName, extraEnv: Record<string, string>, limit = 12, guards = 0): Promise<Run> {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(HOME, ".tl-owedrows-")));
  tmpDirs.push(ws);
  const desk = writeOwedRowsDesk(ws, steps, guards);
  const server = startDevServer(ws, config, { toolSurface: "full", allowWrite: true, extraEnv });
  servers.push(server);
  await server.initialize();
  const replies: Reply[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } = { tool: "tl_read_file", arguments: { cwd: ws, query: OWED_ROWS_DESK_QUERY, task: TASK } };
  for (let step = 0; step < limit; step++) {
    const { body, textBytes } = await server.callTool(call.tool, call.arguments.cwd === undefined ? { cwd: ws, ...call.arguments } : call.arguments);
    replies.push({ body, bytes: textBytes });
    const decision = body?.decision ?? {};
    if (decision.kind !== "discover") break;
    call = Array.isArray(decision.next) ? decision.next[0] : decision.next;
  }
  const served = new Map<number, string>();
  for (const { body } of replies) {
    for (const row of (body?.evidence ?? []) as any[]) {
      if (typeof row?.body !== "string" || row.path !== OWED_ROWS_DESK_FILE) continue;
      const window = /^(\d+)-(\d+)$/u.exec(String(row.range ?? ""));
      row.body.split("\n").forEach((text: string, index: number) => {
        const gutter = /^(\d+)\|(.*)$/u.exec(text);
        if (gutter) served.set(Number(gutter[1]), gutter[2]!);
        else if (window && Number(window[1]) + index <= Number(window[2])) served.set(Number(window[1]) + index, text);
      });
    }
  }
  return { replies, desk, served };
}

const holds = (result: Run, line: number): boolean => result.served.get(line) === result.desk.lines[line - 1];
/** A step served as its rows: every row line, and no line of arithmetic. */
const rowsOnly = (result: Run, step: number): boolean =>
  result.desk.steps[step]!.rows.every(line => holds(result, line)) && result.desk.steps[step]!.filler.every(line => !result.served.has(line));
/** A step served whole: every row line and every line of arithmetic. */
const whole = (result: Run, step: number): boolean =>
  result.desk.steps[step]!.rows.every(line => holds(result, line)) && result.desk.steps[step]!.filler.every(line => holds(result, line));
/** The step the first page cuts: an exact prefix of its body, then the rest as rows. At most one step is cut. */
const cut = (result: Run, step: number): boolean =>
  result.desk.steps[step]!.rows.every(line => holds(result, line)) && !rowsOnly(result, step) && !whole(result, step);
/** Every step is served as rows, as a whole body, or (one) cut by the page. */
const everyStepServed = (result: Run): boolean => {
  const steps = [...result.desk.steps.keys()];
  return steps.every(step => rowsOnly(result, step) || whole(result, step) || cut(result, step)) && steps.filter(step => cut(result, step)).length <= 1;
};

describe("owedRowsFitOnePage — the rule as a function", () => {
  // Sixty-character lines: 61 bytes with the newline, so a window of n lines is about 61n bytes of source.
  const lines = Array.from({ length: 4000 }, (_, i) => `        total += compute${i}(order) + ${"x".repeat(26)};`);
  const window = (start: number, count: number): { start: number; end: number } => ({ start, end: start + count - 1 });
  const some = (count: number, each: number): Array<{ start: number; end: number }> => Array.from({ length: count }, (_, i) => window(1 + i * (each + 50), each));

  it("nothing owed is one page, whatever the cap", () => {
    expect(owedRowsFitOnePage("src/Big.java", lines, [], 4096)).toBe(true);
  });

  it("a handful of small windows fit the Copilot CLI cap", () => {
    expect(owedRowsFitOnePage("src/Big.java", lines, some(12, 6), CEILING)).toBe(true);
  });

  it("more windows than one cursor can carry (64) are not one page, however small", () => {
    expect(owedRowsFitOnePage("src/Big.java", lines, some(64, 1), CEILING)).toBe(true);
    expect(owedRowsFitOnePage("src/Big.java", lines, some(65, 1), CEILING)).toBe(false);
    expect(owedRowsFitOnePage("src/Big.java", lines, some(65, 1), 1_000_000)).toBe(false);
  });

  it("source the cap cannot hold is not one page: the same windows fit a larger cap", () => {
    const heavy = [window(1, 300)];
    expect(owedRowsFitOnePage("src/Big.java", lines, heavy, CEILING)).toBe(false);
    expect(owedRowsFitOnePage("src/Big.java", lines, heavy, 32_768)).toBe(true);
  });

  it("is monotone in what is owed, and keeps its headroom under the cap: the longest window that fits is well short of the cap", () => {
    let longest = 0;
    for (let count = 1; count <= 400; count += 1) {
      const fits = owedRowsFitOnePage("src/Big.java", lines, [window(1, count)], CEILING);
      if (fits) longest = count;
      else expect(owedRowsFitOnePage("src/Big.java", lines, [window(1, count + 20)], CEILING), "once a window does not fit, a longer one does not").toBe(false);
    }
    expect(longest).toBeGreaterThan(100);
    // 61 B a line, the numbered body about 5 B a line more, plus the envelope and the headroom: not the whole 18,432 B.
    expect(longest * 61).toBeLessThan(CEILING - 2_000);
  });

  /** The smallest cap `owedRowsFitOnePage` answers true for: the estimate plus its headroom, to the byte. */
  const minCap = (source: readonly string[], owed: Array<{ start: number; end: number }>, notes: readonly StructureMapRowNote[] = []): number => {
    let low = 0, high = 4_000_000;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (owedRowsFitOnePage("src/Big.java", source, owed, middle, notes)) high = middle; else low = middle;
    }
    return high;
  };
  const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
  /** The body of a row as the answer-line gutter numbers it (no client context here: `N|line`). */
  const numbered = (source: readonly string[], span: { start: number; end: number }): string =>
    source.slice(span.start - 1, span.end).map((line, index) => `${span.start + index}|${line}`).join("\n");

  it("counts the address of an owed row from the row as a continuation serializes it: never fewer bytes than the row takes, whatever its range and role", () => {
    const source = Array.from({ length: 120_000 }, (_, i) => `x${i}`);
    const first = [window(1, 1)];
    for (const second of [window(2, 1), window(1234, 3), window(99_990, 12), window(100_000, 20_000)]) {
      // The second row costs its body, its path and its address: what is left once body and path are taken off is the address.
      const estimated = minCap(source, [...first, second]) - minCap(source, first) - jsonBytes(numbered(source, second)) - jsonBytes("src/Big.java");
      const actualFor = (role: string, extra: Record<string, unknown> = {}): number => {
        const row = { handle: "hjijfjycpmo", path: "src/Big.java", range: `${second.start}-${second.end}`, body: numbered(source, second), role, ...extra };
        return jsonBytes(row) - jsonBytes(row.body) - jsonBytes(row.path) + 1; // + the comma that separates it from the next row
      };
      for (const role of ["api", "unknown", "contract", "wiring", "domain", "test"]) {
        expect(estimated, `${second.start}-${second.end} as ${role}`).toBeGreaterThanOrEqual(actualFor(role));
      }
      // …and it is that number, not a fat constant: within a few bytes of the longest role in use.
      expect(estimated - actualFor("contract"), `${second.start}-${second.end}`).toBeLessThanOrEqual(8);
    }
  });

  it("a wider range costs more address: five-digit lines against single-digit ones, by the digits", () => {
    const source = Array.from({ length: 120_000 }, (_, i) => `x${i}`);
    const addressOf = (span: { start: number; end: number }): number =>
      minCap(source, [window(1, 1), span]) - minCap(source, [window(1, 1)]) - jsonBytes(numbered(source, span)) - jsonBytes("src/Big.java");
    // `3-3` against `99999-99999`: four more digits in each end of the range.
    expect(addressOf({ start: 99_999, end: 99_999 }) - addressOf({ start: 3, end: 3 })).toBe(8);
  });

  it("counts a review note once on the owed row that holds all of its lines, and never on one that does not", () => {
    const source = Array.from({ length: 400 }, (_, i) => `        total += compute${i}(order);`);
    const owed = [window(10, 30), window(100, 30)];
    const text = "L15 Thread.sleep(backoffMs) requires L13 (attempt < MAX_TRIES); loop L12: attempt <= MAX_TRIES. At loop bound: guard false, no sleep. Logged delay is not a wait.";
    const without = minCap(source, owed);
    const cost = jsonBytes(text) + ",\"why\":".length;
    expect(minCap(source, owed, [{ start: 12, end: 20, text }]) - without, "a note inside the first row").toBe(cost);
    expect(minCap(source, owed, [{ start: 12, end: 20, text }, { start: 105, end: 120, text }]) - without, "a note in each row").toBe(2 * cost);
    expect(minCap(source, owed, [{ start: 25, end: 40, text }]), "a note over the end of a row: no row holds it").toBe(without);
    expect(minCap(source, owed, [{ start: 60, end: 70, text }]), "a note in no owed row").toBe(without);
    // The cost is real: the cap that holds the rows exactly does not hold them with their notes, and does by the notes' bytes more.
    const both = [{ start: 12, end: 20, text }, { start: 105, end: 120, text }];
    expect(owedRowsFitOnePage("src/Big.java", source, owed, without)).toBe(true);
    expect(owedRowsFitOnePage("src/Big.java", source, owed, without, both)).toBe(false);
    expect(owedRowsFitOnePage("src/Big.java", source, owed, without + 2 * cost - 1, both)).toBe(false);
    expect(owedRowsFitOnePage("src/Big.java", source, owed, without + 2 * cost, both)).toBe(true);
  });

  it("each window costs its address too: many small windows fit fewer lines than one large", () => {
    const one = owedRowsFitOnePage("src/Big.java", lines, [window(1, 180)], CEILING);
    const split = owedRowsFitOnePage("src/Big.java", lines, some(60, 3), CEILING);
    expect(one).toBe(true);
    expect(split, "60 windows of 3 lines, 180 lines in all, cost their addresses").toBe(false);
  });
});

describe("a map owes its members as rows when the rows fit one continuation page", () => {
  it("under the Copilot CLI ceiling: one cursor, one act.answer, the effects and handlers served, the arithmetic not", async () => {
    const result = await run(16, "default", COPILOT_ENV);
    expect(result.replies.map(reply => reply.body.decision.kind), JSON.stringify(result.replies.map(reply => reply.bytes))).toEqual(["discover", "act.answer"]);
    for (const reply of result.replies) expect(reply.bytes).toBeLessThanOrEqual(CEILING);
    const next = result.replies[0]!.body.decision.next;
    expect(Array.isArray(next), "no sibling cursors").toBe(false);
    expect(Object.keys(next.arguments), "the cursor alias alone").toEqual(["cursor"]);
    const steps = result.desk.steps.map((_, index) => index);
    const rowSteps = steps.filter(step => rowsOnly(result, step)), wholeSteps = steps.filter(step => whole(result, step));
    // The first page holds the first steps whole (and an exact prefix of the next); every later one is owed as its rows.
    expect(rowSteps.length, "owed steps").toBeGreaterThanOrEqual(5);
    expect(wholeSteps.length, "steps on the page").toBeGreaterThanOrEqual(3);
    expect(everyStepServed(result)).toBe(true);
    // What a row holds, line for line: the signature, the loaded ticket, the try with both calls, the handler whole
    // (its log line, its release and its rethrow), the three state writes... the save, the audit and the dispatch.
    const owed = result.desk.steps[rowSteps.at(-1)!]!;
    const text = owed.rows.map(line => result.desk.lines[line - 1]!.trim());
    for (const expected of ["try {", "billingClient.charge(order.account(), base);", "} catch (BillingException ex) {", "stockLedger.release(order.sku(), order.quantity());", "throw ex;",
      "ticket.setState(DeskState.BILLED);", "ticket.setBilledAt(clock.now());", "ticketRepository.save(ticket);", "deliveryService.dispatch(ticket);"]) {
      expect(text, expected).toContain(expected);
    }
    expect(text.some(line => line.startsWith("log.warn(")), "the handler's log line").toBe(true);
    expect(text.some(line => line.startsWith("auditTrail(")), "the audit").toBe(true);
  }, 240_000);

  it("a client with no byte ceiling is served rows for a desk the Copilot ceiling owes whole", async () => {
    const result = await run(26, "default", {});
    expect(result.replies.at(-1)!.body.decision.kind).toBe("act.answer");
    expect(result.replies.length).toBeLessThanOrEqual(3);
    const rowSteps = result.desk.steps.map((_, index) => index).filter(step => rowsOnly(result, step));
    expect(rowSteps.length, "owed steps").toBeGreaterThanOrEqual(10);
    expect(everyStepServed(result)).toBe(true);
  }, 240_000);
});

describe("a map owes its members whole when the rows do not fit one continuation page", () => {
  it("under the Copilot CLI ceiling: every step is served whole, arithmetic included, and every reply is under the ceiling", async () => {
    const result = await run(30, "default", COPILOT_ENV, 16);
    expect(result.replies.at(-1)!.body.decision.kind, JSON.stringify(result.replies.map(reply => [reply.body.decision.kind, reply.bytes]))).toBe("act.answer");
    for (const reply of result.replies) expect(reply.bytes).toBeLessThanOrEqual(CEILING);
    expect(result.replies.length, "more than the one continuation rows would have been").toBeGreaterThan(2);
    for (const step of result.desk.steps.keys()) expect(whole(result, step), "step " + step).toBe(true);
    for (const line of result.desk.steps.flatMap(step => step.filler)) expect(OWED_ROWS_DESK_FILLER_RE.test(result.served.get(line) ?? ""), "line " + line).toBe(true);
  }, 360_000);
});

describe("the rule never takes rows whose continuation would not be one page", () => {
  it("sweeps the desk around the boundary: rows exactly as long as the rows branch is one act.answer under the ceiling", async () => {
    const branches: string[] = [];
    for (const steps of [18, 21, 22, 24]) {
      const result = await run(steps, "default", COPILOT_ENV, 16);
      const everyStep = result.desk.steps.map((_, index) => index);
      const rows = everyStep.some(step => rowsOnly(result, step));
      expect(everyStepServed(result), `${steps} steps: each step is rows, whole or the one the page cut`).toBe(true);
      expect(result.replies.at(-1)!.body.decision.kind, `${steps} steps`).toBe("act.answer");
      for (const reply of result.replies) expect(reply.bytes, `${steps} steps`).toBeLessThanOrEqual(CEILING);
      if (rows) {
        expect(result.replies.length, `${steps} steps: the rows branch is two calls`).toBe(2);
        expect(Array.isArray(result.replies[0]!.body.decision.next), `${steps} steps`).toBe(false);
      } else {
        expect(everyStep.every(step => whole(result, step)), `${steps} steps: whole bodies`).toBe(true);
      }
      branches.push(rows ? "rows" : "whole");
    }
    // Rows below the boundary, whole above it, and the boundary crossed once.
    expect(branches[0], branches.join(",")).toBe("rows");
    expect(branches.at(-1), branches.join(",")).toBe("whole");
    expect(branches.join(",")).toMatch(/^(?:rows,)+(?:whole,?)+$/u);
  }, 600_000);
});

describe("the rule counts the review notes the continuation page carries", () => {
  it("sweeps a desk whose last four steps hold a loop guard: the notes ride the page, and the rows branch is still one act.answer under the ceiling", async () => {
    const branches: string[] = [];
    let noted = 0;
    for (const steps of [17, 19, 20, 22]) {
      const result = await run(steps, "default", COPILOT_ENV, 16, 4);
      // The analyzer reads nothing of a file over 96 KiB: the sweep stays under it.
      expect(Buffer.byteLength(result.desk.lines.join("\n"), "utf8"), `${steps} steps`).toBeLessThan(96 * 1024);
      const everyStep = result.desk.steps.map((_, index) => index);
      const rows = everyStep.some(step => rowsOnly(result, step));
      expect(result.replies.at(-1)!.body.decision.kind, `${steps} steps`).toBe("act.answer");
      for (const reply of result.replies) expect(reply.bytes, `${steps} steps`).toBeLessThanOrEqual(CEILING);
      const whys = result.replies.flatMap(reply => (reply.body.evidence ?? []) as any[])
        .filter(row => typeof row.why === "string" && /^L\d+ Thread\.sleep\(backoffMs\) requires L\d+/u.test(row.why));
      if (rows) {
        expect(result.replies.length, `${steps} steps: the rows branch is two calls`).toBe(2);
        expect(everyStepServed(result), `${steps} steps`).toBe(true);
        noted += whys.length;
      } else {
        expect(everyStep.every(step => whole(result, step)), `${steps} steps: whole bodies`).toBe(true);
      }
      branches.push(rows ? "rows" : "whole");
    }
    expect(branches[0], branches.join(",")).toBe("rows");
    expect(branches.at(-1), branches.join(",")).toBe("whole");
    expect(branches.join(",")).toMatch(/^(?:rows,)+(?:whole,?)+$/u);
    expect(noted, "loop-guard notes delivered on the rows branch").toBeGreaterThan(0);
  }, 900_000);
});
