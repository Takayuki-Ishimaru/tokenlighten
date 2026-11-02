// ---------------------------------------------------------------------------
// A find that did not run a pattern says so rather than reading as "no match", and
// `omitted.oversize` names a file that re-scoping at it can then reach.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildFindResponse, buildFindResponseForQueries, regexNotRunReason } from "../features/search/find/findText.js";
import { createWalkOmissions, mergeOversizeOmissions } from "../tools/walkRepo.js";

const created: string[] = [];

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".tl-find-honesty-")));
  created.push(ws);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  return ws;
}

describe("regexNotRunReason", () => {
  it("runs an ordinary pattern, and names why it will not run the others", () => {
    expect(regexNotRunReason("^const a\\d")).toBeUndefined();
    expect(regexNotRunReason("^[0-9]+,(?!ok,)")).toMatch(/lookarounds/);
    expect(regexNotRunReason("(a+)+$")).toMatch(/repeated groups/);
    expect(regexNotRunReason("([unclosed")).toMatch(/does not compile/);
    expect(regexNotRunReason("a".repeat(257))).toMatch(/longer than 256/);
  });
});

describe("a regex find that was not run", () => {
  const files = { "src/a.ts": "export const alpha = 1;\n" };

  it("a single pattern: no certificate, the hint says nothing was searched", () => {
    const r = buildFindResponse({ query: "alpha(?!x)", regex: true }, workspace(files));
    expect(r.total_matches).toBe(0);
    expect(r.absence).toBeUndefined();
    expect(r.regex_not_run).toEqual(["alpha(?!x)"]);
    expect(r.literal).toBe(false);
    expect(r.hint).toMatch(/not run.*nothing was searched.*lookarounds/);
  });

  it("every pattern of queries[]: same", () => {
    const r = buildFindResponseForQueries({ queries: ["a(?!x)", "(b+)+"], regex: true }, workspace(files));
    expect(r.total_matches).toBe(0);
    expect(r.absence).toBeUndefined();
    expect(r.regex_not_run).toEqual(["a(?!x)", "(b+)+"]);
  });

  it("one of several patterns misses and another did not run: the miss certifies nothing about the whole set", () => {
    const r = buildFindResponseForQueries({ queries: ["a(?!x)", "zzz_absent"], regex: true }, workspace(files));
    expect(r.total_matches).toBe(0);
    expect(r.absence).toBeUndefined();
    expect(r.regex_not_run).toEqual(["a(?!x)"]);
    expect(r.hint).toMatch(/not run/);
  });

  it("one pattern hits and another did not run: the hits come back, and that term stays unknown", () => {
    const r = buildFindResponseForQueries({ queries: ["alpha", "a(?!x)"], regex: true }, workspace(files));
    expect(r.total_matches).toBe(1);
    expect(r.regex_not_run).toEqual(["a(?!x)"]);
    expect(r.term_results).toEqual([
      { original: "alpha", status: "matched", match_count: 1 },
      { original: "a(?!x)", status: "unknown", scope: { completeness: "partial" } },
    ]);
  });

  it("a pattern that runs and matches nothing still certifies its absence", () => {
    const r = buildFindResponse({ query: "zzz_absent\\d", regex: true }, workspace(files));
    expect(r.absence).toBeDefined();
    expect(r.regex_not_run).toBeUndefined();
  });
});

describe("a file over the scan's size limit", () => {
  const big = `${"plain line of text\n".repeat(500_000)}needle_value here\n`;

  it("is named once in omitted, however many walks saw it", () => {
    const ws = workspace({ "data/big.csv": big, "src/a.ts": "export const alpha = 1;\n" });
    expect(fs.statSync(path.join(ws, "data/big.csv")).size).toBeGreaterThan(8 * 1024 * 1024);
    const r = buildFindResponse({ query: "needle_value" }, ws);
    expect(r.total_matches).toBe(0);
    expect(r.omitted).toMatchObject({ oversize: 1, oversize_paths: ["data/big.csv"] });
    expect(r.absence).toBeUndefined();
  });

  it("is reached by re-scoping at it, as the reply says", () => {
    const ws = workspace({ "data/big.csv": big });
    for (const r of [
      buildFindResponse({ query: "needle_value", path: "data/big.csv" }, ws),
      buildFindResponseForQueries({ queries: ["needle_value"], path: "data/big.csv" }, ws),
    ]) {
      expect(r.total_matches).toBe(1);
      expect(r.files[0]!.lines).toEqual([500_001]);
    }
  });

  it("a scope that names a directory keeps the limit", () => {
    const ws = workspace({ "data/big.csv": big });
    expect(buildFindResponse({ query: "needle_value", path: "data" }, ws).total_matches).toBe(0);
  });

  it("merging walks adds each file once and keeps the count equal to the names", () => {
    const first = createWalkOmissions();
    const second = createWalkOmissions();
    second.oversize = 2;
    second.oversize_paths = ["a.csv", "b.csv"];
    first.oversize = 1;
    first.oversize_paths = ["a.csv"];
    mergeOversizeOmissions(first, second);
    expect(first.oversize).toBe(2);
    expect(first.oversize_paths).toEqual(["a.csv", "b.csv"]);
  });
});
