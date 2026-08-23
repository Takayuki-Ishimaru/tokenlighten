/**
 * fenceServesUnservedScope.rc.spec.ts — 2026-08-22 fence-serves-unserved-scope
 * (W8-A), real-server reproduction of bench 2026-08-22's measured defect.
 *
 * MEASURED DEFECT (bench 2026-08-22, same scope as the v0.10 decision run):
 * after a prepared pack (`act.edit`/`act.answer` with a certificate), EVERY
 * subsequent read-only call — `search_files find` with a NEW query/scope,
 * `tree`, `references`, `read_file mode=map`, `slice` of a served handle —
 * was answered with `read.receipt {receipt:"decision-unchanged", ...,
 * next:{tool:"read_file", arguments:{mode:"task_pack", taskEpoch:"new",
 * paths:[...]}}}`. The guide says `next` is executable verbatim, so the
 * solver issued a 5-23 KB generic re-pack with `taskEpoch:"new"`, which
 * minted a NEW certificate and re-armed the fence; the next exploration call
 * got a receipt again -> loop. Measured: arm A spent 290 KB in 27 such
 * re-packs (T09 rep1 alone: 8 receipts -> 8 re-packs).
 *
 * THIS DRILL reproduces T09 rep1's call SHAPE end to end against the real,
 * built server (not the in-process `guardExecutionDiscovery` unit — see
 * preparedReceiptHonesty.spec.ts / executionTypestate.spec.ts for that
 * layer): task_pack (act.edit) -> search_files find (new query) -> tree ->
 * read_file mode=map -> slice of a served handle's served range -> slice of
 * an unserved range -> exact pack re-issue. Required semantics (see
 * AGENTS.md / the task brief this wave shipped against):
 *
 *   1. search_files (any action) and read_file in any mode OTHER than
 *      task_pack now reach the ordinary, fence-independent serve/dedup path
 *      even under a prepared certificate — they are SERVED, never
 *      stonewalled, regardless of whether the scope was ever served before.
 *   2. A slice re-ask fully inside an already-served range still receipts
 *      (code-unchanged) — the prepared fence removing its OWN stonewall must
 *      not regress the pre-existing, fence-independent served-range dedup.
 *   3. When a receipt IS emitted (the exact pack re-issue), its `next` is
 *      never a `taskEpoch:"new"` re-pack — that re-arms the fence and is a
 *      different-task cue, not a receipt continuation.
 *
 * Harness copied from v011ReceiptFence.rc.spec.ts (repo convention: no
 * cross-spec helper import; each rc drill owns its stdio JSON-RPC harness).
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

/** Reaches `act.edit` with the fixture's evidence fully served (F-C1 shape). */
const EDIT_QUERY = "fix computeDiscount so an expired coupon is rejected";

const PRICING_SRC =
  "export function computeDiscount(total: number, coupon: { pct: number; expired: boolean }): number {\n"
  + "  return total * (1 - coupon.pct / 100);\n"
  + "}\n";

const LOGGER_SRC =
  "export function formatOrderLog(orderId: string, total: number): string {\n"
  + "  return `order ${orderId}: total=${total}`;\n"
  + "}\n"
  + "\n"
  + "export function formatShippingLog(orderId: string): string {\n"
  + "  return `order ${orderId}: shipped`;\n"
  + "}\n";

function fenceWorkspace(): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-rc-fenceunserved-")));
  fs.mkdirSync(path.join(ws, "src", "util"), { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), '{"name":"rc-fence-unserved"}\n');
  fs.writeFileSync(path.join(ws, "src/pricing.ts"), PRICING_SRC);
  fs.writeFileSync(
    path.join(ws, "src/checkout.ts"),
    "import { computeDiscount } from \"./pricing.js\";\n"
    + "export function checkout(total: number, coupon: { pct: number; expired: boolean }): number {\n"
    + "  return computeDiscount(total, coupon);\n"
    + "}\n",
  );
  // Never referenced by the task_pack above — genuinely unserved scope for
  // the search/tree/map/slice steps below.
  fs.writeFileSync(path.join(ws, "src/util/logger.ts"), LOGGER_SRC);
  return ws;
}

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
  alive(): boolean;
}

const tmpDirs: string[] = [];
const spawnedServers: ServerHandle[] = [];

function startServer(ws: string): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS, ws], {
    cwd: ws,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
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

  async function initialize(): Promise<void> {
    await rpc(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-rc-fenceunserved", version: "0" },
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

/** True iff `next`/`next_call` (however addressed) prescribes a task_pack taskEpoch:"new" re-pack. */
function isTaskEpochNewRepack(next: unknown): boolean {
  if (next === null || typeof next !== "object") return false;
  const call = next as { tool?: unknown; arguments?: unknown };
  if (call.tool !== "read_file" || call.arguments === null || typeof call.arguments !== "object") return false;
  const args = call.arguments as Record<string, unknown>;
  return args["mode"] === "task_pack" && args["taskEpoch"] === "new";
}

afterAll(() => {
  for (const s of spawnedServers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("2026-08-22 fence-serves-unserved-scope — T09 rep1 call-shape reproduction", () => {
  it("task_pack(act.edit) -> find -> tree -> map -> slice(served) -> slice(unserved) -> exact re-issue: no loop", async () => {
    const ws = fenceWorkspace();
    tmpDirs.push(ws);
    const server = startServer(ws);
    await server.initialize();

    // 1. task_pack reaches a prepared act.edit certificate over pricing.ts
    // (checkout.ts as supporting evidence) — search/util/logger.ts is
    // deliberately never referenced.
    const seedCall = { mode: "task_pack", query: EDIT_QUERY, cwd: ws };
    const seed = bodyOf(await server.rpc(2, "tools/call", { name: "read_file", arguments: seedCall }));
    expect(seed["kind"], JSON.stringify(seed).slice(0, 500)).toBe("read.task_pack");
    expect((seed["decision"] as Record<string, unknown> | undefined)?.["kind"], JSON.stringify(seed).slice(0, 500))
      .toBe("act.edit");
    const evidence = seed["evidence"] as Array<Record<string, unknown>>;
    const pricingEvidence = evidence.find((e) => String(e["path"]).endsWith("pricing.ts"));
    expect(pricingEvidence, "pricing.ts must be part of the served working set").toBeDefined();
    const servedRange = String(pricingEvidence!["range"]);
    expect(servedRange, "fixture must serve a real range to slice back").toMatch(/^\d+-\d+$/);

    // 2. search_files find with a query the pack never saw. REQUIRED
    // SEMANTICS #1: this must be SERVED (search.matches), never stonewalled
    // into a decision-unchanged receipt.
    const found = bodyOf(await server.rpc(3, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "formatOrderLog", cwd: ws },
    }));
    expect(found["kind"], `search_files find must serve under a prepared fence; got ${JSON.stringify(found).slice(0, 500)}`)
      .toBe("search.matches");
    expect(found["receipt"]).toBeUndefined();

    // 3. tree — inventory of a directory the pack never walked.
    const tree = bodyOf(await server.rpc(4, "tools/call", {
      name: "search_files",
      arguments: { action: "tree", path: "src/util", cwd: ws },
    }));
    expect(tree["kind"], `tree must serve under a prepared fence; got ${JSON.stringify(tree).slice(0, 500)}`)
      .toBe("search.tree");
    expect(tree["receipt"]).toBeUndefined();

    // 4. read_file mode=map on the never-referenced file.
    const map = bodyOf(await server.rpc(5, "tools/call", {
      name: "read_file",
      arguments: { mode: "map", path: "src/util/logger.ts", cwd: ws },
    }));
    expect(map["kind"], `mode=map must serve under a prepared fence; got ${JSON.stringify(map).slice(0, 500)}`)
      .toBe("read.map");
    expect(map["receipt"]).toBeUndefined();

    // 5. slice of pricing.ts's OWN served range — content the caller already
    // has. This must NOT re-serve fresh bytes: removing the fence's
    // stonewall must not regress the pre-existing, fence-independent
    // served-range dedup (servedReceipts.spec.ts / receiptHonesty.spec.ts).
    // Two shapes are both honest "already held" signals and neither is
    // touched by this wave: a `read.receipt` tagged `code-unchanged`
    // (servedContentReceipt's ledger dedup), or a `read.text` whose evidence
    // entries are all `prior`-addressed with no `body` (the fence's own
    // evidence gets this compact treatment directly — PI-03
    // `client_acknowledged_prior`).
    const servedSlice = bodyOf(await server.rpc(6, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/pricing.ts", range: servedRange, cwd: ws },
    }));
    const servedIsReceipt = servedSlice["kind"] === "read.receipt"
      && (servedSlice["receipt"] as Record<string, unknown> | undefined)?.["receipt"] === "code-unchanged";
    const servedEvidence = servedSlice["evidence"] as Array<Record<string, unknown>> | undefined;
    const servedIsPriorText = servedSlice["kind"] === "read.text"
      && Array.isArray(servedEvidence) && servedEvidence.length > 0
      && servedEvidence.every((entry) => entry["body"] === undefined && entry["prior"] !== undefined);
    expect(
      servedIsReceipt || servedIsPriorText,
      `an already-served range must not re-serve fresh bytes; got ${JSON.stringify(servedSlice).slice(0, 500)}`,
    ).toBe(true);

    // 6. slice of a file/range the session never served — must SERVE.
    const unservedSlice = bodyOf(await server.rpc(7, "tools/call", {
      name: "read_file",
      arguments: { mode: "slice", path: "src/util/logger.ts", range: "1-3", cwd: ws },
    }));
    expect(unservedSlice["kind"], `unserved scope must serve; got ${JSON.stringify(unservedSlice).slice(0, 500)}`)
      .toBe("read.text");
    expect(unservedSlice["receipt"]).toBeUndefined();

    // 7. exact pack re-issue — the ONE call shape that stays gated. It may
    // receipt (pack-unchanged, or decision-unchanged if something about the
    // intervening calls disqualified the compact bypass), but per REQUIRED
    // SEMANTICS #3 its `next` (if any) must never be a task_pack
    // taskEpoch:"new" re-pack — that would re-arm the fence into exactly the
    // loop this drill exists to prove closed.
    const reissue = bodyOf(await server.rpc(8, "tools/call", { name: "read_file", arguments: seedCall }));
    expect(reissue["kind"], JSON.stringify(reissue).slice(0, 500)).toBe("read.receipt");
    const reissueReceipt = reissue["receipt"] as Record<string, unknown>;
    expect(["pack-unchanged", "decision-unchanged"]).toContain(reissueReceipt["receipt"]);
    expect(
      isTaskEpochNewRepack(reissueReceipt["next"]),
      `the exact-reissue receipt's next must never re-arm the fence: ${JSON.stringify(reissueReceipt).slice(0, 500)}`,
    ).toBe(false);

    expect(server.alive(), "none of the above may crash the server").toBe(true);
  }, SPAWN_TIMEOUT_MS);
});
