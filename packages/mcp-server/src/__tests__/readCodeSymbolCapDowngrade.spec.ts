/**
 * readCodeSymbolCapDowngrade.spec.ts — FIX C (2026-07-12c forensics).
 *
 * Live failure: `read_file mode=symbol symbol=place` on QuoteOrchestrator.java
 * refused `{ok:false,"error":"cap-exceeded",bytes:8378,maxBytes:8192,...}` for
 * being 2.3% over READ_SYMBOL_CAP_BYTES, forcing the agent to immediately
 * re-fetch the same content via mode=slice (which succeeded) — a pure-loss
 * turn.
 *
 * Fix: the cap-exceeded refusal is now a SERVED downgrade (mirroring
 * mode=full's downgraded_from:"full" precedent): ok:true, the symbol's
 * content TRIMMED to fit maxBytes (head of the body), downgraded_from:
 * "symbol", reason:"symbol-cap-reached", and a `next` hint pointing at
 * mode=slice over the symbol's full line range so the caller can fetch the
 * remainder deliberately. The response stays within maxBytes INCLUDING the
 * added envelope fields (bake-into-cap — nothing is spliced on after
 * measuring). A hard refusal is kept only for the pathological case where
 * even a trimmed serve cannot fit (not exercised live; READ_SYMBOL_CAP_BYTES
 * is 24576B as of 2026-07-16a (was 8192B) and a path+symbol name would need
 * to be enormous to trigger it).
 *
 * Covers:
 *   (d1) symbol-over-cap serves downgraded_from:"symbol" within cap, with a
 *        working next hint (mode=slice over the full range).
 *   (d2) symbol-under-cap: unchanged plain success (no downgrade fields).
 *   (d3) the served content is a real PREFIX of the true (elided) symbol
 *        body, cut on a line boundary.
 *   (d4) the downgrade's own handle is usable for a follow-up mode=slice
 *        read that returns the SAME range the `next` hint names.
 *
 * Harness copied from readCodeCaps.spec.ts / argMatrix.spec.ts's pattern.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
}

function mkDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(HOME, `.tl-symbolcapdowngrade-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

let idCounter = 1;

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
      clientInfo: { name: "vitest-symbolcapdowngrade", version: "0" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await rpc(++idCounter, "tools/call", { name, arguments: args });
    const text = res?.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");
    return JSON.parse(text);
  }

  function kill(): void {
    try { child.kill("SIGKILL"); } catch { /* ok */ }
  }

  return { initialize, rpc, call, kill };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.kill();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

async function newServer(tag: string): Promise<{ ws: string; srv: ServerHandle }> {
  const ws = mkDir(tag);
  const srv = startServer({ cwd: ws, args: [ws] });
  servers.push(srv);
  await srv.initialize();
  return { ws, srv };
}

const READ_SYMBOL_CAP_BYTES = 24576; // 2026-07-16a: raised from 8192

/** A symbol body clearly over READ_SYMBOL_CAP_BYTES (2.3%-over-cap shape:
 * a single dominating method, not the whole class). */
function makeOverCapFileContent(): { content: string; symbol: string } {
  const bodyLines: string[] = [];
  for (let i = 0; i < 400; i++) {
    bodyLines.push(`    const padding${i} = "a fairly long line of filler text to inflate the method body ${i}";`);
  }
  const content = [
    "export function bigSymbolForCapTest(): void {",
    ...bodyLines,
    "  return;",
    "}",
  ].join("\n") + "\n";
  return { content, symbol: "bigSymbolForCapTest" };
}

describe("readCodeSymbolCapDowngrade — mode=symbol cap-exceeded now downgrades instead of refusing", () => {
  it("(d1) symbol-over-cap serves ok:true with downgraded_from:\"symbol\", reason, and a next hint — no isError", async () => {
    const { ws, srv } = await newServer("over-cap-basic");
    const { content, symbol } = makeOverCapFileContent();
    writeFile(ws, "big.ts", content);
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(READ_SYMBOL_CAP_BYTES);

    const res = await srv.rpc(2, "tools/call", {
      name: "read_file",
      arguments: { mode: "symbol", path: "big.ts", symbol },
    });

    // Served, not refused: no MCP-transport isError.
    expect(res?.result?.isError).not.toBe(true);
    const text = res?.result?.content?.[0]?.text as string;
    const data = JSON.parse(text);

    // v1 (A.5.2 + Rule T), re-pointed 2026-08-14 on the census wave's OWN
    // precedent for this class in readCodeCaps.spec.ts and
    // readCodeFullDowngrade.spec.ts: a cap downgrade is still a SERVE, so the
    // member is `read.text` and the trimmed head is `evidence[0].body`; the
    // `downgraded_from`/`reason`/`truncated`/`bytes`/`maxBytes` dialect
    // collapses into `limit`, whose presence alone signals a bounded serve; and
    // the remainder rides a structured `limit.next` ToolCall instead of prose.
    expect(data["kind"]).toBe("read.text");
    const evidence = (data["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(evidence["path"]).toBe("big.ts");
    expect(String(evidence["handle"])).toMatch(/^h[0-9a-z]+$/);
    expect(typeof data["sha"]).toBe("string");
    // The served bytes ARE the symbol's own body — this is the whole point of
    // the downgrade (a cap that serves nothing is the pure-loss turn it
    // replaced), and the body naming the symbol is what makes it that symbol's.
    expect(typeof evidence["body"]).toBe("string");
    expect(String(evidence["body"]).length).toBeGreaterThan(0);
    expect(String(evidence["body"])).toContain(symbol);

    const limit = data["limit"] as Record<string, unknown>;
    expect(limit, "a trimmed serve must declare that it withheld something").toBeDefined();

    // The continuation is a mode=slice over the SAME handle, starting strictly
    // after the exact source lines served, so it never replays the head.
    const next = limit["next"] as Record<string, unknown>;
    expect(next["tool"]).toBe("read_file");
    const nextArgs = next["arguments"] as Record<string, unknown>;
    expect(nextArgs["mode"]).toBe("slice");
    expect(nextArgs["handle"]).toBe(evidence["handle"]);
    expect(String(evidence["range"])).toMatch(/^\d+-\d+$/);
    const servedBounds = String(evidence["range"]).split("-").map(Number);
    const nextBounds = String(nextArgs["range"]).match(/^(\d+)-(\d+)$/)!.slice(1).map(Number);
    expect(nextBounds[0]).toBe(servedBounds[1]! + 1);

    // Bake-into-cap: the FULL served JSON payload (this exact text) must
    // itself fit within maxBytes — not just the `code` field in isolation.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(READ_SYMBOL_CAP_BYTES);
  }, 30000);

  it("(d2) symbol-under-cap: unchanged plain success, no downgrade fields", async () => {
    const { ws, srv } = await newServer("under-cap-unchanged");
    writeFile(ws, "small.ts", "export function tiny(): number {\n  return 1;\n}\n");

    const res = await srv.call("read_file", { mode: "symbol", path: "small.ts", symbol: "tiny" });

    // Rule T: absence of `limit` IS completeness — the v1 successor of
    // "no downgrade fields".
    expect(res["kind"]).toBe("read.text");
    expect(res["limit"]).toBeUndefined();
    const underCap = (res["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(typeof underCap["body"]).toBe("string");
    expect(String(underCap["body"])).toContain("tiny");
    expect(String(underCap["handle"])).toMatch(/^h[0-9a-z]+$/);
  }, 30000);

  it("(d3) the served (trimmed) code is a clean line-boundary prefix of the real body — starts at the top, stops short of the end, never cuts mid-line", async () => {
    const { ws, srv } = await newServer("over-cap-prefix");
    const { content, symbol } = makeOverCapFileContent();
    writeFile(ws, "big2.ts", content);

    const res = await srv.call("read_file", { mode: "symbol", path: "big2.ts", symbol });
    // Rule T: the trimmed serve declares itself through `limit`; the bytes are
    // `evidence[0].body` (see d1's note on the re-point).
    expect(res["limit"]).toBeDefined();
    const served = String((res["evidence"] as Array<Record<string, unknown>>)[0]!["body"]);

    // Starts from the real body (a HEAD prefix, not some unrelated slice).
    expect(served).toContain('const padding0 = "a fairly long line');
    // Cut well short of the end — a genuine truncation, not the whole body
    // (elision does not touch these plain statements, so nothing here
    // shrinks the body other than the cap trim itself).
    expect(served).not.toContain("padding399");
    expect(served).not.toContain("return;");

    // No mid-line byte cut: every "padding" body line the served text
    // contains is BYTE-IDENTICAL to that same line in the real source file
    // (elision leaves plain statements untouched, so a clean line-boundary
    // trim is the only way this holds for every such line).
    const sourceLines = new Set(content.split("\n"));
    const paddingLinesServed = served.split("\n").filter((l) => l.includes("padding"));
    expect(paddingLinesServed.length).toBeGreaterThan(0);
    for (const line of paddingLinesServed) {
      expect(sourceLines.has(line)).toBe(true);
    }
  }, 30000);

  it("(d4) the downgrade's handle + next hint's range fetches the remainder via mode=slice (which truncates-and-continues, never refuses)", async () => {
    const { ws, srv } = await newServer("over-cap-next-works");
    const { content, symbol } = makeOverCapFileContent();
    writeFile(ws, "big3.ts", content);

    const res = await srv.call("read_file", { mode: "symbol", path: "big3.ts", symbol });
    const limit = res["limit"] as Record<string, unknown>;
    expect(limit).toBeDefined();
    const downgradeEvidence = (res["evidence"] as Array<Record<string, unknown>>)[0]!;
    // The continuation is a structured ToolCall now (§2.1.2 F5), so it is
    // EXECUTED verbatim rather than scraped out of prose.
    const nextArgs = (limit["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    const range = String(nextArgs["range"]);
    expect(range).toMatch(/^\d+-\d+$/);

    const sliceRes = await srv.call("read_file", {
      mode: "slice", handle: nextArgs["handle"], range,
    });
    // resolveSlice's RANGE branch never refuses on cap — it serves a
    // (possibly further truncated) slice with its own continuation.
    expect(sliceRes["kind"]).toBe("read.text");
    const sliceEvidence = (sliceRes["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(sliceEvidence["range"]).toBe(range);
    expect(typeof sliceEvidence["body"]).toBe("string");
    expect(String(sliceEvidence["body"]).length).toBeGreaterThan(0);

    const servedPadding = new Set(
      String(downgradeEvidence["body"]).split("\n").filter((line) => line.includes("padding")),
    );
    const continuationPadding = String(sliceEvidence["body"])
      .split("\n")
      .filter((line) => line.includes("padding"));
    expect(continuationPadding.length).toBeGreaterThan(0);
    expect(continuationPadding.every((line) => !servedPadding.has(line))).toBe(true);
  }, 30000);

  it("(d5) sanity: mode=auto with an explicit symbol arg on an over-cap symbol also downgrades (shares the same dispatch branch)", async () => {
    const { ws, srv } = await newServer("over-cap-auto-symbol");
    const { content, symbol } = makeOverCapFileContent();
    writeFile(ws, "big4.ts", content);

    const res = await srv.call("read_file", { mode: "auto", path: "big4.ts", symbol });
    // Same branch, same v1 shape: a bounded serve of the symbol's head, with
    // the cap's own dialect collapsed into `limit` + a mode=slice remainder.
    expect(res["kind"]).toBe("read.text");
    const autoLimit = res["limit"] as Record<string, unknown>;
    expect(autoLimit).toBeDefined();
    const autoNextArgs = (autoLimit["next"] as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    expect(autoNextArgs["mode"]).toBe("slice");
    const autoEvidence = (res["evidence"] as Array<Record<string, unknown>>)[0]!;
    expect(String(autoEvidence["body"])).toContain(symbol);
  }, 30000);
});
