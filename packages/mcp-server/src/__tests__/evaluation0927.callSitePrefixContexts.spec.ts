/**
 * evaluation0927.callSitePrefixContexts.spec.ts — call sites the round-4
 * classifier (callSiteClassificationMatrix.spec.ts) misread as declarations
 * because of the word or group in FRONT of the name (orchestrator probe,
 * 2026-09-28). A dropped call site can turn a callers facet into a false
 * `request-item-empty`, so each shape is fenced here with its declaration
 * counterpart.
 *
 *   - a cast: `(void) f(x);`, `return (int) f(x);` — the keyword sits inside a
 *     closed paren group, never a declaration head;
 *   - `export default f(x);` — exports an expression;
 *   - expression statements led by an operator/statement word with a bare `;`
 *     after the call (`assert f(x);`, `co_await f(x);`) — read as a
 *     `<type> f(x);` prototype;
 *   - PHP `echo f($a);` / `print f($a);` — PHP declares functions only with
 *     `function`.
 */
import { describe, expect, it } from "vitest";

import { callSiteOccurrenceIsDeclaration, isDeclarationShapedMatchText } from "../features/task-pack/readCodeTaskPack.js";
import { findCallOccurrences, maskNonCode } from "../features/task-pack/callerExpansion.js";

function classify(relPath: string, member: string, line: string): string[] {
  const masked = maskNonCode(line, false);
  return findCallOccurrences(masked, member).map((occurrence) =>
    callSiteOccurrenceIsDeclaration(occurrence, masked, relPath, [line], 1, false) ? "declaration" : "call");
}

const CALLS: ReadonlyArray<readonly [string, string, string]> = [
  ["a.c", "cancel", "  (void) cancel(id);"],
  ["a.c", "cancel", "  (void)cancel(id);"],
  ["a.c", "cancel", "  x = (int) cancel(id);"],
  ["a.java", "cancel", "    return (int) cancel(id);"],
  ["a.cs", "Cancel", "    var n = (int)Cancel(id);"],
  ["a.ts", "withRouter", "export default withRouter(App);"],
  ["a.tsx", "connect", "export default connect(mapState)(App);"],
  ["a.ts", "cancel", "  export default cancel(id);"],
  ["a.java", "cancel", "    assert cancel(id);"],
  ["a.cpp", "cancel", "  co_await cancel(id);"],
  ["a.cpp", "cancel", "  co_return cancel(id);"],
  ["a.cpp", "cancel", "  not cancel(id);"],
  ["a.php", "cancel", "  echo cancel($id);"],
  ["a.php", "cancel", "  print cancel($id);"],
  ["a.php", "cancel", "  cancel($id);"],
];

const DECLARATIONS: ReadonlyArray<readonly [string, string, string]> = [
  ["a.c", "cancel", "  static int cancel(int id);"],
  ["a.c", "report_open", "report_t *report_open(const char *path);"],
  ["a.c", "cancel", "void cancel(int id);"],
  ["a.java", "cancel", "    void cancel(String id);"],
  ["a.java", "cancel", "    public void cancel(String id);"],
  ["a.cs", "Cancel", "    Task Cancel(int id);"],
  ["a.cpp", "cancel", "  virtual void cancel(int id) = 0;"],
  ["a.ts", "cancel", "  cancel(id: string): void;"],
  ["a.ts", "main", "export default async function main() {"],
  ["a.go", "FetchJSON", "func (m *MemoryClient) FetchJSON(pathname string) ([]byte, error) {"],
  ["a.php", "cancel", "  public function cancel($id);"],
  ["a.php", "cancel", "  public function cancel($id) {"],
];

describe("call sites after a cast, `export default`, or an expression-statement word stay call sites", () => {
  for (const [relPath, member, line] of CALLS) {
    it(`${relPath}: ${line.trim()}`, () => {
      expect(classify(relPath, member, line)).toEqual(["call"]);
    });
  }
});

describe("their declaration counterparts stay declarations", () => {
  for (const [relPath, member, line] of DECLARATIONS) {
    it(`${relPath}: ${line.trim()}`, () => {
      expect(classify(relPath, member, line)).toEqual(["declaration"]);
    });
  }
});

describe("the focal ranking signal (`isDeclarationShapedMatchText`) agrees on casts and `export default`", () => {
  it("a cast or an exported expression is not declaration-shaped", () => {
    expect(isDeclarationShapedMatchText("  (void) cancel(id);", "cancel")).toBe(false);
    expect(isDeclarationShapedMatchText("    return (int) cancel(id);", "cancel")).toBe(false);
    expect(isDeclarationShapedMatchText("export default withRouter(App);", "withRouter")).toBe(false);
  });
  it("declarations keep their signal", () => {
    expect(isDeclarationShapedMatchText("  static int cancel(int id);", "cancel")).toBe(true);
    expect(isDeclarationShapedMatchText("export default async function main() {", "main")).toBe(true);
    expect(isDeclarationShapedMatchText("func (m *MemoryClient) FetchJSON(pathname string) ([]byte, error) {", "FetchJSON")).toBe(true);
  });
});

describe("Go: a line-leading name inside an interface body is a method spec; the same text in a function body is a call", () => {
  function classifyAt(lines: string[], line: number, member: string): string[] {
    const masked = maskNonCode(lines[line - 1]!, false);
    return findCallOccurrences(masked, member).map((occurrence) =>
      callSiteOccurrenceIsDeclaration(occurrence, masked, "a.go", lines, line, false) ? "declaration" : "call");
  }
  it("void interface member `Close()` → declaration", () => {
    expect(classifyAt(["type Closer interface {", "\tClose()", "}"], 2, "Close")).toEqual(["declaration"]);
  });
  it("`Close()` as a statement in a function body → call", () => {
    expect(classifyAt(["func shutdown(c Closer) {", "\tClose()", "}"], 2, "Close")).toEqual(["call"]);
  });
  it("a nested block inside a function inside a file with an interface → still a call", () => {
    expect(classifyAt(["type Closer interface {", "\tClose()", "}", "func run() {", "\tif ok {", "\t\tClose()", "\t}", "}"], 6, "Close")).toEqual(["call"]);
  });
});
