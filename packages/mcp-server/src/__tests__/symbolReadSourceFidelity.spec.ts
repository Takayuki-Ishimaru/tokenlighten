/**
 * symbolReadSourceFidelity.spec.ts — a `targets:[{path, symbol}]` read ships the
 * symbol's own source lines, whatever the file's comments look like.
 *
 * THE DEFECT (external evaluation of v0.16.4, flask `handle_url_build_error`,
 * `create_url_adapter`). A Python method with a docstring came back as
 * `range:"982-1014"` over a body that opened with `# tokenlighten:scope …`, the
 * imports, the enclosing scope and sibling signatures, then
 * `# doc elided L12-27`, and went straight into the docstring text. The
 * method's `def` line (a multi-line signature) was gone, and `L12-27` named no
 * real lines.
 *
 * ROOT CAUSE. A symbol read is an assembled view: scope header, used imports,
 * enclosing scope, sibling signatures, a `target:` label, then the symbol's
 * source. Its sibling list is the enclosing class's skeleton cut to 12 LINES —
 * and that skeleton keeps doc blocks (the class's own docstring in Python, every
 * sibling's JSDoc/Javadoc), so the cut landed inside a block and left its opener
 * unclosed. The default comment policy then ran the doc-comment elider over the
 * WHOLE view, and the elider closes a block at the next delimiter it finds: the
 * target's own docstring (or JSDoc) opening. Everything between collapsed into
 * one marker with view-relative numbers, the `target:` label with it. The wire's
 * source-fidelity seam splits the view on that label (`protocol/sourceFidelity.ts`
 * `faithfulAssembledView`), found none, and left the unverified view as `body`.
 * The same shape broke TypeScript/JavaScript (JSDoc) and Java (Javadoc).
 *
 * THE CONTRACT: `body.split("\n") === sourceLines[lo-1 .. hi-1]` for `range`
 * "lo-hi", with the TL annotations (scope header, imports, enclosing scope,
 * sibling signatures) in `note`, never in `body`.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { elideSymbolContextForDisplay, getSymbolWithContext } from "../tools/getSymbolWithContext.js";
import { compressFormat, elideDocComments } from "../util/formatCompress.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";

const HOME = os.homedir();

// A class whose docstring alone is longer than the 12-line sibling cap, with a
// multi-line signature + docstring method, decorated methods and a nested class.
const PY_SHOP = [
  '"""Shop module."""',
  "import sys",
  "import typing as t",
  "",
  "",
  "class Base:",
  '    """The base class.',
  "",
  "    It has a long docstring so that the sibling extraction",
  "    cuts it in the middle of the block.",
  "    Line 5 of the docstring.",
  "    Line 6 of the docstring.",
  "    Line 7 of the docstring.",
  "    Line 8 of the docstring.",
  "    Line 9 of the docstring.",
  "    Line 10 of the docstring.",
  "    Line 11 of the docstring.",
  "    Line 12 of the docstring.",
  "    Line 13 of the docstring.",
  '    """',
  "",
  "    def helper(self) -> int:",
  "        return 1",
  "",
  "    def handle_error(",
  "        self, error: Exception, endpoint: str, values: dict[str, t.Any]",
  "    ) -> str:",
  '        """Handle an error.',
  "",
  "        Longer description here.",
  "",
  "        :param error: the error.",
  '        """',
  "        for item in values:",
  "            if item == endpoint:",
  "                return sys.argv[0]",
  "",
  "        raise error",
  "",
  "    @property",
  "    def name(self) -> str:",
  '        """The name."""',
  '        return "base"',
  "",
  "    @staticmethod",
  '    def make(value: int) -> "Base":',
  '        """Create one.',
  "",
  "        Details.",
  '        """',
  "        return Base()",
  "",
  "    class Inner:",
  '        """Nested class."""',
  "",
  "        def deep(self) -> int:",
  '            """Deep method.',
  "",
  "            More.",
  '            """',
  "            return 3",
  "",
  "",
  "class Child(Base):",
  "    def handle_error(self, error, endpoint, values):",
  '        """Child override.',
  "",
  "        Different text.",
  '        """',
  "        return endpoint",
  "",
].join("\n");

// The class docstring is above the class line, as in TS: each method carries its own JSDoc.
const TS_SHOP = [
  'import { readFileSync } from "node:fs";',
  "",
  "/**",
  " * The base class. A long JSDoc block that goes on",
  " * and on, so the sibling cap can cut it.",
  " * Line 4.",
  " * Line 5.",
  " * Line 6.",
  " * Line 7.",
  " */",
  "export class Base {",
  "  /**",
  "   * Helper docs.",
  "   * Second line.",
  "   * Third line.",
  "   */",
  "  helper(): number {",
  "    return 1;",
  "  }",
  "",
  "  /**",
  "   * Handle an error.",
  "   *",
  "   * @param error the error",
  "   * @param endpoint the endpoint",
  "   */",
  "  handleError(",
  "    error: Error,",
  "    endpoint: string,",
  "  ): string {",
  '    const text = readFileSync(endpoint, "utf8");',
  "    if (text) {",
  "      return text;",
  "    }",
  "    throw error;",
  "  }",
  "",
  "  /**",
  "   * Another one.",
  "   * Another second.",
  "   * Another third.",
  "   * Another fourth.",
  "   */",
  "  other(): number {",
  "    return 2;",
  "  }",
  "}",
  "",
].join("\n");

const JAVA_SHOP = [
  "package shop;",
  "",
  "import java.util.List;",
  "",
  "/**",
  " * The base class. A long Javadoc block that goes on",
  " * and on, so the sibling cap can cut it.",
  " * Line 4.",
  " * Line 5.",
  " */",
  "public class Shop {",
  "    /**",
  "     * Helper docs.",
  "     * Second line.",
  "     * Third line.",
  "     */",
  "    public int helper() {",
  "        return 1;",
  "    }",
  "",
  "    /**",
  "     * Handle an error.",
  "     *",
  "     * @param error the error",
  "     * @param endpoint the endpoint",
  "     */",
  "    public String handleError(",
  "        Exception error,",
  "        String endpoint",
  "    ) throws Exception {",
  "        List<String> items = List.of(endpoint);",
  "        for (String i : items) {",
  "            return i;",
  "        }",
  "        throw error;",
  "    }",
  "",
  "    public int other() {",
  "        return 2;",
  "    }",
  "}",
  "",
].join("\n");

const GO_SHOP = [
  "package shop",
  "",
  'import "fmt"',
  "",
  "// Base is the base type.",
  "type Base struct {",
  "\tname string",
  "}",
  "",
  "// Handle handles an error.",
  "//",
  "// It has several lines of doc comment.",
  "func (b *Base) Handle(err error, endpoint string) string {",
  "\tfmt.Println(endpoint)",
  "\tif err != nil {",
  "\t\treturn err.Error()",
  "\t}",
  "\treturn b.name",
  "}",
  "",
].join("\n");

// The same module without the subclass, so `handle_error` names one symbol.
const PY_BASE_ONLY = `${PY_SHOP.split("\n\nclass Child(Base):")[0]}\n`;

// A tiny file (no scope header, no label): the symbol is a nested function the AST collector
// does not list, so the view ends in the AST-fallback note.
const JS_TINY = [
  "module.exports = function render(fileName, callback) {",
  "  function onRead(err, str) {",
  "    if (err) {",
  "      callback(err);",
  "      return;",
  "    }",
  "",
  "    callback(null, str);",
  "  }",
  "",
  '  require("node:fs").readFile(fileName, "utf8", onRead);',
  "};",
  "",
].join("\n");

const FILES: Readonly<Record<string, string>> = {
  "base.py": PY_BASE_ONLY,
  "shop.py": PY_SHOP,
  // The flask clone the report was made on is checked out with CRLF line endings.
  "crlf.py": PY_BASE_ONLY.replace(/\n/g, "\r\n"),
  "shop.ts": TS_SHOP,
  "Shop.java": JAVA_SHOP,
  "shop.go": GO_SHOP,
  "tiny.js": JS_TINY,
};

const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});

function workspace(files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-symfid-"));
  dirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function start(ws: string): Promise<ServerHandle> {
  const server = startDevServer(ws, "default", { toolSurface: "full" });
  servers.push(server);
  await server.initialize();
  return server;
}

/** Python's `str.splitlines()`: a final newline terminates the last line. */
function splitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (/(?:\r\n|\r|\n)$/.test(text)) lines.pop();
  return lines;
}

/** 1-based number of the first line of `source` that is exactly `needle` (trailing `\r` ignored). */
function lineOf(source: string, needle: string): number {
  const at = splitlines(source).findIndex((line) => line === needle);
  if (at < 0) throw new Error(`fixture has no line ${JSON.stringify(needle)}`);
  return at + 1;
}

type Row = Record<string, any>;

interface Case {
  readonly name: string;
  readonly file: string;
  readonly symbol: string;
  /** The exact first source line the read must start at (a decorator, doc block opener or `def`). */
  readonly firstLine: string;
  /** Last source line of the symbol, when the test pins it. */
  readonly lastLine?: string;
  /** Which occurrence: some first lines (a docstring close) repeat. */
  readonly skipBefore?: string;
  /** What `note` must look like (default: the scope header). */
  readonly note?: RegExp;
}

const CASES: readonly Case[] = [
  { name: "python method: multi-line signature + docstring, in a class whose docstring fills the sibling cap", file: "base.py", symbol: "handle_error", firstLine: "    def handle_error(", lastLine: "        raise error", skipBefore: "    def helper(self) -> int:" },
  { name: "python @property method", file: "base.py", symbol: "name", firstLine: "    @property", lastLine: '        return "base"' },
  { name: "python @staticmethod method", file: "base.py", symbol: "make", firstLine: "    @staticmethod", lastLine: "        return Base()" },
  { name: "python method of a nested class", file: "base.py", symbol: "deep", firstLine: "        def deep(self) -> int:", lastLine: "            return 3" },
  { name: "python nested class", file: "base.py", symbol: "Inner", firstLine: "    class Inner:", lastLine: "            return 3" },
  { name: "python method of a base class (qualified: Base.handle_error, the subclass overrides it)", file: "shop.py", symbol: "Base.handle_error", firstLine: "    def handle_error(", lastLine: "        raise error", skipBefore: "    def helper(self) -> int:" },
  { name: "python method of the subclass that overrides it", file: "shop.py", symbol: "Child.handle_error", firstLine: "    def handle_error(self, error, endpoint, values):", lastLine: "        return endpoint" },
  { name: "python on a CRLF file", file: "crlf.py", symbol: "handle_error", firstLine: "    def handle_error(", lastLine: "        raise error", skipBefore: "    def helper(self) -> int:" },
  { name: "typescript method with JSDoc and a multi-line signature", file: "shop.ts", symbol: "handleError", firstLine: "   * Handle an error.", lastLine: "  }", skipBefore: "  helper(): number {" },
  { name: "java method with Javadoc and a multi-line signature", file: "Shop.java", symbol: "handleError", firstLine: "     * Handle an error.", lastLine: "    }", skipBefore: "    public int helper() {" },
  { name: "tiny file, symbol found without the AST: the AST-fallback note is metadata, not a body line", file: "tiny.js", symbol: "onRead", firstLine: "  function onRead(err, str) {", lastLine: "  }", note: /^\/\/ note: AST-fallback mode/ },
  { name: "go method (its `//` doc comment is not part of the symbol range)", file: "shop.go", symbol: "Handle", firstLine: "func (b *Base) Handle(err error, endpoint string) string {", lastLine: "}" },
];

/** The first source line number a case's read must start at. */
function expectedStart(source: string, c: Case): number {
  const lines = splitlines(source);
  const from = c.skipBefore === undefined ? 0 : lines.findIndex((line) => line === c.skipBefore);
  const at = lines.findIndex((line, index) => index >= from && line === c.firstLine);
  if (at < 0) throw new Error(`fixture has no line ${JSON.stringify(c.firstLine)}`);
  // A doc-block opener sits on the line before its first text line.
  return c.file.endsWith(".ts") || c.file.endsWith(".java") ? at : at + 1;
}

function assertFaithful(row: Row, source: string): [number, number] {
  const [lo, hi] = String(row["range"]).split("-").map(Number) as [number, number];
  const body = String(row["body"]);
  expect(splitlines(body), `body of ${String(row["path"])}@${lo}-${hi}`).toEqual(splitlines(source).slice(lo - 1, hi));
  expect(body).not.toMatch(/tokenlighten:scope/);
  expect(body).not.toMatch(/doc elided L\d+-\d+/);
  expect(body).not.toMatch(/\n(?:\/\/|#) target:\n/);
  expect(body).not.toMatch(/AST-fallback mode/);
  return [lo, hi];
}

describe("symbol read: body is the file's lines for `range`, annotations are in `note`", () => {
  for (const c of CASES) {
    it(`targets:[{path, symbol}] — ${c.name}`, async () => {
      const ws = workspace(FILES);
      const server = await start(ws);
      const { body } = await server.callTool("tl_read_file", { targets: [{ path: c.file, symbol: c.symbol }], cwd: ws });
      expect(body.kind, JSON.stringify(body).slice(0, 300)).toBe("read.text");
      expect(body.evidence).toHaveLength(1);
      const row = body.evidence[0] as Row;
      const source = FILES[c.file]!;
      const [lo, hi] = assertFaithful(row, source);
      expect(lo).toBe(expectedStart(source, c));
      if (c.lastLine !== undefined) expect(splitlines(source)[hi - 1]).toBe(c.lastLine);
      // The first body line is the symbol's own first line, not an annotation.
      expect(splitlines(String(row["body"]))[0]).toBe(splitlines(source)[lo - 1]);
      // The context the view assembled is still on the wire, as metadata.
      if (row["note"] !== undefined) expect(String(row["note"])).toMatch(c.note ?? /^(?:\/\/|#) tokenlighten:scope path=/);
    }, 90_000);
  }

  it("a symbol read with comments:\"keep\" is faithful too", async () => {
    const ws = workspace(FILES);
    const server = await start(ws);
    const { body } = await server.callTool("tl_read_file", {
      targets: [{ path: "base.py", symbol: "handle_error" }],
      select: { comments: "keep" },
      cwd: ws,
    });
    expect(body.kind).toBe("read.text");
    const [lo] = assertFaithful(body.evidence[0], PY_BASE_ONLY);
    expect(lo).toBe(lineOf(PY_BASE_ONLY, "    def handle_error("));
  }, 90_000);

  it("several symbols in one call: every entry is faithful", async () => {
    const ws = workspace(FILES);
    const server = await start(ws);
    const { body } = await server.callTool("tl_read_file", {
      targets: [
        { path: "base.py", symbol: "handle_error" },
        { path: "base.py", symbol: "make" },
        { path: "shop.ts", symbol: "handleError" },
        { path: "Shop.java", symbol: "handleError" },
      ],
      cwd: ws,
    });
    const rows = [...(body.evidence ?? []), ...(body.entries ?? [])] as Row[];
    const texts = rows.filter((row) => typeof row["body"] === "string" || typeof row["content"] === "string");
    expect(texts.length, JSON.stringify(body).slice(0, 400)).toBeGreaterThanOrEqual(4);
    for (const row of texts) {
      const normalized = { ...row, body: row["body"] ?? row["content"] };
      assertFaithful(normalized, FILES[String(row["path"])]!);
    }
  }, 90_000);
});

describe("the assembled view's two parts are elided apart", () => {
  const TARGET = [
    "    def f(",
    "        self, a: int",
    "    ) -> str:",
    '        """Doc.',
    "",
    "        More.",
    '        """',
    "        return 1",
  ].join("\n");
  // What the 12-line sibling cap used to leave behind: a docstring opened, never closed.
  const HALF_OPEN_PREAMBLE = [
    "# tokenlighten:scope path=x.py symbol=f lang=python",
    "",
    "# sibling signatures:",
    "class A:",
    '  """A class docstring the cap cut off',
    "      second line",
    "",
    "# target:",
  ].join("\n");

  it("mechanism: the doc-comment elider pairs a half-open preamble block with the target's own opener", () => {
    const whole = elideDocComments(`${HALF_OPEN_PREAMBLE}\n${TARGET}`, "python");
    expect(whole).toMatch(/# doc elided L5-\d+/);
    expect(whole).not.toContain("# target:");
    expect(whole).not.toContain("    def f(");
  });

  it("the target part is elided exactly as the same lines are on their own, whatever the preamble holds", () => {
    const shown = elideSymbolContextForDisplay(`${HALF_OPEN_PREAMBLE}\n${TARGET}`, "python").content;
    const [preamble, target] = shown.split("\n# target:\n") as [string, string];
    expect(preamble.startsWith("# tokenlighten:scope path=x.py")).toBe(true);
    // Marker numbers are view-relative: the target's first line follows the preamble's last (the label).
    expect(target).toBe(elideDocComments(TARGET, "python", HALF_OPEN_PREAMBLE.split("\n").length + 1));
    expect(target.startsWith("    def f(\n        self, a: int\n    ) -> str:\n")).toBe(true);
  });

  it("a JSDoc block left open in the preamble cannot take the target's JSDoc or its label with it", () => {
    const target = ["  /**", "   * Handle an error.", "   */", "  handleError(): string {", "    return '';", "  }"].join("\n");
    const preamble = ["// tokenlighten:scope path=x.ts symbol=handleError lang=typescript", "", "// sibling signatures:", "export class Base {", "  /**", "     * Handle an error.", "     * @param error", "", "// target:"].join("\n");
    const shown = elideSymbolContextForDisplay(`${preamble}\n${target}`, "typescript").content;
    const parts = shown.split("\n// target:\n");
    expect(parts).toHaveLength(2);
    // Marker numbers are view-relative: the target's first line follows the preamble's last (the label).
    expect(parts[1]).toBe(elideDocComments(target, "typescript", preamble.split("\n").length + 1));
    expect(parts[1]).toContain("handleError(): string {");
  });

  it("a view with no label (a tiny file's bare body) is elided as one text", () => {
    const bare = '    def f(self):\n        """Doc.\n\n        More.\n        """\n        return 1';
    expect(elideSymbolContextForDisplay(bare, "python").content).toBe(elideDocComments(bare, "python"));
  });

  it("the sibling list never ends inside a doc block (a cut docstring or JSDoc is dropped, not left open)", async () => {
    for (const [file, source, symbol, lang] of [
      ["base.py", PY_BASE_ONLY, "handle_error", "python"],
      ["shop.ts", TS_SHOP, "handleError", "typescript"],
      ["Shop.java", JAVA_SHOP, "handleError", "java"],
    ] as const) {
      const result = await getSymbolWithContext(source, { path: file, symbol });
      expect(result.ok, file).toBe(true);
      if (!result.ok) continue;
      const code = result.data.code;
      const label = code.split("\n").findIndex((line) => /^(?:\/\/|#) target:$/.test(line));
      expect(label, `${file} has a target label`).toBeGreaterThan(0);
      const preamble = code.split("\n").slice(0, label).join("\n");
      if (lang === "python") {
        expect((preamble.match(/"""/g) ?? []).length % 2, `${file}: docstring delimiters in the preamble pair up`).toBe(0);
      } else {
        expect((preamble.match(/\/\*/g) ?? []).length, `${file}: every /* in the preamble closes`).toBe((preamble.match(/\*\//g) ?? []).length);
      }
      // The part after the label is the symbol's source, line for line.
      const [lo, hi] = [result.data.range.start, result.data.range.end];
      expect(code.split("\n").slice(label + 1).join("\n")).toBe(compressFormat(splitlines(source).slice(lo - 1, hi).join("\n")));
    }
  });
});
