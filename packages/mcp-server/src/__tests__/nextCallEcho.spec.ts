// D1/D3/D4 (2026-08-01 probe sweep): a contract must never point BACKWARD —
// no next_call that re-issues the invocation that produced it, no next_call
// naming a locate that already ran, and no over-cap `queries` remedy that
// misroutes to a different tool. Exact observed call shapes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildTaskPack,
  resetPackDedupeCache,
  resetRoleInventoryCache,
} from "../tools/readCodeTaskPack.js";
import { resetRootResolverCache } from "../tools/locateTaskContext.js";
import { resetTokenlightenIgnoreCache } from "../tools/walkRepo.js";
import { handleTable } from "../util/handles.js";
import { resetAll as resetAllSessions } from "../util/session.js";
import {
  recordExecutedLocate,
  consultExecutedLocate,
  resetPackServeLogForTest,
} from "../util/packServeLog.js";
import { callTool } from "../server.js";

const roots: string[] = [];
const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

function workspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-echo-${tag}-`)));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: tag, type: "module" }) + "\n");
  return root;
}

/** Dispatch-based tests need a cwd checkCwdOrRefuse accepts: under $HOME (same constraint closureMode.spec honors). */
function homeWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-echo-${tag}-`)));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: tag, type: "module" }) + "\n");
  return root;
}

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function resetState(): void {
  handleTable.reset();
  resetAllSessions();
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetRootResolverCache();
  resetTokenlightenIgnoreCache();
  resetPackServeLogForTest();
}

beforeEach(resetState);
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("D1 — caller-dir pack must not echo its own invocation", () => {
  it("paths=[<dir>] with zero matches gets a tree inventory next, never the identical re-pack", async () => {
    const root = workspace("dir-echo");
    write(root, "src/other.ts", "export function unrelatedHelper() { return 1; }\n");

    const query = "renameSymbol の実装はどこにありますか？";
    const result = await buildTaskPack({ query, paths: ["src"] }, root);

    expect(result.missing).toContain("src/ (directory)");
    expect(result.next).toEqual({
      tool: "tl_search_files",
      arguments: { action: "tree", path: "src" },
    });
    const nextCall = result.execution_contract?.next_call;
    if (nextCall !== undefined) {
      const args = (nextCall.arguments ?? {}) as Record<string, unknown>;
      const identical = nextCall.tool === "tl_read_file"
        && args["mode"] === "task_pack"
        && typeof args["query"] === "string"
        && query.startsWith(args["query"])
        && JSON.stringify(args["paths"]) === JSON.stringify(["src"]);
      expect(identical, JSON.stringify(nextCall)).toBe(false);
    }
  });
});

describe("D3 — executed-locate ledger", () => {
  it("records, consults, and evicts FIFO past 8 queries; epoch reset clears", () => {
    const root = workspace("locate-ledger");
    recordExecutedLocate(root, "q0", ["h1", "h2"]);
    expect(consultExecutedLocate(root, "q0")).toEqual(["h1", "h2"]);
    for (let i = 1; i <= 8; i++) recordExecutedLocate(root, `q${i}`, []);
    expect(consultExecutedLocate(root, "q0")).toBeUndefined();
    expect(consultExecutedLocate(root, "q8")).toEqual([]);
    resetPackServeLogForTest();
    expect(consultExecutedLocate(root, "q8")).toBeUndefined();
  });

  it("dispatching tl_search_files action=locate records the call with its candidate handles", async () => {
    const root = homeWorkspace("locate-record");
    write(root, "src/alpha.ts", "export function alphaThing() { return 1; }\n");

    await callTool("tl_search_files", { cwd: root, action: "locate", query: "alphaThing" });

    const recorded = consultExecutedLocate(root, "alphaThing");
    expect(recorded).toBeDefined();
  });
});

describe("D4 — over-cap queries remedy stays on find", () => {
  // TL_EFF_WIDE_FIND (default ON since 2026-10-18: ten queries per find, five
  // under an explicit "0") is read per call, from this process's env.
  async function overCapFind(tag: string, queries: string[], wideFind: string | undefined): Promise<Record<string, unknown>> {
    const root = homeWorkspace(tag);
    write(root, "src/a.ts", "export const a = 1;\n");
    const saved = process.env["TL_EFF_WIDE_FIND"];
    if (wideFind === undefined) delete process.env["TL_EFF_WIDE_FIND"];
    else process.env["TL_EFF_WIDE_FIND"] = wideFind;
    try {
      const res = await callTool("tl_search_files", { cwd: root, action: "find", queries });
      return JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
    } finally {
      if (saved === undefined) delete process.env["TL_EFF_WIDE_FIND"];
      else process.env["TL_EFF_WIDE_FIND"] = saved;
    }
  }

  // W2-4: was string-prose `nextText(body)` checks. Same facts on the wire
  // directly: `next` stays on tl_search_files find (never redirects to a
  // tl_read_file task_pack) and carries the queries that fit the cap verbatim.
  function expectFindNext(body: Record<string, unknown>, head: string[]): void {
    const next = body["next"] as { tool?: unknown; arguments?: Record<string, unknown> } | undefined;
    expect(next?.tool, JSON.stringify(body)).toBe("tl_search_files");
    expect(next?.arguments?.["action"], JSON.stringify(body)).toBe("find");
    expect(next?.arguments?.["queries"], JSON.stringify(body)).toEqual(head);
  }

  it("11 queries → error whose next splits into a <=10 find, not a task_pack redirect", async () => {
    const queries = Array.from({ length: 11 }, (_, i) => `zq${i + 1}a`);
    const body = await overCapFind("queries-cap", queries, undefined);
    expect(String(body["detail"])).toContain("at most 10 entries");
    expectFindNext(body, queries.slice(0, 10));
  });

  it("TL_EFF_WIDE_FIND=0: 6 queries → error whose next splits into a <=5 find, not a task_pack redirect", async () => {
    const queries = ["zq1a", "zq2a", "zq3a", "zq4a", "zq5a", "zq6a"];
    const body = await overCapFind("queries-cap-off", queries, "0");
    expect(String(body["detail"])).toContain("at most 5 entries");
    expectFindNext(body, queries.slice(0, 5));
  });
});
