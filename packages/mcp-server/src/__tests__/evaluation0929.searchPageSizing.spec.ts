/**
 * evaluation0929.searchPageSizing.spec.ts — V15-SPC (search pages sized to
 * the host ceiling, 2026-09-29).
 *
 * TL_FIND_WIDE_PAGE (F5, 2026-09-19) is promoted from class (B), default
 * OFF, to (S) supported, DEFAULT ON for every client — see util/flags.ts's
 * "SPC addendum" and findText.ts's findResponseCapBytes()/
 * findInventoryCapBytes()/hostResponseByteCeiling()/
 * activeFindResponseByteCeilingOverride doc comments for the mechanism.
 * findWidePage.spec.ts/findWidePageEconomy.spec.ts already pin the flag's
 * own OFF/ON accessor values and the F6 per-file-cap/soft-degrade mechanics
 * directly (both explicit-flag-driven); this file is the DEFAULT-STATE
 * (flag left unset) wire-level regression home the SPC brief names:
 *
 *   1. a small result never pages (1 hop) for every client;
 *   2. a large result pages within the effective ceiling — smaller for a
 *      known client with its own tighter default (VS Code, 14336 B) than
 *      for a client with none (Claude Code/Codex, the flat 16384 B
 *      default) — while the FIRST page alone stays exact: every matched
 *      file is named, the true counts are accurate, and a complete
 *      inventory is attached ("snippets may truncate; the inventory never
 *      lies" — a truncated find's own `next` is a best-effort narrowing
 *      affordance, not a full-line pager; see this file's own
 *      `runFindToCompletion` doc comment);
 *   3. the per-file line-number cap still discloses `more_lines` honestly
 *      (never silently hides hits) under the new default;
 *   4. action=references and action=tree are completely unaffected — they
 *      never read findResponseCapBytes()/findInventoryCapBytes()/
 *      findWidePageEnabled() at all;
 *   5. an explicit caller-declared `budget.bytes` outranks BOTH the host
 *      ceiling and the flat default ("caller budget > host ceiling > the
 *      flat 16 KB default") — including for the PER-FILE line-number cap,
 *      which must fall back to the legacy MAX_LINES_PER_FILE(8) rather than
 *      the wide FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE(64) once the
 *      effective ceiling is clamped down to the legacy floor (findText.ts's
 *      `capFileGroup` doc comment — discovered via
 *      evaluation0929.cursorStaleRestart.spec.ts's own search-cursor
 *      scenario, which declares `budget:{bytes:900}` and depends on this).
 *
 * Every wire-level case drives a REAL stdio server (`startDevServer`) and
 * follows `next` verbatim, exactly as AGENTS.md instructs a caller to.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  CONFIG_NAMES,
  extractNext,
  startDevServer,
  type ConfigName,
  type ServerHandle,
  type ToolCallShape,
} from "./helpers/qualityFirstScenarios.js";
import {
  buildFindResponse,
  FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE,
} from "../features/search/find/findText.js";
import { callTool } from "../server.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();

const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
  delete process.env["TL_FIND_WIDE_PAGE"];
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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929-sps-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function matchesBlockOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const matches = body["matches"];
  return matches !== null && typeof matches === "object" && !Array.isArray(matches)
    ? (matches as Record<string, unknown>)
    : undefined;
}

interface RunResult {
  pages: Record<string, unknown>[];
  callsMade: number;
  firstPageBytes: number;
  totalMatches?: number;
}

/**
 * Follows a find response's `next` (wherever `extractNext` finds it) to
 * exhaustion (bounded). A truncated find's own `next` (protocol/
 * searchFamily.ts's findNext) is a best-effort "look here first" affordance
 * — for a heavily-tied fixture it narrows `scope.path` to ONE file worth
 * widening, not a claim that running it exhausts every remaining match (see
 * pi05HintPrecedence.spec.ts's own findNext ground truth) — so this only
 * proves the chain terminates and every hop it names is well-formed and
 * executable; completeness itself is the FIRST page's own total_files/
 * total_matches/inventory honesty (asserted separately, against page 0
 * alone) — "snippets may truncate; the inventory never lies".
 */
async function runFindToCompletion(
  server: ServerHandle,
  firstArgs: Record<string, unknown>,
  cap: number,
): Promise<RunResult> {
  let { body, textBytes } = await server.callTool("tl_search_files", firstArgs);
  const pages: Record<string, unknown>[] = [body];
  const firstPageBytes = textBytes;
  const totalMatches = matchesBlockOf(body)?.["total_matches"] as number | undefined;

  let callsMade = 0;
  for (let i = 0; i < cap; i++) {
    const next = extractNext(body).next as ToolCallShape | undefined;
    if (!next) break;
    expect(next.tool, "find continuation must stay inside tl_search_files").toBe("tl_search_files");
    const hop = await server.callTool(next.tool, next.arguments);
    body = hop.body;
    callsMade += 1;
    pages.push(body);
  }
  return { pages, callsMade, firstPageBytes, totalMatches };
}

// ---------------------------------------------------------------------------
// 1. Small result — never pages, for every client.
// ---------------------------------------------------------------------------

for (const config of CONFIG_NAMES as readonly ConfigName[]) {
  describe(`small find result stays in one hop (config=${config})`, () => {
    it("no limit/next when the whole result comfortably fits the effective ceiling", async () => {
      const ws = freshWorkspace(`small-${config}`);
      const server = startDevServer(ws, config);
      servers.push(server);
      await server.initialize();
      writeFile(ws, "src/a.ts", "export const smallPageToken_a = 1;\n");
      writeFile(ws, "src/b.ts", "export const smallPageToken_b = 2;\n");
      writeFile(ws, "src/c.ts", "export const smallPageToken_c = 3;\n");

      const { body } = await server.callTool("tl_search_files", { action: "find", query: "smallPageToken", cwd: ws });
      const matches = matchesBlockOf(body);
      expect(matches, JSON.stringify(body).slice(0, 300)).toBeDefined();
      expect(matches!["total_files"]).toBe(3);
      expect(matches!["truncated"]).toBeUndefined();
      expect(extractNext(body).next, JSON.stringify(body).slice(0, 300)).toBeUndefined();
      expect(body["limit"]).toBeUndefined();
    });
  });
}

// ---------------------------------------------------------------------------
// 2. Large result — pages within the effective ceiling, exact continuation.
// ---------------------------------------------------------------------------

const LARGE_QUERY = "widePageSizingToken";
const LARGE_FILES = 60;
const LARGE_HITS_PER_FILE = 8; // == MAX_LINES_PER_FILE, well under
// FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE(64) — isolates the RESPONSE-WIDE
// byte cap this section targets from the PER-FILE line cap section 3 below.

function largeMatchLine(fileIdx: number, hitIdx: number): string {
  return `const ${LARGE_QUERY}_${fileIdx}_${hitIdx} = "` + "z".repeat(100) + `";`;
}

function buildLargeFixture(ws: string): number {
  for (let i = 0; i < LARGE_FILES; i++) {
    const idx = String(i).padStart(3, "0");
    const lines: string[] = [];
    for (let h = 0; h < LARGE_HITS_PER_FILE; h++) lines.push(largeMatchLine(i, h));
    writeFile(ws, `src/wide${idx}/f.ts`, lines.join("\n") + "\n");
  }
  return LARGE_FILES * LARGE_HITS_PER_FILE;
}

describe("large find result — effective ceiling and exact continuation", () => {
  it("a known client's own tighter ceiling (vscode) pages smaller than a client with none (default); every file is named and the inventory never lies", async () => {
    const wsDefault = freshWorkspace("large-default");
    const wsVscode = freshWorkspace("large-vscode");
    const expectedMatches = buildLargeFixture(wsDefault);
    buildLargeFixture(wsVscode);
    expect(expectedMatches).toBe(LARGE_FILES * LARGE_HITS_PER_FILE);

    const serverDefault = startDevServer(wsDefault, "default");
    servers.push(serverDefault);
    await serverDefault.initialize();
    const serverVscode = startDevServer(wsVscode, "vscode");
    servers.push(serverVscode);
    await serverVscode.initialize();

    const defaultRun = await runFindToCompletion(
      serverDefault,
      { action: "find", query: LARGE_QUERY, cwd: wsDefault },
      30,
    );
    const vscodeRun = await runFindToCompletion(
      serverVscode,
      { action: "find", query: LARGE_QUERY, cwd: wsVscode },
      30,
    );

    // This fixture's natural (untruncated) render is well over even the
    // widest possible effective ceiling — both clients see a truncated
    // first page (`fitFilesToCap`'s footholds mode: every file gets its
    // OWN foothold entry before any file's lines are widened further, so a
    // 60-way tie like this one already names every file in page 0 alone —
    // see findText.ts's `fitFilesToCap` doc comment).
    const firstMatchesOf = (run: RunResult) => matchesBlockOf(run.pages[0]!)!;
    // Rule T (C2-4): the response-level `truncated` boolean folds into
    // `limit` on the wire — absence of `limit` IS completeness, so its
    // PRESENCE is the truncation claim (no separate `matches.truncated:true`
    // key is sent).
    expect(defaultRun.pages[0]!["limit"], JSON.stringify(defaultRun.pages[0]).slice(0, 300)).toBeDefined();
    expect(vscodeRun.pages[0]!["limit"], JSON.stringify(vscodeRun.pages[0]).slice(0, 300)).toBeDefined();

    // The host-ceiling tier is ACTIVE: vscode's own default ceiling (14336 B)
    // is tighter than the flat default (16384 B) a client with no known
    // ceiling gets, so its first page is smaller — never merely equal to a
    // coincidence of rounding.
    expect(vscodeRun.firstPageBytes).toBeLessThan(defaultRun.firstPageBytes);
    // Sanity bounds: wide, but nowhere near wireBudget.ts's independent
    // generic backstop (131072 B) for the WHOLE wire envelope — this proves
    // paging is genuinely happening, not that the cap silently stopped
    // applying.
    expect(defaultRun.firstPageBytes).toBeLessThan(40_000);

    // "Snippets may truncate; the inventory never lies" — EXACTNESS for a
    // find response is this honesty guarantee, not a literal full-line pager
    // (a truncated find's own `next`, protocol/searchFamily.ts's findNext,
    // is a best-effort "look here first" affordance — e.g. it narrows
    // `scope.path` to one specific file worth widening — never a claim that
    // running it exhausts every remaining match; see
    // pi05HintPrecedence.spec.ts's own findNext ground truth). What must be
    // exact, on the FIRST page alone, regardless of client: the true counts,
    // every matched file named at least once (never hidden by truncation —
    // "2 KB truncation must not hide whole directories"), and a complete
    // inventory certifying the full match set.
    for (const run of [defaultRun, vscodeRun]) {
      const m = firstMatchesOf(run);
      expect(m["total_files"]).toBe(LARGE_FILES);
      expect(m["total_matches"]).toBe(expectedMatches);
      expect(run.totalMatches).toBe(expectedMatches);
      const files = m["files"] as Array<{ path: string }>;
      expect(files.length).toBe(LARGE_FILES);
      expect(new Set(files.map((f) => f.path)).size).toBe(LARGE_FILES);
      const inventoryComplete = m["inventory_complete"];
      expect(inventoryComplete === true || inventoryComplete === "by-directory").toBe(true);
    }

    // The chain still terminates cleanly (never hits the 30-hop bound) and
    // every hop it DOES name is executable (runFindToCompletion already
    // asserts `next.tool === "tl_search_files"` on every hop it follows, and
    // each returned a body without throwing) — a real client running to
    // completion never gets stuck or errors out.
    expect(defaultRun.callsMade).toBeLessThan(30);
    expect(vscodeRun.callsMade).toBeLessThan(30);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Per-file line-number cap — still honest under the new default.
// ---------------------------------------------------------------------------

describe("per-file line-number cap under the new default (flag left unset)", () => {
  it("a file whose true match count exceeds FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE is paged, never silently cut", () => {
    delete process.env["TL_FIND_WIDE_PAGE"];
    const ws = freshWorkspace("per-file-cap");
    const query = "perFileCapDefaultToken";
    const total = FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE + 10;
    const lines: string[] = [];
    for (let h = 0; h < total; h++) lines.push(`const ${query}_${h} = ${h};`);
    writeFile(ws, "f.ts", lines.join("\n") + "\n");

    const result = buildFindResponse({ query }, ws);
    const file = result.files[0]!;

    expect(result.files.length).toBe(1);
    expect(result.total_matches).toBe(total);
    // Honest disclosure: the true count is always more_lines + lines.length,
    // never silently smaller than reality — "paged, never silently cut".
    expect(file.lines.length + (file.more_lines ?? 0)).toBe(total);
    expect(file.lines.length).toBe(FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE);
    expect(file.more_lines).toBe(10);
    expect(result.truncated).toBe(true);
    // inventory_complete semantics unchanged: a truncated response still
    // certifies a COMPLETE inventory over the scanned set (never a partial
    // one silently presented as whole).
    expect(result.inventory_complete === true || result.inventory_complete === "by-directory").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. action=references / action=tree — completely unaffected.
// ---------------------------------------------------------------------------

describe("action=references / action=tree are unaffected by TL_FIND_WIDE_PAGE", () => {
  it("references output is byte-identical whether the flag is unset, \"0\", or \"1\"", async () => {
    const ws = freshWorkspace("refs-unaffected");
    writeFile(ws, "src/def.ts", "export function refsUnaffectedTarget() { return 1; }\n");
    writeFile(ws, "src/use1.ts", "import { refsUnaffectedTarget } from \"./def.js\";\nrefsUnaffectedTarget();\n");
    writeFile(ws, "src/use2.ts", "import { refsUnaffectedTarget } from \"./def.js\";\nrefsUnaffectedTarget();\n");

    delete process.env["TL_FIND_WIDE_PAGE"];
    const unset = await callTool("tl_search_files", { action: "references", query: "refsUnaffectedTarget", cwd: ws });

    process.env["TL_FIND_WIDE_PAGE"] = "0";
    const off = await callTool("tl_search_files", { action: "references", query: "refsUnaffectedTarget", cwd: ws });

    process.env["TL_FIND_WIDE_PAGE"] = "1";
    const on = await callTool("tl_search_files", { action: "references", query: "refsUnaffectedTarget", cwd: ws });

    const textOf = (r: unknown): string => {
      const content = (r as { content: Array<{ type: string; text?: string }> }).content;
      const first = content[0];
      return first?.type === "text" && typeof first.text === "string" ? first.text : "";
    };
    expect(textOf(off)).toBe(textOf(unset));
    expect(textOf(on)).toBe(textOf(unset));
  });

  it("tree output is byte-identical whether the flag is unset, \"0\", or \"1\"", async () => {
    const ws = freshWorkspace("tree-unaffected");
    for (let i = 0; i < 20; i++) writeFile(ws, `src/dir${i}/f.ts`, `export const treeUnaffected${i} = ${i};\n`);

    delete process.env["TL_FIND_WIDE_PAGE"];
    const unset = await callTool("tl_search_files", { action: "tree", cwd: ws });

    process.env["TL_FIND_WIDE_PAGE"] = "0";
    const off = await callTool("tl_search_files", { action: "tree", cwd: ws });

    process.env["TL_FIND_WIDE_PAGE"] = "1";
    const on = await callTool("tl_search_files", { action: "tree", cwd: ws });

    const textOf = (r: unknown): string => {
      const content = (r as { content: Array<{ type: string; text?: string }> }).content;
      const first = content[0];
      return first?.type === "text" && typeof first.text === "string" ? first.text : "";
    };
    expect(textOf(off)).toBe(textOf(unset));
    expect(textOf(on)).toBe(textOf(unset));
  });
});

// ---------------------------------------------------------------------------
// 5. Caller budget outranks the host ceiling and the flat default.
// ---------------------------------------------------------------------------

describe("an explicit caller budget outranks the host ceiling and the flat default", () => {
  it("budget.bytes narrower than the flat default forces a real, honest continuation, even with no host ceiling", async () => {
    const ws = freshWorkspace("caller-budget");
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    fs.mkdirSync(`${ws}/src`, { recursive: true });
    const query = "callerBudgetOutranksToken";
    const lines = Array.from({ length: 60 }, (_, i) => `export const HIT_${i} = ${query};`).join("\n") + "\n";
    writeFile(ws, "src/hits.ts", lines);

    // No declared budget: the flat 16384 B default applies, comfortably
    // fitting all 60 bare line numbers (well under
    // FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE=64) in ONE response.
    const noBudget = await server.callTool("tl_search_files", { action: "find", query, cwd: ws });
    const noBudgetMatches = matchesBlockOf(noBudget.body)!;
    expect((noBudgetMatches["files"] as unknown[]).length).toBe(1);
    expect((noBudgetMatches["files"] as Array<{ lines: number[] }>)[0]!.lines.length).toBe(60);
    expect(noBudget.body["limit"]).toBeUndefined();

    // The SAME fixture, with an explicit budget.bytes narrower than the
    // legacy floor: the caller-budget tier wins outright over the flat
    // default (and would win over a host ceiling too, were one known for
    // this client) — findText.ts's capFileGroup falls back to the legacy
    // MAX_LINES_PER_FILE(8) pre-cap instead of the wide 64, and the
    // response-wide fit (here further bounded by the wire layer's own
    // cursor/reserve accounting for THIS declared budget, outside this
    // package's region) narrows it further still — the exact count is not
    // this test's contract; honesty is: fewer lines than the true total,
    // the gap fully accounted for in `more_lines`, and a real continuation.
    const withBudget = await server.callTool("tl_search_files", {
      action: "find",
      query,
      budget: { bytes: 900 },
      cwd: ws,
    });
    const withBudgetMatches = matchesBlockOf(withBudget.body)!;
    const file = (withBudgetMatches["files"] as Array<{ lines: number[]; more_lines?: number }>)[0]!;
    expect(file.lines.length).toBeLessThan(60);
    expect(file.lines.length + (file.more_lines ?? 0)).toBe(60);
    expect(file.more_lines).toBeGreaterThan(0);
    expect(withBudget.body["limit"], JSON.stringify(withBudget.body).slice(0, 300)).toBeDefined();
    const next = extractNext(withBudget.body).next as ToolCallShape | undefined;
    expect(next?.tool).toBe("tl_search_files");
    // Totals stay honest regardless of the declared budget.
    expect(withBudgetMatches["total_files"]).toBe(1);
    expect(withBudgetMatches["total_matches"]).toBe(60);
  });
});
