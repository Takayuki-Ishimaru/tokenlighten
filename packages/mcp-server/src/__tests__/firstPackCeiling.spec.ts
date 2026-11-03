// firstPackCeiling.spec.ts — TL_FIRST_PACK_MAX_BYTES (2026-11-03, external billing
// analysis), server.ts `taskPackByteCeiling`.
//
// THE RULE UNDER TEST. Off by default (measured: a smaller first pack only split
// sessions). When set, a task's FIRST pack on a token-billed client (Claude Code,
// Codex) is bound to the smaller ceiling, never below the 6,144 B pack-admission
// floor; a continuation (task.handle, explicit targets) keeps the client's response
// ceiling, and every other client is untouched.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool, handleRequest, resetCapturedClientIdForTest } from "../server.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import { firstPackMaxBytes } from "../util/flags.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";

type Body = Record<string, unknown>;
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const ENV_KEYS = ["TL_FIRST_PACK_MAX_BYTES", "MAX_MCP_OUTPUT_TOKENS", "TOKENLIGHTEN_CLIENT_ID", "TOKENLIGHTEN_TASK_PACK_MAX_BYTES"] as const;
const tmpDirs: string[] = [];
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
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetCapturedClientIdForTest();
  resetAllSessions();
});

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** One class whose 40 methods give a pack bodies to shed. */
function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(shortTmpDir(HOME, `.tl-firstpack-${tag}-`));
  tmpDirs.push(root);
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
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "orderService.ts"), lines.join("\n"), "utf8");
  return root;
}

async function handshake(clientName: string): Promise<void> {
  await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: clientName, version: "1.0.0" } } });
}

async function read(args: Record<string, unknown>): Promise<{ body: Body; bytes: number }> {
  const result = await callTool("tl_read_file", args);
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  return { body: JSON.parse(text) as Body, bytes: Buffer.byteLength(text, "utf8") };
}

const QUESTION = "explain how OrderService in src/orderService.ts runs the checkout flow step by step";

describe("TL_FIRST_PACK_MAX_BYTES", () => {
  it("is off by default; a digit string sets it; anything else is the default", () => {
    expect(firstPackMaxBytes()).toBe(0);
    process.env["TL_FIRST_PACK_MAX_BYTES"] = "8192";
    expect(firstPackMaxBytes()).toBe(8192);
    for (const garbage of ["", " ", "abc", "-5", "1e3"]) {
      process.env["TL_FIRST_PACK_MAX_BYTES"] = garbage;
      expect(firstPackMaxBytes(), garbage).toBe(0);
    }
  });

  it("binds Claude Code's first pack, never below the admission floor, and leaves the default pack alone", async () => {
    await handshake("claude-code");
    const unset = await read({ cwd: mkWorkspace("unset"), query: QUESTION, task: { epoch: "new" } });
    expect(unset.body["kind"]).toBe("read.task_pack");
    expect(unset.bytes).toBeGreaterThan(7000);

    resetAllSessions();
    process.env["TL_FIRST_PACK_MAX_BYTES"] = "1000"; // below the floor: clamped up to 6,144 B
    const ws = mkWorkspace("bound");
    const first = await read({ cwd: ws, query: QUESTION, task: { epoch: "new" } });
    expect(first.body["kind"], JSON.stringify(first.body).slice(0, 300)).toBe("read.task_pack");
    expect(first.bytes).toBeLessThanOrEqual(6144);
    expect(first.bytes).toBeLessThan(unset.bytes);

    // A continuation on the same task (its handle plus the file it now names) keeps the client ceiling.
    const taskId = String((first.body["task"] as Body)["id"]);
    const continued = await read({ cwd: ws, query: QUESTION, targets: [{ path: "src/orderService.ts" }], task: { handle: taskId } });
    expect(continued.body["kind"], JSON.stringify(continued.body).slice(0, 300)).not.toBe("refusal");
    expect(continued.bytes).toBeGreaterThan(6144);
  }, 120_000);

  it("leaves a client that is not token-billed alone", async () => {
    await handshake("Visual Studio Code");
    const baseline = await read({ cwd: mkWorkspace("vscode-unset"), query: QUESTION, task: { epoch: "new" } });
    resetAllSessions();
    resetCapturedClientIdForTest();
    await handshake("Visual Studio Code");
    process.env["TL_FIRST_PACK_MAX_BYTES"] = "6144";
    const withKnob = await read({ cwd: mkWorkspace("vscode-set"), query: QUESTION, task: { epoch: "new" } });
    expect(withKnob.bytes).toBe(baseline.bytes);
  }, 120_000);
});
