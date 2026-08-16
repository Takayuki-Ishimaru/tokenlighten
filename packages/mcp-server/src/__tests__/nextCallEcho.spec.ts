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
import { nextText } from "./helpers/protocolNext.js";

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
    expect(result.next).toBe("search_files action=tree path=src");
    const nextCall = result.execution_contract?.next_call;
    if (nextCall !== undefined) {
      const args = (nextCall.arguments ?? {}) as Record<string, unknown>;
      const identical = nextCall.tool === "read_file"
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

  it("dispatching search_files action=locate records the call with its candidate handles", async () => {
    const root = homeWorkspace("locate-record");
    write(root, "src/alpha.ts", "export function alphaThing() { return 1; }\n");

    await callTool("search_files", { cwd: root, action: "locate", query: "alphaThing" });

    const recorded = consultExecutedLocate(root, "alphaThing");
    expect(recorded).toBeDefined();
  });
});

describe("D4 — over-cap queries remedy stays on find", () => {
  it("6 queries → error whose next splits into a <=5 find, not a task_pack redirect", async () => {
    const root = homeWorkspace("queries-cap");
    write(root, "src/a.ts", "export const a = 1;\n");

    const res = await callTool("search_files", {
      cwd: root,
      action: "find",
      queries: ["zq1a", "zq2a", "zq3a", "zq4a", "zq5a", "zq6a"],
    });
    const body = JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

    expect(String(body["detail"])).toContain("at most 5 entries");
    const next = nextText(body as Record<string, unknown>);
    expect(next).toContain("action=find");
    expect(next).toContain("zq1a");
    expect(next).not.toContain("task_pack");
  });
});
