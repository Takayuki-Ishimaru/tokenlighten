/**
 * callSiteClassificationMatrix.r5.spec.ts — round 5 extension of the
 * declaration-vs-call regression fence (eval-0927 review-r4 P1-5/P1-6/P1-11).
 *
 * The cells below are the round-4 reviewer's own attack probe, copied verbatim
 * (`scratchpad/review4/classprobe.mts` and `classprobe2.mts`): each row is
 * [id, relPath, identifier, lines, targetLine, expectDeclaration]. A call that
 * reads as a declaration drops a real call site (a false "no callers"); a
 * declaration that reads as a call pollutes the answer with a false caller.
 * The round-4 cells stay in callSiteClassificationMatrix.spec.ts.
 */
import { describe, expect, it } from "vitest";

import { findCallOccurrences, hasHashComments, maskNonCode } from "../features/task-pack/callerExpansion.js";
import { callSiteOccurrenceIsDeclaration } from "../features/task-pack/readCodeTaskPack.js";

type Row = [string, string, string, string[], number, boolean];
const ROWS: Row[] = [
  // ---- calls that must stay CALLS (a dropped site can yield a false empty)
  ["js-yield-star", "a.js", "run", ["function* outer() {", "  yield* run(x);", "}"], 2, false],
  ["ts-template-interp", "a.ts", "run", ["const s = `total ${run(n)} bytes`;"], 1, false],
  ["py-fstring", "a.py", "run", ["s = f\"total {run(n)} bytes\""], 1, false],
  ["go-generic-explicit", "a.go", "Sum", ["total := Sum[int](xs)"], 1, false],
  ["ts-generic-explicit", "a.ts", "run", ["const v = run<string>(\"x\");"], 1, false],
  ["ts-optional-call", "a.ts", "run", ["run?.(x);"], 1, false],
  ["ts-bare-multiline-call", "a.ts", "run", ["run(", "  a,", "  b,", ");"], 1, false],
  ["ts-bare-multiline-call-then-block", "a.ts", "run", ["run(", "  a,", ")", "{", "  x();", "}"], 1, false],
  ["c-macro-arg", "a.c", "run", ["LOG(run(x));"], 1, false],
  ["c-comma-second", "a.c", "run", ["int a = run(1), b = run(2);"], 1, false],
  ["cpp-ternary", "a.cpp", "run", ["auto y = c ? run(a) : run(b);"], 1, false],
  ["java-label", "a.java", "run", ["retry: run(x);"], 1, false],
  ["cs-expression-bodied-prop-call", "a.cs", "Run", ["public int Total => Run(x);"], 1, false],
  ["cs-static-field-init", "a.cs", "Run", ["static readonly int X = Run(1);"], 1, false],
  ["ts-export-default-call", "a.ts", "run", ["export default run(x);"], 1, false],
  ["ts-decorator-factory-call", "a.ts", "run", ["@run(options) class Foo {}"], 1, false],
  ["cpp-co-await", "a.cpp", "run", ["co_await run(x);"], 1, false],
  ["cpp-cast", "a.cpp", "run", ["(void) run(x);"], 1, false],
  ["cpp-deref-assign", "a.cpp", "run", ["*run(x) = 3;"], 1, false],
  ["cpp-neg", "a.cpp", "run", ["!run(x);"], 1, false],
  ["js-else-call", "a.js", "run", ["if (a) b(); else run(x);"], 1, false],
  ["js-do-while", "a.js", "run", ["do run(x); while (cond);"], 1, false],
  ["java-then-call", "a.java", "run", ["if (a) run(x);"], 1, false],
  ["ts-as-cast", "a.ts", "run", ["run(x) as Foo;"], 1, false],
  ["ts-non-null", "a.ts", "run", ["run(x)!;"], 1, false],
  ["ts-type-assert-prefix", "a.ts", "run", ["<Foo>run(x);"], 1, false],
  ["ts-await-in-const", "a.ts", "run", ["const r: Foo = await run(x);"], 1, false],
  ["ts-return-type-obj", "a.ts", "run", ["const r = run(x) satisfies Foo;"], 1, false],
  ["ts-arrow-body", "a.ts", "run", ["const f = (x) => run(x);"], 1, false],
  ["ts-callback-arg-newline-close", "a.ts", "run", ["schedule(", "  run(x),", ");"], 2, false],
  ["ts-object-literal-value", "a.ts", "run", ["const o = { a: run(x) };"], 1, false],
  ["ts-array-value", "a.ts", "run", ["const o = [run(x)];"], 1, false],
  ["ts-bare-call-no-semicolon", "a.ts", "run", ["run(x)", "next()"], 1, false],
  ["ts-bare-call-generic-no-semicolon", "a.ts", "run", ["run<T>(x)", "next()"], 1, false],
  ["ts-throw-new", "a.ts", "run", ["throw run(x);"], 1, false],
  ["ts-typeof", "a.ts", "run", ["typeof run(x);"], 1, false],
  ["ts-void-op", "a.ts", "run", ["void run(x);"], 1, false],
  ["java-void-cast-like", "a.java", "run", ["Object o = (Object) run(x);"], 1, false],
  ["cpp-template-call-explicit", "a.cpp", "run", ["auto v = run<int>(x);"], 1, false],
  ["cpp-namespace-call", "a.cpp", "run", ["auto v = app::run(x);"], 1, false],
  ["cpp-scope-call-stmt", "a.cpp", "run", ["app::run(x);"], 1, false],
  ["cpp-static-member-call", "a.cpp", "run", ["Foo::run(x);"], 1, false],
  ["php-echo", "a.php", "run", ["echo run($x);"], 1, false],
  ["rb-puts", "a.rb", "run", ["puts run(x)"], 1, false],
  ["kt-trailing-lambda", "a.kt", "run", ["run(x) { doThing() }"], 1, false],
  ["swift-trailing", "a.swift", "run", ["run(x) { doThing() }"], 1, false],
  ["go-defer", "a.go", "run", ["defer run(x)"], 1, false],
  ["go-go", "a.go", "run", ["go run(x)"], 1, false],
  ["go-struct-field", "a.go", "run", ["cfg := Config{Handler: run(x)}"], 1, false],
  ["go-return-err", "a.go", "run", ["return run(x), nil"], 1, false],
  ["go-call-then-type-assert", "a.go", "run", ["v := run(x).(Foo)"], 1, false],
  ["ts-const-assert", "a.ts", "run", ["const x = run(1) as const;"], 1, false],
  ["js-new-call", "a.js", "run", ["const x = new run(1);"], 1, false],
  ["cs-lambda-body", "a.cs", "Run", ["var f = (int x) => Run(x);"], 1, false],
  ["java-lambda-body", "a.java", "run", ["Function<Integer, Integer> f = x -> run(x);"], 1, false],
  ["java-method-ref-call-chain", "a.java", "run", ["list.forEach(x -> run(x));"], 1, false],
  ["cpp-lambda-body", "a.cpp", "run", ["auto f = [](int x) { return run(x); };"], 1, false],
  ["c-if-noparen-body-newline", "a.c", "run", ["if (a)", "  run(x);"], 2, false],
  ["ts-multiline-obj-arg-close-then-brace", "a.ts", "run", ["run({", "  a: 1,", "});"], 1, false],
  ["ts-call-after-label-type-like", "a.ts", "run", ["Result: run(x);"], 1, false],
  ["cpp-comma-operator", "a.cpp", "run", ["a = 1, run(x);"], 1, false],
  ["ts-spread-arg", "a.ts", "run", ["f(...run(x));"], 1, false],
  ["ts-unary-plus", "a.ts", "run", ["+run(x);"], 1, false],
  ["ts-tagged-template-arg", "a.ts", "run", ["sql`select ${run(x)}`;"], 1, false],

  // ---- declarations that must stay DECLARATIONS (a false caller pollutes the answer)
  ["java-annot-same-line-public", "a.java", "run", ["@Override public void run() {", "}"], 1, true],
  ["java-annot-same-line-pkgpriv-type", "a.java", "run", ["@Test Map<String, Integer> run() {", "}"], 1, true],
  ["cs-attr-same-line-public", "a.cs", "Run", ["[Fact] public void Run() {", "}"], 1, true],
  ["cs-attr-same-line-type", "a.cs", "Get", ["[HttpGet] IActionResult Get() {", "}"], 1, true],
  ["cs-expression-bodied-public", "a.cs", "Run", ["public int Run(int x) => x * 2;"], 1, true],
  ["cs-expression-bodied-usertype", "a.cs", "Run", ["Booking Run(long id) => null;"], 1, true],
  ["cpp-template-typename-oneline", "a.hpp", "run", ["template <typename T> T run(T v) { return v; }"], 1, true],
  ["cpp-template-class-oneline", "a.hpp", "run", ["template <class T> T run(T v) { return v; }"], 1, true],
  ["cpp-template-own-line", "a.hpp", "run", ["template <typename T>", "T run(T v) {", "  return v;", "}"], 2, true],
  ["c-extern-proto", "a.h", "run", ["extern size_t run(int x);"], 1, true],
  ["c-unsigned-int-def", "a.c", "run", ["unsigned int run(unsigned x) {", "  return x;", "}"], 1, true],
  ["c-unsigned-long-proto", "a.h", "run", ["unsigned long run(int x);"], 1, true],
  ["c-long-long-def", "a.c", "run", ["long long run(int x) {", "  return x;", "}"], 1, true],
  ["cpp-constexpr-size_t", "a.cpp", "run", ["constexpr size_t run(int x) {", "  return x;", "}"], 1, true],
  ["cpp-inline-constexpr", "a.hpp", "run", ["inline constexpr size_t run(int x) { return x; }"], 1, true],
  ["cpp-out-of-line-member-usertype", "a.cpp", "cancel", ["OrderStatus OrderService::cancel(int id) {", "  return OrderStatus::Cancelled;", "}"], 1, true],
  ["cpp-out-of-line-member-std", "a.cpp", "render", ["std::string OrderService::render(int id) {", "  return \"\";", "}"], 1, true],
  ["cpp-out-of-line-member-bool", "a.cpp", "cancel", ["bool OrderService::cancel(int id) {", "  return true;", "}"], 1, true],
  ["cpp-pure-virtual", "a.hpp", "run", ["  virtual int run(int x) = 0;"], 1, true],
  ["cpp-pure-virtual-usertype", "a.hpp", "run", ["  virtual Status run(int x) = 0;"], 1, true],
  ["cpp-override-trailing", "a.hpp", "run", ["  int run(int x) override {", "    return x;", "  }"], 1, true],
  ["cpp-const-member", "a.hpp", "run", ["  int run(int x) const {", "    return x;", "  }"], 1, true],
  ["cpp-noexcept", "a.hpp", "run", ["  Status run(int x) noexcept {", "    return {};", "  }"], 1, true],
  ["cpp-usertype-const-member", "a.hpp", "run", ["  Status run(int x) const {", "    return {};", "  }"], 1, true],
  ["java-generic-method", "a.java", "run", ["public <T> List<T> run(Class<T> c) {", "  return null;", "}"], 1, true],
  ["java-throws", "a.java", "run", ["public Booking run(long id) throws IOException {", "  return null;", "}"], 1, true],
  ["java-pkgpriv-throws", "a.java", "run", ["Booking run(long id) throws IOException {", "  return null;", "}"], 1, true],
  ["js-generator-method", "a.js", "run", ["class A {", "  *run(x) {", "    yield x;", "  }", "}"], 2, true],
  ["js-async-generator-method", "a.js", "run", ["class A {", "  async *run(x) {", "    yield x;", "  }", "}"], 2, true],
  ["ts-decorator-same-line", "a.ts", "onResize", ["  @HostListener('window:resize', ['$event']) onResize(event: UIEvent): void {", "    this.width = 1;", "  }"], 1, true],
  ["ts-decorator-own-line", "a.ts", "onResize", ["  @HostListener('window:resize', ['$event'])", "  onResize(event: UIEvent): void {", "    this.width = 1;", "  }"], 2, true],
  ["ts-method-obj-return-type", "a.ts", "run", ["  run(x: number): { ok: boolean } {", "    return { ok: true };", "  }"], 1, true],
  ["ts-method-union-return", "a.ts", "run", ["  run(x: number): string | undefined {", "    return undefined;", "  }"], 1, true],
  ["ts-method-generic-return", "a.ts", "run", ["  run(x: number): Promise<Map<string, number>> {", "    return null as any;", "  }"], 1, true],
  ["ts-method-arrow-return-type", "a.ts", "run", ["  run(x: number): (y: number) => number {", "    return (y) => y;", "  }"], 1, true],
  ["ts-abstract-generic-return", "a.ts", "run", ["  abstract run(x: number): Promise<Map<string, number>>;"], 1, true],
  ["ts-iface-obj-return", "a.ts", "run", ["interface A {", "  run(x: number): { ok: boolean };", "}"], 2, true],
  ["ts-iface-arrow-return", "a.ts", "run", ["interface A {", "  run(x: number): (y: number) => number;", "}"], 2, true],
  ["ts-method-allman", "a.ts", "run", ["  run(x: number): number", "  {", "    return x;", "  }"], 1, true],
  ["ts-multiline-params-obj-return", "a.ts", "run", ["  run(", "    x: number,", "  ): { ok: boolean } {", "    return { ok: true };", "  }"], 1, true],
  ["ts-multiline-params-default-obj", "a.ts", "run", ["  run(", "    opts: Options = {},", "  ): void {", "  }"], 1, true],
  ["ts-default-param-object-literal", "a.ts", "run", ["function run(opts = {}) {", "  return opts;", "}"], 1, true],
  ["ts-shorthand-default-param-object", "a.ts", "run", ["  run(opts = { a: 1 }) {", "    return opts;", "  }"], 1, true],
  ["java-default-obj-like", "a.java", "run", ["  public void run(int[] xs) {", "  }"], 1, true],
  ["java-array-return", "a.java", "run", ["  public int[] run() {", "    return null;", "  }"], 1, true],
  ["java-annotated-param", "a.java", "run", ["  public void run(@NonNull String s) {", "  }"], 1, true],
  ["java-pkgpriv-annotated-param", "a.java", "run", ["  Booking run(@NonNull String s) {", "    return null;", "  }"], 1, true],
  ["cs-attr-param", "a.cs", "Run", ["  Booking Run([FromBody] Order o) {", "    return null;", "  }"], 1, true],
  ["c-kr-static", "a.c", "run", ["static int run(x)", "int x;", "{", "  return x;", "}"], 1, true],
  ["c-proto-void-params", "a.h", "run", ["size_t run(void);"], 1, true],
  ["c-macro-define", "a.h", "run", ["#define run(x) ((x) * 2)"], 1, true],
  ["c-attr-proto", "a.h", "run", ["__attribute__((warn_unused_result)) int run(int x);"], 1, true],
  ["cpp-nodiscard", "a.hpp", "run", ["[[nodiscard]] Status run(int x);"], 1, true],
  ["cpp-nodiscard-int", "a.hpp", "run", ["[[nodiscard]] int run(int x);"], 1, true],
  ["cpp-friend", "a.hpp", "run", ["  friend Status run(int x);"], 1, true],
  ["cpp-static-usertype", "a.hpp", "run", ["  static Status run(int x);"], 1, true],
  ["cpp-explicit-ctor-like", "a.hpp", "Run", ["  explicit Run(int x);"], 1, true],
  ["cpp-default-arg-call", "a.hpp", "run", ["Status run(int x = defaultValue());"], 1, true],
  ["cpp-default-arg-call-usertype-def", "a.cpp", "run", ["Status run(int x = defaultValue()) {", "  return {};", "}"], 1, true],
  ["c-proto-default-arg-int", "a.h", "run", ["int run(int x = defaultValue());"], 1, true],
  ["ts-export-default-function-shorthand-ok", "a.ts", "run", ["export default function run(x: number) {", "  return x;", "}"], 1, true],
  ["ts-export-default-class-method", "a.ts", "run", ["export default class A {", "  run(x: number) {", "    return x;", "  }", "}"], 2, true],
  ["kt-fun", "a.kt", "run", ["fun run(x: Int): Int = x"], 1, true],
  ["swift-func", "a.swift", "run", ["func run(x: Int) -> Int { x }"], 1, true],
  ["py-def-decorated", "a.py", "run", ["@app.route(\"/x\")", "def run():", "    return 1"], 2, true],
  ["go-iface-void", "a.go", "Close", ["type C interface {", "\tClose()", "}"], 2, true],
  ["go-iface-generic-ret", "a.go", "Fetch", ["type C interface {", "\tFetch(p string) map[string]int", "}"], 2, true],
  ["go-iface-slice-ret", "a.go", "Fetch", ["type C interface {", "\tFetch(p string) []byte", "}"], 2, true],
  ["go-iface-ptr-ret", "a.go", "Fetch", ["type C interface {", "\tFetch(p string) *Result", "}"], 2, true],
  ["go-iface-chan-ret", "a.go", "Fetch", ["type C interface {", "\tFetch(p string) <-chan int", "}"], 2, true],
  ["go-iface-func-ret", "a.go", "Fetch", ["type C interface {", "\tFetch(p string) func() error", "}"], 2, true],
  ["go-iface-multiline-params", "a.go", "Fetch", ["type C interface {", "\tFetch(", "\t\tp string,", "\t) ([]byte, error)", "}"], 2, true],
  ["rs-trait-default-body", "a.rs", "run", ["trait T {", "    fn run(&self) -> i32 { 1 }", "}"], 2, true],
  ["php-iface-method", "a.php", "run", ["interface A {", "    public function run(int $x): int;", "}"], 2, true],
];

/** classprobe2: typed initialisations whose right-hand side is a CALL (never a declaration of the callee). */
const INIT_ROWS: Array<[string, string, string[], number]> = [
  ["c-typedef-ptr-init", "report_open", ["#include \"report.h\"", "#include <stdio.h>", "int main(void) {", "  report_t *r = report_open(\"all\");", "  printf(\"%zu\\n\", report_rows(r));", "  return 0;", "}"], 4],
  ["c-int-init", "report_open", ["int main(void) {", "  int r = report_open(\"all\");", "}"], 2],
  ["c-ptr-init-nospace", "report_open", ["int main(void) {", "  report_t* r = report_open(\"all\");", "}"], 2],
  ["c-assign-existing", "report_open", ["int main(void) {", "  r = report_open(\"all\");", "}"], 2],
  ["ts-typed-init", "run", ["function f() {", "  const r: Foo = run(1);", "}"], 2],
  ["java-typed-init", "run", ["void f() {", "  Booking b = run(1);", "}"], 2],
  ["cpp-auto-init", "run", ["void f() {", "  auto b = run(1);", "}"], 2],
  ["cpp-usertype-init", "run", ["void f() {", "  Status s = run(1);", "}"], 2],
  ["cs-var-init", "Run", ["void F() {", "  var s = Run(1);", "}"], 2],
  ["cs-usertype-init", "Run", ["void F() {", "  Status s = Run(1);", "}"], 2],
  ["go-typed", "run", ["func f() {", "\tvar s Status = run(1)", "}"], 2],
];

function relPathFor(id: string): string {
  return id.startsWith("c-") ? "a.c" : id.startsWith("ts") ? "a.ts" : id.startsWith("java") ? "a.java" : id.startsWith("cpp") ? "a.cpp" : id.startsWith("cs") ? "a.cs" : "a.go";
}

/** "call" / "declaration" per occurrence of `identifier` on the target line; [] = no occurrence at all. */
function classify(relPath: string, identifier: string, lines: readonly string[], targetLine: number): string[] {
  const hash = hasHashComments(relPath);
  const masked = maskNonCode(lines[targetLine - 1]!, hash);
  return findCallOccurrences(masked, identifier).map((occurrence) =>
    callSiteOccurrenceIsDeclaration(occurrence, masked, relPath, lines, targetLine, hash) ? "declaration" : "call");
}

describe("classifier matrix, round 5 (reviewer probe cells)", () => {
  for (const [id, relPath, identifier, lines, targetLine, expectDeclaration] of ROWS) {
    it(`${id}: ${lines[targetLine - 1]!.trim()}`, () => {
      const verdicts = classify(relPath, identifier, lines, targetLine);
      if (expectDeclaration) {
        // A declaration may also be simply invisible (no call occurrence at all): never a caller either way.
        expect(verdicts.every((verdict) => verdict === "declaration")).toBe(true);
      } else {
        expect(verdicts.length, "the call site is not even an occurrence").toBeGreaterThan(0);
        expect(verdicts.every((verdict) => verdict === "call")).toBe(true);
      }
    });
  }
  for (const [id, identifier, lines, targetLine] of INIT_ROWS) {
    it(`${id}: ${lines[targetLine - 1]!.trim()}`, () => {
      const verdicts = classify(relPathFor(id), identifier, lines, targetLine);
      expect(verdicts.length).toBeGreaterThan(0);
      expect(verdicts.every((verdict) => verdict === "call")).toBe(true);
    });
  }
});
