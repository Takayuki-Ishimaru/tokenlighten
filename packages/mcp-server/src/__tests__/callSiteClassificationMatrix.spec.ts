// callSiteClassificationMatrix.spec.ts — R4-A2 (eval-0927 review-r3 P1-5,
// P0-3 shape half, 2026-09-28): the declaration-vs-call classifier every
// caller/flow call-site collector shares (`callSiteOccurrenceIsDeclaration`,
// built from `opensBlockDeclaration`/`rightHandOpensDeclarationBody`/
// `declarationHeadShape`/`isTypeToken`/`definitionSegment` in
// callerExpansion.ts), exercised as a MATRIX: language x shape.
//
// Pure unit tests only — no server, no workspace, no filesystem. Every case
// hand-builds a small multi-line source snippet, masks the target line with
// the SAME `maskNonCode` the real scanner uses, finds the occurrence with
// the SAME `findCallOccurrences`, and asks the SAME classifier the real
// caller-site collectors call. This is the regression fence: once every cell
// below passes, a future change that regresses any one of them fails here
// first, cheaply, with no fixture or server involved.
//
// SHAPES (see brief R4-A2): (1) declaration, body on the same line; (2)
// declaration whose own parameter list spans several lines, then the body;
// (3) body-less declaration (`;`-terminated prototype / interface member /
// overload signature / abstract method / Go interface member / Go receiver
// method / Rust trait method); (4) plain call statement; (5) call in a
// control-statement condition; (6) call with an object-literal / callback /
// dict / trailing-lambda ARGUMENT; (7) call in a default parameter value;
// (8) call after return/await/void/new/throw; (9) declaration head with
// generics or a qualified/pointer return type. Expected: (1)(2)(3)(9) are
// declarations, NEVER call sites; (4)-(8) are call sites, never
// declarations.
//
// LANGUAGE COVERAGE: TS, JS, Java, C#, Kotlin, Swift, Go, Rust, Python,
// Ruby, PHP, C, C++ — shapes (1)(2)(4)(5)(6)(8) for all thirteen. Shape (7)
// (a call used as a DEFAULT parameter VALUE) is skipped, with a comment,
// for the six languages that do not have this syntax at all: Java and C#
// (no default parameter values), Go and Rust (no default parameters at
// all), PHP (default values must be compile-time constants, never a call),
// C (no default parameters of any kind). Shape (3) and shape (9) each cover
// the specific languages/sub-shapes the brief names as canonical examples,
// not every language (most languages have no body-less declaration syntax,
// or no generic/qualified-return-type syntax, worth a dedicated cell).

import { describe, expect, it } from "vitest";

import { findCallOccurrences, maskNonCode } from "../features/task-pack/callerExpansion.js";
import { callSiteOccurrenceIsDeclaration, isDeclarationShapedMatchText } from "../features/task-pack/readCodeTaskPack.js";

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface Case {
  readonly id: string;
  readonly relPath: string;
  readonly hashComment?: boolean;
  readonly identifier: string;
  readonly lines: readonly string[];
  /** 1-based line the occurrence under test sits on. */
  readonly targetLine: number;
  readonly expectDeclaration: boolean;
}

/** Runs one case against the real classifier and reports a message naming exactly what was expected vs. found. */
function check(c: Case): void {
  const hashComment = c.hashComment ?? false;
  const rawLine = c.lines[c.targetLine - 1];
  expect(rawLine, `${c.id}: line ${c.targetLine} must exist in the snippet`).toBeDefined();
  const masked = maskNonCode(rawLine!, hashComment);
  const occurrences = findCallOccurrences(masked, c.identifier);
  expect(occurrences.length, `${c.id}: expected an occurrence of "${c.identifier}" on line ${c.targetLine} (${JSON.stringify(rawLine)})`).toBeGreaterThan(0);
  // A line may carry more than one occurrence in principle; every one found
  // must agree (the cases below are built so exactly one occurrence exists).
  for (const occurrence of occurrences) {
    const actual = callSiteOccurrenceIsDeclaration(occurrence, masked, c.relPath, c.lines, c.targetLine, hashComment);
    expect(actual, `${c.id}: expected isDeclaration=${c.expectDeclaration}, got ${actual} (line ${JSON.stringify(rawLine)})`).toBe(c.expectDeclaration);
  }
}

// ---------------------------------------------------------------------------
// A. Universal shapes across all thirteen languages: (1)(2)(4)(5)(6)(8)
// ---------------------------------------------------------------------------

interface LanguageShapes {
  readonly lang: string;
  readonly relPath: string;
  readonly hashComment?: boolean;
  readonly identifier: string;
  readonly declSameLine: readonly string[];
  readonly declMultiLine: readonly string[];
  readonly plainCall: readonly string[];
  readonly callInCondition: readonly string[];
  readonly callWithBlockArg: readonly string[];
  readonly callInDefaultParam?: readonly string[];
  readonly callAfterKeyword: readonly [readonly string[], number];
}

const LANGUAGES: readonly LanguageShapes[] = [
  {
    lang: "TS", relPath: "a.ts", identifier: "run",
    declSameLine: ["function run(x: number): number { return x; }"],
    declMultiLine: ["function run(", "  x: number,", "  y: number,", "): number {", "  return x + y;", "}"],
    plainCall: ["run(x);"],
    callInCondition: ["if (run(x)) {", "  doThing();", "}"],
    callWithBlockArg: ["run(x, () => {", "  doThing();", "});"],
    callInDefaultParam: ["function outer(x = run(y)): void {", "  return;", "}"],
    callAfterKeyword: [["function outer(): number {", "  return run(x);", "}"], 2],
  },
  {
    lang: "JS", relPath: "a.js", identifier: "run",
    declSameLine: ["function run(x) { return x; }"],
    declMultiLine: ["function run(", "  x,", "  y", ") {", "  return x + y;", "}"],
    plainCall: ["run(x);"],
    callInCondition: ["if (run(x)) {", "  doThing();", "}"],
    callWithBlockArg: ["run(x, function () {", "  doThing();", "});"],
    callInDefaultParam: ["function outer(x = run(y)) {", "  return;", "}"],
    callAfterKeyword: [["function outer() {", "  return run(x);", "}"], 2],
  },
  {
    lang: "Java", relPath: "a.java", identifier: "run",
    declSameLine: ["public Booking run(long id) { return null; }"],
    declMultiLine: ["public Booking run(", "    long id,", "    String note", ") {", "    return null;", "}"],
    plainCall: ["run(id);"],
    callInCondition: ["if (run(id)) {", "    doThing();", "}"],
    callWithBlockArg: ["run(id, () -> {", "    doThing();", "});"],
    // Java has no default parameter values at all -- shape (7) does not apply.
    callAfterKeyword: [["Booking outer() {", "    return run(id);", "}"], 2],
  },
  {
    lang: "C#", relPath: "a.cs", identifier: "run",
    declSameLine: ["public Booking run(long id) { return null; }"],
    declMultiLine: ["public Booking run(", "    long id,", "    string note", ") {", "    return null;", "}"],
    plainCall: ["run(id);"],
    callInCondition: ["if (run(id)) {", "    doThing();", "}"],
    callWithBlockArg: ["run(id, () => {", "    doThing();", "});"],
    // C# default parameter values must be compile-time constants, never a call -- shape (7) does not apply.
    callAfterKeyword: [["Booking outer() {", "    return run(id);", "}"], 2],
  },
  {
    lang: "Kotlin", relPath: "a.kt", identifier: "run",
    declSameLine: ["fun run(x: Int): Int { return x }"],
    declMultiLine: ["fun run(", "    x: Int,", "    y: Int", "): Int {", "    return x + y", "}"],
    plainCall: ["run(x)"],
    callInCondition: ["if (run(x)) {", "    doThing()", "}"],
    callWithBlockArg: ["run(x) {", "    doThing()", "}"],
    callInDefaultParam: ["fun outer(x: Int = run(1)): Int {", "    return x", "}"],
    callAfterKeyword: [["fun outer(): Int {", "    return run(x)", "}"], 2],
  },
  {
    lang: "Swift", relPath: "a.swift", identifier: "run",
    declSameLine: ["func run(x: Int) -> Int { return x }"],
    declMultiLine: ["func run(", "    x: Int,", "    y: Int", ") -> Int {", "    return x + y", "}"],
    plainCall: ["run(x)"],
    callInCondition: ["if run(x) {", "    doThing()", "}"],
    callWithBlockArg: ["run(x) {", "    doThing()", "}"],
    callInDefaultParam: ["func outer(x: Int = run(1)) -> Int {", "    return x", "}"],
    callAfterKeyword: [["func outer() -> Int {", "    return run(x)", "}"], 2],
  },
  {
    lang: "Go", relPath: "a.go", identifier: "run",
    declSameLine: ["func run(x int) int { return x }"],
    declMultiLine: ["func run(", "\tx int,", "\ty int,", ") int {", "\treturn x + y", "}"],
    plainCall: ["run(x)"],
    callInCondition: ["if run(x) {", "\tdoThing()", "}"],
    callWithBlockArg: ["run(x, func() {", "\tdoThing()", "})"],
    // Go has no default parameters at all -- shape (7) does not apply.
    callAfterKeyword: [["func outer() int {", "\treturn run(x)", "}"], 2],
  },
  {
    lang: "Rust", relPath: "a.rs", identifier: "run",
    declSameLine: ["fn run(x: i32) -> i32 { x }"],
    declMultiLine: ["fn run(", "    x: i32,", "    y: i32,", ") -> i32 {", "    x + y", "}"],
    plainCall: ["run(x);"],
    callInCondition: ["if run(x) {", "    do_thing();", "}"],
    callWithBlockArg: ["run(x, || {", "    do_thing();", "});"],
    // Rust has no default parameters at all -- shape (7) does not apply.
    callAfterKeyword: [["fn outer() -> i32 {", "    return run(x);", "}"], 2],
  },
  {
    lang: "Python", relPath: "a.py", hashComment: true, identifier: "run",
    declSameLine: ["def run(x):", "    return x"],
    declMultiLine: ["def run(", "    x,", "    y,", "):", "    return x + y"],
    plainCall: ["run(x)"],
    callInCondition: ["if run(x):", "    do_thing()"],
    callWithBlockArg: ["run(x, {", "    \"a\": 1,", "})"],
    callInDefaultParam: ["def outer(x=run(1)):", "    return x"],
    callAfterKeyword: [["def outer():", "    return run(x)"], 2],
  },
  {
    lang: "Ruby", relPath: "a.rb", hashComment: true, identifier: "run",
    declSameLine: ["def run(x)", "  x", "end"],
    declMultiLine: ["def run(", "  x,", "  y", ")", "  x + y", "end"],
    plainCall: ["run(x)"],
    callInCondition: ["if run(x)", "  do_thing", "end"],
    callWithBlockArg: ["run(x) do", "  do_thing", "end"],
    callInDefaultParam: ["def outer(x = run(1))", "  x", "end"],
    callAfterKeyword: [["def outer", "  return run(x)", "end"], 2],
  },
  {
    lang: "PHP", relPath: "a.php", identifier: "run",
    declSameLine: ["function run($x) { return $x; }"],
    declMultiLine: ["function run(", "    $x,", "    $y", ") {", "    return $x + $y;", "}"],
    plainCall: ["run($x);"],
    callInCondition: ["if (run($x)) {", "    doThing();", "}"],
    callWithBlockArg: ["run($x, function () {", "    doThing();", "});"],
    // PHP default parameter values must be constant expressions, never a call -- shape (7) does not apply.
    callAfterKeyword: [["function outer() {", "    return run($x);", "}"], 2],
  },
  {
    lang: "C", relPath: "a.c", identifier: "run",
    declSameLine: ["int run(int x) { return x; }"],
    declMultiLine: ["int run(", "    int x,", "    int y", ") {", "    return x + y;", "}"],
    plainCall: ["run(x);"],
    callInCondition: ["if (run(x)) {", "    doThing();", "}"],
    callWithBlockArg: ["run(x, (struct P){", "    1", "});"],
    // C has no default parameters of any kind -- shape (7) does not apply.
    callAfterKeyword: [["int outer(void) {", "    return run(x);", "}"], 2],
  },
  {
    lang: "C++", relPath: "a.cpp", identifier: "run",
    declSameLine: ["int run(int x) { return x; }"],
    declMultiLine: ["int run(", "    int x,", "    int y", ") {", "    return x + y;", "}"],
    plainCall: ["run(x);"],
    callInCondition: ["if (run(x)) {", "    doThing();", "}"],
    callWithBlockArg: ["run(x, []() {", "    doThing();", "});"],
    callInDefaultParam: ["int outer(int x = run(1)) {", "    return x;", "}"],
    callAfterKeyword: [["int outer() {", "    return run(x);", "}"], 2],
  },
];

describe("callSiteClassificationMatrix — universal shapes (1)(2)(4)(5)(6)(8) x 13 languages", () => {
  for (const l of LANGUAGES) {
    it(`${l.lang}: (1) declaration, body on the same line`, () => {
      check({ id: `${l.lang}/1`, relPath: l.relPath, hashComment: l.hashComment, identifier: l.identifier, lines: l.declSameLine, targetLine: 1, expectDeclaration: true });
    });
    it(`${l.lang}: (2) declaration, parameters span several lines`, () => {
      check({ id: `${l.lang}/2`, relPath: l.relPath, hashComment: l.hashComment, identifier: l.identifier, lines: l.declMultiLine, targetLine: 1, expectDeclaration: true });
    });
    it(`${l.lang}: (4) plain call statement`, () => {
      check({ id: `${l.lang}/4`, relPath: l.relPath, hashComment: l.hashComment, identifier: l.identifier, lines: l.plainCall, targetLine: 1, expectDeclaration: false });
    });
    it(`${l.lang}: (5) call in a control-statement condition`, () => {
      check({ id: `${l.lang}/5`, relPath: l.relPath, hashComment: l.hashComment, identifier: l.identifier, lines: l.callInCondition, targetLine: 1, expectDeclaration: false });
    });
    it(`${l.lang}: (6) call with a block-shaped (object/callback/dict/lambda) argument`, () => {
      check({ id: `${l.lang}/6`, relPath: l.relPath, hashComment: l.hashComment, identifier: l.identifier, lines: l.callWithBlockArg, targetLine: 1, expectDeclaration: false });
    });
    if (l.callInDefaultParam !== undefined) {
      it(`${l.lang}: (7) call in a default parameter value`, () => {
        check({ id: `${l.lang}/7`, relPath: l.relPath, hashComment: l.hashComment, identifier: l.identifier, lines: l.callInDefaultParam!, targetLine: 1, expectDeclaration: false });
      });
    }
    it(`${l.lang}: (8) call after return`, () => {
      const [lines, targetLine] = l.callAfterKeyword;
      check({ id: `${l.lang}/8`, relPath: l.relPath, hashComment: l.hashComment, identifier: l.identifier, lines, targetLine, expectDeclaration: false });
    });
  }
});

// ---------------------------------------------------------------------------
// B. Shape (3): body-less declarations — the canonical per-language shapes
// named in the brief (a `;`-terminated prototype, TS interface member and
// overload signature, Java/C# interface/abstract method, Go interface
// member, Go method with a receiver, Rust trait method).
// ---------------------------------------------------------------------------

describe("callSiteClassificationMatrix — shape (3): body-less declarations", () => {
  it("C: a `;`-terminated prototype with a pointer return type is a declaration", () => {
    check({
      id: "C/3-prototype",
      relPath: "report.h",
      identifier: "report_open",
      lines: ["report_t *report_open(const char *scope);"],
      targetLine: 1,
      expectDeclaration: true,
    });
  });

  it("C++: a `;`-terminated prototype with a namespace-qualified return type is a declaration", () => {
    check({
      id: "C++/3-prototype",
      relPath: "parser.h",
      identifier: "render_report",
      lines: ["std::string render_report(const std::string& scope);"],
      targetLine: 1,
      expectDeclaration: true,
    });
  });

  it("TS: an interface member (no body, suffix return type) is a declaration", () => {
    check({
      id: "TS/3-iface-member",
      relPath: "types.ts",
      identifier: "fetchJson",
      lines: ["interface JsonClient {", "  fetchJson(pathname: string): Promise<unknown>;", "  close(): void;", "}"],
      targetLine: 2,
      expectDeclaration: true,
    });
  });

  it("TS: an overload signature (no body, ahead of the implementation) is a declaration", () => {
    check({
      id: "TS/3-overload",
      relPath: "store.ts",
      identifier: "lookup",
      lines: [
        "class Store {",
        "  lookup(key: string): string | undefined;",
        "  lookup(key: number): number | undefined;",
        "  lookup(key: string | number): unknown {",
        "    return undefined;",
        "  }",
        "}",
      ],
      targetLine: 2,
      expectDeclaration: true,
    });
  });

  it("Java: an interface method (no body, no modifier, generic return type) is a declaration", () => {
    check({
      id: "Java/3-iface-method",
      relPath: "StatsSource.java",
      identifier: "counts",
      lines: ["public interface StatsSource {", "  Map<String, Integer> counts(String scope);", "}"],
      targetLine: 2,
      expectDeclaration: true,
    });
  });

  it("C#: an interface method (no body, generic return type) is a declaration", () => {
    check({
      id: "C#/3-iface-method",
      relPath: "IStatsSource.cs",
      identifier: "Counts",
      lines: ["public interface IStatsSource {", "    Dictionary<string, int> Counts(string scope);", "}"],
      targetLine: 2,
      expectDeclaration: true,
    });
  });

  it("Go: an interface member (no `func`, no body, return-type tuple) is a declaration", () => {
    check({
      id: "Go/3-iface-member",
      relPath: "iface.go",
      identifier: "FetchJSON",
      lines: ["type Fetcher interface {", "\tFetchJSON(pathname string) ([]byte, error)", "}"],
      targetLine: 2,
      expectDeclaration: true,
    });
  });

  it("Go: a method with a receiver (`func (m *T) Name(`) is a declaration", () => {
    check({
      id: "Go/3-receiver-method",
      relPath: "memory.go",
      identifier: "FetchJSON",
      lines: ["func (m *MemoryClient) FetchJSON(pathname string) ([]byte, error) {", "\treturn m.Data, nil", "}"],
      targetLine: 1,
      expectDeclaration: true,
    });
  });

  it("Rust: a trait method (no body, keyword-led) is a declaration", () => {
    check({
      id: "Rust/3-trait-method",
      relPath: "fetcher.rs",
      identifier: "fetch_json",
      lines: ["trait Fetcher {", "    fn fetch_json(&self, pathname: &str) -> Vec<u8>;", "}"],
      targetLine: 2,
      expectDeclaration: true,
    });
  });
});

// ---------------------------------------------------------------------------
// C. Shape (9): declaration heads with generics or a qualified/pointer
// return type — the canonical examples named in the brief.
// ---------------------------------------------------------------------------

describe("callSiteClassificationMatrix — shape (9): generic / qualified / pointer declaration heads", () => {
  it("Java: `Map<K, V> f(` — a generic prefix return type", () => {
    check({
      id: "Java/9-map",
      relPath: "Run.java",
      identifier: "run",
      lines: ["public Map<String, Integer> run(String scope) {", "    return null;", "}"],
      targetLine: 1,
      expectDeclaration: true,
    });
  });

  it("Java: `List<? extends T> f(` — a bounded wildcard generic prefix return type", () => {
    check({
      id: "Java/9-wildcard",
      relPath: "Run.java",
      identifier: "run",
      lines: ["public List<? extends Number> run(int n) {", "    return null;", "}"],
      targetLine: 1,
      expectDeclaration: true,
    });
  });

  it("TS: `fetchJson<T>(` — a generic method declaration", () => {
    check({
      id: "TS/9-generic-method",
      relPath: "zclient.ts",
      identifier: "fetchJson",
      lines: ["  fetchJson<T>(pathname: string): Promise<T> {", "    return fetch(pathname).then((r) => r.json() as Promise<T>);", "  }"],
      targetLine: 1,
      expectDeclaration: true,
    });
  });

  it("C++: `std::string f(` — a namespace-qualified prefix return type", () => {
    check({
      id: "C++/9-qualified",
      relPath: "parser.cpp",
      identifier: "render_report",
      lines: ["std::string render_report(const std::string& scope) {", "  return \"report:\" + scope;", "}"],
      targetLine: 1,
      expectDeclaration: true,
    });
  });

  it("C: `report_t *f(` — a pointer return type written as its own word", () => {
    check({
      id: "C/9-pointer",
      relPath: "report.c",
      identifier: "report_open",
      lines: ["report_t *report_open(const char *scope) {", "  return malloc(sizeof(report_t));", "}"],
      targetLine: 1,
      expectDeclaration: true,
    });
  });
});

// ---------------------------------------------------------------------------
// D. `isDeclarationShapedMatchText` — the SAME shapes, but through the
// weaker single-line (no next-line lookahead) heuristic the literal-fallback
// focal resolver uses. Shape (2) (multi-line parameters) is OUT OF SCOPE for
// this function by design (it never sees a second line at all — see its own
// doc comment) and is not asserted here; every other shape this function can
// decide is.
// ---------------------------------------------------------------------------

describe("isDeclarationShapedMatchText — single-line shapes", () => {
  it("recognizes a same-line declaration (keyword-led and shorthand)", () => {
    expect(isDeclarationShapedMatchText("function run(x) {", "run")).toBe(true);
    expect(isDeclarationShapedMatchText("public Booking run(long id) {", "run")).toBe(true);
    expect(isDeclarationShapedMatchText("def run(x):", "run")).toBe(true);
  });

  it("recognizes a body-less declaration (annotated and bare)", () => {
    expect(isDeclarationShapedMatchText("fetchJson(pathname: string): Promise<unknown>;", "fetchJson")).toBe(true);
    expect(isDeclarationShapedMatchText("report_t *report_open(const char *scope);", "report_open")).toBe(true);
  });

  it("recognizes a generic method declaration head", () => {
    expect(isDeclarationShapedMatchText("fetchJson<T>(pathname: string): Promise<T> {", "fetchJson")).toBe(true);
  });

  it("still rejects a plain call and a call in a condition", () => {
    expect(isDeclarationShapedMatchText("run(x);", "run")).toBe(false);
    expect(isDeclarationShapedMatchText("if (run(x)) {", "run")).toBe(false);
  });

  it("never mistakes a bare call statement for a body-less declaration (the ambiguity a non-empty head guards against)", () => {
    // Empty head + bare `;` is indistinguishable from an ordinary call
    // statement -- must NOT be accepted just because a body-less
    // declaration elsewhere in this same file would be.
    expect(isDeclarationShapedMatchText("cancel(id);", "cancel")).toBe(false);
  });
});
