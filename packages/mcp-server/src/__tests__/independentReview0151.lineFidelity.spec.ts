/**
 * independentReview0151.lineFidelity.spec.ts — TL-REVIEW-2 of the independent
 * runtime review of v0.15.1 (2026-10-06): the default comment projection broke
 * evidence body/source-range fidelity.
 *
 * THE REVIEWER'S CALL (stdio MCP, a workspace holding only a copy of
 * packages/vscode-extension/src/copilotGuide.ts, 136 lines):
 *
 *   tl_read_file {"targets":[{"path":"copilotGuide.ts"}],"content":"full","budget":{"bytes":16000}}
 *
 * came back as one `read.text` evidence entry `range:"1-109"` whose body was
 * the comment-ELIDED display (`/* doc elided L28-37 *\/` …), so body line 29
 * was source line 38; it also carried `remaining:["110-111"]` and a cursor that
 * fetched only the tail of a comment block, and the identical repeat re-served
 * three JSDoc blocks labelled "doc-only file". The task-pack projection had the
 * same defect (`calc.ts`: `range:"2-13"` over a 6-line body).
 *
 * THE ORACLE (the reviewer's own acceptance check, kept verbatim in spirit):
 * for every evidence entry — and every `read.batch` entry — that carries a
 * string body, `splitlines(body) == source_lines[lo-1:hi]` for its declared
 * `range` "lo-hi". `splitlines` is Python's, i.e. a final newline terminates
 * the last line rather than starting an empty one.
 *
 * Everything here drives the real dev server over stdio
 * (`startDevServer`, the independentReview1006.spec.ts harness).
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { applySourceFidelity } from "../protocol/sourceFidelity.js";
import { compressFormat, elideDocComments, elideDocCommentsWithWindows } from "../util/formatCompress.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The REAL file the reviewer read — copied, never edited. */
const COPILOT_GUIDE = fs.readFileSync(path.resolve(HERE, "../../../vscode-extension/src/copilotGuide.ts"), "utf8");
const CALC = "export const RATE = 3;\n/**\n * Doubles then triples.\n * Second line.\n */\n"
  + "export function calc(x: number): number {\n  /*\n   * inner block comment\n   * spanning lines\n   */\n"
  + "  const y = x * 2;\n  return y * RATE;\n}\n";
const MARKER = /doc elided L\d+-\d+/;

const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});

function workspace(files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-review0151-"));
  dirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function start(ws: string, allowWrite = false): Promise<ServerHandle> {
  const server = startDevServer(ws, "default", { toolSurface: "full", allowWrite });
  servers.push(server);
  await server.initialize();
  return server;
}

/** Python's `str.splitlines()` for the line endings this server emits. */
function splitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (/(?:\r\n|\r|\n)$/.test(text)) lines.pop();
  return lines;
}

type Row = Record<string, any>;

/** Every body-bearing row of a response: `evidence[]` (`body`) and `read.batch` `entries[]` (`content`). */
function bodyRows(body: any): Array<{ row: Row; text: string }> {
  const rows: Row[] = [...(body?.evidence ?? []), ...(body?.entries ?? [])];
  const out: Array<{ row: Row; text: string }> = [];
  for (const row of rows) {
    const text = typeof row["body"] === "string" ? row["body"] : typeof row["content"] === "string" ? row["content"] : undefined;
    if (text !== undefined) out.push({ row, text });
  }
  return out;
}

/** `[lo, hi]` of a row: its `range`, or the whole file for a rangeless `form:"file"` entry. */
function windowOf(row: Row, sourceLines: readonly string[]): [number, number] | undefined {
  if (typeof row["range"] === "string") {
    const [lo, hi] = row["range"].split("-").map(Number) as [number, number];
    return [lo, hi];
  }
  return row["form"] === "file" ? [1, sourceLines.length] : undefined;
}

/** THE REVIEWER'S ORACLE: every mismatch, as `path@range` strings (empty = faithful). */
function oracleMismatches(body: any, sources: Readonly<Record<string, string>>): string[] {
  const bad: string[] = [];
  for (const { row, text } of bodyRows(body)) {
    const source = sources[String(row["path"])];
    if (source === undefined) { bad.push(`unknown path ${String(row["path"])}`); continue; }
    const lines = splitlines(source);
    const window = windowOf(row, lines);
    if (window === undefined) { bad.push(`rangeless ${String(row["path"])}`); continue; }
    // A one-line BLANK window ships `""` (readFamily.ts `blankLineBody`).
    const got = text === "" && window[0] === window[1] ? [""] : splitlines(text);
    if (JSON.stringify(got) !== JSON.stringify(lines.slice(window[0] - 1, window[1]))) bad.push(`${String(row["path"])}@${window[0]}-${window[1]}`);
    if (MARKER.test(text)) bad.push(`marker in ${String(row["path"])}@${window[0]}-${window[1]}`);
  }
  return bad;
}

/** The renderer's own elided windows for a whole file — what a default-policy full read must disclose. */
function rendererWindows(text: string, lang: string): string[] {
  return elideDocCommentsWithWindows(text, lang).elided.map(([a, b]) => `${a}-${b}`);
}

/** Every `elided` window a response discloses for `relPath`. */
function disclosed(body: any, relPath: string): string[] {
  const rows: Row[] = [...(body?.evidence ?? []), ...(body?.entries ?? [])];
  const out = new Set<string>();
  for (const row of rows) {
    if (row["path"] !== relPath || !Array.isArray(row["elided"])) continue;
    for (const window of row["elided"]) out.add(String(window));
  }
  return [...out].sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
}

function nextOf(body: any): { tool: string; arguments: Record<string, unknown> } | undefined {
  for (const holder of [body, body?.decision, body?.limit]) {
    const next = holder?.["next"];
    if (next !== null && typeof next === "object" && !Array.isArray(next) && typeof next["tool"] === "string") return next;
  }
  return undefined;
}

const FULL = { targets: [{ path: "copilotGuide.ts" }], content: "full", budget: { bytes: 16000 } };

describe("TL-REVIEW-2 — the reviewer's copilotGuide.ts call (content:\"full\", default comment policy)", () => {
  it("every evidence body is its declared source range; the comment blocks are disclosed in `elided`; nothing is owed, so no limit/next", async () => {
    const ws = workspace({ "copilotGuide.ts": COPILOT_GUIDE });
    const server = await start(ws);
    const { body } = await server.callTool("tl_read_file", { ...FULL, cwd: ws });
    expect(body.kind, JSON.stringify(body).slice(0, 300)).toBe("read.text");
    expect(oracleMismatches(body, { "copilotGuide.ts": COPILOT_GUIDE })).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(MARKER);

    // The fixture still exercises the defect: the renderer elides 3+ blocks.
    const windows = rendererWindows(COPILOT_GUIDE, "typescript");
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(disclosed(body, "copilotGuide.ts")).toEqual(windows);

    // Shipped ranges + disclosed windows tile the file exactly once.
    const total = splitlines(COPILOT_GUIDE).length;
    const seen = new Array<number>(total + 1).fill(0);
    for (const range of [...body.evidence.map((row: Row) => row["range"]), ...windows]) {
      const [lo, hi] = String(range).split("-").map(Number) as [number, number];
      for (let line = lo; line <= hi; line += 1) seen[line]! += 1;
    }
    expect(seen.slice(1).every((count) => count === 1)).toBe(true);

    // The reviewer's bogus continuation is gone: the read is complete.
    expect(body.limit).toBeUndefined();
    expect(nextOf(body)).toBeUndefined();
    expect(body.evidence.every((row: Row) => row["remaining"] === undefined)).toBe(true);
  }, 90_000);

  it("the identical repeat is a read.receipt (code-unchanged); comments:\"keep\" then serves exactly the never-served comment windows", async () => {
    const ws = workspace({ "copilotGuide.ts": COPILOT_GUIDE });
    const server = await start(ws);
    await server.callTool("tl_read_file", { ...FULL, cwd: ws });

    const repeat = (await server.callTool("tl_read_file", { ...FULL, cwd: ws })).body;
    expect(repeat.kind, JSON.stringify(repeat).slice(0, 400)).toBe("read.receipt");
    expect(repeat.receipt?.receipt).toBe("code-unchanged");
    expect(JSON.stringify(repeat)).not.toContain("doc-only file");

    const keep = (await server.callTool("tl_read_file", { ...FULL, select: { comments: "keep" }, cwd: ws })).body;
    expect(keep.kind, JSON.stringify(keep).slice(0, 400)).toBe("read.text");
    expect(oracleMismatches(keep, { "copilotGuide.ts": COPILOT_GUIDE })).toEqual([]);
    const fresh = keep.evidence.filter((row: Row) => typeof row["body"] === "string").map((row: Row) => row["range"]);
    expect(fresh).toEqual(rendererWindows(COPILOT_GUIDE, "typescript"));
    // Everything else is `prior` (held since the first call), never re-sent.
    expect(keep.evidence.filter((row: Row) => typeof row["body"] !== "string").every((row: Row) => typeof row["prior"] === "string")).toBe(true);
    expect(keep.note === undefined || !String(keep.note).includes("doc-only file")).toBe(true);
  }, 90_000);

  it("comments:\"keep\" in a fresh session: 136 faithful lines, and its repeat is a receipt (behaviour unchanged)", async () => {
    const ws = workspace({ "copilotGuide.ts": COPILOT_GUIDE });
    const server = await start(ws);
    const keepCall = { ...FULL, select: { comments: "keep" }, cwd: ws };
    const first = (await server.callTool("tl_read_file", keepCall)).body;
    expect(first.kind).toBe("read.text");
    expect(first.evidence).toHaveLength(1);
    expect(first.evidence[0].range).toBe(`1-${splitlines(COPILOT_GUIDE).length}`);
    expect(first.evidence[0].elided).toBeUndefined();
    expect(oracleMismatches(first, { "copilotGuide.ts": COPILOT_GUIDE })).toEqual([]);
    const repeat = (await server.callTool("tl_read_file", keepCall)).body;
    expect(repeat.kind).toBe("read.receipt");
    expect(repeat.receipt?.receipt).toBe("code-unchanged");
  }, 90_000);

  it("a comment-only WINDOW of a file with code serves raw and is never labelled a doc-only file; a genuinely doc-only file keeps its fallback", async () => {
    const docOnly = "/**\n * Nothing but documentation.\n * Second line.\n */\n";
    const ws = workspace({ "copilotGuide.ts": COPILOT_GUIDE, "docOnly.ts": docOnly });
    const server = await start(ws);
    const [first] = rendererWindows(COPILOT_GUIDE, "typescript");
    const zoom = (await server.callTool("tl_read_file", { targets: [{ path: "copilotGuide.ts", range: first }], cwd: ws })).body;
    expect(zoom.kind).toBe("read.text");
    expect(oracleMismatches(zoom, { "copilotGuide.ts": COPILOT_GUIDE })).toEqual([]);
    expect(zoom.evidence[0].range).toBe(first);
    expect(String(zoom.note ?? "")).toContain("comment-only window");
    expect(String(zoom.note ?? "")).not.toContain("doc-only file");

    const whole = (await server.callTool("tl_read_file", { targets: [{ path: "docOnly.ts" }], content: "full", cwd: ws })).body;
    expect(whole.kind).toBe("read.text");
    expect(oracleMismatches(whole, { "docOnly.ts": docOnly })).toEqual([]);
    expect(whole.evidence[0].range).toBe("1-4");
    expect(String(whole.note ?? "")).toContain("doc-only file");
  }, 90_000);

  it("a symbol read's assembled scope view carries no elision marker, and its target part is the symbol's verbatim source", async () => {
    const ws = workspace({ "copilotGuide.ts": COPILOT_GUIDE });
    const server = await start(ws);
    const { body } = await server.callTool("tl_read_file", {
      targets: [{ path: "copilotGuide.ts", symbol: "predictStandaloneCopilotGuide" }],
      cwd: ws,
    });
    expect(body.kind, JSON.stringify(body).slice(0, 300)).toBe("read.text");
    const row = body.evidence[0] as Row;
    const text = String(row["body"]);
    expect(text).not.toMatch(MARKER);
    const [lo, hi] = String(row["range"]).split("-").map(Number) as [number, number];
    const target = text.includes("\n// target:\n") ? text.split("\n// target:\n")[1]! : text;
    expect(splitlines(target)).toEqual(splitlines(COPILOT_GUIDE).slice(lo - 1, hi));
  }, 90_000);

  it("tl_edit_file still refuses a pasted elision marker it cannot resolve (the write guard), now that no marker reaches a body", async () => {
    const ws = workspace({ "copilotGuide.ts": COPILOT_GUIDE });
    const server = await start(ws, true);
    const read = (await server.callTool("tl_read_file", { ...FULL, cwd: ws })).body;
    const [first] = rendererWindows(COPILOT_GUIDE, "typescript");
    const codeLine = String((read.evidence[1] as Row)["body"]).split("\n")[0]!;
    // A marker written INTO the file (marker in `replace`, none in `search`).
    const intoFile = (await server.callTool("tl_edit_file", {
      edits: [{ path: "copilotGuide.ts", search: codeLine, replace: `/* doc elided L${first} */` }],
      cwd: ws,
    })).body;
    expect(intoFile.kind, JSON.stringify(intoFile).slice(0, 300)).toBe("refusal");
    expect(intoFile.code).toBe("elided-content");
    // A marker naming no window the renderer collapses (lines 1-3 are code).
    const forged = (await server.callTool("tl_edit_file", {
      edits: [{ path: "copilotGuide.ts", search: "/* doc elided L1-3 */", replace: "// gone" }],
      cwd: ws,
    })).body;
    expect(forged.kind, JSON.stringify(forged).slice(0, 300)).toBe("refusal");
    expect(forged.code).toBe("elided-content");
    expect(fs.readFileSync(path.join(ws, "copilotGuide.ts"), "utf8")).toBe(COPILOT_GUIDE);
  }, 90_000);
});

describe("TL-REVIEW-2 — the task-pack, batch and budget shapes", () => {
  it("task_pack `Explain calc in calc.ts.`: calc ships as faithful segments, its two comment blocks disclosed", async () => {
    const ws = workspace({ "calc.ts": CALC });
    const server = await start(ws);
    const { body } = await server.callTool("tl_read_file", {
      query: "Explain calc in calc.ts.",
      task: { epoch: "new", profile: "answer" },
      cwd: ws,
    });
    expect(body.kind, JSON.stringify(body).slice(0, 300)).toBe("read.task_pack");
    expect(oracleMismatches(body, { "calc.ts": CALC })).toEqual([]);
    expect(JSON.stringify(body.evidence)).not.toMatch(MARKER);
    expect(disclosed(body, "calc.ts")).toEqual(["2-5", "7-10"]);
    const served = bodyRows(body).map(({ text }) => text).join("\n");
    expect(served).toContain("export function calc(x: number): number {");
    expect(served).toContain("return y * RATE;");
  }, 90_000);

  it("read.batch of two whole files: every entry's content is the source of its range", async () => {
    const ws = workspace({ "copilotGuide.ts": COPILOT_GUIDE, "calc.ts": CALC });
    const server = await start(ws);
    const { body } = await server.callTool("tl_read_file", {
      targets: [{ path: "copilotGuide.ts" }, { path: "calc.ts" }],
      content: "full",
      cwd: ws,
    });
    expect(body.kind, JSON.stringify(body).slice(0, 300)).toBe("read.batch");
    expect(oracleMismatches(body, { "copilotGuide.ts": COPILOT_GUIDE, "calc.ts": CALC })).toEqual([]);
    expect(disclosed(body, "copilotGuide.ts")).toEqual(rendererWindows(COPILOT_GUIDE, "typescript"));
    expect(disclosed(body, "calc.ts")).toEqual(["2-5", "7-10"]);
    expect(body.limit).toBeUndefined();
  }, 90_000);

  /** 100 lines: self-identifying code lines with three JSDoc blocks. */
  function commentedModule(tag: string, blocks: ReadonlyArray<readonly [number, number]>): string {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i += 1) {
      const block = blocks.find(([a, b]) => i >= a && i <= b);
      if (block === undefined) lines.push(`export const ${tag}_${i} = ${i}; // ${tag}:${i}`);
      else if (i === block[0]) lines.push("/**");
      else if (i === block[1]) lines.push(" */");
      else lines.push(` * ${tag} documentation line ${i}, long enough to matter.`);
    }
    return lines.join("\n") + "\n";
  }

  for (const budget of [1500, 2600]) {
    it(`2 files x 100 lines with comment blocks at budget.bytes ${budget}: following next to exhaustion serves every code line exactly once and no comment line`, async () => {
      const blocks = {
        "src/a.ts": [[10, 19], [40, 52], [75, 81]] as const,
        "src/b.ts": [[5, 14], [60, 70], [90, 96]] as const,
      };
      const sources = {
        "src/a.ts": commentedModule("A", blocks["src/a.ts"]),
        "src/b.ts": commentedModule("B", blocks["src/b.ts"]),
      };
      const ws = workspace(sources);
      const server = await start(ws);
      const served = new Map<string, number[]>([["src/a.ts", new Array(101).fill(0)], ["src/b.ts", new Array(101).fill(0)]]);
      const elided = new Map<string, Set<string>>([["src/a.ts", new Set()], ["src/b.ts", new Set()]]);
      let call: { tool: string; arguments: Record<string, unknown> } | undefined = {
        tool: "tl_read_file",
        arguments: { targets: [{ path: "src/a.ts" }, { path: "src/b.ts" }], content: "full", budget: { bytes: budget }, cwd: ws },
      };
      let hops = 0;
      while (call !== undefined && hops < 60) {
        const { body, textBytes } = await server.callTool(call.tool, call.arguments);
        const where = `hop ${hops}: ${JSON.stringify(body).slice(0, 300)}`;
        expect(body.kind, where).not.toBe("refusal");
        expect(textBytes, where).toBeLessThanOrEqual(budget);
        expect(oracleMismatches(body, sources), where).toEqual([]);
        for (const { row } of bodyRows(body)) {
          const counts = served.get(String(row["path"]))!;
          const [lo, hi] = windowOf(row, splitlines(sources[row["path"] as keyof typeof sources]))!;
          for (let line = lo; line <= hi; line += 1) counts[line]! += 1;
        }
        for (const relPath of Object.keys(sources)) for (const window of disclosed(body, relPath)) elided.get(relPath)!.add(window);
        call = nextOf(body);
        hops += 1;
      }
      expect(call, "the chain terminates").toBeUndefined();
      for (const [relPath, fileBlocks] of Object.entries(blocks)) {
        const counts = served.get(relPath)!;
        const inBlock = (line: number): boolean => fileBlocks.some(([a, b]) => line >= a && line <= b);
        const code = Array.from({ length: 100 }, (_, i) => i + 1).filter((line) => !inBlock(line));
        expect(code.filter((line) => counts[line] !== 1), `${relPath}: code lines not served exactly once`).toEqual([]);
        expect(Array.from({ length: 100 }, (_, i) => i + 1).filter((line) => inBlock(line) && counts[line] !== 0), `${relPath}: comment lines served`).toEqual([]);
        expect([...elided.get(relPath)!].sort((x, y) => Number(x.split("-")[0]) - Number(y.split("-")[0])))
          .toEqual(fileBlocks.map(([a, b]) => `${a}-${b}`));
      }
    }, 180_000);
  }
});

// ---------------------------------------------------------------------------
// The seam itself (protocol/sourceFidelity.ts), in process: each case hands
// it one projected payload over a real workspace file and checks the oracle.
// ---------------------------------------------------------------------------

describe("TL-REVIEW-2 — applySourceFidelity unit cases", () => {
  const rows = (payload: Record<string, unknown>): Row[] => (payload["evidence"] ?? payload["entries"]) as Row[];
  const project = (ws: string, kind: "read.text" | "read.batch" | "read.task_pack", list: Row[]): Record<string, unknown> =>
    applySourceFidelity(kind === "read.batch" ? { entries: list } : { evidence: list }, kind, { readServeWorkspace: ws });

  it("splits an absolute-marker rendering into faithful segments and discloses the windows", () => {
    const ws = workspace({ "calc.ts": CALC });
    const out = project(ws, "read.text", [{ handle: "h1", path: "calc.ts", range: "1-13", body: elideDocComments(CALC, "typescript") }]);
    expect(rows(out).map((row) => row["range"])).toEqual(["1-1", "6-6", "11-13"]);
    expect(rows(out)[0]!["elided"]).toEqual(["2-5", "7-10"]);
    expect(oracleMismatches(out, { "calc.ts": CALC })).toEqual([]);
  });

  it("accepts slice-relative markers (a producer rendering at start line 1) by width at the renderer's own positions", () => {
    const ws = workspace({ "calc.ts": CALC });
    const slice = splitlines(CALC).slice(1, 13).join("\n");
    const out = project(ws, "read.task_pack", [{ handle: "h1", path: "calc.ts", range: "2-13", body: elideDocComments(slice, "typescript"), role: "unknown", why: "w" }]);
    expect(rows(out).map((row) => row["range"])).toEqual(["6-6", "11-13"]);
    expect(rows(out)[0]!["elided"]).toEqual(["2-5", "7-10"]);
    expect(rows(out)[0]!["why"]).toBe("w");
    expect(rows(out)[1]!["why"]).toBeUndefined();
    expect(rows(out).every((row) => row["role"] === "unknown")).toBe(true);
    expect(oracleMismatches(out, { "calc.ts": CALC })).toEqual([]);
  });

  it("a FORGED marker-shaped literal in the source is ordinary content, never a window", () => {
    const text = "export const A = 1;\n/* doc elided L1-40 */\n/**\n * real\n * block\n */\nexport const B = 2;\n";
    const ws = workspace({ "forged.ts": text });
    // A faithful body containing the literal is left exactly as it is.
    const faithful = { handle: "h1", path: "forged.ts", range: "1-2", body: "export const A = 1;\n/* doc elided L1-40 */" };
    expect(project(ws, "read.text", [faithful])).toEqual({ evidence: [faithful] });
    // The real rendering keeps the literal as a served line and elides only the real block.
    const out = project(ws, "read.text", [{ handle: "h1", path: "forged.ts", range: "1-7", body: elideDocComments(text, "typescript") }]);
    expect(rows(out).map((row) => row["range"])).toEqual(["1-2", "7-7"]);
    expect(rows(out)[0]!["elided"]).toEqual(["3-6"]);
    expect(String(rows(out)[0]!["body"])).toContain("/* doc elided L1-40 */");
    expect(oracleMismatches({ evidence: rows(out).map((row) => ({ ...row, body: String(row["body"]).replace("/* doc elided L1-40 */", "X") })) }, { "forged.ts": text.replace("/* doc elided L1-40 */", "X") })).toEqual([]);
  });

  it("a closing line that carries code is shipped, never inside an elided window", () => {
    const text = "/**\n * doc\n * more\n */ export const A = 1;\nexport const B = 2;\n";
    const ws = workspace({ "close.ts": text });
    const out = project(ws, "read.text", [{ handle: "h1", path: "close.ts", range: "1-5", body: elideDocComments(text, "typescript") }]);
    expect(rows(out)[0]!["range"]).toBe("4-5");
    expect(rows(out)[0]!["elided"]).toEqual(["1-3"]);
    expect(String(rows(out)[0]!["body"])).toContain(" */ export const A = 1;");
    expect(oracleMismatches(out, { "close.ts": text })).toEqual([]);
  });

  it("CRLF sources and compressFormat'd bodies (blank runs collapsed, trailing blanks stripped) are restored line for line", () => {
    const text = "export const A = 1;   \r\n\r\n\r\n/**\r\n * doc\r\n */\r\nexport const B = 2;\r\n";
    const ws = workspace({ "crlf.ts": text });
    const display = compressFormat(elideDocComments(text, "typescript"));
    const out = project(ws, "read.text", [{ handle: "h1", path: "crlf.ts", range: "1-5", body: display }]);
    expect(rows(out).map((row) => row["range"])).toEqual(["1-3", "7-7"]);
    expect(rows(out)[0]!["elided"]).toEqual(["4-6"]);
    expect(String(rows(out)[0]!["body"])).toBe("export const A = 1;   \n\n\n");
    expect(oracleMismatches(out, { "crlf.ts": text })).toEqual([]);
  });

  it("the symbol serve's compress-THEN-elide order verifies too (a blank run inside the block)", () => {
    const text = "export function f() {\n  /*\n   * a\n\n\n   * b\n   */\n  return 1;\n}\n";
    const ws = workspace({ "sym.ts": text });
    const body = elideDocComments(compressFormat(text), "typescript").replace(/\n$/, "");
    const out = project(ws, "read.text", [{ handle: "h1", path: "sym.ts", range: "1-9", body }]);
    expect(rows(out).map((row) => row["range"])).toEqual(["1-1", "8-9"]);
    expect(rows(out)[0]!["elided"]).toEqual(["2-7"]);
    expect(oracleMismatches(out, { "sym.ts": text })).toEqual([]);
  });

  it("a window that is nothing but one comment block ships RAW (the doc-only rule), never an empty entry", () => {
    const ws = workspace({ "calc.ts": CALC });
    const marker = elideDocComments(splitlines(CALC).slice(1, 5).join("\n"), "typescript", 2);
    expect(marker).toBe("/* doc elided L2-5 */");
    const out = project(ws, "read.text", [{ handle: "h1", path: "calc.ts", range: "2-5", body: marker }]);
    expect(rows(out)).toHaveLength(1);
    expect(rows(out)[0]!["range"]).toBe("2-5");
    expect(rows(out)[0]!["elided"]).toBeUndefined();
    expect(oracleMismatches(out, { "calc.ts": CALC })).toEqual([]);
  });

  it("a strict-prefix rendering of a declared window names the undelivered tail in `remaining`", () => {
    const ws = workspace({ "calc.ts": CALC });
    const display = elideDocComments(CALC, "typescript").split("\n").slice(0, 3).join("\n");
    const out = project(ws, "read.text", [{ handle: "h1", path: "calc.ts", range: "1-13", body: display }]);
    expect(rows(out).map((row) => row["range"])).toEqual(["1-1", "6-6"]);
    expect(rows(out)[0]!["remaining"]).toEqual(["7-13"]);
    expect(oracleMismatches(out, { "calc.ts": CALC })).toEqual([]);
  });

  it("a separator-joined verbatim body whose last line is blank is re-spelled so terminator readers count it", () => {
    const text = "a\n\nb\n";
    const ws = workspace({ "blank.ts": text });
    const out = project(ws, "read.text", [{ handle: "h1", path: "blank.ts", range: "1-2", body: "a\n" }]);
    expect(rows(out)[0]!["body"]).toBe("a\n\n");
    expect(oracleMismatches(out, { "blank.ts": text })).toEqual([]);
  });

  it("an unverifiable body (an outline, a synthetic preview) is left exactly as the producer built it", () => {
    const ws = workspace({ "calc.ts": CALC });
    const outline = { handle: "h1", path: "calc.ts", range: "1-2", body: "calc(x) { ... }\nRATE" };
    expect(project(ws, "read.text", [outline])).toEqual({ evidence: [outline] });
  });

  it("an assembled scope view moves its labelled preamble to metadata and serves the verbatim target", () => {
    const ws = workspace({ "calc.ts": CALC });
    const target = splitlines(CALC).slice(1, 13).join("\n");
    const view = elideDocComments(["// tokenlighten:scope path=calc.ts symbol=calc lang=typescript", "", "// sibling signatures:", "/**", " * x", " */", "", "// target:", target].join("\n"), "typescript");
    const out = project(ws, "read.text", [{ handle: "h1", path: "calc.ts", range: "2-13", body: view }]);
    const body = String(rows(out)[0]!["body"]);
    expect(body).not.toMatch(MARKER);
    expect(body).toBe(target);
    expect(rows(out)[0]!["note"]).toMatch(/^\/\/ tokenlighten:scope path=calc.ts/);
    expect(rows(out)[0]!["note"]).not.toMatch(MARKER);
  });

  it("read.batch: an elided whole-file entry becomes handle-form segments; a compress-only one stays a file entry", () => {
    const plain = "export const A = 1;  \n\n\nexport const B = 2;\n";
    const ws = workspace({ "calc.ts": CALC, "plain.ts": plain });
    const out = project(ws, "read.batch", [
      { form: "file", path: "calc.ts", truncated: false, handle: "h1", content: compressFormat(elideDocComments(CALC, "typescript")), sha: "sha256:x", fullFileExpansion: true },
      { form: "file", path: "plain.ts", truncated: false, handle: "h2", content: compressFormat(plain), sha: "sha256:y", fullFileExpansion: true },
    ]);
    expect(rows(out).map((row) => [row["form"], row["path"], row["range"]])).toEqual([
      ["handle", "calc.ts", "1-1"], ["handle", "calc.ts", "6-6"], ["handle", "calc.ts", "11-13"], ["file", "plain.ts", undefined],
    ]);
    expect(rows(out)[0]!["elided"]).toEqual(["2-5", "7-10"]);
    expect(rows(out)[3]!["content"]).toBe(plain);
    expect(oracleMismatches(out, { "calc.ts": CALC, "plain.ts": plain })).toEqual([]);
  });
});
