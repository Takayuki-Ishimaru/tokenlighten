/**
 * evaluation0929.wholeFileBudgetChain.spec.ts — R2-R1 (final review 2026-09-30:
 * P0-2 and P1-5, plus FX1's chips 1-3).
 *
 * THE DEFECTS THIS PINS (all found by following `next` verbatim, the way
 * AGENTS.md tells a caller to):
 *
 *  P0-2  `tl_read_file {targets:[{path}], content:"full", budget:{bytes:6144}}` on a
 *        300-500-line file. The first call was REFUSED (`budget-below-minimum`,
 *        `required_min_bytes` 6230 — a moving target: a fresh call at 6230 refused
 *        again with 6318), and the refused call had already BOOKED every line of
 *        the page it never shipped. The re-issued call served 1-75; its cursor
 *        resumed at 127; lines 76-126 were never delivered and never named — no
 *        refusal, no disclosure, a silent skip.
 *        ROOT CAUSE: `emit.ts` settled the served-range ledger and the read
 *        request BEFORE its post-rewrite budget check, so a line that check
 *        dropped (or a page it replaced by a refusal) stayed booked, and
 *        `D = Q - (C u S)` never owed it again. FIX: the funnel DECIDES the final
 *        payload first (`fitStagedReadToBudget`, a dry run of the real
 *        continuation) and settles ONCE on what ships; a page that cannot fit is
 *        refused with the exact floor BEFORE a single span is booked; the
 *        producer (`planBudgetedFullServe`) sizes the head from the MEASURED
 *        response instead of a flat reserve.
 *  P1-5  Re-issuing the identical request after the chain completed returned a
 *        partial page (1-126 / the over-cap head) with NO `limit`/`next`: "no
 *        limit = complete" is the guide's contract. It must be the receipt
 *        (`read.receipt` `code-unchanged`) or a response whose `limit`/`next` is
 *        correct. Two causes: the producer's narrowing bypassed the server's
 *        receipt gate, and the over-cap governed head (`buildFullDowngradePayload`)
 *        never booked the lines it shipped, so the file was never "fully held".
 *  chip 1  a 20-line file under a 1-1.7 KiB budget was narrowed to 1-19 lines with a
 *        "single-serve cap" note where v0.14.4 served it whole.
 *  chip 2  multi-window cursor chains lost a window's last line (a booked line the
 *        post-rewrite one-line shrink then dropped) — with the budget re-declared on
 *        every hop; and, following `next` verbatim, resumed pages exceeded the
 *        budget the request carries (the funnel never saw the inherited budget).
 *  chip 3  a markdown range at 600 B refused `cap-exceeded` with a `next` that
 *        re-issued the SAME call (a 40-hop loop). A refusal's `next` must change the
 *        one thing that makes it fit — the budget, to a floor that works on the
 *        first retry.
 *
 * WHAT IS CHECKED, for every chain (`runChain` follows `next` VERBATIM, and
 * retries a `budget-below-minimum` refusal exactly once at its own
 * `required_min_bytes`):
 *   1. the first call SERVES a page within budget (a refusal, where one is
 *      legitimate, names a floor that works on its FIRST retry);
 *   2. every served hop is within the budget that hop carries (declared, or
 *      inherited by the request);
 *   3. no `next` equals the call that produced it;
 *   4. after EVERY hop the delivered lines are a gap-free, duplicate-free prefix
 *      (whole-file) / a duplicate-free subset of the requested windows (ranges);
 *   5. the chain terminates having delivered every requested line EXACTLY ONCE;
 *   6. the identical request re-issued afterwards is answered honestly.
 *
 * `content:"auto"` on a file whose map does not fit the budget answers
 * `cap-exceeded` on v0.14.4 and on this build alike (the response is a
 * `read.map`, which has no page to shrink): the cells below pin that it is an
 * HONEST refusal — never a false serve, never a `next` that repeats the call —
 * and that the same file is served at a budget that holds the map.
 *
 * Languages: byte/line arithmetic over the wire, language-agnostic; `.ts` is
 * used for the fixtures, `.md` for chip 3's markdown (headings are the one
 * per-language wrinkle the fix defers to the ladder for).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { extractNext, startDevServer, type ServerHandle, type ToolCallShape } from "./helpers/qualityFirstScenarios.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const READ_FULL_CAP_BYTES = 81920; // server.ts's own literal: a file over it is served as a governed head

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

async function freshServer(tag: string): Promise<{ ws: string; server: ServerHandle }> {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-wfbc-${tag}-`));
  tmpDirs.push(ws);
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  const server = startDevServer(ws, "default", { allowWrite: true });
  servers.push(server);
  await server.initialize();
  return { ws, server };
}

// ---------------------------------------------------------------------------
// Fixtures: every line names itself (`TAG_0007`), so delivery is read off the
// SERVED BYTES alone, never off a range the response claims.
// ---------------------------------------------------------------------------

const pad4 = (n: number): string => String(n).padStart(4, "0");

/** `export const TAG_0007 = "ppp…";` padded to EXACTLY `width` bytes (never below its own head). */
function tsLine(tag: string, n: number, width: number): string {
  const head = `export const ${tag}_${pad4(n)} = "`;
  const tail = `";`;
  return head + "p".repeat(Math.max(0, width - head.length - tail.length)) + tail;
}

function writeNumbered(ws: string, rel: string, tag: string, lines: number, width: number): number {
  const body = Array.from({ length: lines }, (_, i) => tsLine(tag, i + 1, width)).join("\n") + "\n";
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), body, "utf8");
  return Buffer.byteLength(body, "utf8");
}

/** The evidence bodies of a response (a `read.batch`'s entry contents included) — the only place a served line can be. */
function bodiesOf(body: unknown): string[] {
  const out: string[] = [];
  const evidence = (body as { evidence?: unknown } | null | undefined)?.evidence;
  if (Array.isArray(evidence)) {
    for (const entry of evidence) {
      const text = (entry as { body?: unknown } | null)?.body;
      if (typeof text === "string") out.push(text);
    }
  }
  const entries = (body as { entries?: unknown } | null | undefined)?.entries;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const content = (entry as { content?: unknown } | null)?.content;
      if (typeof content === "string") out.push(content);
    }
  }
  return out;
}

function idsOf(body: unknown, tag: string): number[] {
  const re = new RegExp(`${tag}_(\\d{4})`, "g");
  const ids: number[] = [];
  for (const text of bodiesOf(body)) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) ids.push(Number(m[1]));
  }
  return ids;
}

interface ChainHop {
  call: ToolCallShape;
  body: Record<string, any>;
  bytes: number;
  /** The budget this hop is bound by: declared on its call, else inherited from the last hop that declared one. */
  budget: number | undefined;
  via: "first" | "next" | "min-retry";
}

const declaredBytes = (args: Record<string, unknown>): number | undefined => {
  const budget = args["budget"] as { bytes?: unknown } | undefined;
  return typeof budget?.bytes === "number" ? budget.bytes : undefined;
};

/**
 * Follow a chain to its end, VERBATIM: each hop's `next` is run exactly as
 * given. A `budget-below-minimum` refusal that names `required_min_bytes` but no
 * `next` is retried ONCE per refusal — the same call at exactly that floor.
 * Stops at the end of the chain, or after `stopAfter` hops (a prefix check),
 * and reports a chain that hit `hopCap` as `capped`.
 */
async function runChain(
  server: ServerHandle,
  first: ToolCallShape,
  opts: { hopCap?: number; stopAfter?: number } = {},
): Promise<{ hops: ChainHop[]; capped: boolean }> {
  const hopCap = opts.hopCap ?? 120;
  const hops: ChainHop[] = [];
  let call = first;
  let via: ChainHop["via"] = "first";
  let budget: number | undefined;
  let floorRetries = 0;
  // A refusal that names a recovery is never the LAST hop of a stopped chain: the
  // recovery is what the rules check ("the floor works on its first retry").
  let recoveryPending = false;
  for (;;) {
    if (opts.stopAfter !== undefined && hops.length >= opts.stopAfter && !recoveryPending) return { hops, capped: false };
    if (hops.length >= hopCap) return { hops, capped: true };
    const { body, textBytes } = await server.callTool(call.tool, call.arguments);
    budget = declaredBytes(call.arguments) ?? budget;
    hops.push({ call, body, bytes: textBytes, budget, via });
    const next = extractNext(body).next;
    const floor = body["required_min_bytes"];
    recoveryPending = body["kind"] === "refusal" && (next !== undefined || typeof floor === "number");
    if (next !== undefined) {
      call = next;
      via = "next";
      continue;
    }
    if (body["kind"] === "refusal" && typeof floor === "number" && floorRetries < 6) {
      floorRetries += 1;
      call = { tool: call.tool, arguments: { ...call.arguments, budget: { bytes: floor } } };
      via = "min-retry";
      continue;
    }
    return { hops, capped: false };
  }
}

/** The rules every chain obeys, checked hop by hop (see the header). Returns the ids delivered. */
function assertChainRules(
  hops: readonly ChainHop[],
  tag: string,
  mode: "prefix" | "subset",
  wanted: ReadonlySet<number>,
  opts: { strictBudget?: boolean } = {},
): Map<number, number> {
  const strictBudget = opts.strictBudget ?? true;
  const seen = new Map<number, number>();
  hops.forEach((hop, i) => {
    const where = `hop ${i} (${hop.via}): ${JSON.stringify(hop.body).slice(0, 300)}`;
    // 3. a `next` is never the call that produced it.
    const next = extractNext(hop.body).next;
    if (next !== undefined) {
      expect(JSON.stringify(next.arguments), `a next that repeats its own call — ${where}`).not.toBe(JSON.stringify(hop.call.arguments));
    }
    // 1./2. a served hop is within the budget it carries; a refusal's floor works on the FIRST retry.
    const kind = hop.body["kind"];
    if (strictBudget && (kind === "read.text" || kind === "read.batch")) {
      if (hop.budget !== undefined) expect(hop.bytes, `over budget ${hop.budget} — ${where}`).toBeLessThanOrEqual(hop.budget);
    }
    if (kind === "refusal" && (next !== undefined || typeof hop.body["required_min_bytes"] === "number")) {
      const following = hops[i + 1];
      expect(following, `a refusal's recovery was never run — ${where}`).toBeDefined();
      if (following !== undefined) {
        expect(following.body["kind"], `the refusal's floor did not work on its first retry — ${where}\n  retry: ${JSON.stringify(following.body).slice(0, 300)}`).not.toBe("refusal");
      }
    }
    // 4. delivery accounting after every hop.
    for (const id of idsOf(hop.body, tag)) seen.set(id, (seen.get(id) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    expect(dups, `lines delivered twice — ${where}`).toEqual([]);
    const outside = [...seen.keys()].filter((id) => !wanted.has(id));
    expect(outside, `lines delivered that were never requested — ${where}`).toEqual([]);
    if (mode === "prefix") {
      const highest = Math.max(0, ...seen.keys());
      const gaps = Array.from({ length: highest }, (_, k) => k + 1).filter((id) => !seen.has(id));
      expect(gaps, `a line was skipped (the delivered set must stay a gap-free prefix) — ${where}`).toEqual([]);
    }
  });
  return seen;
}

const range = (from: number, to: number): Set<number> => new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i));

/** The identical request, re-issued after the chain completed: a receipt, or a response that is correct on its own. */
async function assertHonestRepeat(server: ServerHandle, first: ToolCallShape, tag: string, totalLines: number, expectReceipt: boolean): Promise<void> {
  const { body } = await server.callTool(first.tool, first.arguments);
  const where = `repeat: ${JSON.stringify(body).slice(0, 400)}`;
  if (body["kind"] === "read.receipt") {
    expect(body["receipt"]?.["receipt"], where).toBe("code-unchanged");
    return;
  }
  expect(expectReceipt, `the completed chain's identical request must be a receipt — ${where}`).toBe(false);
  // No receipt: then "no limit = complete" must be TRUE of what it carries.
  const carriesEverything = new Set(idsOf(body, tag)).size === totalLines;
  const continues = extractNext(body).next !== undefined || body["limit"] !== undefined;
  expect(carriesEverything || continues, `a partial page presented as complete (no limit, no next) — ${where}`).toBe(true);
}

// ---------------------------------------------------------------------------
// 1. THE MATRIX — 100/300/500/2000 lines x budgets 6144/6230/7000/8192 x
//    content full/auto.
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  tag: string;
  lines: number;
  width: number;
  /** A first page below ~90% fill is expected (a governed head: the ladder's halving sizes it). */
  fillFloor: number | undefined;
}

const FIXTURES: readonly Fixture[] = [
  { name: "100 lines", tag: "AA", lines: 100, width: 40, fillFloor: undefined },
  { name: "300 lines", tag: "BB", lines: 300, width: 40, fillFloor: 0.9 },
  { name: "500 lines", tag: "CC", lines: 500, width: 40, fillFloor: 0.9 },
  { name: "2000 short lines (under the 80 KiB full cap)", tag: "DD", lines: 2000, width: 28, fillFloor: 0.9 },
  { name: "2000 lines (over the 80 KiB full cap: a governed head)", tag: "EE", lines: 2000, width: 44, fillFloor: undefined },
];
const BUDGETS = [6144, 6230, 7000, 8192] as const;

describe("whole-file content:\"full\" under a declared budget (review P0-2 + P1-5)", () => {
  for (const fixture of FIXTURES) {
    for (const budget of BUDGETS) {
      it(`${fixture.name} @ ${budget} B: first call serves within budget, the chain delivers every line exactly once, the identical re-request is the receipt`, async () => {
        const { ws, server } = await freshServer(`full-${fixture.tag}-${budget}`);
        const bytes = writeNumbered(ws, "src/a.ts", fixture.tag, fixture.lines, fixture.width);
        if (fixture.tag === "EE") expect(bytes, "this fixture must be OVER the full cap").toBeGreaterThan(READ_FULL_CAP_BYTES);
        if (fixture.tag === "DD") expect(bytes, "this fixture must be UNDER the full cap").toBeLessThan(READ_FULL_CAP_BYTES);
        const first: ToolCallShape = {
          tool: "tl_read_file",
          arguments: { targets: [{ path: "src/a.ts" }], content: "full", budget: { bytes: budget }, cwd: ws },
        };

        const { hops, capped } = await runChain(server, first);
        expect(capped, "the chain never terminated").toBe(false);

        // 1. the FIRST call serves a page within budget — no refusal where v0.14.4 served.
        const head = hops[0]!;
        expect(head.body["kind"], `first call: ${JSON.stringify(head.body).slice(0, 300)}`).toBe("read.text");
        expect(head.bytes).toBeLessThanOrEqual(budget);
        expect(hops.filter((hop) => hop.body["kind"] === "refusal"), "no refusal anywhere in this chain").toEqual([]);

        // 2.-5. every hop within budget, gap-free prefix, exactly once, to the end.
        const seen = assertChainRules(hops, fixture.tag, "prefix", range(1, fixture.lines));
        expect([...seen.keys()].length, "every line delivered").toBe(fixture.lines);
        const last = hops[hops.length - 1]!;
        expect(last.body["limit"], "the last hop must not claim more to come").toBeUndefined();
        expect(extractNext(last.body).next).toBeUndefined();

        // fill: a non-final first page uses the budget it was given (BCF2: >= 0.9).
        if (fixture.fillFloor !== undefined && hops.length > 1) {
          expect(head.bytes / budget, `first page fill ${head.bytes}/${budget}`).toBeGreaterThanOrEqual(fixture.fillFloor);
        }

        // 6. P1-5: the completed request, re-issued, is the receipt.
        await assertHonestRepeat(server, first, fixture.tag, fixture.lines, true);
      }, 120_000);
    }
  }

  it("content:\"auto\" whole-file at every budget: a file whose text fits is served whole; otherwise an honest refusal (both builds), served once the budget holds the map", async () => {
    const { ws, server } = await freshServer("auto");
    for (const fixture of FIXTURES) {
      for (const budget of BUDGETS) {
        const rel = `src/auto-${fixture.tag}-${budget}.ts`;
        writeNumbered(ws, rel, fixture.tag, fixture.lines, fixture.width);
        const first: ToolCallShape = { tool: "tl_read_file", arguments: { targets: [{ path: rel }], budget: { bytes: budget }, cwd: ws } };
        const { hops, capped } = await runChain(server, first, { hopCap: 80 });
        expect(capped).toBe(false);
        const head = hops[0]!;
        const where = `${fixture.name} @ ${budget}: ${JSON.stringify(head.body).slice(0, 300)}`;
        if (head.body["kind"] === "read.text") {
          // served: within budget, and it must carry what it claims — every line, or a correct continuation.
          expect(head.bytes, where).toBeLessThanOrEqual(budget);
          const seen = assertChainRules(hops, fixture.tag, "prefix", range(1, fixture.lines));
          expect(seen.size, `auto served text but delivered ${seen.size}/${fixture.lines} — ${where}`).toBe(fixture.lines);
          await assertHonestRepeat(server, first, fixture.tag, fixture.lines, false);
        } else {
          // the map does not fit: an HONEST refusal — never a false serve, never a next that repeats the call.
          expect(head.body["kind"], where).toBe("refusal");
          expect(head.body["code"], where).toBe("cap-exceeded");
          expect(head.body["retry"], where).toBe("call");
          expect(hops, `a refusal without a recovery ends the chain — ${where}`).toHaveLength(1);
          // ... and the same file IS served at a budget that holds the map.
          const roomy = await server.callTool("tl_read_file", { targets: [{ path: rel }], budget: { bytes: 32768 }, cwd: ws });
          expect(roomy.body["kind"], `served at 32 KiB — ${where}`).not.toBe("refusal");
        }
      }
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 2. FX1 chip 1 — a file that fits whole is served whole (content:"full").
// ---------------------------------------------------------------------------

describe("chip 1: content:\"full\" serves a small file whole, no note, where v0.14.4 did", () => {
  // The full-read governor spends a per-TASK whole-file budget: a seventh whole-file expansion in one
  // session is answered by a map ("per-task whole-file budget spent on other files"). That is v0.14.4's
  // own governor, not this fix's business — so each group of budgets gets a fresh server.
  const GROUPS: number[][] = [[620, 700, 800], [1000, 1100, 1200], [1300, 1400, 1500], [1700]];
  for (const budgets of GROUPS) {
    it(`a 20-line file, budgets ${budgets.join("/")} B`, async () => {
      const { ws, server } = await freshServer(`chip1-${budgets[0]}`);
      const text = Array.from({ length: 20 }, (_, i) => `export const C${i} = ${i};`).join("\n") + "\n";
      let previousBytes = 0;
      for (const budget of budgets) {
        const rel = `src/f20-${String(budget).padStart(4, "0")}.ts`; // the path rides the wire: one length for every budget
        fs.writeFileSync(path.join(ws, rel), text, "utf8");
        const { body, textBytes } = await server.callTool("tl_read_file", { targets: [{ path: rel }], content: "full", budget: { bytes: budget }, cwd: ws });
        const where = `budget ${budget}: ${JSON.stringify(body).slice(0, 300)}`;
        expect(body["kind"], where).toBe("read.text");
        expect(body["evidence"]?.[0]?.["range"], `served whole — ${where}`).toBe("1-20");
        expect(body["limit"], `no continuation for a file that fits — ${where}`).toBeUndefined();
        expect(body["note"], `no "single-serve cap" note — ${where}`).toBeUndefined();
        expect(textBytes, where).toBeLessThanOrEqual(budget);
        // the whole response is one size, whatever the budget above it.
        if (previousBytes !== 0) expect(textBytes, where).toBe(previousBytes);
        previousBytes = textBytes;
      }
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// 3. FX1 chip 2 — multi-window chains: every requested line exactly once.
// ---------------------------------------------------------------------------

const WINDOW_SETS: Record<string, string[]> = {
  m2: ["20-30", "150-190"],
  m3: ["1-10", "100-110", "200-215"],
  m4: ["1-5", "20-30", "60-70", "150-190"],
  m5: ["1-3", "10-12", "40-60", "100-120", "200-230"],
  m6: ["1-2", "5-7", "20-25", "60-70", "120-150", "250-300"],
};

function wantedOf(ranges: readonly string[], totalLines: number): Set<number> {
  const wanted = new Set<number>();
  for (const spec of ranges) {
    const [from, to] = spec.split("-").map(Number) as [number, number];
    for (let line = from; line <= Math.min(to, totalLines); line += 1) wanted.add(line);
  }
  return wanted;
}

describe("chip 2: a multi-window chain delivers every requested line exactly once, within every hop's budget", () => {
  it("the reviewer's repro — 300 wide lines, ranges [1-5, 20-30, 60-70, 150-190], budget 2500 (line 30 was lost)", async () => {
    const { ws, server } = await freshServer("chip2-repro");
    writeNumbered(ws, "src/wide.ts", "WW", 300, 84);
    const ranges = WINDOW_SETS["m4"]!;
    const first: ToolCallShape = { tool: "tl_read_file", arguments: { targets: [{ path: "src/wide.ts", ranges }], budget: { bytes: 2500 }, cwd: ws } };
    const { hops, capped } = await runChain(server, first);
    expect(capped).toBe(false);
    const seen = assertChainRules(hops, "WW", "subset", wantedOf(ranges, 300));
    expect([...seen.keys()].sort((a, b) => a - b), "the delivered set is exactly the requested set").toEqual([...wantedOf(ranges, 300)].sort((a, b) => a - b));
    expect(seen.get(30), "line 30 — the last line of the second window — was delivered").toBe(1);
    await assertHonestRepeat(server, first, "WW", 68, true);
  }, 60_000);

  it("the same repro with the budget RE-DECLARED on every hop (how a client that adds `budget` to each cursor call sees it)", async () => {
    const { ws, server } = await freshServer("chip2-redeclare");
    writeNumbered(ws, "src/wide.ts", "WW", 300, 84);
    const ranges = WINDOW_SETS["m4"]!;
    for (const budget of [1500, 1800, 2048, 2500, 3000, 4096, 6144, 8192]) {
      const rel = `src/wide-${budget}.ts`;
      writeNumbered(ws, rel, "WW", 300, 84);
      let call: ToolCallShape | undefined = { tool: "tl_read_file", arguments: { targets: [{ path: rel, ranges }], budget: { bytes: budget }, cwd: ws } };
      const seen = new Map<number, number>();
      for (let hop = 0; call !== undefined && hop < 40; hop += 1) {
        const { body, textBytes } = await server.callTool(call.tool, call.arguments);
        const where = `budget ${budget}, hop ${hop}: ${JSON.stringify(body).slice(0, 300)}`;
        expect(body["kind"], where).not.toBe("refusal");
        expect(textBytes, `over budget — ${where}`).toBeLessThanOrEqual(budget);
        for (const id of idsOf(body, "WW")) seen.set(id, (seen.get(id) ?? 0) + 1);
        const next = extractNext(body).next;
        call = next === undefined ? undefined : { tool: next.tool, arguments: { ...next.arguments, budget: { bytes: budget } } };
      }
      expect(call, `budget ${budget}: the chain never ended`).toBeUndefined();
      expect([...seen.keys()].sort((a, b) => a - b), `budget ${budget}: delivered set`).toEqual([...wantedOf(ranges, 300)].sort((a, b) => a - b));
      expect([...seen.values()].filter((count) => count !== 1), `budget ${budget}: lines delivered twice`).toEqual([]);
    }
  }, 120_000);

  it("2-6 windows x budgets (verbatim next): exactly once, every hop within its budget", async () => {
    const { ws, server } = await freshServer("chip2-sweep");
    for (const [name, ranges] of Object.entries(WINDOW_SETS)) {
      for (const budget of [1500, 2500, 4096]) {
        for (const [fixture, tag, width] of [["wide", "WW", 84], ["plain", "PP", 40]] as const) {
          const rel = `src/${name}-${fixture}-${budget}.ts`;
          writeNumbered(ws, rel, tag, 300, width);
          const first: ToolCallShape = { tool: "tl_read_file", arguments: { targets: [{ path: rel, ranges }], budget: { bytes: budget }, cwd: ws } };
          const { hops, capped } = await runChain(server, first);
          const where = `${name}/${fixture}/${budget}`;
          expect(capped, `${where}: chain never ended`).toBe(false);
          const wanted = wantedOf(ranges, 300);
          const seen = assertChainRules(hops, tag, "subset", wanted);
          expect([...seen.keys()].sort((a, b) => a - b), `${where}: delivered set`).toEqual([...wanted].sort((a, b) => a - b));
        }
      }
    }
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 4. FX1 chip 3 — a refusal's `next` is never the identical call, and works
//    on the first retry.
// ---------------------------------------------------------------------------

describe("chip 3: a budget refusal's next changes what makes the call fit (never the identical call, never a loop)", () => {
  const NOTES = Array.from({ length: 6 }, (_, i) => `# Section ${i}\n\nParagraph ${i} line one.\nParagraph ${i} line two.\n`).join("\n");

  it("a markdown range at 400-900 B: served, or refused with a next that works on its first retry", async () => {
    const { ws, server } = await freshServer("chip3-md");
    for (const budget of [400, 500, 600, 700, 800, 900]) {
      // the served-range ledger is keyed by path: one copy of the document per budget.
      const rel = `src/notes-${budget}.md`;
      fs.writeFileSync(path.join(ws, rel), NOTES, "utf8");
      const first: ToolCallShape = { tool: "tl_read_file", arguments: { targets: [{ path: rel, range: "1-20" }], budget: { bytes: budget }, cwd: ws } };
      const { hops, capped } = await runChain(server, first, { hopCap: 8 });
      const where = `budget ${budget}: ${hops.map((hop) => `${hop.body["kind"]}${hop.body["code"] ? ":" + hop.body["code"] : ""} ${hop.bytes}B`).join(" -> ")}`;
      expect(capped, `a refusal loop — ${where}`).toBe(false);
      assertChainRules(hops, "ZZ", "subset", new Set());
      const last = hops[hops.length - 1]!;
      expect(last.body["kind"], `the chain must END served — ${where}`).toBe("read.text");
      // it served the requested range: line 20 is the last line of section 3's paragraph block.
      expect(JSON.stringify(last.body), where).toContain("Paragraph 3 line two.");
      // a refusal is followed by at most one recovery hop.
      expect(hops.length, where).toBeLessThanOrEqual(2);
      // the completed request, re-issued, is a receipt.
      const repeat = await server.callTool(first.tool, first.arguments);
      expect(repeat.body["kind"], `repeat — ${JSON.stringify(repeat.body).slice(0, 200)}`).toBe("read.receipt");
    }
  }, 120_000);

  it("a markdown section whose single line is far larger than the budget: the refusal names the floor that serves it", async () => {
    const { ws, server } = await freshServer("chip3-huge-md");
    const huge = "# Title\n\n" + "word ".repeat(600) + "\n\n## Tail\n\nshort tail line\n";
    for (const budget of [600, 1500]) {
      const rel = `src/huge-${budget}.md`;
      fs.writeFileSync(path.join(ws, rel), huge, "utf8");
      const first: ToolCallShape = { tool: "tl_read_file", arguments: { targets: [{ path: rel, range: "1-9" }], budget: { bytes: budget }, cwd: ws } };
      const { hops, capped } = await runChain(server, first, { hopCap: 6 });
      const where = `budget ${budget}: ${hops.map((hop) => `${hop.body["kind"]}${hop.body["code"] ? ":" + hop.body["code"] : ""} ${hop.bytes}B`).join(" -> ")}`;
      expect(capped, where).toBe(false);
      assertChainRules(hops, "ZZ", "subset", new Set());
      expect(hops[0]!.body["kind"], where).toBe("refusal");
      const recovery = hops[1]!;
      expect(recovery.via, where).toBe("next");
      expect(declaredBytes(recovery.call.arguments)!, `the next RAISES the budget — ${where}`).toBeGreaterThan(budget);
      expect(recovery.body["kind"], where).toBe("read.text");
      expect(JSON.stringify(recovery.body), where).toContain("short tail line");
    }
  }, 60_000);

  it("a single line larger than the budget in a code file: the first line is served, the resumed page's floor works on the first retry", async () => {
    const { ws, server } = await freshServer("chip3-huge-ts");
    const lines = [`export const HH_0001 = 1;`, `export const HH_0002 = "${"x".repeat(3000)}";`, `export const HH_0003 = 3;`];
    fs.writeFileSync(path.join(ws, "src/hugeline.ts"), lines.join("\n") + "\n", "utf8");
    const first: ToolCallShape = { tool: "tl_read_file", arguments: { targets: [{ path: "src/hugeline.ts", range: "1-3" }], budget: { bytes: 600 }, cwd: ws } };
    const { hops, capped } = await runChain(server, first);
    expect(capped).toBe(false);
    const seen = assertChainRules(hops, "HH", "prefix", range(1, 3));
    expect([...seen.keys()].sort()).toEqual([1, 2, 3]);
    // the oversized line took a floor retry (a refusal that NAMES its minimum), and that minimum worked once.
    expect(hops.some((hop) => hop.via === "min-retry"), hops.map((hop) => hop.body["kind"]).join(",")).toBe(true);
  }, 60_000);
});

describe("chip 3 (markdown sections) and the multi-target batch: a refusal's recovery works and never widens the caller's budget for nothing", () => {
  it("a markdown range/sections read at 500-2000 B: a cap-exceeded refusal's floor works on the first retry; the chain ends", async () => {
    const { ws, server } = await freshServer("md-sections");
    const doc = Array.from({ length: 40 }, (_, i) => `# Section ${i}\n\nParagraph ${i} line one with some words here.\nParagraph ${i} line two with more words here.\n`).join("\n");
    for (const budget of [500, 700, 1200, 2000]) {
      const rel = `src/sections-${String(budget).padStart(4, "0")}.md`;
      fs.writeFileSync(path.join(ws, rel), doc, "utf8");
      // This chain has always been a WHOLE-FILE markdown read under a budget:
      // it used to send `sections` inside the target object, which is not a
      // target member (`select.sections` is), and the canonical projection
      // dropped it silently. The 2026-10-10 request validation refuses that
      // member as unknown, so the call now states the read it always made.
      const first: ToolCallShape = { tool: "tl_read_file", arguments: { targets: [{ path: rel }], budget: { bytes: budget }, cwd: ws } };
      const { hops, capped } = await runChain(server, first, { hopCap: 40 });
      const where = `budget ${budget}: ${hops.map((hop) => `${hop.body["kind"]}${hop.body["code"] ? ":" + hop.body["code"] : ""} ${hop.bytes}B`).join(" -> ")}`;
      expect(capped, `a refusal loop — ${where}`).toBe(false);
      // a markdown page carries a heading index no rung can shed; a RESUMED page that cannot fit its inherited
      // budget ships as chosen (v0.14.4), so only the recovery rules are strict here.
      assertChainRules(hops, "ZZ", "subset", new Set(), { strictBudget: false });
      expect(hops[0]!.body["kind"], where).toBe("read.text");
      expect(hops[0]!.bytes, where).toBeLessThanOrEqual(budget);
      expect(hops[hops.length - 1]!.body["kind"], `the chain must END served — ${where}`).toBe("read.text");
      expect(hops.length, `no more than v0.14.4's handful of hops — ${where}`).toBeLessThanOrEqual(14);
    }
  }, 120_000);

  for (const budget of [900, 1500, 3000, 6144]) {
    it(`two files, content:"full" @ ${budget} B: any refusal's next is a cursor that pages INSIDE the declared budget; every line of both files exactly once`, async () => {
      const { ws, server } = await freshServer(`batch-${budget}`);
      writeNumbered(ws, "src/a.ts", "AA", 120, 40);
      writeNumbered(ws, "src/b.ts", "BB", 90, 40);
      const first: ToolCallShape = {
        tool: "tl_read_file",
        arguments: { targets: [{ path: "src/a.ts" }, { path: "src/b.ts" }], content: "full", budget: { bytes: budget }, cwd: ws },
      };
      const { hops, capped } = await runChain(server, first, { hopCap: 120 });
      expect(capped, "the chain never terminated").toBe(false);
      const head = hops[0]!;
      if (head.body["kind"] === "refusal") {
        // v0.14.4's recovery: the cursor keeps the caller's own budget (no raise) — a restart at the batch's
        // whole-entry floor would answer a 900 B budget with a ~5.5 KB batch.
        const next = extractNext(head.body).next;
        expect(next, JSON.stringify(head.body).slice(0, 300)).toBeDefined();
        expect(next!.arguments["cursor"], "the refusal's next is the cursor").toBeDefined();
        expect(declaredBytes(next!.arguments), "the cursor does not raise the caller's budget").toBeUndefined();
      }
      // the served hops after the first stay inside the declared budget (hop 0 of a served batch too).
      assertChainRules(hops, "AA", "prefix", range(1, 120));
      const seen = assertChainRules(hops, "BB", "prefix", range(1, 90));
      expect(seen.size, "every line of the second file delivered").toBe(90);
      const seenA = new Set<number>();
      for (const hop of hops) for (const id of idsOf(hop.body, "AA")) seenA.add(id);
      expect(seenA.size, "every line of the first file delivered").toBe(120);
    }, 120_000);
  }
});

describe("an identical whole-file call is never answered as COMPLETE before the chain is (v0.14.4 answered a receipt after one page)", () => {
  for (const comments of [undefined, "keep"] as const) {
    it(`500 lines @ 6144 B, comments ${comments ?? "default"}: the second identical call carries a continuation; the completed chain's repeat is the receipt`, async () => {
      const { ws, server } = await freshServer(`mid-${comments ?? "elide"}`);
      writeNumbered(ws, "src/a.ts", "MM", 500, 40);
      const first: ToolCallShape = {
        tool: "tl_read_file",
        arguments: { targets: [{ path: "src/a.ts" }], content: "full", ...(comments !== undefined ? { comments } : {}), budget: { bytes: 6144 }, cwd: ws },
      };
      const opening = await server.callTool(first.tool, first.arguments);
      expect(opening.body["kind"]).toBe("read.text");
      const openingNext = extractNext(opening.body).next;
      expect(openingNext, "the first page names its continuation").toBeDefined();

      // the identical call, before anything else was delivered: NOT a receipt, and not a page that claims to be the whole.
      const second = await server.callTool(first.tool, first.arguments);
      expect(second.body["kind"], `false completion — ${JSON.stringify(second.body).slice(0, 300)}`).not.toBe("read.receipt");
      expect(extractNext(second.body).next, `a partial page with no continuation — ${JSON.stringify(second.body).slice(0, 300)}`).toBeDefined();

      // the chain from the FIRST call's cursor still delivers everything exactly once, and then the repeat is the receipt.
      const { hops, capped } = await runChain(server, openingNext!);
      expect(capped).toBe(false);
      const all: ChainHop[] = [{ call: first, body: opening.body, bytes: opening.textBytes, budget: 6144, via: "first" }, ...hops];
      const seen = assertChainRules(all, "MM", "prefix", range(1, 500));
      expect(seen.size).toBe(500);
      await assertHonestRepeat(server, first, "MM", 500, true);
    }, 120_000);
  }
});

// ---------------------------------------------------------------------------
// 5. Tiny budgets — a refused call books nothing: what follows starts at
//    line 1 and never skips.
// ---------------------------------------------------------------------------

describe("a refused first call books nothing: the retry starts at line 1 and the delivered lines stay a gap-free prefix", () => {
  for (const budget of [300, 450, 540, 580, 600, 640, 720]) {
    it(`300 lines @ ${budget} B, first eight hops`, async () => {
      const { ws, server } = await freshServer(`tiny-${budget}`);
      writeNumbered(ws, "src/a.ts", "TT", 300, 40);
      const first: ToolCallShape = { tool: "tl_read_file", arguments: { targets: [{ path: "src/a.ts" }], content: "full", budget: { bytes: budget }, cwd: ws } };
      const { hops } = await runChain(server, first, { stopAfter: 8 });
      const seen = assertChainRules(hops, "TT", "prefix", range(1, 300));
      // whatever was refused on the way, SOMETHING was delivered and it began at line 1.
      expect(seen.get(1), `line 1 was never delivered — ${hops.map((hop) => hop.body["kind"]).join(",")}`).toBe(1);
    }, 60_000);
  }
});
