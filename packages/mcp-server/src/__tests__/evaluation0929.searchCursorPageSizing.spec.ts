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
import { FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE, MAX_LINES_PER_FILE } from "../features/search/find/findText.js";

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
// 1. A single 200-line file — cursor hops past page 1 keep the wide cap.
// ---------------------------------------------------------------------------

const WIDE_TAG = "cursorWideFileTag";
const WIDE_TOTAL_LINES = 200;

describe("single-file cursor pagination follows the wide per-file cap, not just page 1", () => {
  it("every hop (including resumes) shows at most FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE lines, and at least one resume exceeds the legacy 8", async () => {
    const ws = freshWorkspace("wide-single");
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    writeSelfIdFile(ws, "src/big.ts", WIDE_TOTAL_LINES, WIDE_TAG, 24);

    const chain = await walkHops(
      server,
      { tool: "tl_search_files", arguments: { action: "find", queries: [WIDE_TAG], scope: { path: "src" }, cwd: ws } },
      10,
    );
    expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
    assertNoEscalation(chain.responses);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals, JSON.stringify(refusals).slice(0, 300)).toEqual([]);

    // BEFORE THIS FIX, every hop (page 1 included) capped at MAX_LINES_PER_
    // FILE(8) regardless of headroom — this fixture needed ~25 hops. The fix
    // must show a hop wider than that legacy cap; a genuinely wide-open
    // request (no declared budget, no tight host ceiling) should reach the
    // full FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE(64) on at least one hop.
    const perHopLineCounts = chain.responses.map((r) => firstFileOf(r as Record<string, unknown>)?.lines.length ?? 0);
    for (const count of perHopLineCounts) {
      expect(count, `a page showed more than the wide cap: ${JSON.stringify(perHopLineCounts)}`)
        .toBeLessThanOrEqual(FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE);
    }
    expect(
      perHopLineCounts.some((count) => count > MAX_LINES_PER_FILE),
      `no hop exceeded the legacy 8-line cap: ${JSON.stringify(perHopLineCounts)}`,
    ).toBe(true);
    // Far fewer hops than the pre-fix worst case (200/8 = 25).
    expect(chain.responses.length).toBeLessThanOrEqual(6);

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
    const server = startDevServer(ws, "default");
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
// 3. Budget-inherited cursor — a small declared budget stays narrowed to the
//    legacy cap on EVERY hop, not only the first.
// ---------------------------------------------------------------------------

const NARROW_TAG = "cursorNarrowBudgetTag";
const NARROW_TOTAL_LINES = 80;

describe("a small caller-declared budget narrows every cursor hop, not just the first", () => {
  it("every hop stays at MAX_LINES_PER_FILE(8) once the effective ceiling clamps to the legacy floor", async () => {
    const ws = freshWorkspace("narrow-budget");
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    writeSelfIdFile(ws, "src/narrow.ts", NARROW_TOTAL_LINES, NARROW_TAG, 24);

    // budget.bytes AT the legacy floor (MAX_RESPONSE_BYTES=4096): the
    // effective ceiling clamps to exactly 4096, so `ceiling > 4096` is FALSE
    // and the per-file cap stays the legacy 8 — but 4096 B of ROOM is ample
    // to actually REACH that 8-line boundary each hop (unlike a much smaller
    // budget, where room alone — not the cap — would be the limiter), so
    // this isolates the cap decision specifically. `state.budget` (the
    // ORIGINAL call's declared value, inherited verbatim by every resume —
    // see SearchRequestState.budget's own doc comment) is what every later
    // `chooseSearchPage` call reads; this is the ONE thing this test proves
    // stays true past hop 1.
    const chain = await walkHops(
      server,
      {
        tool: "tl_search_files",
        arguments: {
          action: "find",
          queries: [NARROW_TAG],
          scope: { path: "src" },
          budget: { bytes: 4096 },
          cwd: ws,
        },
      },
      20,
    );
    expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
    assertNoEscalation(chain.responses);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals, JSON.stringify(refusals).slice(0, 300)).toEqual([]);

    // At least one genuine cursor resume happened (this is the point: prior
    // to the fix, ONLY page 1 was ever observed directly — this proves the
    // clamp survives a resume too).
    expect(chain.responses.length).toBeGreaterThanOrEqual(3);

    const perHopLineCounts = chain.responses.map((r) => firstFileOf(r as Record<string, unknown>)?.lines.length ?? 0);
    for (const count of perHopLineCounts) {
      expect(count, `a page exceeded the clamped legacy cap: ${JSON.stringify(perHopLineCounts)}`)
        .toBeLessThanOrEqual(MAX_LINES_PER_FILE);
    }

    const served = new Map<string, Set<number>>();
    for (const r of chain.responses) unionInto(served, extractServedIds(r, [NARROW_TAG]));
    expect(missingIds(idRangeSet(1, NARROW_TOTAL_LINES), served.get(NARROW_TAG) ?? new Set())).toEqual([]);
    expect(countTagOccurrences(chain.responses, NARROW_TAG)).toBe(NARROW_TOTAL_LINES);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. VS Code client env — the host-ceiling tier resolves on a cursor resume
//    (no declared budget) exactly as it does on the first page.
// ---------------------------------------------------------------------------

const VSCODE_TAG = "cursorVscodeHostCeilingTag";
const VSCODE_TOTAL_LINES = 200;

describe("host-ceiling tier under the vscode client env reaches cursor resumes too", () => {
  it("with no declared budget, a vscode-config cursor chain still widens past the legacy 8-line cap on resume", async () => {
    // VS Code's own known ceiling (14336 B, clientProfile.ts) clears
    // MAX_RESPONSE_BYTES(4096) the same way the flat 16 KB default does, so
    // this cannot show a NUMERICALLY different cap from test 1's default
    // config — no known host ceiling is at or below the legacy floor today.
    // What this DOES prove: the host-ceiling branch of
    // effectiveSearchPageLineCap (state.budget undefined, so it falls
    // through to hostSearchPageByteCeiling()) resolves correctly and grants
    // the SAME wide allowance on a cursor RESUME under this client env,
    // rather than silently reverting to the legacy 8 the way it did before
    // this fix (which never consulted any ceiling at all).
    const ws = freshWorkspace("vscode-host-ceiling");
    const server = startDevServer(ws, "vscode");
    servers.push(server);
    await server.initialize();
    writeSelfIdFile(ws, "src/big.ts", VSCODE_TOTAL_LINES, VSCODE_TAG, 24);

    const chain = await walkHops(
      server,
      { tool: "tl_search_files", arguments: { action: "find", queries: [VSCODE_TAG], scope: { path: "src" }, cwd: ws } },
      10,
    );
    expect(chain.capped, `chain never completed: ${JSON.stringify(chain.responses).slice(0, 500)}`).toBe(false);
    assertNoEscalation(chain.responses);
    const refusals = chain.responses.filter((r) => (r as Record<string, unknown>)["kind"] === "refusal");
    expect(refusals, JSON.stringify(refusals).slice(0, 300)).toEqual([]);

    const perHopLineCounts = chain.responses.map((r) => firstFileOf(r as Record<string, unknown>)?.lines.length ?? 0);
    for (const count of perHopLineCounts) {
      expect(count).toBeLessThanOrEqual(FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE);
    }
    expect(
      perHopLineCounts.some((count) => count > MAX_LINES_PER_FILE),
      `no hop exceeded the legacy 8-line cap under vscode: ${JSON.stringify(perHopLineCounts)}`,
    ).toBe(true);
    expect(chain.responses.length).toBeLessThanOrEqual(6);

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
