/**
 * evaluation0929.overCapFullRead.spec.ts — eval-0929 §3/§8 row 5 (WP-J,
 * adopted chip from WP-G).
 *
 * DEFECT (orchestrator repro, v0.14.4 build). A whole-file `content:"full"`
 * read of a file OVER `READ_FULL_CAP_BYTES` (server.ts, 81920) downgrades to
 * a governed head serve (`buildFullDowngradePayload`'s W1 branch,
 * `serveGovernedFullHead(content, GOVERNED_FULL_SERVE_BYTES=12288)`), which
 * mints its OWN `next` naming `servedLines+1 .. totalLines` — e.g. lines
 * 300-2000 of a 2000-line file after a 299-line/12288B head. When the
 * CALLER's own wire budget (e.g. 6144 B) is smaller than that head, the
 * generic wire-shed ladder (`protocol/budget/shedders/readText.ts`'s rung 4,
 * `truncateLargestBody`) truncates the body FURTHER — e.g. down to 75 lines —
 * and correctly records the gap as `evidence[0].remaining:["76-299"]`. But
 * the WIRE-LEVEL `limit.next` that ships is `mergeWireLimit`'s (wireLimit.ts)
 * CLAUSE 4 result: "an emitter `next` already exists, keep it, the boundary's
 * cut is disclosed through `omitted` alone" — so `limit.next` stays the
 * STALE, pre-shed `{range:"300-2000"}` call, permanently skipping lines
 * 76-299. A caller that runs `next` verbatim (as AGENTS.md instructs) never
 * sees those lines again — no refusal, no later disclosure, just silence.
 *
 * ROOT CAUSE. `buildFullDowngradePayload` (server.ts) is the ONLY one of the
 * full-read builders that never calls `stageFullReadRequest`. Its sibling
 * `buildFullServePayload` (server.ts:6258) stages EVERY serve — whole-fit or
 * chunked — so `emit.ts`'s tail (`applyReadRequestContinuation`,
 * `protocol/readRequestContinuation.ts`) can settle D = Q - (C ∪ S) against
 * whatever the ladder ACTUALLY shipped and mint ONE reconciled cursor,
 * overriding any stale producer-built `next` regardless of what
 * `mergeWireLimit`'s clause 4 preferred. Without that staging,
 * `context.readRequest` stays `undefined` for a downgrade, so
 * `applyReadRequestContinuation` is a no-op (`staged === undefined`) and the
 * ladder's own correct, narrower continuation
 * (`truncateLargestBody`'s `stepped.continuation`) is computed but never
 * reaches the wire — clause 4 keeps the wider, stale emitter `next` instead.
 *
 * FIX (server.ts, `buildFullDowngradePayload`'s W1 default branch — the one
 * that serves `content: head` with `downgraded_from:"full"`): call
 * `stageFullReadRequest(workspace, filePath, content, sha, keepComments)`,
 * exactly mirroring `buildFullServePayload`. ONE mechanism, reused rather
 * than duplicated: `applyReadRequestContinuation`'s own "which responses this
 * owns" gate (readRequestContinuation.ts) already guarantees byte-identical
 * behaviour when neither a caller budget nor the ladder actually shed
 * anything (`staged.mode === "open" && !budgetDeclared && !shed` short-
 * circuits to the producer's own, in that case genuinely correct, `next`) —
 * so the ordinary calibrated-budget downgrade (no explicit `budget`, governed
 * head fits) is untouched, and only the case where the caller's declared
 * budget (or the ladder) narrows the response further now gets the same
 * settle-and-reconcile treatment `buildFullServePayload` already had. No new
 * wire field, no new special case in `wireLimit.ts`/`readText.ts`.
 *
 * Languages: this path is content/line-count driven, not language-aware —
 * `.ts` is used for the repro; `.py`/`.go`/`.java`/`.kt`/`.cs`/`.rs`/`.c`
 * (or any extension) take the identical byte-cap/governed-head/ladder/staging
 * route, since `resolveFullReadForPath` branches on file size, never on
 * language, before this point (`languageForPath` only affects elision).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  extractNext,
  extractServedIds,
  idRangeSet,
  missingIds,
  startDevServer,
  walkHops,
  type ServerHandle,
  type ToolCallShape,
} from "./helpers/qualityFirstScenarios.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

// server.ts's own literal (not exported — readCodeCaps.spec.ts redeclares the
// same way). GOVERNED_FULL_SERVE_BYTES IS exported (util/fullGovernor.ts).
const READ_FULL_CAP_BYTES = 81920;

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

function freshWorkspace(tag: string): { ws: string; server: ServerHandle } {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-ocfr-${tag}-`));
  tmpDirs.push(ws);
  const server = startDevServer(ws, "default", { allowWrite: true });
  servers.push(server);
  return { ws, server };
}

/**
 * `${tag}-NNNN ` head, padded with `x` to EXACTLY `width` bytes — unlike
 * `qualityFirstScenarios.ts`'s `selfIdLine` (which jumps in whole
 * ~79-byte filler chunks), this gives byte-exact control over the total file
 * size relative to `READ_FULL_CAP_BYTES`/`GOVERNED_FULL_SERVE_BYTES`, which
 * this spec's thresholds depend on.
 */
function exactLine(tag: string, n: number, width: number): string {
  const head = `${tag}-${String(n).padStart(4, "0")} `;
  const headBytes = Buffer.byteLength(head, "utf8");
  return headBytes >= width ? head : head + "x".repeat(width - headBytes);
}

/** Writes `totalLines` `exactLine`s and returns the file's exact byte size. */
function writeExactFile(dir: string, relPath: string, totalLines: number, tag: string, lineWidth: number): number {
  const lines: string[] = [];
  for (let i = 1; i <= totalLines; i += 1) lines.push(exactLine(tag, i, lineWidth));
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const body = lines.join("\n") + "\n";
  fs.writeFileSync(abs, body, "utf8");
  return Buffer.byteLength(body, "utf8");
}

/** Raw occurrence COUNT of `${tag}-NNNN` — distinguishes "served once" from
 *  "served twice", matching `evaluation0929.cursorStaleRestart.spec.ts`'s and
 *  `evaluation0929.batchNoSilentDrop.spec.ts`'s own identical local copy. */
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

/** Runs `first`, follows `next` to completion, and asserts: no refusal, no
 *  chain cap, every line 1..totalLines delivered exactly once (by `tag`), and
 *  every response respects `budgetBytes` (+ envelope tolerance) when given. */
async function assertCompleteChain(args: {
  server: ServerHandle;
  first: { body: unknown };
  totalLines: number;
  tag: string;
  budgetBytes?: number;
  hopCap?: number;
}): Promise<void> {
  const { server, first, totalLines, tag, budgetBytes, hopCap = 30 } = args;
  const firstNext = extractNext(first.body).next;
  const chain = firstNext !== undefined
    ? await walkHops(server, firstNext, hopCap)
    : { responses: [], capped: false };
  const allResponses = [first.body, ...chain.responses];

  expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(-800)}`).toBe(false);
  const refusals = allResponses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
  expect(refusals, `unexpected refusal(s): ${JSON.stringify(refusals).slice(0, 500)}`).toEqual([]);

  if (budgetBytes !== undefined) {
    for (const r of allResponses) {
      expect(bytesOf(r), `over budget: ${JSON.stringify(r).slice(0, 300)}`).toBeLessThanOrEqual(budgetBytes + 300);
    }
  }

  const seen = new Set<number>();
  for (const r of allResponses) for (const n of extractServedIds(r, [tag]).get(tag) ?? []) seen.add(n);
  expect(missingIds(idRangeSet(1, totalLines), seen), "lines missing across the chain — the over-cap skip").toEqual([]);
  expect(countTagOccurrences(allResponses, tag), "lines duplicated across the chain").toBe(seen.size);
}

const LINE_WIDTH = 40; // bytes/line (exclusive of the trailing "\n")

describe("over-cap whole-file read: the continuation never skips lines (eval-0929 §3/§8 row 5)", () => {
  it("just over the cap, budget 6144: every line delivered exactly once, none skipped", async () => {
    const { ws, server } = freshWorkspace("primary");
    await server.initialize();
    const totalLines = 2200; // 2200*41 = 90,200 B > READ_FULL_CAP_BYTES(81920)
    const bytes = writeExactFile(ws, "big.ts", totalLines, "oc1", LINE_WIDTH);
    expect(bytes).toBeGreaterThan(READ_FULL_CAP_BYTES);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "big.ts" }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    expect(first.body["kind"], JSON.stringify(first.body).slice(0, 300)).not.toBe("refusal");
    await assertCompleteChain({ server, first, totalLines, tag: "oc1", budgetBytes: 6144 });
  }, 180_000);

  it("just over the cap, budget 8192: every line delivered exactly once, none skipped", async () => {
    const { ws, server } = freshWorkspace("budget8192");
    await server.initialize();
    const totalLines = 2200;
    writeExactFile(ws, "big.ts", totalLines, "oc2", LINE_WIDTH);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "big.ts" }],
      content: "full",
      budget: { bytes: 8192 },
      cwd: ws,
    });
    await assertCompleteChain({ server, first, totalLines, tag: "oc2", budgetBytes: 8192 });
  }, 180_000);

  it("just over the cap, NO explicit budget (calibrated default): still completes", async () => {
    const { ws, server } = freshWorkspace("nobudget");
    await server.initialize();
    const totalLines = 2200;
    writeExactFile(ws, "big.ts", totalLines, "oc3", LINE_WIDTH);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "big.ts" }],
      content: "full",
      cwd: ws,
    });
    await assertCompleteChain({ server, first, totalLines, tag: "oc3", hopCap: 10 });
  }, 180_000);

  it("content:\"auto\" on the same over-cap file: does not hit this fix's route, and does not refuse", async () => {
    // MEASURED (probe): `content:"auto"` treats any file >= SMALL_FILE_BYTES
    // (server.ts:17274, 8192 B) as large and answers with a `read.map`
    // skeleton — an entirely different resolution than `resolveFullReadForPath`
    // /`buildFullDowngradePayload` (this fix's route), which `content:"full"`
    // alone reaches. So "auto" cannot exercise the line-skip this fix closes;
    // the honest metamorphic claim for it is narrower: this fix must not have
    // broken auto's own dispatch on the identical over-cap file.
    const { ws, server } = freshWorkspace("auto");
    await server.initialize();
    const totalLines = 2200;
    writeExactFile(ws, "big.ts", totalLines, "oc4", LINE_WIDTH);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "big.ts" }],
      content: "auto",
      cwd: ws,
    });
    expect(first.body["kind"], JSON.stringify(first.body).slice(0, 300)).not.toBe("refusal");
  }, 60_000);

  it("2x the cap, budget 6144: every line delivered exactly once, none skipped", async () => {
    const { ws, server } = freshWorkspace("2x");
    await server.initialize();
    const totalLines = 4200; // 4200*41 = 172,200 B ~= 2.1x READ_FULL_CAP_BYTES
    const bytes = writeExactFile(ws, "big.ts", totalLines, "oc5", LINE_WIDTH);
    expect(bytes).toBeGreaterThan(READ_FULL_CAP_BYTES * 2);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "big.ts" }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    await assertCompleteChain({ server, first, totalLines, tag: "oc5", budgetBytes: 6144, hopCap: 60 });
  }, 180_000);

  it("10x the cap, a wider budget (65536): every line delivered exactly once, none skipped", async () => {
    const { ws, server } = freshWorkspace("10x");
    await server.initialize();
    // `extractServedIds` (qualityFirstScenarios.ts) matches `<tag>-(\d{4})\b`
    // — EXACTLY 4 digits — so `totalLines` must stay <= 9999 or a 5-digit
    // line number becomes invisible to it (measured: a 21000-line/41B-wide
    // fixture "lost" every line >= 10000 to this harness limitation, not to
    // the server, which a raw hop-by-hop probe confirmed served all 21000).
    // A wider line reaches 10x the cap in fewer, still-4-digit-safe lines.
    const totalLines = 9500; // 9500*91 = 864,500 B ~= 10.5x READ_FULL_CAP_BYTES
    const bytes = writeExactFile(ws, "big.ts", totalLines, "oc6", 90);
    expect(bytes).toBeGreaterThan(READ_FULL_CAP_BYTES * 10);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "big.ts" }],
      content: "full",
      budget: { bytes: 65536 },
      cwd: ws,
    });
    // MEASURED: a cursor-resumed page is bounded by the per-slice serve cap
    // (~24576 B, independent of the caller's wider declared wire budget), so
    // completing 21,000 lines takes ~35 hops; hopCap is sized with margin.
    await assertCompleteChain({ server, first, totalLines, tag: "oc6", budgetBytes: 65536, hopCap: 50 });
  }, 240_000);

  it("a ranged request whose range crosses the cap (1..totalLines explicitly): none skipped", async () => {
    const { ws, server } = freshWorkspace("ranged-cross");
    await server.initialize();
    const totalLines = 2200;
    writeExactFile(ws, "big.ts", totalLines, "oc7", LINE_WIDTH);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "big.ts", range: `1-${totalLines}` }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    expect(first.body["kind"], JSON.stringify(first.body).slice(0, 300)).not.toBe("refusal");
    await assertCompleteChain({ server, first, totalLines, tag: "oc7", budgetBytes: 6144, hopCap: 40 });
  }, 180_000);

  it("a mixed batch — a ranged small file alongside an over-cap bare file — completes both, never drops either (boundary with WP-G's mixed-batch fix)", async () => {
    const { ws, server } = freshWorkspace("mixed");
    await server.initialize();
    const totalBig = 2200;
    const totalRanged = 200;
    writeExactFile(ws, "big.ts", totalBig, "mxBig", LINE_WIDTH);
    writeExactFile(ws, "ranged.ts", totalRanged, "mxRanged", 20);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "ranged.ts", range: `1-${totalRanged}` }, { path: "big.ts" }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    expect(first.body["kind"], JSON.stringify(first.body).slice(0, 300)).not.toBe("refusal");

    const firstNext = extractNext(first.body).next;
    const chain = firstNext !== undefined ? await walkHops(server, firstNext, 30) : { responses: [], capped: false };
    expect(chain.capped, JSON.stringify(chain.responses).slice(-500)).toBe(false);
    const allResponses = [first.body, ...chain.responses];

    const seenBig = new Set<number>();
    const seenRanged = new Set<number>();
    for (const r of allResponses) {
      for (const n of extractServedIds(r, ["mxBig"]).get("mxBig") ?? []) seenBig.add(n);
      for (const n of extractServedIds(r, ["mxRanged"]).get("mxRanged") ?? []) seenRanged.add(n);
    }
    expect(missingIds(idRangeSet(1, totalBig), seenBig), "big.ts (this fix's route) missing lines").toEqual([]);
    expect(missingIds(idRangeSet(1, totalRanged), seenRanged), "ranged.ts (WP-G's route) missing lines").toEqual([]);
  }, 180_000);

  it("a mid-chain file edit is honestly reflected (cursor-stale semantics, WP-D) — never a torn read", async () => {
    const { ws, server } = freshWorkspace("midedit");
    await server.initialize();
    const totalLines = 2200;
    writeExactFile(ws, "big.ts", totalLines, "ocOld", LINE_WIDTH);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "big.ts" }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    const firstNext = extractNext(first.body).next as ToolCallShape | undefined;
    expect(firstNext, JSON.stringify(first.body).slice(0, 300)).toBeDefined();

    // Same shape, new tag — a torn read would show BOTH tags.
    writeExactFile(ws, "big.ts", totalLines, "ocNew", LINE_WIDTH);
    const second = await server.callTool(firstNext!.tool, firstNext!.arguments);

    let chainStart: ToolCallShape;
    if (second.body["kind"] === "refusal") {
      expect(second.body["code"]).toBe("cursor-stale");
      const restart = extractNext(second.body).next as ToolCallShape | undefined;
      expect(restart, "a cursor-stale refusal must carry a restart next").toBeDefined();
      chainStart = restart!;
    } else {
      // The old-revision continuation resolved by handle+range instead of a
      // cursor (e.g. the calibrated no-shed path) and the handle/sha layer
      // served the new revision directly — also acceptable, AS LONG AS no
      // response ever mixes both tags (checked below over the WHOLE chain,
      // first hop included).
      chainStart = firstNext!;
      // Re-run from the top of the remaining chain using the same next.
      const chain0 = await walkHops(server, chainStart, 40);
      const allResponses = [first.body, second.body, ...chain0.responses];
      for (const r of allResponses) {
        const ids = extractServedIds(r, ["ocOld", "ocNew"]);
        const oldHit = (ids.get("ocOld")?.size ?? 0) > 0;
        const newHit = (ids.get("ocNew")?.size ?? 0) > 0;
        expect(oldHit && newHit, `a single response mixed old+new revisions: ${JSON.stringify(r).slice(0, 300)}`).toBe(false);
      }
      return;
    }

    const chain = await walkHops(server, chainStart, 40);
    expect(chain.capped, JSON.stringify(chain.responses).slice(-500)).toBe(false);
    const allResponses = [first.body, second.body, ...chain.responses];
    for (const r of allResponses) {
      const ids = extractServedIds(r, ["ocOld", "ocNew"]);
      const oldHit = (ids.get("ocOld")?.size ?? 0) > 0;
      const newHit = (ids.get("ocNew")?.size ?? 0) > 0;
      expect(oldHit && newHit, `a single response mixed old+new revisions: ${JSON.stringify(r).slice(0, 300)}`).toBe(false);
    }
  }, 180_000);
});

describe("recall control — under-cap full read is unaffected by the staging fix", () => {
  it("a file well under the cap completes normally (small budget still pages, but every line arrives)", async () => {
    const { ws, server } = freshWorkspace("undercap");
    await server.initialize();
    const totalLines = 800; // 800*41 = 32,800 B, well under READ_FULL_CAP_BYTES
    const bytes = writeExactFile(ws, "small_big.ts", totalLines, "uc1", LINE_WIDTH);
    expect(bytes).toBeLessThan(READ_FULL_CAP_BYTES);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "small_big.ts" }],
      content: "full",
      budget: { bytes: 6144 },
      cwd: ws,
    });
    await assertCompleteChain({ server, first, totalLines, tag: "uc1", budgetBytes: 6144, hopCap: 20 });
  }, 180_000);

  it("a tiny file at the calibrated default budget: single hop, no continuation at all", async () => {
    const { ws, server } = freshWorkspace("tiny");
    await server.initialize();
    writeExactFile(ws, "tiny.ts", 5, "ucT", LINE_WIDTH);

    const first = await server.callTool("tl_read_file", {
      targets: [{ path: "tiny.ts" }],
      content: "full",
      cwd: ws,
    });
    expect(first.body["kind"]).not.toBe("refusal");
    expect(extractNext(first.body).next, "a tiny file must never carry a continuation").toBeUndefined();
    const ids = extractServedIds(first.body, ["ucT"]);
    expect(missingIds(idRangeSet(1, 5), ids.get("ucT") ?? new Set())).toEqual([]);
  }, 60_000);
});
