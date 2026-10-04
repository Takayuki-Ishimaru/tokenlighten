/**
 * evaluation0929.batchNoSilentDrop.spec.ts — eval-0929 §3/§8 (WP-G, adopted
 * chip from WP-D's `evaluation0929.cursorStaleRestart.spec.ts` "row 5" test).
 *
 * DEFECT. `tl_read_file targets:[{path,range},{path}]` (a MIXED batch: one entry
 * the caller ranged, one it left bare) under a byte budget silently dropped
 * the ranged entry once the bare entry alone admitted and the ranged one was
 * deferred for budget:
 *
 *   tl_read_file {targets:[{path:"large.ts",range:"1-1000"},{path:"small.ts"}],
 *              content:"full", budget:{bytes:6144}}
 *     -> {"kind":"read.batch","entries":[<small.ts only>]}
 *   — no entry for large.ts, no `omitted`, no `limit`, no `next`: the target
 *   vanishes with no trace it was ever requested. Order-independent (same
 *   with the targets swapped). The all-ranged control (both targets carry a
 *   `range`) was already honest: small.ts entry + `limit.next` naming
 *   large.ts.
 *
 * ROOT CAUSE, tracked to its actual source (NOT where it first looked like it
 * was: `server.ts`'s `mode=full` `paths[]` batch loop, ~server.ts:16392,
 * correctly resolves every entry, admits small.ts, and defers large.ts into
 * `omitted`+`deferredForNext`, building a correct `next`).
 *
 *  1. `protocol/readRequestContinuation.ts`'s `clearContinuation` (the D=∅
 *     "this request is now complete, drop its continuation" step). A bare
 *     whole-file entry (small.ts) stages a `StagedReadRequest` via
 *     `resolveFullReadForPath` (`stageFullReadRequest`/
 *     `appendReadRequestTarget`); a RANGED entry never stages one at all
 *     (`resolveRangedPathsBatchEntry` only touches the separate served-range
 *     ledger). Once small.ts's own request settles to D=∅,
 *     `clearContinuation` deleted ANY `wire`-caused `limit`/`next`/
 *     `receipt.next` bound for `tl_read_file`, with no check for WHICH path it
 *     named — including large.ts's own, entirely unrelated, still-owed
 *     disclosure. Fixed by scoping `dropLimit`/`dropNext`/`dropReceiptNext`
 *     to continuations that name ONLY paths this staged request's own Q
 *     covers (`addressesForeignPath`/`toolCallNamedPaths`, new).
 *  2. `protocol/envelope.ts`'s `inheritCallerResponseBudget` ("rule 5": skip
 *     stamping the caller's declared budget onto a freshly minted `next`
 *     when SOME read/search request is staged, because that request's own
 *     cursor mechanism "will overwrite whatever this stamps... at zero wire
 *     cost"). True only when the staged request actually owns the
 *     continuation being minted; for large.ts's own deferred `next` it does
 *     not, so once (1) stopped deleting it, it still shipped with no
 *     `budget` at all, re-opening the response to the calibrated server
 *     ceiling instead of the caller's declared one. Fixed by scoping the
 *     skip to `ownsMintedContinuation` (new): only when every path the
 *     minted call names is one of the staged request's own targets.
 *
 * Every case here drives a REAL stdio server (`startDevServer`), exactly as
 * `evaluation0929.cursorStaleRestart.spec.ts` does, and follows `next`
 * verbatim (AGENTS.md).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  extractNext,
  extractServedIds,
  idRangeSet,
  missingIds,
  startDevServer,
  walkHops,
  writeSelfIdFile,
  type ConfigName,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const LINE_BYTES = 24;
const LARGE_LINES = 1000;

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

function freshWorkspace(config: ConfigName, tag: string): { ws: string; server: ServerHandle } {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-bnsd-${config}-${tag}-`));
  tmpDirs.push(ws);
  const server = startDevServer(ws, config, { allowWrite: true });
  servers.push(server);
  return { ws, server };
}

/** Raw occurrence COUNT of `${tag}-NNNN` across a chain of responses —
 *  distinguishes "served once" from "served twice" the way a `Set` cannot.
 *  Mirrors `evaluation0929.cursorStaleRestart.spec.ts`'s own
 *  `countTagOccurrences` (kept local, not shared, same as that file's own
 *  copy of `isExplicitStop`: this harness does not import across spec
 *  files). */
function countTagOccurrences(responses: readonly unknown[], tag: string): number {
  const re = new RegExp(`${tag}-(\\d{4})`, "g");
  let count = 0;
  for (const r of responses) {
    const text = JSON.stringify(r);
    re.lastIndex = 0;
    while (re.exec(text) !== null) count += 1;
  }
  return count;
}

function bytesOf(response: unknown): number {
  return Buffer.byteLength(JSON.stringify(response), "utf8");
}

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`mixed ranged+bare targets:[] batch never drops the deferred target (config=${config})`, () => {
    it("large.ts is accounted for (never silently dropped) and the chain delivers every line exactly once", async () => {
      const { ws, server } = freshWorkspace(config, "primary");
      await server.initialize();
      writeSelfIdFile(ws, "large.ts", LARGE_LINES, "big", LINE_BYTES);
      writeSelfIdFile(ws, "small.ts", 1, "sm", LINE_BYTES);

      const first = await server.callTool("tl_read_file", {
        targets: [{ path: "large.ts", range: `1-${LARGE_LINES}` }, { path: "small.ts" }],
        content: "full",
        budget: { bytes: 6144 },
        cwd: ws,
      });

      // THE REGRESSION ITSELF: if large.ts has no ids in THIS response, the
      // response must still name it somewhere (an `omitted`/`limit`
      // disclosure) — the pre-fix defect had literally zero trace of it.
      const hop0Ids = extractServedIds(first.body, ["big", "sm"]);
      const bigInHop0 = hop0Ids.get("big")?.size ?? 0;
      if (bigInHop0 === 0) {
        expect(
          JSON.stringify(first.body).includes("large.ts"),
          `large.ts silently dropped: ${JSON.stringify(first.body)}`,
        ).toBe(true);
        expect(
          extractNext(first.body).next,
          `large.ts named but no executable continuation: ${JSON.stringify(first.body)}`,
        ).toBeDefined();
      }

      const firstNext = extractNext(first.body).next;
      const chain = firstNext !== undefined
        ? await walkHops(server, firstNext, 20)
        : { responses: [], capped: false };
      const allResponses = [first.body, ...chain.responses];

      expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
      const refusals = allResponses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
      expect(refusals, `unexpected refusal(s): ${JSON.stringify(refusals).slice(0, 500)}`).toEqual([]);

      // Every response stayed within the caller's declared budget (a small
      // envelope tolerance, matching the wave's existing spec convention).
      for (const r of allResponses) {
        expect(bytesOf(r), `over budget: ${JSON.stringify(r).slice(0, 300)}`).toBeLessThanOrEqual(6144 + 300);
      }

      const seenBig = new Set<number>();
      let sawSmall = false;
      for (const r of allResponses) {
        const ids = extractServedIds(r, ["big", "sm"]);
        for (const n of ids.get("big") ?? []) seenBig.add(n);
        if ((ids.get("sm")?.size ?? 0) > 0) sawSmall = true;
      }
      expect(sawSmall, "small.ts never delivered").toBe(true);
      expect(missingIds(idRangeSet(1, LARGE_LINES), seenBig), "large.ts lines missing across the chain").toEqual([]);
      expect(
        countTagOccurrences(allResponses, "big"),
        "large.ts lines duplicated across the chain",
      ).toBe(seenBig.size);
    }, 180_000);

    it("order does not matter — bare target first, ranged target second", async () => {
      const { ws, server } = freshWorkspace(config, "swapped");
      await server.initialize();
      writeSelfIdFile(ws, "large.ts", LARGE_LINES, "big2", LINE_BYTES);
      writeSelfIdFile(ws, "small.ts", 1, "sm2", LINE_BYTES);

      const first = await server.callTool("tl_read_file", {
        targets: [{ path: "small.ts" }, { path: "large.ts", range: `1-${LARGE_LINES}` }],
        content: "full",
        budget: { bytes: 6144 },
        cwd: ws,
      });
      const hop0Ids = extractServedIds(first.body, ["big2", "sm2"]);
      if ((hop0Ids.get("big2")?.size ?? 0) === 0) {
        expect(JSON.stringify(first.body)).toContain("large.ts");
        expect(extractNext(first.body).next).toBeDefined();
      }

      const firstNext = extractNext(first.body).next;
      const chain = firstNext !== undefined
        ? await walkHops(server, firstNext, 20)
        : { responses: [], capped: false };
      expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
      const allResponses = [first.body, ...chain.responses];
      const seenBig = new Set<number>();
      for (const r of allResponses) for (const n of extractServedIds(r, ["big2"]).get("big2") ?? []) seenBig.add(n);
      expect(missingIds(idRangeSet(1, LARGE_LINES), seenBig)).toEqual([]);
    }, 180_000);
  });
}

describe("mixed batch metamorphic variants (default config)", () => {
  it("3 targets: 2 ranged + 1 whole — none is dropped", async () => {
    const { ws, server } = freshWorkspace("default", "three");
    await server.initialize();
    writeSelfIdFile(ws, "large.ts", LARGE_LINES, "big3", LINE_BYTES);
    writeSelfIdFile(ws, "mid.ts", 40, "mid3", LINE_BYTES);
    writeSelfIdFile(ws, "small.ts", 1, "sm3", LINE_BYTES);

    const first = await server.callTool("tl_read_file", {
      targets: [
        { path: "large.ts", range: `1-${LARGE_LINES}` },
        { path: "mid.ts", range: "1-40" },
        { path: "small.ts" },
      ],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next;
    const chain = firstNext !== undefined ? await walkHops(server, firstNext, 25) : { responses: [], capped: false };
    expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
    const allResponses = [first.body, ...chain.responses];
    const seenBig = new Set<number>();
    const seenMid = new Set<number>();
    let sawSmall = false;
    for (const r of allResponses) {
      const ids = extractServedIds(r, ["big3", "mid3", "sm3"]);
      for (const n of ids.get("big3") ?? []) seenBig.add(n);
      for (const n of ids.get("mid3") ?? []) seenMid.add(n);
      if ((ids.get("sm3")?.size ?? 0) > 0) sawSmall = true;
    }
    expect(missingIds(idRangeSet(1, LARGE_LINES), seenBig), "large.ts").toEqual([]);
    expect(missingIds(idRangeSet(1, 40), seenMid), "mid.ts").toEqual([]);
    expect(sawSmall, "small.ts").toBe(true);
  }, 180_000);

  it("ranges:[] (plural, non-contiguous) on the deferred target — only the requested windows are owed, none dropped", async () => {
    const { ws, server } = freshWorkspace("default", "ranges-plural");
    await server.initialize();
    writeSelfIdFile(ws, "large.ts", LARGE_LINES, "big4", LINE_BYTES);
    writeSelfIdFile(ws, "small.ts", 1, "sm4", LINE_BYTES);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "large.ts", ranges: ["1-500", "600-1000"] }, { path: "small.ts" }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next;
    const chain = firstNext !== undefined ? await walkHops(server, firstNext, 25) : { responses: [], capped: false };
    expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
    const allResponses = [first.body, ...chain.responses];
    const seenBig = new Set<number>();
    for (const r of allResponses) for (const n of extractServedIds(r, ["big4"]).get("big4") ?? []) seenBig.add(n);
    const wanted = new Set<number>([...idRangeSet(1, 500), ...idRangeSet(600, 1000)]);
    expect(missingIds(wanted, seenBig), "requested windows must all arrive").toEqual([]);
    // Lines 501-600 (exclusive of the requested windows) were never asked
    // for and must not be silently substituted for what WAS asked.
    expect([...seenBig].some((n) => n > 500 && n < 600), "unrequested window leaked in").toBe(false);
  }, 180_000);

  it("handle-addressed deferred target (mixed with a bare path target)", async () => {
    const { ws, server } = freshWorkspace("default", "handle-addr");
    await server.initialize();
    writeSelfIdFile(ws, "large.ts", LARGE_LINES, "big5", LINE_BYTES);
    writeSelfIdFile(ws, "small.ts", 1, "sm5", LINE_BYTES);

    const mint = await server.callTool("tl_read_file", { targets: [{ path: "large.ts", range: "1-1" }], cwd: ws });
    const handle = (mint.body?.["evidence"] as Array<Record<string, unknown>> | undefined)?.[0]?.["handle"]
      ?? (mint.body?.["entries"] as Array<Record<string, unknown>> | undefined)?.[0]?.["handle"];
    expect(typeof handle, JSON.stringify(mint.body)).toBe("string");

    const first = await server.callTool("tl_read_file", {
      targets: [{ handle, range: `1-${LARGE_LINES}` }, { path: "small.ts" }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next;
    const chain = firstNext !== undefined ? await walkHops(server, firstNext, 25) : { responses: [], capped: false };
    expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
    const allResponses = [first.body, ...chain.responses];
    const seenBig = new Set<number>();
    let sawSmall = false;
    for (const r of allResponses) {
      const ids = extractServedIds(r, ["big5", "sm5"]);
      for (const n of ids.get("big5") ?? []) seenBig.add(n);
      if ((ids.get("sm5")?.size ?? 0) > 0) sawSmall = true;
    }
    expect(missingIds(idRangeSet(1, LARGE_LINES), seenBig)).toEqual([]);
    expect(sawSmall).toBe(true);
  }, 180_000);

  it("a wider caller budget (8192) still delivers everything, none dropped", async () => {
    const { ws, server } = freshWorkspace("default", "budget8192");
    await server.initialize();
    writeSelfIdFile(ws, "large.ts", LARGE_LINES, "big6", LINE_BYTES);
    writeSelfIdFile(ws, "small.ts", 1, "sm6", LINE_BYTES);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "large.ts", range: `1-${LARGE_LINES}` }, { path: "small.ts" }],
      content: "full",
      budget: { bytes: 8192 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next;
    const chain = firstNext !== undefined ? await walkHops(server, firstNext, 20) : { responses: [], capped: false };
    expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
    const allResponses = [first.body, ...chain.responses];
    for (const r of allResponses) expect(bytesOf(r)).toBeLessThanOrEqual(8192 + 300);
    const seenBig = new Set<number>();
    let sawSmall = false;
    for (const r of allResponses) {
      const ids = extractServedIds(r, ["big6", "sm6"]);
      for (const n of ids.get("big6") ?? []) seenBig.add(n);
      if ((ids.get("sm6")?.size ?? 0) > 0) sawSmall = true;
    }
    expect(missingIds(idRangeSet(1, LARGE_LINES), seenBig)).toEqual([]);
    expect(sawSmall).toBe(true);
  }, 180_000);
});

describe("recall controls — unaffected by the mixed-batch fix", () => {
  it("all targets ranged: byte-identical shape (small.ts entry + honest limit.next for large.ts)", async () => {
    const { ws, server } = freshWorkspace("default", "recall-all-ranged");
    await server.initialize();
    writeSelfIdFile(ws, "large.ts", LARGE_LINES, "bigC", LINE_BYTES);
    writeSelfIdFile(ws, "small.ts", 1, "smC", LINE_BYTES);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "small.ts", range: "1-1" }, { path: "large.ts", range: `1-${LARGE_LINES}` }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    // The control was ALREADY honest pre-fix: small.ts entry plus a
    // response-level `limit` naming large.ts. Both a batch entry AND a
    // top-level omitted/limit path are acceptable encodings of "served" —
    // this only pins that it stays honest, not the exact wire shape.
    const ids = extractServedIds(first.body, ["smC"]);
    expect((ids.get("smC")?.size ?? 0) > 0, JSON.stringify(first.body)).toBe(true);
    const next = extractNext(first.body).next;
    expect(next, "large.ts must still carry an executable continuation").toBeDefined();
    expect(JSON.stringify(next)).toContain("large.ts");

    const chain = await walkHops(server, next!, 20);
    expect(chain.capped, JSON.stringify(chain.responses).slice(0, 500)).toBe(false);
    const seenBig = new Set<number>();
    for (const r of [first.body, ...chain.responses]) for (const n of extractServedIds(r, ["bigC"]).get("bigC") ?? []) seenBig.add(n);
    expect(missingIds(idRangeSet(1, LARGE_LINES), seenBig)).toEqual([]);
  }, 180_000);

  it("all targets bare (unranged), nothing deferred: both admit in one hop, unaffected by the fix", async () => {
    // NOTE: an all-bare batch where the whole-file target is itself so large
    // it needs its OWN multi-page continuation exercises a DIFFERENT,
    // pre-existing gap in the single-target governed-full continuation
    // builder (`server.ts`'s `buildFullServePayload`) — reproduced with NO
    // batching at all (a lone `targets:[{path:"large.ts"}]`) and confirmed
    // present on the unmodified v0.14.4 baseline build, so it is unrelated to
    // this fix and out of this spec's scope (flagged separately). This case
    // stays deliberately small so BOTH targets admit in the first hop, which
    // is the actual "byte-identical to HEAD" recall control this wave's
    // brief asks for.
    const { ws, server } = freshWorkspace("default", "recall-all-bare");
    await server.initialize();
    writeSelfIdFile(ws, "a.ts", 2, "aD", LINE_BYTES);
    writeSelfIdFile(ws, "b.ts", 2, "bD", LINE_BYTES);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "a.ts" }, { path: "b.ts" }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    expect(first.body["kind"]).toBe("read.batch");
    const ids = extractServedIds(first.body, ["aD", "bD"]);
    expect(missingIds(idRangeSet(1, 2), ids.get("aD") ?? new Set())).toEqual([]);
    expect(missingIds(idRangeSet(1, 2), ids.get("bD") ?? new Set())).toEqual([]);
    // Nothing deferred: no omission/continuation of any kind.
    expect(extractNext(first.body).next).toBeUndefined();
  }, 60_000);
});
