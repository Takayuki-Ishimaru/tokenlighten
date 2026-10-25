// epochRepeatAdvisoryReply.spec.ts — the epoch-repeat advisory on the reply of
// the call that earned it (2026-10-20, decision run 6t-8, T13 rep2 arm A).
//
// After its first pack that cell sent all 25 later TokenLighten calls with
// `task:"{\"epoch\":\"new\"}"` and no query: targets-only reads and finds.
// None was advised. The session armed the advisory only for a repeated
// epoch:"new" read with a query AND targets (§20.15), and only a task pack
// carried it (`advisory`), so a single-target read.text or a find could not.
// Now a targets-only read earns it too, and a search its own form, once the
// request has handed out a task handle (the continuation the advisory
// names), and the funnel tail hands it to the call's own `hint` (read.text;
// `matches.hint` for a find). The epoch boundary is unchanged.
// executionTypestate.spec.ts holds the session rules; replayCorpus.spec.ts's
// v016ep group replays the cell's verbatim calls.
//
// Harness idiom: in-process `callTool`, as serialSingleTargetHint.spec.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { callTool } from "../server.js";
import {
  EPOCH_REPEAT_ADVISORY,
  EPOCH_REPEAT_SEARCH_ADVISORY,
  resetAll,
  takePreparedHandleAdvisory,
} from "../state/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const dirs: string[] = [];

/** The task string the 6t-8 cell sent on every call after its first, verbatim. */
const EPOCH_NEW = "{\"epoch\":\"new\"}";

type Body = Record<string, unknown>;

function mkWs(tag: string): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-epochrepeat-${tag}-`)));
  dirs.push(d);
  write(d, "src/order.ts", [
    "import { taxOf } from \"./tax\";",
    "",
    "export function priceOrder(subtotal: number, region: string): number {",
    "  return subtotal + taxOf(subtotal, region);",
    "}",
    "",
  ].join("\n"));
  write(d, "src/tax.ts", [
    "export function taxOf(subtotal: number, region: string): number {",
    "  return region === \"eu\" ? subtotal * 0.2 : subtotal * 0.1;",
    "}",
    "",
  ].join("\n"));
  return d;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function call(tool: string, args: Body): Promise<Body> {
  const res = await callTool(tool, args) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]?.text ?? "{}") as Body;
}

/** The exported texts, asserted present so that no pin below can pass against `undefined`. */
function advisories(): { read: string; search: string } {
  for (const [name, value] of [
    ["EPOCH_REPEAT_ADVISORY", EPOCH_REPEAT_ADVISORY],
    ["EPOCH_REPEAT_SEARCH_ADVISORY", EPOCH_REPEAT_SEARCH_ADVISORY],
  ] as const) {
    expect(typeof value, `${name} must be exported text`).toBe("string");
    expect(String(value).length).toBeGreaterThan(0);
  }
  return { read: EPOCH_REPEAT_ADVISORY, search: EPOCH_REPEAT_SEARCH_ADVISORY };
}

/** `hint` at the top level (read.text) or under `matches` (a find). */
function hintOf(body: Body): string | undefined {
  if (typeof body["hint"] === "string") return body["hint"];
  const matches = body["matches"] as Body | undefined;
  return typeof matches?.["hint"] === "string" ? matches["hint"] : undefined;
}

/** 6t-8 #1: the request's first read, a query and no targets. Returns its task id. */
async function openRequest(ws: string): Promise<string> {
  const pack = await call("tl_read_file", { query: "explain how priceOrder applies taxOf", task: EPOCH_NEW, cwd: ws });
  expect(pack["kind"], JSON.stringify(pack).slice(0, 400)).toBe("read.task_pack");
  expect(String(pack["advisory"] ?? "")).not.toContain(advisories().read);
  const id = (pack["task"] as Body | undefined)?.["id"];
  expect(typeof id, JSON.stringify(pack["task"])).toBe("string");
  return String(id);
}

beforeEach(() => {
  resetAll();
});
afterEach(() => {
  resetAll();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("6t-8: a follow-up sent as task.epoch:\"new\" carries the epoch-repeat advisory on its own reply", () => {
  it("a targets-only read (#4's shape) is read.text whose hint is the read advisory, every time", async () => {
    const ws = mkWs("read");
    await openRequest(ws);
    for (const range of ["1-2", "2-3"]) {
      const body = await call("tl_read_file", { targets: [{ path: "src/tax.ts", range }], task: EPOCH_NEW, cwd: ws });
      expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("read.text");
      expect(hintOf(body), range).toBe(advisories().read);
    }
  });

  it("a find (#2's shape) is search.matches whose matches.hint is the search advisory", async () => {
    const ws = mkWs("find");
    await openRequest(ws);
    const body = await call("tl_search_files", { action: "find", queries: ["taxOf"], task: EPOCH_NEW, cwd: ws });
    expect(body["kind"], JSON.stringify(body).slice(0, 400)).toBe("search.matches");
    expect((body["matches"] as Body)["total_matches"]).toBeGreaterThan(0);
    expect(hintOf(body)).toBe(advisories().search);
  });

  it("the advisory names the continuation it recommends", () => {
    const { read, search } = advisories();
    expect(read).toContain("task.handle");
    expect(search).toContain("task.handle");
    expect(search).toContain("search");
  });
});

describe("6t-8 controls", () => {
  it("with no task handle handed out, targets-only reads and a find sent as task.epoch:\"new\" carry nothing, however many", async () => {
    // Every reply a read.text, so the caller holds no task handle to send:
    // the shape evaluation0929.budgetFillSlice.spec.ts compares byte for byte.
    const ws = mkWs("none-open");
    for (const relPath of ["src/tax.ts", "src/order.ts"]) {
      const read = await call("tl_read_file", { targets: [{ path: relPath }], task: EPOCH_NEW, cwd: ws });
      expect(read["kind"], JSON.stringify(read).slice(0, 400)).toBe("read.text");
      expect(hintOf(read), relPath).toBeUndefined();
    }

    const find = await call("tl_search_files", { action: "find", queries: ["taxOf"], task: EPOCH_NEW, cwd: ws });
    expect(find["kind"], JSON.stringify(find).slice(0, 400)).toBe("search.matches");
    expect(hintOf(find)).toBeUndefined();
  });

  it("the recommended continuation, targets with task.handle, carries nothing", async () => {
    const ws = mkWs("handle");
    const taskId = await openRequest(ws);
    const body = await call("tl_read_file", {
      targets: [{ path: "src/tax.ts", range: "1-2" }],
      task: JSON.stringify({ handle: taskId }),
      cwd: ws,
    });
    expect(body["kind"], JSON.stringify(body).slice(0, 400)).not.toBe("refusal");
    expect(hintOf(body)).toBeUndefined();
    expect(String(body["advisory"] ?? "")).not.toContain(advisories().read);
  });

  it("a reply with no hint to carry it (#19's tree) ends the advisory with its call: nothing is left for a later reply", async () => {
    const ws = mkWs("tree");
    await openRequest(ws);
    const tree = await call("tl_search_files", { action: "tree", scope: { path: "src" }, task: EPOCH_NEW, cwd: ws });
    expect(tree["kind"], JSON.stringify(tree).slice(0, 400)).toBe("search.tree");
    expect(JSON.stringify(tree)).not.toContain(advisories().search);
    // Nothing pending for the next task pack …
    expect(takePreparedHandleAdvisory(ws) ?? "").not.toContain(advisories().search);
    // … or for the next read.
    const read = await call("tl_read_file", { targets: [{ path: "src/order.ts" }], cwd: ws });
    expect(read["kind"], JSON.stringify(read).slice(0, 400)).toBe("read.text");
    expect(hintOf(read)).toBeUndefined();
  });
});
