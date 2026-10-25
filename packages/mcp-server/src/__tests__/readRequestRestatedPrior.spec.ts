/**
 * readRequestRestatedPrior.spec.ts — v0.16.0 release verification (T08 / T09).
 *
 * THE DEFECT. The slice door projects a partly overlapping read as a
 * ledger DIFFERENCE by default: the lines the caller does not hold ride as
 * fresh bodies, the lines it holds are restated as `prior` rows (no body). A
 * read request opened with C = ∅ — a `force_serve` origin, which WP-S10's
 * small-window reserve (`TL_TURN_ECONOMY`, the VS Code / Copilot configs)
 * stamps on any small explicit window, while the slice door itself still answers
 * it with a difference — kept every restated window in D = Q − (C ∪ S): the
 * fresh row carried `remaining:["95-100"]` for lines the same response restated
 * as `prior`, and `limit.next` minted a cursor whose only page was a bare
 * `code-unchanged` receipt (rangedDeliveryCompleteness R02/R03, vscode arms:
 * "zero new lines served and no explicit stop").
 *
 * THE RULE. A window the response restates as held is delivered by reference:
 * it leaves D exactly like a body would take it out. Nothing else changes —
 * a held window the response does NOT restate is still owed by a C = ∅ origin,
 * and a window the ladder cut stays owed whatever surrounds it.
 *
 * Part 1 drives the settle tail (`applyReadRequestContinuation`,
 * `fitStagedReadToBudget`) on hand-built payloads; part 2 drives the real
 * dispatcher with the reserve switched on.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { fitStagedReadToBudget, applyReadRequestContinuation } from "../protocol/readRequestContinuation.js";
import { openReadRequest, type StagedReadRequest } from "../state/readRequestStore.js";
import { beginServeCall, recordServedRange, settleServedCallBookings } from "../state/session.js";
import { resetStateStoresForTests } from "../state/stateStore.js";
import { resetAll } from "../util/session.js";
import { handleTable } from "../util/handles.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const SHA = `sha256:${"b".repeat(64)}`;
const REL = "src/held.txt";
const TOTAL = 200;
const tmpDirs: string[] = [];

afterAll(async () => {
  resetStateStoresForTests();
  for (const dir of tmpDirs.splice(0)) {
    try { await rmDirWithRetry(dir); } catch { /* best-effort cleanup */ }
  }
});

function freshWs(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-rrp-${tag}-`));
  tmpDirs.push(ws);
  resetStateStoresForTests();
  return ws;
}

function hold(ws: string, start: number, end: number): void {
  recordServedRange(ws, REL, SHA, start, end, TOTAL, { mode: "slice", range: `${start}-${end}`, call: beginServeCall(ws) });
  settleServedCallBookings({ unattributed: false, windows: [{ path: REL, start, end }] }, ws);
}

/** The request of the failing cells: Q = `[start, end]`, opened as a force_serve origin with the caller's earlier coverage held. */
function openForced(ws: string, start: number, end: number): StagedReadRequest {
  const staged = openReadRequest({
    workspaceRoot: ws,
    originalInput: { targets: [{ path: REL, range: `${start}-${end}` }], content: "auto" },
    budget: { bytes: 6500 },
    forceServeOrigin: true,
    echo: { cwd: ws },
    targets: [{
      path: REL,
      sha: SHA,
      totalLines: TOTAL,
      representation: { content: "auto", comments: "elide" },
      requested: [{ start, end }],
    }],
  });
  if (staged === undefined) throw new Error("openReadRequest returned undefined");
  return staged;
}

/** This call's fresh serve of `[start, end]`, booked the way the slice door books it. */
function serveFresh(ws: string, start: number, end: number): void {
  recordServedRange(ws, REL, SHA, start, end, TOTAL, { mode: "slice", range: `${start}-${end}`, call: beginServeCall(ws) });
  settleServedCallBookings({ unattributed: false, windows: [{ path: REL, start, end }] }, ws);
}

function bodyOf(start: number, end: number): string {
  return Array.from({ length: end - start + 1 }, (_, i) => `line ${start + i}`).join("\n") + "\n";
}

function differencePayload(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  return { v: 1, kind: "read.text", evidence: rows, sha: SHA.slice(0, 19), total_lines: TOTAL };
}

const FRESH_88_94 = { handle: "h1", path: REL, range: "88-94", body: bodyOf(88, 94) };
const PRIOR_95_100 = { handle: "h1", path: REL, range: "95-100", prior: "task_pack 95-140 (call #1)" };
const claim = { budgetDeclared: true, shed: false } as const;
const measure = (payload: Record<string, unknown>): number => Buffer.byteLength(JSON.stringify(payload), "utf8");

describe("a window the response restates as `prior` leaves D (settle tail)", () => {
  it("fresh 88-94 + prior 95-100 for Q = 88-100: nothing is owed, so no cursor and no `remaining`", () => {
    const ws = freshWs("complete");
    hold(ws, 31, 87);
    hold(ws, 95, 140);
    const staged = openForced(ws, 88, 100);
    serveFresh(ws, 88, 94);
    const payload = differencePayload([FRESH_88_94, PRIOR_95_100]);

    // The dry run the funnel sizes the response with agrees with the real settle.
    const fit = fitStagedReadToBudget({ payload, staged, claim, limit: 6500, measure });
    expect(fit.ok).toBe(true);
    if (fit.ok) {
      expect(fit.payload["limit"], JSON.stringify(fit.payload)).toBeUndefined();
      expect((fit.payload["evidence"] as Array<Record<string, unknown>>).some((row) => row["remaining"] !== undefined)).toBe(false);
    }

    const out = applyReadRequestContinuation(payload, staged, claim);
    expect(out["limit"], JSON.stringify(out)).toBeUndefined();
    for (const row of out["evidence"] as Array<Record<string, unknown>>) expect(row["remaining"], JSON.stringify(row)).toBeUndefined();
    // The restatement itself is kept: the caller is still told where it holds those lines.
    expect((out["evidence"] as Array<Record<string, unknown>>)[1]).toEqual(PRIOR_95_100);
    expect(staged.state.targets[0]!.remaining).toEqual([]);
  });

  it("a window the ladder cut stays owed next to a restated one: D names only the cut lines, never the prior ones", () => {
    const ws = freshWs("partial");
    hold(ws, 95, 140);
    const staged = openForced(ws, 80, 100);
    serveFresh(ws, 88, 94); // 80-87 never reached the wire
    const payload = differencePayload([FRESH_88_94, PRIOR_95_100]);

    const out = applyReadRequestContinuation(payload, staged, claim);
    const evidence = out["evidence"] as Array<Record<string, unknown>>;
    expect(evidence[0]!["remaining"], JSON.stringify(out)).toEqual(["80-87"]);
    expect(evidence[1]!["remaining"]).toBeUndefined();
    const next = (out["limit"] as { next?: { tool?: string; arguments?: Record<string, unknown> } } | undefined)?.next;
    expect(next?.tool, JSON.stringify(out)).toBe("tl_read_file");
    expect(typeof next?.arguments?.["cursor"]).toBe("string");
    expect(staged.state.targets[0]!.remaining).toEqual([{ start: 80, end: 87 }]);
  });

  it("control: a held window the response does NOT restate is still owed by a C = ∅ origin", () => {
    const ws = freshWs("control");
    hold(ws, 95, 140);
    const staged = openForced(ws, 88, 100);
    serveFresh(ws, 88, 94);
    const payload = differencePayload([FRESH_88_94]);

    const out = applyReadRequestContinuation(payload, staged, claim);
    expect((out["evidence"] as Array<Record<string, unknown>>)[0]!["remaining"], JSON.stringify(out)).toEqual(["95-100"]);
    expect((out["limit"] as { next?: unknown } | undefined)?.next, JSON.stringify(out)).toBeDefined();
  });

  it("a `prior` row restating another file's lines credits nothing here", () => {
    const ws = freshWs("other-path");
    hold(ws, 95, 140);
    const staged = openForced(ws, 88, 100);
    serveFresh(ws, 88, 94);
    const payload = differencePayload([FRESH_88_94, { ...PRIOR_95_100, path: "src/other.txt" }]);

    const out = applyReadRequestContinuation(payload, staged, claim);
    expect((out["evidence"] as Array<Record<string, unknown>>)[0]!["remaining"], JSON.stringify(out)).toEqual(["95-100"]);
  });
});

describe("the reserve-forced slice door ends a partly overlapping chain without a wasted cursor hop (dispatcher)", () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["TL_TURN_ECONOMY", "TL_RESERVE_SMALL_WINDOWS", "TOKENLIGHTEN_CLIENT_ID"];

  beforeEach(() => {
    resetAll();
    handleTable.reset();
    resetStateStoresForTests();
    for (const key of KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
    process.env["TL_TURN_ECONOMY"] = "1"; // the VS Code / Copilot posture: WP-S10 stamps force_serve on a small explicit window
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  /** 120-byte self-identifying lines, so the held window outweighs the difference projection's per-row overhead. */
  function fixture(): string {
    const root = fs.realpathSync(shortTmpDir(HOME, ".tl-rrp-e2e-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "src"));
    const lines = Array.from({ length: 150 }, (_, i) => `L${String(i + 1).padStart(6, "0")} ${"x".repeat(112)}`);
    fs.writeFileSync(path.join(root, "src/held.txt"), lines.join("\n") + "\n");
    return root;
  }

  async function call(root: string, args: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await callTool("tl_read_file", { cwd: root, lane: "rrp-e2e", ...args });
    const first = response.content[0];
    if (first?.type !== "text") throw new Error("Expected textual MCP result.");
    return JSON.parse(first.text);
  }

  it("holds 95-106, then reads 84-100 at budget 6500: fresh 84-94 + prior 95-100, no `remaining`, no `limit`", async () => {
    const root = fixture();
    const held = await call(root, { targets: [{ path: "src/held.txt", range: "95-106" }], task: { epoch: "new" } });
    expect(held["kind"], JSON.stringify(held).slice(0, 300)).toBe("read.text");

    const reply = await call(root, { targets: [{ path: "src/held.txt", range: "84-100" }], content: "auto", budget: { bytes: 6500 } });
    const text = JSON.stringify(reply);
    expect(reply["kind"], text.slice(0, 400)).toBe("read.text");
    const rows = reply["evidence"] as Array<Record<string, any>>;
    expect(rows.map((row) => [row["range"], row["body"] !== undefined ? "body" : row["prior"] !== undefined ? "prior" : "-"]), text.slice(0, 600))
      .toEqual([["84-94", "body"], ["95-100", "prior"]]);
    expect(rows.some((row) => row["remaining"] !== undefined), text.slice(0, 600)).toBe(false);
    expect(reply["limit"], text.slice(0, 600)).toBeUndefined();
  }, 30000);
});
