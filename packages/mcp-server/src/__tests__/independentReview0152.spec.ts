import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";
import { replaceRangeContent } from "../write/rangeEdit.js";
import { REVIEW_0152_TINY as TINY, REVIEW_0152_PRICING_QUERY as PRICING_QUERY, review0152Pricing as pricing } from "./helpers/independentReview0152Fixture.js";

const dirs: string[] = [];
const servers: ServerHandle[] = [];
afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});

async function fixture(files: Record<string, string>, allowWrite = false, extraEnv?: Readonly<Record<string, string>>) {
  const ws = fs.realpathSync(shortTmpDir(os.homedir(), ".tl-review0152-"));
  dirs.push(ws);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, name)), { recursive: true });
    fs.writeFileSync(path.join(ws, name), content);
  }
  const server = startDevServer(ws, "default", { toolSurface: "full", allowWrite, ...(extraEnv ? { extraEnv } : {}) });
  servers.push(server);
  await server.initialize();
  return { ws, server };
}

describe("independent v0.15.2 review — exact public call shapes", () => {
  it.each([
    "Who uses the return value of total(5000, true)?",
    "Explain how a consumer uses the return value of total(5000, true).",
    "Explain the type of the return value of total(5000, true).",
    "Explain the return value type of `total()`.",
    "What is the return value of `parseProxy`?",
    "`parseProxy` の戻り値の型を教えてください。",
  ])("keeps caller/type questions separate from call evaluation: %s", query => {
    expect(extractFacetRequirements(query).map(r => r.facet)).not.toContain("value");
  });
  it.each([PRICING_QUERY, "Explain the return value of total(5000, true) in src/pricing.ts, including discount and shipping calculations."])("retains the computed value facet in a composite question: %s", query => {
    expect(extractFacetRequirements(query).map(r => r.facet)).toContain("value");
  });

  it.each([0.1, 0.2])("serves the distinguishing discount and shipping implementations (%s)", async rate => {
    const { server } = await fixture({ "src/pricing.ts": pricing(rate) });
    let reply = (await server.callTool("tl_read_file", { query: PRICING_QUERY, task: { epoch: "new" } })).body;
    const responses = [reply];
    for (let hop = 0; hop < 5 && reply.decision?.next; hop++) {
      const next = reply.decision.next;
      reply = (await server.callTool(next.tool, next.arguments)).body;
      responses.push(reply);
    }
    const bodies = responses.flatMap((r: any) => r.evidence ?? []).map((e: any) => e.body ?? "").join("\n");
    expect(bodies, JSON.stringify(responses)).toContain(`Math.floor(subtotal * ${rate})`);
    expect(bodies).toContain("subtotal >= 5000");
    expect(reply.decision?.kind, JSON.stringify(responses)).toBe("act.answer");
    expect(JSON.stringify(reply.decision?.certificate)).toMatch(/request-item:facet-\d+:value/);
  });

  it.each([
    "src/tiny.ts の add 関数を説明してください。",
    "src/tiny.ts の add 関数を要約してください。",
    "src/tiny.ts の add 関数が何をするか教えてください。",
    "src/tiny.ts の add 関数の挙動を教えてください。",
  ])("closes a known small Japanese explanation: %s", async query => {
    const { server } = await fixture({ "src/tiny.ts": TINY });
    const reply = (await server.callTool("tl_read_file", { query, task: { epoch: "new" } })).body;
    expect(reply.profile, JSON.stringify(reply)).toBe("answer");
    expect(reply.decision?.kind, JSON.stringify(reply)).toBe("act.answer");
    expect(reply.decision?.next).toBeUndefined();
  });

  it("retains both return-value and computation-order requirements", () => {
    expect(extractFacetRequirements(PRICING_QUERY).map(r => r.facet)).toEqual(["value", "flow"]);
  });

  it("keeps requested edits authoritative when a named function is called add", async () => {
    const { server } = await fixture({ "src/tiny.ts": TINY });
    const reply = (await server.callTool("tl_read_file", {
      query: "src/tiny.ts の add 関数を説明し、戻り値を修正してください。", task: { epoch: "new" },
    })).body;
    expect(reply.profile).not.toBe("answer");
    expect(reply.decision?.kind).not.toBe("act.answer");
  });

  it("suggests an economical all-results budget without enlarging next or dropping matches", async () => {
    const files = Object.fromEntries(Array.from({ length: 120 }, (_, i) =>
      [`searchset/item${String(i).padStart(3, "0")}.ts`, `export const RETRY_LIMIT_${i} = 3; // shared retry policy\n`]));
    const { server } = await fixture(files);
    const initial = { action: "find", queries: ["RETRY_LIMIT_"], scope: { path: "searchset", kind: "text" }, budget: { bytes: 2000 } };
    const first = await server.callTool("tl_search_files", initial);
    expect(first.body.matches.pagination_advice.remaining_lines).toBeGreaterThan(0);
    expect(first.body.limit.next.arguments.budget.bytes).toBe(2000);
    let current = first;
    const paths: string[] = [];
    let originalBytes = 0;
    let originalCalls = 0;
    for (let hop = 0; hop < 100; hop++) {
      expect(current.textBytes).toBeLessThanOrEqual(2000);
      originalBytes += current.textBytes;
      originalCalls++;
      paths.push(...current.body.matches.files.map((file: any) => file.path));
      if (!current.body.limit?.next) break;
      const next = current.body.limit.next;
      current = await server.callTool(next.tool, next.arguments);
    }
    expect(paths.length).toBe(120);
    expect(new Set(paths).size).toBe(120);
    const recommended = first.body.matches.pagination_advice.recommended_budget.bytes;
    const wider = await server.callTool("tl_search_files", { ...initial, budget: { bytes: recommended }, lane: "wider" });
    expect(wider.body.matches.files.length).toBeGreaterThan(first.body.matches.files.length);
    expect(wider.textBytes).toBeLessThanOrEqual(recommended);
    let adaptive = await server.callTool("tl_search_files", { ...initial, lane: "adaptive" });
    let adaptiveBytes = adaptive.textBytes;
    let adaptiveCalls = 1;
    const adaptivePaths = adaptive.body.matches.files.map((file: any) => file.path);
    while (adaptive.body.limit?.next && adaptiveCalls < 10) {
      const next = adaptive.body.limit.next;
      adaptive = await server.callTool(next.tool, { ...next.arguments, budget: { bytes: recommended } });
      expect(adaptive.textBytes).toBeLessThanOrEqual(recommended);
      adaptiveBytes += adaptive.textBytes;
      adaptiveCalls++;
      adaptivePaths.push(...adaptive.body.matches.files.map((file: any) => file.path));
    }
    expect(adaptive.body.limit).toBeUndefined();
    expect(adaptivePaths.length).toBe(120);
    expect(new Set(adaptivePaths).size).toBe(120);
    expect(adaptiveCalls).toBeLessThan(originalCalls);
    expect(adaptiveBytes).toBeLessThan(originalBytes);
    const limited = await server.callTool("tl_search_files", { ...initial, budget: { bytes: 2000, items: 2 }, lane: "first-few" });
    expect(limited.body.matches.hint).toBeUndefined();
  });

  it("does not claim an all-results budget when the search snapshot is capped", async () => {
    const files = Object.fromEntries(Array.from({ length: 120 }, (_, i) =>
      [`searchset/item${String(i).padStart(3, "0")}.ts`, `export const RETRY_LIMIT_${i} = 3; // shared retry policy\n`]));
    const { server } = await fixture(files, false, { TOKENLIGHTEN_TEST_MAX_SEARCH_SNAPSHOT_RECORDS: "80" });
    const result = await server.callTool("tl_search_files", {
      action: "find", queries: ["RETRY_LIMIT_"], scope: { path: "searchset", kind: "text" }, budget: { bytes: 2000 },
    });
    expect(result.body.matches.files.length).toBeGreaterThan(0);
    expect(result.body.limit.next).toBeDefined();
    expect(result.body.matches.hint).toBeUndefined();
  });

  it.each(["\n", "\r\n", "\r"])("preserves a non-EOF line boundary through edits[] (%j)", async ending => {
    const { ws, server } = await fixture({ "main.py": `x = 1${ending}print(x)${ending}` }, true);
    const read = (await server.callTool("tl_read_file", { targets: [{ path: "main.py" }], content: "full" })).body;
    const edit = (await server.callTool("tl_edit_file", { edits: [{ handle: read.evidence[0].handle, range: "1-1", content: "x = 2" }] })).body;
    expect(edit.kind, JSON.stringify(edit)).toBe("edit.applied");
    expect(fs.readFileSync(path.join(ws, "main.py"), "utf8")).toBe(`x = 2${ending}print(x)${ending}`);
    const run = spawnSync(process.platform === "win32" ? "python" : "python3", [path.join(ws, "main.py")], { encoding: "utf8", timeout: 5000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe("2");
  });

  it.each([
    { original: "a\nb\nc\n", range: "1-2", content: "x\ny", result: "x\ny\nc\n" },
    { original: "a\nb\nc\n", range: "1-2", content: "", result: "c\n" },
    { original: "a\nb", range: "2-2", content: "z", result: "a\nz" },
    { original: "a\nb\n", range: "2-2", content: "z", result: "a\nz" },
  ])("keeps single-edit line semantics: $range", async test => {
    const { ws } = await fixture({ "lines.txt": test.original });
    expect(replaceRangeContent({ path: "lines.txt", range: test.range, content: test.content }, ws, true, "review0152").ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, "lines.txt"), "utf8")).toBe(test.result);
  });

  it("keeps direct range, symbol, task-pack and batch bodies in source coordinates", async () => {
    const source = Array.from({ length: 300 }, (_, i) => `export function operation${i}(value: number): number {\n  return value * ${i};\n}\n`).join("\n");
    const { server } = await fixture({ "src/large.ts": source, "src/tiny.ts": TINY });
    const calls = [
      { targets: [{ path: "src/large.ts", range: "693-695" }], lane: "range" },
      { targets: [{ path: "src/large.ts", symbol: "operation173" }], lane: "symbol" },
      { query: "Explain operation173 in src/large.ts.", task: { epoch: "new", profile: "answer" }, lane: "pack" },
      { targets: [{ path: "src/large.ts", symbol: "operation173" }, { path: "src/tiny.ts" }], lane: "batch" },
    ];
    for (const call of calls) {
      const reply = (await server.callTool("tl_read_file", call)).body;
      const entries = reply.evidence ?? reply.entries;
      expect(entries?.length, JSON.stringify(reply)).toBeGreaterThan(0);
      for (const entry of entries) {
        if (!entry.range || !(entry.body ?? entry.content)) continue;
        const [start, end] = entry.range.split("-").map(Number);
        const original = entry.path === "src/tiny.ts" ? TINY : source;
        const expected = original.split("\n").slice(start - 1, end).join("\n");
        expect((entry.body ?? entry.content).replace(/\n$/, ""), `${call.lane}:${JSON.stringify(entry)}`).toBe(expected);
      }
    }
  });
});
