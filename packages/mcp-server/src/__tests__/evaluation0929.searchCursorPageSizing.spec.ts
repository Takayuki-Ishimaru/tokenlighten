/**
 * evaluation0929.searchCursorPageSizing.spec.ts — V15-SPC2 (search cursor
 * pages sized to the same policy as the first page, 2026-09-29).
 *
 * V15-SPC (evaluation0929.searchPageSizing.spec.ts) widened the ORDINARY,
 * non-staged find pipeline's per-file line cap from the bare
 * MAX_LINES_PER_FILE(8) to the headroom-gated FIND_WIDE_PAGE_MAX_LINE_
 * NUMBERS_PER_FILE(64) (findText.ts's capFileGroup/findResponseCapBytes).
 * `state/searchRequestStore.ts`'s `chooseSearchPage` — the ONE function that
 * builds EVERY page of a STAGED search request, including a staged
 * request's own first page and every later cursor resume — was left
 * hardcoded at the bare 8, regardless of TL_FIND_WIDE_PAGE or how much byte
 * headroom the response actually had. A single file needing genuine
 * multi-hop cursor pagination (e.g. 200 matching lines) therefore always
 * took ~25 hops (200/8) no matter how generous the effective ceiling was.
 * `chooseSearchPage` now resolves the same three-tier ceiling
 * (`effectiveSearchPageLineCap`, that module) — caller budget inherited
 * through the cursor's stored state > host ceiling > the flat 16 KB default
 * — on EVERY page it builds, so a genuinely wide-open request pages at 64
 * lines/hop throughout, while a request whose caller declared a small
 * budget stays correctly narrowed to 8 on every hop, not just the first.
 *
 * SPB (2026-10-10 independent runtime review) RE-POINTED cases 1, 3 and 4.
 * The per-file line cap this spec pinned (8, or 64 past the legacy floor) is
 * gone from staged pages: a page is a PREFIX of the path-major snapshot, so
 * that cap never brought another file onto it — it only ended the page early
 * (a 4.2 KB, 120-line result took 2 calls at any budget, 15 at
 * `budget.bytes:2000`). A staged page is now filled to its byte budget — the
 * caller's `budget.bytes`, else the host ceiling, else the 16 KiB default
 * page — on EVERY hop. What these cases prove is unchanged in kind (the
 * budget the original call resolved still governs every resume, not only
 * page 1); what they measure is now bytes per page, with fixtures large
 * enough that a filled page still leaves something for a resume. See
 * `searchPagingBudget1010.spec.ts` for the review's own fixture.
 *
 * Every case here drives a REAL stdio server (`startDevServer`) and follows
 * `next`/`cursor` verbatim, exactly as AGENTS.md instructs a caller to.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  extractNext,
  extractServedIds,
  idRangeSet,
  missingIds,
  selfIdLine,
  startDevServer,
  unionInto,
  walkHops,
  writeSelfIdFile,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import {
  FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE,
  FIND_WIDE_PAGE_RESPONSE_BYTES,
} from "../features/search/find/findText.js";
import { resolveClientProfile } from "../protocol/codec/clientProfile.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-scps-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function matchesOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const matches = body["matches"];
  return matches !== null && typeof matches === "object" && !Array.isArray(matches)
    ? (matches as Record<string, unknown>)
    : undefined;
}

function firstFileOf(body: Record<string, unknown>): { lines: number[]; more_lines?: number } | undefined {
  const files = matchesOf(body)?.["files"];
  return Array.isArray(files) ? (files[0] as { lines: number[]; more_lines?: number } | undefined) : undefined;
}

/** Raw occurrence COUNT of `${tag}-NNNN` across a chain of responses — catches
 *  a line served TWICE, which a Set-based completeness check alone would
 *  miss. Mirrors evaluation0929.cursorStaleRestart.spec.ts's own helper. */
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

/** `walkHops`, plus each response's raw wire size (SPB: pages are judged in bytes). */
async function walkHopsMeasured(
  server: ServerHandle,
  args: Record<string, unknown>,
  hopCap: number,
): Promise<{ responses: unknown[]; bytes: number[]; capped: boolean }> {
  const responses: unknown[] = [];
  const bytes: number[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } | undefined = { tool: "tl_search_files", arguments: args };
  while (call !== undefined) {
    if (responses.length >= hopCap) return { responses, bytes, capped: true };
    const { body, textBytes } = await server.callTool(call.tool, call.arguments);
    responses.push(body);
    bytes.push(textBytes);
    call = extractNext(body).next;
  }
  return { responses, bytes, capped: false };
}

/** Every response must be a `tl_search_files find` continuation — never a mode
 *  escalation into a different tool/action. */
function assertNoEscalation(responses: readonly unknown[]): void {
  for (const r of responses) {
    const body = r as Record<string, unknown>;
    const next = extractNext(body).next;
    if (next !== undefined) {
      expect(next.tool, JSON.stringify(body).slice(0, 200)).toBe("tl_search_files");
      expect(next.arguments["action"], JSON.stringify(body).slice(0, 200)).toBe("find");
    }
  }
}

// ---------------------------------------------------------------------------
// 1. A single 200-line file — every hop is filled to the default page.
// ---------------------------------------------------------------------------

const WIDE_TAG = "cursorWideFileTag";
const WIDE_TOTAL_LINES = 200;

describe("single-file cursor pagination fills the default page on every hop, not just page 1", () => {
  it("no declared budget: every hop fits the 16 KiB default page, and page 1 is filled far past the old 64-line cap", async () => {
    const ws = freshWorkspace("wide-single");
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    // ~85 B lines (the helper pads to 24 B with an 80 B filler): ~16 KB of
    // snippets, just over one default page, so a resume still happens.
    writeSelfIdFile(ws, "src/big.ts", WIDE_TOTAL_LINES, WIDE_TAG, 24);

    const chain = await walkHopsMeasured(server, { action: "find", queries: [WIDE_TAG], scope: { path: "src" }, cwd: ws }, 10);
    expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
    assertNoEscalation(chain.responses);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals, JSON.stringify(refusals).slice(0, 300)).toEqual([]);

    // SPC2 stopped every hop at 64 lines (4 hops here; ~25 before SPC2). SPB
    // fills each hop to the default page instead (measured: 176 + 24 lines,
    // 16.2 KB + 2.3 KB) — and never past it.
    const perHopLineCounts = chain.responses.map((r) => firstFileOf(r as Record<string, unknown>)?.lines.length ?? 0);
    for (const bytes of chain.bytes) {
      expect(bytes, `a page exceeded the default page: ${JSON.stringify(chain.bytes)}`).toBeLessThanOrEqual(FIND_WIDE_PAGE_RESPONSE_BYTES);
    }
    expect(perHopLineCounts[0], JSON.stringify(perHopLineCounts)).toBeGreaterThan(2 * FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE);
    expect(chain.bytes[0], JSON.stringify(chain.bytes)).toBeGreaterThanOrEqual(0.9 * FIND_WIDE_PAGE_RESPONSE_BYTES);
    expect(chain.responses.length, JSON.stringify(perHopLineCounts)).toBe(2);

    // Exact-once delivery across the whole chain: every one of the 200 lines
    // served, none missing, none duplicated.
    const served = new Map<string, Set<number>>();
    for (const r of chain.responses) unionInto(served, extractServedIds(r, [WIDE_TAG]));
    expect(missingIds(idRangeSet(1, WIDE_TOTAL_LINES), served.get(WIDE_TAG) ?? new Set())).toEqual([]);
    expect(countTagOccurrences(chain.responses, WIDE_TAG)).toBe(WIDE_TOTAL_LINES);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Many files sharing one cursor chain — the dynamic cap does not disturb
//    multi-file exact-once delivery.
// ---------------------------------------------------------------------------

const MANY_FILES_COUNT = 40;
const MANY_FILES_LINES_PER_FILE = 3;
const MANY_FILES_TAG = "cursorManyFilesTag";
const MANY_FILES_TOTAL = MANY_FILES_COUNT * MANY_FILES_LINES_PER_FILE;

function buildManyFilesFixture(ws: string): void {
  let counter = 1;
  for (let f = 0; f < MANY_FILES_COUNT; f++) {
    const lines: string[] = [];
    for (let l = 0; l < MANY_FILES_LINES_PER_FILE; l++) {
      lines.push(selfIdLine(MANY_FILES_TAG, counter, 24));
      counter += 1;
    }
    writeFile(ws, `src/many/f${String(f).padStart(3, "0")}.ts`, lines.join("\n") + "\n");
  }
}

describe("many-file cursor pagination stays exact under the dynamic per-file cap", () => {
  it("every file's every line is delivered exactly once across the chain (no file individually near the cap)", async () => {
    const ws = freshWorkspace("many-files");
    // 2026-10-19: with TL_EFF_FIND_SNIPPET_CAP (default ON) the first page
    // carries snippets for ten of the 40 files and fits the 8192-byte budget
    // whole, so no cursor chain is staged and the 30 lines-only files' ids are
    // never quoted. Pinned off so the paged chain this case audits still runs.
    const server = startDevServer(ws, "default", { extraEnv: { TL_EFF_FIND_SNIPPET_CAP: "0" } });
    servers.push(server);
    await server.initialize();
    buildManyFilesFixture(ws);

    const chain = await walkHops(
      server,
      {
        tool: "tl_search_files",
        arguments: {
          action: "find",
          queries: [MANY_FILES_TAG],
          scope: { path: "src" },
          budget: { bytes: 8192 },
          cwd: ws,
        },
      },
      15,
    );
    expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
    assertNoEscalation(chain.responses);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals, JSON.stringify(refusals).slice(0, 300)).toEqual([]);

    // Every response's own per-file byte budget (8192 B, well above the
    // legacy floor) keeps the wide cap active, but no single file here has
    // more than MANY_FILES_LINES_PER_FILE(3) matches — the per-file cap
    // never binds; this proves the ROOM-based multi-file fitting (footholds,
    // round-robin widening) is unaffected by computing the dynamic cap once
    // per chooseSearchPage call.
    const served = new Map<string, Set<number>>();
    for (const r of chain.responses) unionInto(served, extractServedIds(r, [MANY_FILES_TAG]));
    expect(missingIds(idRangeSet(1, MANY_FILES_TOTAL), served.get(MANY_FILES_TAG) ?? new Set())).toEqual([]);
    expect(countTagOccurrences(chain.responses, MANY_FILES_TAG)).toBe(MANY_FILES_TOTAL);

    const lastMatches = matchesOf(chain.responses[chain.responses.length - 1] as Record<string, unknown>);
    expect(lastMatches?.["total_files"]).toBe(MANY_FILES_COUNT);
    expect(lastMatches?.["total_matches"]).toBe(MANY_FILES_TOTAL);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Budget-inherited cursor — a small declared budget sizes EVERY hop, not
//    only the first.
// ---------------------------------------------------------------------------

const NARROW_TAG = "cursorNarrowBudgetTag";
// 27 B lines (the tag is past the 24 B target, so no filler): ~100 lines fit
// one 4096 B page, so 320 lines take four hops — three of them resumes.
const NARROW_TOTAL_LINES = 320;
const NARROW_BUDGET_BYTES = 4096;

describe("a small caller-declared budget sizes every cursor hop, not just the first", () => {
  it("every hop is filled to the declared 4096 B and never past it; every resume re-sends that budget", async () => {
    const ws = freshWorkspace("narrow-budget");
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    writeSelfIdFile(ws, "src/narrow.ts", NARROW_TOTAL_LINES, NARROW_TAG, 24);

    // `state.budget` (the ORIGINAL call's declared value, inherited verbatim
    // by every resume — see SearchRequestState.budget's own doc comment) is
    // what every later `chooseSearchPage` call reads; this is the ONE thing
    // this test proves stays true past hop 1. Before SPB a 4096 B budget also
    // clamped the per-file cap to 8 lines (~1 KB of a 4 KB page, 40 hops for
    // this fixture).
    const chain = await walkHopsMeasured(
      server,
      { action: "find", queries: [NARROW_TAG], scope: { path: "src" }, budget: { bytes: NARROW_BUDGET_BYTES }, cwd: ws },
      20,
    );
    expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
    assertNoEscalation(chain.responses);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals, JSON.stringify(refusals).slice(0, 300)).toEqual([]);

    // At least two genuine cursor resumes happened (this is the point: the
    // budget survives a resume, not only page 1).
    expect(chain.responses.length, JSON.stringify(chain.bytes)).toBeGreaterThanOrEqual(3);
    expect(chain.responses.length, JSON.stringify(chain.bytes)).toBeLessThanOrEqual(5);
    for (const bytes of chain.bytes) {
      expect(bytes, `a page exceeded the declared budget: ${JSON.stringify(chain.bytes)}`).toBeLessThanOrEqual(NARROW_BUDGET_BYTES);
    }
    chain.bytes.slice(0, -1).forEach((bytes) => {
      expect(bytes, `a page was left mostly empty: ${JSON.stringify(chain.bytes)}`).toBeGreaterThanOrEqual(0.85 * NARROW_BUDGET_BYTES);
    });
    for (const response of chain.responses.slice(0, -1)) {
      expect(extractNext(response).next?.arguments["budget"]).toEqual({ bytes: NARROW_BUDGET_BYTES });
    }

    const served = new Map<string, Set<number>>();
    for (const r of chain.responses) unionInto(served, extractServedIds(r, [NARROW_TAG]));
    expect(missingIds(idRangeSet(1, NARROW_TOTAL_LINES), served.get(NARROW_TAG) ?? new Set())).toEqual([]);
    expect(countTagOccurrences(chain.responses, NARROW_TAG)).toBe(NARROW_TOTAL_LINES);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. VS Code client env — the host-ceiling tier sizes a cursor resume (no
//    declared budget) exactly as it does the first page.
// ---------------------------------------------------------------------------

const VSCODE_TAG = "cursorVscodeHostCeilingTag";
// 32 B lines: ~350 lines fill one 14336 B page, so 1000 lines take three
// hops and the middle one is a FULL resume page.
const VSCODE_TOTAL_LINES = 1000;

describe("host-ceiling tier under the vscode client env reaches cursor resumes too", () => {
  it("with no declared budget, a vscode-config cursor resume is filled to the host ceiling, not the 16 KiB default", async () => {
    // VS Code's own known ceiling (14336 B, clientProfile.ts) sits below the
    // flat 16 KiB default page, so a resume sized from the wrong tier would
    // show up here as a page over the host ceiling. What this proves: the
    // host-ceiling branch of `defaultSearchPageBudgetBytes` (state.budget
    // undefined, so it falls through to hostSearchPageByteCeiling()) sizes a
    // cursor RESUME under this client env exactly as it sizes page 1.
    const hostCeiling = resolveClientProfile("vscode").responseByteCeiling;
    expect(hostCeiling).toBeLessThan(FIND_WIDE_PAGE_RESPONSE_BYTES);
    const ws = freshWorkspace("vscode-host-ceiling");
    const server = startDevServer(ws, "vscode");
    servers.push(server);
    await server.initialize();
    writeSelfIdFile(ws, "src/big.ts", VSCODE_TOTAL_LINES, VSCODE_TAG, 24);

    const chain = await walkHopsMeasured(server, { action: "find", queries: [VSCODE_TAG], scope: { path: "src" }, cwd: ws }, 10);
    expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
    assertNoEscalation(chain.responses);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals, JSON.stringify(refusals).slice(0, 300)).toEqual([]);

    expect(chain.responses.length, JSON.stringify(chain.bytes)).toBe(3);
    for (const bytes of chain.bytes) {
      expect(bytes, `a page exceeded the vscode host ceiling: ${JSON.stringify(chain.bytes)}`).toBeLessThanOrEqual(hostCeiling!);
    }
    // Page 1 and the full resume page are both filled to the host ceiling.
    expect(chain.bytes[0], JSON.stringify(chain.bytes)).toBeGreaterThanOrEqual(0.9 * hostCeiling!);
    expect(chain.bytes[1], JSON.stringify(chain.bytes)).toBeGreaterThanOrEqual(0.9 * hostCeiling!);

    const served = new Map<string, Set<number>>();
    for (const r of chain.responses) unionInto(served, extractServedIds(r, [VSCODE_TAG]));
    expect(missingIds(idRangeSet(1, VSCODE_TOTAL_LINES), served.get(VSCODE_TAG) ?? new Set())).toEqual([]);
    expect(countTagOccurrences(chain.responses, VSCODE_TAG)).toBe(VSCODE_TOTAL_LINES);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Recall control — a small result that never needed a cursor is unchanged.
// ---------------------------------------------------------------------------

describe("recall control: a small result never reaches the search-request cursor at all", () => {
  it("stays a single hop, no limit/next, exact recall of every match", async () => {
    const ws = freshWorkspace("recall-small");
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    writeFile(ws, "src/a.ts", "export const recallSmallToken_a = 1;\n");
    writeFile(ws, "src/b.ts", "export const recallSmallToken_b = 2;\n");
    writeFile(ws, "src/c.ts", "export const recallSmallToken_c = 3;\n");

    const { body } = await server.callTool("tl_search_files", {
      action: "find",
      query: "recallSmallToken",
      scope: { path: "src" },
      cwd: ws,
    });
    const matches = matchesOf(body);
    expect(matches, JSON.stringify(body).slice(0, 300)).toBeDefined();
    expect(matches!["total_files"]).toBe(3);
    expect(matches!["total_matches"]).toBe(3);
    expect(extractNext(body).next, JSON.stringify(body).slice(0, 300)).toBeUndefined();
    expect(body["limit"]).toBeUndefined();
  }, 30_000);
});
