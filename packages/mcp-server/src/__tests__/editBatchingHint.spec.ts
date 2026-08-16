// editBatchingHint.spec.ts — one-shot edits[] batching hint (server-side
// nudge).
//
// Evidence (bench run 2026-07-11c): an agent made 21 SINGLETON
// edit_file calls in one session — never once using the edits[] batch form —
// at ~1 billed turn each. Prompt guidance alone ("Batch the TL calls
// themselves too" / the v18 "Batch independent edits" template bullet) does
// not reliably land for every session, so this is the complementary
// server-side nudge: append a bounded `hint` field on the response of a
// successful single-edit completion, exactly once per session, unless the
// session has already demonstrated it knows the edits[] form.
//
// 2026-07-24 (bench task T09 forensics): the hint used to fire on the 4th
// successful single edit — too late in practice. Both observed T09 sessions
// made 5 sequential single-file edit_file calls apiece and never saw (or at
// least never heeded) a hint that landed only after 4 of those 5 calls were
// already spent one-shot. The fire point is now the 2ND successful single
// edit, and the wording is more actionable: it names the multi-FILE +
// per-item-precondition shape of edits[] explicitly and tells the agent to
// batch its remaining known edit sites now, instead of the older generic
// "batch independent edits" phrasing.
//
// See packages/mcp-server/src/util/session.ts (recordSingleEditCompletion,
// recordEditsBatchUsed, BATCH_HINT_THRESHOLD = 2) and server.ts's
// BATCH_HINT_TEXT / finishEdit's hint-firing logic inside the edit_file
// dispatch case.

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BATCH_HINT_TEXT } from "../server.js";

const nodeRequire = createRequire(import.meta.url);
const TSX_CLI = nodeRequire.resolve("tsx/cli");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

interface ServerHandle {
  initialize(): Promise<void>;
  rpc(id: number, method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  kill(): void;
}

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-batchhint-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function startServer(opts: { cwd: string; args: string[] }): ServerHandle {
  const child: ChildProcess = spawn(
    process.execPath,
    [TSX_CLI, BIN_TS, ...opts.args],
    { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
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
      clientInfo: { name: "vitest", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function kill(): void {
    try { child.kill("SIGKILL"); } catch { /* ok */ }
  }

  return { initialize, rpc, kill };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

function parseEdit(rpcResult: any): { text: string; data: Record<string, unknown> } {
  const text: string = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return { text, data: JSON.parse(text) };
}

// Byte ceilings: SINGLE_EDIT_CEILING matches the plain single-edit ceiling
// pinned by writeResponseSize.spec.ts / editHandleAutoMint.spec.ts
// for every response that does NOT carry the hint. HINT_BEARING_CEILING is
// an explicit carve-out for the ONE response that does — not a blanket raise.
// The hint text itself grew from ~105 to ~175 chars (2026-07-24 rewording,
// see BATCH_HINT_TEXT's doc comment in server.ts) to spell out the
// multi-file + per-item-precondition shape of edits[], so the carve-out grew
// with it (measured: a ~100-150B base auto-mint response + the ~175B hint
// field stays comfortably under 400B).
//
// REVIEWED CHANGE (protocol-v1 C2-5, 2026-08-14): 200 -> 400 and 400 -> 600.
// §4.2.1(3) adds a guaranteed-fit `SideEffectCore` — counts + affected paths +
// a workspace marker, ~250 bytes for a one-file edit — that no shedder, budget
// or serializer may cut. These ceilings have to sit above that floor; a budget
// that cannot fit it makes the server MISCONFIGURED (§4.2.1(3)), not the
// response smaller. Measured at the C2-5 commit: 367 plain, 550 hint-bearing,
// and the raise is the SAME +200 on both, so the carve-out is still exactly the
// hint text and not a blanket relaxation. `SINGLE_EDIT_CEILING` deliberately
// equals `writeResponseSize.spec.ts`'s `SINGLE_CORE_CAP` — one number, one
// meaning, as before.
const SINGLE_EDIT_CEILING = 400;
const HINT_BEARING_CEILING = 600;

// 2026-07-26 G1 read-back: `applied[]`/`applied_note` (and a possible
// per-file `verification` manifest) ride edit successes by design — each
// replaces a follow-up read turn. The ceilings above bind the CORE response,
// so strip the separately-capped read-back sections before measuring.
function coreBytes(data: Record<string, unknown>): number {
  const { applied: _a, applied_note: _n, verification: _v, ...core } = data;
  return Buffer.byteLength(JSON.stringify(core), "utf8");
}

describe("editBatchingHint — fires exactly once on the 2nd successful single edit", () => {
  it("response 1 carries no hint, response 2 carries it, responses 3-5 do not", async () => {
    const ws = mkDir("fires-once");
    writeFile(ws, "src/vals.ts", [
      "export const A1 = 1;",
      "export const A2 = 2;",
      "export const A3 = 3;",
      "export const A4 = 4;",
      "export const A5 = 5;",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    const responses: Array<{ text: string; data: Record<string, unknown> }> = [];
    for (let i = 1; i <= 5; i++) {
      const res = await srv.rpc(i + 1, "tools/call", {
        name: "edit_file",
        arguments: { path: "src/vals.ts", search: `A${i} = ${i}`, replace: `A${i} = ${i + 100}` },
      });
      responses.push(parseEdit(res));
    }

    for (const r of responses) expect(r.data["kind"]).not.toBe("refusal");

    // 1st: no hint yet, within the normal single-edit ceiling.
    const first = responses[0]!;
    expect(first.data["hint"]).toBeUndefined();
    expect(coreBytes(first.data)).toBeLessThanOrEqual(SINGLE_EDIT_CEILING);

    // 2nd: the ONE hint-bearing response — exceeds the normal ceiling but
    // stays within the explicit carve-out, and echoes the actionable
    // multi-file/per-precondition wording via the shared BATCH_HINT_TEXT
    // constant.
    const second = responses[1]!;
    expect(second.data["hint"]).toBe(BATCH_HINT_TEXT);
    const secondBytes = coreBytes(second.data);
    expect(secondBytes).toBeGreaterThan(SINGLE_EDIT_CEILING);
    expect(secondBytes).toBeLessThanOrEqual(HINT_BEARING_CEILING);

    // 3rd-5th: back to no hint, back within the normal ceiling — proves the
    // hint is one-shot, not "every edit from the 2nd onward".
    for (const r of responses.slice(2)) {
      expect(r.data["hint"]).toBeUndefined();
      expect(coreBytes(r.data)).toBeLessThanOrEqual(SINGLE_EDIT_CEILING);
    }
  }, 30000);
});

describe("editBatchingHint — prior edits[] batch use suppresses the hint permanently", () => {
  it("a session whose first edit is a batch, followed by 4 singletons, never sees the hint", async () => {
    const ws = mkDir("batch-first");
    writeFile(ws, "src/a.ts", 'export const A = "a-old";\n');
    writeFile(ws, "src/b.ts", 'export const B = "b-old";\n');
    writeFile(ws, "src/vals.ts", [
      "export const V1 = 1;",
      "export const V2 = 2;",
      "export const V3 = 3;",
      "export const V4 = 4;",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    // First call this session: an edits[] batch (2 items) — the agent has
    // now demonstrated it knows the form, per recordEditsBatchUsed.
    const batchRes = await srv.rpc(2, "tools/call", {
      name: "edit_file",
      arguments: {
        edits: [
          { path: "src/a.ts", search: '"a-old"', replace: '"a-new"' },
          { path: "src/b.ts", search: '"b-old"', replace: '"b-new"' },
        ],
      },
    });
    const batchData = parseEdit(batchRes).data;
    expect(batchData["kind"]).not.toBe("refusal");
    expect(batchData["hint"]).toBeUndefined();

    // 4 singleton edits — would normally fire the hint on the 2nd, but
    // suppression is permanent once edits[] has been used this session
    // (crossing well past the fire point proves it stays suppressed, not
    // just delayed).
    for (let i = 1; i <= 4; i++) {
      const res = await srv.rpc(i + 2, "tools/call", {
        name: "edit_file",
        arguments: { path: "src/vals.ts", search: `V${i} = ${i}`, replace: `V${i} = ${i + 100}` },
      });
      const { data } = parseEdit(res);
      expect(data["kind"]).not.toBe("refusal");
      expect(data["hint"]).toBeUndefined();
    }
  }, 30000);
});

describe("editBatchingHint — create=true and failed edits are excluded from the counter", () => {
  it("1 singleton + create=true + a not-found failure + 1 more singleton fires the hint only on the 2nd SUCCESSFUL single edit", async () => {
    const ws = mkDir("excluded-calls");
    writeFile(ws, "src/vals.ts", [
      "export const B1 = 1;",
      "export const B2 = 2;",
      "export const B3 = 3;",
      "export const B4 = 4;",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: ws, args: [ws, "--allow-write"] });
    servers.push(srv);
    await srv.initialize();

    let id = 2;

    // 1 successful singleton edit (counter -> 1).
    const firstRes = await srv.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/vals.ts", search: "B1 = 1", replace: "B1 = 101" },
    });
    const firstData = parseEdit(firstRes).data;
    expect(firstData["kind"]).not.toBe("refusal");
    expect(firstData["hint"]).toBeUndefined();

    // create=true — must NOT increment the counter (excluded by design).
    const createRes = await srv.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/new.ts", content: "export const NEW = 1;\n", create: true, cwd: ws },
    });
    const createData = parseEdit(createRes).data;
    expect(createData["kind"]).not.toBe("refusal");
    expect(createData["hint"]).toBeUndefined();

    // A failed edit (search string absent) — must NOT increment the counter.
    const failRes = await srv.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/vals.ts", search: "DOES_NOT_EXIST_TOKEN_XYZ", replace: "irrelevant" },
    });
    const failData = parseEdit(failRes).data;
    expect(failData["kind"]).toBe("refusal");
    expect(failData["hint"]).toBeUndefined();

    // 2nd SUCCESSFUL singleton edit — the counter was still at 1 (create and
    // the failure were correctly excluded above), so THIS call brings it to
    // 2 and fires the hint, staying within the carved-out byte ceiling.
    const secondRes = await srv.rpc(id++, "tools/call", {
      name: "edit_file",
      arguments: { path: "src/vals.ts", search: "B4 = 4", replace: "B4 = 400" },
    });
    const { data: secondData } = parseEdit(secondRes);
    expect(secondData["kind"]).not.toBe("refusal");
    expect(secondData["hint"]).toBe(BATCH_HINT_TEXT);
    expect(coreBytes(secondData)).toBeLessThanOrEqual(HINT_BEARING_CEILING);
  }, 30000);
});
