/**
 * findWidePageEconomy.spec.ts — F6 (2026-09-20 find-page-economy): pins the
 * two follow-up fixes to TL_FIND_WIDE_PAGE (F5, findWidePage.spec.ts) that
 * WP-S3's brief measured as still missing under the flag:
 *
 *   1. The soft-degrade threshold (SOFT_DEGRADE_BYTES, findText.ts) stayed
 *      pinned at 6144 bytes even once the flag widened the response cap to
 *      16384 -- so a natural render in the band between them still
 *      collapsed to the compact one-line-per-file "footholds" form instead
 *      of being served whole. softDegradeThresholdBytes() (findText.ts) now
 *      scales the threshold with findResponseCapBytes() under the flag.
 *   2. A file whose matches exceeded MAX_LINES_PER_FILE(8) only ever
 *      disclosed 8 line numbers per call, forcing a follow-up call to learn
 *      more of them even though a bare line number costs a handful of
 *      bytes. capFileGroup() (findText.ts) now caps `lines` at the wider
 *      FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE(64) under the flag while
 *      `snippets` stays at MAX_LINES_PER_FILE(8) either way.
 *
 * A separate file from findWidePage.spec.ts on purpose: that file pins F5's
 * own byte-cap-widening accessors and their OFF-byte-identity; this file
 * pins ONLY the new F6 behaviour (both ON-only, both additive), so neither
 * fix risks disturbing F5's already-green expectations.
 *
 * Both fixes are OFF by default (TL_FIND_WIDE_PAGE unset/"0", and
 * TL_TURN_ECONOMY unset) -- flags.spec.ts pins findWidePageEnabled()'s own
 * accessor-level OFF-byte-identity and umbrella fallback; this file never
 * edits an existing expectation, only adds new ON-only cases.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildFindResponse,
  findResponseCapBytes,
  FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE,
  MAX_LINES_PER_FILE,
  SOFT_DEGRADE_BYTES,
} from "../tools/findText.js";

const tmpDirs: string[] = [];

function mkWorkspace(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tl-fwpe-${prefix}-`)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env["TL_FIND_WIDE_PAGE"];
  delete process.env["TL_TURN_ECONOMY"];
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// Fixture 1: the soft-degrade band -- MAX_LINES_PER_FILE(8) hits per file
// across enough files that the natural (already per-file-capped) render
// sits ABOVE SOFT_DEGRADE_BYTES(6144) but comfortably under the flag's own
// 3/4-of-cap threshold (12288). Empirically ~9.2 KB across 12 files,
// calibrated against the real snippet-trimming/JSON-escaping cost (not
// estimated) -- the "~9 KB across ~10 files" shape the brief measured.
// ---------------------------------------------------------------------------

const DEGRADE_BAND_QUERY = "wideDegradeBandToken";
const DEGRADE_BAND_FILES = 12;
// No per-file cap is in play here (8 <= MAX_LINES_PER_FILE): this fixture
// isolates F6's response-wide soft-degrade fix from F6's other, per-file
// cheap-line-numbers fix (covered separately below).
const DEGRADE_BAND_HITS_PER_FILE = MAX_LINES_PER_FILE;

function matchLine(fileIdx: number, hitIdx: number): string {
  return `const ${DEGRADE_BAND_QUERY}_${fileIdx}_${hitIdx} = "` + "z".repeat(100) + `";`;
}

function buildDegradeBandFixture(prefix: string): { workspace: string; expectedMatches: number } {
  const workspace = mkWorkspace(prefix);
  for (let i = 0; i < DEGRADE_BAND_FILES; i++) {
    const idx = String(i).padStart(2, "0");
    const lines: string[] = [];
    for (let h = 0; h < DEGRADE_BAND_HITS_PER_FILE; h++) lines.push(matchLine(i, h));
    const abs = path.join(workspace, `src/deg${idx}/f.ts`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, lines.join("\n") + "\n", "utf8");
  }
  return { workspace, expectedMatches: DEGRADE_BAND_FILES * DEGRADE_BAND_HITS_PER_FILE };
}

describe("F6: soft-degrade threshold scales with the wide-page cap", () => {
  it("OFF (default): this fixture already collapses to one-line-per-file footholds -- the exact band F5 alone left unfixed", () => {
    const { workspace, expectedMatches } = buildDegradeBandFixture("off");
    delete process.env["TL_FIND_WIDE_PAGE"];
    const off = buildFindResponse({ query: DEGRADE_BAND_QUERY }, workspace);
    expect(off.total_files).toBe(DEGRADE_BAND_FILES);
    expect(off.total_matches).toBe(expectedMatches);
    expect(off.truncated).toBe(true);
    // Collapsed all the way to footholds (1 line/file): confirms the
    // fixture's natural per-file-capped render is already past
    // SOFT_DEGRADE_BYTES(6144), the premise this whole describe block tests.
    expect(off.files.every((f) => f.lines.length === 1)).toBe(true);
    expect(off.files.some((f) => (f.more_lines ?? 0) > 0)).toBe(true);
  });

  it("ON: the ~9 KB natural render is served WHOLE in one response -- no more_lines anywhere, not truncated", () => {
    const { workspace, expectedMatches } = buildDegradeBandFixture("on");
    process.env["TL_FIND_WIDE_PAGE"] = "1";
    const on = buildFindResponse({ query: DEGRADE_BAND_QUERY }, workspace);
    const bytes = Buffer.byteLength(JSON.stringify(on), "utf8");

    expect(on.total_files).toBe(DEGRADE_BAND_FILES);
    expect(on.total_matches).toBe(expectedMatches);
    expect(on.truncated).toBe(false);
    expect(on.files.length).toBe(DEGRADE_BAND_FILES);
    for (const f of on.files) {
      expect(f.lines.length).toBe(DEGRADE_BAND_HITS_PER_FILE);
      expect(f.more_lines ?? 0).toBe(0);
    }
    // The "~9 KB" shape the brief measured, and confirmation it fits well
    // inside the wide-page response cap rather than merely under the old one.
    expect(bytes).toBeGreaterThan(SOFT_DEGRADE_BYTES);
    expect(bytes).toBeLessThanOrEqual(findResponseCapBytes());
  });

  it("TL_TURN_ECONOMY=1 alone (umbrella, no explicit TL_FIND_WIDE_PAGE) reaches the same ON behaviour", () => {
    const { workspace } = buildDegradeBandFixture("umbrella");
    process.env["TL_TURN_ECONOMY"] = "1";
    const on = buildFindResponse({ query: DEGRADE_BAND_QUERY }, workspace);
    expect(on.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: a single file whose matches exceed MAX_LINES_PER_FILE but stay
// under FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE -- "cheap line numbers".
// ---------------------------------------------------------------------------

const MANY_LINES_QUERY = "manyLinesSingleFileToken";
const MANY_LINES_MATCH_COUNT = 30;

function buildSingleFileManyMatches(prefix: string, query: string, count: number): string {
  const workspace = mkWorkspace(prefix);
  const lines: string[] = [];
  for (let h = 0; h < count; h++) lines.push(`const ${query}_${h} = ${h};`);
  fs.writeFileSync(path.join(workspace, "f.ts"), lines.join("\n") + "\n", "utf8");
  return workspace;
}

describe("F6: cheap line numbers past the snippet cap", () => {
  it("OFF (default): unchanged -- 8 lines, 8 snippets, more_lines discloses the rest", () => {
    const workspace = buildSingleFileManyMatches("cheap-off", MANY_LINES_QUERY, MANY_LINES_MATCH_COUNT);
    delete process.env["TL_FIND_WIDE_PAGE"];
    const off = buildFindResponse({ query: MANY_LINES_QUERY }, workspace);
    const file = off.files[0]!;
    expect(off.files.length).toBe(1);
    expect(file.lines.length).toBe(MAX_LINES_PER_FILE);
    expect(file.snippets?.length).toBe(MAX_LINES_PER_FILE);
    expect(file.more_lines).toBe(MANY_LINES_MATCH_COUNT - MAX_LINES_PER_FILE);
    expect(off.truncated).toBe(true);
  });

  it("ON: all 30 line numbers ship in `lines`, snippets stay capped at 8, and the file is no longer truncated", () => {
    const workspace = buildSingleFileManyMatches("cheap-on", MANY_LINES_QUERY, MANY_LINES_MATCH_COUNT);
    process.env["TL_FIND_WIDE_PAGE"] = "1";
    const on = buildFindResponse({ query: MANY_LINES_QUERY }, workspace);
    const file = on.files[0]!;

    expect(on.files.length).toBe(1);
    expect(file.lines.length).toBe(MANY_LINES_MATCH_COUNT);
    expect(file.lines).toEqual(Array.from({ length: MANY_LINES_MATCH_COUNT }, (_, i) => i + 1));
    expect(file.snippets?.length).toBe(MAX_LINES_PER_FILE);
    // lines[] intentionally runs past snippets[]: FindFileGroup's own doc
    // comment (packages/types) already describes snippets as "same order as
    // lines", never same-length. Every entry up to snippets.length still
    // pairs 1:1 with its snippet.
    expect(file.lines.length).toBeGreaterThan(file.snippets!.length);
    expect(file.lines.slice(0, MAX_LINES_PER_FILE)).toEqual(
      Array.from({ length: MAX_LINES_PER_FILE }, (_, i) => i + 1),
    );
    expect(file.more_lines ?? 0).toBe(0);
    expect(on.truncated).toBe(false);
  });

  it("a file whose true match count exceeds FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE still discloses more_lines honestly", () => {
    const query = "overBoundToken";
    const total = FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE + 10;
    const workspace = buildSingleFileManyMatches("cheap-over-bound", query, total);

    process.env["TL_FIND_WIDE_PAGE"] = "1";
    const on = buildFindResponse({ query }, workspace);
    const file = on.files[0]!;
    expect(file.lines.length).toBe(FIND_WIDE_PAGE_MAX_LINE_NUMBERS_PER_FILE);
    expect(file.snippets?.length).toBe(MAX_LINES_PER_FILE);
    expect(file.more_lines).toBe(10);
    expect(on.truncated).toBe(true);
  });
});
