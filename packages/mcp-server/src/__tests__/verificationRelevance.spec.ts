/**
 * verificationRelevance.spec.ts — which tests the post-edit verification kit
 * names, and how much of them its next_call asks to read (2026-10-29 field
 * report, click repo, Python).
 *
 * THE MEASURED DEFECT. After a one-line fix to the show_default help rendering
 * in src/click/core.py, the edit response's kit proposed full reads of six test
 * files (~95 KB) that merely `from click.core import ...`, and left out
 * tests/test_options.py, the test that checks the show_default output:
 *   - a test was a candidate only if its text held the edited file's basename
 *     or stem ("core.py", "core") as a bare lowercase SUBSTRING, so
 *     test_options.py (which never spells `core`) was never considered while
 *     anything containing the letters was;
 *   - the relevance gate fell back to the identifiers of the whole 3,000-line
 *     file, which every test shares;
 *   - nothing bounded how much test source next_call asked for.
 *
 * Pinned here: edit-line signals (verificationPack.mineEditSignals), symbol-only
 * candidates ranked first, token-boundary stems, the Node relative-import path
 * unchanged, and the kit's read budget end to end through the real dispatch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildVerificationManifest,
  mineEditSignals,
  resetVerificationKitDedupeForTest,
} from "../util/verificationPack.js";
import { VERIFICATION_TEST_READ_BUDGET_BYTES } from "../protocol/verificationReads.js";
import { resetRootResolverCache } from "../features/locator/locateTaskContext.js";

const workspaceDirs = new Set<string>();

beforeEach(() => {
  resetVerificationKitDedupeForTest();
});

afterEach(() => {
  for (const dir of workspaceDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  workspaceDirs.clear();
});

function mkWorkspace(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-vrel-${name}-`)));
  workspaceDirs.add(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Unrelated, plausible test functions up to roughly `bytes` of source. */
function padTests(label: string, bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const block = `def test_${label}_${i}():\n    assert ${i} + 1 == ${i + 1}\n\n`;
    lines.push(block);
    size += block.length;
  }
  return lines.join("");
}

/** src/click/core.py: several hundred lines around one show_default branch. */
function coreSource(): string {
  const filler = Array.from({ length: 110 }, (_, i) =>
    `def helper_${i}(value):\n    """Filler ${i}."""\n    total = value + ${i}\n    return total\n`).join("\n");
  return [
    '"""Core command machinery (fixture)."""',
    "from __future__ import annotations",
    "",
    "n = 1",
    "",
    "",
    "class Context:",
    "    show_default = None",
    "",
    "",
    "class Command:",
    "    def invoke(self, ctx):",
    "        return ctx",
    "",
    "",
    "class Option:",
    "    def get_help_record(self, ctx):",
    "        extra = []",
    "        default_value = self.get_default(ctx, call=False)",
    "        show_default = False",
    "        show_default_is_str = False",
    "",
    "        if self.show_default is not None:",
    "            if isinstance(self.show_default, str):",
    "                show_default_is_str = show_default = True",
    "            else:",
    "                show_default = self.show_default",
    "        elif ctx.show_default is not None:",
    "            show_default = ctx.show_default",
    "",
    "        if show_default_is_str or (show_default and (default_value is not None)):",
    "            if show_default_is_str:",
    '                default_string = f"({self.show_default})"',
    "            elif isinstance(default_value, (list, tuple)):",
    '                default_string = ", ".join(str(d) for d in default_value)',
    "            elif default_value == -1:",
    '                default_string = "unlimited"',
    "            else:",
    "                default_string = str(default_value)",
    "            if default_string:",
    '                extra.append(_("default: {default}").format(default=default_string))',
    "        return extra",
    "",
    "",
    filler,
  ].join("\n");
}

const SHOW_DEFAULT_EDIT = {
  search: "            show_default = ctx.show_default\n",
  replace: "            show_default = bool(ctx.show_default)\n",
};

const LITERAL_EDIT = {
  search: '                default_string = "unlimited"\n',
  replace: '                default_string = _("(unlimited)")\n',
};

/** The report's shape: one asserting test and six that only import click / click.core. */
function writeClickFixture(root: string, unrelatedBytes = 15000): void {
  write(root, `pyproject.toml`, '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  write(root, `.venv/bin/pytest`, "");
  write(root, `src/click/__init__.py`, "from .core import Context, Command, Option\n");
  write(root, `src/click/core.py`, coreSource());
  write(root, `tests/test_options.py`, [
    "import click",
    "",
    "",
    "def test_show_default_unlimited(runner):",
    "    @click.command()",
    '    @click.option("--limit", type=int, default=-1, show_default=True)',
    "    def cli(limit):",
    "        pass",
    "",
    '    result = runner.invoke(cli, ["--help"])',
    '    assert "[default: (unlimited)]" in result.output',
    "",
    "",
    "def test_show_default_string(runner):",
    '    option = click.Option(["--name"], default="x", show_default="shown")',
    '    assert "shown" in option.get_help_record(None)[1]',
    "",
    padTests("options", 4000),
  ].join("\n"));
  write(root, `tests/test_basic.py`, `import click\n\n${padTests("basic", unrelatedBytes)}`);
  write(root, `tests/test_commands.py`, `import click\nfrom click.core import Command\n\n${padTests("commands", unrelatedBytes)}`);
  write(root, `tests/test_context.py`, `import click\nfrom click.core import Context\n\n${padTests("context", unrelatedBytes)}`);
  write(root, `tests/test_chain.py`, `import click\nfrom click.core import Context\n\n${padTests("chain", unrelatedBytes)}`);
  write(root, `tests/test_formatting.py`, `import click\nfrom click.core import Context\n\n${padTests("formatting", unrelatedBytes)}`);
  write(root, `tests/test_parser.py`, `import click\nfrom click import core\n\n${padTests("parser", unrelatedBytes)}`);
}

const UNRELATED = [
  "tests/test_basic.py", "tests/test_commands.py", "tests/test_context.py",
  "tests/test_chain.py", "tests/test_formatting.py", "tests/test_parser.py",
];

describe("mineEditSignals — identifiers and literals on the removed and added lines only", () => {
  it("ignores context lines quoted on both sides of the hunk", () => {
    const signals = mineEditSignals([{
      search: "    def quiet_helper(self):\n        total = compute_total(items)\n        return finalize_report(total)\n",
      replace: "    def quiet_helper(self):\n        total = compute_subtotal(items)\n        return finalize_report(total)\n",
    }]);
    expect(signals.identifiers).toContain("compute_total");
    expect(signals.identifiers).toContain("compute_subtotal");
    expect(signals.identifiers).not.toContain("quiet_helper");
    expect(signals.identifiers).not.toContain("finalize_report");
  });

  it("mines string literals of the changed lines, and drops short or letterless ones", () => {
    const signals = mineEditSignals([{
      search: 'default_string = "unlimited"; sep = ", "; n = "12345678"\n',
      replace: 'default_string = _("(unlimited)"); sep = ", "; n = "12345678"\n',
    }]);
    expect(signals.literals).toEqual(expect.arrayContaining(["unlimited", "(unlimited)"]));
    expect(signals.literals).not.toContain(", ");
    expect(signals.literals).not.toContain("12345678");
  });

  it("takes only the new lines of a range item (content, no search), and counts a moved line as unchanged", () => {
    expect(mineEditSignals([{ content: "render_footer(page)\n" }]).identifiers).toEqual(["render_footer", "page"]);
    const moved = mineEditSignals([{ search: "alpha_call()\nbeta_call()\n", replace: "beta_call()\nalpha_call()\n" }]);
    expect(moved.identifiers).toEqual([]);
  });
});

describe("click report: show_default fix in a large core.py", () => {
  it("selects the test that asserts show_default first and none of the six that only import click.core", () => {
    const ws = mkWorkspace("click-first");
    writeClickFixture(ws);
    const signals = mineEditSignals([SHOW_DEFAULT_EDIT]);
    expect(signals.identifiers).toContain("show_default");

    const manifest = buildVerificationManifest(ws, ["src/click/core.py"], {
      changedIdentifiers: signals.identifiers,
      changedLiterals: signals.literals,
    });
    expect(manifest).toBeDefined();
    const paths = manifest!.surfaces.map((surface) => surface.path);
    expect(paths[0], JSON.stringify(paths)).toBe("tests/test_options.py");
    for (const unrelated of UNRELATED) expect(paths, unrelated).not.toContain(unrelated);
    // Named by what it says about the change, not by the module it never imports.
    expect(manifest!.surfaces[0]!.references).toEqual(["src/click/core.py"]);
  });

  it("admits a test by a changed string literal alone, ranked by literal and identifier strength", () => {
    const ws = mkWorkspace("click-literal");
    writeClickFixture(ws);
    write(ws, "tests/test_help_text.py", [
      "def test_unlimited_rendering(runner, cli):",
      '    assert "[default: (unlimited)]" in runner.invoke(cli, ["--help"]).output',
      "",
    ].join("\n"));
    const signals = mineEditSignals([LITERAL_EDIT]);
    expect(signals.literals).toContain("(unlimited)");

    const manifest = buildVerificationManifest(ws, ["src/click/core.py"], {
      changedIdentifiers: signals.identifiers,
      changedLiterals: signals.literals,
    });
    const paths = manifest!.surfaces.map((surface) => surface.path);
    expect(paths).toContain("tests/test_help_text.py");
    expect(paths).toContain("tests/test_options.py");
    for (const unrelated of UNRELATED) expect(paths, unrelated).not.toContain(unrelated);
  });

  it("does not admit symbol-only tests, or run the gate, on a plain one-word edit (too little signal)", () => {
    const ws = mkWorkspace("click-plain");
    writeClickFixture(ws);
    write(ws, "tests/test_plain_word.py", 'def test_value():\n    value = 1\n    assert value\n');
    const manifest = buildVerificationManifest(ws, ["src/click/core.py"], { changedIdentifiers: ["value"] });
    const paths = manifest!.surfaces.map((surface) => surface.path);
    expect(paths, "a plain word is not distinctive enough to admit a test on its own").not.toContain("tests/test_plain_word.py");
    // The gate stays inert below its signal floor: name-matched tests keep riding, as K2 pins.
    expect(paths).toContain("tests/test_context.py");
  });

  it("never admits symbol-only tests from the whole-file proxy (no mined signals)", () => {
    const ws = mkWorkspace("click-proxy");
    writeClickFixture(ws);
    const manifest = buildVerificationManifest(ws, ["src/click/core.py"]);
    const paths = manifest!.surfaces.map((surface) => surface.path);
    // test_options.py names no module token and the proxy cannot admit it; this is exactly why the edit path must mine the edit.
    expect(paths).not.toContain("tests/test_options.py");
  });
});

describe("token-boundary stem matching", () => {
  it("matches module references (from pkg.core import, import core, ./core, core.py) and not any occurrence of the letters", () => {
    const ws = mkWorkspace("boundary");
    write(ws, "pyproject.toml", "[project]\nname = 'pkg'\n");
    write(ws, "src/pkg/core.py", [
      "class Context: ...",
      "class Command: ...",
      "def invoke_command(ctx): ...",
      "def resolve_param(ctx): ...",
      "",
    ].join("\n"));
    write(ws, "tests/test_from_import.py", "from pkg.core import Context\n");
    write(ws, "tests/test_bare_import.py", "import core\nContext = core.Context\n");
    write(ws, "tests/test_relative_path.py", 'PATH = "./core"\nContext = 1\n');
    write(ws, "tests/test_file_name.py", "# see core.py for Context\n");
    write(ws, "tests/test_hardcore.py", "hardcore = 1\nContext = hardcore\n");
    write(ws, "tests/test_score.py", "from pkg.score import Context\nscoreboard = Context\n");
    write(ws, "tests/test_underscore.py", "from pkg.core_utils import Context\n");
    write(ws, "tests/test_suffix.py", "corex = 1\nContext = corex\n");

    const manifest = buildVerificationManifest(ws, ["src/pkg/core.py"]);
    const paths = new Set(manifest!.surfaces.map((surface) => surface.path));
    for (const hit of ["test_from_import", "test_bare_import", "test_relative_path", "test_file_name"]) {
      expect(paths.has(`tests/${hit}.py`), hit).toBe(true);
    }
    for (const miss of ["test_hardcore", "test_score", "test_underscore", "test_suffix"]) {
      expect(paths.has(`tests/${miss}.py`), miss).toBe(false);
    }
  });

  it("leaves native C/C++ matching and gating exactly as they were: the stem inside a longer identifier still references the module", () => {
    const ws = mkWorkspace("boundary-native");
    write(ws, "src/rtos/os_mutex.c", '#include "rtos/os_mutex.h"\nvoid os_mutex_lock(void) {}\n');
    write(ws, "include/rtos/os_mutex.h", "#pragma once\nvoid os_mutex_lock(void);\n");
    write(ws, "test/mock/stub.h", "#pragma once\n// stub\nvoid os_mutex_lock(void);\n");
    write(ws, "test/test_other_thing.cpp", "int main() { os_mutex_lock(); return 0; }\n");
    // Mined signals with a compound identifier must not start dropping native name-matched tests.
    const signals = mineEditSignals([{ search: "void os_mutex_lock(void) {}", replace: "void os_mutex_lock(void) { return; }" }]);
    const plain = buildVerificationManifest(ws, ["src/rtos/os_mutex.c"]);
    resetVerificationKitDedupeForTest();
    const mined = buildVerificationManifest(ws, ["src/rtos/os_mutex.c"], {
      changedIdentifiers: signals.identifiers,
      changedLiterals: signals.literals,
    });
    const pathsOf = (manifest: typeof plain): string[] => [
      ...manifest!.surfaces.map((surface) => surface.path),
      ...(manifest!.harness?.mock_headers ?? []).map((header) => header.path),
    ];
    expect(pathsOf(plain)).toContain("test/mock/stub.h");
    expect(pathsOf(plain)).toContain("test/test_other_thing.cpp");
    expect(pathsOf(mined)).toEqual(pathsOf(plain));
  });
});

describe("Node/TS: a relative import still selects the test", () => {
  function writeNodeFixture(ws: string): void {
    write(ws, "package.json", JSON.stringify({ name: "app", scripts: { test: "vitest run" } }));
    write(ws, "src/util.ts", [
      "export function roundCurrency(amount: number): number { return Math.round(amount * 100) / 100; }",
      "export function formatPriceWithTax(amount: number, rate: number): number { return amount * (1 + rate); }",
      "",
    ].join("\n"));
    write(ws, "src/checkout.ts", 'import { formatPriceWithTax } from "./util";\nexport const checkout = (a: number) => formatPriceWithTax(a, 0.1);\n');
    // The module's own test: imports it by a relative specifier, never says the changed name.
    write(ws, "test/util.test.ts", 'import { roundCurrency } from "../src/util";\nit("rounds", () => expect(roundCurrency(1.005)).toBe(1));\n');
    // Names the changed function through another module.
    write(ws, "test/checkout.test.ts", 'import { checkout } from "../src/checkout";\nit("adds tax", () => expect(checkout(100)).toBeCloseTo(110));\n// formatPriceWithTax(100, 0.1) is 110\n');
    // Mentions the stem in prose only; says nothing about the change.
    write(ws, "test/notes.test.ts", "// see util for details\nit('noop', () => {});\n");
    write(ws, "test/utility.test.ts", "// utility helpers only\nit('noop2', () => {});\n");
  }

  it("keeps the relative-import test with zero overlap, ranks the test that names the change first, and drops prose-only mentions", () => {
    const ws = mkWorkspace("node-direct");
    writeNodeFixture(ws);
    const signals = mineEditSignals([{
      search: "return amount * (1 + rate); }",
      replace: "return roundCurrency(amount * (1 + rate)); }",
    }]);
    expect(signals.identifiers).toContain("roundCurrency");

    const manifest = buildVerificationManifest(ws, ["src/util.ts"], {
      changedIdentifiers: signals.identifiers,
      changedLiterals: signals.literals,
    });
    expect(manifest).toBeDefined();
    const paths = manifest!.surfaces.map((surface) => surface.path);
    expect(paths).toContain("test/util.test.ts");
    expect(paths).not.toContain("test/notes.test.ts");
    expect(paths).not.toContain("test/utility.test.ts");
    // test/util.test.ts holds the changed identifier AND imports the module; the other names neither.
    expect(paths[0]).toBe("test/util.test.ts");
  });

  it("selects a test that holds the changed compound identifier but imports another module (symbol-only), ahead of a bare importer", () => {
    const ws = mkWorkspace("node-symbol");
    writeNodeFixture(ws);
    const signals = mineEditSignals([{
      search: "export function formatPriceWithTax(amount: number, rate: number): number { return amount * (1 + rate); }",
      replace: "export function formatPriceWithTax(amount: number, rate: number): number { return amount * (1 + rate) + 0; }",
    }]);
    const manifest = buildVerificationManifest(ws, ["src/util.ts"], {
      changedIdentifiers: signals.identifiers,
      changedLiterals: signals.literals,
    });
    const paths = manifest!.surfaces.map((surface) => surface.path);
    expect(paths[0]).toBe("test/checkout.test.ts");
    expect(paths).toContain("test/util.test.ts");
  });
});

// ---------------------------------------------------------------------------
// End to end through the real dispatch: the edit response's kit.
// ---------------------------------------------------------------------------
type Body = Record<string, unknown>;
type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

describe("edit response kit: next_call stays within the optional test read budget", () => {
  let ws: string;
  let callTool: (name: string, args: Body) => Promise<ToolResult>;
  const previousRoot = process.env["TOKENLIGHTEN_ROOT"];

  beforeAll(async () => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tl-vrel-e2e-")));
    if (!process.argv.includes("--allow-write")) process.argv.push("--allow-write");
    process.env["TOKENLIGHTEN_ROOT"] = ws;
    const server = await import("../server.js");
    callTool = server.callTool as typeof callTool;
  });

  beforeEach(async () => {
    const { resetAll } = await import("../state/session.js");
    resetAll();
    const { handleTable } = await import("../util/handles.js");
    handleTable.reset();
  });

  afterAll(() => {
    if (previousRoot === undefined) delete process.env["TOKENLIGHTEN_ROOT"];
    else process.env["TOKENLIGHTEN_ROOT"] = previousRoot;
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function edit(args: Body): Promise<Body> {
    const result = await callTool("tl_edit_file", args);
    return JSON.parse(result.content[0]?.text ?? "{}") as Body;
  }

  /** Bytes of every handle the kit's next_call would read, by the surfaces that carry them. */
  function nextCallBytes(verification: Body): { handles: string[]; bytes: number } {
    // The wire spells the batched read as `handles` or as `targets: [{handle}]`.
    const call = verification["next_call"] as { arguments?: { handles?: string[]; targets?: Array<{ handle?: string }> } } | undefined;
    const handles = call?.arguments?.handles
      ?? (call?.arguments?.targets ?? []).flatMap((target) => (typeof target.handle === "string" ? [target.handle] : []));
    const surfaces = (verification["surfaces"] ?? []) as Array<{ handle: string; bytes: number }>;
    const bytes = handles.reduce((sum, handle) => sum + (surfaces.find((s) => s.handle === handle)?.bytes ?? 0), 0);
    return { handles, bytes };
  }

  it("reads a top-level search/replace, edits[] items and a range item's content, and ignores creates", async () => {
    const { verificationSignalsFromEditArgs } = await import("../server.js");
    expect(verificationSignalsFromEditArgs({ search: "alpha_old()\nkeep_context()", replace: "alpha_new()\nkeep_context()" }).identifiers)
      .toEqual(expect.arrayContaining(["alpha_old", "alpha_new"]));
    const batch = verificationSignalsFromEditArgs({
      edits: [
        { path: "a.py", search: 'label = "old message"', replace: 'label = "new message"' },
        { handle: "h1", range: { from: 3, to: 4 }, content: "render_footer(page)" },
        { path: "fresh.py", create: true, content: "brand_new_module_symbol = 1" },
      ],
    });
    expect(batch.identifiers).toEqual(expect.arrayContaining(["label", "render_footer"]));
    expect(batch.identifiers).not.toContain("brand_new_module_symbol");
    expect(batch.literals).toEqual(expect.arrayContaining(["old message", "new message"]));
    expect(verificationSignalsFromEditArgs({ path: "a.py" })).toEqual({ identifiers: [], literals: [] });
  });

  it("a show_default edit names test_options.py first and proposes no unrelated test, within the budget", async () => {
    const root = "click1";
    writeClickFixture(path.join(ws, root));
    resetRootResolverCache();
    const applied = await edit({
      path: `${root}/src/click/core.py`,
      search: SHOW_DEFAULT_EDIT.search,
      replace: SHOW_DEFAULT_EDIT.replace,
      precondition: "unique-match",
      allowPathFallback: false,
    });
    expect(applied["kind"], JSON.stringify(applied).slice(0, 600)).toBe("edit.applied");
    const verification = applied["verification"] as Body;
    expect(verification, JSON.stringify(applied).slice(0, 600)).toBeDefined();
    const surfaces = verification["surfaces"] as Array<{ path: string; bytes: number; handle: string }>;
    expect(surfaces[0]!.path).toBe(`${root}/tests/test_options.py`);
    for (const unrelated of UNRELATED) expect(surfaces.map((s) => s.path)).not.toContain(`${root}/${unrelated}`);
    const proposed = nextCallBytes(verification);
    expect(proposed.handles, "the asserting test is what the batched read asks for").toContain(surfaces[0]!.handle);
    expect(proposed.bytes).toBeLessThanOrEqual(VERIFICATION_TEST_READ_BUDGET_BYTES);
  });

  it("an edit that mines no signal falls back to name-matched tests, and next_call still stays within the budget", async () => {
    const root = "click2";
    writeClickFixture(path.join(ws, root));
    resetRootResolverCache();
    const applied = await edit({
      path: `${root}/src/click/core.py`,
      search: "\nn = 1\n",
      replace: "\nn = 2\n",
      precondition: "unique-match",
      allowPathFallback: false,
    });
    expect(applied["kind"], JSON.stringify(applied).slice(0, 600)).toBe("edit.applied");
    const verification = applied["verification"] as Body;
    const surfaces = verification["surfaces"] as Array<{ path: string; bytes: number }>;
    const unrelatedSelected = surfaces.filter((s) => UNRELATED.some((u) => s.path.endsWith(u)));
    expect(unrelatedSelected.length, "the fallback proxy keeps name-matched tests, which is what the budget must bound").toBeGreaterThan(1);
    const totalOffered = unrelatedSelected.reduce((sum, s) => sum + s.bytes, 0);
    expect(totalOffered).toBeGreaterThan(VERIFICATION_TEST_READ_BUDGET_BYTES);
    const proposed = nextCallBytes(verification);
    expect(proposed.bytes, JSON.stringify(proposed)).toBeLessThanOrEqual(VERIFICATION_TEST_READ_BUDGET_BYTES);
    expect(proposed.handles.length, "the budget keeps the first test, not all of them").toBeGreaterThan(0);
    expect(proposed.handles.length).toBeLessThan(unrelatedSelected.length);
    // The paths and the run command still ride: the run command is the check.
    expect((verification["toolchain"] as Body | undefined)?.["test_entry"]).toBe("pytest");
  });

  it("when even the first optional test exceeds the budget, no test body is requested and the note names only the run command", async () => {
    const root = "node3";
    const base = path.join(ws, root);
    write(base, "package.json", '{"name":"app","scripts":{"test":"node --test"}}\n');
    write(base, "src/util.ts", "export const rate = 1;\n");
    const bigTest = (label: string): string => [
      'import { rate } from "../src/util";',
      ...Array.from({ length: 600 }, (_, i) => `it("${label} ${i}", () => { void rate; });`),
      "",
    ].join("\n");
    for (const label of ["alpha", "beta", "gamma"]) write(base, `test/${label}.test.ts`, bigTest(label));
    resetRootResolverCache();
    const applied = await edit({
      path: `${root}/src/util.ts`,
      search: "export const rate = 1;",
      replace: "export const rate = 2;",
      precondition: "unique-match",
      allowPathFallback: false,
    });
    expect(applied["kind"], JSON.stringify(applied).slice(0, 600)).toBe("edit.applied");
    const verification = applied["verification"] as Body;
    const surfaces = verification["surfaces"] as Array<{ path: string; bytes: number; body?: string }>;
    expect(surfaces.length).toBe(3);
    expect(surfaces.every((s) => s.bytes > VERIFICATION_TEST_READ_BUDGET_BYTES && s.body === "omitted")).toBe(true);
    expect(verification["next_call"], "no optional test body is requested past the budget").toBeUndefined();
    expect(String(verification["note"])).toContain('run "npm test"');
    expect(String(verification["note"])).toContain("other listed test source is optional");
  });
});
