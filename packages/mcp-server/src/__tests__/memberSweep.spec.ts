// memberSweep.spec.ts — L1: member-usage sweep affordance on type/class
// references (search_files action=references / action=find on a single
// identifier).
//
// Evidence (2026-07-30 bench T11, repo-rename alignment task): a live A/B
// cell paid 7 of its 17 TL calls on serial single-token find guessing to
// discover a class's member names one grep at a time. See
// packages/mcp-server/src/features/search/find/memberSweep.ts for the
// implementation and its own doc comment for the exact evidence + the known
// collectSymbols-linkage limitations (Go receiver methods, Rust `impl`
// blocks, bare TS/JS `interface` method signatures without a body — all
// verified empirically while building this feature).
//
// Coverage:
//   - computeMemberSweep (pure): unambiguous class -> attachment shape,
//     public/exported-looking members first, ambiguous definition -> abstain,
//     non-identifier symbol -> abstain, byte-budget (<=600B) respected via
//     members[] trimming, MAX_MEMBERS=12 cap.
//   - findReferences() integration: class + members + call sites across
//     files -> response carries member_sweep with a valid batched `next`;
//     non-type symbol -> no attachment; single-member class -> no attachment.
//   - action=find path: maybeAttachMemberSweepToFindResponse layered onto a
//     buildFindResponse() result; regex queries and empty/absence responses
//     are skipped.

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findReferences } from "../tools/findReferences.js";
import { buildFindResponse } from "../features/search/find/findText.js";
import {
  computeMemberSweep,
  isIdentifierToken,
  maybeAttachMemberSweepToFindResponse,
  MEMBER_SWEEP_HINT_TEXT,
  MEMBER_SWEEP_MAX_BYTES,
  type MemberSweepCandidate,
} from "../features/search/find/memberSweep.js";

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-membersweep-test-"));
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

// ---------------------------------------------------------------------------
// computeMemberSweep — pure function, in-memory candidates
// ---------------------------------------------------------------------------

describe("computeMemberSweep — resolution and shape", () => {
  it("returns a member_sweep attachment for an unambiguous class, public members before private-looking ones", async () => {
    const candidates: MemberSweepCandidate[] = [{
      path: "src/UserRepository.ts",
      language: "typescript",
      content: [
        "export class UserRepository {",
        "  constructor(private db: unknown) {}",
        "  _validateInternal(u: unknown) {",
        "    return !!u;",
        "  }",
        "  getUser(id: string) {",
        "    return this.db;",
        "  }",
        "  saveUser(u: unknown) {",
        "    return u;",
        "  }",
        "}",
      ].join("\n"),
    }];

    const sweep = await computeMemberSweep("UserRepository", candidates);

    expect(sweep).toBeDefined();
    expect(sweep?.symbol).toBe("UserRepository");
    // Declaration order is constructor, _validateInternal, getUser, saveUser
    // — the private-looking (leading underscore) member must be pushed
    // after every public-looking one, not left in source order.
    expect(sweep?.members).toEqual(["constructor", "getUser", "saveUser", "_validateInternal"]);
    expect(sweep?.next).toBe(
      'search_files action=find queries=["constructor","getUser","saveUser","_validateInternal"]',
    );
  });

  it("abstains when the definition appears in MORE THAN ONE file (ambiguous)", async () => {
    const candidates: MemberSweepCandidate[] = [
      {
        path: "src/ShapeA.ts",
        language: "typescript",
        content: "export class Shape {\n  area() { return 1; }\n  perimeter() { return 2; }\n}\n",
      },
      {
        path: "src/ShapeB.ts",
        language: "typescript",
        content: "export class Shape {\n  volume() { return 3; }\n  scale() { return 4; }\n}\n",
      },
    ];

    const sweep = await computeMemberSweep("Shape", candidates);
    expect(sweep).toBeUndefined();
  });

  it("abstains when the resolved definition has fewer than 2 members", async () => {
    const candidates: MemberSweepCandidate[] = [{
      path: "src/Single.ts",
      language: "typescript",
      content: "export class Single {\n  onlyMethod() { return 1; }\n}\n",
    }];

    const sweep = await computeMemberSweep("Single", candidates);
    expect(sweep).toBeUndefined();
  });

  it("abstains when no candidate defines the symbol as a class/interface", async () => {
    const candidates: MemberSweepCandidate[] = [{
      path: "src/util.ts",
      language: "typescript",
      content: "export function computeTotal(items: unknown[]) {\n  return items.length;\n}\n",
    }];

    const sweep = await computeMemberSweep("computeTotal", candidates);
    expect(sweep).toBeUndefined();
  });

  it("abstains for a non-identifier symbol name", async () => {
    const candidates: MemberSweepCandidate[] = [{
      path: "src/Foo.ts",
      language: "typescript",
      content: "export class Foo {\n  a() {}\n  b() {}\n}\n",
    }];

    const sweep = await computeMemberSweep("Foo.Bar", candidates);
    expect(sweep).toBeUndefined();
  });

  it("caps members at 12 even when the class declares more", async () => {
    const methods = Array.from({ length: 15 }, (_, i) => `  m${i}() { return ${i}; }`);
    const candidates: MemberSweepCandidate[] = [{
      path: "src/Big.ts",
      language: "typescript",
      content: `export class Big {\n${methods.join("\n")}\n}\n`,
    }];

    const sweep = await computeMemberSweep("Big", candidates);
    expect(sweep?.members.length).toBe(12);
    expect(sweep?.members[0]).toBe("m0");
    // `next` is the first <=5 of the (already capped) members list.
    expect(sweep?.next).toContain('["m0","m1","m2","m3","m4"]');
  });

  it("keeps the attachment within the ~600 byte budget by trimming members[], never by omitting the whole attachment when it can still fit >=2", async () => {
    // Long names chosen so the natural (uncapped-by-count) attachment would
    // exceed MEMBER_SWEEP_MAX_BYTES, forcing the trim-from-the-tail loop to
    // actually run.
    const methods = Array.from(
      { length: 12 },
      (_, i) => `  methodWithAVeryLongDescriptiveNameForBudgetTesting${i}() { return ${i}; }`,
    );
    const candidates: MemberSweepCandidate[] = [{
      path: "src/Oversized.ts",
      language: "typescript",
      content: `export class Oversized {\n${methods.join("\n")}\n}\n`,
    }];

    // Sanity check: the untrimmed 12-member attachment really would blow
    // the budget, so this test actually exercises the trim loop rather
    // than passing trivially.
    const untrimmedNames = methods.map((_, i) => `methodWithAVeryLongDescriptiveNameForBudgetTesting${i}`);
    const untrimmedBytes = Buffer.byteLength(JSON.stringify({
      symbol: "Oversized",
      members: untrimmedNames,
      next: `search_files action=find queries=${JSON.stringify(untrimmedNames.slice(0, 5))}`,
    }), "utf8");
    expect(untrimmedBytes).toBeGreaterThan(MEMBER_SWEEP_MAX_BYTES);

    const sweep = await computeMemberSweep("Oversized", candidates);
    expect(sweep).toBeDefined();
    expect(sweep!.members.length).toBeGreaterThanOrEqual(2);
    expect(Buffer.byteLength(JSON.stringify(sweep), "utf8")).toBeLessThanOrEqual(MEMBER_SWEEP_MAX_BYTES);
  });
});

describe("isIdentifierToken", () => {
  it("accepts bare identifiers and rejects dotted/spaced/numeric-leading tokens", () => {
    expect(isIdentifierToken("UserRepository")).toBe(true);
    expect(isIdentifierToken("_private")).toBe(true);
    expect(isIdentifierToken("Foo.Bar")).toBe(false);
    expect(isIdentifierToken("foo bar")).toBe(false);
    expect(isIdentifierToken("123abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findReferences() integration — action=references
// ---------------------------------------------------------------------------

describe("findReferences — member_sweep attachment", () => {
  it("attaches member_sweep with a valid batched `next` for a class referenced across files", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/Widget.ts", [
      "export class Widget {",
      "  render() {",
      "    return \"<div/>\";",
      "  }",
      "  destroy() {",
      "    return true;",
      "  }",
      "  _cleanup() {",
      "    return null;",
      "  }",
      "}",
    ].join("\n") + "\n");
    writeFile(ws, "src/app.ts", [
      "import { Widget } from \"./Widget\";",
      "const w = new Widget();",
      "w.render();",
    ].join("\n") + "\n");

    const result = await findReferences({ symbol: "Widget" }, ws);

    expect(result.member_sweep).toBeDefined();
    expect(result.member_sweep?.symbol).toBe("Widget");
    expect(result.member_sweep?.members).toEqual(["render", "destroy", "_cleanup"]);
    expect(result.member_sweep?.next).toBe(
      'search_files action=find queries=["render","destroy","_cleanup"]',
    );
    expect(result.hint).toBe(MEMBER_SWEEP_HINT_TEXT);
    // The attachment's own byte budget, independent of the 2048-byte
    // response-wide cap.
    expect(Buffer.byteLength(JSON.stringify(result.member_sweep), "utf8")).toBeLessThanOrEqual(MEMBER_SWEEP_MAX_BYTES);
  });

  it("does not attach member_sweep for a non-type (function) symbol", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/util.ts", "export function computeTotal(items) {\n  return items.length;\n}\n");
    writeFile(ws, "src/app.ts", "import { computeTotal } from \"./util\";\ncomputeTotal([1, 2]);\n");

    const result = await findReferences({ symbol: "computeTotal" }, ws);

    expect(result.member_sweep).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  it("does not attach member_sweep for a class with fewer than 2 members", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/Single.ts", "export class Single {\n  onlyMethod() { return 1; }\n}\n");
    writeFile(ws, "src/app.ts", "import { Single } from \"./Single\";\nnew Single().onlyMethod();\n");

    const result = await findReferences({ symbol: "Single" }, ws);

    expect(result.member_sweep).toBeUndefined();
  });

  it("does not attach member_sweep when the same class name is defined in two different files (ambiguous)", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/moduleA/Shape.ts", "export class Shape {\n  area() { return 1; }\n  perimeter() { return 2; }\n}\n");
    writeFile(ws, "src/moduleB/Shape.ts", "export class Shape {\n  volume() { return 3; }\n  scale() { return 4; }\n}\n");

    const result = await findReferences({ symbol: "Shape" }, ws);

    expect(result.member_sweep).toBeUndefined();
  });

  it("still respects the existing 2048-byte response cap when member_sweep is attached", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/Widget.ts", [
      "export class Widget {",
      "  render() { return 1; }",
      "  destroy() { return 2; }",
      "}",
    ].join("\n") + "\n");
    // Enough call sites that fitReferencesToCap's trim loop actually runs
    // while member_sweep is present, proving it was baked into the same
    // cap trial rather than appended after files[] was already finalized.
    for (let i = 0; i < 40; i++) {
      writeFile(ws, `src/consumer${i}.ts`, `import { Widget } from "../Widget";\nconst w${i} = new Widget();\nw${i}.render();\n`);
    }

    const result = await findReferences({ symbol: "Widget" }, ws);

    expect(result.member_sweep).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(2048);
  });
});

// ---------------------------------------------------------------------------
// action=find path — maybeAttachMemberSweepToFindResponse layered on
// buildFindResponse() (see server.ts's find dispatch)
// ---------------------------------------------------------------------------

describe("maybeAttachMemberSweepToFindResponse — action=find path", () => {
  it("attaches member_sweep to a buildFindResponse() result for a single-identifier class query", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/Widget.ts", [
      "export class Widget {",
      "  render() { return 1; }",
      "  destroy() { return 2; }",
      "}",
    ].join("\n") + "\n");
    // Exactly ONE "Widget" occurrence per file: attachDominantEditContext
    // requires >=2 matched lines in a file before it will promote an
    // editHint, so this fixture isolates the "no other hint present" case
    // this test is actually about (the precedence-vs-an-existing-hint case
    // is covered separately below).
    writeFile(ws, "src/app.ts", "import { Widget } from \"./Widget\";\n");

    const raw = buildFindResponse({ query: "Widget" }, ws);
    expect(raw.files.length).toBeGreaterThan(0);
    expect(raw.hint).toBeUndefined();

    const withSweep = await maybeAttachMemberSweepToFindResponse(raw, {
      query: "Widget",
      isRegex: false,
      workspace: ws,
      candidatePaths: raw.files.map((f) => f.path),
    });

    expect(withSweep.member_sweep).toBeDefined();
    expect(withSweep.member_sweep?.members).toEqual(["render", "destroy"]);
    expect(withSweep.hint).toBe(MEMBER_SWEEP_HINT_TEXT);
  });

  it("skips attachment for a regex query", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/Widget.ts", "export class Widget {\n  render() { return 1; }\n  destroy() { return 2; }\n}\n");

    const raw = buildFindResponse({ query: "Widget", regex: true }, ws);
    const result = await maybeAttachMemberSweepToFindResponse(raw, {
      query: "Widget",
      isRegex: true,
      workspace: ws,
      candidatePaths: raw.files.map((f) => f.path),
    });

    expect(result.member_sweep).toBeUndefined();
  });

  it("skips attachment when the response has no matched files", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/other.ts", "export const other = 1;\n");

    const raw = buildFindResponse({ query: "TotallyAbsentSymbolXYZ" }, ws);
    expect(raw.files.length).toBe(0);

    const result = await maybeAttachMemberSweepToFindResponse(raw, {
      query: "TotallyAbsentSymbolXYZ",
      isRegex: false,
      workspace: ws,
      candidatePaths: raw.files.map((f) => f.path),
    });

    expect(result.member_sweep).toBeUndefined();
    expect(result).toBe(raw); // unchanged — same object, not force-attached.
  });

  it("does not overwrite an existing hint (e.g. an edit-grade dominant-context hint) — only fills hint when the response didn't already carry one", async () => {
    const ws = mkWorkspace();
    writeFile(ws, "src/Widget.ts", "export class Widget {\n  render() { return 1; }\n  destroy() { return 2; }\n}\n");

    const raw = buildFindResponse({ query: "Widget" }, ws);
    const fakeHint = "pre-existing hint from another feature";
    const responseWithHint = { ...raw, hint: fakeHint };

    const result = await maybeAttachMemberSweepToFindResponse(responseWithHint, {
      query: "Widget",
      isRegex: false,
      workspace: ws,
      candidatePaths: responseWithHint.files.map((f) => f.path),
    });

    expect(result.member_sweep).toBeDefined();
    expect(result.hint).toBe(fakeHint);
  });
});
