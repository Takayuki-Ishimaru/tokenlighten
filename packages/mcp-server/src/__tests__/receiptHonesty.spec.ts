// receiptHonesty.spec.ts — [R5-10], adjudicated 2026-08-14.
//
// THE RULE, verbatim:
//
//     A receipt may only be issued for the fact of having SERVED: only bytes
//     that actually reached the consumer on the wire can ground `served_by`.
//     A serve dropped by a cap is UNSERVED and remains discovery-eligible.
//
// Three reproductions drove it, and each is a case below.
//
// F-1 (reproduced at 5b699484, fixed by this wave). After an `act.answer`
// pack over file A, a `mode=slice` of a file B the session had NEVER served
// answered with this, entire:
//
//   {"v":1,"kind":"read.receipt","receipt":{"receipt":"decision-unchanged",
//    "certificate":{"id":"ready-…"},"certified_query":"…"}}
//
// No decision, no next, no retry. `taskEpoch:"new"` did work, but nothing on
// the wire said so — a non-editing consumer had no in-protocol path to B's
// bytes at all. Per the rule, a receipt was the wrong member: nothing had been
// served for B, so there was nothing to receipt.
//
// F-1b. A `mode=full` the per-task cap downgraded to an outline delivers zero
// content bytes; those lines must stay discovery-eligible, so the follow-up
// slice must SERVE rather than answer `code-unchanged`.
//
// F-1c. `ranges:[…]` (the multi-window form) must put real bytes on the wire,
// the `sections` route must stay healthy, and a genuinely-served range must
// still receipt — the honest suppression is the thing being protected, not the
// thing being removed.
//
// The last case is the mechanism itself: booking is provisional until the
// funnel corroborates it against the serialized payload.

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  recordServedRange,
  resetAll,
  servedRangeReceipt,
  settleServedRanges,
} from "../state/session.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  initialize(): Promise<void>;
  call(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
}

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-rh-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(cwd: string, env?: Record<string, string>): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, cwd],
    { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(env ?? {}) } },
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

  const send = (obj: unknown): void => { child.stdin!.write(JSON.stringify(obj) + "\n"); };

  let nextId = 0;
  function rpc(method: string, params?: unknown, timeoutMs = 30000): Promise<any> {
    const id = (nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`rpc '${method}' timed out after ${timeoutMs}ms.\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  return {
    async initialize(): Promise<void> {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const result = await rpc("tools/call", { name: "read_file", arguments: args });
      const text: string = result?.result?.content?.[0]?.text;
      expect(typeof text).toBe("string");
      return JSON.parse(text) as Record<string, unknown>;
    },
    kill(): void { try { child.kill("SIGKILL"); } catch { /* ok */ } },
  };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  resetAll();
});

async function liveServer(tag: string, env?: Record<string, string>): Promise<{ ws: string; srv: ServerHandle }> {
  const ws = mkDir(tag);
  const srv = startServer(ws, env);
  servers.push(srv);
  await srv.initialize();
  return { ws, srv };
}

/** Every non-empty body this payload carries, in any of the read dialects. */
function bodiesOf(payload: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "arguments") continue;
      if ((key === "body" || key === "content" || key === "code")
        && typeof child === "string" && child.length > 0) {
        found.push(child);
        continue;
      }
      walk(child);
    }
  };
  walk(payload);
  return found;
}

const receiptOf = (payload: Record<string, unknown>): Record<string, unknown> | undefined =>
  payload["receipt"] as Record<string, unknown> | undefined;

const lines = (n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

// ---------------------------------------------------------------------------
// F-1 — a receipt for an UNSERVED target must still be followable
// ---------------------------------------------------------------------------

describe("[R5-10] F-1 — every emitted receipt carries an actionable continuation", () => {
  it("2026-08-22 fence-serves-unserved-scope: a read on an UNSERVED file now serves it directly, no stop/next round trip", async () => {
    const { ws, srv } = await liveServer("f1");
    writeFile(ws, "src/alpha.ts", `export function alpha(): number {\n${lines(40, "  // a")}  return 1;\n}\n`);
    writeFile(ws, "src/beta.ts", `export function beta(): string {\n${lines(40, "  // b")}  return "BETA_MARKER";\n}\n`);

    // 1. An act.answer pack over A installs the prepared certificate.
    const pack = await srv.call({
      mode: "task_pack",
      query: "what does alpha() return in src/alpha.ts",
      paths: ["src/alpha.ts"],
      taskProfile: "answer",
      cwd: ws,
    });
    expect(pack["kind"]).toBe("read.task_pack");
    expect((pack["decision"] as Record<string, unknown>)["kind"]).toBe("act.answer");

    // 2. Ask for a file the pack never served.
    //
    // THE ACCEPTANCE, superseding F-1's original one: F-1 (2026-08-14) fixed
    // a bare, unfollowable `decision-unchanged` stop by giving it a `next`.
    // 2026-08-22 fence-serves-unserved-scope removes the stop itself for this
    // call shape — a prepared certificate must not stonewall read-only
    // discovery of scope it never served — so B's bytes now arrive directly,
    // with no receipt/next round trip to follow at all.
    const served = await srv.call({ mode: "full", path: "src/beta.ts", cwd: ws });
    expect(served["kind"], `expected a direct serve; got ${JSON.stringify(served)}`).toBe("read.text");
    expect(served["receipt"]).toBeUndefined();
    const body = bodiesOf(served).join("\n");
    expect(body).toContain("BETA_MARKER");
  }, 60000);

  it("an EDIT-terminal prepared stop is equally followable (the edit_file template is scrubbed too)", async () => {
    const { ws, srv } = await liveServer("f1edit");
    writeFile(ws, "src/order.ts", `export function total(items: number[]): number {\n${lines(30, "  // t")}  return 0;\n}\n`);
    writeFile(ws, "src/other.ts", `export const OTHER_MARKER = 1;\n${lines(30, "  // o")}`);

    await srv.call({
      mode: "task_pack",
      query: "fix the total() reducer in src/order.ts so it sums the items",
      paths: ["src/order.ts"],
      cwd: ws,
    });
    const stop = await srv.call({ mode: "slice", path: "src/other.ts", range: "1-5", cwd: ws });

    if (stop["kind"] === "read.receipt") {
      const next = receiptOf(stop)?.["next"] as { tool: string; arguments: Record<string, unknown> } | undefined;
      expect(next, `bare receipt on an edit-terminal stop: ${JSON.stringify(stop)}`).toBeDefined();
      expect(JSON.stringify(next!.arguments)).not.toMatch(/<[^<>]{3,}>/);
      const followed = await srv.call(next!.arguments);
      expect(bodiesOf(followed).join("\n")).toContain("OTHER_MARKER");
    } else {
      // Served outright (the fence let it through) — also a followable outcome.
      expect(bodiesOf(stop).length).toBeGreaterThan(0);
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// W5 — post-ready trim preserves serving honesty
// ---------------------------------------------------------------------------

describe("[W5] post-ready trim serves an existing-wire skeleton, never a fake receipt", () => {
  it("T13-shaped N=6 full read serves a truthful skeleton; OFF and force_serve retain normal full content", async () => {
    const { ws, srv } = await liveServer("w5-honest", { TL_POST_READY_TRIM: "1", TL_POST_READY_TRIM_N: "6" });
    writeFile(ws, "src/alpha.ts", `export function alpha(): number { return 1; }\n`);
    writeFile(ws, "src/beta.ts", `export function beta(): string {\n  return "W5_BETA_MARKER";\n}\n${lines(80, "// beta")}`);

    const pack = await srv.call({
      mode: "task_pack",
      query: "what does alpha() return in src/alpha.ts",
      paths: ["src/alpha.ts"],
      taskProfile: "answer",
      cwd: ws,
    });
    expect(pack["kind"]).toBe("read.task_pack");
    // Five ordinary pre-edit reads establish the T13-shaped tail. The
    // fixture's pack already served alpha, so these are honest cache receipts;
    // they still count as read/search calls for the post-ready threshold.
    for (let call = 1; call < 6; call++) {
      const read = await srv.call({ mode: "slice", path: "src/alpha.ts", range: "1-1", cwd: ws });
      expect(["read.text", "read.receipt"]).toContain(read["kind"]);
    }

    // Keep this W5 fixture above the tiny-file honesty exception: the
    // separate dispatcher integration test pins that tiny files stay full.
    fs.appendFileSync(
      path.join(ws, "src/beta.ts"),
      "/* " + "post-ready trim non-tiny fixture ".repeat(400) + " */",
      "utf8",
    );
    const trimmed = await srv.call({ mode: "full", path: "src/beta.ts", cwd: ws });
    // Skeletons project through the established read.map member, not a new
    // W5-specific wire kind.
    expect(trimmed["kind"]).toBe("read.map");
    expect(trimmed["receipt"]).toBeUndefined();
    // The frozen v1 projector expresses an honest skeleton as read.map:
    // signatures are the served content and limit.next names the unserved
    // range on the minted handle. No W5-only field is introduced.
    expect(trimmed).toMatchObject({
      outline: { path: "src/beta.ts", signatures: [expect.objectContaining({ name: "beta" })] },
      limit: {
        next: {
          tool: "read_file",
          arguments: {
            content: "auto",
            targets: [expect.objectContaining({ handle: expect.any(String), ranges: expect.any(Array) })],
          },
        },
      },
    });
    expect(JSON.stringify(trimmed)).toMatch(/"1-\d+"/);

    const forced = await srv.call({ mode: "full", path: "src/beta.ts", force_serve: true, cwd: ws });
    expect(forced["kind"]).toBe("read.text");
    expect(bodiesOf(forced).join("\n")).toContain("W5_BETA_MARKER");
  }, 60000);

  it("is inert while TL_POST_READY_TRIM is off", async () => {
    const { ws, srv } = await liveServer("w5-off", { TL_POST_READY_TRIM: "0", TL_POST_READY_TRIM_N: "6" });
    writeFile(ws, "src/alpha.ts", `export function alpha(): number { return 1; }\n`);
    writeFile(ws, "src/beta.ts", `export const W5_OFF_MARKER = true;\n`);
    await srv.call({ mode: "task_pack", query: "what does alpha() return in src/alpha.ts", paths: ["src/alpha.ts"], taskProfile: "answer", cwd: ws });
    for (let call = 1; call <= 6; call++) {
      await srv.call({ mode: "slice", path: "src/alpha.ts", range: "1-1", cwd: ws });
    }
    const full = await srv.call({ mode: "full", path: "src/beta.ts", cwd: ws });
    expect(full["kind"]).toBe("read.text");
    expect(JSON.stringify(full)).not.toContain("post-ready discovery trimmed");
    expect(bodiesOf(full).join("\n")).toContain("W5_OFF_MARKER");
  }, 60000);
});

// ---------------------------------------------------------------------------
// F-1b — a cap-dropped serve books nothing
// ---------------------------------------------------------------------------

describe("[R5-10] F-1b — a serve the cap dropped stays discovery-eligible", () => {
  it("a mode=full downgraded past the per-task cap ships no body, and the slice retry SERVES", async () => {
    const { ws, srv } = await liveServer("f1b");
    const total = 12;
    for (let i = 0; i < total; i += 1) {
      writeFile(ws, `src/f${i}.ts`, `export const MARKER_${i} = ${i};\n${lines(300, `// pad${i}`)}`);
    }

    // Spend the per-task whole-file budget until a full read comes back with
    // zero content bytes. The exact cap is a tuning constant; the invariant is
    // not, so the case finds the first dropped serve rather than hardcoding it.
    let dropped: number | undefined;
    for (let i = 0; i < total && dropped === undefined; i += 1) {
      const full = await srv.call({ mode: "full", path: `src/f${i}.ts`, cwd: ws });
      if (bodiesOf(full).length === 0) dropped = i;
    }
    expect(dropped, "no mode=full was dropped by the cap — retune the fixture").toBeDefined();

    // THE ACCEPTANCE: the dropped range was never booked, so this recovers to a
    // real serve rather than a `code-unchanged` receipt for bytes nobody got.
    const retry = await srv.call({ mode: "slice", path: `src/f${dropped}.ts`, range: "1-50", cwd: ws });
    expect(retry["kind"]).toBe("read.text");
    expect(receiptOf(retry)?.["receipt"]).not.toBe("code-unchanged");
    expect(bodiesOf(retry).join("\n")).toContain(`MARKER_${dropped}`);
  }, 120000);

  it("a genuinely-served range still yields its code-unchanged receipt (the honest suppression survives)", async () => {
    const { ws, srv } = await liveServer("f1bhonest");
    writeFile(ws, "src/served.ts", `export const SERVED_MARKER = 1;\n${lines(60, "// s")}`);

    const first = await srv.call({ mode: "slice", path: "src/served.ts", range: "1-40", cwd: ws });
    expect(first["kind"]).toBe("read.text");
    expect(bodiesOf(first).join("\n")).toContain("SERVED_MARKER");

    const again = await srv.call({ mode: "slice", path: "src/served.ts", range: "1-40", cwd: ws });
    expect(again["kind"]).toBe("read.receipt");
    expect(receiptOf(again)?.["receipt"]).toBe("code-unchanged");
    expect(receiptOf(again)?.["served_by"]).toMatch(/slice 1-40/);
    // [R5-10]'s other half: even an HONEST suppression names a way forward.
    expect(receiptOf(again)?.["next"]).toBeDefined();

    // A strictly narrower window is subsumed by the same genuine serve.
    const narrower = await srv.call({ mode: "slice", path: "src/served.ts", range: "5-10", cwd: ws });
    expect(receiptOf(narrower)?.["receipt"]).toBe("code-unchanged");
  }, 60000);
});

// ---------------------------------------------------------------------------
// F-1c — the multi-window route serves, and so does `sections`
// ---------------------------------------------------------------------------

describe("[R5-10] F-1c — ranges[] puts real bytes on the wire before it books them", () => {
  it("ranges:['1-237'] serves a body on the FIRST call, then receipts honestly", async () => {
    const { ws, srv } = await liveServer("f1c");
    writeFile(ws, "src/code.ts", `export const RANGES_MARKER = 1;\n${lines(240, "// c")}`);

    const first = await srv.call({ mode: "slice", path: "src/code.ts", ranges: ["1-237"], cwd: ws });
    expect(first["kind"]).toBe("read.text");
    const body = bodiesOf(first).join("\n");
    expect(body).toContain("RANGES_MARKER");
    expect(body).toContain("// c 100");

    // Only NOW may it be receipted — the bytes went out on call 1.
    const second = await srv.call({ mode: "slice", path: "src/code.ts", ranges: ["1-237"], cwd: ws });
    expect(second["kind"]).toBe("read.receipt");
    expect(receiptOf(second)?.["receipt"]).toBe("code-unchanged");
    expect(receiptOf(second)?.["next"]).toBeDefined();
  }, 60000);

  it("the sections route — ranges[]'s sibling selector — stays healthy", async () => {
    const { ws, srv } = await liveServer("f1csec");
    writeFile(ws, "doc/guide.md",
      `# Guide\n\nintro\n\n## Alpha\n\n${lines(40, "alpha line")}\n## Beta\n\nBETA_SECTION_MARKER\n${lines(40, "beta line")}`);

    // `sections:[…]` is the named-material selector on a slice, the route the
    // F-1c report contrasted with `ranges:[…]`. It must serve bytes on its
    // first call for exactly the same reason.
    const sections = await srv.call({
      mode: "slice", path: "doc/guide.md", sections: ["Beta"], cwd: ws,
    });
    expect(sections["kind"]).not.toBe("refusal");
    expect(bodiesOf(sections).join("\n")).toContain("BETA_SECTION_MARKER");
  }, 60000);
});

// ---------------------------------------------------------------------------
// W2A-1 (2026-08-21) — a re-ask wider than an already-clamped serve must not
// collapse to a full-range receipt
// ---------------------------------------------------------------------------
//
// Live repro (readCodeTaskPack.ts, 21,107 lines, real dist build):
// `range=587-8119` served only 587-1104 (the per-call slice byte cap), with
// `remaining:["1105-8119"]` honestly disclosed. The IDENTICAL 587-8119 re-ask
// — same session, no new bytes needed for 587-1104 — collapsed to a bare
// `code-unchanged` receipt for the caller's WHOLE 587-8119 ask: no body, no
// `remaining`, no signal that 1105-8119 (92% of the request) was never put on
// the wire. `addedLines === 0` only proves the CLAMPED prefix was already
// held; it says nothing about whether that prefix was the caller's whole ask.
// Both `servedContentReceipt` collapse guards in server.ts had this gap (the
// single `range` form and the `ranges:[…]` batch form) and are pinned
// separately below; `sliceData.remaining_ranges` / `batchData.truncated` are
// the fields that already carried the missing signal.
describe("[W2A-1] a wider re-ask than an already-clamped serve must not silently drop its tail", () => {
  it("range='1-<total>' on a file wider than one slice's cap: the identical re-ask SERVES the tail, not a full-range receipt", async () => {
    const { ws, srv } = await liveServer("w2a1range");
    const total = 4000;
    writeFile(
      ws,
      "src/wide.ts",
      `export const WIDE_MARKER = 1;\n${lines(total, "// filler line with enough characters to force a slice byte cap")}`,
    );
    const whole = `1-${total + 1}`;

    const first = await srv.call({ mode: "slice", path: "src/wide.ts", range: whole, cwd: ws });
    expect(first["kind"]).toBe("read.text");
    const firstEvidence = (first["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(String(firstEvidence["range"]), "fixture did not trigger a clamp — widen it").not.toBe(whole);
    expect(firstEvidence["remaining"], "the clamped first serve must disclose its own tail").toBeDefined();

    // THE ACCEPTANCE: the identical wide re-ask, now that the clamped prefix
    // is already held (addedLines===0 for it), must still put bytes on the
    // wire and disclose the same undelivered tail — never a bare receipt for
    // the whole nominal range.
    const second = await srv.call({ mode: "slice", path: "src/wide.ts", range: whole, cwd: ws });
    expect(
      second["kind"],
      `a wider re-ask than the held prefix must serve, not receipt; got ${JSON.stringify(second).slice(0, 300)}`,
    ).toBe("read.text");
    expect(bodiesOf(second).join("\n")).toContain("WIDE_MARKER");
    const secondEvidence = (second["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(secondEvidence["remaining"], "the re-ask must still disclose the undelivered tail").toBeDefined();
  }, 60000);

  it("ranges:['1-<total>'] (the batch form) on the same oversized file: the identical re-ask also SERVES, never a full-range receipt", async () => {
    const { ws, srv } = await liveServer("w2a1ranges");
    const total = 4000;
    writeFile(
      ws,
      "src/wideb.ts",
      `export const WIDE_BATCH_MARKER = 1;\n${lines(total, "// filler line with enough characters to force a slice byte cap")}`,
    );
    const whole = `1-${total + 1}`;

    const first = await srv.call({ mode: "slice", path: "src/wideb.ts", ranges: [whole], cwd: ws });
    expect(first["kind"]).toBe("read.text");
    const firstEvidence = (first["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(String(firstEvidence["range"]), "fixture did not trigger a clamp — widen it").not.toBe(whole);

    const second = await srv.call({ mode: "slice", path: "src/wideb.ts", ranges: [whole], cwd: ws });
    expect(
      second["kind"],
      `a wider re-ask than the held prefix must serve, not receipt; got ${JSON.stringify(second).slice(0, 300)}`,
    ).toBe("read.text");
    expect(bodiesOf(second).join("\n")).toContain("WIDE_BATCH_MARKER");
  }, 60000);
});

// ---------------------------------------------------------------------------
// The mechanism — booking is provisional until the payload corroborates it
// ---------------------------------------------------------------------------

describe("W7 TL_OVERLAP_TRIM reuses the served-range ledger", () => {
  const overlapFixture = (): string => Array.from(
    { length: 12 },
    (_, index) => `export const LINE_${String(index + 1).padStart(2, "0")} = ${index + 1};`,
  ).join("\n") + "\n";

  it("projects the held overlap as prior, serves only the residual, receipts full coverage, and lets force_serve bypass", async () => {
    const { ws, srv } = await liveServer("w7-on", { TL_OVERLAP_TRIM: "1" });
    writeFile(ws, "src/overlap.ts", overlapFixture());

    const first = await srv.call({ mode: "slice", path: "src/overlap.ts", range: "1-6", cwd: ws });
    expect(bodiesOf(first).join("\n")).toContain("LINE_04");

    const partial = await srv.call({ mode: "slice", path: "src/overlap.ts", range: "4-10", cwd: ws });
    expect(partial["kind"]).toBe("read.text");
    const partialBodies = bodiesOf(partial).join("\n");
    expect(partialBodies).toContain("LINE_07");
    expect(partialBodies).toContain("LINE_10");
    expect(partialBodies).not.toContain("LINE_04");
    expect(JSON.stringify(partial)).toContain("\"prior\"");
    expect(JSON.stringify(partial)).toContain("\"range\":\"4-6\"");

    const covered = await srv.call({ mode: "slice", path: "src/overlap.ts", range: "1-6", cwd: ws });
    expect(covered["kind"]).toBe("read.receipt");
    expect(receiptOf(covered)?.["receipt"]).toBe("code-unchanged");

    const forced = await srv.call({ mode: "slice", path: "src/overlap.ts", range: "4-10", force_serve: true, cwd: ws });
    const forcedBodies = bodiesOf(forced).join("\n");
    expect(forcedBodies).toContain("LINE_04");
    expect(forcedBodies).toContain("LINE_10");
    expect(JSON.stringify(forced)).not.toContain("\"prior\"");

    writeFile(ws, "src/full-overlap.ts", overlapFixture());
    await srv.call({ mode: "slice", path: "src/full-overlap.ts", range: "1-4", cwd: ws });
    const full = await srv.call({ mode: "full", path: "src/full-overlap.ts", cwd: ws });
    expect(bodiesOf(full).join("\n")).not.toContain("LINE_02");
    expect(bodiesOf(full).join("\n")).toContain("LINE_12");
    expect(JSON.stringify(full)).toContain("\"prior\"");

    writeFile(ws, "src/symbol-overlap.ts", [
      "export function overlapSymbol(): number {",
      "  const SYMBOL_LINE_02 = 2;",
      "  const SYMBOL_LINE_03 = 3;",
      "  const SYMBOL_LINE_04 = 4;",
      "  const SYMBOL_LINE_05 = 5;",
      "  const SYMBOL_LINE_06 = 6;",
      "  return SYMBOL_LINE_02 + SYMBOL_LINE_03 + SYMBOL_LINE_04 + SYMBOL_LINE_05 + SYMBOL_LINE_06;",
      "}",
      "",
    ].join("\n"));
    await srv.call({ mode: "slice", path: "src/symbol-overlap.ts", range: "1-4", cwd: ws });
    const symbol = await srv.call({ mode: "symbol", path: "src/symbol-overlap.ts", symbol: "overlapSymbol", cwd: ws });
    const symbolBodies = bodiesOf(symbol).join("\n");
    expect(symbolBodies).not.toContain("SYMBOL_LINE_02 = 2");
    expect(symbolBodies).toContain("SYMBOL_LINE_05 = 5");
    expect(JSON.stringify(symbol)).toContain("\"prior\"");
  }, 60000);

  it("keeps the pre-W7 full-body behavior when the flag is off", async () => {
    const { ws, srv } = await liveServer("w7-off", { TL_OVERLAP_TRIM: "0" });
    writeFile(ws, "src/overlap-off.ts", overlapFixture());
    await srv.call({ mode: "slice", path: "src/overlap-off.ts", range: "1-6", cwd: ws });
    const partial = await srv.call({ mode: "slice", path: "src/overlap-off.ts", range: "4-10", cwd: ws });
    const body = bodiesOf(partial).join("\n");
    expect(body).toContain("LINE_04");
    expect(body).toContain("LINE_10");
    expect(JSON.stringify(partial)).not.toContain("\"prior\"");
  }, 60000);
});

describe("[R5-10] the served-range ledger books what the wire carried", () => {
  const WS = "/tmp/tl-r510-ledger";
  const SHA = "sha256:aaaaaaaaaaaa";

  it("a span the response did not carry is RETRACTED, and the lines stay discovery-eligible", () => {
    recordServedRange(WS, "src/dropped.ts", SHA, 1, 40, 200, {
      mode: "full", range: "1-40", call: 1,
    });
    // Booked provisionally: before the funnel settles, the span is live.
    expect(servedRangeReceipt(WS, "src/dropped.ts", SHA, 1, 40, 200)).toBeDefined();

    // The response carried no body for that path — an outline, a receipt, a
    // refusal, a cap-dropped downgrade. Nothing reached the consumer.
    settleServedRanges(WS, { unattributed: false, windows: [] });

    expect(servedRangeReceipt(WS, "src/dropped.ts", SHA, 1, 40, 200)).toBeUndefined();
  });

  it("a span the response DID carry survives, and a sibling it did not is retracted", () => {
    recordServedRange(WS, "src/kept.ts", SHA, 1, 40, 200, { mode: "slice", range: "1-40", call: 1 });
    recordServedRange(WS, "src/shed.ts", SHA, 1, 40, 200, { mode: "slice", range: "1-40", call: 1 });

    settleServedRanges(WS, {
      unattributed: false,
      windows: [{ path: "src/kept.ts", start: 1, end: 40 }],
    });

    expect(servedRangeReceipt(WS, "src/kept.ts", SHA, 1, 40, 200)).toBeDefined();
    expect(servedRangeReceipt(WS, "src/shed.ts", SHA, 1, 40, 200)).toBeUndefined();
  });

  it("an unattributable body fails OPEN — a projector gap must not re-serve held bytes", () => {
    recordServedRange(WS, "src/openfail.ts", SHA, 1, 40, 200, { mode: "slice", range: "1-40", call: 1 });
    settleServedRanges(WS, { unattributed: true, windows: [] });
    expect(servedRangeReceipt(WS, "src/openfail.ts", SHA, 1, 40, 200)).toBeDefined();
  });

  it("retraction is per-span: an earlier genuine serve is not undone by a later dropped one", () => {
    recordServedRange(WS, "src/mixed.ts", SHA, 1, 40, 200, { mode: "slice", range: "1-40", call: 1 });
    settleServedRanges(WS, {
      unattributed: false,
      windows: [{ path: "src/mixed.ts", start: 1, end: 40 }],
    });

    // A second call books 41-80 and then ships nothing.
    recordServedRange(WS, "src/mixed.ts", SHA, 41, 80, 200, { mode: "full", range: "41-80", call: 2 });
    settleServedRanges(WS, { unattributed: false, windows: [] });

    expect(servedRangeReceipt(WS, "src/mixed.ts", SHA, 1, 40, 200)).toBeDefined();
    expect(servedRangeReceipt(WS, "src/mixed.ts", SHA, 41, 80, 200)).toBeUndefined();
  });

  it("absolute/relative path spellings still corroborate each other", () => {
    recordServedRange(WS, `${WS}/src/abs.ts`, SHA, 1, 40, 200, { mode: "slice", range: "1-40", call: 1 });
    settleServedRanges(WS, {
      unattributed: false,
      windows: [{ path: "src/abs.ts", start: 1, end: 40 }],
    });
    expect(servedRangeReceipt(WS, `${WS}/src/abs.ts`, SHA, 1, 40, 200)).toBeDefined();
  });
});
