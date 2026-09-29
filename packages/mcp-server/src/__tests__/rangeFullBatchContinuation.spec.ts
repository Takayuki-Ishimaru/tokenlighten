/**
 * rangeFullBatchContinuation.spec.ts — FIX-A3, TL-05 follow-up items 2 and 3
 * (2026-09-21): `content:"full"` + `range` must survive a `read.batch`
 * continuation, both the shed ladder's own minted `next` (item 2) and the A7
 * `handles=[]` loop's own elision decision on a call that already carries the
 * marker (item 3, whether that call is a fresh request or itself a
 * continuation of an earlier one — the loop does not distinguish).
 *
 * THE CONTRACT (plan §7.1, FIX-A2's ruling, unchanged by this file):
 *   range/ranges + content:"full" => serve the selected lines UNELIDED (no
 *   doc-comment collapsing) across the WHOLE continuation chain, never widen
 *   past the requested window.
 *
 * ITEM 2, ROOT CAUSE (FIX-A2's own report, fixed here). `readBatch.ts`'s rung
 * 4 (`truncateRangedEntries`) and rung 6 (`shedBatchEntry`) each mint a
 * `read_file` continuation for a "handle"-form entry, but `ShedContext.args`
 * is the SAME `args` object `server.ts`'s `normalizeCanonicalRequest` already
 * deleted `content` from before dispatch — by the time a rung runs, there is
 * no way left to tell "this call originally said content:full" from "it did
 * not". Fixed via `RANGE_CONTENT_FULL_MARKER`
 * (`protocol/budget/shedders/registry.ts`), a Symbol-keyed property BOTH
 * `server.ts` (the writer) and this shedder (a reader, several import hops
 * below `server.ts`) can see without a circular import.
 *
 * ITEM 3, ROOT CAUSE (also FIX-A2's report, fixed here). The A7 `handles=[]`
 * loop (`server.ts`) computes `itemDisplay` — the ONE place that decides
 * elision for this whole response — from `keepComments` alone (the caller's
 * explicit `comments:"keep"`), never consulting the SAME
 * `rangeContentFullMarker` the single-handle `mode=slice` branch already
 * used. A multi-handle continuation naming `content:"full"` therefore
 * re-elided on arrival, regardless of item 2's fix to the call that produced
 * it — the two defects compound (a continuation minted with the marker still
 * arrived elided) but are independently reachable (a caller can address the
 * A7 loop directly with `content:"full"` on the very first hop).
 *
 * MEASURED, FAIL-FIRST (both reverted locally and confirmed before writing
 * this file — see the FIX-A3 wave report for the exact numbers): with items 2
 * and 3 both reverted, the two-handle continuation scenario below elides its
 * commented file on the FIRST hop and the chain terminates there — all 40
 * "doc comment content line N" markers are permanently lost, not merely
 * delayed to a later hop.
 */

import { afterAll, describe, expect, it } from "vitest";
import type { Kind } from "@tokenlighten/types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { callTool } from "../server.js";
import { runLadder } from "../protocol/budget/ladder.js";
import { validateProtocolBody } from "../protocol/budget/validate.js";
import { RANGE_CONTENT_FULL_MARKER } from "../protocol/budget/shedders/registry.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";

// ---------------------------------------------------------------------------
// Shared fixtures / helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function mkWs(tag: string): string {
  const dir = fs.realpathSync(shortTmpDir(os.homedir(), `.tl-rfbc-${tag}-`));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function plainFile(n: number): string {
  return Array.from({ length: n }, (_, i) => `export const P${i} = ${i};`).join("\n") + "\n";
}

/** `codeLines` real lines, one big doc-comment block, `codeLines` more real lines. */
function commentedFile(codeLines: number, commentLines: number): string {
  const lines: string[] = [];
  for (let i = 0; i < codeLines; i++) lines.push(`export const A${i} = ${i};`);
  lines.push("/**");
  for (let i = 0; i < commentLines; i++) lines.push(` * doc comment content line ${i} with enough padding text to matter here`);
  lines.push(" */");
  for (let i = 0; i < codeLines; i++) lines.push(`export const B${i} = ${i};`);
  return lines.join("\n") + "\n";
}

const ELISION_MARKER_RE = /\/\* doc elided L\d+-\d+ \*\/|#\s?doc elided L\d+-\d+/;

async function call(args: Record<string, unknown>, ws: string): Promise<Record<string, unknown>> {
  const raw = await callTool("read_file", { ...args, cwd: ws });
  return JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
}

function extractNext(body: Record<string, unknown>): { tool: string; arguments: Record<string, unknown> } | undefined {
  const limit = body["limit"] as Record<string, unknown> | undefined;
  const limitNext = limit?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
  if (limitNext && typeof limitNext.tool === "string") {
    return { tool: limitNext.tool, arguments: (limitNext.arguments as Record<string, unknown>) ?? {} };
  }
  const topNext = body["next"] as { tool?: unknown; arguments?: unknown } | undefined;
  if (topNext && typeof topNext.tool === "string") {
    return { tool: topNext.tool, arguments: (topNext.arguments as Record<string, unknown>) ?? {} };
  }
  for (const key of ["entries", "evidence"]) {
    const arr = body[key];
    if (Array.isArray(arr)) {
      for (const raw of arr) {
        const entry = raw as Record<string, unknown> | undefined;
        const entryNext = entry?.["next"] as { tool?: unknown; arguments?: unknown } | undefined;
        if (entryNext && typeof entryNext.tool === "string") {
          return { tool: entryNext.tool, arguments: (entryNext.arguments as Record<string, unknown>) ?? {} };
        }
      }
    }
  }
  return undefined;
}

describe("FIX-A3 item 3: the A7 handles=[] loop honors content:\"full\" directly", () => {
  it("a multi-handle {handle,range} batch with content:\"full\" and a generous budget serves the commented file UNELIDED", async () => {
    const ws = mkWs("item3-full");
    write(ws, "src/plain.ts", plainFile(6));
    const commented = commentedFile(4, 12);
    write(ws, "src/commented.ts", commented);
    const commentedLines = commented.split("\n").length - 1;

    const hPlain = ((await call({ targets: [{ path: "src/plain.ts" }] }, ws))["evidence"] as Record<string, unknown>[])[0]!["handle"] as string;
    const hCommented = ((await call({ targets: [{ path: "src/commented.ts" }] }, ws))["evidence"] as Record<string, unknown>[])[0]!["handle"] as string;

    const res = await call({
      targets: [{ handle: hPlain, range: "1-6" }, { handle: hCommented, range: `1-${commentedLines}` }],
      content: "full",
      budget: { bytes: 20000 },
    }, ws);
    const text = JSON.stringify(res);
    expect(res["kind"], text.slice(0, 300)).toBe("read.batch");
    expect(ELISION_MARKER_RE.test(text), `must not elide: ${text.slice(0, 600)}`).toBe(false);
    expect(text, "the raw comment text must be present verbatim").toContain("doc comment content line 0 with enough padding");
    expect(text).toContain("doc comment content line 11 with enough padding");
  });

  it("CONTROL — the SAME batch WITHOUT content:\"full\" still elides (the fixture and marker regex are meaningful)", async () => {
    const ws = mkWs("item3-control");
    write(ws, "src/plain.ts", plainFile(6));
    const commented = commentedFile(4, 12);
    write(ws, "src/commented.ts", commented);
    const commentedLines = commented.split("\n").length - 1;

    const hPlain = ((await call({ targets: [{ path: "src/plain.ts" }] }, ws))["evidence"] as Record<string, unknown>[])[0]!["handle"] as string;
    const hCommented = ((await call({ targets: [{ path: "src/commented.ts" }] }, ws))["evidence"] as Record<string, unknown>[])[0]!["handle"] as string;

    const res = await call({
      targets: [{ handle: hPlain, range: "1-6" }, { handle: hCommented, range: `1-${commentedLines}` }],
      budget: { bytes: 20000 },
    }, ws);
    const text = JSON.stringify(res);
    expect(res["kind"], text.slice(0, 300)).toBe("read.batch");
    expect(ELISION_MARKER_RE.test(text), `precondition: this fixture really does elide by default: ${text.slice(0, 600)}`).toBe(true);
  });
});

describe("FIX-A3 item 2: readBatch.ts's shed-ladder continuation echoes content:\"full\"", () => {
  it("a tight budget forces truncation of a commented file; every hop of the chain stays unelided until every requested line has arrived", async () => {
    const ws = mkWs("item2-chain");
    write(ws, "src/plain.ts", plainFile(10));
    const commented = commentedFile(6, 40);
    write(ws, "src/commented.ts", commented);
    const commentedLines = commented.split("\n").length - 1;

    const hPlain = ((await call({ targets: [{ path: "src/plain.ts" }] }, ws))["evidence"] as Record<string, unknown>[])[0]!["handle"] as string;
    const hCommented = ((await call({ targets: [{ path: "src/commented.ts" }] }, ws))["evidence"] as Record<string, unknown>[])[0]!["handle"] as string;

    let res = await call({
      targets: [{ handle: hPlain, range: "1-10" }, { handle: hCommented, range: `1-${commentedLines}` }],
      content: "full",
      budget: { bytes: 1200 },
    }, ws);
    expect(res["kind"], JSON.stringify(res).slice(0, 300)).toBe("read.batch");
    // ITEM 2'S OWN ASSERTION: the FIRST hop's minted continuation(s) already
    // carry content:"full" — the fact `truncateRangedEntries`/`shedBatchEntry`
    // used to drop.
    const firstNext = extractNext(res);
    expect(firstNext, "hop 0 must mint a continuation at this budget").toBeDefined();
    expect(firstNext!.arguments["content"], JSON.stringify(firstNext)).toBe("full");

    // Follow the chain verbatim (AGENTS.md: "every `next` is executable: run
    // it verbatim") and collect every response body, bounded generously so a
    // regression that loops cannot hang the suite.
    const collected: string[] = [JSON.stringify(res)];
    for (let hop = 0; hop < 15; hop++) {
      const next = extractNext(res);
      if (next === undefined) break;
      // Every minted continuation this call ever follows must itself still
      // declare content:"full" (not merely the very first one) — a later hop
      // that silently dropped it would re-elide the remainder.
      if (next.tool === "read_file" && next.arguments["cursor"] === undefined) {
        expect(next.arguments["content"], `hop's own next lost content:"full": ${JSON.stringify(next)}`).toBe("full");
      }
      res = await call(next.arguments, ws);
      collected.push(JSON.stringify(res));
    }

    const allText = collected.join("\n");
    for (const text of collected) {
      expect(ELISION_MARKER_RE.test(text), `no hop may ever elide: ${text.slice(0, 500)}`).toBe(false);
    }
    for (let i = 0; i < 40; i++) {
      expect(allText, `line ${i} of the comment must arrive somewhere in the chain`)
        .toContain(`doc comment content line ${i} with enough padding`);
    }
  });
});

// ---------------------------------------------------------------------------
// Direct ladder-level coverage: BOTH readBatch.ts rungs, in isolation.
//
// The end-to-end tests above prove the contract holds through the real
// dispatcher; these prove exactly which rung is responsible and pin the
// WITHOUT-marker case as a regression control ("auto", not merely "not
// full") so a future change cannot make the marker leak onto every batch
// continuation regardless of whether the caller ever asked for one.
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function ladder(payload: Body, kind: Kind, budget: number, args?: Record<string, unknown>) {
  const out = runLadder({
    payload,
    kind,
    budget,
    context: args === undefined ? {} : { args },
    validate: (candidate) => validateProtocolBody(candidate, kind, undefined).ok,
  });
  return out;
}

/** Two "handle"-form entries, long enough that truncation is real progress. */
function twoHandleBatch(): Body {
  const linesA = Array.from({ length: 40 }, (_, i) => `line a${i} with some padding text to matter here`);
  const linesB = Array.from({ length: 40 }, (_, i) => `line b${i} with some padding text to matter here`);
  return {
    v: 1,
    kind: "read.batch",
    entries: [
      { form: "handle", handle: "h1", path: "src/a.ts", range: "1-40", truncated: false, content: linesA.join("\n"), sha: "sha256:aaa" },
      { form: "handle", handle: "h2", path: "src/b.ts", range: "1-40", truncated: false, content: linesB.join("\n"), sha: "sha256:bbb" },
    ],
  };
}

describe("FIX-A3 item 2: direct ladder coverage of read.batch rungs 4 and 6", () => {
  it("rung 4 (truncateRangedEntries): the per-entry `next` echoes content:\"full\" only when the marker is present", () => {
    // A budget that lets rung 4 alone (not rung 6) fit both entries: earlier
    // in the halving sequence than the point where a whole entry gets dropped.
    const withMarker = ladder(twoHandleBatch(), "read.batch", 900, { [RANGE_CONTENT_FULL_MARKER]: true });
    const entriesWith = withMarker.payload["entries"] as Body[];
    expect(entriesWith.length, JSON.stringify(withMarker.payload).slice(0, 300)).toBe(2);
    for (const entry of entriesWith) {
      const next = entry["next"] as { arguments?: Record<string, unknown> } | undefined;
      expect(next?.arguments?.["content"], JSON.stringify(entry)).toBe("full");
    }

    const withoutMarker = ladder(twoHandleBatch(), "read.batch", 900, {});
    const entriesWithout = withoutMarker.payload["entries"] as Body[];
    for (const entry of entriesWithout) {
      const next = entry["next"] as { arguments?: Record<string, unknown> } | undefined;
      // Not merely "not full" — the pre-existing default the legacy mode=slice
      // dialect already projects to, unchanged by this fix.
      expect(next?.arguments?.["content"], JSON.stringify(entry)).toBe("auto");
    }
  });

  it("rung 6 (shedBatchEntry): the dropped-entry recovery `next` echoes content:\"full\" only when the marker is present", () => {
    // Tight enough that rung 4 alone cannot fit both entries even at their
    // 1-line floor, forcing rung 6 to drop one whole entry.
    const withMarker = ladder(twoHandleBatch(), "read.batch", 300, { [RANGE_CONTENT_FULL_MARKER]: true });
    expect(withMarker.records.some((r) => r.rung === 6), withMarker.records.map((r) => r.rung).join(",")).toBe(true);
    const droppedNextWith = (withMarker.payload["limit"] as Body)["next"] as { arguments?: Record<string, unknown> };
    expect(droppedNextWith.arguments?.["content"], JSON.stringify(withMarker.payload["limit"])).toBe("full");

    const withoutMarker = ladder(twoHandleBatch(), "read.batch", 300, {});
    expect(withoutMarker.records.some((r) => r.rung === 6)).toBe(true);
    const droppedNextWithout = (withoutMarker.payload["limit"] as Body)["next"] as { arguments?: Record<string, unknown> };
    expect(droppedNextWithout.arguments?.["content"], JSON.stringify(withoutMarker.payload["limit"])).toBe("auto");
  });

  it("a \"file\"/\"file-downgraded\" entry's mode=full recovery is BYTE-IDENTICAL with or without the marker (out of scope: plan §7.1's own \"no range + content:full => whole file\" row)", () => {
    const body: Body = {
      v: 1,
      kind: "read.batch",
      entries: [
        { form: "file", path: "src/whole.ts", truncated: false, content: "W".repeat(300) },
        { form: "file", path: "src/whole2.ts", truncated: false, content: "X".repeat(300) },
      ],
    };
    const withMarker = ladder(body, "read.batch", 200, { [RANGE_CONTENT_FULL_MARKER]: true });
    const withoutMarker = ladder(body, "read.batch", 200, {});
    expect(withMarker.records.some((r) => r.rung === 6)).toBe(true);
    const droppedNextWith = (withMarker.payload["limit"] as Body)["next"] as { arguments?: Record<string, unknown> };
    const droppedNextWithout = (withoutMarker.payload["limit"] as Body)["next"] as { arguments?: Record<string, unknown> };
    // `shedBatchEntry`'s `range === undefined` branch never reads `keepFull`
    // at all — the `content:"full"` visible here comes from ordinary mode=full
    // canonicalization (plan §7.1's third table row, unconditional), not from
    // this fix, so the marker must make NO difference to this shape.
    expect(droppedNextWith).toEqual(droppedNextWithout);
    const targets = droppedNextWith.arguments?.["targets"] as Array<Record<string, unknown>> | undefined;
    expect(targets?.[0]?.["path"], JSON.stringify(droppedNextWith)).toBe("src/whole2.ts");
    expect(targets?.[0]?.["range"]).toBeUndefined();
  });
});
