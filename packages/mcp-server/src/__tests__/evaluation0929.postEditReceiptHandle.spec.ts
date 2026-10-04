/**
 * evaluation0929.postEditReceiptHandle.spec.ts — FX2 (eval-0929 fix wave,
 * 2026-09-30): a post-edit `read.receipt` names the handle the H4 refresh KEPT,
 * never a second id for the same symbol.
 *
 * WHAT THIS PINS. serverSideFixesP2.spec.ts's H4 says: mint a symbol handle,
 * edit THROUGH it, re-read the same symbol -> the SAME id. `withHandleAugment`
 * (server.ts) re-keys the driving handle in place (`handleTable.refreshSha`, sha
 * over the post-edit `getSymbolWithContext` code, range recomputed), and the
 * re-read's canonical-key upsert lands on it. That was proven on the fresh
 * `read.text` serve only, because before PEW a re-read after an edit always
 * re-served. PEW (`tl_edit_file` -> `applied[].after`, booked in the served-range
 * ledger as mode `edit-after`) legitimately turns that re-read into a
 * `read.receipt` (orchestrator ruling: the bytes reached the client in `after`)
 * — so the invariant must also hold on the RECEIPT path, whose handle rides
 * `receipt.handle` (no `evidence[]`). For a non-tiny file the three producers of
 * a symbol handle key — the H4 refresh, the fresh `mode=symbol` serve and the W1
 * receipt — build the same (kind, path, range, symbol, sha) tuple; this file pins
 * that they stay in lockstep, per language shape and per read door.
 *
 * Sections:
 *   1. handle-driven edit -> every symbol door answers a receipt naming h1
 *      (TS function, TS class method, Python def; legacy `mode=symbol`,
 *      canonical `targets[{path,symbol}]`, canonical `targets[{handle}]`),
 *      `served_by` names the edit, and no second id is minted.
 *   2. the fresh arm (`force_serve`) and the receipt arm name ONE id.
 *   3. an id survives repeated edit -> re-read cycles (H4 chain).
 *   4. CONTROL — a path-driven edit refreshes no handle, yet the receipt still
 *      names a handle that addresses the CURRENT bytes (a follow-up edit through
 *      it applies), and a repeat re-read names the same id.
 *   5. CONTROL — a symbol the edit's own window does not cover is not receipted:
 *      the fresh serve still names h1 (PEW left H4's text arm untouched).
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { resetAll } from "../util/session.js";
import { handleTable } from "../util/handles.js";

type ToolResult = { content: Array<{ text: string }> };
type Body = Record<string, any>;

const workspaces: string[] = [];

function makeWorkspace(tag: string): string {
  const ws = mkdtempSync(join(homedir(), `.tl-e0929-prh-${tag}-`));
  workspaces.push(ws);
  return ws;
}

function writeSource(workspace: string, relPath: string, content: string): void {
  const abs = join(workspace, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function readSource(workspace: string, relPath: string): string {
  return readFileSync(join(workspace, relPath), "utf8");
}

function parseResult(result: ToolResult): Body {
  const text = result.content[0]?.text;
  if (typeof text !== "string") throw new Error("tool result carried no text");
  return JSON.parse(text) as Body;
}

// ---------------------------------------------------------------------------
// Setup — ALLOW_WRITE is a module-level const server.ts reads once from
// process.argv at import time (same constraint evaluation0929.postEditWindow
// documents): push the flag, THEN dynamically import.
// ---------------------------------------------------------------------------

let callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

beforeAll(async () => {
  if (!process.argv.includes("--allow-write")) process.argv.push("--allow-write");
  const server = await import("../server.js");
  callTool = server.callTool as typeof callTool;
});

afterEach(() => {
  resetAll();
  handleTable.reset();
  for (const ws of workspaces.splice(0)) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// Fixtures — every symbol sits in a file over TINY_BYTES/TINY_LINES so a symbol
// read mints a kind:"symbol" handle (a tiny file mints a whole-file range handle
// on the fresh route instead — a separate route this file does not pin), and far
// enough from both file edges that the edit's ±20 window is not clipped.
// ---------------------------------------------------------------------------

function filler(lines: number, marker: string): string {
  return Array.from({ length: lines }, (_, i) => `${marker} filler line ${i} padding padding padding`).join("\n");
}

interface Shape {
  label: string;
  file: string;
  source: string;
  symbol: string;
  search: string;
  replace: string;
  /** The follow-up edit of cycle 2/3 and the control: `replace` -> `again`. */
  again: string;
}

const SHAPES: Shape[] = [
  {
    label: "TS function",
    file: "src/big.ts",
    source: [filler(300, "//"), "export function target(a: number): number {", "  return a + 1;", "}", filler(300, "//")].join("\n") + "\n",
    symbol: "target",
    search: "return a + 1;",
    replace: "return a + 2;",
    again: "return a + 3;",
  },
  {
    label: "TS class method",
    file: "src/big.ts",
    source: [filler(300, "//"), "export class Calc {", "  add(a: number): number {", "    return a + 1;", "  }", "}", filler(300, "//")].join("\n") + "\n",
    symbol: "add",
    search: "return a + 1;",
    replace: "return a + 2;",
    again: "return a + 3;",
  },
  {
    label: "Python def",
    file: "src/big.py",
    source: [filler(300, "#"), "def target(a):", "    return a + 1", "", filler(300, "#")].join("\n") + "\n",
    symbol: "target",
    search: "return a + 1",
    replace: "return a + 2",
    again: "return a + 3",
  },
];

/** The read doors that address a symbol handle's own bytes (the natural re-read of an edited symbol). */
const DOORS: Array<{ label: string; args: (shape: Shape, h1: string) => Record<string, unknown> }> = [
  { label: "legacy mode=symbol", args: (s) => ({ mode: "symbol", path: s.file, symbol: s.symbol }) },
  { label: "canonical targets[{path,symbol}]", args: (s) => ({ targets: [{ path: s.file, symbol: s.symbol }] }) },
  { label: "canonical targets[{handle}]", args: (_s, h1) => ({ targets: [{ handle: h1 }] }) },
];

async function mintSymbolHandle(ws: string, shape: Shape): Promise<string> {
  const mint = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: shape.file, symbol: shape.symbol }));
  expect(mint["kind"], JSON.stringify(mint)).toBe("read.text");
  const h1 = String(mint["evidence"]?.[0]?.handle);
  expect(h1).toMatch(/^h[0-9a-z]+$/);
  expect(handleTable.get(h1)?.kind).toBe("symbol");
  return h1;
}

function afterBodyOf(edit: Body): string {
  return String(edit["applied"]?.[0]?.["after"]?.["body"]);
}

// ---------------------------------------------------------------------------
// 1. Handle-driven edit -> receipt names h1, on every door and every shape.
// ---------------------------------------------------------------------------

describe("FX2 1: a post-edit symbol receipt names the handle the H4 refresh kept", () => {
  for (const shape of SHAPES) {
    it(`${shape.label}: every door answers a receipt whose handle is h1, served_by names the edit, no second id is minted`, async () => {
      const ws = makeWorkspace("doors");
      writeSource(ws, shape.file, shape.source);
      const h1 = await mintSymbolHandle(ws, shape);

      const edit = parseResult(await callTool("tl_edit_file", { cwd: ws, handle: h1, search: shape.search, replace: shape.replace }));
      expect(edit["kind"], JSON.stringify(edit)).toBe("edit.applied");
      // PEW carried the window (the reason a receipt is honest) and the edit's own handle IS h1.
      expect(afterBodyOf(edit)).toContain(shape.replace);
      expect(edit["applied"]?.[0]?.["handle"]).toBe(h1);
      expect(readSource(ws, shape.file)).toContain(shape.replace);

      const idsBefore = handleTable.size();
      for (const door of DOORS) {
        const reread = parseResult(await callTool("tl_read_file", { cwd: ws, ...door.args(shape, h1) }));
        const where = `${shape.label} / ${door.label}`;
        expect(reread["kind"], `${where}: ${JSON.stringify(reread)}`).toBe("read.receipt");
        expect(reread["receipt"]?.["receipt"], where).toBe("code-unchanged");
        expect(reread["receipt"]?.["handle"], where).toBe(h1);
        expect(String(reread["receipt"]?.["served_by"]), where).toMatch(/^edit-after \d+-\d+ \(call #\d+\)$/);
      }
      // No door minted a second id for the symbol (the handle table did not grow).
      expect(handleTable.size()).toBe(idsBefore);
      // h1 still addresses the symbol, re-keyed in place by the edit (not replaced).
      expect(handleTable.get(h1)).toMatchObject({ kind: "symbol", path: shape.file, symbol: shape.symbol });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The fresh arm and the receipt arm agree.
// ---------------------------------------------------------------------------

describe("FX2 2: the fresh serve and the receipt name ONE id", () => {
  it("force_serve re-reads the edited symbol as read.text under h1, and the plain re-read is a receipt under the same h1", async () => {
    const shape = SHAPES[0]!;
    const ws = makeWorkspace("arms");
    writeSource(ws, shape.file, shape.source);
    const h1 = await mintSymbolHandle(ws, shape);
    const edit = parseResult(await callTool("tl_edit_file", { cwd: ws, handle: h1, search: shape.search, replace: shape.replace }));
    expect(edit["kind"], JSON.stringify(edit)).toBe("edit.applied");

    const fresh = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: shape.file, symbol: shape.symbol, force_serve: true }));
    expect(fresh["kind"], JSON.stringify(fresh)).toBe("read.text");
    expect(fresh["evidence"]?.[0]?.handle).toBe(h1);
    expect(String(fresh["evidence"]?.[0]?.body)).toContain(shape.replace);

    const receipt = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: shape.file, symbol: shape.symbol }));
    expect(receipt["kind"], JSON.stringify(receipt)).toBe("read.receipt");
    expect(receipt["receipt"]?.["handle"]).toBe(h1);
  });
});

// ---------------------------------------------------------------------------
// 3. The id survives repeated edit -> re-read cycles.
// ---------------------------------------------------------------------------

describe("FX2 3: repeated edit -> re-read cycles keep naming the same id (H4 chain)", () => {
  it("edit through h1, re-read (receipt h1), edit through h1 again, re-read (receipt h1)", async () => {
    const shape = SHAPES[0]!;
    const ws = makeWorkspace("chain");
    writeSource(ws, shape.file, shape.source);
    const h1 = await mintSymbolHandle(ws, shape);

    const first = parseResult(await callTool("tl_edit_file", { cwd: ws, handle: h1, search: shape.search, replace: shape.replace }));
    expect(first["kind"], JSON.stringify(first)).toBe("edit.applied");
    const reread1 = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: shape.file, symbol: shape.symbol }));
    expect(reread1["kind"], JSON.stringify(reread1)).toBe("read.receipt");
    expect(reread1["receipt"]?.["handle"]).toBe(h1);

    const second = parseResult(await callTool("tl_edit_file", { cwd: ws, handle: h1, search: shape.replace, replace: shape.again }));
    expect(second["kind"], JSON.stringify(second)).toBe("edit.applied");
    expect(afterBodyOf(second)).toContain(shape.again);
    const reread2 = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: shape.file, symbol: shape.symbol }));
    expect(reread2["kind"], JSON.stringify(reread2)).toBe("read.receipt");
    expect(reread2["receipt"]?.["handle"]).toBe(h1);
    expect(String(reread2["receipt"]?.["served_by"])).toMatch(/^edit-after /);
    expect(readSource(ws, shape.file)).toContain(shape.again);
  });
});

// ---------------------------------------------------------------------------
// 4. CONTROL — path-driven edit: no refresh, but the receipt's handle is current.
// ---------------------------------------------------------------------------

describe("FX2 4: CONTROL — a path-driven edit (no handle refreshed) still gets a receipt handle that addresses the current bytes", () => {
  for (const shape of SHAPES) {
    it(`${shape.label}: the receipt's handle accepts a follow-up edit (never stale) and a repeat re-read names it again`, async () => {
      const ws = makeWorkspace("path");
      writeSource(ws, shape.file, shape.source);
      await mintSymbolHandle(ws, shape);

      const edit = parseResult(await callTool("tl_edit_file", { cwd: ws, path: shape.file, search: shape.search, replace: shape.replace }));
      expect(edit["kind"], JSON.stringify(edit)).toBe("edit.applied");

      const reread = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: shape.file, symbol: shape.symbol }));
      expect(reread["kind"], JSON.stringify(reread)).toBe("read.receipt");
      const handle = String(reread["receipt"]?.["handle"]);
      expect(handle).toMatch(/^h[0-9a-z]+$/);

      // A repeat re-read names the SAME id and mints nothing.
      const idsBefore = handleTable.size();
      const again = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: shape.file, symbol: shape.symbol }));
      expect(again["kind"], JSON.stringify(again)).toBe("read.receipt");
      expect(again["receipt"]?.["handle"]).toBe(handle);
      expect(handleTable.size()).toBe(idsBefore);

      // The handle addresses the CURRENT bytes: an edit through it applies.
      const followUp = parseResult(await callTool("tl_edit_file", { cwd: ws, handle, search: shape.replace, replace: shape.again }));
      expect(followUp["kind"], JSON.stringify(followUp)).toBe("edit.applied");
      expect(readSource(ws, shape.file)).toContain(shape.again);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. CONTROL — a symbol the edit's window does not cover is not receipted.
// ---------------------------------------------------------------------------

describe("FX2 5: CONTROL — an edit deep inside a class wider than PEW's window leaves the class re-read a fresh serve under h1", () => {
  it("class re-read is read.text with evidence[0].handle === h1 and the new body", async () => {
    // ~8.8 KB of class body: under the symbol serve cap (24 KiB) so it is served whole,
    // over PEW's 6 KiB per-hunk cap so no enclosing-symbol extension can cover it either.
    const methods = Array.from({ length: 220 }, (_, i) => `  m${i}(): number {\n    return ${i};\n  }`);
    const source = [
      filler(300, "//"),
      "export class Wide {",
      ...methods,
      "}",
      filler(300, "//"),
    ].join("\n") + "\n";
    const ws = makeWorkspace("wide");
    writeSource(ws, "src/wide.ts", source);
    const wide: Shape = { label: "wide class", file: "src/wide.ts", source, symbol: "Wide", search: "return 110;", replace: "return 1100;", again: "return 1101;" };
    const h1 = await mintSymbolHandle(ws, wide);

    const edit = parseResult(await callTool("tl_edit_file", { cwd: ws, handle: h1, search: wide.search, replace: wide.replace }));
    expect(edit["kind"], JSON.stringify(edit)).toBe("edit.applied");
    expect(afterBodyOf(edit)).toContain(wide.replace);

    const reread = parseResult(await callTool("tl_read_file", { cwd: ws, mode: "symbol", path: wide.file, symbol: wide.symbol }));
    expect(reread["kind"], JSON.stringify(reread).slice(0, 400)).toBe("read.text");
    expect(reread["evidence"]?.[0]?.handle).toBe(h1);
    expect(String(reread["evidence"]?.[0]?.body)).toContain(wide.replace);
  });
});
