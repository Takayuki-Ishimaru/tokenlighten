import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applySourceFidelity } from "../protocol/sourceFidelity.js";
import { startDevServer } from "./helpers/qualityFirstScenarios.js";

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tl-source-next-"));
  dirs.push(ws);
  const text = "export function calc() {\n  return 1;\n}\n";
  fs.writeFileSync(path.join(ws, "calc.ts"), text);
  fs.writeFileSync(path.join(ws, "other.ts"), text);
  return ws;
}
const call = (file = "calc.ts", range = "1-3") => ({
  tool: "tl_read_file",
  arguments: { cwd: "$WS", lane: "audit", targets: [{ path: file, range }], budget: { bytes: 2000 } },
});
const body = "// tokenlighten:scope path=calc.ts symbol=calc lang=typescript\n// target:\nexport function calc() {";

describe("assembled source prefixes keep every continuation bound to the unserved tail", () => {
  it.each(["read.batch", "read.text", "read.task_pack"] as const)("narrows entry and limit next together: %s", kind => {
    const ws = fixture();
    const field = kind === "read.batch" ? "entries" : "evidence";
    const textField = kind === "read.batch" ? "content" : "body";
    const remainingField = kind === "read.batch" ? "remaining_ranges" : "remaining";
    const next = call();
    next.arguments.cwd = ws;
    const inputEntry = { form: "handle", handle: "h1", path: "calc.ts", range: "1-3", [textField]: body,
      [remainingField]: ["1-3"], next };
    const payload = { [field]: [inputEntry], limit: { cause: "wire", next } };
    const out = applySourceFidelity(payload, kind, { readServeWorkspace: ws });
    const row = (out[field] as any[])[0];
    expect(row.range).toBe("1-1");
    expect(row[remainingField]).toEqual(["2-3"]);
    expect(row.next).toEqual({ ...next, arguments: { ...next.arguments, targets: [{ path: "calc.ts", range: "2-3" }] } });
    expect((out.limit as any).next).toEqual(row.next);
    expect(inputEntry.next.arguments.targets[0]!.range).toBe("1-3");
  });

  it("narrows a standalone batch-entry next when no outer limit exists", () => {
    const ws = fixture();
    const out = applySourceFidelity({ entries: [{ form: "handle", handle: "h1", path: "calc.ts", range: "1-3",
      content: body, remaining_ranges: ["1-3"], next: call() }] }, "read.batch", { readServeWorkspace: ws });
    expect((out.entries as any[])[0].next.arguments.targets[0].range).toBe("2-3");
  });

  it("narrows a top-level next when no outer limit exists", () => {
    const ws = fixture();
    const out = applySourceFidelity({ evidence: [{ handle: "h1", path: "calc.ts", range: "1-3",
      body, remaining: ["1-3"] }], next: call() }, "read.text", { readServeWorkspace: ws });
    expect((out.next as any).arguments.targets[0].range).toBe("2-3");
  });

  it.each([call("other.ts"), call("calc.ts", "2-3"), { tool: "tl_search_files", arguments: { action: "tree" } }])(
    "preserves continuations for a different capability, range, or tool", next => {
      const ws = fixture();
      const out = applySourceFidelity({ entries: [{ form: "handle", handle: "h1", path: "calc.ts", range: "1-3",
        content: body, next }], limit: { cause: "wire", next } }, "read.batch", { readServeWorkspace: ws });
      expect((out.entries as any[])[0].next).toBe(next);
      expect((out.limit as any).next).toBe(next);
    },
  );

  it.each([
    { label: "single symbol", files: ["calc.ts"], full: false, secondSelector: "symbol" },
    { label: "single full symbol", files: ["calc.ts"], full: true, secondSelector: "symbol" },
    { label: "batched full symbols", files: ["calc.ts", "other.ts"], full: true, secondSelector: "symbol" },
    { label: "mixed full symbol/range", files: ["calc.ts", "other.ts"], full: true, secondSelector: "range" },
    { label: "mixed full symbol/ranges", files: ["calc.ts", "other.ts"], full: true, secondSelector: "ranges" },
    { label: "two symbols in one file", files: ["calc.ts", "calc.ts"], full: true, secondSelector: "secondSymbol" },
  ])("follows canonical budgeted $label reads to exact, nonduplicated source coverage", async ({ files, full, secondSelector }) => {
    const ws = fs.mkdtempSync(path.join(os.homedir(), ".tl-source-next-rpc-"));
    dirs.push(ws);
    const symbolLines = ["export function calc() {",
      ...Array.from({ length: 600 }, (_, i) => `  const amount${i} = "${"x".repeat(60)}";`),
      "  return amount599;", "}"];
    const secondSymbol = secondSelector === "secondSymbol"
      ? ["", ...symbolLines.map(line => line.replace("function calc()", "function calc2()"))] : [];
    const lines = ["export const before = 0;", "", ...symbolLines, ...secondSymbol, "", "export const after = 1;"];
    const expectedLines = [
      ...Array.from({ length: symbolLines.length }, (_, i) => i + 3),
      ...(secondSymbol.length > 0 ? Array.from({ length: symbolLines.length }, (_, i) => i + symbolLines.length + 4) : []),
    ];
    for (const file of files) fs.writeFileSync(path.join(ws, file), lines.join("\n") + "\n");
    const server = startDevServer(ws, "default", { toolSurface: "full" });
    try {
      await server.initialize();
      let response = await server.callTool("tl_read_file", {
        cwd: ws, lane: "audit-symbol-next",
        targets: files.map((file, index) => index === 1 && secondSelector === "range"
          ? { path: file, range: `3-${symbolLines.length + 2}` }
          : index === 1 && secondSelector === "ranges"
            ? { path: file, ranges: ["3-302", `303-${symbolLines.length + 2}`] }
            : { path: file, symbol: index === 1 && secondSelector === "secondSymbol" ? "calc2" : "calc" }),
        ...(full ? { content: "full" } : {}),
        budget: { bytes: files.length > 1 ? 30000 : 4000 },
      });
      const served = new Map(files.map(file => [file, [] as number[]]));
      for (let hop = 0; hop < 100; hop++) {
        expect(response.body.kind, JSON.stringify(response.body)).not.toBe("refusal");
        const rows = response.body.evidence ?? response.body.entries ?? [];
        for (const row of rows) {
          const text = row.body ?? row.content;
          const coverage = served.get(row.path);
          if (coverage === undefined || !row.range || typeof text !== "string") continue;
          const [start, end] = row.range.split("-").map(Number);
          expect(text.replace(/\n$/, "")).toBe(lines.slice(start - 1, end).join("\n"));
          for (let line = start; line <= end; line++) coverage.push(line);
        }
        const next = response.body.limit?.next ?? response.body.next ?? response.body.decision?.next ?? rows.find((row: any) => row.next)?.next;
        if (!next) break;
        response = await server.callTool(next.tool, next.arguments);
      }
      for (const [file, coverage] of served) {
        expect(coverage.length, file).toBe(expectedLines.length);
        expect(new Set(coverage).size, file).toBe(expectedLines.length);
        expect([...coverage].sort((a, b) => a - b), file).toEqual(expectedLines);
      }
    } finally { await server.kill(); }
  }, 60000);
});
