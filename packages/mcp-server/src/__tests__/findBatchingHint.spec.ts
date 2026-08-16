// findBatchingHint.spec.ts — one-shot find-batching hint (server-side
// nudge, Fix B, sibling of editBatchingHint.spec.ts's edits[] hint).
//
// Evidence (bench run 2026-07-12c): an agent made 14 SINGLE-TOKEN
// search_files find calls in one session — several trivially batchable into
// ONE queries:[...] call — even though it used queries:[...] successfully
// TWICE earlier in the same session (so it knew the form). This is the
// server-side nudge: attach a bounded `hint` field on the response of the
// 2nd successful single-query find completion, exactly once per session.
//
// L2 (2026-07-30 bench T11 forensics): FIND_HINT_THRESHOLD lowered 4 -> 2 —
// a live A/B cell paid 7 of its 17 TL calls on serial single-token find
// guessing, and by the OLD threshold's 4th call most of that waste had
// already happened. Mirrors BATCH_HINT_THRESHOLD's own "4 fires too late, 2
// catches the pattern while it is still forming" finding (state/session.ts)
// — same rationale, same one-shot mechanism, only the number changed.
//
// Unlike the edits[] hint (BATCH_HINT_TEXT / usedEditsBatch), there is NO
// permanent suppression once queries[] has been used — the live evidence
// above shows demonstrated knowledge of the batch form does not reliably
// stop the wasteful pattern, so recordSingleFindCompletion (util/session.ts)
// has no usedEditsBatch-style flag.
//
// See packages/mcp-server/src/util/session.ts (recordSingleFindCompletion,
// FIND_HINT_THRESHOLD) and server.ts's find dispatch / findText.ts's
// buildFindResponse opts.extraHint bake-into-cap wiring (responseExtra /
// buildWithExtra, mirroring buildFindResponseForQueries' own pattern).

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FIND_HINT_TEXT } from "../server.js";
import { MAX_INVENTORY_RESPONSE_BYTES } from "../tools/findText.js";

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
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-findhint-${tag}-`));
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

function parseFind(rpcResult: any): { text: string; data: Record<string, unknown>; body: Record<string, unknown> } {
  const text: string = rpcResult?.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  const body = JSON.parse(text) as Record<string, unknown>;
  // A.5.8 / Rule K (C2-4): `search.matches` covers find/symbols/locate/diff
  // through an INTERNAL tag, so a find's own fields now live under
  // `matches:{form:"find", …}` instead of at the top level. `data` is that
  // inner object; `body` is the whole envelope (kind/limit/…).
  expect(body["kind"]).toBe("search.matches");
  const matches = body["matches"] as Record<string, unknown>;
  expect(matches?.["form"]).toBe("find");
  return { text, data: matches, body };
}

/**
 * findText.ts's own hard byte cap (MAX_RESPONSE_BYTES) — mirrored here so
 * the ceiling isn't a magic number. Applies to the non-truncated responses
 * in this file (small fixtures whose snippets all fit, so no match
 * inventory is attached — see "snippets may truncate; the inventory never
 * lies" in findText.ts). The one test below whose fixture IS truncated (and
 * therefore carries a complete inventory on top) checks against the larger
 * MAX_INVENTORY_RESPONSE_BYTES instead, imported directly from findText.ts.
 */
const FIND_RESPONSE_CEILING = 4096;

describe("findBatchingHint — fires exactly once on the 2nd successful single-query find", () => {
  it("response 1 carries no hint, response 2 carries it, responses 3-5 do not", async () => {
    const ws = mkDir("fires-once");
    for (let i = 1; i <= 5; i++) {
      writeFile(ws, `src/needle${i}.ts`, `export const NEEDLE_${i} = ${i};\n`);
    }

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    const responses: Array<{ text: string; data: Record<string, unknown> }> = [];
    for (let i = 1; i <= 5; i++) {
      const res = await srv.rpc(i + 1, "tools/call", {
        name: "search_files",
        arguments: { action: "find", query: `NEEDLE_${i}` },
      });
      responses.push(parseFind(res));
    }

    // 1st: no hint yet (counter at 1, below FIND_HINT_THRESHOLD=2).
    expect(responses[0]!.data["hint"]).toBeUndefined();

    // 2nd: the ONE hint-bearing response — echoes FIND_HINT_TEXT exactly,
    // and stays within findText.ts's own response cap.
    const second = responses[1]!;
    expect(second.data["hint"]).toBe(FIND_HINT_TEXT);
    expect(Buffer.byteLength(second.text, "utf8")).toBeLessThanOrEqual(FIND_RESPONSE_CEILING);

    // 3rd-5th: back to no hint — proves the hint is one-shot, not "every
    // find from the 2nd onward".
    for (const r of responses.slice(2)) {
      expect(r.data["hint"]).toBeUndefined();
    }
  }, 30000);
});

describe("findBatchingHint — queries:[...] calls do not increment the counter", () => {
  it("2 queries[] batches + 2 singletons: the hint still fires on the 2nd SINGLE-query call, not sooner", async () => {
    const ws = mkDir("queries-no-increment");
    for (let i = 1; i <= 2; i++) {
      writeFile(ws, `src/solo${i}.ts`, `export const SOLO_${i} = ${i};\n`);
    }
    writeFile(ws, "src/batch.ts", [
      "export const ALPHA = 1;",
      "export const BETA = 2;",
    ].join("\n") + "\n");

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    let id = 2;

    // Two queries[] batch calls FIRST — the agent "knows the form", but per
    // the doc comment above, that must NOT suppress or advance the counter.
    for (let b = 0; b < 2; b++) {
      const res = await srv.rpc(id++, "tools/call", {
        name: "search_files",
        arguments: { action: "find", queries: ["ALPHA", "BETA"] },
      });
      const { data } = parseFind(res);
      expect(data["hint"]).toBeUndefined();
    }

    // 1 single-query call — still no hint (counter at 1).
    const first = await srv.rpc(id++, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "SOLO_1" },
    });
    expect(parseFind(first).data["hint"]).toBeUndefined();

    // 2nd single-query call — the counter was still at 1 (queries[] calls
    // correctly excluded above), so THIS call brings it to 2 and fires.
    const res = await srv.rpc(id++, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "SOLO_2" },
    });
    const { data } = parseFind(res);
    expect(data["hint"]).toBe(FIND_HINT_TEXT);
  }, 30000);
});

describe("findBatchingHint — baked into the cap, not appended after trimming", () => {
  it("the 2nd single-query find, even when fitFilesToCap must trim matches, still carries the hint within the response cap", async () => {
    const ws = mkDir("cap-bake");
    writeFile(ws, "src/warm1.ts", "export const WARM_1 = 1;\n");
    // Enough matching files that the UN-trimmed response would blow well
    // past FIND_RESPONSE_CEILING on its own, forcing fitFilesToCap's
    // footholds-then-widen trimming to actually run for this call.
    for (let i = 0; i < 80; i++) {
      writeFile(
        ws,
        `src/big${i}.ts`,
        `export const BIGNEEDLE_${i} = "padding text to inflate the per-match snippet size for cap-trimming coverage ${i}";\n`,
      );
    }

    const srv = startServer({ cwd: ws, args: [ws] });
    servers.push(srv);
    await srv.initialize();

    let id = 2;
    const warm = await srv.rpc(id++, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "WARM_1" },
    });
    expect(parseFind(warm).data["hint"]).toBeUndefined();

    const second = await srv.rpc(id++, "tools/call", {
      name: "search_files",
      arguments: { action: "find", query: "BIGNEEDLE" },
    });
    const { text, data, body } = parseFind(second);

    // Proves trimming actually happened (the un-trimmed 80-file match set
    // would not fit) AND the hint survived it, baked in rather than
    // appended after — see buildFindResponse's opts.extraHint/
    // responseExtra/buildWithExtra wiring in findText.ts.
    // Rule T (C2-4): the response-level `truncated` boolean folds into `limit`
    // — absence of `limit` IS completeness, so its PRESENCE is the truncation
    // claim, and `limit.next` is the continuation the bare boolean never had.
    const limit = body["limit"] as Record<string, unknown> | undefined;
    expect(limit, JSON.stringify(body).slice(0, 300)).toBeDefined();
    expect(data["truncated"]).toBeUndefined();
    expect(data["hint"]).toBe(FIND_HINT_TEXT);
    // "snippets may truncate; the inventory never lies": this fixture's
    // files[] truncates, so a complete match inventory is attached on top —
    // the whole response is bounded by the larger MAX_INVENTORY_RESPONSE_BYTES,
    // not the tighter snippet-only FIND_RESPONSE_CEILING. The batching hint
    // (asserted above via toBe, an EXACT match) is unaffected: the inventory
    // note is carried in its own separate `note` field, never merged into
    // `hint`, so this one-shot nudge's text is never altered by the
    // inventory feature.
    expect(data["note"]).toBeTruthy();
    expect(Array.isArray(data["inventory"])).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_INVENTORY_RESPONSE_BYTES);
  }, 30000);
});
