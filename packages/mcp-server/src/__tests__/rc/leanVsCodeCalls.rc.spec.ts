/**
 * leanVsCodeCalls.rc.spec.ts — WP-V1 (2026-09-20).
 *
 * Spawned-server proof that WP-V1's leaning claims hold against a REAL
 * server (AGENTS.md: "VERIFY the claim before relying on it ... show it
 * returns the same response kind/evidence as the un-leaned one"), and that
 * the lean schema diet (leanSchema.spec.ts, pure/in-process) never narrows
 * what `dispatchTool` actually accepts — a caller that still sends a
 * leaned-away property is served exactly as today.
 *
 * Harness copied from rc/readFileScopePathDirectory.rc.spec.ts.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "..", "bin.ts");
const SPAWN_TIMEOUT_MS = 90_000;

// A realistic, varied-content Java class -- large enough (padded below) that
// a single-method query does not fit one served page, so the pack's own
// `decision.next` is a real, server-authored continuation rather than a
// closed "act.answer".
const METHODS: Array<[string, string, string]> = [
  ["computeShippingCost", "double weightKg, String destinationZone", "return weightKg * ZONE_RATES.getOrDefault(destinationZone, DEFAULT_RATE);"],
  ["applyDiscountCode", "double subtotal, String code", "Discount discount = discountLedger.lookup(code); return discount == null ? subtotal : discount.apply(subtotal);"],
  ["reserveInventory", "String sku, int quantity", "InventoryRecord record = inventory.get(sku); if (record == null) throw new NoSuchSkuException(sku); record.reserve(quantity);"],
  ["cancelReservation", "String reservationId", "reservations.remove(reservationId); metrics.increment(\"reservation.cancelled\");"],
  ["schedulePickup", "String orderId, Instant when", "pickupSchedule.put(orderId, when); notifier.notifyWarehouse(orderId, when);"],
  ["refundOrder", "String orderId, double amount", "ledger.credit(orderId, amount); auditLog.record(orderId, \"refund\", amount);"],
  ["validateAddress", "Address address", "return addressValidator.isDeliverable(address) && !restrictedZones.contains(address.zone());"],
  ["mergeCarts", "Cart primary, Cart secondary", "for (LineItem item : secondary.items()) primary.addOrIncrement(item); return primary;"],
  ["applyLoyaltyPoints", "String customerId, int points", "loyaltyLedger.credit(customerId, points); notifier.notifyCustomer(customerId, \"points-earned\");"],
  ["closeOutOrder", "String orderId", "orders.get(orderId).markComplete(); metrics.increment(\"order.completed\");"],
  ["escalateDispute", "String orderId, String reason", "disputeQueue.add(new Dispute(orderId, reason)); notifier.notifySupport(orderId, reason);"],
  ["auditShipment", "String trackingId", "ShipmentRecord record = shipments.get(trackingId); return record == null ? ShipmentStatus.UNKNOWN : record.status();"],
];

function orderOperationsSource(): string {
  const expanded: Array<[string, string, string]> = [];
  for (let round = 0; round < 8; round++) {
    for (const [name, params, logic] of METHODS) {
      expanded.push([round === 0 ? name : `${name}Variant${round}`, params, logic]);
    }
  }
  const body = expanded.map(([name, params, logic]) => `  public void ${name}(${params}) {\n    ${logic}\n  }\n`).join("\n");
  return `package com.example.probe;\n\nimport java.time.Instant;\n\npublic class OrderOperationsService {\n\n${body}\n}\n`;
}

function scopeWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-lean-vscode-")));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"lean-vscode-rc"}\n');
  fs.writeFileSync(path.join(ws, "src/OrderOperationsService.java"), orderOperationsSource());
  fs.writeFileSync(path.join(ws, "src/main.ts"), "export const main = 1;\n");
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

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

const VSCODE_LEAN_ENV = { TOKENLIGHTEN_CLIENT_ID: "vscode", TL_LEAN_CALLS: "1", TL_LEGACY_INPUT: "refuse" };

/**
 * Opens a fresh answer-profile task on its OWN server/workspace and returns
 * that server plus its minted task id. TWO INDEPENDENT servers (one per
 * comparison side below), never one server asked the SAME comparison call
 * twice, on purpose: this repo's own search/read dedupe doors legitimately
 * change a SECOND identical call's shape ("already served this session"),
 * which would confound a leaned-vs-un-leaned comparison with an unrelated
 * repetition effect. Independent servers isolate the ONE variable this file
 * exists to test.
 */
async function openAnswerTask(ws: string, env: Record<string, string>): Promise<{ server: ServerHandle; taskId: string }> {
  const server = startServer(ws, env);
  await server.initialize("Visual Studio Code");
  const opened = bodyOf(await server.rpc(2, "tools/call", {
    name: "read_file",
    arguments: {
      query: "how does reserveInventory reserve stock",
      targets: [{ path: "src/OrderOperationsService.java" }],
      task: { epoch: "new", profile: "answer" },
      cwd: ws,
    },
  }));
  expect(opened["kind"], JSON.stringify(opened).slice(0, 400)).toBe("read.task_pack");
  const taskId = (opened["task"] as Record<string, unknown>)["id"] as string;
  expect(typeof taskId).toBe("string");
  return { server, taskId };
}

/** Evidence rows compared content-only: `handle` is an opaque per-server id, never equal across two independent servers even for byte-identical content. */
function evidenceContentOf(body: Record<string, unknown>): unknown {
  const rows = body["evidence"];
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const { handle: _handle, ...rest } = row as Record<string, unknown>;
    return rest;
  });
}

describe("WP-V1 — leaned read_file/search_files continuations replay identically to the un-leaned shape", () => {
  it("a plain targets zoom read (no cwd, no task) returns the same kind+evidence content as the explicit cwd+task.handle shape", async () => {
    const wsA = scopeWorkspace();
    const wsB = scopeWorkspace();
    tmpDirs.push(wsA, wsB);
    const { server: serverA, taskId } = await openAnswerTask(wsA, VSCODE_LEAN_ENV);
    const { server: serverB } = await openAnswerTask(wsB, VSCODE_LEAN_ENV);

    // The un-leaned shape a caller would send today: explicit cwd + task.handle.
    const unleaned = bodyOf(await serverA.rpc(3, "tools/call", {
      name: "read_file",
      arguments: {
        targets: [{ path: "src/OrderOperationsService.java", range: "1-9" }],
        cwd: wsA,
        task: { handle: taskId },
      },
    }));

    // The leaned shape WP-V1 authorizes for this same continuation: no cwd
    // (single-root workspace; the server was launched bound to its own ws),
    // no task at all (a plain targets read needs no task continuity).
    const leaned = bodyOf(await serverB.rpc(3, "tools/call", {
      name: "read_file",
      arguments: {
        targets: [{ path: "src/OrderOperationsService.java", range: "1-9" }],
      },
    }));

    expect(leaned["kind"]).toBe(unleaned["kind"]);
    expect(evidenceContentOf(leaned)).toEqual(evidenceContentOf(unleaned));
    expect(serverA.alive()).toBe(true);
    expect(serverB.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("a plain search_files find (no cwd, no task) returns the same kind+matches as the explicit cwd+task.handle shape", async () => {
    const wsA = scopeWorkspace();
    const wsB = scopeWorkspace();
    tmpDirs.push(wsA, wsB);
    const { server: serverA, taskId } = await openAnswerTask(wsA, VSCODE_LEAN_ENV);
    const { server: serverB } = await openAnswerTask(wsB, VSCODE_LEAN_ENV);

    const unleaned = bodyOf(await serverA.rpc(3, "tools/call", {
      name: "search_files",
      arguments: { action: "find", queries: ["cancelReservation"], cwd: wsA, task: { handle: taskId } },
    }));
    const leaned = bodyOf(await serverB.rpc(3, "tools/call", {
      name: "search_files",
      arguments: { action: "find", queries: ["cancelReservation"] },
    }));

    expect(leaned["kind"]).toBe(unleaned["kind"]);
    expect((leaned["matches"] as Record<string, unknown>)?.["files"]).toEqual((unleaned["matches"] as Record<string, unknown>)?.["files"]);
    expect(serverA.alive()).toBe(true);
    expect(serverB.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("a real server-authored decision.next omits cwd under vscode+TL_LEAN_CALLS, and keeps it for vscode without the flag and for a non-vscode client", async () => {
    async function nextArguments(env: Record<string, string>, clientName: string): Promise<Record<string, unknown> | undefined> {
      const ws = scopeWorkspace();
      tmpDirs.push(ws);
      const server = startServer(ws, env);
      await server.initialize(clientName);
      const body = bodyOf(await server.rpc(2, "tools/call", {
        name: "read_file",
        arguments: {
          // Naming TWO identifiers (one served, one not) is what reliably
          // leaves this pack mid-investigation with a real `decision.next`
          // (a `search_files` symbol lookup for the unserved one) instead of
          // closing outright — verified empirically; a single-identifier
          // query against this same fixture closes as `act.answer`.
          query: "how does reserveInventory reserve stock and what happens on cancelReservation",
          targets: [{ path: "src/OrderOperationsService.java" }],
          task: { epoch: "new", profile: "answer" },
          cwd: ws,
        },
      }));
      expect(server.alive()).toBe(true);
      const decision = body["decision"] as Record<string, unknown> | undefined;
      const next = decision?.["next"] as Record<string, unknown> | undefined;
      return next?.["arguments"] as Record<string, unknown> | undefined;
    }

    const leanedNextArgs = await nextArguments(VSCODE_LEAN_ENV, "Visual Studio Code");
    // This corpus/query is expected (per rc/leanVsCodeCalls' own fixture) to
    // still be mid-investigation (a `discover` decision with a real `next`)
    // -- if the pack closed instead, there is nothing to assert here, so
    // fail loudly rather than silently pass on an empty continuation.
    expect(leanedNextArgs, "expected a real decision.next; the fixture/query no longer leaves the pack open").toBeDefined();
    expect(leanedNextArgs!["cwd"]).toBeUndefined();

    const vscodeNoFlagNextArgs = await nextArguments(
      { TOKENLIGHTEN_CLIENT_ID: "vscode", TL_LEGACY_INPUT: "refuse" },
      "Visual Studio Code",
    );
    expect(vscodeNoFlagNextArgs?.["cwd"]).toBeDefined();

    const nonVscodeNextArgs = await nextArguments(
      { TL_LEAN_CALLS: "1", TL_LEGACY_INPUT: "refuse" },
      "claude-code",
    );
    expect(nonVscodeNextArgs?.["cwd"]).toBeDefined();
  }, SPAWN_TIMEOUT_MS);
});

describe("WP-V1 — the lean schema diet never narrows what dispatchTool accepts", () => {
  it("a read_file call using targets[].purpose is served under the vscode+lean schema, not refused", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws, VSCODE_LEAN_ENV);
    await server.initialize("Visual Studio Code");

    const body = bodyOf(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        query: "how does reserveInventory reserve stock",
        targets: [{ path: "src/OrderOperationsService.java", purpose: "confirm the reservation guard clause" }],
        task: { epoch: "new", profile: "answer" },
        cwd: ws,
      },
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 400)).not.toBe("refusal");
    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);

  it("a read_file call using budget.bytes (dropped from the advertised vscode+lean read_file schema) is still honoured, not refused", async () => {
    const ws = scopeWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws, VSCODE_LEAN_ENV);
    await server.initialize("Visual Studio Code");

    const body = bodyOf(await server.rpc(2, "tools/call", {
      name: "read_file",
      arguments: {
        // A specific range (not the whole ~24 KB file) so this is purely a
        // "does dispatch still read budget.bytes at all" check, not a
        // separate cap-exceeded-for-unrelated-reasons scenario.
        targets: [{ path: "src/OrderOperationsService.java", range: "1-9" }],
        budget: { bytes: 20000 },
        task: { epoch: "new" },
        cwd: ws,
      },
    }));
    expect(body["kind"], JSON.stringify(body).slice(0, 400)).not.toBe("refusal");
    expect(server.alive()).toBe(true);
  }, SPAWN_TIMEOUT_MS);
});
