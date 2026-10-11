/**
 * evaluation0929.sliceWireModel.spec.ts — FX1 (eval-0929 full-suite finding):
 * V15-BCF2's budget sizing of ranged reads regressed v0.14.4 at small budgets.
 *
 * REPRO (the file is 300 lines of `export const C<i> = <i>;`):
 *   tl_read_file {targets:[{path, range:"1-20"}], budget:{bytes:B}}
 *   v0.14.4  B=620: `read.text`, 612 B, ALL of 1-20, no `limit`, no `next`.
 *   BCF2     B=620: `read.text`, 604 B, ONE line + a continuation + a ~70 B
 *            `note` ("exceeds the serve byte cap" — no serve cap was hit);
 *            B=560: `refusal budget-below-minimum` (the note alone pushed one
 *            line past the budget) where v0.14.4 served.
 *
 * ROOT CAUSE (tools/readCodeModes.ts, BCF2's `narrowedByteCap`): it reserved
 * `pageEnvelopeReserve + 350` B (~930 B) for the envelope BEFORE asking whether
 * a continuation was needed. Below ~1 KiB that reserve is larger than the
 * budget, so a window that fits WHOLE was narrowed to its first line
 * (self-fulfilling) and the note it minted cost bytes v0.14.4 never spent.
 *
 * THE RULES THIS FILE PINS (in the order the code decides them):
 *   1. WHOLE FIRST. When the response carrying the whole window fits the
 *      declared budget it is served exactly as v0.14.4 served it.
 *   2. NARROW by whole lines with the continuation's REAL bytes counted once
 *      (`sliceWireEnvelopeBytes`), no `note`, never a refusal at a budget
 *      where one line + its continuation fits.
 *   3. Where the wire body cannot be predicted (doc-comment elision, markdown)
 *      the window is served as v0.14.4 served it and the ladder decides.
 *
 * THE MODEL IS CALIBRATED HERE, NOT TRUSTED: `sliceWireEnvelopeBytes` is a
 * model of what `readFamily.ts` projects and `readRequestContinuation.ts`
 * installs. Every calibration case below compares it to a REAL response and
 * derives the expected body size from `JSON.stringify` directly (not from the
 * estimator under test), so the day either side drifts this file fails by
 * name instead of a budget quietly going over or under.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { estimateBytesFromTokens } from "../protocol/budget/wireBudget.js";
import { resolveSlice, sliceWireEnvelopeBytes, SLICE_SIZING_MARGIN_BYTES } from "../tools/readCodeModes.js";
import { HANDLE_ID_LENGTH } from "../util/handles.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});

afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function freshWs(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-swm-${tag}-`));
  tmpDirs.push(ws);
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  return ws;
}

function put(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function constFile(lines: number, prefix = "C"): string {
  return Array.from({ length: lines }, (_, i) => `export const ${prefix}${i} = ${i};`).join("\n") + "\n";
}

/** ~90 B lines: the shape `evaluation0929.budgetFillSlice.spec.ts` sizes against. */
function wideFile(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `export const WIDE${String(i).padStart(4, "0")} = "${"x".repeat(60)}";`).join("\n") + "\n";
}

type Json = Record<string, unknown>;

async function read(ws: string, args: Json): Promise<{ body: Json; bytes: number }> {
  const raw = await callTool("tl_read_file", { ...args, cwd: ws });
  const text = raw.content[0]!.text;
  return { body: JSON.parse(text) as Json, bytes: Buffer.byteLength(text, "utf8") };
}

function rows(body: Json): Array<Record<string, unknown>> {
  return Array.isArray(body["evidence"]) ? (body["evidence"] as Array<Record<string, unknown>>) : [];
}

function linesServed(body: Json): number {
  let total = 0;
  for (const row of rows(body)) if (typeof row["body"] === "string" && row["body"] !== "") total += (row["body"] as string).split("\n").length;
  return total;
}

/** The wire size of `text` as ONE JSON string, computed directly — never through the estimator under test. */
function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

/** The body a `start-end` window of `fileText` serves (a window reaching EOF keeps the file's trailing newline). */
function windowBody(fileText: string, start: number, end: number): string {
  const all = fileText.split("\n");
  const realLines = all[all.length - 1] === "" ? all.length - 1 : all.length;
  const text = all.slice(start - 1, end).join("\n");
  return end >= realLines && fileText.endsWith("\n") ? `${text}\n` : text;
}

function next(body: Json): { tool: string; arguments: Json } | undefined {
  const limit = body["limit"] as Json | undefined;
  return (limit?.["next"] ?? body["next"]) as { tool: string; arguments: Json } | undefined;
}

// ---------------------------------------------------------------------------
// 1. CALIBRATION — the model against real responses.
// ---------------------------------------------------------------------------

describe("FX1 wire model: calibrated against real responses (drift fails by name)", () => {
  const PATHS = ["a.ts", "src/features/read/serve.ts", "packages/mcp-server/src/features/task-pack/a-rather-long-file-name.ts"];
  const WINDOWS: Array<[number, number]> = [[1, 20], [5, 5], [290, 300], [100, 140]];

  for (const rel of PATHS) {
    for (const [start, end] of WINDOWS) {
      it(`whole single-window response = model, exactly (${rel.length}-char path, ${start}-${end})`, async () => {
        const ws = freshWs("whole");
        const text = constFile(300);
        put(ws, rel, text);
        const { body, bytes } = await read(ws, { targets: [{ path: rel, range: `${start}-${end}` }], budget: { bytes: 6144 } });
        expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("read.text");
        expect(body["limit"], "the whole window must ship with no continuation").toBeUndefined();
        const expected = sliceWireEnvelopeBytes({ path: rel, totalLines: 300, rowRanges: [`${start}-${end}`], withSha: true })
          - 2 + jsonBytes(windowBody(text, start, end));
        expect(bytes).toBe(expected);
      });
    }
  }

  it("multi-window whole response = model, exactly (no top-level sha in the ranges[] shape)", async () => {
    const ws = freshWs("multi-whole");
    const text = constFile(300);
    put(ws, "src/mw.ts", text);
    const { body, bytes } = await read(ws, { targets: [{ path: "src/mw.ts", ranges: ["1-20", "250-260"] }], budget: { bytes: 6144 } });
    expect(body["kind"]).toBe("read.text");
    const expected = sliceWireEnvelopeBytes({ path: "src/mw.ts", totalLines: 300, rowRanges: ["1-20", "250-260"], withSha: false })
      - 4 + jsonBytes(windowBody(text, 1, 20)) + jsonBytes(windowBody(text, 250, 260));
    expect(bytes).toBe(expected);
  });

  for (const rel of PATHS) {
    it(`narrowed single-window page = model, exactly, cursor call included (${rel.length}-char path)`, async () => {
      const ws = freshWs("narrow");
      const text = wideFile(300);
      put(ws, rel, text);
      const { body, bytes } = await read(ws, { targets: [{ path: rel, range: "11-90" }], budget: { bytes: 2500 } });
      expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("read.text");
      const row = rows(body)[0]!;
      const [servedStart, servedEnd] = (row["range"] as string).split("-").map(Number) as [number, number];
      expect(servedStart).toBe(11);
      expect(servedEnd, "a 2500 B budget must narrow an ~7 KB window").toBeLessThan(90);
      const remaining = row["remaining"] as string[];
      expect(remaining).toEqual([`${servedEnd + 1}-90`]);
      const expected = sliceWireEnvelopeBytes({
        path: rel,
        totalLines: 300,
        rowRanges: [`${servedStart}-${servedEnd}`],
        withSha: true,
        continuation: { remaining, cwd: ws },
      }) - 2 + jsonBytes(windowBody(text, servedStart, servedEnd));
      expect(bytes).toBe(expected);
    });
  }

  it("narrowed multi-window page = model, exactly", async () => {
    const ws = freshWs("multi-narrow");
    const text = wideFile(300);
    put(ws, "src/mw.ts", text);
    const { body, bytes } = await read(ws, { targets: [{ path: "src/mw.ts", ranges: ["1-20", "250-260"] }], budget: { bytes: 1500 } });
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("read.text");
    const evidence = rows(body);
    const remaining = evidence[0]!["remaining"] as string[];
    const expected = sliceWireEnvelopeBytes({
      path: "src/mw.ts",
      totalLines: 300,
      rowRanges: evidence.map((row) => row["range"] as string),
      withSha: false,
      continuation: { remaining, cwd: ws },
    }) - 2 * evidence.length + evidence.reduce((sum, row) => sum + jsonBytes(row["body"] as string), 0);
    expect(bytes).toBe(expected);
  });

  it("the cursor token is exactly READ_CURSOR_TOKEN_CHARS (200) long, the handle HANDLE_ID_LENGTH, the short sha 19", async () => {
    const ws = freshWs("widths");
    put(ws, "src/w.ts", wideFile(300));
    const { body } = await read(ws, { targets: [{ path: "src/w.ts", range: "11-90" }], budget: { bytes: 2500 } });
    const call = next(body);
    expect(call, JSON.stringify(body).slice(0, 300)).toBeDefined();
    const cursor = call!.arguments["cursor"] as string;
    expect(cursor.startsWith("tlh_rreq_v1_")).toBe(true);
    expect(cursor.length).toBe(200);
    expect((rows(body)[0]!["handle"] as string).length).toBe(HANDLE_ID_LENGTH);
    expect((body["sha"] as string).length).toBe("sha256:".length + 12);
  });

  it("a lane echo rides the continuation and is counted (model = real, budget still respected)", async () => {
    const ws = freshWs("lane");
    const text = wideFile(300);
    put(ws, "src/l.ts", text);
    const { body, bytes } = await read(ws, { targets: [{ path: "src/l.ts", range: "11-90" }], budget: { bytes: 2500 }, lane: "swm-lane" });
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("read.text");
    const row = rows(body)[0]!;
    const [servedStart, servedEnd] = (row["range"] as string).split("-").map(Number) as [number, number];
    const remaining = row["remaining"] as string[];
    const expected = sliceWireEnvelopeBytes({
      path: "src/l.ts",
      totalLines: 300,
      rowRanges: [`${servedStart}-${servedEnd}`],
      withSha: true,
      continuation: { remaining, cwd: ws, lane: "swm-lane" },
    }) - 2 + jsonBytes(windowBody(text, servedStart, servedEnd));
    expect(bytes).toBe(expected);
    expect(bytes).toBeLessThanOrEqual(2500);
    expect(bytes / 2500, "a lane echo must not cost a whole extra line of fill").toBeGreaterThanOrEqual(0.85);
  });
});

// ---------------------------------------------------------------------------
// 2. THE REGRESSION — whole first, no note, never a refusal above the floor.
// ---------------------------------------------------------------------------

describe("FX1: a window that fits whole is served whole (v0.14.4), a narrowed one carries no note", () => {
  it("single window 1-20: every budget from 540 to 700 B, one byte at a time", async () => {
    const ws = freshWs("sweep");
    const text = constFile(300);
    const wholeBytes = sliceWireEnvelopeBytes({ path: "src/f000.ts", totalLines: 300, rowRanges: ["1-20"], withSha: true }) - 2 + jsonBytes(windowBody(text, 1, 20));
    // The smallest response that carries one line AND its continuation.
    const floorBytes = sliceWireEnvelopeBytes({
      path: "src/f000.ts", totalLines: 300, rowRanges: ["1-1"], withSha: true, continuation: { remaining: ["2-20"], cwd: ws },
    }) - 2 + jsonBytes(windowBody(text, 1, 1));

    let previousLines = 0;
    for (let budget = 540; budget <= 700; budget += 1) {
      const rel = `src/f${String(budget).padStart(3, "0")}.ts`; // a fresh file per call: no ledger receipt
      put(ws, rel, text);
      const { body, bytes } = await read(ws, { targets: [{ path: rel, range: "1-20" }], budget: { bytes: budget } });
      const where = `budget ${budget}: ${JSON.stringify(body).slice(0, 260)}`;
      if (budget >= wholeBytes) {
        // RULE 1 — whole first, exactly as v0.14.4.
        expect(body["kind"], where).toBe("read.text");
        expect(rows(body)[0]!["range"], where).toBe("1-20");
        expect(body["limit"], where).toBeUndefined();
        expect(body["note"], where).toBeUndefined();
        expect(linesServed(body), where).toBe(20);
      } else if (budget >= floorBytes) {
        // RULE 2 — narrowed, never refused while a line and its continuation fit.
        expect(body["kind"], where).toBe("read.text");
        expect((body["limit"] as Json)["cause"], where).toBe("wire");
        expect(rows(body)[0]!["remaining"], where).toBeDefined();
        expect(body["note"], `a budget cut carries no note — ${where}`).toBeUndefined();
        expect(bytes, where).toBeLessThanOrEqual(budget);
        expect(linesServed(body), where).toBeGreaterThanOrEqual(1);
      }
      if (body["kind"] === "read.text") {
        expect(bytes, where).toBeLessThanOrEqual(budget);
        expect(linesServed(body), `lines served must not shrink as the budget grows — ${where}`).toBeGreaterThanOrEqual(previousLines);
        previousLines = linesServed(body);
      }
    }
    expect(previousLines).toBe(20);
  });

  it("multi window [1-20, 250-260]: in caller order, whole at >= its size, no note, lines never shrink", async () => {
    const ws = freshWs("multi-sweep");
    const text = constFile(300);

    let previousLines = 0;
    for (let budget = 520; budget <= 1000; budget += 4) {
      const rel = `src/m${String(budget).padStart(4, "0")}.ts`;
      // Thresholds for THIS file: the path is repeated on every evidence row, so its length is part of the size.
      const wholeBytes = sliceWireEnvelopeBytes({ path: rel, totalLines: 300, rowRanges: ["1-20", "250-260"], withSha: false })
        - 4 + jsonBytes(windowBody(text, 1, 20)) + jsonBytes(windowBody(text, 250, 260));
      const floorBytes = sliceWireEnvelopeBytes({
        path: rel, totalLines: 300, rowRanges: ["1-1"], withSha: false, continuation: { remaining: ["2-20", "250-260"], cwd: ws },
      }) - 2 + jsonBytes(windowBody(text, 1, 1));
      put(ws, rel, text);
      const { body, bytes } = await read(ws, { targets: [{ path: rel, ranges: ["1-20", "250-260"] }], budget: { bytes: budget } });
      const where = `budget ${budget}: ${JSON.stringify(body).slice(0, 260)}`;
      if (budget >= wholeBytes) {
        expect(rows(body).map((row) => row["range"]), where).toEqual(["1-20", "250-260"]);
        expect(body["limit"], where).toBeUndefined();
      } else if (budget >= floorBytes) {
        expect(body["kind"], where).toBe("read.text");
        expect(body["note"], where).toBeUndefined();
        // In caller order: the first row always starts at the first window.
        expect((rows(body)[0]!["range"] as string).startsWith("1-"), where).toBe(true);
        // hop-0 partition: what shipped plus what `remaining` names is EXACTLY what was asked for.
        const shipped = new Set<number>();
        for (const row of rows(body)) {
          const [a, z] = (row["range"] as string).split("-").map(Number) as [number, number];
          for (let l = a; l <= z; l += 1) shipped.add(l);
        }
        const owed = new Set<number>();
        for (const window of (rows(body)[0]!["remaining"] as string[])) {
          const [a, z] = window.split("-").map(Number) as [number, number];
          for (let l = a; l <= z; l += 1) owed.add(l);
        }
        const wanted = new Set<number>([...Array.from({ length: 20 }, (_, i) => i + 1), ...Array.from({ length: 11 }, (_, i) => i + 250)]);
        expect([...shipped].filter((l) => owed.has(l)), `served and owed must be disjoint — ${where}`).toEqual([]);
        expect([...new Set([...shipped, ...owed])].sort((a, b) => a - b), where).toEqual([...wanted].sort((a, b) => a - b));
      }
      if (body["kind"] === "read.text") {
        expect(bytes, where).toBeLessThanOrEqual(budget);
        expect(linesServed(body), where).toBeGreaterThanOrEqual(previousLines);
        previousLines = linesServed(body);
      }
    }
    expect(previousLines).toBe(31);
  });

  it("the leftover room a whole window leaves is topped up with a whole-line PREFIX of the next window (never split below one line)", async () => {
    const ws = freshWs("topup");
    put(ws, "src/t.ts", wideFile(300));
    // Two windows of EQUAL size (server.ts orders windows by unserved lines, larger first, caller order on a tie):
    // W1 = 1-10 (~0.93 KB), W2 = 100-109 (~0.93 KB). 2000 B holds W1 whole and part of W2.
    const { body, bytes } = await read(ws, { targets: [{ path: "src/t.ts", ranges: ["1-10", "100-109"] }], budget: { bytes: 2000 } });
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("read.text");
    const evidence = rows(body);
    expect(evidence.map((row) => row["range"])[0]).toBe("1-10");
    expect(evidence).toHaveLength(2);
    const [secondStart, secondEnd] = (evidence[1]!["range"] as string).split("-").map(Number) as [number, number];
    expect(secondStart).toBe(100);
    expect(secondEnd, "part of window 2 shipped").toBeGreaterThan(100);
    expect(secondEnd, "but not all of it").toBeLessThan(109);
    expect(evidence[0]!["remaining"]).toEqual([`${secondEnd + 1}-109`]);
    expect(bytes).toBeLessThanOrEqual(2000);
    expect(bytes / 2000, "the room must actually be used").toBeGreaterThanOrEqual(0.85);
  });

  it("a note the whole serve carries (EOF clamp) is kept when it fits and dropped when the budget cuts the window", async () => {
    const ws = freshWs("eofnote");
    const text = constFile(300);
    put(ws, "src/e1.ts", text);
    put(ws, "src/e2.ts", text);
    const whole = await read(ws, { targets: [{ path: "src/e1.ts", range: "250-340" }], budget: { bytes: 6144 } });
    expect(whole.body["kind"]).toBe("read.text");
    expect(String(whole.body["note"])).toContain("exceeds end of file");
    expect(rows(whole.body)[0]!["range"]).toBe("250-300");

    const cut = await read(ws, { targets: [{ path: "src/e2.ts", range: "250-340" }], budget: { bytes: 900 } });
    expect(cut.body["kind"], JSON.stringify(cut.body).slice(0, 300)).toBe("read.text");
    expect(cut.body["note"], "a budget cut ships no prose (the ladder's first rung sheds it before any line)").toBeUndefined();
    const owed = (rows(cut.body)[0]!["remaining"] as string[]);
    expect(owed[owed.length - 1]!.endsWith("-300"), "the EOF clamp is explicit in `remaining`").toBe(true);
  });

  it("chains follow `next` verbatim to the end: every hop <= budget, every requested line delivered exactly once", async () => {
    for (const budget of [700, 900, 1024, 2048, 6144]) {
      const ws = freshWs(`chain-${budget}`);
      const text = wideFile(300);
      put(ws, "src/c.ts", text);
      let response = await read(ws, { targets: [{ path: "src/c.ts", range: "11-90" }], budget: { bytes: budget } });
      const seen = new Map<number, number>();
      for (let hop = 0; hop < 100; hop += 1) {
        const where = `budget ${budget} hop ${hop}: ${JSON.stringify(response.body).slice(0, 240)}`;
        expect(response.body["kind"], where).toBe("read.text");
        expect(response.bytes, where).toBeLessThanOrEqual(budget);
        for (const row of rows(response.body)) {
          const [a, z] = (row["range"] as string).split("-").map(Number) as [number, number];
          for (let l = a; l <= z; l += 1) seen.set(l, (seen.get(l) ?? 0) + 1);
        }
        const call = next(response.body);
        if (call === undefined) break;
        // AGENTS.md: run `next` verbatim; the declared budget is re-declared exactly as the caller would.
        response = await read(ws, { ...call.arguments, budget: { bytes: budget } });
      }
      const missing = Array.from({ length: 80 }, (_, i) => i + 11).filter((l) => !seen.has(l));
      expect(missing, `budget ${budget}: lines never delivered`).toEqual([]);
      expect([...seen.entries()].filter(([, count]) => count > 1).map(([line]) => line), `budget ${budget}: duplicated lines`).toEqual([]);
    }
  }, 120_000);

  it("a budget.tokens declaration sizes exactly like the equivalent bytes", async () => {
    const ws = freshWs("tokens");
    put(ws, "src/k.ts", wideFile(300));
    const tokens = 400;
    const { body, bytes } = await read(ws, { targets: [{ path: "src/k.ts", range: "11-90" }], budget: { tokens } });
    expect(body["kind"], JSON.stringify(body).slice(0, 300)).toBe("read.text");
    expect(bytes).toBeLessThanOrEqual(estimateBytesFromTokens(tokens)!);
    expect(linesServed(body)).toBeGreaterThanOrEqual(1);
    expect(linesServed(body), "the window is ~7 KB and the token budget far below it").toBeLessThan(80);
  });
});

// ---------------------------------------------------------------------------
// 3. WHERE THE WIRE BODY CANNOT BE PREDICTED, v0.14.4 IS PRESERVED.
// ---------------------------------------------------------------------------

describe("FX1: a body the wire may rewrite is served as v0.14.4 served it (the ladder measures the real bytes)", () => {
  it("a window whose doc comments elide ships faithful segments; when they do not fit, the chain pages them — never a refusal, every code line exactly once", async () => {
    const ws = freshWs("elide");
    const doc = Array.from({ length: 12 }, (_, i) => `/**\n * Doc for item ${i}.\n * More text here.\n */\nexport const D${i} = ${i};`).join("\n") + "\n";
    put(ws, "src/doc.ts", doc);
    // The response that would carry the RAW 30 lines (60-line file): more than 480 B.
    const rawResponseBytes = sliceWireEnvelopeBytes({ path: "src/doc.ts", totalLines: 60, rowRanges: ["1-30"], withSha: true })
      - 2 + jsonBytes(windowBody(doc, 1, 30));
    expect(rawResponseBytes).toBeGreaterThan(480);
    // TL-REVIEW-2 (2026-10-06): v0.14.4 served the marker DISPLAY whole here
    // (`range:"1-30"` over a 12-line body whose markers stood for the six
    // comment blocks — line N of that body was not source line N). Bodies are
    // now the source's own ranges, so 1-30 ships as six one-line code
    // segments (5, 10, …, 30) with the blocks disclosed in `elided`. That
    // faithful shape costs more than the marker display for THIS pathological
    // fixture (a 4-line block before every single code line): at 480 B not
    // even its smallest page fits, and the answer is the honest, actionable
    // `budget-below-minimum` naming the exact floor — never a lossy page and
    // never `cap-exceeded`.
    const tight = await read(ws, { targets: [{ path: "src/doc.ts", range: "1-30" }], budget: { bytes: 480 } });
    expect(tight.body["kind"], JSON.stringify(tight.body).slice(0, 300)).toBe("refusal");
    expect(tight.body["code"]).toBe("budget-below-minimum");
    const floor = tight.body["required_min_bytes"] as number;
    expect(floor).toBeGreaterThan(480);

    // At a budget a page fits, the window degrades to a cursor chain (whole
    // trailing segments are dropped, rung 5 / the staged fit) — every hop
    // within budget, every code line delivered exactly once, the comment
    // blocks never served nor owed, and their windows disclosed.
    const budget = Math.max(floor, 800);
    let response = await read(ws, { targets: [{ path: "src/doc.ts", range: "1-30" }], budget: { bytes: budget } });
    const seen = new Map<number, number>();
    const elided = new Set<string>();
    for (let hop = 0; hop < 20; hop += 1) {
      const where = `hop ${hop}: ${JSON.stringify(response.body).slice(0, 300)}`;
      expect(response.body["kind"], where).toBe("read.text");
      expect(response.bytes, where).toBeLessThanOrEqual(budget);
      for (const row of rows(response.body)) {
        expect(String(row["body"] ?? ""), where).not.toContain("doc elided");
        for (const window of (row["elided"] as string[] | undefined) ?? []) elided.add(window);
        if (typeof row["body"] !== "string") continue;
        const [a, z] = (row["range"] as string).split("-").map(Number) as [number, number];
        for (let l = a; l <= z; l += 1) seen.set(l, (seen.get(l) ?? 0) + 1);
      }
      const call = next(response.body);
      if (call === undefined) break;
      response = await read(ws, { ...call.arguments, budget: { bytes: budget } });
    }
    expect([...seen.keys()].sort((a, b) => a - b)).toEqual([5, 10, 15, 20, 25, 30]);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
    expect([...elided].sort()).toEqual(["1-4", "11-14", "16-19", "21-24", "26-29", "6-9"]);
  });
});

describe("FX1: a server-composed member the model cannot see defers to v0.14.4 (TL_BATCH_HINTS)", () => {
  it("with the serial-slice hint flag ON, a second narrow read of a file is served (as v0.14.4 served it), never refused", async () => {
    // A REAL stdio server: the flag is latched at server start, so an in-process env flip would prove nothing.
    // The child copies `process.env` at spawn, so the flag is restored as soon as it has been spawned.
    const previous = process.env["TL_BATCH_HINTS"];
    process.env["TL_BATCH_HINTS"] = "1";
    const ws = freshWs("hints");
    const text = constFile(300);
    const budgets = [700, 720, 740, 760, 780, 800, 900, 1000];
    budgets.forEach((_, index) => put(ws, `src/h${index}.ts`, text));
    let server: ServerHandle;
    try {
      server = startDevServer(ws, "default");
    } finally {
      if (previous === undefined) delete process.env["TL_BATCH_HINTS"];
      else process.env["TL_BATCH_HINTS"] = previous;
    }
    servers.push(server);
    await server.initialize();

    // The hint rides only on the SECOND read of a path (exactly one served cluster held), so each budget gets a
    // fresh file: the wire bytes are knife-edge in the path and workspace length, and one budget alone could pass by luck.
    for (const [index, budget] of budgets.entries()) {
      const rel = `src/h${index}.ts`;
      const first = await server.callTool("tl_read_file", { targets: [{ path: rel, range: "250-260" }], cwd: ws });
      expect(first.body["kind"]).toBe("read.text");
      const second = await server.callTool("tl_read_file", { targets: [{ path: rel, range: "1-40" }], budget: { bytes: budget }, cwd: ws });
      const bytes = Buffer.byteLength(JSON.stringify(second.body), "utf8");
      expect(second.body["kind"], `budget ${budget}: ${JSON.stringify(second.body).slice(0, 260)}`).toBe("read.text");
      expect(bytes, `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 4. THE SYMBOL BRANCH shares the rule (direct: no protocol context).
// ---------------------------------------------------------------------------

describe("FX1: resolveSlice's symbol branch — whole first, then a note-less trimmed head", () => {
  const fn = (name: string, n: number): string => [
    `export function ${name}(x: number): number {`,
    ...Array.from({ length: n }, (_, i) => `  const v${i} = x * ${i + 2} + ${i};`),
    "  return x;",
    "}",
    "",
  ].join("\n");
  const source = [fn("alpha", 6), fn("beta", 14), fn("gamma", 40)].join("\n");

  it("a symbol whose whole response fits the declared budget is untouched (not truncated, no downgrade)", async () => {
    const ws = freshWs("sym-whole");
    put(ws, "src/f.ts", source);
    const result = await resolveSlice(ws, "src/f.ts", source, "beta", undefined, 1024);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.truncated).toBe(false);
    expect(result.data.downgraded_from).toBeUndefined();
  });

  it("a symbol that does not fit is trimmed to whole lines with NO note, and never to zero lines", async () => {
    const ws = freshWs("sym-narrow");
    put(ws, "src/f.ts", source);
    for (const budget of [1100, 800, 600, 200]) {
      const result = await resolveSlice(ws, "src/f.ts", source, "gamma", undefined, budget);
      expect(result.ok, `budget ${budget}`).toBe(true);
      if (!result.ok) continue;
      expect(result.data.truncated, `budget ${budget}`).toBe(true);
      expect(result.data.downgraded_from).toBe("symbol");
      expect(result.data.note, `budget ${budget}: a budget cut carries no note`).toBeUndefined();
      const head = result.data.content;
      expect(head.length, `budget ${budget}: never an empty head`).toBeGreaterThan(0);
      // whole lines of the assembled view: no line was cut in the middle.
      for (const line of head.split("\n")) expect(source.includes(line), `budget ${budget}: "${line}" is not a verbatim source line`).toBe(true);
    }
  });

  it("no explicit budget, or one at/above the fixed cap, is byte-identical to before (the fixed-cap path is untouched)", async () => {
    const ws = freshWs("sym-fixed");
    put(ws, "src/f.ts", source);
    const none = await resolveSlice(ws, "src/f.ts", source, "gamma");
    const wide = await resolveSlice(ws, "src/f.ts", source, "gamma", undefined, 1_000_000);
    expect(none.ok && wide.ok).toBe(true);
    if (!none.ok || !wide.ok) return;
    expect(wide.data.content).toBe(none.data.content);
    expect(wide.data.truncated).toBe(none.data.truncated);
  });
});

describe("FX1: sizing constants", () => {
  it("the margin stays the same order as the page chooser's own slack (a hop-0 page and every later cursor page fill alike)", () => {
    expect(SLICE_SIZING_MARGIN_BYTES).toBeGreaterThanOrEqual(32);
    expect(SLICE_SIZING_MARGIN_BYTES).toBeLessThanOrEqual(96);
  });
});
