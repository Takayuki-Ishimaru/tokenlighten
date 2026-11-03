// claudeCodeLowOutputTokens.spec.ts — 2026-11-03 (v0.16.4 field evaluation):
// MAX_MCP_OUTPUT_TOKENS=5000 made the server refuse every `tl_read_file` question
// from Claude Code.
//
// THE DEFECT. protocol/codec/clientProfile.ts's `claudeCodeProfile()` set
// `responseByteCeiling = min(45056, floor(tokens * 1.2))`, so 5000 tokens gave 6000 B.
// server.ts's `taskPackAdmission` hands that ceiling to `admitTaskPackBudget`
// (features/task-pack/readCodeTaskPack.ts) as the call's own `maxBytes`, and that
// admission refuses anything under REQUIRED_MIN_TASK_PACK_BYTES (6144 B) with
// `budget-below-minimum` / `required_min_bytes: 6144` before a pack is built. The caller
// declared no budget, so no retry could raise it: every query-bearing read was refused,
// at 5000 tokens and at any value under 5120 (5120 x 1.2 = 6144). A value of 1 gave a
// 1 B ceiling, which also made every page and every find a `cap-exceeded` refusal.
//
// THE RULE UNDER TEST. A low host cap degrades into a smaller answer, never a refusal
// of everything: the Claude Code ceiling is never below CLAUDE_CODE_MIN_REPLY_BYTES (the
// pack admission floor), whatever MAX_MCP_OUTPUT_TOKENS says, and a value of 5120 or more
// (and the default) is byte for byte what it was.
//
// WHAT IS NOT PROMISED. A content-dependent floor above 6144 B (a docx's first page, a
// broad find's inventory of a hundred files) is still the bounded, terminal `cap-exceeded`
// every ceiling-bearing client gets today (readReplyCeiling.spec.ts); this spec pins only
// that the ceiling itself is never the thing that refuses an ordinary question.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  callTool,
  handleRequest,
  resetCapturedClientIdForTest,
} from "../server.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import {
  CLAUDE_CODE_MIN_REPLY_BYTES,
  resolveClientProfile,
  resolveReadReplyCeiling,
} from "../protocol/codec/clientProfile.js";
import { READ_BATCH_TASK_PACK_PROMOTION_FLOOR_BYTES } from "../protocol/emit.js";
import { admitTaskPackBudget, REQUIRED_MIN_TASK_PACK_BYTES } from "../features/task-pack/readCodeTaskPack.js";
import { killServerGroup } from "./helpers/killServerGroup.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { TSX_NODE_ARGS } from "./helpers/tsxNode.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_TS = path.resolve(HERE, "..", "bin.ts");
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ChildProcess[] = [];
const CASE_TIMEOUT_MS = 120_000;

type Body = Record<string, unknown>;

const ENV_KEYS = ["MAX_MCP_OUTPUT_TOKENS", "TOKENLIGHTEN_CLIENT_ID", "TOKENLIGHTEN_TASK_PACK_MAX_BYTES"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetCapturedClientIdForTest();
  resetAllSessions();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const child of servers.splice(0)) killServerGroup(child);
  resetCapturedClientIdForTest();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  resetAllSessions();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// Fixture: a small TypeScript service, plus a handful of files that share one token
// ---------------------------------------------------------------------------

function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(shortTmpDir(HOME, `.tl-lowtok-${tag}-`));
  tmpDirs.push(root);
  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  };
  write("src/retry.ts", [
    "export const TRANSIENT_CODES = [408, 429, 500, 502, 503, 504];",
    "export function shouldRetry(status: number, attempt: number): boolean {",
    "  if (attempt >= 3) return false;",
    "  return TRANSIENT_CODES.includes(status);",
    "}",
    "export function backoff(attempt: number): number { return 100 * 2 ** attempt; }",
    "",
  ].join("\n"));
  write("src/client.ts", [
    "import { shouldRetry, backoff } from './retry';",
    "export async function send(url: string): Promise<number> {",
    "  let attempt = 0;",
    "  for (;;) {",
    "    const status = 200 + attempt;",
    "    if (!shouldRetry(status, attempt)) return status;",
    "    await new Promise((r) => setTimeout(r, backoff(attempt)));",
    "    attempt += 1;",
    "  }",
    "}",
    "",
  ].join("\n"));
  // Six files that each mention the token a few times: a find over it is a few KB, more than a 1 KB ceiling holds.
  for (let index = 0; index < 6; index += 1) {
    write(`src/handlers/handler${index}.ts`, [
      `import { TRANSIENT_CODES } from '../retry';`,
      `export function handle${index}(status: number): string {`,
      `  // handler ${index} classifies a status against TRANSIENT_CODES before it decides`,
      `  if (TRANSIENT_CODES.includes(status)) return "retry-${index}";`,
      `  const known = TRANSIENT_CODES.length > ${index};`,
      `  return known ? "known-${index}" : "unknown-${index}";`,
      `}`,
      "",
    ].join("\n"));
  }
  return root;
}

/** A module whose only anchor is wide enough that a pack over it has bodies to shed: 40 functions of ~7 lines each. */
function mkWideWorkspace(tag: string): string {
  const root = mkWorkspace(tag);
  const lines: string[] = ["export class OrderService {"];
  for (let index = 0; index < 40; index += 1) {
    lines.push(
      `  /** Step ${index} of the checkout flow: validates the cart and reserves stock. */`,
      `  step${index}(cart: { id: string; items: number[] }, flag: boolean): number {`,
      `    const base = cart.items.reduce((sum, value) => sum + value, ${index});`,
      `    if (flag) { return base + ${index * 3}; }`,
      `    return base - ${index};`,
      `  }`,
      "",
    );
  }
  lines.push("}", "");
  fs.writeFileSync(path.join(root, "src", "orderService.ts"), lines.join("\n"), "utf8");
  return root;
}

// ---------------------------------------------------------------------------
// Driving the real dispatcher
// ---------------------------------------------------------------------------

/** The real handshake: this is how a client's name reaches the profile lookup. */
async function handshake(clientName: string): Promise<void> {
  await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: clientName, version: "1.0.0" } },
  });
}

async function call(tool: "tl_read_file" | "tl_search_files", args: Record<string, unknown>): Promise<{ body: Body; bytes: number }> {
  const result = await callTool(tool, args);
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  return { body: JSON.parse(text) as Body, bytes: Buffer.byteLength(text, "utf8") };
}

const QUESTION = "explain how shouldRetry in src/retry.ts decides whether to retry, including the values in TRANSIENT_CODES";

/** What a refusal looks like, for the failure message of a case that expected an answer. */
function describeReply(reply: { body: Body; bytes: number }): string {
  return `${reply.bytes} B ${JSON.stringify(reply.body).slice(0, 300)}`;
}

function evidenceBodies(body: Body): string[] {
  const evidence = Array.isArray(body["evidence"]) ? (body["evidence"] as Body[]) : [];
  return evidence.map((row) => row["body"]).filter((text): text is string => typeof text === "string");
}

// ---------------------------------------------------------------------------
// The ceiling, on its own
// ---------------------------------------------------------------------------

describe("the Claude Code reply ceiling is never below the smallest reply the machinery accepts", () => {
  it("CLAUDE_CODE_MIN_REPLY_BYTES is the task-pack admission floor and the read.batch promotion floor", () => {
    expect(CLAUDE_CODE_MIN_REPLY_BYTES).toBe(REQUIRED_MIN_TASK_PACK_BYTES);
    expect(CLAUDE_CODE_MIN_REPLY_BYTES).toBe(READ_BATCH_TASK_PACK_PROMOTION_FLOOR_BYTES);
    expect(CLAUDE_CODE_MIN_REPLY_BYTES).toBe(6144);
  });

  it("the smallest cap the pack admission accepts is 6144 B: 6143 is refused, 6144 is not", () => {
    expect(admitTaskPackBudget({ maxBytes: 6143 })).toMatchObject({ code: "budget-below-minimum", required_min_bytes: 6144 });
    expect(admitTaskPackBudget({ maxBytes: 6144 })).toBeUndefined();
    expect(admitTaskPackBudget({ maxBytes: 1 })).toMatchObject({ code: "budget-below-minimum", required_min_bytes: 6144 });
  });

  // [MAX_MCP_OUTPUT_TOKENS, expected ceiling in bytes]
  const CEILINGS: ReadonlyArray<readonly [string | undefined, number]> = [
    ["1", 6144],
    ["1000", 6144],
    ["4000", 6144],
    ["5000", 6144], // the field evaluation: 5000 x 1.2 = 6000 B, under the floor
    ["5119", 6144], // floor(5119 x 1.2) = 6142
    ["5120", 6144], // 5120 x 1.2 = 6144 exactly: the first value the plain rule already serves
    ["5121", 6145],
    ["8000", 9600],
    ["10000", 12000],
    ["25000", 30000],
    ["37546", 45055],
    ["37547", 45056], // the 50,000-character host limit's cap, CLAUDE_CODE_MAX_REPLY_BYTES
    ["100000", 45056],
    [" 5000 ", 6144], // surrounding whitespace is trimmed, as before
    [undefined, 30000], // unset = the host default of 25,000 tokens
  ];

  it.each(CEILINGS)("MAX_MCP_OUTPUT_TOKENS=%s gives a %i B ceiling", (tokens, expected) => {
    if (tokens !== undefined) process.env["MAX_MCP_OUTPUT_TOKENS"] = tokens;
    expect(resolveClientProfile("claude-code").responseByteCeiling).toBe(expected);
    expect(resolveReadReplyCeiling("claude-code", undefined)).toBe(expected);
    // ...and whatever it is, the pack admission takes it as the call's own maxBytes.
    expect(admitTaskPackBudget({ maxBytes: expected })).toBeUndefined();
  });

  it.each(["abc", "0", "-5", "", "   ", "1e3", "5000.5", "0x1388", "+5000", "NaN", "Infinity", "99999999999999999999"])(
    "MAX_MCP_OUTPUT_TOKENS=%j is not a token count: the default 30000 B ceiling stays",
    (garbage) => {
      process.env["MAX_MCP_OUTPUT_TOKENS"] = garbage;
      expect(resolveClientProfile("claude-code").responseByteCeiling).toBe(30000);
    },
  );

  it("no other client's ceiling moved", () => {
    process.env["MAX_MCP_OUTPUT_TOKENS"] = "1";
    expect(resolveClientProfile("copilot-cli").responseByteCeiling).toBe(18 * 1024);
    expect(resolveClientProfile("Visual Studio Code").responseByteCeiling).toBe(14336);
    expect(resolveClientProfile("codex-mcp-client").responseByteCeiling).toBeUndefined();
    expect(resolveClientProfile(undefined).responseByteCeiling).toBeUndefined();
  });

  it("TOKENLIGHTEN_TASK_PACK_MAX_BYTES still lowers the ceiling, and a larger one or 0 still cannot lift it", () => {
    process.env["MAX_MCP_OUTPUT_TOKENS"] = "5000";
    expect(resolveReadReplyCeiling("claude-code", "8192")).toBe(6144);
    expect(resolveReadReplyCeiling("claude-code", "0")).toBe(6144);
    expect(resolveReadReplyCeiling("claude-code", "6144")).toBe(6144);
    // an explicit pack preference below the floor is the caller's own to raise: it is not rewritten.
    expect(resolveReadReplyCeiling("claude-code", "4096")).toBe(4096);
  });
});

// ---------------------------------------------------------------------------
// End to end: the exact field shape
// ---------------------------------------------------------------------------

describe("Claude Code with a low MAX_MCP_OUTPUT_TOKENS answers, smaller, instead of refusing", () => {
  // 1 and 1000 are far below any real cap; 5000 is the field evaluation; 5119 is the last value
  // the floor lifts; 8000 sits above it and was never refused.
  const TOKEN_VALUES = ["1", "1000", "5000", "5119", "8000"] as const;

  it.each(TOKEN_VALUES)("MAX_MCP_OUTPUT_TOKENS=%s: an ordinary tl_read_file question is answered with a task pack, not budget-below-minimum", async (tokens) => {
    process.env["MAX_MCP_OUTPUT_TOKENS"] = tokens;
    await handshake("claude-code");
    const ws = mkWorkspace(`read-${tokens}`);
    const ceiling = resolveReadReplyCeiling("claude-code", undefined)!;

    const reply = await call("tl_read_file", { cwd: ws, query: QUESTION, task: { epoch: "new" } });

    expect(reply.body["kind"], describeReply(reply)).toBe("read.task_pack");
    expect(reply.body["code"], describeReply(reply)).toBeUndefined();
    expect(reply.bytes, describeReply(reply)).toBeLessThanOrEqual(ceiling);
    // an answer, not an empty envelope: the function asked about is in it.
    expect(evidenceBodies(reply.body).join("\n"), describeReply(reply)).toContain("shouldRetry");
    expect(typeof (reply.body["decision"] as Body | undefined)?.["kind"]).toBe("string");
  }, CASE_TIMEOUT_MS);

  it.each(TOKEN_VALUES)("MAX_MCP_OUTPUT_TOKENS=%s: a tl_search_files find is answered inside the ceiling, not refused", async (tokens) => {
    process.env["MAX_MCP_OUTPUT_TOKENS"] = tokens;
    await handshake("claude-code");
    const ws = mkWorkspace(`find-${tokens}`);
    const ceiling = resolveReadReplyCeiling("claude-code", undefined)!;

    const reply = await call("tl_search_files", { cwd: ws, action: "find", queries: ["TRANSIENT_CODES"] });

    expect(reply.body["kind"], describeReply(reply)).toBe("search.matches");
    expect(reply.body["code"], describeReply(reply)).toBeUndefined();
    expect(reply.bytes, describeReply(reply)).toBeLessThanOrEqual(ceiling);
    const matches = reply.body["matches"] as Body;
    expect(matches["total_files"], describeReply(reply)).toBe(7);
    expect(Array.isArray(matches["files"]) && (matches["files"] as unknown[]).length > 0, describeReply(reply)).toBe(true);
  }, CASE_TIMEOUT_MS);

  it("the client named by TOKENLIGHTEN_CLIENT_ID=claude-code (no handshake) gets the same: a 5000-token cap answers a question and a find", async () => {
    process.env["MAX_MCP_OUTPUT_TOKENS"] = "5000";
    process.env["TOKENLIGHTEN_CLIENT_ID"] = "claude-code";
    const ws = mkWorkspace("envid");

    const read = await call("tl_read_file", { cwd: ws, query: QUESTION, task: { epoch: "new" } });
    expect(read.body["kind"], describeReply(read)).toBe("read.task_pack");
    expect(read.bytes, describeReply(read)).toBeLessThanOrEqual(6144);

    const find = await call("tl_search_files", { cwd: ws, action: "find", queries: ["TRANSIENT_CODES"] });
    expect(find.body["kind"], describeReply(find)).toBe("search.matches");
    expect(find.bytes, describeReply(find)).toBeLessThanOrEqual(6144);
  }, CASE_TIMEOUT_MS);

  it("a wide module under a 5000-token cap is a smaller pack inside the floor, not a refusal; the default pack is unchanged and larger", async () => {
    process.env["MAX_MCP_OUTPUT_TOKENS"] = "5000";
    await handshake("claude-code");
    const wideQuestion = "explain how OrderService in src/orderService.ts runs the checkout flow step by step";
    const ws = mkWideWorkspace("wide-low");
    const low = await call("tl_read_file", { cwd: ws, query: wideQuestion, task: { epoch: "new" } });
    expect(low.body["kind"], describeReply(low)).toBe("read.task_pack");
    expect(low.bytes, describeReply(low)).toBeLessThanOrEqual(6144);
    expect(evidenceBodies(low.body).length, describeReply(low)).toBeGreaterThan(0);
    // The existing smaller form: a partial pack, what it left out disclosed, and the paging call that owes the rest
    // (decision.next). Following that call keeps handing back answers inside the floor, never a refusal.
    expect((low.body["decision"] as Body)["kind"], describeReply(low)).toBe("discover");
    expect((low.body["limit"] as Body)["cause"], describeReply(low)).toBe("capped");
    let nextCall = (low.body["decision"] as { next?: { arguments?: Body } }).next;
    expect(nextCall?.arguments, describeReply(low)).toBeDefined();
    const served: string[] = evidenceBodies(low.body);
    for (let hop = 0; hop < 3 && nextCall?.arguments !== undefined; hop += 1) {
      const page = await call("tl_read_file", { cwd: ws, ...nextCall.arguments });
      expect(page.body["kind"], describeReply(page)).not.toBe("refusal");
      expect(page.bytes, describeReply(page)).toBeLessThanOrEqual(6144);
      served.push(...evidenceBodies(page.body));
      nextCall = (page.body["decision"] as { next?: { arguments?: Body } } | undefined)?.next;
    }
    expect(served.join("\n")).toContain("step0");

    resetAllSessions();
    delete process.env["MAX_MCP_OUTPUT_TOKENS"];
    const normal = await call("tl_read_file", { cwd: mkWideWorkspace("wide-default"), query: wideQuestion, task: { epoch: "new" } });
    expect(normal.body["kind"], describeReply(normal)).toBe("read.task_pack");
    expect(normal.bytes, describeReply(normal)).toBeLessThanOrEqual(30_000);
    expect(normal.bytes).toBeGreaterThan(low.bytes);
  }, CASE_TIMEOUT_MS);

  it("the line-addressed read of a file larger than the floor is paged inside it", async () => {
    process.env["MAX_MCP_OUTPUT_TOKENS"] = "1";
    await handshake("claude-code");
    const ws = mkWideWorkspace("page");

    const page = await call("tl_read_file", { cwd: ws, targets: [{ path: "src/orderService.ts", range: "1-280" }] });

    expect(page.body["kind"], describeReply(page)).toBe("read.text");
    expect(page.bytes, describeReply(page)).toBeLessThanOrEqual(6144);
    // what did not fit is owed, by a continuation: nothing was refused.
    expect((page.body["limit"] as Body | undefined)?.["next"], describeReply(page)).toBeDefined();
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// The literal field shape: a server process started with the env, spoken to over stdio
// ---------------------------------------------------------------------------

describe("a real server process started with MAX_MCP_OUTPUT_TOKENS=5000 for Claude Code", () => {
  it("answers a tl_read_file question and a tl_search_files find over stdio, as claude-code named by the handshake and by TOKENLIGHTEN_CLIENT_ID", async () => {
    const root = mkWorkspace("stdio");
    // The server inherits nothing of the suite's own TL_*/TOKENLIGHTEN_* knobs: only what the field had.
    const clean = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith("TL_") && !key.startsWith("TOKENLIGHTEN_") && key !== "MAX_MCP_OUTPUT_TOKENS"));

    for (const byEnvId of [false, true]) {
      const env = { ...clean, MAX_MCP_OUTPUT_TOKENS: "5000", ...(byEnvId ? { TOKENLIGHTEN_CLIENT_ID: "claude-code" } : {}) };
      const child = spawn(process.execPath, [...TSX_NODE_ARGS, BIN_TS, root], {
        cwd: root,
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });
      servers.push(child);
      const pending = new Map<number, (message: any) => void>();
      let buffer = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim() === "") continue;
          const message = JSON.parse(line);
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      });
      let id = 0;
      const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
        id += 1;
        pending.set(id, resolve);
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: byEnvId ? "unrecognised-host" : "claude-code", version: "1" } });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

      const read = await rpc("tools/call", { name: "tl_read_file", arguments: { cwd: root, query: QUESTION, task: { epoch: "new" } } });
      const readText = read.result.content[0].text as string;
      const readBody = JSON.parse(readText) as Body;
      const label = `${byEnvId ? "TOKENLIGHTEN_CLIENT_ID" : "handshake"}: ${readText.slice(0, 300)}`;
      expect(readBody["kind"], label).toBe("read.task_pack");
      expect(Buffer.byteLength(readText, "utf8"), label).toBeLessThanOrEqual(6144);

      const find = await rpc("tools/call", { name: "tl_search_files", arguments: { cwd: root, action: "find", queries: ["TRANSIENT_CODES"] } });
      const findText = find.result.content[0].text as string;
      expect(JSON.parse(findText)["kind"], label).toBe("search.matches");
      expect(Buffer.byteLength(findText, "utf8"), label).toBeLessThanOrEqual(6144);
      killServerGroup(child);
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------
// The default, and the garbage that means the default, are what they were
// ---------------------------------------------------------------------------

describe("the default and a garbage MAX_MCP_OUTPUT_TOKENS reply byte for byte as before", () => {
  async function shapeOf(tokens: string | undefined): Promise<{ read: string; find: string }> {
    resetAllSessions();
    resetCapturedClientIdForTest();
    delete process.env["MAX_MCP_OUTPUT_TOKENS"];
    if (tokens !== undefined) process.env["MAX_MCP_OUTPUT_TOKENS"] = tokens;
    await handshake("claude-code");
    const ws = mkWorkspace(`shape-${tokens ?? "unset"}`);
    const read = await call("tl_read_file", { cwd: ws, query: QUESTION, task: { epoch: "new" } });
    const find = await call("tl_search_files", { cwd: ws, action: "find", queries: ["TRANSIENT_CODES"] });
    // handles, task ids, the certificate id and the workspace path differ between runs; their widths do not.
    const normalize = (body: Body): string => JSON.stringify(body)
      .replace(/"cwd":"[^"]*"/g, '"cwd":"-"')
      .replace(/"(h[0-9a-z]{10})"/g, '"h-"')
      .replace(/tlh_task_v1_[A-Za-z0-9_-]+/g, "tlh_task_v1_-")
      .replace(/q-[0-9a-f]{16}/g, "q-")
      .replace(/ready-[0-9a-f]{16}/g, "ready-");
    return { read: `${read.bytes} ${normalize(read.body)}`, find: `${find.bytes} ${normalize(find.body)}` };
  }

  it("unset, and every value that is not a positive integer, reply exactly alike", async () => {
    const unset = await shapeOf(undefined);
    expect(unset.read.length).toBeGreaterThan(200);
    for (const garbage of ["abc", "0", "-5"]) {
      expect(await shapeOf(garbage), `MAX_MCP_OUTPUT_TOKENS=${garbage}`).toEqual(unset);
    }
  }, CASE_TIMEOUT_MS);

  it("25000 tokens, the host default spelled out, replies exactly as unset does", async () => {
    expect(await shapeOf("25000")).toEqual(await shapeOf(undefined));
  }, CASE_TIMEOUT_MS);
});
