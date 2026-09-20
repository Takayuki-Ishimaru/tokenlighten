/**
 * findWidePage.spec.ts — TL_FIND_WIDE_PAGE (F5, 2026-09-19).
 *
 * NORMATIVE SOURCE: this wave's own evidence — a live-session measurement
 * showing a 7-file/50-match `search_files find` result truncated at the
 * 4096-byte snippet-section cap (`findText.ts`'s `MAX_RESPONSE_BYTES`) came
 * back as four separate follow-up calls (3084 B + 1681 B + 1499 B + …), one
 * full priced model turn per ~1.5-3 KB page. TL_FIND_WIDE_PAGE (default OFF)
 * widens that cap to 16384 bytes via the new `findResponseCapBytes()`
 * accessor (and the companion `findInventoryCapBytes()` for the
 * whole-response-with-inventory ceiling) — see util/flags.ts's "F5
 * addendum" and each accessor's own doc comment in findText.ts.
 *
 * Fixture shape: ~12 files, each with several (6) literal matches on a
 * unique camelCase token — deliberately camelCase (no `-`/`_`) so
 * withSiblingStemMatches' stem-family widening never engages, deliberately
 * <=6 matches per file (< MAX_LINES_PER_FILE=8) so the per-file hard cap
 * never trips (independent of this flag; see findText.ts's capFileGroup),
 * and deliberately IDENTICAL line/cluster shape across every file so
 * attachDominantEditContext's "uniquely dominant" promotion never fires (a
 * 12-way tie), keeping the snippet-section proxy below exact. Every matching
 * line is padded past MATCH_TEXT_MAX_CHARS (80) so every snippet trims to
 * the SAME predictable length regardless of index — this is what makes the
 * byte-cap crossing (under 4096, over 16384) deterministic rather than a
 * hand-tuned coincidence.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildFindResponse,
  MAX_RESPONSE_BYTES,
  MAX_INVENTORY_RESPONSE_BYTES,
  FIND_WIDE_PAGE_RESPONSE_BYTES,
  findResponseCapBytes,
  findInventoryCapBytes,
  type FindResponse,
} from "../tools/findText.js";
import { callTool } from "../server.js";

const QUERY = "wideCapPageToken";
const TOTAL_FILES = 12;
// F3's SOFT_DEGRADE_BYTES (6144, findText.ts) is a THIRD threshold, above
// MAX_RESPONSE_BYTES(4096) and below FIND_WIDE_PAGE_RESPONSE_BYTES(16384):
// once the fixture's NATURAL full render (every file at its own full line
// count, uncapped) exceeds it, fitFilesToCap prefers whichever of
// {footholds, fully-widened} finalizes smaller — which is always footholds
// once the natural render is much bigger than a footholds-only render,
// REGARDLESS of how large the governing cap is. That would make OFF and ON
// converge on the identical minimal (1-line-per-file) rendering and mask
// this flag's effect entirely (verified empirically: 6 hits/file, whose
// ~6.9 KB natural render sits just past SOFT_DEGRADE_BYTES, reproduced
// exactly that collapse). 4 hits/file keeps the natural render inside the
// (MAX_RESPONSE_BYTES, SOFT_DEGRADE_BYTES) band, so OFF genuinely needs the
// normal per-file widen pass (not the soft-degrade shortcut) and ON's wider
// cap has real, visible headroom to serve more of it.
const HITS_PER_FILE = 4;

const tmpDirs: string[] = [];

function mkWorkspace(prefix: string): string {
  const home = process.env["HOME"] ?? os.homedir();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(home, `.tl-fwp-${prefix}-`)));
  tmpDirs.push(dir);
  return dir;
}

/** A matching line, padded well past MATCH_TEXT_MAX_CHARS(80) so every snippet trims identically. */
function matchLine(fileIdx: number, hitIdx: number): string {
  return `const ${QUERY}_${fileIdx}_${hitIdx} = "` + "z".repeat(100) + `";`;
}

/** ~TOTAL_FILES files, each with HITS_PER_FILE identically-shaped matching lines. */
function buildFixture(prefix: string): { workspace: string; expectedMatches: number } {
  const workspace = mkWorkspace(prefix);
  for (let i = 0; i < TOTAL_FILES; i++) {
    const idx = String(i).padStart(2, "0");
    const lines: string[] = [];
    for (let h = 0; h < HITS_PER_FILE; h++) lines.push(matchLine(i, h));
    const abs = path.join(workspace, `src/wide${idx}/f.ts`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, lines.join("\n") + "\n", "utf8");
  }
  return { workspace, expectedMatches: TOTAL_FILES * HITS_PER_FILE };
}

afterEach(() => {
  delete process.env["TL_FIND_WIDE_PAGE"];
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/**
 * Reconstructs the byte count fitFilesToCap()/applyRoles() themselves
 * measured against findResponseCapBytes() for this response — the "snippet
 * section" (files[]/roles/matched_terms/hint), i.e. the SAME shape
 * findText.ts's own `build()` closure produces before attachInventory
 * splices total_files/total_matches/inventory on top. `more_lines` is
 * stripped from each file: fitFilesToCap's own doc comment is explicit that
 * every fit/drop DECISION is measured "as if more_lines did not exist" —
 * finalize() adds that disclosure field to the RETURNED files only, AFTER
 * the cap decision, so the true byte-fitting guarantee (and this
 * reconstruction of it) excludes it too.
 */
function snippetSectionBytes(result: FindResponse): number {
  const filesWithoutMoreLines = result.files.map((f) => {
    const { more_lines, ...rest } = f;
    return rest;
  });
  const proxy: Record<string, unknown> = {
    query: result.query,
    files: filesWithoutMoreLines,
    total_files: result.files.length,
    total_matches: result.files.reduce((n, f) => n + f.lines.length, 0),
    truncated: false,
    literal: result.literal,
  };
  if (result.matched_terms) proxy["matched_terms"] = result.matched_terms;
  if (result.matched_variant) proxy["matched_variant"] = result.matched_variant;
  if (result.hint) proxy["hint"] = result.hint;
  if (result.omitted) proxy["omitted"] = result.omitted;
  return Buffer.byteLength(JSON.stringify(proxy), "utf8");
}

function totalShownLines(result: FindResponse): number {
  return result.files.reduce((n, f) => n + f.lines.length, 0);
}

// ---------------------------------------------------------------------------
// Accessor pinning
// ---------------------------------------------------------------------------

describe("findResponseCapBytes / findInventoryCapBytes — accessor pinning", () => {
  it("OFF (default, unset) returns the unchanged pre-F5 constants", () => {
    delete process.env["TL_FIND_WIDE_PAGE"];
    expect(findResponseCapBytes()).toBe(MAX_RESPONSE_BYTES);
    expect(findResponseCapBytes()).toBe(4096);
    expect(findInventoryCapBytes()).toBe(MAX_INVENTORY_RESPONSE_BYTES);
    expect(findInventoryCapBytes()).toBe(24576);
  });

  it("explicit \"0\" is still off, same as unset", () => {
    process.env["TL_FIND_WIDE_PAGE"] = "0";
    expect(findResponseCapBytes()).toBe(MAX_RESPONSE_BYTES);
    expect(findInventoryCapBytes()).toBe(MAX_INVENTORY_RESPONSE_BYTES);
  });

  it("ON widens the snippet cap to 16384 and the inventory ceiling by the same +12288 delta (36864), preserving inventory headroom", () => {
    process.env["TL_FIND_WIDE_PAGE"] = "1";
    expect(findResponseCapBytes()).toBe(FIND_WIDE_PAGE_RESPONSE_BYTES);
    expect(findResponseCapBytes()).toBe(16384);
    expect(findInventoryCapBytes()).toBe(36864);
    // The delta is identical on both sides — same headroom preserved.
    expect(findInventoryCapBytes() - findResponseCapBytes()).toBe(
      MAX_INVENTORY_RESPONSE_BYTES - MAX_RESPONSE_BYTES,
    );
  });
});

// ---------------------------------------------------------------------------
// buildFindResponse() — direct unit-level comparison
// ---------------------------------------------------------------------------

describe("buildFindResponse — TL_FIND_WIDE_PAGE OFF vs ON", () => {
  it("OFF: snippet section stays within the legacy 4096-byte cap and the response is truncated", () => {
    const { workspace, expectedMatches } = buildFixture("off-unit");
    delete process.env["TL_FIND_WIDE_PAGE"];

    const result = buildFindResponse({ query: QUERY }, workspace);

    expect(result.total_files).toBe(TOTAL_FILES);
    expect(result.total_matches).toBe(expectedMatches);
    expect(result.truncated).toBe(true);
    expect(snippetSectionBytes(result)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    // A real continuation must be nameable: every matched file is at least
    // represented, but not every file shows its full 6 lines.
    expect(result.files.some((f) => (f.more_lines ?? 0) > 0)).toBe(true);
  });

  it("ON: the same query shows strictly more shown lines in ONE call, within the wider 16384-byte cap, with identical totals", () => {
    const { workspace, expectedMatches } = buildFixture("on-unit");

    delete process.env["TL_FIND_WIDE_PAGE"];
    const off = buildFindResponse({ query: QUERY }, workspace);

    process.env["TL_FIND_WIDE_PAGE"] = "1";
    const on = buildFindResponse({ query: QUERY }, workspace);

    // Same underlying facts either way — only how many bytes/lines ship
    // before truncation kicks in changes.
    expect(on.total_files).toBe(off.total_files);
    expect(on.total_matches).toBe(off.total_matches);
    expect(on.total_files).toBe(TOTAL_FILES);
    expect(on.total_matches).toBe(expectedMatches);

    expect(snippetSectionBytes(on)).toBeLessThanOrEqual(FIND_WIDE_PAGE_RESPONSE_BYTES);
    // The whole response (files[] + inventory, if any) stays within the
    // widened inventory ceiling too.
    expect(Buffer.byteLength(JSON.stringify(on), "utf8")).toBeLessThanOrEqual(findInventoryCapBytes());

    // ON shows every file (never fewer than OFF) and strictly more total
    // matched lines than OFF's tighter cap allowed.
    expect(on.files.length).toBeGreaterThanOrEqual(off.files.length);
    expect(totalShownLines(on)).toBeGreaterThan(totalShownLines(off));

    // This fixture's full render comfortably fits the wider cap: ON needs no
    // truncation at all, i.e. it returns ALL matches for every file in the
    // first response.
    expect(on.truncated).toBe(false);
    expect(on.files.length).toBe(TOTAL_FILES);
    expect(totalShownLines(on)).toBe(expectedMatches);
    for (const f of on.files) expect(f.more_lines ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wire level — search_files find dispatch, following limit.next to exhaustion
// ---------------------------------------------------------------------------

interface ToolCallShape { tool: string; arguments: Record<string, unknown> }

function asToolCall(value: unknown): ToolCallShape | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v["tool"] !== "string") return undefined;
  const args = v["arguments"];
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  return { tool: v["tool"], arguments: args as Record<string, unknown> };
}

/** `limit.next` if present, else a bare top-level `next` — the two positions this family ever uses. */
function nextCallOf(body: Record<string, unknown>): ToolCallShape | undefined {
  const limit = body["limit"];
  if (limit !== null && typeof limit === "object" && !Array.isArray(limit)) {
    const fromLimit = asToolCall((limit as Record<string, unknown>)["next"]);
    if (fromLimit) return fromLimit;
  }
  return asToolCall(body["next"]);
}

function matchesBlockOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const matches = body["matches"];
  return matches !== null && typeof matches === "object" && !Array.isArray(matches)
    ? (matches as Record<string, unknown>)
    : undefined;
}

async function invokeFind(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await callTool("search_files", args);
  const first = (response as { content: Array<{ type: string; text?: string }> }).content[0];
  const text = first?.type === "text" && typeof first.text === "string" ? first.text : "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

interface RunResult {
  pages: Record<string, unknown>[];
  paths: Set<string>;
  totalFiles?: number;
  totalMatches?: number;
  callsMade: number;
}

/** Follow `nextCallOf` until it disappears (bounded), collecting every page's matched file paths. */
async function runFindToCompletion(firstArgs: Record<string, unknown>, cap: number): Promise<RunResult> {
  let body = await invokeFind(firstArgs);
  const pages: Record<string, unknown>[] = [body];
  const paths = new Set<string>();
  const collect = (b: Record<string, unknown>): void => {
    const files = matchesBlockOf(b)?.["files"];
    if (!Array.isArray(files)) return;
    for (const raw of files) {
      if (raw !== null && typeof raw === "object" && typeof (raw as Record<string, unknown>)["path"] === "string") {
        paths.add((raw as Record<string, unknown>)["path"] as string);
      }
    }
  };
  collect(body);
  const first = matchesBlockOf(body);
  const totalFiles = typeof first?.["total_files"] === "number" ? first["total_files"] as number : undefined;
  const totalMatches = typeof first?.["total_matches"] === "number" ? first["total_matches"] as number : undefined;

  let callsMade = 0;
  for (let i = 0; i < cap; i++) {
    const next = nextCallOf(body);
    if (!next) break;
    expect(next.tool, "find continuation must stay inside search_files").toBe("search_files");
    body = await invokeFind(next.arguments);
    callsMade += 1;
    pages.push(body);
    collect(body);
  }
  return { pages, paths, totalFiles, totalMatches, callsMade };
}

describe("search_files find dispatch — TL_FIND_WIDE_PAGE wire-level continuation", () => {
  it("OFF needs at least one follow-up call; ON needs no more calls than OFF; both runs converge on the identical file union", async () => {
    const off = buildFixture("off-wire");
    const on = buildFixture("on-wire");

    delete process.env["TL_FIND_WIDE_PAGE"];
    const offRun = await runFindToCompletion({ action: "find", query: QUERY, cwd: off.workspace }, 20);

    process.env["TL_FIND_WIDE_PAGE"] = "1";
    const onRun = await runFindToCompletion({ action: "find", query: QUERY, cwd: on.workspace }, 20);

    // Honesty: total_files/total_matches identical and accurate regardless
    // of the flag — only how much ships per page changes.
    expect(offRun.totalFiles).toBe(TOTAL_FILES);
    expect(onRun.totalFiles).toBe(TOTAL_FILES);
    expect(offRun.totalMatches).toBe(TOTAL_FILES * HITS_PER_FILE);
    expect(onRun.totalMatches).toBe(offRun.totalMatches);

    // The legacy 4096-byte cap forces at least one continuation call for
    // this fixture.
    expect(offRun.callsMade).toBeGreaterThanOrEqual(1);
    // The wider cap never needs MORE calls than the legacy cap did for the
    // identical data — it either resolves in the first call or needs no
    // more hops than OFF did.
    expect(onRun.callsMade).toBeLessThanOrEqual(offRun.callsMade);

    // No loss, no duplicates: both runs' file-path unions are identical and
    // cover every matched file.
    expect(offRun.paths.size).toBe(TOTAL_FILES);
    expect(onRun.paths.size).toBe(TOTAL_FILES);
    expect([...onRun.paths].sort()).toEqual([...offRun.paths].sort());

    // If ON still needed a continuation for this fixture, its page(s) must
    // be wider than a 4096-era page could ever have been — proving the
    // wider cap reaches the tail, not just the first call. For THIS query
    // shape (many similarly-sized files) that branch is structurally
    // unreachable, not merely uncalibrated: SOFT_DEGRADE_BYTES (6144,
    // findText.ts) always sits below FIND_WIDE_PAGE_RESPONSE_BYTES (16384),
    // so any fixture whose natural per-file rendering is small enough to
    // stay OFF the soft-degrade shortcut (a precondition for the wider cap
    // to matter at all — see buildFixture's HITS_PER_FILE comment) is by
    // construction also small enough to fit whole under the wider cap. The
    // branch is kept as a documented, defensive assertion rather than
    // deleted, in case that relationship ever changes.
    if (onRun.callsMade > 0) {
      for (const page of onRun.pages) {
        const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
        expect(bytes).toBeGreaterThan(MAX_RESPONSE_BYTES);
      }
    } else {
      // The expected, calibrated outcome for this fixture: ON resolves
      // every file's every match in the FIRST call, so no `next` at all.
      expect(nextCallOf(offRun.pages[0]!)).toBeDefined();
      expect(nextCallOf(onRun.pages[0]!)).toBeUndefined();
    }
  }, 60_000);
});
