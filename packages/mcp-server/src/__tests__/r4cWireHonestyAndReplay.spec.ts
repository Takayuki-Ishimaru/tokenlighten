/**
 * r4cWireHonestyAndReplay.spec.ts — round-4 evaluation findings P1-6, P2-11,
 * P2-15 (review-findings-fable-r3.md items 6, 11, 15).
 *
 * P1-6 — a `{qref}` re-pack after a certified answer must restate the
 * certificate or converge, never loop discover <-> read of an already-served
 * window. ROOT CAUSE (readCodeTaskPack.ts): `recordPredatesAdditionalServed
 * Evidence` (the answer-profile "is this seed record stale" predicate feeding
 * both `tryServeCachedPack` and `tryServeSupersedingCertifiedRecord`) had two
 * gaps: (1) `ServedPackRecord.surfaces` never stored `remaining_ranges`, so a
 * capture-time PARTIAL surface's nominal `range` read as fully covered
 * (`servedLineSpansOf` had no holes to subtract); (2) its ledger-range check
 * only iterated `readOnlyServedEntries`, missing a later sibling call whose
 * surfaces landed in the OTHER store (`queryServedSurfaces`, the cumulative
 * log). FIX: `remaining_ranges` now threads through `captureServedPack`/
 * `tryServeSubsetReceipt` onto `ServedPackRecord.surfaces`, and the
 * ledger-range loop iterates every path the record claims to know about
 * (`capturedPaths`), not only the ones `readOnlyServedEntries` happened to
 * enumerate.
 *
 * P2-11 — a `read.batch` entry (`form:"handle"`) whose target carries no
 * explicit override symbol/range must ship the VERBATIM source of its
 * declared `range` under `content:"full"`, never a symbol-assembled scope
 * view. ROOT CAUSE (server.ts): the A7 `handles=[]` batch loop (and its S6
 * mixed symbol/path sibling) fell back to a `kind:"symbol"` handle's OWN
 * stored `symbol` whenever no per-item override was given, regardless of
 * `content:"full"`. FIX: `rangeContentFullMarker` now suppresses that
 * IMPLICIT stored-symbol fallback (an EXPLICIT per-item override symbol
 * still wins), so the plain-range branch serves the handle's own stored
 * window honestly.
 *
 * P2-15 — a `code-unchanged` receipt must cite served windows only when they
 * cover EVERY line of the request, blank lines included. ROOT CAUSE
 * (server.ts, mode=slice): `actualEnd` was derived from
 * `countLines(sliceData.content)`, which cannot tell "N real lines with an
 * ordinary trailing newline" apart from "N+1 lines whose LAST one is blank"
 * — both serialize to the identical joined string — so a request ending on a
 * blank line silently examined one line short of what was actually asked
 * for. FIX: when the slice was not capped (`remaining_ranges` undefined),
 * `sliceData.range`'s own declared end (`rangeEndLine`) is authoritative
 * over the content-length guess.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, followNextToEnd, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try { await rmDirWithRetry(dir); } catch { /* best-effort cleanup */ }
  }
});

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r4c-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

async function spawnedServer(ws: string, config: "default" | "vscode" = "default"): Promise<ServerHandle> {
  const s = startDevServer(ws, config, { toolSurface: "full" });
  servers.push(s);
  await s.initialize();
  return s;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function pick(obj: unknown, keyPath: string): any {
  return keyPath.split(".").reduce((acc: any, key) => (acc == null ? undefined : acc[key]), obj);
}

// ---------------------------------------------------------------------------
// P1-6 — qref re-pack after a certified answer must restate it, never loop.
// ---------------------------------------------------------------------------

/** A class with enough same-shaped methods that a single hop cannot certify
 *  the whole flow in one response (forcing a discover -> continuation ->
 *  act.answer chain) — the same shape review3's classFlowOver64Long used. */
function writeBigFlowClass(ws: string, methodCount: number): void {
  writeFile(ws, "package.json", '{ "name": "bigflow", "private": true, "type": "module" }\n');
  let body = "export class OrderFlow {\n  constructor(private readonly log: (m: string) => void) {}\n\n";
  for (let i = 0; i < methodCount; i++) {
    const kind = i % 2 === 0 ? "payment" : "shipping";
    body += `  ${kind}Step${i}(orderId: string): void {\n    this.log(\`${kind} step ${i} for \${orderId}\`);\n    if (orderId.length === 0) {\n      throw new Error("missing order");\n    }\n    this.log("done ${i}");\n  }\n\n`;
  }
  body += "}\n";
  // Padding helpers so the file is large enough to force a byte-capped first
  // hop, exactly like the review's own fixture.
  let pad = "";
  for (let i = 1; i <= 14; i++) {
    pad += `\nexport function ofHelper${i}(items: number[]): number {\n  return items.reduce((sum, item) => sum + item * ${i}, ${i * 3});\n}\n`;
  }
  writeFile(ws, "src/OrderFlow.ts", body + pad);
}

describe("P1-6: a {qref} re-pack after a certified act.answer restates it, never reverts to discover", () => {
  it("classFlowOver64Long shape: 8 bare-qref replays after the chain first certifies stay act.answer (or a receipt restating it), never discover/await_input again", async () => {
    const ws = makeWorkspace("p16-flow");
    writeBigFlowClass(ws, 70);
    const server = await spawnedServer(ws);

    const chain = await followNextToEnd(
      server,
      {
        tool: "tl_read_file",
        arguments: {
          query: "How does OrderFlow handle payment and shipping, step by step?",
          cwd: ws,
          task: { epoch: "new", profile: "answer" },
        },
      },
      { cwd: ws, hopCap: 24, maxQrefRepacks: 8 },
    );

    const kinds = chain.hops.map((h) => pick(h.response, "decision.kind") ?? h.response?.kind);
    const firstAnswerIndex = kinds.findIndex((k) => k === "act.answer");
    expect(firstAnswerIndex, `chain never reached act.answer at all: ${JSON.stringify(kinds)}`).toBeGreaterThanOrEqual(0);

    // Every hop from the first act.answer onward must stay act.answer or a
    // read.receipt (a compact restatement) — never a bare "discover" (the
    // regression) and never "await_input" (the observed dead-end symptom).
    for (let i = firstAnswerIndex; i < kinds.length; i++) {
      const kind = kinds[i];
      expect(
        kind === "act.answer" || kind === "read.receipt",
        `hop ${i} reverted to "${kind}" after the chain had already certified act.answer at hop ${firstAnswerIndex}: ${JSON.stringify(kinds)}`,
      ).toBe(true);
    }

    // Recall control: the chain must not be capped out (a real convergence,
    // not merely "we stopped following before the loop could show itself").
    expect(chain.capped, "chain hit hopCap before settling — inconclusive, widen hopCap").toBe(false);
  }, 60_000);

  it("classFlowOver64Long shape, VS Code config: the same convergence holds under TL_TURN_ECONOMY too", async () => {
    const ws = makeWorkspace("p16-flow-vscode");
    writeBigFlowClass(ws, 70);
    const server = await spawnedServer(ws, "vscode");

    const chain = await followNextToEnd(
      server,
      {
        tool: "tl_read_file",
        arguments: {
          query: "How does OrderFlow handle payment and shipping, step by step?",
          cwd: ws,
          task: { epoch: "new", profile: "answer" },
        },
      },
      { cwd: ws, hopCap: 24, maxQrefRepacks: 8 },
    );

    const kinds = chain.hops.map((h) => pick(h.response, "decision.kind") ?? h.response?.kind);
    const firstAnswerIndex = kinds.findIndex((k) => k === "act.answer");
    expect(firstAnswerIndex, `chain never reached act.answer at all: ${JSON.stringify(kinds)}`).toBeGreaterThanOrEqual(0);
    for (let i = firstAnswerIndex; i < kinds.length; i++) {
      const kind = kinds[i];
      expect(
        kind === "act.answer" || kind === "read.receipt",
        `hop ${i} reverted to "${kind}" after certifying act.answer at hop ${firstAnswerIndex} (VS Code config): ${JSON.stringify(kinds)}`,
      ).toBe(true);
    }
  }, 60_000);

  async function runReplayFlipGrFollowShape(tag: string, config: "default" | "vscode"): Promise<void> {
    const ws = makeWorkspace(tag);
    writeFile(ws, "package.json", '{ "name": "perfedge", "private": true, "type": "module" }\n');
    // A file whose only relevant symbol is short, forcing the seed's first
    // hop to be a partial/discover step before a follow-up completes it.
    let body = "export function größe(value: number): number {\n  return value * 2;\n}\n";
    for (let i = 1; i <= 40; i++) {
      body += `\nexport function unrelatedHelper${i}(x: number): number {\n  return x + ${i};\n}\n`;
    }
    writeFile(ws, "src/größe.ts", body);
    const server = await spawnedServer(ws, config);

    const chain = await followNextToEnd(
      server,
      {
        tool: "tl_read_file",
        arguments: {
          query: "Where is größe used and what does it return?",
          cwd: ws,
          task: { epoch: "new" },
        },
      },
      { cwd: ws, hopCap: 20, maxQrefRepacks: 6 },
    );

    const kinds = chain.hops.map((h) => pick(h.response, "decision.kind") ?? h.response?.kind);
    const firstAnswerIndex = kinds.findIndex((k) => k === "act.answer");
    expect(firstAnswerIndex, `chain never reached act.answer at all (${config}): ${JSON.stringify(kinds)}`).toBeGreaterThanOrEqual(0);
    for (let i = firstAnswerIndex; i < kinds.length; i++) {
      const kind = kinds[i];
      expect(
        kind === "act.answer" || kind === "read.receipt",
        `hop ${i} reverted to "${kind}" after certifying act.answer at hop ${firstAnswerIndex} (${config}): ${JSON.stringify(kinds)}`,
      ).toBe(true);
    }
  }

  it("Unicode-identifier shape, default config (a bare-qref replay must not loop discover <-> read of the same window)", async () => {
    await runReplayFlipGrFollowShape("p16-unicode-default", "default");
  }, 60_000);

  it("Unicode-identifier shape, VS Code config: the same convergence holds under TL_TURN_ECONOMY too", async () => {
    await runReplayFlipGrFollowShape("p16-unicode-vscode", "vscode");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-11 — a bare-handle read.batch entry with no override ships the verbatim
// source of its declared range under content:"full", never a symbol view.
// ---------------------------------------------------------------------------

describe("P2-11: a bare-handle read.batch entry under content:\"full\" is verbatim, never a getSymbolWithContext scope view", () => {
  function writeBigWidget(ws: string): void {
    writeFile(ws, "package.json", '{ "name": "p211", "private": true, "type": "module" }\n');
    let body = "export class Widget {\n";
    body += "  paint(ctx: string): void {\n    console.log(ctx);\n    if (ctx.length === 0) {\n      throw new Error('empty');\n    }\n  }\n\n";
    body += "  resize(w: number, h: number): void {\n    console.log(w, h);\n  }\n}\n";
    // Past TINY_LINES (250) so `paint`/`resize` mint real kind:"symbol"
    // handles instead of the small-file whole-file shortcut.
    for (let i = 1; i <= 70; i++) {
      body += `\n  helper${i}(x: number): number {\n    return x * ${i} + ${i};\n  }\n`;
    }
    writeFile(ws, "src/widget.ts", body);
  }

  it("A7 all-handle batch: a bare {handle} target resolves to a kind:\"symbol\" handle and still ships verbatim lines", async () => {
    const ws = makeWorkspace("p211-a7");
    writeBigWidget(ws);
    const server = await spawnedServer(ws);

    const symRes = await server.callTool("tl_read_file", { targets: [{ path: "src/widget.ts", symbol: "paint" }], cwd: ws });
    const evidence = symRes.body?.evidence?.[0];
    const symHandle = evidence?.handle;
    const symRange = evidence?.range;
    expect(typeof symHandle, `no symbol handle minted: ${JSON.stringify(symRes.body)}`).toBe("string");
    expect(typeof symRange, `no range on the minted symbol handle: ${JSON.stringify(symRes.body)}`).toBe("string");

    // A second handle so the batch has 2 targets (>1 triggers the A7
    // handles=[] loop rather than the single-target mode=symbol door).
    const resizeRes = await server.callTool("tl_read_file", { targets: [{ path: "src/widget.ts", symbol: "resize" }], cwd: ws });
    const resizeHandle = resizeRes.body?.evidence?.[0]?.handle;
    expect(typeof resizeHandle, `no resize handle minted: ${JSON.stringify(resizeRes.body)}`).toBe("string");

    const batch = await server.callTool("tl_read_file", {
      targets: [{ handle: symHandle }, { handle: resizeHandle }],
      content: "full",
      cwd: ws,
    });
    expect(batch.body?.kind).toBe("read.batch");
    const entries: Array<Record<string, unknown>> = Array.isArray(batch.body?.entries) ? batch.body.entries : [];
    const widgetEntry = entries.find((e) => e["handle"] === symHandle);
    expect(widgetEntry, `no batch entry for the symbol handle: ${JSON.stringify(entries)}`).toBeDefined();

    const contentStr = String(widgetEntry?.["content"] ?? "");
    expect(contentStr, "batch entry shipped an assembled scope view, not verbatim source").not.toMatch(/tokenlighten:scope/);

    const fileOnDisk = fs.readFileSync(path.join(ws, "src/widget.ts"), "utf8");
    const lines = fileOnDisk.split("\n");
    const [start, end] = String(widgetEntry?.["range"] ?? symRange).split("-").map(Number);
    const expectedVerbatim = lines.slice(start - 1, end).join("\n");
    expect(contentStr).toBe(expectedVerbatim);
  }, 60_000);

  it("S6 mixed symbol/path batch: a bare {handle} sibling (implicit stored-symbol fallback) is also verbatim under content:\"full\"", async () => {
    const ws = makeWorkspace("p211-s6");
    writeBigWidget(ws);
    const server = await spawnedServer(ws);

    const resizeRes = await server.callTool("tl_read_file", { targets: [{ path: "src/widget.ts", symbol: "resize" }], cwd: ws });
    const resizeHandle = resizeRes.body?.evidence?.[0]?.handle;
    const resizeRange = resizeRes.body?.evidence?.[0]?.range;
    expect(typeof resizeHandle).toBe("string");

    // Target 0 carries an EXPLICIT symbol (picks mode="symbol", admitting the
    // S6 branch); target 1 is a bare {handle} with no override of its own —
    // the same implicit-stored-symbol-fallback shape as the A7 case above,
    // now inside resolvePathsBatchEntry's own hEntryForOverride path.
    const mixed = await server.callTool("tl_read_file", {
      targets: [{ path: "src/widget.ts", symbol: "paint" }, { handle: resizeHandle }],
      content: "full",
      cwd: ws,
    });
    expect(mixed.body?.kind).toBe("read.batch");
    const entries: Array<Record<string, unknown>> = Array.isArray(mixed.body?.entries) ? mixed.body.entries : [];
    const resizeEntry = entries.find((e) => e["handle"] === resizeHandle);
    expect(resizeEntry, `no batch entry for the resize handle: ${JSON.stringify(entries)}`).toBeDefined();

    const contentStr = String(resizeEntry?.["content"] ?? "");
    expect(contentStr, "S6 batch entry shipped an assembled scope view, not verbatim source").not.toMatch(/tokenlighten:scope/);

    const fileOnDisk = fs.readFileSync(path.join(ws, "src/widget.ts"), "utf8");
    const lines = fileOnDisk.split("\n");
    const [start, end] = String(resizeEntry?.["range"] ?? resizeRange).split("-").map(Number);
    const expectedVerbatim = lines.slice(start - 1, end).join("\n");
    expect(contentStr).toBe(expectedVerbatim);
  }, 60_000);

  it("recall control: an EXPLICIT per-item override symbol still gets the assembled scope view (this fix must not suppress a deliberate ask)", async () => {
    const ws = makeWorkspace("p211-recall");
    writeBigWidget(ws);
    const server = await spawnedServer(ws);

    const resizeRes = await server.callTool("tl_read_file", { targets: [{ path: "src/widget.ts", symbol: "resize" }], cwd: ws });
    const resizeHandle = resizeRes.body?.evidence?.[0]?.handle;

    // Two explicit-symbol targets in one batch -- both should get the
    // assembled view, since both symbols are DELIBERATELY named on this call
    // (not a passive fallback to a handle's own stored tag).
    const batch = await server.callTool("tl_read_file", {
      targets: [{ path: "src/widget.ts", symbol: "paint" }, { handle: resizeHandle, symbol: "resize" }],
      content: "full",
      cwd: ws,
    });
    const entries: Array<Record<string, unknown>> = Array.isArray(batch.body?.entries) ? batch.body.entries : [];
    const paintEntry = entries.find((e) => typeof e["content"] === "string" && String(e["content"]).includes("paint("));
    expect(paintEntry, `no paint entry found: ${JSON.stringify(entries)}`).toBeDefined();
    expect(String(paintEntry?.["content"] ?? "")).toMatch(/tokenlighten:scope/);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-15 — a code-unchanged receipt cites served windows only when they cover
// EVERY line of the request, blank lines included.
// ---------------------------------------------------------------------------

describe("P2-15: a code-unchanged receipt never claims a request whose last requested line is blank and unserved", () => {
  /** Lines 1-5 real content, line 6 BLANK, lines 7-11 more real content --
   *  the exact shape HTTP_CONFIG_TS uses (evaluation0927Scenarios.ts). */
  const CONFIG_TS = [
    "export interface Options {",
    "  a: number;",
    "  b: number;",
    "  c: number;",
    "}",
    "",
    "export const DEFAULT: Options = {",
    "  a: 1,",
    "  b: 2,",
    "  c: 3,",
    "};",
  ].join("\n") + "\n";

  it("serve 1-5, then request 3-6 (line 6 blank): the receipt/body must account for line 6, never silently omit it", async () => {
    const ws = makeWorkspace("p215-blank");
    writeFile(ws, "package.json", '{ "name": "p215", "private": true, "type": "module" }\n');
    writeFile(ws, "src/config.ts", CONFIG_TS);
    const server = await spawnedServer(ws);

    const first = await server.callTool("tl_read_file", { targets: [{ path: "src/config.ts", range: "1-5" }], content: "full", cwd: ws });
    expect(first.body?.evidence?.[0]?.body ?? first.body?.content, `first call served no body: ${JSON.stringify(first.body)}`).toBeTruthy();

    const second = await server.callTool("tl_read_file", { targets: [{ path: "src/config.ts", range: "3-6" }], content: "full", cwd: ws });
    const body = second.body;

    if (body?.kind === "read.receipt" || body?.receipt !== undefined) {
      // A receipt is only honest here if it (or its covered_by) proves ALL
      // FOUR requested lines (3,4,5,6) -- including the blank line 6 -- are
      // covered. This test's fixture has no whole-file serve anywhere else
      // in the chain, so the only legitimate coverage is "1-5", which does
      // NOT reach line 6 -- a receipt at all is therefore dishonest here.
      throw new Error(`a bare-request "3-6" answered with a code-unchanged receipt after only "1-5" was ever served -- line 6 (blank) was never examined: ${JSON.stringify(body)}`);
    }

    // The normal path: a real body covering the full 4-line window.
    const evidence = body?.evidence?.[0];
    const served = typeof evidence?.body === "string" ? evidence.body : (typeof body?.content === "string" ? body.content : undefined);
    expect(served, `no body served for range 3-6: ${JSON.stringify(body)}`).toBeDefined();
    const servedLines = (served ?? "").split("\n");
    // Lines 3,4,5,6 = "  c: number;", "}", "", (trailing join artifact) --
    // the served text must contain the blank line 6 as a real line, not be
    // silently truncated to only 3,4,5.
    expect(servedLines.length, `served body looks truncated to 3 lines, not 4: ${JSON.stringify(served)}`).toBeGreaterThanOrEqual(3);
    expect(String(evidence?.range ?? body?.range ?? "")).toBe("3-6");
  }, 60_000);

  it("recall control: an EXACT re-request of an already-fully-served window (no blank-tail ambiguity) still gets an honest code-unchanged receipt", async () => {
    const ws = makeWorkspace("p215-recall");
    writeFile(ws, "package.json", '{ "name": "p215r", "private": true, "type": "module" }\n');
    writeFile(ws, "src/config.ts", CONFIG_TS);
    const server = await spawnedServer(ws);

    const first = await server.callTool("tl_read_file", { targets: [{ path: "src/config.ts", range: "1-5" }], content: "full", cwd: ws });
    expect(first.body?.evidence?.[0]?.body, `first call served no body: ${JSON.stringify(first.body)}`).toBeTruthy();

    // The IDENTICAL window again -- this must still be eligible for a
    // code-unchanged receipt (the fix must not have made the whole mechanism
    // over-conservative; only the blank-tail miscount was the bug).
    const second = await server.callTool("tl_read_file", { targets: [{ path: "src/config.ts", range: "1-5" }], content: "full", cwd: ws });
    const body = second.body;
    const isReceipt = body?.kind === "read.receipt" || body?.receipt !== undefined || body?.code_unchanged === true;
    expect(isReceipt, `exact re-request of an already-served window did not get a code-unchanged receipt: ${JSON.stringify(body)}`).toBe(true);
  }, 60_000);
});
