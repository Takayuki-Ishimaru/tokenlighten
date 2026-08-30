/**
 * sequenceCorpus.spec.ts — SEQUENCE-INVARIANT CORPUS.
 *
 * This is the multi-call companion to replayCorpus.spec.ts.  Inputs are
 * verbatim MCP call shapes; only the disposable workspace path is injected.
 * Expectations describe POST-FIX behaviour.  Known current failures remain
 * `it.fails` until the corresponding proof-completion change lands, rather
 * than weakening the invariant.
 *
 * Re-pin policy: a behaviour-changing protocol fix must name the affected
 * case, explain the observable defect, and update this file and the Track A
 * report together.  Never turn a failure green by changing an input query.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bindTaskContractHandle,
  clearTaskContract,
  consumeExecutableNextScope,
  executableNextScope,
  recordTaskContract,
  registerExecutableNextScope,
  resetTaskContractStoreForTest,
} from "../features/task-pack/taskContractStore.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

interface Server {
  initialize(): Promise<void>;
  call(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
}

const servers: Server[] = [];
const workspaces: string[] = [];

function startServer(cwd: string): Server {
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, BIN_TS], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TOKENLIGHTEN_ALLOWED_PARENTS: os.tmpdir() },
  });
  let buffer = "";
  let stderr = "";
  const waiters = new Map<number, (value: Record<string, unknown>) => void>();

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) {
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            waiter(message as Record<string, unknown>);
          }
        }
      } catch { /* protocol parser ignores non-JSON diagnostics */ }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const rpc = (id: number, method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`sequence corpus ${method} timed out\n${stderr}`));
      }, 45_000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  return {
    async initialize(): Promise<void> {
      await rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest-sequence-corpus", version: "0" },
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const response = await rpc(id, "tools/call", { name, arguments: args });
      if (response.error !== undefined) throw new Error(JSON.stringify(response.error));
      const result = response.result as { content?: Array<{ text?: string }> } | undefined;
      const text = result?.content?.[0]?.text ?? "";
      return JSON.parse(text) as Record<string, unknown>;
    },
    kill(): void {
      try { child.kill("SIGKILL"); } catch { /* already closed */ }
    },
  };
}

function workspace(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-sequence-"));
  workspaces.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), "{\"name\":\"sequence-fixture\",\"private\":true}\n");
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}

function bodyValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function decisionOf(response: Record<string, unknown>): Record<string, unknown> {
  return bodyValue(response.decision);
}

function nextOf(response: Record<string, unknown>): { tool: string; arguments: Record<string, unknown> } | undefined {
  const next = decisionOf(response).next;
  const candidate = bodyValue(next);
  return typeof candidate.tool === "string" && candidate.arguments !== undefined
    ? { tool: candidate.tool, arguments: bodyValue(candidate.arguments) }
    : undefined;
}

function fingerprint(next: { tool: string; arguments: Record<string, unknown> }): string {
  return JSON.stringify([next.tool, next.arguments]);
}

/**
 * R1 (2026-08-28): the server's OWN identity rule for "the same call shape",
 * mirrored from `util/packServeLog.ts`'s `nextFingerprint` — `cwd`, `lane` and
 * `task_handle` are caller-managed standing state, so two calls that differ
 * only in them are the same call. Comparing raw JSON here would let a repeat
 * hide behind a re-stated `cwd`.
 */
function callIdentity(call: { tool: string; arguments: Record<string, unknown> }): string {
  const rest = Object.entries(call.arguments)
    .filter(([key]) => key !== "cwd" && key !== "lane" && key !== "task_handle")
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([call.tool, Object.fromEntries(rest)]);
}

/**
 * EVERY carrier a `next` can ride, not just the one a given fix looked at.
 *
 * `decision.next` is the projected one, but the same call also reaches clients
 * through the contract, the continuation plan, a receipt and a `limit` — and
 * the P0-2 defect class is precisely a call resurfacing on a carrier the
 * no-repeat gate did not cover. An assertion that names only `decision.next`
 * cannot see that.
 */
function nextCarriers(response: Record<string, unknown>): { carrier: string; call: { tool: string; arguments: Record<string, unknown> } }[] {
  const stages = (bodyValue(response.continuation).stages ?? []) as unknown[];
  const raw: [string, unknown][] = [
    ["decision.next", decisionOf(response).next],
    ["next_call", response.next_call],
    ["next", response.next],
    ["execution_contract.next_call", bodyValue(response.execution_contract).next_call],
    ["receipt.next", bodyValue(response.receipt).next],
    ["limit.next", bodyValue(response.limit).next],
    ...stages.flatMap((stage, index) =>
      ((bodyValue(stage).calls ?? []) as unknown[])
        .map((call, position): [string, unknown] => [`continuation.stages[${index}].calls[${position}]`, call])),
  ];
  const carriers: { carrier: string; call: { tool: string; arguments: Record<string, unknown> } }[] = [];
  for (const [carrier, value] of raw) {
    const candidate = bodyValue(value);
    if (typeof candidate.tool !== "string" || candidate.arguments === undefined) continue;
    carriers.push({ carrier, call: { tool: candidate.tool, arguments: bodyValue(candidate.arguments) } });
  }
  return carriers;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

async function pack(
  server: Server,
  id: number,
  cwd: string,
  query: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return server.call(id, "read_file", {
    mode: "task_pack",
    query,
    cwd,
    lane: "sequence-corpus",
    ...extra,
  });
}

/**
 * A-F1 (2026-08-28): the lane-LESS twin of `pack`. `lane` is optional on the
 * wire, so omitting it is the default single-agent call shape — and the shape
 * every corpus case above accidentally avoided by always declaring one.
 */
async function packNoLane(
  server: Server,
  id: number,
  cwd: string,
  query: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return server.call(id, "read_file", { mode: "task_pack", query, cwd, ...extra });
}

const PENDING_FIXES: Record<string, string> = {};

function itFor(id: string): typeof it | typeof it.fails {
  return PENDING_FIXES[id] ? it.fails : it;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.kill();
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("sequence corpus", () => {
  it("keeps executable-next provenance lane-local and refuses an ambiguous same-lane collision", () => {
    const cwd = workspace({ "src/a.ts": "export const a = 1;\n" });
    const lane = "sequence-concurrency";
    const refunded = { tool: "search_files", arguments: { action: "find", query: "REFUNDED" } };
    const settled = { tool: "search_files", arguments: { action: "find", query: "SETTLED" } };
    registerExecutableNextScope(cwd, { lane, taskHandle: "task-a" }, refunded);
    registerExecutableNextScope(cwd, { lane, taskHandle: "task-b" }, settled);
    expect(executableNextScope(cwd, lane, refunded)).toEqual({ lane, taskHandle: "task-a" });
    expect(executableNextScope(cwd, lane, settled)).toEqual({ lane, taskHandle: "task-b" });

    registerExecutableNextScope(cwd, { lane, taskHandle: "task-b" }, refunded);
    expect(executableNextScope(cwd, lane, refunded)).toBeUndefined();
    expect(executableNextScope(cwd, "other-lane", settled)).toBeUndefined();
  });

  it("recovers one pending next after restart and never lets it discharge a new epoch", () => {
    const cwd = workspace({ "src/a.ts": "export const a = 1;\n" });
    const lane = "sequence-restart";
    const next = { tool: "search_files", arguments: { action: "find", query: "REFUNDED" } };
    recordTaskContract(cwd, ["refunded", "invoice"], { query: "Find REFUNDED", concernTokens: ["REFUNDED"] }, { lane });
    const scope = bindTaskContractHandle(cwd, { lane }, "task-before-restart");
    registerExecutableNextScope(cwd, scope, next);

    resetTaskContractStoreForTest();
    expect(consumeExecutableNextScope(cwd, lane, next)).toEqual(scope);
    expect(consumeExecutableNextScope(cwd, lane, next)).toBeUndefined();

    clearTaskContract(cwd, scope);
    expect(consumeExecutableNextScope(cwd, lane, next)).toBeUndefined();
  });

  // P0-1 verbatim shape, reduced only by remapping the workspace.
  itFor("p0_1_exhaustive_direct_callees")("I2: never emits act.answer while exhaustive direct callees are unresolved", async () => {
    const cwd = workspace({
      "src/invoice.ts": [
        "import { applyDiscount } from './discount.js';",
        "import { applyTax } from './tax.js';",
        "import { roundCurrency } from './round.js';",
        "export function calculateInvoiceTotal(n: number) {",
        "  return roundCurrency(applyTax(applyDiscount(n)));",
        "}",
        "",
      ].join("\n"),
      "src/discount.ts": "export function applyDiscount(n: number) { return n - 1; }\n",
      "src/tax.ts": "export function applyTax(n: number) { return n + 1; }\n",
      "src/round.ts": "export function roundCurrency(n: number) { return Math.round(n); }\n",
    });
    const server = startServer(cwd);
    servers.push(server);
    await server.initialize();

    for (const [id, query] of [
      [2, "Identify every definition directly called by calculateInvoiceTotal."],
      [3, "calculateInvoiceTotal が直接呼び出す関数の定義をすべて特定してください。"],
    ] as const) {
      const response = await pack(server, id, cwd, query, { taskProfile: "answer" });
      expect(decisionOf(response).kind).not.toBe("act.answer");
    }
  });

  // P0-2 verbatim shape: prescribed find(absent) then continuation.
  itFor("p0_2_absence_is_consumed")("I1/I3: consumes authoritative absence and never repeats that next or missing concern", async () => {
    const cwd = workspace({
      "src/status.ts": "export enum InvoiceStatus { PENDING = 'PENDING', PAID = 'PAID' }\n",
      "src/consumer.ts": "import { InvoiceStatus } from './status.js'; export const current = InvoiceStatus.PAID;\n",
    });
    const server = startServer(cwd);
    servers.push(server);
    await server.initialize();

    const query = "Add REFUNDED everywhere InvoiceStatus is used.";
    const first = await pack(server, 2, cwd, query);
    const prescribed = nextOf(first);
    expect(prescribed).toEqual({
      tool: "search_files",
      arguments: { action: "find", queries: ["REFUNDED"] },
    });
    const absence = await server.call(3, prescribed!.tool, { ...prescribed!.arguments, cwd, lane: "sequence-corpus" });
    expect((absence.matches as Record<string, unknown> | undefined)?.absence).toBeDefined();

    const firstTask = bodyValue(first.task);
    const continued = await pack(server, 4, cwd, query, {
      task_handle: firstTask.id,
      ...(typeof firstTask.state_version === "number" ? { expected_state_version: firstTask.state_version } : {}),
    });
    const secondNext = nextOf(continued);
    expect(secondNext === undefined || fingerprint(secondNext), JSON.stringify(continued)).not.toBe(fingerprint(prescribed!));
    expect(strings(continued.missing).join("\n")).not.toContain("REFUNDED");
  });

  /**
   * A-F1 REGRESSION SHAPE. Identical to I1/I3 except that `lane` is omitted.
   *
   * The executed-next ledger had two spellings of "no lane": the dispatcher
   * wrote lane-less calls under `""` (WorkspaceSession's sentinel) while both
   * readers looked under `"default"`. The corpus above always declares a lane,
   * so the split was invisible to CI while the DEFAULT path — a single agent,
   * no lane — re-issued the absence-proved find verbatim forever. Adding a lane
   * to this case would delete the invariant it exists to hold.
   */
  it("I1/I3 (lane omitted): consumes authoritative absence on the default lane too", async () => {
    const cwd = workspace({
      "src/status.ts": "export enum InvoiceStatus { PENDING = 'PENDING', PAID = 'PAID' }\n",
      "src/consumer.ts": "import { InvoiceStatus } from './status.js'; export const current = InvoiceStatus.PAID;\n",
    });
    const server = startServer(cwd);
    servers.push(server);
    await server.initialize();

    const query = "Add REFUNDED everywhere InvoiceStatus is used.";
    const first = await packNoLane(server, 2, cwd, query);
    const prescribed = nextOf(first);
    expect(prescribed).toEqual({
      tool: "search_files",
      arguments: { action: "find", queries: ["REFUNDED"] },
    });
    const absence = await server.call(3, prescribed!.tool, { ...prescribed!.arguments, cwd });
    expect((absence.matches as Record<string, unknown> | undefined)?.absence).toBeDefined();

    const firstTask = bodyValue(first.task);
    const continued = await packNoLane(server, 4, cwd, query, {
      task_handle: firstTask.id,
      ...(typeof firstTask.state_version === "number" ? { expected_state_version: firstTask.state_version } : {}),
    });
    const secondNext = nextOf(continued);
    expect(secondNext === undefined || fingerprint(secondNext), JSON.stringify(continued)).not.toBe(fingerprint(prescribed!));
    expect(strings(continued.missing).join("\n")).not.toContain("REFUNDED");
  }, 60_000);

  /**
   * A-3 ACCEPTANCE, NEGATIVE EXAMPLE INCLUDED (A-F2, 2026-08-28).
   *
   * Suppressing a consumed next and repairing the dead end it leaves are two
   * halves of one invariant, and the code shipped only the first: a
   * continuation could be neither progress nor an honest terminus — no next,
   * no gap, and (at the producer exit) a `missing[]` from which the suppressed
   * call's own concern had been filtered out. This walks the ledger to
   * exhaustion and holds BOTH directions at every step: no already-consumed
   * next is ever re-issued, and no step lands in the bare third state.
   */
  it("I5: every continuation is progress or a disclosed gap, and never repeats a consumed next", async () => {
    const cwd = workspace({
      "src/status.ts": "export enum InvoiceStatus { PENDING = 'PENDING', PAID = 'PAID' }\n",
      "src/consumer.ts": "import { InvoiceStatus } from './status.js'; export const current = InvoiceStatus.PAID;\n",
    });
    const server = startServer(cwd);
    servers.push(server);
    await server.initialize();

    const query = "Add REFUNDED everywhere InvoiceStatus is used.";
    const consumed = new Set<string>();
    let id = 2;
    let body = await packNoLane(server, id++, cwd, query);
    let task = bodyValue(body.task);

    for (let step = 0; step < 4; step += 1) {
      const next = nextOf(body);
      const missing = strings(body.missing);
      if (next === undefined) {
        // TERMINUS. Honest only if the pack still discloses what it owes —
        // `missing[]` is the surviving disclosure channel, because the frozen
        // `await_input` member of TaskDecision carries no `gaps` key.
        expect(decisionOf(body).kind, JSON.stringify(body)).toBe("await_input");
        expect(missing.length, JSON.stringify(body)).toBeGreaterThan(0);
        return;
      }
      // NEGATIVE EXAMPLE: a next whose result this session already consumed.
      expect(consumed.has(fingerprint(next)), `${fingerprint(next)} was already executed`).toBe(false);
      consumed.add(fingerprint(next));
      await server.call(id++, next.tool, { ...next.arguments, cwd });
      body = await packNoLane(server, id++, cwd, query, {
        task_handle: task.id,
        ...(typeof task.state_version === "number" ? { expected_state_version: task.state_version } : {}),
      });
      task = bodyValue(body.task);
    }
  }, 90_000);

  /**
   * R1 REGRESSION SHAPE (2026-08-28) — THE CALL BEING SERVED IS CONSUMED WORK.
   *
   * Reduced verbatim from the follower's f03 (`c2-ledgerd`) and Tier-3
   * `enum-refunded` cases, which reproduced it independently: step 0 prescribes
   * `read_file mode=task_pack query=<verbatim> surfaceRoles=[…]`, step 1 IS that
   * call, and step 1's response handed the same call back byte-identically with
   * the same unresolved gaps. Only a THIRD identical call finally advanced.
   *
   * THE MECHANISM, and why the existing no-repeat gates could not see it: the
   * executed-next ledger was written in `callTool` AFTER the response had been
   * fully built, so both gates (`suppressNonProgressingNextCall` and the shared
   * producer exit) compared against a ledger exactly one call stale. The fix
   * records the in-flight call at dispatch, so a response can observe that the
   * call producing it has just spent the next it is about to re-propose.
   *
   * THE ASSERTION IS OVER EVERY CARRIER, not `decision.next` alone: the
   * projected next is minted from four independent sources (discovery bundle,
   * contract `next_call`, continuation plan, gap-named recovery) and the gate
   * could only ever inspect the second, so an assertion narrowed to one carrier
   * would not have caught this and will not catch the next one.
   *
   * Three RPCs, executed exactly as a follower does — no `cwd`, `lane` or
   * `task_handle` injected into a server-issued call.
   */
  it("R1: no carrier re-issues a next the call being served has itself consumed", async () => {
    const cwd = workspace({
      "internal/api/router.go": "package api\n\ntype Router struct{}\n\nfunc NewRouter() *Router { return &Router{} }\n",
      "pkg/invoice/invoice.go": [
        "package invoice",
        "",
        "func calculateInvoiceTotal(subtotal, tax int) int {",
        "\treturn subtotal + tax",
        "}",
        "",
        "func Total(subtotal, tax int) int { return calculateInvoiceTotal(subtotal, tax) }",
        "",
      ].join("\n"),
      "pkg/transaction/status.go": "package transaction\n\ntype Status string\n\nconst (\n\tREFUNDED Status = \"REFUNDED\"\n)\n",
    });
    const server = startServer(cwd);
    servers.push(server);
    await server.initialize();

    const first = await packNoLane(server, 2, cwd, "Find all enum variants that represent REFUNDED.");
    const prescribed = nextOf(first);
    expect(prescribed, JSON.stringify(first)).toBeDefined();

    const consumed = new Set<string>([callIdentity(prescribed!)]);
    let step = prescribed!;
    for (let rpc = 3; rpc <= 4; rpc += 1) {
      // Verbatim: a structured next is an executable server-issued call.
      const response = await server.call(rpc, step.tool, { ...step.arguments });
      for (const { carrier, call } of nextCarriers(response)) {
        expect(
          consumed.has(callIdentity(call)),
          `${carrier} re-issued an already-consumed call: ${callIdentity(call)}`,
        ).toBe(false);
      }
      const advanced = nextOf(response);
      if (advanced === undefined) return;
      consumed.add(callIdentity(advanced));
      step = advanced;
    }
  }, 90_000);

  /**
   * I4, IMPLEMENTED (A-F5, 2026-08-28).
   *
   * The case shipped as a tautology: it built a literal
   * `["complete","partial","complete"]` array and asserted that the detector
   * fired on it. That tests the detector against its own input and observes the
   * server not at all — the corpus's own rule is that inputs are verbatim MCP
   * call shapes. The oscillation PREDICATE is preserved character-for-character
   * so the re-pin is traceable; what changed is that `observed` now comes from
   * three real packs of one unchanged query against one unchanged workspace,
   * and the expectation is inverted because a server that oscillates is the
   * defect, not the pass.
   *
   * Coverage rides `task.coverage`, and a repeated pack legitimately returns a
   * `read.receipt` whose task node carries it — both shapes are read, so a
   * receipt cannot hide a flip.
   */
  it("I4: coverage never oscillates complete → partial → complete without a workspace change", async () => {
    const cwd = workspace({
      "src/invoice.ts": [
        "import { applyTax } from './tax.js';",
        "export function calculateInvoiceTotal(n: number) { return applyTax(n); }",
        "",
      ].join("\n"),
      "src/tax.ts": "export function applyTax(n: number) { return n + 1; }\n",
      "src/report.ts": "export function renderReport(total: number) { return `total: ${total}`; }\n",
    });
    const server = startServer(cwd);
    servers.push(server);
    await server.initialize();

    const query = "Explain how calculateInvoiceTotal composes its helpers.";
    const coverage: string[] = [];
    for (let call = 0; call < 3; call += 1) {
      const body = await packNoLane(server, 2 + call, cwd, query, { taskProfile: "answer" });
      const task = bodyValue(bodyValue(body.receipt).task ?? body.task);
      coverage.push(typeof task.coverage === "string" ? task.coverage : "<absent>");
    }

    // Guard against the case degenerating back into a tautology from the other
    // direction: an assertion over three "<absent>" readings would also pass.
    expect(coverage.some((state) => state !== "<absent>"), coverage.join(" → ")).toBe(true);
    expect(coverage.some((state, index) =>
      index > 0 && coverage[index - 1] === "complete" && state === "partial"
        && coverage.slice(index + 1).includes("complete"),
    ), coverage.join(" → ")).toBe(false);
  }, 60_000);
});
