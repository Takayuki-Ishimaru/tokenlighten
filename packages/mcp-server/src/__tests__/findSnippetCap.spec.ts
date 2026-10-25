/**
 * findSnippetCap.spec.ts — TL_EFF_FIND_SNIPPET_CAP (2026-10-19, default ON).
 *
 * MEASURED (v0.16.0 decision run 2026-10-18-v016-decision-6t-3, arm A): 12 of
 * the 49 finds matched 13-31 files and ran 4.7-11.1 KB, mostly `snippets` —
 * up to eight trimmed lines for every matched file. T09 rep1 #4
 * (`queries:["IssuePriority","priority"]`) matched 31 files in 10,674 B.
 *
 * THE RULE (findText.ts `capFindSnippets`): above FIND_SNIPPET_MAX_FILES (10)
 * matched files, `snippets` ride only on the ten files with the most matched
 * lines (ties: the reply's path order); every file keeps all of its `lines`;
 * `snippet_cap` gives `top`, `more` (files left with lines only) and the
 * `scope` that narrows the same find to the directory holding most of those
 * files while matching at most ten. The match set and its completeness —
 * `total_files`, `total_matches`, `truncated` (hence `limit`),
 * `inventory_complete`, `term_results`, `absence` — are unchanged, and
 * TL_EFF_FIND_SNIPPET_CAP=0 restores the uncapped reply byte-for-byte.
 *
 * Fixture: fourteen small files under `pkg/`, hit counts 9..1, one of them
 * tied with the tenth-ranked file so the path-order tie-break decides, and one
 * over the per-file preview cap (MAX_LINES_PER_FILE snippets), which still
 * applies; every match line is short, so no byte cap interferes.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildFindResponse,
  buildFindResponseForQueries,
  FIND_SNIPPET_MAX_FILES,
  MAX_LINES_PER_FILE,
  type FindResponse,
} from "../tools/findText.js";
import { callTool } from "../server.js";

const TOKEN = "snipCapToken";

/** path -> matched lines in that file. Top ten by hits: a/one..c/ten (9..3); d/x2 ties ten at 3 and loses on path order. */
const LAYOUT: ReadonlyArray<readonly [string, number]> = [
  ["pkg/a/one.ts", 9],
  ["pkg/a/two.ts", 8],
  ["pkg/a/three.ts", 7],
  ["pkg/b/four.ts", 6],
  ["pkg/b/five.ts", 5],
  ["pkg/b/six.ts", 5],
  ["pkg/c/seven.ts", 4],
  ["pkg/c/eight.ts", 4],
  ["pkg/c/nine.ts", 3],
  ["pkg/c/ten.ts", 3],
  ["pkg/d/x1.ts", 1],
  ["pkg/d/x2.ts", 3],
  ["pkg/e/deep/y1.ts", 1],
  ["pkg/e/deep/y2.ts", 1],
];
const TOP_TEN = new Set(LAYOUT.slice(0, 10).map(([rel]) => rel));
const TOTAL_MATCHES = LAYOUT.reduce((n, [, hits]) => n + hits, 0);

const tmpDirs: string[] = [];

function mkWorkspace(prefix: string): string {
  const home = process.env["HOME"] ?? os.homedir();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(home, `.tl-fsc-${prefix}-`)));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, text: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
}

/** Each matched line is preceded by a non-matching one, so `lines` are 2, 4, 6, ... */
function buildFixture(prefix: string, layout: ReadonlyArray<readonly [string, number]> = LAYOUT): string {
  const workspace = mkWorkspace(prefix);
  for (const [rel, hits] of layout) {
    const lines: string[] = [];
    for (let h = 0; h < hits; h++) {
      lines.push(`// filler ${h}`);
      lines.push(`export const ${TOKEN}_${h} = ${h};`);
    }
    writeFile(workspace, rel, lines.join("\n") + "\n");
  }
  return workspace;
}

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env["TL_EFF_FIND_SNIPPET_CAP"];
  if (value === undefined) delete process.env["TL_EFF_FIND_SNIPPET_CAP"];
  else process.env["TL_EFF_FIND_SNIPPET_CAP"] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env["TL_EFF_FIND_SNIPPET_CAP"];
    else process.env["TL_EFF_FIND_SNIPPET_CAP"] = previous;
  }
}

afterEach(() => {
  delete process.env["TL_EFF_FIND_SNIPPET_CAP"];
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** `files[]` with `snippets` removed: what the capped reply must equal for the lines-only files. */
function withoutSnippets(files: FindResponse["files"]): Array<Record<string, unknown>> {
  return files.map((file) => {
    const copy: Record<string, unknown> = { ...file };
    delete copy["snippets"];
    return copy;
  });
}

describe("TL_EFF_FIND_SNIPPET_CAP — buildFindResponse (single query)", () => {
  it("default: every file lists all its lines; snippets ride only on the ten files with the most hits (path order breaks the tie)", () => {
    const workspace = buildFixture("on");
    const on = withFlag(undefined, () => buildFindResponse({ query: TOKEN, path: "pkg" }, workspace));

    expect(FIND_SNIPPET_MAX_FILES).toBe(10);
    expect(on.files.map((f) => f.path).sort()).toEqual(LAYOUT.map(([rel]) => rel).sort());
    for (const [rel, hits] of LAYOUT) {
      const file = on.files.find((f) => f.path === rel)!;
      // Every matched line, untouched by the cap.
      expect(file.lines, rel).toEqual(Array.from({ length: hits }, (_, h) => 2 * h + 2));
      expect(file.more_lines, rel).toBeUndefined();
      // The per-file preview cap still applies to the files that keep snippets (one.ts: 9 lines, 8 snippets).
      if (TOP_TEN.has(rel)) expect(file.snippets?.length, rel).toBe(Math.min(hits, MAX_LINES_PER_FILE));
      else expect(file.snippets, rel).toBeUndefined();
    }
    expect(on.snippet_cap).toEqual({ top: 10, more: 4, scope: { path: "pkg/d" } });
    expect(on.total_files).toBe(LAYOUT.length);
    expect(on.total_matches).toBe(TOTAL_MATCHES);
    expect(on.truncated).toBe(false);
    expect(on.inventory_complete).toBe(true);
  });

  it("explicit 0 restores the uncapped reply: snippets on every file, no snippet_cap, same match set", () => {
    const workspace = buildFixture("off");
    const off = withFlag("0", () => buildFindResponse({ query: TOKEN, path: "pkg" }, workspace));
    const on = withFlag(undefined, () => buildFindResponse({ query: TOKEN, path: "pkg" }, workspace));

    expect(off.snippet_cap).toBeUndefined();
    expect(off.files.every((f) => f.snippets?.length === Math.min(f.lines.length, MAX_LINES_PER_FILE))).toBe(true);
    // Same match set and completeness either way.
    for (const key of ["query", "total_files", "total_matches", "truncated", "literal", "inventory_complete"] as const) {
      expect(on[key], key).toEqual(off[key]);
    }
    // The capped files are the uncapped ones minus `snippets`, nothing else.
    expect(withoutSnippets(on.files)).toEqual(withoutSnippets(off.files));
    const offByPath = new Map(off.files.map((f) => [f.path, f]));
    for (const file of on.files) {
      if (TOP_TEN.has(file.path)) expect(file, file.path).toEqual(offByPath.get(file.path));
    }
  });

  it("ten matched files or fewer: the reply is unchanged", () => {
    const workspace = buildFixture("ten", LAYOUT.slice(0, 10));
    const on = withFlag(undefined, () => buildFindResponse({ query: TOKEN }, workspace));
    const off = withFlag("0", () => buildFindResponse({ query: TOKEN }, workspace));
    expect(on.snippet_cap).toBeUndefined();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  it("no directory below the searched scope matches ten files or fewer: snippet_cap names no scope", () => {
    const flat = Array.from({ length: 12 }, (_, i) => [`flat/f${String(i).padStart(2, "0")}.ts`, 12 - i] as const);
    const workspace = buildFixture("flat", flat);
    const atRoot = withFlag(undefined, () => buildFindResponse({ query: TOKEN }, workspace));
    expect(atRoot.snippet_cap).toEqual({ top: 10, more: 2 });
    const inFlat = withFlag(undefined, () => buildFindResponse({ query: TOKEN, path: "flat" }, workspace));
    expect(inFlat.snippet_cap).toEqual({ top: 10, more: 2 });
    // The two files with the fewest hits are the lines-only ones.
    expect(inFlat.files.filter((f) => f.snippets === undefined).map((f) => f.path)).toEqual(["flat/f10.ts", "flat/f11.ts"]);
  });

  it("a capped find that still overflows its page keeps the over-cap guarantees: every file named, exact totals, the complete inventory", () => {
    // The replay corpus's fic1 (150 files, 1-4 hits) fits one page once
    // snippets are capped, so it pins the uncapped shape; this is the same
    // shape at a scale that overflows with the cap on: 150 files of 10-40 hits.
    const layout: ReadonlyArray<readonly [string, number]> = Array.from({ length: 150 }, (_, i) => [`src/m${i}/f.ts`, 10 * ((i % 4) + 1)] as const);
    const workspace = buildFixture("overflow", layout);
    const totalMatches = layout.reduce((n, [, hits]) => n + hits, 0);
    const on = withFlag(undefined, () => buildFindResponse({ query: TOKEN }, workspace));

    expect(on.truncated).toBe(true);
    expect(on.snippet_cap).toEqual({ top: 10, more: 140 });
    expect(on.total_files).toBe(150);
    expect(on.total_matches).toBe(totalMatches);
    expect(on.files).toHaveLength(150);
    const hitsByPath = new Map(layout);
    for (const file of on.files) expect(file.lines.length + (file.more_lines ?? 0), file.path).toBe(hitsByPath.get(file.path));
    const inventory = on.inventory as Array<{ path: string; matches: number }>;
    expect(on.inventory_complete).toBe(true);
    expect(inventory).toHaveLength(150);
    expect(inventory.reduce((n, entry) => n + entry.matches, 0)).toBe(totalMatches);
    expect(on.note).toMatch(/exhaustive/);
  });
});

describe("TL_EFF_FIND_SNIPPET_CAP — buildFindResponseForQueries (queries[])", () => {
  it("caps the merged OR result the same way; term_results and matched_terms are unchanged", () => {
    const workspace = buildFixture("queries");
    const input = { queries: [TOKEN, "neverPresentSnipToken"], path: "pkg" };
    const on = withFlag(undefined, () => buildFindResponseForQueries(input, workspace));
    const off = withFlag("0", () => buildFindResponseForQueries(input, workspace));

    expect(on.snippet_cap).toEqual({ top: 10, more: 4, scope: { path: "pkg/d" } });
    expect(off.snippet_cap).toBeUndefined();
    expect(on.term_results).toEqual(off.term_results);
    expect(on.term_results?.map((t) => t.status)).toEqual(["matched", "absent"]);
    expect(on.matched_terms).toEqual(off.matched_terms);
    expect(on.did_you_mean).toEqual(off.did_you_mean);
    expect(on.total_matches).toBe(TOTAL_MATCHES);
    expect(withoutSnippets(on.files)).toEqual(withoutSnippets(off.files));
  });

  it("a zero-match reply keeps its absence certificate byte-for-byte", () => {
    const workspace = buildFixture("absent");
    const input = { queries: ["neverPresentSnipToken", "alsoNeverPresent"], path: "pkg" };
    const on = withFlag(undefined, () => buildFindResponseForQueries(input, workspace));
    const off = withFlag("0", () => buildFindResponseForQueries(input, workspace));
    expect(on.absence).toBeDefined();
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });
});

describe("TL_EFF_FIND_SNIPPET_CAP — on the wire (search.matches find)", () => {
  async function find(workspace: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await callTool("tl_search_files", { action: "find", cwd: workspace, ...args });
    const first = (response as { content: Array<{ type: string; text?: string }> }).content[0];
    return JSON.parse(first?.type === "text" && typeof first.text === "string" ? first.text : "{}") as Record<string, unknown>;
  }

  it("snippet_cap rides the find form ahead of files[], and no limit is added", async () => {
    const workspace = buildFixture("wire");
    const body = await find(workspace, { queries: [TOKEN], scope: { path: "pkg" } });
    expect(body["kind"]).toBe("search.matches");
    const matches = body["matches"] as Record<string, unknown>;
    expect(matches["snippet_cap"]).toEqual({ top: 10, more: 4, scope: { path: "pkg/d" } });
    const keys = Object.keys(matches);
    expect(keys.indexOf("snippet_cap")).toBeLessThan(keys.indexOf("files"));
    expect(body["limit"]).toBeUndefined();
    const files = matches["files"] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(LAYOUT.length);
    expect(files.filter((f) => f["snippets"] === undefined).map((f) => f["path"]).sort())
      .toEqual(["pkg/d/x1.ts", "pkg/d/x2.ts", "pkg/e/deep/y1.ts", "pkg/e/deep/y2.ts"]);
  });

  it("explicit 0: the same call carries snippets for every file and no snippet_cap", async () => {
    const workspace = buildFixture("wire-off");
    process.env["TL_EFF_FIND_SNIPPET_CAP"] = "0";
    const body = await find(workspace, { queries: [TOKEN], scope: { path: "pkg" } });
    const matches = body["matches"] as Record<string, unknown>;
    expect(matches["snippet_cap"]).toBeUndefined();
    const files = matches["files"] as Array<Record<string, unknown>>;
    expect(files.every((f) => Array.isArray(f["snippets"]))).toBe(true);
  });
});
