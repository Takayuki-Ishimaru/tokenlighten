// findReferences.spec.ts — unit tests for the explore action=references backend.
//
// Tests:
//   - word-boundary match (excludes `findById2`, `myFindById`, etc.)
//   - in_comment flag on // and /* lines
//   - invalid identifier → empty result
//   - lang filter
//   - subpath filter
//   - 200-cap truncation
//   - C7: trimmed per-line text (match-centered), grouped-by-file `files`,
//     2048-byte cap with a foothold per file
//   - L2 (2026-08-01) response contract: truncation_reason, an effective
//     `limit`, files_omitted + a runnable `next`, the zero-match absence
//     certificate, and `generated` provenance
//   - L3/E3 (2026-08-01 references-cursor): `next` is a CONTINUATION
//     (`after=<last-served-path>`) that walks every dropped file group to
//     exhaustion, and the flat `references` peek honors the caller's `limit`

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  decodeReferencesCursor,
  encodeReferencesCursor,
  findReferences,
  MAX_RESPONSE_BYTES,
  type FindReferencesInput,
  type FindReferencesResult,
} from "../tools/findReferences.js";
import type { LangKey } from "../tools/walkRepo.js";

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-fr-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

describe("findReferences — word boundary", () => {
  it("matches whole-word only, not substrings", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "const r = repo.findById(id);",     // ← match
      "const r2 = repo.findById2(id);",   // no match (findById2 is a different word)
      "const r3 = myFindById(id);",       // no match (myFindById is a different word)
      "const r4 = findById;",             // ← match
    ].join("\n"));

    const result = await findReferences({ symbol: "findById" }, ws);

    expect(result.total).toBe(2);
    expect(result.references.map((r) => r.line).sort()).toEqual([1, 4]);
  });

  it("returns matches across multiple files in sorted order", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "b.ts", "doX(); findById(1);\n");
    writeFile(ws, "a.ts", "findById(0);\n");

    const result = await findReferences({ symbol: "findById" }, ws);

    expect(result.total).toBe(2);
    expect(result.references.map((r) => r.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("findReferences — comment detection", () => {
  it("flags matches on // line-comments", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "// uses findById internally",
      "const r = findById(1);",
    ].join("\n"));

    const result = await findReferences({ symbol: "findById" }, ws);

    expect(result.total).toBe(2);
    const byLine = new Map(result.references.map((r) => [r.line, r]));
    expect(byLine.get(1)?.in_comment).toBe(true);
    expect(byLine.get(2)?.in_comment).toBe(false);
  });

  it("flags matches on # line-comments in python", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.py", [
      "# we call find_by_id here",
      "x = find_by_id(1)",
    ].join("\n"));

    const result = await findReferences({ symbol: "find_by_id" }, ws);

    expect(result.total).toBe(2);
    expect(result.references[0]?.in_comment).toBe(true);
    expect(result.references[1]?.in_comment).toBe(false);
  });

  it("flags JSDoc-style block-comment lines", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "/**",
      " * uses findById to lookup",
      " */",
      "function lookup() { return findById(1); }",
    ].join("\n"));

    const result = await findReferences({ symbol: "findById" }, ws);
    const flags = new Map(result.references.map((r) => [r.line, r.in_comment]));
    expect(flags.get(2)).toBe(true);
    expect(flags.get(4)).toBe(false);
  });
});

describe("findReferences — lexical exclusions", () => {
  it("excludes matches inside string literals while keeping real references", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "const label = \"findById\";",
      "const template = `call findById later`;",
      "const r = findById(1);",
    ].join("\n"));

    const result = await findReferences({ symbol: "findById" }, ws);

    expect(result.total).toBe(1);
    expect(result.references.map((r) => r.line)).toEqual([3]);
  });
});

describe("findReferences — full-recall (build/generated source)", () => {
  it("finds references in legitimately-named build/ and generated/ source dirs", async () => {
    const ws = mkWorkspace();
    // Regular source reference.
    writeFile(ws, "src/main.ts", "import { helper } from './build/utils';\nhelper();\n");
    // Source that lives under build-dir / generated-named directories — these
    // are noise-filtered for orientation modes but MUST be seen for correct
    // reference recall (findReferences passes fullRecall).
    writeFile(ws, "src/build/utils.ts", "export function helper() { return 1; }\n");
    writeFile(ws, "src/codegen/generated/schema.ts", "export const s = helper;\n");
    writeFile(ws, "packages/lib/__generated__/api.ts", "export const a = helper();\n");

    const result = await findReferences({ symbol: "helper" }, ws);
    const paths = result.references.map((r) => r.path).sort();

    expect(paths).toContain("src/main.ts");
    expect(paths).toContain("src/build/utils.ts");
    expect(paths).toContain("src/codegen/generated/schema.ts");
    expect(paths).toContain("packages/lib/__generated__/api.ts");
  });
});

describe("findReferences — input validation", () => {
  it("returns empty result for an invalid identifier", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "anything\n");

    const result = await findReferences({ symbol: "not-an-identifier" }, ws);

    expect(result.total).toBe(0);
    expect(result.references).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it("returns empty result for an empty symbol", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "anything\n");

    const result = await findReferences({ symbol: "" }, ws);

    expect(result.total).toBe(0);
    expect(result.files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C7 — trimmed per-line text, grouped-by-file `files`, 2048-byte cap
// ---------------------------------------------------------------------------

describe("findReferences — C7 line text", () => {
  // Trimmed source text lives on the grouped `files[].snippets` view (not
  // the flat `references[]` array — see the module doc comment: keeping the
  // flat view text-free preserves its pre-C7 byte cost so the fixed
  // 2048-byte cap is spent on footholds-per-file instead of duplicated text).

  it("adds a trimmed snippet (<=80 chars) per reference to its file group", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "  const marker = findById(1);  \n");

    const result = await findReferences({ symbol: "findById" }, ws);

    const group = result.files.find((f) => f.path === "a.ts");
    expect(group?.snippets?.[0]).toBe("const marker = findById(1);");
  });

  it("C7: a reference past column 80 keeps the matched token (match-centered window, shared trimMatchText policy)", async () => {
    const ws = mkWorkspace();
    // 95 chars of filler before the matched call, so a naive first-80-chars
    // trim would cut the symbol out of its own snippet entirely.
    const filler = "x".repeat(95);
    const line = `const ${filler} = veryDistinctiveReferenceTarget(); // trailing padding padding\n`;
    writeFile(ws, "a.ts", line);

    const result = await findReferences({ symbol: "veryDistinctiveReferenceTarget" }, ws);

    expect(result.references).toHaveLength(1);
    const group = result.files.find((f) => f.path === "a.ts");
    const text = group?.snippets?.[0] ?? "";
    expect(text).toContain("veryDistinctiveReferenceTarget");
    expect(text.startsWith("…")).toBe(true); // left-clipped: same convention as findText's C6 window
    expect(text.length).toBeLessThanOrEqual(82);
  });

  it("preserves in_comment alongside the new per-file snippets", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", [
      "// uses findById internally",
      "const r = findById(1);",
    ].join("\n"));

    const result = await findReferences({ symbol: "findById" }, ws);
    const group = result.files.find((f) => f.path === "a.ts");
    expect(group?.lines).toEqual([1, 2]);
    expect(group?.in_comment).toEqual([true, false]);
    expect(group?.snippets?.[0]).toContain("findById");
    expect(group?.snippets?.[1]).toContain("findById");

    // Flat `references` still carries in_comment (unchanged pre-C7 field).
    const byLine = new Map(result.references.map((r) => [r.line, r]));
    expect(byLine.get(1)?.in_comment).toBe(true);
    expect(byLine.get(2)?.in_comment).toBe(false);
  });
});

describe("findReferences — C7 grouping by file", () => {
  it("groups references by file: {path, lines:[...], snippets:[...], in_comment:[...]} instead of one entry per line", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "findById(1);\nfindById(2);\nfindById(3);\n");

    const result = await findReferences({ symbol: "findById" }, ws);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("a.ts");
    expect(result.files[0]?.lines).toEqual([1, 2, 3]);
    expect(result.files[0]?.snippets).toHaveLength(3);
    expect(result.files[0]?.in_comment).toEqual([false, false, false]);
  });

  it("avoids repeating the path across files — one group entry per file, not per reference", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "a.ts", "findById(1);\n");
    writeFile(ws, "b.ts", "findById(2);\nfindById(3);\n");
    writeFile(ws, "c.ts", "findById(4);\n");

    const result = await findReferences({ symbol: "findById" }, ws);

    expect(result.total).toBe(4);
    // 4 references, but only 3 file groups — the path string itself is not
    // duplicated per matched line, unlike the flat `references` array.
    expect(result.files).toHaveLength(3);
    const serialized = JSON.stringify(result.files);
    // "b.ts" (the 2-reference file) appears exactly once as a JSON key value,
    // not once per line.
    expect(serialized.match(/"b\.ts"/g)?.length).toBe(1);
    const bGroup = result.files.find((f) => f.path === "b.ts");
    expect(bGroup?.lines).toEqual([1, 2]); // findById(2) on line 1, findById(3) on line 2 of b.ts
  });

  it("files are sorted alphabetically by path (byte-stable order)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "z.ts", "findById(1);\n");
    writeFile(ws, "a.ts", "findById(2);\n");
    writeFile(ws, "m.ts", "findById(3);\n");

    const result = await findReferences({ symbol: "findById" }, ws);

    expect(result.files.map((f) => f.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});

describe("findReferences — C7 byte cap", () => {
  it("exports MAX_RESPONSE_BYTES = 2048 (unchanged cap)", () => {
    expect(MAX_RESPONSE_BYTES).toBe(2048);
  });

  it("stays within the 2048-byte cap on a many-reference case, with a foothold line per file surviving", async () => {
    const ws = mkWorkspace();
    // 11 files x 3 references each = 33 total references. At findReferences'
    // 2048-byte cap, the full 3-line-per-file payload measures well over
    // cap, while 11 single-line footholds (plus the fixed-size `references`
    // peek) measure ~2.0KB — comfortably under. This forces real truncation
    // while keeping the foothold guarantee provable: every matched file
    // must still surface at least 1 line with its snippet.
    const FILE_COUNT = 11;
    for (let i = 0; i < FILE_COUNT; i++) {
      const lines = [
        `const refTarget${i}_a = 1; // call refTarget below`,
        `refTarget(refTarget${i}_a);`,
        `refTarget(refTarget${i}_a + 1);`,
      ];
      writeFile(ws, `src/dir${i}/file.ts`, lines.join("\n"));
    }

    const result = await findReferences({ symbol: "refTarget" }, ws);

    expect(result.total).toBe(FILE_COUNT * 3);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    // L4 (2026-08-01 references-cursor v2): the foothold-per-file breadth
    // policy this test used to pin was DELIBERATELY traded away — sampling a
    // bit of every file is incompatible with a scalar cursor, and the
    // trimmed lines it produced were unreachable once the cursor passed the
    // file (review finding P1). A byte-pressured page is now a whole-group
    // PREFIX: fewer files, but every served group is complete (only the
    // last may be cut, disclosed via more_lines) and next_call recovers the
    // rest exhaustively.
    expect(result.files.length).toBeGreaterThanOrEqual(1);
    expect(result.files.length).toBeLessThan(FILE_COUNT);
    for (const [i, group] of result.files.entries()) {
      expect(group.in_comment.length).toBe(group.lines.length);
      if (group.snippets) expect(group.snippets.length).toBe(group.lines.length);
      // Prefix completeness: every group but the last carries ALL its lines.
      if (i < result.files.length - 1) {
        expect(group.lines.length).toBe(3);
        expect(group.more_lines).toBeUndefined();
      }
    }
    expect(result.truncated).toBe(true);
    // The withheld remainder is reachable: follow next_call to exhaustion.
    let servedLineCount = result.files.reduce((n, g) => n + g.lines.length, 0);
    let page = result;
    for (let calls = 1; page.next_call !== undefined; calls++) {
      expect(calls).toBeLessThanOrEqual(FILE_COUNT * 3 + 2);
      page = await findReferences(nextCallInput(page.next_call), ws);
      servedLineCount += page.files.reduce((n, g) => n + g.lines.length, 0);
    }
    expect(servedLineCount).toBe(FILE_COUNT * 3);
  });

  it("guarantees every matched file gets a foothold even with a much larger fan-out (40 files)", async () => {
    const ws = mkWorkspace();
    // A more extreme fan-out than the cap can give full footholds to (see
    // the byte-math in the module doc comment) — files must still be
    // dropped from the TAIL deterministically (alphabetical), never
    // silently, and `truncated` must say so; every SURVIVING file entry
    // must still be well-formed (foothold line + aligned parallel arrays).
    for (let i = 0; i < 40; i++) {
      const lines = [
        `const wideTarget${i}_a = 1;`,
        `wideTarget(wideTarget${i}_a);`,
      ];
      writeFile(ws, `src/dir${i}/file.ts`, lines.join("\n"));
    }

    const result = await findReferences({ symbol: "wideTarget" }, ws);

    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(result.truncated).toBe(true);
    // Fewer than all 40 files fit — but at least several do, and every one
    // that survives has a well-formed foothold.
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThan(40);
    for (const group of result.files) {
      expect(group.lines.length).toBeGreaterThanOrEqual(1);
      expect(group.in_comment.length).toBe(group.lines.length);
    }
  });

  it("the flat `references` peek is bounded independently of `files` and stays cheap regardless of fan-out", async () => {
    const ws = mkWorkspace();
    for (let i = 0; i < 40; i++) {
      writeFile(ws, `src/dir${i}/file.ts`, `capTarget(${i});\n`);
    }

    const result = await findReferences({ symbol: "capTarget" }, ws);

    expect(result.total).toBe(40);
    // references[] is capped well below `total`, independent of how many
    // files made it into `files`.
    expect(result.references.length).toBeLessThan(result.total);
    expect(result.references.length).toBeLessThanOrEqual(10);
    // Every references[] entry is a genuine match — its (path,line) is a
    // real reference (i.e. some file with a wideTarget/capTarget call), not
    // fabricated data.
    for (const r of result.references) {
      expect(r.path).toMatch(/^src\/dir\d+\/file\.ts$/);
      expect(r.line).toBe(1);
      expect(r.in_comment).toBe(false);
    }
  });

  it("S1/C2 regression: still walks only code extensions, NOT the explore action=find widened doc/config exts (.md/.yaml/etc.)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "const quorumThreshold = 3;\n");
    // findText's FIND_EXTRA_EXTS widening (C2) is scoped to the find path
    // only (via its own extraExts option) — findReferences must NOT pick up
    // matches from markdown/yaml/etc. it was never asked to walk.
    writeFile(ws, "docs/notes.md", "quorumThreshold mentioned in docs too\n");
    writeFile(ws, "config/settings.yaml", "quorumThreshold: 3\n");

    const result = await findReferences({ symbol: "quorumThreshold" }, ws);

    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("docs/notes.md");
    expect(paths).not.toContain("config/settings.yaml");
  });
});

// ---------------------------------------------------------------------------
// L2 (2026-08-01) response contract
//
// The live defect these pin: `total:10` with `limit:50` still returned
// `truncated:true` (a byte fit, not a match overflow) while whole file groups
// vanished from `files[]` with nothing to say so, `limit` was ignored
// outright, and a zero-match reply carried no proof it had scanned anything.
// ---------------------------------------------------------------------------

/**
 * L4 (2026-08-01 references-cursor v2): turn a structured `next_call` back
 * into findReferences() input — a chain-following agent does exactly this
 * (the arguments ARE the call). Strict on shape so a malformed continuation
 * fails the test rather than being papered over by a lenient consumer.
 */
function nextCallInput(nc: NonNullable<FindReferencesResult["next_call"]>): FindReferencesInput {
  expect(nc.tool).toBe("search_files");
  const a = nc.arguments;
  expect(a["action"]).toBe("references");
  expect(typeof a["query"], `next_call carries no query: ${JSON.stringify(a)}`).toBe("string");
  expect(typeof a["cursor"], `next_call carries no cursor: ${JSON.stringify(a)}`).toBe("string");
  return {
    symbol: a["query"] as string,
    cursor: a["cursor"] as string,
    ...(typeof a["path"] === "string" ? { path: a["path"] } : {}),
    ...(typeof a["lang"] === "string" ? { lang: a["lang"] as LangKey } : {}),
    ...(typeof a["limit"] === "number" ? { limit: a["limit"] } : {}),
  };
}

/** L4: every (path,line) pair a page served — the unit the v2 contract recovers. */
function servedLineKeys(page: FindReferencesResult): string[] {
  return page.files.flatMap((g) => g.lines.map((l) => `${g.path}#${l}`));
}

describe("findReferences — L2 truncation_reason", () => {
  it("(a) byte fit with total well under limit: reason 'bytes' + files_omitted + a `next` that walks EVERY dropped group to exhaustion", async () => {
    const ws = mkWorkspace();
    // 40 files x 2 references = 80 matches, against a limit of 100 — nothing
    // is match-capped, so `truncated` can ONLY be the 2048-byte fit. This is
    // the shape the live probe hit (total <= limit, truncated:true).
    for (let i = 0; i < 40; i++) {
      writeFile(ws, `src/dir${i}/file.ts`, [
        `contractTarget(${i});`,
        `const v${i} = contractTarget;`,
      ].join("\n"));
    }
    const allPaths = Array.from({ length: 40 }, (_, i) => `src/dir${i}/file.ts`).sort();

    const first = await findReferences({ symbol: "contractTarget", limit: 100 }, ws);

    expect(first.total).toBe(80);
    expect(first.total).toBeLessThanOrEqual(100);
    expect(first.truncated).toBe(true);
    expect(first.truncation_reason).toBe("bytes");
    // The byte fit dropped whole groups — say how many, and how to get them.
    expect(first.files_omitted).toBeGreaterThanOrEqual(1);
    expect(first.files_omitted).toBe(40 - first.files.length);
    expect(first.next_call).toBeDefined();
    expect(first.next_call!.arguments["query"]).toBe("contractTarget");

    // L4: `next_call` is a CONTINUATION, not a one-directory narrowing.
    // Following it verbatim, repeatedly, must reach EVERY matched LINE — the
    // pre-L3 response named one modal directory and stranded the rest; the
    // v1 cursor stranded trimmed lines inside served files.
    const servedLines: string[] = [];
    let page = first;
    let calls = 1;
    const MAX_PAGES = 90; // 80 matches + slack; a non-advancing cursor trips this
    for (;;) {
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      expect(page.total, "total stays the TRUE match count on every page").toBe(80);
      const pageLines = servedLineKeys(page);
      expect(pageLines.length, "every page must make progress").toBeGreaterThan(0);
      // Pages never re-serve: each one starts strictly after the last cursor.
      for (const k of pageLines) expect(servedLines).not.toContain(k);
      servedLines.push(...pageLines);
      if (servedLines.length === 80) {
        expect(page.files_omitted, "the last page owes nothing").toBeUndefined();
        expect(page.next_call).toBeUndefined();
        break;
      }
      expect(page.next_call, "a page that still owes lines must carry a next_call").toBeDefined();
      expect(calls, "continuation must terminate").toBeLessThan(MAX_PAGES);
      const args = nextCallInput(page.next_call!);
      expect(args.symbol).toBe("contractTarget");
      expect(args.limit).toBe(100);                        // original scoping echoed back
      // The opaque cursor decodes to the exact last (path,line) this page served.
      const pos = decodeReferencesCursor(args.cursor!);
      const lastKey = pageLines[pageLines.length - 1]!;
      expect(pos).toBeDefined();
      expect(`${pos!.p}#${pos!.l}`).toBe(lastKey);
      page = await findReferences(args, ws);
      calls++;
    }
    const servedPaths = [...new Set(servedLines.map((k) => k.split("#")[0]!))].sort();
    expect(servedPaths).toEqual(allPaths);
    expect(calls).toBeLessThan(MAX_PAGES);
  });

  it("(a2) the continuation is stateless and deterministic: a mid-list cursor serves exactly the matches after it", async () => {
    const ws = mkWorkspace();
    for (let i = 0; i < 6; i++) writeFile(ws, `src/f${i}.ts`, `statelessTarget(${i});\n`);

    // No prior call, no session — the cursor alone is the state.
    const midCursor = encodeReferencesCursor({ p: "src/f3.ts", l: 1 });
    const cold = await findReferences({ symbol: "statelessTarget", cursor: midCursor }, ws);
    expect(cold.files.map((g) => g.path)).toEqual(["src/f4.ts", "src/f5.ts"]);
    expect(cold.total).toBe(6);              // `total` is the whole walk, not the window
    expect(cold.references.every((r) => r.path > "src/f3.ts")).toBe(true);
    expect(cold.next_call).toBeUndefined();  // nothing left after the window
    expect(cold.cursor_note).toBeUndefined();

    // Line granularity: a cursor INSIDE f3 (before its line) still serves f3's line.
    const insideCursor = encodeReferencesCursor({ p: "src/f3.ts", l: 0 });
    const inside = await findReferences({ symbol: "statelessTarget", cursor: insideCursor }, ws);
    expect(inside.files.map((g) => g.path)).toEqual(["src/f3.ts", "src/f4.ts", "src/f5.ts"]);

    // Same call, same answer (deterministic for a fixed workspace).
    const again = await findReferences({ symbol: "statelessTarget", cursor: midCursor }, ws);
    expect(JSON.stringify(again)).toBe(JSON.stringify(cold));

    // A cursor past the end is end-of-chain, not an error.
    const pastCursor = encodeReferencesCursor({ p: "src/zzz.ts", l: 1 });
    const past = await findReferences({ symbol: "statelessTarget", cursor: pastCursor }, ws);
    expect(past.files).toEqual([]);
    expect(past.next_call).toBeUndefined();
    expect(past.total).toBe(6);

    // An UNDECODABLE cursor is ignored WITH disclosure — never a guessed window.
    const garbage = await findReferences({ symbol: "statelessTarget", cursor: "not-a-token!!" }, ws);
    expect(garbage.cursor_note).toContain("invalid cursor");
    expect(garbage.files.map((g) => g.path)).toEqual(
      ["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts", "src/f5.ts"],
    );
  });

  it("(a3) P1 regression — limit:3 against a 10-reference FILE pages through all 10 lines (v1 skipped 7 forever)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", Array.from({ length: 10 }, (_, i) => `hotSymbol(${i});`).join("\n") + "\n");
    writeFile(ws, "src/b.ts", "hotSymbol(99);\n");

    const servedLines: string[] = [];
    let page = await findReferences({ symbol: "hotSymbol", limit: 3 }, ws);
    for (let calls = 1; ; calls++) {
      expect(calls, "line-granular continuation must terminate").toBeLessThanOrEqual(6);
      servedLines.push(...servedLineKeys(page));
      if (page.next_call === undefined) break;
      // The mid-file page must disclose its withheld tail on the group itself.
      const aGroup = page.files.find((g) => g.path === "src/a.ts");
      if (aGroup !== undefined && servedLines.filter((k) => k.startsWith("src/a.ts#")).length < 10) {
        expect(aGroup.more_lines ?? 0).toBeGreaterThan(0);
      }
      page = await findReferences(nextCallInput(page.next_call), ws);
    }
    // Every line of BOTH files arrived exactly once — 11 matches total.
    expect(servedLines.sort()).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `src/a.ts#${i + 1}`),
      "src/b.ts#1",
    ].sort());
    expect(new Set(servedLines).size).toBe(11);
  });

  it("(a4) P1 regression — a byte-cut INSIDE one huge file resumes inside that file, recovering every line", async () => {
    const ws = mkWorkspace();
    // One file whose grouped rendering alone exceeds MAX_RESPONSE_BYTES: long
    // snippet lines force a mid-file byte cut on page 1.
    const wide = Array.from({ length: 60 }, (_, i) =>
      `bigCutTarget(${i}, "${"x".repeat(60)}");`).join("\n") + "\n";
    writeFile(ws, "src/huge.ts", wide);

    const servedLines: string[] = [];
    let page = await findReferences({ symbol: "bigCutTarget" }, ws);
    let sawMidFileCut = false;
    for (let calls = 1; ; calls++) {
      expect(calls).toBeLessThanOrEqual(10);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      const keys = servedLineKeys(page);
      for (const k of keys) expect(servedLines, "no line is ever re-served").not.toContain(k);
      servedLines.push(...keys);
      if (page.next_call === undefined) break;
      sawMidFileCut = true;
      const g = page.files[page.files.length - 1]!;
      expect(g.path).toBe("src/huge.ts");
      expect(g.more_lines ?? 0).toBeGreaterThan(0);
      page = await findReferences(nextCallInput(page.next_call), ws);
    }
    expect(sawMidFileCut, "fixture must actually force a mid-file cut").toBe(true);
    expect(servedLines.length).toBe(60);
  });

  it("(a5) P2 regression — paths with SPACES survive the structured continuation verbatim", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/my dir/space file.ts", "spacedTarget(1);\nspacedTarget(2);\n");
    writeFile(ws, "src/zz.ts", "spacedTarget(3);\n");

    const first = await findReferences({ symbol: "spacedTarget", limit: 1 }, ws);
    expect(first.files.map((g) => g.path)).toEqual(["src/my dir/space file.ts"]);
    expect(first.next_call).toBeDefined();
    // The cursor is opaque — the spaced path rides INSIDE the token, so no
    // whitespace-splitting consumer can corrupt it (v1's `after=src/my dir/…`
    // string was unexecutable verbatim).
    const pos = decodeReferencesCursor(first.next_call!.arguments["cursor"] as string);
    expect(pos).toEqual({ p: "src/my dir/space file.ts", l: 1 });

    const second = await findReferences(nextCallInput(first.next_call!), ws);
    expect(servedLineKeys(second)).toEqual(["src/my dir/space file.ts#2"]);
    const third = await findReferences(nextCallInput(second.next_call!), ws);
    expect(servedLineKeys(third)).toEqual(["src/zz.ts#1"]);
    expect(third.next_call).toBeUndefined();
  });

  it("(b) limit binds before the byte fit: reason names match-cap, `total` stays the true count, and the peek honors the limit", async () => {
    const ws = mkWorkspace();
    for (let i = 0; i < 5; i++) {
      writeFile(ws, `src/f${i}.ts`, `capped(${i});\n`);
    }

    const result = await findReferences({ symbol: "capped", limit: 3 }, ws);

    expect(result.total).toBe(5);            // the walk is exhaustive regardless
    expect(result.files).toHaveLength(3);    // only what the caller asked to be served
    expect(result.truncated).toBe(true);
    expect(result.truncation_reason).toContain("match-cap");
    // E3: the flat peek is bounded by the caller's own limit, not just by
    // REFERENCES_PEEK_CAP — a limit:3 reply used to list 10 flat references
    // beside its 3 file groups, contradicting its own contract.
    expect(result.references.length).toBeLessThanOrEqual(3);
    expect(result.references.map((r) => r.path)).toEqual(["src/f0.ts", "src/f1.ts", "src/f2.ts"]);

    // L4: `limit` withheld 2 groups, so the caller is still offered a way to
    // them (pre-L3 this was a dead end: no files_omitted, no next_call).
    expect(result.files_omitted).toBe(2);
    const args = nextCallInput(result.next_call!);
    expect(decodeReferencesCursor(args.cursor!)).toEqual({ p: "src/f2.ts", l: 1 });
    expect(args.limit).toBe(3);
    const rest = await findReferences(args, ws);
    expect(rest.files.map((g) => g.path)).toEqual(["src/f3.ts", "src/f4.ts"]);
    expect(rest.next_call).toBeUndefined();
  });

  it("E3: limit:1 bounds the peek to one entry; an unset limit still peeks up to 10", async () => {
    const ws = mkWorkspace();
    for (let i = 0; i < 12; i++) writeFile(ws, `src/f${i}.ts`, `peekTarget(${i});\n`);

    const one = await findReferences({ symbol: "peekTarget", limit: 1 }, ws);
    expect(one.references).toHaveLength(1);
    expect(one.files).toHaveLength(1);
    expect(one.total).toBe(12);

    // Unset limit → effectiveLimit 200 → the peek stays at REFERENCES_PEEK_CAP
    // (10), the pre-E3 behaviour locateTaskContext.ts's .slice(0, 5) relies on.
    const unset = await findReferences({ symbol: "peekTarget" }, ws);
    expect(unset.references).toHaveLength(10);

    // A limit above the peek cap leaves the peek at the cap, not the limit.
    const wide = await findReferences({ symbol: "peekTarget", limit: 50 }, ws);
    expect(wide.references).toHaveLength(10);
  });

  it("clamps limit into [1, MAX_REFERENCES]; an omitted limit keeps the 200 default", async () => {
    const ws = mkWorkspace();
    for (let i = 0; i < 4; i++) writeFile(ws, `src/f${i}.ts`, `clampTarget(${i});\n`);

    const zero = await findReferences({ symbol: "clampTarget", limit: 0 }, ws);
    expect(zero.files).toHaveLength(1);      // floor(0) -> clamped up to 1
    expect(zero.total).toBe(4);
    expect(zero.truncation_reason).toBe("match-cap");

    const unset = await findReferences({ symbol: "clampTarget" }, ws);
    expect(unset.files).toHaveLength(4);
    expect(unset.truncated).toBe(false);
    expect(unset.truncation_reason).toBeUndefined();
  });
});

describe("findReferences — L2 absence certificate", () => {
  it("(c) zero matches on a real scan return an absence certificate, not a bare empty shape", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "export const x = 1;\n");
    writeFile(ws, "src/b.ts", "export const y = 2;\n");

    const result = await findReferences({ symbol: "zzqx_no_such_token_zzqx" }, ws);

    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.truncation_reason).toBeUndefined();
    expect(result.absence?.scanned_files).toBeGreaterThan(0);
    expect(result.absence?.symbol).toBe("zzqx_no_such_token_zzqx");
    expect(result.absence?.conclusion).toContain("no scanned file");
    expect(result.absence?.caveat).toBeUndefined();
  });

  it("names the scope in the conclusion when the caller narrowed with path", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "export const x = 1;\n");
    writeFile(ws, "lib/b.ts", "export const y = 2;\n");

    const result = await findReferences({ symbol: "absentUnderScope", path: "src" }, ws);

    expect(result.total).toBe(0);
    expect(result.absence?.conclusion).toContain("under 'src'");
  });

  it("refuses to certify an absence it did not earn — an invalid identifier scans nothing", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "export const x = 1;\n");

    const result = await findReferences({ symbol: "not-an-identifier" }, ws);

    expect(result.total).toBe(0);
    expect(result.absence).toBeUndefined();
  });
});

describe("findReferences — L2 generated provenance", () => {
  it("(d) marks build-output groups generated:true, leaves source unmarked, and excludes neither", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/app.ts", "provenanceTarget();\n");
    writeFile(ws, "packages/web/dist/bundle.ts", "provenanceTarget();\n");
    writeFile(ws, "packages/web/out/page.ts", "provenanceTarget();\n");

    const result = await findReferences({ symbol: "provenanceTarget" }, ws);

    const byPath = new Map(result.files.map((g) => [g.path, g]));
    // Full recall is unchanged: build output is still RETURNED, only labelled.
    expect(result.total).toBe(3);
    expect(byPath.get("packages/web/dist/bundle.ts")?.generated).toBe(true);
    expect(byPath.get("packages/web/out/page.ts")?.generated).toBe(true);
    expect(byPath.get("src/app.ts")?.generated).toBeUndefined();
  });

  it("a file whose BASENAME merely looks like a build dir is source, not generated", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/out.ts", "basenameTarget();\n");

    const result = await findReferences({ symbol: "basenameTarget" }, ws);

    expect(result.files[0]?.path).toBe("src/out.ts");
    expect(result.files[0]?.generated).toBeUndefined();
  });
});

describe("findReferences — L2 no-regression on the un-truncated path", () => {
  it("(e) a path-scoped search that fits carries none of the new fields", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "scopedTarget(1);\nscopedTarget(2);\n");
    writeFile(ws, "src/b.ts", "scopedTarget(3);\n");
    writeFile(ws, "lib/c.ts", "scopedTarget(4);\n");

    const result = await findReferences({ symbol: "scopedTarget", path: "src" }, ws);

    expect(result.total).toBe(3);
    expect(result.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.truncated).toBe(false);
    expect(result.truncation_reason).toBeUndefined();
    expect(result.files_omitted).toBeUndefined();
    expect(result.next_call).toBeUndefined();
    expect(result.absence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ND-2 (2026-08-08 references-cursor recall) — THE PAGE AND ITS CURSOR MUST
// DESCRIBE THE SAME SET.
//
// Measured defect: the flat `references[]` list was built from `servedRefs` —
// the PRE-byte-fit slice — and capped at REFERENCES_PEEK_CAP independently of
// the page's actually-emitted `files[]`, while the resume cursor was derived
// (correctly) from the POST-fit `files[]`. The two lists therefore disagreed
// in BOTH directions, and nothing on the wire disclosed it:
//
//   - peek SHORTER than the page (10 < 16 emitted): every boundary silently
//     skipped the references between the peek's last entry and the cursor, and
//     the terminal page's honest `truncated:false` then certified the short
//     union as complete. Live, on a 13-file/122-reference C++ fixture:
//     80 of 122 distinct references (34% loss), 3-6 skipped per boundary,
//     definition site src/mod/util.cpp:4 dropped while the declaration in
//     include/ctl/util.hpp survived, page 1's list ending at
//     src/mod/stage00.cpp:15 while its cursor already read stage01.cpp:11.
//   - peek LONGER than the page (10 > 2 emitted, long-path fixtures): the peek
//     named references the page never emitted, which the NEXT page then served
//     again — phantom entries and duplicates for the same consumer.
//
// Enforced invariant, for every page P of a verbatim cursor chain:
//   (a) emitted(P) = union of P.files[].lines is exactly the maximal
//       (path,line)-ordered run of the match stream starting immediately after
//       the previous page's cursor;
//   (b) P.references is a PREFIX of emitted(P) — never a reference P did not
//       emit, never past the cursor — and P.references_omitted is exactly
//       |emitted(P)| - |P.references|, present exactly when > 0;
//   (c) P.next_call's cursor decodes to last(emitted(P)) — "immediately after
//       the last reference actually emitted", after any byte-budget trim;
//   (d) therefore the union over the chain is the FULL reference set, each
//       exactly once, and a page with no next_call truly owes nothing.
// ---------------------------------------------------------------------------

/** ND-2: the (path,line) keys this page actually EMITTED (post byte-fit). */
function emittedKeys(page: FindReferencesResult): string[] {
  return page.files.flatMap((g) => g.lines.map((l) => `${g.path}#${l}`));
}

/** ND-2: the (path,line) keys this page listed on the flat `references[]`. */
function peekKeys(page: FindReferencesResult): string[] {
  return page.references.map((r) => `${r.path}#${r.line}`);
}

/**
 * ND-2 fixture — a compact in-spec stand-in for the live C++ workspace:
 * a declaration that sorts FIRST, eight call-site files, and the DEFINITION in
 * `src/mod/util.cpp` which sorts LAST (so it survives only if the chain truly
 * exhausts). 1 + 8*10 + 1 = 82 references over 10 files: enough to force well
 * more than three byte-budget pages at MAX_RESPONSE_BYTES.
 */
function mkNd2Workspace(): { ws: string; truth: string[]; definition: string } {
  const ws = mkWorkspace();
  const truth: string[] = [];

  writeFile(ws, "include/ctl/util.hpp", [
    "#pragma once",
    "#include <ctl/types.hpp>",
    "namespace democtl {",
    "namespace control {",
    "f32 clampMotor(f32 raw);",
    "}  // namespace control",
    "}  // namespace democtl",
  ].join("\n") + "\n");
  truth.push("include/ctl/util.hpp#5");

  for (let f = 0; f < 8; f++) {
    const id = String(f).padStart(2, "0");
    const lines = [
      "#include <ctl/util.hpp>",
      "",
      "namespace democtl {",
      "namespace control {",
      "",
      `void stageApply${id}(f32* m, int n) {`,
    ];
    for (let i = 0; i < 10; i++) {
      lines.push(`    m[${i}] = clampMotor(m[${i}] * 1.0${i}f);  // site ${id}-0${i}`);
      truth.push(`src/mod/stage${id}.cpp#${lines.length}`);
    }
    lines.push("}", "", "}  // namespace control", "}  // namespace democtl");
    writeFile(ws, `src/mod/stage${id}.cpp`, lines.join("\n") + "\n");
  }

  writeFile(ws, "src/mod/util.cpp", [
    "#include <ctl/util.hpp>",
    "namespace democtl {",
    "namespace control {",
    "f32 clampMotor(f32 raw) {",
    "    return raw < 0.0f ? 0.0f : raw;",
    "}",
    "}  // namespace control",
    "}  // namespace democtl",
  ].join("\n") + "\n");
  truth.push("src/mod/util.cpp#4");

  return { ws, truth, definition: "src/mod/util.cpp#4" };
}

describe("findReferences — ND-2 page/cursor agreement", () => {
  it("(nd2-a) verbatim exhaustion serves EVERY reference exactly once, contiguously, keeping the definition site (live pre-fix: 80/122 via the peek)", async () => {
    const { ws, truth, definition } = mkNd2Workspace();

    const pages: FindReferencesResult[] = [];
    let page = await findReferences({ symbol: "clampMotor" }, ws);
    for (let calls = 1; ; calls++) {
      pages.push(page);
      expect(calls, "the continuation must terminate").toBeLessThan(120);
      if (page.next_call === undefined) break;
      page = await findReferences(nextCallInput(page.next_call), ws);
    }
    expect(pages.length, "fixture must force >= 3 byte-budget pages").toBeGreaterThanOrEqual(3);
    for (const p of pages.slice(0, -1)) expect(p.truncation_reason).toBe("bytes");

    // (a) set equality + count: every reference, exactly once.
    const emitted = pages.flatMap(emittedKeys);
    expect(emitted.length, "no reference is ever served twice").toBe(new Set(emitted).size);
    expect([...emitted].sort()).toEqual([...truth].sort());
    expect(emitted.length).toBe(82);

    // (b) contiguity: page N+1 opens on the reference right after page N's last.
    for (let i = 0; i + 1 < pages.length; i++) {
      const prev = emittedKeys(pages[i]!);
      const next = emittedKeys(pages[i + 1]!);
      const at = truth.indexOf(prev[prev.length - 1]!);
      expect(at, "page boundary must land inside the true ordering").toBeGreaterThanOrEqual(0);
      expect(next[0], `page ${i + 2} skipped a reference at the boundary`).toBe(truth[at + 1]);
    }
    // ...and the chain is the truth in order, not merely the same set.
    expect(emitted).toEqual(truth);

    // (c) the definition site survives — it sorts LAST, so a chain that
    // over-advances anywhere loses it (it was among the live casualties).
    expect(emitted).toContain(definition);

    // (d) the terminal page's exhaustion claim is TRUE, not merely asserted.
    const last = pages[pages.length - 1]!;
    expect(last.next_call).toBeUndefined();
    expect(last.files_omitted).toBeUndefined();
    expect(last.truncated).toBe(false);
    expect(last.total).toBe(82);
  });

  it("(nd2-b) the flat `references[]` never disagrees with the page it rides on: prefix of emitted, shortfall disclosed", async () => {
    const { ws } = mkNd2Workspace();

    let page = await findReferences({ symbol: "clampMotor" }, ws);
    let sawShortPeek = false;
    for (let calls = 1; ; calls++) {
      const emitted = emittedKeys(page);
      const peek = peekKeys(page);

      // No phantom entries: the peek can only name references THIS page served.
      expect(peek, "peek must be a prefix of the page's emitted set")
        .toEqual(emitted.slice(0, peek.length));

      // No silent partial: what the peek withholds is stated, exactly.
      const omitted = page.references_omitted ?? 0;
      expect(peek.length + omitted, "peek + references_omitted must account for the whole page")
        .toBe(emitted.length);
      if (emitted.length > peek.length) {
        sawShortPeek = true;
        expect(page.references_omitted, "a short peek must disclose its shortfall").toBe(emitted.length - peek.length);
      } else {
        expect(page.references_omitted, "a complete peek discloses nothing").toBeUndefined();
      }

      // The peek never runs past the resume point.
      if (page.next_call !== undefined) {
        const pos = decodeReferencesCursor(page.next_call.arguments["cursor"] as string)!;
        expect(`${pos.p}#${pos.l}`, "cursor is the LAST EMITTED reference, post-trim")
          .toBe(emitted[emitted.length - 1]);
        expect(peek[peek.length - 1], "peek's last entry cannot sit after the cursor")
          .toBe(emitted[Math.min(peek.length, emitted.length) - 1]);
      }

      expect(calls).toBeLessThan(120);
      if (page.next_call === undefined) break;
      page = await findReferences(nextCallInput(page.next_call), ws);
    }
    expect(sawShortPeek, "fixture must actually exercise a peek shorter than its page").toBe(true);
  });

  it("(nd2-c) long paths: the byte fit seats a couple of groups and the peek no longer names files the page dropped", async () => {
    const ws = mkWorkspace();
    // Long paths make each peek entry expensive and each group cheap-ish, so
    // the fit seats FEWER references than REFERENCES_PEEK_CAP — the shape
    // where the pre-fit peek used to overrun its own page.
    for (let i = 0; i < 12; i++) {
      writeFile(ws, `src/deep${i}/${"seg/".repeat(8)}mod${String(i).padStart(2, "0")}${"z".repeat(40)}.ts`,
        "  overrunTarget(1);\n");
    }

    const seen: string[] = [];
    let page = await findReferences({ symbol: "overrunTarget" }, ws);
    let sawOverrunShape = false;
    for (let calls = 1; ; calls++) {
      const emitted = emittedKeys(page);
      const peek = peekKeys(page);
      if (emitted.length < 10) sawOverrunShape = true;
      // Pre-fix this held up to 8 phantom entries per page, every one of them
      // re-served by a later page.
      for (const k of peek) expect(emitted, "peek named a reference the page did not emit").toContain(k);
      for (const k of emitted) expect(seen, "a reference was served twice").not.toContain(k);
      seen.push(...emitted);
      expect(calls).toBeLessThan(60);
      if (page.next_call === undefined) break;
      page = await findReferences(nextCallInput(page.next_call), ws);
    }
    expect(sawOverrunShape, "fixture must seat fewer refs than the peek cap").toBe(true);
    expect(new Set(seen).size, "every long-path reference arrives exactly once").toBe(12);
  });

  it("(nd2-d) the cursor stays opaque and server-issued — a hand-built token is still refused and disclosed", async () => {
    const { ws } = mkNd2Workspace();

    const first = await findReferences({ symbol: "clampMotor" }, ws);
    const token = first.next_call!.arguments["cursor"] as string;
    // Opaque: base64url only — no path bytes, no separators a consumer could
    // parse or forge by hand (the v2 wire contract, unchanged by ND-2).
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("/");
    expect(token).not.toContain("src");
    expect(decodeReferencesCursor(token)).toBeDefined();

    // A hand-built (non-server) token is ignored WITH disclosure, and the page
    // is served from the START — never a silently guessed window.
    const forged = await findReferences({ symbol: "clampMotor", cursor: "src/mod/stage04.cpp:12" }, ws);
    expect(forged.cursor_note).toContain("invalid cursor");
    expect(emittedKeys(forged)[0]).toBe("include/ctl/util.hpp#5");
    expect(forged.total).toBe(82);
  });
});
