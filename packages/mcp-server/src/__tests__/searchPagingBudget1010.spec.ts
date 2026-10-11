/**
 * searchPagingBudget1010.spec.ts — SPB (2026-10-10 independent runtime
 * review): `tl_search_files action:"find"` pages are filled to the effective
 * byte budget, and a result that fits that budget comes back in ONE page.
 *
 * THE MEASURED DEFECT (reproduced on develop 07627077 before this fix). One
 * 4.2 KB file holding 120 matching lines (`export const needle_000 = 0; // n`
 * … `needle_119`), `queries:["needle_"]`, following `limit.next` (the search
 * cursor) to exhaustion — correct every time (120 unique lines, no
 * duplicates), but:
 *
 *   no budget                          2 calls  5,688 B  first page 64 lines
 *   budget {bytes:2000}               15 calls 14,618 B  every page 8 lines, <= 1,020 B
 *   budget {bytes:8000} / {bytes:32000} / {bytes:8000, items:120}
 *                                      2 calls  ~5.7 KB  first page 64 lines
 *
 * ROOT CAUSE. Every page of a staged search request (the first page included)
 * is built by `state/searchRequestStore.ts`'s `chooseSearchPage`, which
 * stopped a page as soon as the file being accumulated reached a FIXED
 * per-file line cap — MAX_LINES_PER_FILE (8) when the effective ceiling sat at
 * the 4096-byte floor (any `budget.bytes <= 4096`), else
 * FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE (64) — whatever byte room was
 * left. A page is a PREFIX of the path-major snapshot, so that cap never put
 * another file on the page: it only ended the page early.
 *
 * THE FIX (see `chooseSearchPage`'s own doc comment): a page takes whole match
 * lines until the next one would not fit the page's byte budget (the caller's
 * `budget.bytes`/`budget.tokens`, else the default find page size — the host
 * ceiling or 16 KiB) or would cross `budget.items`, and the whole remainder is
 * one page whenever it fits beside the smaller envelope of a page that ENDS
 * the request (no `limit`, no cursor call); the envelope reserve now also
 * counts what the cursor call and the open page carry beyond the measured
 * envelope. Measured after: 1 call, 5,035 B, at no budget / 8000 / 32000;
 * 4 calls, 6,826 B, at 2000. `TL_FIND_WIDE_PAGE=0` keeps the legacy 8-line staged
 * page (the documented rollback). The ordinary (unstaged) multi-file page's
 * breadth protection — every matched file a foothold before any file widens,
 * one file's preview capped — is untouched, and pinned below.
 *
 * Judged the way the review asked: calls and total bytes to completion, every
 * page within the budget, exact once delivery — never first-page bytes alone.
 * Every case drives a REAL stdio server (`startDevServer`) and follows the
 * response's own `next` verbatim, exactly as AGENTS.md instructs a caller to.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  extractNext,
  startDevServer,
  type ConfigName,
  type DevServerOptions,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import {
  FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE,
  FIND_WIDE_PAGE_RESPONSE_BYTES,
  MAX_LINES_PER_FILE,
} from "../features/search/find/findText.js";

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

function freshWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-spb1010-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function serverFor(ws: string, config: ConfigName = "default", opts: DevServerOptions = {}): Promise<ServerHandle> {
  const server = startDevServer(ws, config, opts);
  servers.push(server);
  await server.initialize();
  return server;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEEDLE_LINES = 120;
const NEEDLE_PATH = "src/needles.ts";

/** The review's own fixture: 120 lines, `export const needle_000 = 0; // n` … (4,210 B). */
function writeNeedleFile(ws: string): void {
  const lines: string[] = [];
  for (let i = 0; i < NEEDLE_LINES; i++) lines.push(`export const needle_${String(i).padStart(3, "0")} = ${i}; // n`);
  writeFile(ws, NEEDLE_PATH, lines.join("\n") + "\n");
  expect(fs.statSync(path.join(ws, NEEDLE_PATH)).size).toBe(4210);
}

interface MultiFileFixture {
  /** Every `path:line` the find must deliver. */
  keys: Set<string>;
  /** Matching lines per file. */
  totals: Map<string, number>;
  /** Files in snapshot (path) order. */
  paths: string[];
}

/** `src/a_wide.ts` (sorts first) with `wide` matching lines, plus `small` files of `perSmall` matching lines each. */
function writeWideAndSmallFiles(ws: string, wide: number, small: number, perSmall: number): MultiFileFixture {
  const fixture: MultiFileFixture = { keys: new Set(), totals: new Map(), paths: [] };
  const add = (rel: string, lines: string[]): void => {
    writeFile(ws, rel, lines.join("\n") + "\n");
    fixture.paths.push(rel);
    fixture.totals.set(rel, lines.length);
    lines.forEach((_, index) => fixture.keys.add(`${rel}:${index + 1}`));
  };
  add("src/a_wide.ts", Array.from({ length: wide }, (_, i) => `export const needle_w${String(i).padStart(4, "0")} = ${i};`));
  for (let f = 0; f < small; f++) {
    add(
      `src/m${String(f).padStart(3, "0")}/small.ts`,
      Array.from({ length: perSmall }, (_, l) => `export const needle_s${f}_${l} = ${l};`),
    );
  }
  return fixture;
}

// ---------------------------------------------------------------------------
// Chain walking and wire accounting
// ---------------------------------------------------------------------------

interface Page {
  body: Record<string, unknown>;
  textBytes: number;
}

interface Chain {
  pages: Page[];
  capped: boolean;
  calls: number;
  totalBytes: number;
  maxPageBytes: number;
}

async function walkFind(server: ServerHandle, args: Record<string, unknown>, hopCap = 40): Promise<Chain> {
  const pages: Page[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } | undefined = { tool: "tl_search_files", arguments: args };
  while (call !== undefined) {
    if (pages.length >= hopCap) break;
    const { body, textBytes } = await server.callTool(call.tool, call.arguments);
    pages.push({ body: body as Record<string, unknown>, textBytes });
    const next = extractNext(body).next;
    if (next !== undefined) {
      // Every continuation must stay a `tl_search_files find` — never a mode
      // escalation into another tool or action.
      expect(next.tool, JSON.stringify(body).slice(0, 300)).toBe("tl_search_files");
      expect(next.arguments["action"], JSON.stringify(body).slice(0, 300)).toBe("find");
    }
    call = next;
  }
  return {
    pages,
    capped: call !== undefined,
    calls: pages.length,
    totalBytes: pages.reduce((sum, page) => sum + page.textBytes, 0),
    maxPageBytes: Math.max(...pages.map((page) => page.textBytes)),
  };
}

function matchesOf(body: Record<string, unknown>): Record<string, unknown> {
  const matches = body["matches"];
  return matches !== null && typeof matches === "object" && !Array.isArray(matches)
    ? (matches as Record<string, unknown>)
    : {};
}

interface WireFile {
  path: string;
  lines: number[];
  snippets?: string[];
  more_lines?: number;
}

function filesOf(body: Record<string, unknown>): WireFile[] {
  const files = matchesOf(body)["files"];
  return Array.isArray(files) ? (files as WireFile[]) : [];
}

/** Every `path:line` a page delivered WITH its snippet text, in wire order (duplicates kept). */
function deliveredKeys(chain: Chain): string[] {
  const keys: string[] = [];
  for (const page of chain.pages) {
    for (const file of filesOf(page.body)) {
      file.lines.forEach((line, index) => {
        if (typeof file.snippets?.[index] === "string") keys.push(`${file.path}:${line}`);
      });
    }
  }
  return keys;
}

function linesPerPage(chain: Chain): number[] {
  return chain.pages.map((page) => filesOf(page.body).reduce((sum, file) => sum + file.lines.length, 0));
}

function describeChain(chain: Chain): string {
  return `calls=${chain.calls} total=${chain.totalBytes}B max=${chain.maxPageBytes}B pages=[${chain.pages
    .map((page, index) => `${page.textBytes}B/${linesPerPage(chain)[index]}L`)
    .join(" ")}]`;
}

/** No refusal anywhere, the chain completed, and every expected line arrived exactly once. */
function expectExactOnce(chain: Chain, expected: ReadonlySet<string>): void {
  const refusals = chain.pages.filter((page) => page.body["kind"] === "refusal");
  expect(refusals.map((page) => JSON.stringify(page.body).slice(0, 300))).toEqual([]);
  expect(chain.capped, `chain never completed: ${describeChain(chain)}`).toBe(false);
  expect(chain.pages[chain.pages.length - 1]!.body["limit"], "the last page must carry no limit").toBeUndefined();
  const keys = deliveredKeys(chain);
  const unique = new Set(keys);
  expect(unique.size, `duplicates: ${keys.length - unique.size}`).toBe(keys.length);
  expect([...expected].filter((key) => !unique.has(key)), "missing lines").toEqual([]);
  expect([...unique].filter((key) => !expected.has(key)), "unexpected lines").toEqual([]);
}

/**
 * Exact counts on EVERY page: `total_matches`/`total_files` are the whole
 * result's, and each file's `lines.length + more_lines` is exactly what was
 * still owed for that file when the page was built.
 */
function expectHonestCounts(chain: Chain, totalsByPath: ReadonlyMap<string, number>): void {
  const totalMatches = [...totalsByPath.values()].reduce((sum, n) => sum + n, 0);
  const deliveredSoFar = new Map<string, number>();
  for (const page of chain.pages) {
    const matches = matchesOf(page.body);
    expect(matches["total_matches"]).toBe(totalMatches);
    expect(matches["total_files"]).toBe(totalsByPath.size);
    for (const file of filesOf(page.body)) {
      const owed = (totalsByPath.get(file.path) ?? 0) - (deliveredSoFar.get(file.path) ?? 0);
      expect(file.lines.length + (file.more_lines ?? 0), `${file.path} on page ${chain.pages.indexOf(page)}`).toBe(owed);
      expect(file.snippets?.length).toBe(file.lines.length);
    }
    for (const file of filesOf(page.body)) {
      deliveredSoFar.set(file.path, (deliveredSoFar.get(file.path) ?? 0) + file.lines.length);
    }
  }
}

const NEEDLE_KEYS: ReadonlySet<string> = new Set(
  Array.from({ length: NEEDLE_LINES }, (_, i) => `${NEEDLE_PATH}:${i + 1}`),
);
const NEEDLE_TOTALS: ReadonlyMap<string, number> = new Map([[NEEDLE_PATH, NEEDLE_LINES]]);

/** Each snippet is the text of the line it is paired with — `needle_<line-1>`. */
function expectNeedleSnippetsAligned(chain: Chain): void {
  for (const page of chain.pages) {
    for (const file of filesOf(page.body)) {
      file.lines.forEach((line, index) => {
        expect(file.snippets?.[index]).toContain(`needle_${String(line - 1).padStart(3, "0")} `);
      });
    }
  }
}

async function needleChain(budget: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): Promise<Chain> {
  const ws = freshWorkspace("needle");
  writeNeedleFile(ws);
  const server = await serverFor(ws);
  return walkFind(server, {
    action: "find",
    queries: ["needle_"],
    cwd: ws,
    ...(budget !== undefined ? { budget } : {}),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 1. The review's fixture: a result that fits the budget is ONE page.
// ---------------------------------------------------------------------------

describe("SPB: one 4.2 KB file of 120 matching lines — a result that fits the budget is one page", () => {
  for (const budget of [{ bytes: 8000 }, { bytes: 32000 }, { bytes: 8000, items: 120 }]) {
    it(`budget ${JSON.stringify(budget)}: exactly 1 call, all 120 lines (was 2 calls of 64 + 56 lines)`, async () => {
      const chain = await needleChain(budget);
      expect(chain.calls, describeChain(chain)).toBe(1);
      expect(chain.maxPageBytes).toBeLessThanOrEqual(budget.bytes);
      expect(linesPerPage(chain)).toEqual([NEEDLE_LINES]);
      expectExactOnce(chain, NEEDLE_KEYS);
      expectHonestCounts(chain, NEEDLE_TOTALS);
      expectNeedleSnippetsAligned(chain);
    }, 60_000);
  }

  it("a result whose FINISHED response fits the budget is one page, though no continuation would fit beside it", async () => {
    // The page that ends a request carries no `limit` (no cursor call, no
    // `more_lines`), so "fits the budget" is judged against THAT page — not
    // against the ~0.5 KB larger envelope a page with a continuation needs.
    const ws = freshWorkspace("boundary");
    writeNeedleFile(ws);
    const server = await serverFor(ws);
    const whole = await walkFind(server, { action: "find", queries: ["needle_"], cwd: ws, budget: { bytes: 32000 } });
    expect(whole.calls, describeChain(whole)).toBe(1);
    const size = whole.pages[0]!.textBytes;
    // 128 = the 96 B envelope safety margin (searchRequestStore.ts) plus slack.
    for (const bytes of [size + 128, size + 300]) {
      const chain = await walkFind(server, { action: "find", queries: ["needle_"], cwd: ws, budget: { bytes } });
      expect(chain.calls, `budget ${bytes} (finished page ${size} B): ${describeChain(chain)}`).toBe(1);
      expect(chain.pages[0]!.textBytes).toBe(size);
      expectExactOnce(chain, NEEDLE_KEYS);
    }
    // Just under the finished size it pages instead — never over budget.
    const under = await walkFind(server, { action: "find", queries: ["needle_"], cwd: ws, budget: { bytes: size - 1 } });
    expect(under.calls, describeChain(under)).toBeGreaterThanOrEqual(2);
    for (const page of under.pages) expect(page.textBytes, describeChain(under)).toBeLessThanOrEqual(size - 1);
    expectExactOnce(under, NEEDLE_KEYS);
    expectHonestCounts(under, NEEDLE_TOTALS);
  }, 60_000);

  it("no budget: the default find page (16 KiB) holds the whole ~5 KB result — 1 call (was 2 calls, 5,688 B)", async () => {
    const chain = await needleChain(undefined);
    // Measured after the fix: 1 call, ~5.0 KB (the second page's whole
    // envelope and cursor are gone, not just its lines).
    expect(chain.calls, describeChain(chain)).toBe(1);
    expect(chain.maxPageBytes).toBeLessThanOrEqual(FIND_WIDE_PAGE_RESPONSE_BYTES);
    expect(chain.totalBytes).toBeLessThan(5_688);
    expectExactOnce(chain, NEEDLE_KEYS);
    expectHonestCounts(chain, NEEDLE_TOTALS);
    expectNeedleSnippetsAligned(chain);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. A budget the result does NOT fit: pages are filled, not pinned at 8.
// ---------------------------------------------------------------------------

describe("SPB: a budget smaller than the result — every page is filled to the budget", () => {
  it("budget {bytes:2000}: every page <= 2000 B and filled, far fewer calls and bytes than 15 calls / 14,618 B", async () => {
    const chain = await needleChain({ bytes: 2000 });
    // Measured after the fix on this fixture: 4 calls (32 lines, ~1.9 KB a
    // page; the exact count can move with the length of the workspace path
    // the cursor call echoes), 6,826 B in total.
    expect(chain.calls, describeChain(chain)).toBeLessThanOrEqual(5);
    expect(chain.calls, describeChain(chain)).toBeGreaterThanOrEqual(3);
    expect(chain.totalBytes, describeChain(chain)).toBeLessThan(14_618 / 1.5);
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(2000);
    // Filled: every page but the last uses most of the budget (the fixed 8
    // lines used ~1 KB of it) and carries far more than 8 lines.
    chain.pages.slice(0, -1).forEach((page, index) => {
      expect(page.textBytes, describeChain(chain)).toBeGreaterThanOrEqual(2000 * 0.85);
      expect(linesPerPage(chain)[index]!, describeChain(chain)).toBeGreaterThan(3 * MAX_LINES_PER_FILE);
    });
    expectExactOnce(chain, NEEDLE_KEYS);
    expectHonestCounts(chain, NEEDLE_TOTALS);
    expectNeedleSnippetsAligned(chain);
  }, 60_000);

  it("budget {items:50} (no byte budget): pages of exactly 50/50/20 lines, each within the default page size", async () => {
    const chain = await needleChain({ items: 50 });
    expect(linesPerPage(chain), describeChain(chain)).toEqual([50, 50, 20]);
    for (const page of chain.pages) expect(page.textBytes).toBeLessThanOrEqual(FIND_WIDE_PAGE_RESPONSE_BYTES);
    expectExactOnce(chain, NEEDLE_KEYS);
    expectHonestCounts(chain, NEEDLE_TOTALS);
  }, 60_000);

  it("every cursor call re-sends the caller's budget, and every resumed page honours it", async () => {
    const chain = await needleChain({ bytes: 1500 });
    expect(chain.calls).toBeGreaterThanOrEqual(3);
    for (const page of chain.pages.slice(0, -1)) {
      const next = extractNext(page.body).next!;
      expect(next.arguments["budget"]).toEqual({ bytes: 1500 });
      expect(typeof next.arguments["cursor"]).toBe("string");
    }
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(1500);
    expectExactOnce(chain, NEEDLE_KEYS);
    expectHonestCounts(chain, NEEDLE_TOTALS);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. The page reserve: whatever the page carries besides its lines is counted.
// ---------------------------------------------------------------------------

describe("SPB: the page reserve counts everything the page carries — no page over budget", () => {
  // A page is now filled up to its budget, so every byte the reserve misses
  // would push it over (the cursor call's attributed `cwd` when the caller
  // sent none, the open page's `matched_terms`/`term_results`, a regex
  // query's `scope.regex`). One server per variant; budgets swept on it.
  //
  // A budget too small for the open page's envelope plus one line is refused
  // `budget-below-minimum` with the floor named — the documented contract —
  // and only then: never below FLOOR_CEILING here, and the named floor must
  // itself carry the whole chain within it.
  const BUDGETS = [1000, 1400, 2200, 3500, 6000];
  const FLOOR_CEILING = 1400;
  const VARIANTS: ReadonlyArray<{ name: string; args: (ws: string) => Record<string, unknown>; expected: ReadonlySet<string> }> = [
    { name: "queries[] with cwd", args: (ws) => ({ queries: ["needle_"], cwd: ws }), expected: NEEDLE_KEYS },
    { name: "queries[] without cwd (the cursor call gets the resolved root)", args: () => ({ queries: ["needle_"] }), expected: NEEDLE_KEYS },
    {
      name: "queries[] with an absent second term (term_results on the open page)",
      args: (ws) => ({ queries: ["needle_", "zzzSpbAbsentTerm"], cwd: ws }),
      expected: NEEDLE_KEYS,
    },
    {
      name: "a regex query (scope.regex echoed by the cursor call)",
      args: (ws) => ({ queries: ["needle_0[0-9]{2} "], scope: { regex: true }, cwd: ws }),
      expected: new Set(Array.from({ length: 100 }, (_, i) => `${NEEDLE_PATH}:${i + 1}`)),
    },
  ];

  for (const variant of VARIANTS) {
    it(variant.name, async () => {
      const ws = freshWorkspace("reserve");
      writeNeedleFile(ws);
      const server = await serverFor(ws);
      for (const bytes of BUDGETS) {
        let budget = bytes;
        let chain = await walkFind(server, { action: "find", ...variant.args(ws), budget: { bytes } }, 150);
        const first = chain.pages[0]!.body;
        if (first["kind"] === "refusal") {
          expect(first["code"], JSON.stringify(first)).toBe("budget-below-minimum");
          expect(bytes, `refused at ${bytes} B: ${JSON.stringify(first)}`).toBeLessThan(FLOOR_CEILING);
          const floor = first["required_min_bytes"];
          expect(typeof floor === "number" && floor > bytes, JSON.stringify(first)).toBe(true);
          budget = floor as number;
          chain = await walkFind(server, { action: "find", ...variant.args(ws), budget: { bytes: budget } }, 150);
        }
        for (const page of chain.pages) {
          expect(page.textBytes, `budget ${budget}: ${describeChain(chain)}`).toBeLessThanOrEqual(budget);
        }
        expectExactOnce(chain, variant.expected);
      }
    }, 180_000);
  }
});

// ---------------------------------------------------------------------------
// 4. Multi-file results.
// ---------------------------------------------------------------------------

describe("SPB: multi-file results", () => {
  it("a multi-file result that fits the budget comes back whole on ONE page, every file on it", async () => {
    // The wide file alone (100 lines) is past both old per-file caps; the
    // whole 112-line result is ~5 KB. Before SPB: 2 calls (64 wide lines,
    // then the rest).
    const ws = freshWorkspace("multi-fit");
    const fixture = writeWideAndSmallFiles(ws, 100, 6, 2);
    const server = await serverFor(ws);
    const chain = await walkFind(server, { action: "find", queries: ["needle_"], cwd: ws, budget: { bytes: 32000 } });
    expect(chain.calls, describeChain(chain)).toBe(1);
    expect(filesOf(chain.pages[0]!.body).map((file) => file.path)).toEqual(fixture.paths);
    expectExactOnce(chain, fixture.keys);
    expectHonestCounts(chain, fixture.totals);
  }, 60_000);

  it("a multi-file result over the budget pages exactly once across files, every page within budget", async () => {
    const ws = freshWorkspace("multi-pages");
    const fixture = writeWideAndSmallFiles(ws, 200, 6, 2);
    const server = await serverFor(ws);
    const chain = await walkFind(server, { action: "find", queries: ["needle_"], cwd: ws, budget: { bytes: 2000 } });
    // Measured: 7 calls, 12,107 B (was 25 calls of 8 lines, 22,877 B).
    expect(chain.calls, describeChain(chain)).toBeLessThanOrEqual(10);
    for (const page of chain.pages) expect(page.textBytes, describeChain(chain)).toBeLessThanOrEqual(2000);
    expectExactOnce(chain, fixture.keys);
    expectHonestCounts(chain, fixture.totals);
  }, 60_000);

  it("breadth protection still holds on the ordinary multi-file page: one wide file cannot hide the other files", async () => {
    // 250 one-match files plus one 300-match file that sorts FIRST — too many
    // footholds for one default page, so the ordinary page (findText.ts's
    // `fitFilesToCap`) answers: every file it can name gets a foothold before
    // any file widens, and the wide file is held to its per-file preview cap
    // instead of filling the page. Untouched by SPB; pinned so it stays so.
    const ws = freshWorkspace("breadth");
    const fixture = writeWideAndSmallFiles(ws, 300, 250, 1);
    expect(fixture.keys.size).toBe(550);
    const server = await serverFor(ws);
    const { body, textBytes } = await server.callTool("tl_search_files", { action: "find", queries: ["needle_"], cwd: ws });
    const matches = matchesOf(body as Record<string, unknown>);
    const files = filesOf(body as Record<string, unknown>);
    expect(matches["total_files"]).toBe(251);
    expect(matches["total_matches"]).toBe(550);
    expect(files.length, `only ${files.length} files named on the first page`).toBeGreaterThanOrEqual(100);
    const wide = files.find((file) => file.path === "src/a_wide.ts");
    expect(wide, "the wide file keeps its own foothold").toBeDefined();
    expect(wide!.lines.length).toBeLessThanOrEqual(FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE);
    expect(wide!.snippets!.length).toBeLessThanOrEqual(MAX_LINES_PER_FILE);
    expect(wide!.lines.length + (wide!.more_lines ?? 0)).toBe(300);
    // The other files' share of the page dwarfs the wide file's.
    const otherLines = files.filter((file) => file !== wide).reduce((sum, file) => sum + file.lines.length, 0);
    expect(otherLines).toBeGreaterThan(10 * wide!.lines.length);
    expect(["by-directory", true]).toContain(matches["inventory_complete"]);
    expect((body as Record<string, unknown>)["limit"]).toBeDefined();
    expect(textBytes).toBeLessThanOrEqual(FIND_WIDE_PAGE_RESPONSE_BYTES * 3);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. The documented rollback keeps the legacy staged page.
// ---------------------------------------------------------------------------

describe("SPB: TL_FIND_WIDE_PAGE=0 (the documented rollback) keeps the legacy narrow staged page", () => {
  it("budget {bytes:2000} pages at MAX_LINES_PER_FILE (8) lines, as before SPB", async () => {
    const ws = freshWorkspace("rollback");
    writeNeedleFile(ws);
    const server = await serverFor(ws, "default", { extraEnv: { TL_FIND_WIDE_PAGE: "0" } });
    const chain = await walkFind(server, { action: "find", queries: ["needle_"], cwd: ws, budget: { bytes: 2000 } });
    expect(linesPerPage(chain), describeChain(chain)).toEqual(Array.from({ length: NEEDLE_LINES / MAX_LINES_PER_FILE }, () => MAX_LINES_PER_FILE));
    expectExactOnce(chain, NEEDLE_KEYS);
  }, 60_000);
});
