import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const BIN_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin.ts");
const children: ChildProcess[] = [];
const roots: string[] = [];

function start(cwd: string, mode: "on" | "off", tracePath: string): { initialize(): Promise<void>; call(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>; close(): void } {
  const child = spawn(process.execPath, [TSX_CLI, BIN_TS], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TOKENLIGHTEN_ALLOWED_PARENTS: os.tmpdir(),
      TL_PROOF_COMPLETION: mode,
      TL_PROOF_COMPLETION_TRACE_PATH: tracePath,
      TL_DECISION_INVARIANT_STRICT: "off",
    },
  });
  children.push(child);
  let buffer = "";
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        const id = message.id;
        if (typeof id === "number") waiters.get(id)?.(message);
      } catch { /* ignore diagnostics */ }
    }
  });
  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proof dispatcher ${method} timed out`)), 20_000);
    waiters.set(id, (message) => { clearTimeout(timer); waiters.delete(id); resolve(message); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return {
    async initialize() {
      await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proof-live", version: "0" } });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(id, name, args) {
      const response = await rpc(id, "tools/call", { name, arguments: args });
      const result = response.result as { content?: Array<{ text?: string }> } | undefined;
      return JSON.parse(result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    },
    close() { try { child.kill("SIGKILL"); } catch { /* already exited */ } },
  };
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("proof completion live dispatcher flag", () => {
  it("keeps non-exhaustive task-pack wire parity OFF while ON emits a child-visible engagement trace", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tl-proof-live-"));
    roots.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"proof-live\",\"private\":true}\n");
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "invoice.ts"), "export function calculateInvoiceTotal() { return 1; }\n");
    const onTrace = path.join(cwd, "on.trace.jsonl");
    const offTrace = path.join(cwd, "off.trace.jsonl");
    const args = { mode: "task_pack", query: "Show the implementation of calculateInvoiceTotal", paths: ["src/invoice.ts"], taskProfile: "answer", cwd, lane: "proof-live" };

    const on = start(cwd, "on", onTrace);
    await on.initialize();
    const onBody = await on.call(2, "read_file", args);
    const off = start(cwd, "off", offTrace);
    await off.initialize();
    const offBody = await off.call(2, "read_file", args);

    expect(onBody.kind).toBe("read.task_pack");
    expect(offBody.kind).toBe("read.task_pack");
    expect(onBody.decision).toMatchObject({ kind: (offBody.decision as { kind?: unknown })?.kind });
    const trace = fs.readFileSync(onTrace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(trace).toContainEqual(expect.objectContaining({ flag: "TL_PROOF_COMPLETION", enabled: true }));
    expect(trace.at(-1)).toMatchObject({ count: trace.length });
    expect(fs.existsSync(offTrace)).toBe(false);
  }, 30_000);

  /**
   * A-F6 PARITY, through the real producer rather than a synthetic contract.
   *
   * OFF must be v0.12 (base 23a023e0), which had no open-universe concept at
   * all: an exhaustive query certified like any other. ON must suppress that
   * act — that is the whole point of A-4..A-7. The shipped code collapsed the
   * OFF arm to `baseReady`, a third behavior looser than either release, and no
   * spec covered an exhaustive query in either mode, so the difference this
   * pins was entirely unmeasured.
   *
   * The certificate id is pinned in both modes because it is the one wire shape
   * the flag unavoidably moves: a discharged ledger contributes its digest,
   * making the id two-segment ON and single-segment OFF — the exact form
   * `ledgerCertificateBindingValid` discriminates on.
   */
  it("suppresses the exhaustive act when ON and reproduces v0.12 acceptance when OFF", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tl-proof-parity-"));
    roots.push(cwd);
    fs.writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"proof-parity\",\"private\":true}\n");
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "src", "invoice.ts"), [
      "import { applyDiscount } from './discount.js';",
      "import { applyTax } from './tax.js';",
      "import { roundCurrency } from './round.js';",
      "export function calculateInvoiceTotal(n: number) {",
      "  return roundCurrency(applyTax(applyDiscount(n)));",
      "}",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "src", "discount.ts"), "export function applyDiscount(n: number) { return n - 1; }\n");
    fs.writeFileSync(path.join(cwd, "src", "tax.ts"), "export function applyTax(n: number) { return n + 1; }\n");
    fs.writeFileSync(path.join(cwd, "src", "round.ts"), "export function roundCurrency(n: number) { return Math.round(n); }\n");
    const args = {
      mode: "task_pack",
      query: "Identify every definition directly called by calculateInvoiceTotal.",
      taskProfile: "answer",
      cwd,
    };

    const on = start(cwd, "on", path.join(cwd, "on.trace.jsonl"));
    await on.initialize();
    const onBody = await on.call(2, "read_file", { ...args, lane: "parity-on" });
    const off = start(cwd, "off", path.join(cwd, "off.trace.jsonl"));
    await off.initialize();
    const offBody = await off.call(2, "read_file", { ...args, lane: "parity-off" });

    const onDecision = onBody.decision as { kind?: string; certificate?: { id?: string } } | undefined;
    const offDecision = offBody.decision as { kind?: string; certificate?: { id?: string } } | undefined;
    expect(onDecision?.kind, JSON.stringify(onBody.decision)).not.toBe("act.answer");
    expect(offDecision?.kind, JSON.stringify(offBody.decision)).toBe("act.answer");
    expect(offDecision?.certificate?.id).toMatch(/^ready-[a-f0-9]{16}$/);

    // The same server ON still certifies a NON-exhaustive query, so the
    // suppression above is the quantifier at work, not a blanket refusal to
    // certify. Its id stays single-segment because its ledger recorded no
    // obligation, and A-F3 forbids dressing that as a discharge.
    const plain = await on.call(3, "read_file", {
      mode: "task_pack",
      query: "Show the implementation of calculateInvoiceTotal",
      paths: ["src/invoice.ts"],
      taskProfile: "answer",
      cwd,
      lane: "parity-on-plain",
    });
    const plainDecision = plain.decision as { kind?: string; certificate?: { id?: string } } | undefined;
    expect(plainDecision?.kind).toBe("act.answer");
    expect(plainDecision?.certificate?.id).toMatch(/^ready-[a-f0-9]{16}$/);
  }, 60_000);
});
