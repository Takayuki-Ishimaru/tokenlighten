/**
 * dispatchGuardConformance.spec.ts — belt to the compiler's suspenders.
 *
 * write/guardedWorkspace.ts makes an unguarded write-capable dispatch case a
 * TYPE error. That closes the ordinary way to ship one, but a brand is a
 * compile-time construct: `as GuardedWorkspaceRoot`, an `any`-typed helper, or
 * a brand-new write path that never touches the branded entry points would all
 * slip past it.
 *
 * So this spec goes at the problem from the other side. It reads server.ts,
 * enumerates the REAL `dispatchTool` cases from source, and forces every one of
 * them to be classified here as read-only or write-capable. A case that appears
 * without a classification fails loudly and by name — the list cannot rot into
 * a stale allowlist that quietly stops covering the thing it was written for.
 *
 * What it pins, in order of what the 2026-08-09 incident actually needed:
 *   1. the case inventory matches ALL_TOOLS (nothing dispatchable is unlisted,
 *      nothing listed is undispatchable);
 *   2. every case — read or write — runs the cwd guard, before it resolves a
 *      workspace root;
 *   3. every WRITE case additionally runs the routing/boundary guard and takes
 *      its root from resolveGuardedWorkspaceRoot, never the unbranded resolver;
 *   4. no case classified read-only reaches a write-capable entry point;
 *   5. the write entry points still DECLARE the brand (nobody widened a
 *      signature back to `string`);
 *   6. the tests-only mint is not referenced from production code.
 *
 * Source parsing, not reflection: `dispatchTool` is a switch, so its cases have
 * no runtime representation to reflect over. The parse keys on the file's own
 * formatting (a top-level case label is indented exactly four spaces), and the
 * ALL_TOOLS cross-check in (1) is what catches a case the parse missed.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const SERVER_TS = path.join(SRC, "server.ts");

const serverSource = fs.readFileSync(SERVER_TS, "utf8");

// ---------------------------------------------------------------------------
// The classification. THIS is the list a new case must join.
// ---------------------------------------------------------------------------

/**
 * Every canonical tool name `dispatchTool` handles, and whether that case can
 * put bytes on disk.
 *
 * "write" means the case can reach a write-capable entry point
 * (WRITE_ENTRY_POINTS below) on some argument shape — not that every call
 * writes. edit_file's read-ish sub-dispatches still count: they share the one
 * guard preamble, which is exactly why the preamble has to be complete.
 */
const CASE_CLASSIFICATION: Readonly<Record<string, "read" | "write">> = {
  read_file: "read",
  edit_file: "write",
  search_files: "read",
  // D11: the 9 deprecated-alias cases that used to be listed here
  // (get_file_skeleton, get_symbol_with_context, extract_office_text,
  // search_replace_edit, apply_edits_multi, search_symbols, get_current_diff,
  // create_file, read_and_edit) are DELETED from dispatchTool. The three above
  // are the whole switch — dispatchable and advertised are now the same set.
};

/**
 * D11: `CANON` is DELETED. There is no rewrite table left, so the alias->
 * canonical fold this spec used to assert cannot exist — and its ABSENCE is
 * what gets asserted below, because a re-introduced table would silently
 * re-open the accepted-but-unadvertised name class D2 exists to close.
 */
const EXPECTED_CANON: Readonly<Record<string, string>> = {};

/**
 * Functions that can write, keyed by the module that owns them. Each must take
 * the guard brand; each must be unreachable from a read-classified case.
 */
const WRITE_ENTRY_POINTS: ReadonlyArray<{ file: string; fn: string }> = [
  { file: "tools/createFile.ts", fn: "createFile" },
  { file: "tools/applyEditsMulti.ts", fn: "applyEditsMulti" },
  { file: "tools/searchReplaceEdit.ts", fn: "searchReplaceEdit" },
  { file: "tools/readAndEdit.ts", fn: "readAndEdit" },
  { file: "tools/renameSymbol.ts", fn: "renameSymbol" },
  { file: "write/artifactEdit.ts", fn: "editArtifact" },
  { file: "write/pathlessEdit.ts", fn: "pathlessExactEdit" },
  { file: "write/pathlessEdit.ts", fn: "pathlessSymbolEdit" },
  { file: "intents/index.ts", fn: "applyIntent" },
  { file: "intents/removeDuplicateBranch.ts", fn: "applyRemoveDuplicateBranch" },
  { file: "intents/appendUnionMember.ts", fn: "applyAppendUnionMember" },
  { file: "intents/appendEnumMember.ts", fn: "applyAppendEnumMember" },
  { file: "intents/renameSymbolReferences.ts", fn: "applyRenameSymbolReferences" },
  { file: "util/safePath.ts", fn: "safeResolveForWrite" },
];

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

interface DispatchCase {
  name: string;
  body: string;
}

/** The `dispatchTool` function body, from its signature to its closing brace. */
function dispatchToolSource(): string {
  const start = serverSource.indexOf("async function dispatchTool(");
  expect(start, "dispatchTool not found in server.ts — did it move or get renamed?").toBeGreaterThan(-1);
  // The function is declared at column 0, so the next line that is exactly "}"
  // closes it.
  const rest = serverSource.slice(start);
  const end = rest.indexOf("\n}\n");
  expect(end, "could not find the end of dispatchTool").toBeGreaterThan(-1);
  return rest.slice(0, end);
}

/**
 * Top-level `case "<name>": {` labels inside dispatchTool's switch, with the
 * source of each case up to the next label (or `default:`). A top-level label
 * is indented exactly four spaces; anything deeper belongs to an inner switch.
 */
function parseDispatchCases(): DispatchCase[] {
  const source = dispatchToolSource();
  const label = /^ {4}case "([a-z_]+)":/gm;
  const marks: Array<{ name: string; at: number }> = [];
  for (let m = label.exec(source); m !== null; m = label.exec(source)) {
    marks.push({ name: m[1]!, at: m.index });
  }
  const defaultAt = source.search(/^ {4}default:/m);
  return marks.map((mark, i) => ({
    name: mark.name,
    body: source.slice(mark.at, marks[i + 1]?.at ?? (defaultAt > -1 ? defaultAt : source.length)),
  }));
}

/** Every tool name ALL_TOOLS advertises or keeps dispatchable. */
function allToolNames(): string[] {
  const start = serverSource.indexOf("const ALL_TOOLS: ToolEntry[] = [");
  expect(start, "ALL_TOOLS not found in server.ts").toBeGreaterThan(-1);
  const end = serverSource.indexOf("\n];", start);
  expect(end, "could not find the end of ALL_TOOLS").toBeGreaterThan(-1);
  const block = serverSource.slice(start, end);
  const names = new Set<string>();
  const nameRe = /\bname: "([a-z_]+)"/g;
  for (let m = nameRe.exec(block); m !== null; m = nameRe.exec(block)) names.add(m[1]!);
  return [...names].sort();
}

const CASES = parseDispatchCases();
const CASE_NAMES = CASES.map((c) => c.name).sort();

function caseBody(name: string): string {
  const found = CASES.find((c) => c.name === name);
  expect(found, `no dispatch case named "${name}"`).toBeDefined();
  return found!.body;
}

/** Index of the first match, or -1. Used for "guard ran BEFORE resolve" order. */
function firstIndexOf(body: string, pattern: RegExp): number {
  const m = pattern.exec(body);
  return m === null ? -1 : m.index;
}

const CWD_GUARD = /\bguardCwd\s*\(/;
const ROUTING_GUARD = /\bguardWriteRouting\s*\(/;
const GUARDED_RESOLVE = /\bresolveGuardedWorkspaceRoot\s*\(/;
const UNBRANDED_RESOLVE = /\bresolveWorkspaceRoot\s*\(/;
const RAW_CWD_CHECK = /\bcheckCwdOrRefuse\s*\(/;
const RAW_ROUTING_CHECK = /\bworkspaceRoutingRefusal\s*\(/;

// ---------------------------------------------------------------------------
// 1. Inventory — a new case cannot appear unclassified
// ---------------------------------------------------------------------------

describe("dispatch guard conformance — case inventory", () => {
  it("parses exactly the three advertised cases (the parse itself must not silently break)", () => {
    // Before D11 this read `toBeGreaterThan(5)` because 12 aliases shared the
    // switch. The switch is now the three advertised tools and nothing else,
    // so the parser's non-vacuity check is an exact count: 0 or 1 means the
    // source-format assumption in parseDispatchCases() broke (fix the parser,
    // do not delete this spec), and 4+ means a case was added without a
    // classification, which the next test names.
    expect(
      CASE_NAMES,
      "dispatchTool's top-level cases are no longer exactly the three advertised tools",
    ).toEqual(["edit_file", "read_file", "search_files"]);
  });

  it("classifies EVERY dispatch case — an unclassified case fails by name", () => {
    const classified = Object.keys(CASE_CLASSIFICATION).sort();
    const unclassified = CASE_NAMES.filter((n) => !(n in CASE_CLASSIFICATION));
    const stale = classified.filter((n) => !CASE_NAMES.includes(n));

    expect(
      unclassified,
      `NEW dispatchTool case(s) with no guard classification: ${unclassified.join(", ")}. `
        + "Add each to CASE_CLASSIFICATION in this spec as \"read\" or \"write\" — a write-capable case must run guardCwd + guardWriteRouting and take its root from resolveGuardedWorkspaceRoot.",
    ).toEqual([]);
    expect(
      stale,
      `CASE_CLASSIFICATION names case(s) dispatchTool no longer has: ${stale.join(", ")}. Remove them so this list keeps meaning something.`,
    ).toEqual([]);
  });

  it("matches ALL_TOOLS: everything dispatchable is listed, everything listed is dispatchable", () => {
    // D11: the pre-switch rewrite table is asserted ABSENT. While it existed, a
    // fourth renamed alias could map onto a case this spec never checked; now
    // the only way a name reaches a case is by being that case's own label.
    expect(
      serverSource,
      "server.ts declares a CANON rewrite table again — that re-opens the accepted-but-unadvertised name class D2/D11 closed; delete it or re-teach this spec deliberately",
    ).not.toContain("const CANON: Record<string, string> = {");
    expect(Object.keys(EXPECTED_CANON)).toEqual([]);

    const canonicalNames = new Set(
      allToolNames().map((n) => EXPECTED_CANON[n] ?? n),
    );
    expect([...canonicalNames].sort()).toEqual(CASE_NAMES);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Every case runs the guard; write cases run the whole stack
// ---------------------------------------------------------------------------

describe("dispatch guard conformance — every case runs the cwd guard", () => {
  for (const name of Object.keys(CASE_CLASSIFICATION)) {
    it(`${name}: calls guardCwd before it resolves a workspace root`, () => {
      const body = caseBody(name);
      const guardAt = firstIndexOf(body, CWD_GUARD);
      expect(
        guardAt,
        `case "${name}" never calls guardCwd — an invalid or never-declared cwd would silently resolve against the server's pinned root (the 2026-08-09 alias drift, verbatim)`,
      ).toBeGreaterThan(-1);

      const resolveAt = Math.min(
        ...[firstIndexOf(body, GUARDED_RESOLVE), firstIndexOf(body, UNBRANDED_RESOLVE)]
          .filter((i) => i > -1)
          .concat([Number.MAX_SAFE_INTEGER]),
      );
      if (resolveAt !== Number.MAX_SAFE_INTEGER) {
        expect(
          guardAt,
          `case "${name}" resolves a workspace root before running guardCwd`,
        ).toBeLessThan(resolveAt);
      }
    });

    it(`${name}: does not call the raw guards directly (one way in, so the stages cannot be skipped)`, () => {
      const body = caseBody(name);
      expect(
        RAW_CWD_CHECK.test(body),
        `case "${name}" calls checkCwdOrRefuse directly instead of guardCwd — that bypasses the pass token the later stages require`,
      ).toBe(false);
      expect(
        RAW_ROUTING_CHECK.test(body),
        `case "${name}" calls workspaceRoutingRefusal directly instead of guardWriteRouting`,
      ).toBe(false);
    });
  }
});

describe("dispatch guard conformance — write-capable cases run the whole stack", () => {
  const writeCases = Object.entries(CASE_CLASSIFICATION)
    .filter(([, kind]) => kind === "write")
    .map(([name]) => name);

  it("there is at least one write case (a vacuous suite proves nothing)", () => {
    expect(writeCases.length).toBeGreaterThan(0);
  });

  for (const name of writeCases) {
    it(`${name}: runs guardWriteRouting and takes its root from resolveGuardedWorkspaceRoot`, () => {
      const body = caseBody(name);
      expect(
        ROUTING_GUARD.test(body),
        `write case "${name}" never runs the routing/boundary guard — a write whose workspace nobody declared, or one crossing into a nested worktree, would go through unnoticed`,
      ).toBe(true);
      expect(
        GUARDED_RESOLVE.test(body),
        `write case "${name}" does not obtain a GuardedWorkspaceRoot — how is it reaching a write entry point?`,
      ).toBe(true);
      expect(
        UNBRANDED_RESOLVE.test(body),
        `write case "${name}" calls the UNBRANDED resolveWorkspaceRoot; a write path must resolve through resolveGuardedWorkspaceRoot so the guard stack is proven`,
      ).toBe(false);
    });

    it(`${name}: the routing guard runs before the root is resolved`, () => {
      const body = caseBody(name);
      expect(firstIndexOf(body, ROUTING_GUARD)).toBeLessThan(firstIndexOf(body, GUARDED_RESOLVE));
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Read-classified cases stay read-only
// ---------------------------------------------------------------------------

describe("dispatch guard conformance — read cases reach no write entry point", () => {
  const readCases = Object.entries(CASE_CLASSIFICATION)
    .filter(([, kind]) => kind === "read")
    .map(([name]) => name);
  const writeFns = [...new Set(WRITE_ENTRY_POINTS.map((e) => e.fn))];

  for (const name of readCases) {
    it(`${name}: calls none of ${writeFns.length} write entry points`, () => {
      const body = caseBody(name);
      const reached = writeFns.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(body));
      expect(
        reached,
        `case "${name}" is classified read-only but reaches ${reached.join(", ")}. Either it is not read-only — reclassify it as "write" and give it the full guard stack — or the call does not belong there.`,
      ).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// 5 + 6. The brand itself cannot be quietly removed or forged
// ---------------------------------------------------------------------------

describe("dispatch guard conformance — the brand stays required", () => {
  for (const { file, fn } of WRITE_ENTRY_POINTS) {
    it(`${file} :: ${fn}() still requires GuardedWorkspaceRoot`, () => {
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      const declRe = new RegExp(`export (?:async )?function ${fn}\\s*\\(`);
      const at = firstIndexOf(source, declRe);
      expect(at, `${fn} is no longer exported from ${file}`).toBeGreaterThan(-1);
      // Parameter list: from the opening paren to the first "):" that closes it.
      const fromDecl = source.slice(at);
      const params = fromDecl.slice(0, fromDecl.indexOf("):"));
      expect(
        params,
        `${fn}() in ${file} no longer takes a GuardedWorkspaceRoot. Widening it back to \`string\` re-opens the class this whole mechanism exists to close.`,
      ).toContain("GuardedWorkspaceRoot");
    });
  }

  it("the tests-only mint is never referenced from production source", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(abs);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        // The definition itself lives in guardedWorkspace.ts, by construction.
        if (abs.endsWith(path.join("write", "guardedWorkspace.ts"))) continue;
        if (fs.readFileSync(abs, "utf8").includes("unsafeGuardedWorkspaceRootForTests")) {
          offenders.push(path.relative(SRC, abs));
        }
      }
    };
    walk(SRC);
    expect(
      offenders,
      `production source references the tests-only guarded-root mint: ${offenders.join(", ")}. That function exists so unit tests can drive a write tool with no dispatch; using it in production forges the guard proof.`,
    ).toEqual([]);
  });

  it("resolveGuardedWorkspaceRoot is the only production site of the brand", () => {
    const guarded = fs.readFileSync(path.join(SRC, "write/guardedWorkspace.ts"), "utf8");
    // Casts to the brand are the one bypass a type system cannot prevent, so
    // count them (in code, not prose): exactly three are legitimate, all inside
    // this module — resolveGuardedWorkspaceRoot's mint, adoptGuardedWorkspaceRoot's
    // re-brand, and the tests-only escape hatch.
    const code = guarded
      .split("\n")
      .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
      .join("\n");
    const casts = code.match(/as GuardedWorkspaceRoot/g) ?? [];
    expect(
      casts.length,
      "guardedWorkspace.ts has gained (or lost) a brand cast. Three are expected: resolveGuardedWorkspaceRoot, adoptGuardedWorkspaceRoot, unsafeGuardedWorkspaceRootForTests. A fourth is a new way to assert the guard ran without running it — justify it here deliberately.",
    ).toBe(3);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(abs);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (abs.endsWith(path.join("write", "guardedWorkspace.ts"))) continue;
        if (/as (?:unknown as )?GuardedWorkspaceRoot/.test(fs.readFileSync(abs, "utf8"))) {
          offenders.push(path.relative(SRC, abs));
        }
      }
    };
    walk(SRC);
    expect(
      offenders,
      `these files cast a plain string to GuardedWorkspaceRoot: ${offenders.join(", ")}. A cast asserts the guard ran without running it — route through guardCwd/guardWriteRouting/resolveGuardedWorkspaceRoot (or adoptGuardedWorkspaceRoot for a handle-adopted root) instead.`,
    ).toEqual([]);
  });
});
