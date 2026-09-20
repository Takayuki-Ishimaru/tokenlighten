/**
 * answerLineGutterLaneSticky.rc.spec.ts — WP-V1 (2026-09-20).
 *
 * Regression coverage for the lane-sticky extension to TL_ANSWER_LINE_GUTTER
 * (protocol/lineGutter.ts's `applyAnswerLineGutter`): once a leaned
 * continuation (util/flags.ts's `leanCallsEnabled`) stops attributing
 * `task` at all, a follow-up zoom read has no `task.profile` to declare —
 * this records, per lane, the profile of the most recent task pack, and
 * treats a task-less read-family response in that lane as answer-profile
 * while the lane's latest pack was answer, turning back off the moment a
 * later pack in the same lane is generic.
 *
 * REPLAY-FORENSICS FOLLOW-UP (same day): a query-less multi-target ranged
 * read (`read_file {targets:[{path,range},...]}`, no query/qref/task) is
 * PROMOTED by the dispatcher to `read.task_pack` with an INFERRED "generic"
 * profile (`profile_binding.source:"inferred"`) — verified live against this
 * file's own fixture below. The lane rule must ALSO cover that shape, while
 * NEVER numbering a pack whose `decision.kind` is `"act.edit"` (an
 * edit-directed body must stay copy-exact for `edit_file`'s search/replace
 * matching — the same reasoning the flag's own "generic profile => never
 * numbered" rule already applies). Harness copied from
 * rc/readFileScopePathDirectory.rc.spec.ts.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyAnswerLineGutter } from "../../protocol/lineGutter.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");
const SPAWN_TIMEOUT_MS = 90_000;

const JAVA_SRC =
  "package com.example.probe;\n\npublic class OrderOperations {\n"
  + "  public void reserveInventory(String sku, int quantity) {\n"
  + "    InventoryRecord record = inventory.get(sku);\n"
  + "    if (record == null) throw new NoSuchSkuException(sku);\n"
  + "    record.reserve(quantity);\n"
  + "  }\n\n"
  + "  public void cancelReservation(String reservationId) {\n"
  + "    reservations.remove(reservationId);\n"
  + "    metrics.increment(\"reservation.cancelled\");\n"
  + "  }\n\n"
  + "  public void refundOrder(String orderId, double amount) {\n"
  + "    ledger.credit(orderId, amount);\n"
  + "    auditLog.record(orderId, \"refund\", amount);\n"
  + "  }\n"
  + "}\n";

// A SEPARATE file for the task-less zoom-read checks below: `OrderOperations
// .java` is small enough that the opening query-based call serves it whole
// (TL_SMALL_FILE_ONE_CALL), so any later read of it hits the "already
// served this session" dedupe (a body-less read.receipt) regardless of
// leaning -- an unrelated mechanism this file must not confound with the
// lane-sticky rule under test. `Shipping.java` is never touched by the
// opening call, so a follow-up read of it is a genuine fresh serve.
const OTHER_JAVA_SRC =
  "package com.example.probe;\n\npublic class Shipping {\n"
  + "  public double baseRate() { return 4.99; }\n"
  + "  public double expeditedRate() { return 14.99; }\n"
  + "  public double internationalRate() { return 24.99; }\n"
  + "}\n";

function scopeWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-gutter-lane-")));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"gutter-lane-rc"}\n');
  fs.writeFileSync(path.join(ws, "src/OrderOperations.java"), JAVA_SRC);
  fs.writeFileSync(path.join(ws, "src/Shipping.java"), OTHER_JAVA_SRC);
  return ws;
}

interface ServerHandle {
  initialize(clientName: string): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
  alive(): boolean;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];

function startServer(ws: string, env: Record<string, string>): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, ws], {
    cwd: ws,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
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

  function rpc(id: number, method: string, params?: unknown, timeoutMs = 60000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async function initialize(clientName: string): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  const handle: ServerHandle = {
    initialize,
    rpc,
    kill: () => { try { child.kill("SIGKILL"); } catch { /* ok */ } },
    alive: () => child.exitCode === null && child.signalCode === null,
  };
  spawnedServers.push(handle);
  return handle;
}

function bodyOf(rpcResult: any): Record<string, unknown> {
  const text = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text, `expected text content, got: ${JSON.stringify(rpcResult)}`).toBe("string");
  return JSON.parse(text);
}

function firstRow(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const evidence = body["evidence"];
  return Array.isArray(evidence) ? (evidence[0] as Record<string, unknown>) : undefined;
}

/** The EXACT 1-based [start,end] line slice of a real fixture file, for a direct-seam payload body that must byte-match `applyAnswerLineGutter`'s own re-rendering (never hand-typed -- a single stray space would silently fail the match and leave the body un-numbered for the wrong reason). */
function exactBody(ws: string, relPath: string, start: number, end: number): string {
  const text = fs.readFileSync(path.join(ws, relPath), "utf8");
  return text.split("\n").slice(start - 1, end).join("\n");
}

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

const GUTTER_ENV = { TL_ANSWER_LINE_GUTTER: "1", TL_LEGACY_INPUT: "refuse" };
const LANE = "lane-a";

describe("WP-V1 — lane-sticky answer profile covers a task-less read.text", () => {
  it("numbers a task-less single-target ranged read in the same lane as a prior answer-profile pack", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws, GUTTER_ENV);
    await server.initialize("vitest-gutter-lane");

    const opened = bodyOf(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how does reserveInventory reserve stock",
        targets: [{ path: "src/OrderOperations.java" }],
        task: { epoch: "new", profile: "answer" },
        lane: LANE,
        cwd: ws,
      },
    }));
    expect(opened["kind"]).toBe("read.task_pack");
    expect(opened["profile"]).toBe("answer");

    // Task-less: no query, no qref, no task at all -- exactly what a leaned
    // vscode continuation (or a model's own plain follow-up) would send.
    // A DIFFERENT file (never touched by the opening query) so this is a
    // fresh serve, not an already-served-this-session receipt.
    const followUp = bodyOf(await server.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { targets: [{ path: "src/Shipping.java", range: "1-3" }], lane: LANE, cwd: ws },
    }));
    expect(followUp["kind"]).toBe("read.text");
    const row = firstRow(followUp);
    expect(row, JSON.stringify(followUp)).toBeDefined();
    expect(String(row!["body"])).toMatch(/^1\|/m);
    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("a later generic pack in the same lane turns the sticky answer state back off", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws, GUTTER_ENV);
    await server.initialize("vitest-gutter-lane");

    await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how does reserveInventory reserve stock",
        targets: [{ path: "src/OrderOperations.java" }],
        task: { epoch: "new", profile: "answer" },
        lane: LANE,
        cwd: ws,
      },
    });
    // A later, DECLARED-generic pack in the SAME lane.
    const genericPack = bodyOf(await server.rpc(3, "tools/call", {
      name: "read_file",
      arguments: {
        query: "where is refundOrder implemented",
        targets: [{ path: "src/OrderOperations.java" }],
        task: { epoch: "new", profile: "generic" },
        lane: LANE,
        cwd: ws,
      },
    }));
    expect(genericPack["profile"]).toBe("generic");

    const followUp = bodyOf(await server.rpc(4, "tools/call", {
      name: "read_file",
      arguments: { targets: [{ path: "src/Shipping.java", range: "1-3" }], lane: LANE, cwd: ws },
    }));
    expect(followUp["kind"]).toBe("read.text");
    const row = firstRow(followUp);
    expect(String(row!["body"])).not.toMatch(/^\d+\|/m);
    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("a DIFFERENT lane is unaffected by lane A's sticky answer state", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws, GUTTER_ENV);
    await server.initialize("vitest-gutter-lane");

    await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how does reserveInventory reserve stock",
        targets: [{ path: "src/OrderOperations.java" }],
        task: { epoch: "new", profile: "answer" },
        lane: LANE,
        cwd: ws,
      },
    });
    const otherLaneFollowUp = bodyOf(await server.rpc(3, "tools/call", {
      name: "read_file",
      arguments: { targets: [{ path: "src/Shipping.java", range: "1-3" }], lane: "lane-b", cwd: ws },
    }));
    expect(otherLaneFollowUp["kind"]).toBe("read.text");
    const row = firstRow(otherLaneFollowUp);
    expect(String(row!["body"])).not.toMatch(/^\d+\|/m);
    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);
});

describe("WP-V1 — lane-sticky answer profile covers the promoted (query-less, multi-target) generic pack", () => {
  it("confirms the promotion shape: a query-less multi-target ranged read resolves read.task_pack with an INFERRED generic profile", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws, GUTTER_ENV);
    await server.initialize("vitest-gutter-lane");

    const body = bodyOf(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        targets: [
          { path: "src/OrderOperations.java", range: "1-6" },
          { path: "src/OrderOperations.java", range: "9-12" },
        ],
        lane: LANE,
        cwd: ws,
      },
    }));
    expect(body["kind"]).toBe("read.task_pack");
    expect(body["profile"]).toBe("generic");
    expect((body["profile_binding"] as Record<string, unknown> | undefined)?.["source"]).toBe("inferred");
    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("never numbers the promoted pack when its decision is act.edit, even with a sticky lane answer state (edit safety)", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws, GUTTER_ENV);
    await server.initialize("vitest-gutter-lane");

    await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how does reserveInventory reserve stock",
        targets: [{ path: "src/OrderOperations.java" }],
        task: { epoch: "new", profile: "answer" },
        lane: LANE,
        cwd: ws,
      },
    });
    const promoted = bodyOf(await server.rpc(3, "tools/call", {
      name: "read_file",
      arguments: {
        targets: [
          { path: "src/OrderOperations.java", range: "1-6" },
          { path: "src/OrderOperations.java", range: "9-12" },
        ],
        lane: LANE,
        cwd: ws,
      },
    }));
    expect(promoted["kind"]).toBe("read.task_pack");
    expect(promoted["profile"]).toBe("generic");
    const decision = promoted["decision"] as Record<string, unknown> | undefined;
    // This exact shape (query-less multi-target ranged read) is verified
    // live to resolve `decision.kind:"act.edit"` -- the edit-safety branch
    // this test exists to pin. If a future change makes it resolve some
    // OTHER decision kind instead, this assertion should be revisited
    // alongside the direct-seam test below, which pins the boundary
    // unconditionally.
    expect(decision?.["kind"]).toBe("act.edit");
    const row = firstRow(promoted);
    expect(row, JSON.stringify(promoted)).toBeDefined();
    expect(String(row!["body"])).not.toMatch(/^\d+\|/m);
    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("direct seam check: a hand-built promoted-generic pack IS numbered when the lane is sticky-answer and decision is NOT act.edit", () => {
    process.env["TL_ANSWER_LINE_GUTTER"] = "1";
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const workspace = ws;
    const lane = "direct-seam-lane";

    // Prime the lane's sticky state via a real read.task_pack pass.
    applyAnswerLineGutter(
      { profile: "answer", evidence: [] },
      "read.task_pack",
      { workspace, args: { lane } },
    );

    const payload = {
      profile: "generic",
      decision: { kind: "discover" }, // NOT act.edit
      evidence: [{ handle: "h1", path: "src/OrderOperations.java", range: "1-3", body: exactBody(ws, "src/OrderOperations.java", 1, 3) }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { workspace, args: { lane } });
    const row = (result["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(String(row["body"])).toMatch(/^1\|/);
  });

  it("direct seam check: the SAME hand-built pack is NOT numbered when decision is act.edit, even sticky-answer", () => {
    process.env["TL_ANSWER_LINE_GUTTER"] = "1";
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const workspace = ws;
    const lane = "direct-seam-lane-edit";

    applyAnswerLineGutter(
      { profile: "answer", evidence: [] },
      "read.task_pack",
      { workspace, args: { lane } },
    );

    const payload = {
      profile: "generic",
      decision: { kind: "act.edit" },
      evidence: [{ handle: "h1", path: "src/OrderOperations.java", range: "1-3", body: exactBody(ws, "src/OrderOperations.java", 1, 3) }],
    };
    const result = applyAnswerLineGutter(payload, "read.task_pack", { workspace, args: { lane } });
    const row = (result["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(String(row["body"])).not.toMatch(/^\d+\|/);
  });

  it("direct seam check: a fresh query binds its own profile and is never overridden by a sticky lane answer state", () => {
    process.env["TL_ANSWER_LINE_GUTTER"] = "1";
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const workspace = ws;
    const lane = "direct-seam-lane-query";

    applyAnswerLineGutter(
      { profile: "answer", evidence: [] },
      "read.task_pack",
      { workspace, args: { lane } },
    );

    const payload = {
      profile: "generic",
      decision: { kind: "discover" },
      evidence: [{ handle: "h1", path: "src/OrderOperations.java", range: "1-3", body: exactBody(ws, "src/OrderOperations.java", 1, 3) }],
    };
    // This call carries a fresh `query` -- must bind its own (generic)
    // profile, never inherit the lane's prior answer state.
    const result = applyAnswerLineGutter(payload, "read.task_pack", { workspace, args: { lane, query: "where is refundOrder" } });
    const row = (result["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(String(row["body"])).not.toMatch(/^\d+\|/);
  });
});
