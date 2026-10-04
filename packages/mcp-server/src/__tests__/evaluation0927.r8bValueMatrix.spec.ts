/**
 * evaluation0927.r8bValueMatrix.spec.ts — R8-B (round-8 wave, 2026-09-28):
 * regression coverage for review-findings-fable-r7.md's P0/P1/P2 value-facet
 * items this agent owns (brief-round8.md "R8-B — values"): B1 (P1-6,
 * pyStarImportLowerConst/csUsingStaticPascalConst/cppScopedConst — a WILDCARD
 * import specifier never "names" a queried identifier, and a disclosure never
 * names the focal's own parameters/loop-catch-comprehension-lambda variables/
 * keyword-argument names/locals/own type), B2 (P1-5, ktStarImportLowerConst/
 * javaStaticStarImportConst/csUsingStaticPascalConst's TimeoutMs — a TYPE
 * wildcard import resolves an otherwise-bare name through its owner's body),
 * B3 (P1-4/P2-9, cjsRequireModuleConst/cjsDestructureConst/
 * tsDefaultImportObjectConst — a `require()`/default-import module alias is
 * never itself served as a value, and its member is resolved through the
 * module's own exports), B4 (P2-9, rustUseConstPlain/rustImplConstOtherType —
 * a bare Rust `use`-bound constant resolves through its module, and a
 * `impl Owner { … }` block is searched as part of Owner's own body).
 *
 * THE ROUND-8 LESSON: this matrix is built from the FINDING CLASS, not only
 * the reviewer's own reported shapes — every fixture below is written FRESH
 * (different names, different files, different wording) so a fix that only
 * special-cases the reviewer's exact identifiers still fails here.
 *
 * Fast, no-server unit tests first (the pure evidenceClosure.ts functions
 * this wave added/widened); spawned dev-server end-to-end matrix cells follow.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  followNextToEnd,
  startDevServer,
  type ChainResult,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import {
  findModuleConstantWindow,
  findModuleExportsMemberWindow,
  focalParameterNames,
  importSpecifiersNaming,
  isRequireModuleInitializer,
  transientBindingNamesIn,
} from "../features/task-pack/evidenceClosure.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r8b-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function spawnedServer(ws: string): Promise<ServerHandle> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  return s;
}

async function ask(ws: string, query: string, hopCap = 14): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return followNextToEnd(
    s,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap },
  );
}

function decisionOf(response: unknown): any {
  return (response as any)?.decision ?? {};
}

function gapRefs(response: unknown): string[] {
  const gaps = decisionOf(response).certificate?.gaps ?? decisionOf(response).gaps ?? [];
  const out: string[] = [];
  for (const g of gaps) {
    if (typeof g === "string") out.push(g);
    else if (Array.isArray(g?.refs)) out.push(...g.refs);
    else if (g && typeof g === "object") out.push(JSON.stringify(g));
  }
  return out;
}

function evidenceOf(response: unknown): any[] {
  return ((response as any)?.evidence ?? []) as any[];
}

/** Every cumulative gap string seen up to and including the first act.answer/act.edit certification (never only the LAST hop's own gaps — an earlier certified hop's wording matters exactly as much). */
function allGapsUntilCertified(chain: ChainResult): string[] {
  const out: string[] = [];
  for (const hop of chain.hops) {
    out.push(...gapRefs(hop.response));
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") break;
  }
  return out;
}

/** Honest minimum bar: the FIRST certification either already served `marker`, or discloses an honest value gap (never silently "covered" with neither). */
function assertHonestValueCompletion(chain: ChainResult, marker: string): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") {
      if (cumulative.includes(marker)) continue;
      const gaps = gapRefs(hop.response);
      expect(
        gaps.some((g) => g.includes("request-item-undetermined") && g.includes("value")),
        `certified "${kind}" with neither "${marker}" served nor an honest value gap disclosed (gaps: ${JSON.stringify(gaps)})`,
      ).toBe(true);
    }
  }
}

/** Strict bar: the value MUST be served (never merely disclosed) — used for the B1-B4 fixtures whose whole point is that the value IS resolvable and must not be left undetermined. */
function assertValueServed(chain: ChainResult, marker: string): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
  }
  expect(cumulative, `expected "${marker}" to be served somewhere in the chain's evidence`).toContain(marker);
}

/** P3/B1 bar: no gap string anywhere in the chain (up to first certification) names any of `forbidden` — a parameter, loop variable, kwarg name, local, or the focal's own type must never be disclosed as "could not be resolved"/"imported". */
function assertNoForbiddenDisclosure(chain: ChainResult, forbidden: readonly string[]): void {
  const gaps = allGapsUntilCertified(chain);
  for (const name of forbidden) {
    const hit = gaps.find((g) => new RegExp(`(?<![\\w.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`).test(g));
    expect(hit, `gap wrongly named "${name}" (forbidden: parameter/loop-catch-lambda variable/kwarg name/local/own type): ${JSON.stringify(hit)}`).toBeUndefined();
  }
}

// ===========================================================================
// Unit: focalParameterNames(bodyLines, hashComment, focalName, relPath)
// ===========================================================================
describe("unit: focalParameterNames — per-language signature parsing", () => {
  it("TS: typed params with a default value", () => {
    const body = ["export function fetchData(endpoint: string, retries: number = 3): void {", "  return;", "}"];
    const names = focalParameterNames(body, false, "fetchData", "a.ts");
    expect(names.has("endpoint")).toBe(true);
    expect(names.has("retries")).toBe(true);
  });
  it("Python: bare params, a starred varargs, and a keyword default", () => {
    const body = ["def send(self, target, *tags, delay=5):", "    return None"];
    const names = focalParameterNames(body, false, "send", "a.py");
    expect(names.has("self")).toBe(true);
    expect(names.has("target")).toBe(true);
    expect(names.has("tags")).toBe(true);
    expect(names.has("delay")).toBe(true);
  });
  it("Go: name-FIRST order (untyped-looking name before its type)", () => {
    const body = ["func Dispatch(channel string, budget time.Duration) error {", "\treturn nil", "}"];
    const names = focalParameterNames(body, false, "Dispatch", "a.go");
    expect(names.has("channel")).toBe(true);
    expect(names.has("budget")).toBe(true);
    expect(names.has("time")).toBe(false);
  });
  it("Java: Type-name order (name LAST)", () => {
    const body = ["public String render(String label, int width) {", "  return label;", "}"];
    const names = focalParameterNames(body, false, "render", "a.java");
    expect(names.has("label")).toBe(true);
    expect(names.has("width")).toBe(true);
    expect(names.has("String")).toBe(false);
  });
  it("C#: Type-name order, generic type", () => {
    const body = ["public string Render(List<string> labels, int width) {", "  return \"\";", "}"];
    const names = focalParameterNames(body, false, "Render", "a.cs");
    expect(names.has("labels")).toBe(true);
    expect(names.has("width")).toBe(true);
  });
  it("C++: reference param, Type-name order", () => {
    const body = ["std::string Widget::render(const std::string& label) {", "  return label;", "}"];
    const names = focalParameterNames(body, false, "render", "a.cpp");
    expect(names.has("label")).toBe(true);
  });
  it("Kotlin: colon type-hint order, name FIRST", () => {
    const body = ["fun render(label: String, width: Int = 10): String {", "    return label", "}"];
    const names = focalParameterNames(body, false, "render", "a.kt");
    expect(names.has("label")).toBe(true);
    expect(names.has("width")).toBe(true);
  });
  it("a doc comment/decorator above the signature does not defeat the locator", () => {
    const body = ["/**", " * Renders a label.", " */", "export function render(label: string): string {", "  return label;", "}"];
    const names = focalParameterNames(body, false, "render", "a.ts");
    expect(names.has("label")).toBe(true);
  });
  it("no matching signature within the bound yields an empty set (never guessed)", () => {
    expect(focalParameterNames(["  return other();"], false, "render", "a.ts").size).toBe(0);
  });
});

// ===========================================================================
// Unit: transientBindingNamesIn(bodyLines, hashComment)
// ===========================================================================
describe("unit: transientBindingNamesIn — loop/catch/lambda/kwarg binding names", () => {
  it("Python: for-in loop variable and a tuple-unpack pair", () => {
    const names = transientBindingNamesIn(["for slot in range(5):", "    pass", "for idx, slot in enumerate(xs):", "    pass"], false);
    expect(names.has("slot")).toBe(true);
    expect(names.has("idx")).toBe(true);
  });
  it("JS/TS: for-of loop variable", () => {
    expect(transientBindingNamesIn(["for (const slot of slots) {", "  use(slot);", "}"], false).has("slot")).toBe(true);
  });
  it("Java: typed range-for (Type name : collection)", () => {
    expect(transientBindingNamesIn(["for (String slot : slots) {", "  use(slot);", "}"], false).has("slot")).toBe(true);
  });
  it("C-style for-init (no const/let/var) — C++/Java/C# counters", () => {
    const names = transientBindingNamesIn(["for (int slot = 0; slot < 3; slot++) {", "  use(slot);", "}"], false);
    expect(names.has("slot")).toBe(true);
  });
  it("JS: bare catch and a typed TS catch", () => {
    expect(transientBindingNamesIn(["try { x(); } catch (fault) { log(fault); }"], false).has("fault")).toBe(true);
    expect(transientBindingNamesIn(["try { x(); } catch (fault: Error) { log(fault); }"], false).has("fault")).toBe(true);
  });
  it("Java: typed catch (Type name)", () => {
    expect(transientBindingNamesIn(["try { x(); } catch (IOException fault) { log(fault); }"], false).has("fault")).toBe(true);
  });
  it("Python: except ... as name", () => {
    expect(transientBindingNamesIn(["    except ValueError as fault:", "        log(fault)"], true).has("fault")).toBe(true);
  });
  it("Python: lambda parameters", () => {
    const names = transientBindingNamesIn(["handler = lambda slot, retries=3: slot + retries"], true);
    expect(names.has("slot")).toBe(true);
    expect(names.has("retries")).toBe(true);
  });
  it("JS/TS: arrow parameters, parenthesized and bare", () => {
    expect(transientBindingNamesIn(["const f = (slot, retries) => slot + retries;"], false).has("slot")).toBe(true);
    expect(transientBindingNamesIn(["const g = slot => slot * 2;"], false).has("slot")).toBe(true);
  });
  it("a keyword-argument NAME inside a call is bound, its VALUE identifier is not", () => {
    const names = transientBindingNamesIn(["    return send(url, retries=default_retries)"], true);
    expect(names.has("retries")).toBe(true);
    expect(names.has("default_retries")).toBe(false);
    expect(names.has("url")).toBe(false); // positional arg, no "=" after it -- not a kwarg name
  });
  it("an ordinary top-level reassignment is NOT treated as a kwarg name (no preceding '(' or ',')", () => {
    expect(transientBindingNamesIn(["retries = 3;"], false).has("retries")).toBe(false);
  });
});

// ===========================================================================
// Unit: importSpecifiersNaming — B1 wildcard/packageEligible tagging
// ===========================================================================
describe("unit: importSpecifiersNaming — B1 wildcard/packageEligible fields", () => {
  it("Python from-import (named) is NOT a wildcard, is package-eligible", () => {
    const [spec] = importSpecifiersNaming(["from .config import DEFAULT_TIMEOUT"], "DEFAULT_TIMEOUT", true);
    expect(spec?.wildcard).toBe(false);
    expect(spec?.packageEligible).toBe(true);
  });
  it("Python star-import is a wildcard for EVERY queried name", () => {
    const specs = importSpecifiersNaming(["from .config import *"], "anything_at_all", true);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.wildcard).toBe(true);
  });
  it("C# using-static is a wildcard, never package-eligible", () => {
    const [spec] = importSpecifiersNaming(["using static App.Config;"], "AnythingAtAll", false);
    expect(spec?.wildcard).toBe(true);
    expect(spec?.packageEligible).toBe(false);
  });
  it("Java import-static (per-member) is NOT a wildcard, never package-eligible", () => {
    const [spec] = importSpecifiersNaming(["import static app.Config.MAX_RETRIES;"], "MAX_RETRIES", false);
    expect(spec?.wildcard).toBe(false);
    expect(spec?.packageEligible).toBe(false);
  });
  it("a quoted #include is a wildcard for EVERY queried name, never package-eligible", () => {
    const specs = importSpecifiersNaming(['#include "widget.h"'], "AnythingAtAll", false);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.wildcard).toBe(true);
    expect(specs[0]?.packageEligible).toBe(false);
  });
  it("NEW: Java/Kotlin type wildcard `import a.b.C.*` is a wildcard, never package-eligible", () => {
    const specs = importSpecifiersNaming(["import app.Widgets.*"], "anything_at_all", false);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.specifier).toBe("app.Widgets");
    expect(specs[0]?.wildcard).toBe(true);
    expect(specs[0]?.packageEligible).toBe(false);
  });
  it("NEW: Java `import static a.b.C.*` (static member wildcard) is recognized the same way", () => {
    const specs = importSpecifiersNaming(["import static app.Widgets.*;"], "anything_at_all", false);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.specifier).toBe("app.Widgets");
    expect(specs[0]?.wildcard).toBe(true);
  });
  it("NEW: Kotlin package wildcard `import a.b.*` (lower-case last segment)", () => {
    const specs = importSpecifiersNaming(["import app.widgets.*"], "anything_at_all", false);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.specifier).toBe("app.widgets");
  });
  it("TS/JS export * from is a wildcard, still package-eligible (a TS/JS module specifier)", () => {
    const [spec] = importSpecifiersNaming(['export * from "./widgets";'], "AnythingAtAll", false);
    expect(spec?.wildcard).toBe(true);
    expect(spec?.packageEligible).toBe(true);
  });
});

// ===========================================================================
// Unit: findModuleExportsMemberWindow — B3 CJS/ES-default export members
// ===========================================================================
// ===========================================================================
// Unit: findModuleConstantWindow — B2 root-cause fix (own reproduction): a
// Kotlin/Swift top-level `val` was never recognized as a module-level
// declaration at all, same-file, which silently broke the B2 package-
// wildcard SHOULD case (a resolved-looking "not found" that was actually a
// declarationShapes gap, not a genuine miss).
// ===========================================================================
describe("unit: findModuleConstantWindow — Kotlin/Swift top-level `val`", () => {
  it("a top-level `val NAME = …` is now a recognized module-level declaration", () => {
    const win = findModuleConstantWindow(["val retryDelayMs = 4500L", "val maxBatch = 10"], "retryDelayMs", false);
    expect(win?.start).toBe(1);
  });
  it("an indented (non-column-0) `val` is NOT a module-level declaration (a local/property, same rule as const/let/var)", () => {
    const win = findModuleConstantWindow(["class Foo {", "  val notTopLevel = 1", "}"], "notTopLevel", false);
    expect(win).toBeUndefined();
  });
});

describe("unit: findModuleExportsMemberWindow — CJS/ES-default export member lookup", () => {
  it("a depth-1 key of module.exports = { … } (multi-line)", () => {
    const lines = ["module.exports = {", "  RETRY_LIMIT: 4,", "  BATCH_SIZE: 10,", "};"];
    const win = findModuleExportsMemberWindow(lines, "RETRY_LIMIT", false);
    expect(win?.start).toBe(2);
  });
  it("a depth-1 key sharing the opener's own line", () => {
    const lines = ["module.exports = { RETRY_LIMIT: 4, BATCH_SIZE: 10 };"];
    const win = findModuleExportsMemberWindow(lines, "RETRY_LIMIT", false);
    expect(win?.start).toBe(1);
  });
  it("export default { … } object literal member", () => {
    const lines = ["export default {", "  RETRY_LIMIT: 4,", "};"];
    const win = findModuleExportsMemberWindow(lines, "RETRY_LIMIT", false);
    expect(win?.start).toBe(2);
  });
  it("exports.member = … direct assignment", () => {
    const lines = ["exports.RETRY_LIMIT = 4;"];
    expect(findModuleExportsMemberWindow(lines, "RETRY_LIMIT", false)?.start).toBe(1);
  });
  it("module.exports.member = … direct assignment", () => {
    const lines = ["module.exports.RETRY_LIMIT = 4;"];
    expect(findModuleExportsMemberWindow(lines, "RETRY_LIMIT", false)?.start).toBe(1);
  });
  it("module resolves but the member is missing -> undefined (disclosed by the caller, never guessed)", () => {
    const lines = ["module.exports = {", "  BATCH_SIZE: 10,", "};"];
    expect(findModuleExportsMemberWindow(lines, "RETRY_LIMIT", false)).toBeUndefined();
  });
  it("a NESTED (depth-2) key is not matched -- one member, one hop", () => {
    const lines = ["module.exports = {", "  limits: {", "    RETRY_LIMIT: 4,", "  },", "};"];
    expect(findModuleExportsMemberWindow(lines, "RETRY_LIMIT", false)).toBeUndefined();
  });
});

// ===========================================================================
// Unit: isRequireModuleInitializer — B3 require() is a module, never a value
// ===========================================================================
describe("unit: isRequireModuleInitializer — a bare require() is a module binding", () => {
  it("a bare require(\"./x\") initializer", () => {
    expect(isRequireModuleInitializer(['const widgets = require("./widgets");'], false)).toBe(true);
  });
  it("TS import x = require(\"./x\") initializer", () => {
    expect(isRequireModuleInitializer(['import widgets = require("./widgets");'], false)).toBe(true);
  });
  it("require(...).default is NOT a bare require() -- may still be a real value", () => {
    expect(isRequireModuleInitializer(['const widgets = require("./widgets").default;'], false)).toBe(false);
  });
  it("an ordinary construction is not a require() module binding", () => {
    expect(isRequireModuleInitializer(["const widgets = new Widgets();"], false)).toBe(false);
  });
  it("an ordinary literal is not a require() module binding", () => {
    expect(isRequireModuleInitializer(["const RETRY_LIMIT = 4;"], false)).toBe(false);
  });
});

// ===========================================================================
// E2E matrix — B1: wildcard specs never "name" a queried identifier, and a
// disclosure never names a parameter/loop-catch-lambda variable/kwarg name/
// the focal's own type. Every fixture is FRESH (own names, own files, own
// wording) — different from the reviewer's pyStarImportLowerConst/
// csUsingStaticPascalConst/cppScopedConst fixtures this class was found in.
// ===========================================================================
describe("E2E matrix — B1: wildcard imports never falsely disclose a param/loop-var/kwarg/own-type", () => {
  it("Python: star-import + param + loop-var + kwarg-name + own-type noise around a real value", async () => {
    const ws = makeWorkspace("b1Py");
    writeFile(ws, "pyproject.toml", '[project]\nname = "widgetapp"\n');
    writeFile(ws, "widgetapp/__init__.py", "");
    writeFile(ws, "widgetapp/settings.py", "default_retry_delay = 4.5\nmax_batch_size = 10\n");
    writeFile(
      ws,
      "widgetapp/worker.py",
      "from .settings import *\n\n\nclass Dispatcher:\n    def send(self, endpoint):\n        for slot in range(3):\n            return transmit(endpoint, delay=default_retry_delay)\n        return None\n",
    );
    writeFile(ws, "widgetapp/api.py", 'from .worker import Dispatcher\n\n\ndef dispatch(pid):\n    return Dispatcher().send(f"/queues/{pid}")\n');
    const chain = await ask(ws, "What default retry delay does Dispatcher.send use?");
    assertValueServed(chain, "default_retry_delay = 4.5");
    assertNoForbiddenDisclosure(chain, ["endpoint", "slot", "Dispatcher"]);
    // "delay" is the kwarg NAME (transmit(endpoint, delay=...)) -- must never
    // be disclosed even though it textually matches part of
    // "default_retry_delay"; the word-boundary check in
    // assertNoForbiddenDisclosure already keeps the two apart.
    assertNoForbiddenDisclosure(chain, ["delay"]);
  }, 60_000);

  it("C#: using-static wildcard + param + own-BCL-namespace noise (control: real value still served, B2)", async () => {
    const ws = makeWorkspace("b1Cs");
    writeFile(ws, "Widget.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
    writeFile(ws, "src/Limits.cs", "namespace WidgetApp;\n\npublic static class Limits\n{\n    public const int RetryDelayMs = 4500;\n    public const int MaxBatchSize = 10;\n}\n");
    writeFile(
      ws,
      "src/Dispatcher.cs",
      "using static WidgetApp.Limits;\n\nnamespace WidgetApp.Net;\n\npublic sealed class Dispatcher\n{\n    public string Send(string endpoint)\n    {\n        for (var slot = 0; slot < 3; slot++)\n        {\n            var deadline = System.Environment.TickCount64 + RetryDelayMs;\n            if (deadline > 0) return endpoint;\n        }\n        throw new System.InvalidOperationException(\"exhausted\");\n    }\n}\n",
    );
    writeFile(
      ws,
      "src/Program.cs",
      'namespace WidgetApp;\n\npublic static class Program\n{\n    public static void Main()\n    {\n        System.Console.WriteLine(new WidgetApp.Net.Dispatcher().Send("/queues/1"));\n    }\n}\n',
    );
    const chain = await ask(ws, "What default retry delay does Dispatcher.Send use?");
    assertValueServed(chain, "RetryDelayMs = 4500");
    assertNoForbiddenDisclosure(chain, ["endpoint", "System", "Dispatcher"]);
  }, 60_000);

  it("C++: quoted #include wildcard + own-type + param + C-style-for loop-var noise", async () => {
    const ws = makeWorkspace("b1Cpp");
    writeFile(ws, "CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)\nproject(app CXX)\nadd_executable(app src/main.cpp src/dispatcher.cpp)\n");
    writeFile(ws, "src/limits.hpp", "#pragma once\n\nstruct Limits {\n  static constexpr int RETRY_DELAY_MS = 4500;\n  static constexpr int MAX_BATCH = 10;\n};\n");
    writeFile(ws, "src/dispatcher.hpp", "#pragma once\n#include <string>\n\nclass Dispatcher {\n public:\n  std::string send(const std::string& endpoint);\n};\n");
    writeFile(
      ws,
      "src/dispatcher.cpp",
      "#include \"dispatcher.hpp\"\n#include \"limits.hpp\"\n\nstd::string Dispatcher::send(const std::string& endpoint) {\n  for (int slot = 0; slot < 3; ++slot) {\n    const int delay = Limits::RETRY_DELAY_MS;\n    if (delay > 0) return endpoint;\n  }\n  return \"\";\n}\n",
    );
    writeFile(
      ws,
      "src/main.cpp",
      '#include "dispatcher.hpp"\n#include <iostream>\n\nint main() {\n  Dispatcher d;\n  std::cout << d.send("/queues/1") << std::endl;\n  return 0;\n}\n',
    );
    const chain = await ask(ws, "What default retry delay does Dispatcher::send use?");
    assertValueServed(chain, "RETRY_DELAY_MS = 4500");
    assertNoForbiddenDisclosure(chain, ["Dispatcher", "endpoint", "slot"]);
  }, 60_000);

  it("control: a genuinely unresolvable CONST_CASE name reached only through a wildcard import is still honestly disclosed (never silenced)", async () => {
    const ws = makeWorkspace("b1Control");
    writeFile(ws, "pyproject.toml", '[project]\nname = "widgetapp2"\n');
    writeFile(ws, "widgetapp2/__init__.py", "");
    writeFile(ws, "widgetapp2/settings.py", "max_batch_size = 10\n");
    writeFile(
      ws,
      "widgetapp2/worker.py",
      "from .settings import *\n\n\nclass Dispatcher:\n    def send(self, endpoint):\n        return RETRY_LIMIT_NEVER_DECLARED\n",
    );
    const chain = await ask(ws, "What retry limit does Dispatcher.send use?");
    assertHonestValueCompletion(chain, "RETRY_LIMIT_NEVER_DECLARED = ");
  }, 60_000);
});

// ===========================================================================
// E2E matrix — B2: a TYPE wildcard import resolves an otherwise-unresolved
// bare name through its owner's own body (findQualifiedConstantWindow).
// ===========================================================================
describe("E2E matrix — B2: type-wildcard-imported bare name resolves through its owner", () => {
  it("Kotlin: `import app.Limits.*` + a lowerCamel bare read", async () => {
    const ws = makeWorkspace("b2Kt");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(ws, "src/main/kotlin/app/Limits.kt", "package app\n\nobject Limits {\n    val retryDelayMs = 4500L\n    val maxBatch = 10\n}\n");
    writeFile(
      ws,
      "src/main/kotlin/net/Dispatcher.kt",
      "package net\n\nimport app.Limits.*\n\nclass Dispatcher {\n    fun send(endpoint: String): String {\n        for (slot in 0 until 3) {\n            val deadline = System.currentTimeMillis() + retryDelayMs\n            if (deadline > 0) return endpoint\n        }\n        throw IllegalStateException(\"exhausted\")\n    }\n}\n",
    );
    writeFile(ws, "src/main/kotlin/app/Main.kt", 'package app\n\nimport net.Dispatcher\n\nfun main() {\n    println(Dispatcher().send("/queues/1"))\n}\n');
    const chain = await ask(ws, "What default retry delay does Dispatcher.send use?");
    assertValueServed(chain, "retryDelayMs = 4500");
    assertNoForbiddenDisclosure(chain, ["endpoint", "Dispatcher"]);
  }, 60_000);

  it("Java: `import static app.Limits.*` + a CONST_CASE bare read", async () => {
    const ws = makeWorkspace("b2Java");
    writeFile(ws, "pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>app</groupId><artifactId>app</artifactId><version>1</version></project>\n");
    writeFile(ws, "src/main/java/app/Limits.java", "package app;\n\npublic final class Limits {\n    public static final int RETRY_DELAY_MS = 4500;\n    public static final int MAX_BATCH = 10;\n}\n");
    writeFile(
      ws,
      "src/main/java/net/Dispatcher.java",
      "package net;\n\nimport static app.Limits.*;\n\npublic final class Dispatcher {\n    public String send(String endpoint) {\n        for (int slot = 0; slot < 3; slot++) {\n            long deadline = System.currentTimeMillis() + RETRY_DELAY_MS;\n            if (deadline > 0) return endpoint;\n        }\n        throw new IllegalStateException(\"exhausted\");\n    }\n}\n",
    );
    writeFile(
      ws,
      "src/main/java/app/Main.java",
      'package app;\n\npublic final class Main {\n    public static void main(String[] args) {\n        System.out.println(new net.Dispatcher().send("/queues/1"));\n    }\n}\n',
    );
    const chain = await ask(ws, "What default retry delay does Dispatcher.send use?");
    assertValueServed(chain, "RETRY_DELAY_MS = 4500");
    assertNoForbiddenDisclosure(chain, ["endpoint", "slot", "Dispatcher"]);
  }, 60_000);

  it("SHOULD: Kotlin `import app.*` (lower-case last segment, package wildcard) resolves a top-level val in a file declaring `package app`", async () => {
    const ws = makeWorkspace("b2KtPackage");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(ws, "src/main/kotlin/app/defaults.kt", "package app\n\nval retryDelayMs = 4500L\nval maxBatch = 10\n");
    writeFile(
      ws,
      "src/main/kotlin/net/dispatcher.kt",
      "package net\n\nimport app.*\n\nclass Dispatcher {\n    fun send(endpoint: String): String {\n        val deadline = retryDelayMs\n        return if (deadline > 0) endpoint else \"\"\n    }\n}\n",
    );
    const chain = await ask(ws, "What default retry delay does Dispatcher.send use?");
    assertValueServed(chain, "retryDelayMs = 4500");
  }, 60_000);

  it("control: a wildcard-imported type that does NOT declare the queried CONST_CASE member stays honestly undetermined (never guessed) -- \"not found -> not from that import\", never a silent drop", async () => {
    const ws = makeWorkspace("b2Control");
    writeFile(ws, "build.gradle.kts", 'plugins { kotlin("jvm") version "2.0.0" }\n');
    writeFile(ws, "src/main/kotlin/app/Limits.kt", "package app\n\nobject Limits {\n    val retryDelayMs = 4500L\n}\n");
    writeFile(
      ws,
      "src/main/kotlin/net/Dispatcher.kt",
      "package net\n\nimport app.Limits.*\n\nclass Dispatcher {\n    fun send(endpoint: String): String {\n        val deadline = BATCH_TIMEOUT_MS\n        return if (deadline > 0) endpoint else \"\"\n    }\n}\n",
    );
    const chain = await ask(ws, "What default batch timeout does Dispatcher.send use?");
    assertHonestValueCompletion(chain, "BATCH_TIMEOUT_MS = ");
  }, 60_000);
});

// ===========================================================================
// E2E matrix — B3: require()/default-import module aliases resolve through
// the module's own exports; the alias's own declaration line is never
// itself served as a value.
// ===========================================================================
describe("E2E matrix — B3: CJS/default-import module aliases resolve through their exports", () => {
  const LIMITS_CJS = "module.exports = {\n  RETRY_DELAY_MS: 4500,\n  MAX_BATCH: 10,\n};\n";

  it("CJS: `const x = require(...)` + qualified member read (x.MEMBER)", async () => {
    const ws = makeWorkspace("b3CjsRequire");
    writeFile(ws, "package.json", '{ "name": "widgetcjs", "private": true }\n');
    writeFile(ws, "src/limits.js", LIMITS_CJS);
    writeFile(
      ws,
      "src/dispatcher.js",
      "const limits = require(\"./limits\");\n\nclass Dispatcher {\n  async send(endpoint) {\n    for (let slot = 0; slot < 3; slot++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), limits.RETRY_DELAY_MS);\n      try {\n        return await fetch(endpoint, { signal: controller.signal });\n      } finally {\n        clearTimeout(timer);\n      }\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n\nmodule.exports = { Dispatcher };\n",
    );
    writeFile(
      ws,
      "src/api.js",
      "const { Dispatcher } = require(\"./dispatcher\");\n\nconst dispatcher = new Dispatcher();\n\nasync function run(id) {\n  const response = await dispatcher.send(`/queues/${id}`);\n  return response.json();\n}\n\nmodule.exports = { run };\n",
    );
    const chain = await ask(ws, "What default retry delay does Dispatcher.send use?");
    assertValueServed(chain, "RETRY_DELAY_MS: 4500");
  }, 60_000);

  it("CJS: destructured `const { MEMBER } = require(...)` resolves the exports-object key", async () => {
    const ws = makeWorkspace("b3CjsDestructure");
    writeFile(ws, "package.json", '{ "name": "widgetcjs2", "private": true }\n');
    writeFile(ws, "src/limits.js", LIMITS_CJS);
    writeFile(
      ws,
      "src/dispatcher2.js",
      "const { RETRY_DELAY_MS } = require(\"./limits\");\n\nclass Dispatcher2 {\n  async send(endpoint) {\n    for (let slot = 0; slot < 3; slot++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), RETRY_DELAY_MS);\n      try {\n        return await fetch(endpoint, { signal: controller.signal });\n      } finally {\n        clearTimeout(timer);\n      }\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n\nmodule.exports = { Dispatcher2 };\n",
    );
    const chain = await ask(ws, "What default retry delay does Dispatcher2.send use?");
    assertValueServed(chain, "RETRY_DELAY_MS: 4500");
  }, 60_000);

  it("TS: default-imported object + qualified member read (x.MEMBER)", async () => {
    const ws = makeWorkspace("b3TsDefault");
    writeFile(ws, "package.json", '{ "name": "widgetts", "private": true, "type": "module" }\n');
    writeFile(ws, "src/limits.ts", "export default {\n  RETRY_DELAY_MS: 4500,\n  MAX_BATCH: 10,\n};\n");
    writeFile(
      ws,
      "src/dispatcher.ts",
      "import limits from \"./limits\";\n\nexport class Dispatcher {\n  async request(endpoint: string): Promise<Response> {\n    for (let slot = 0; slot < 3; slot++) {\n      const controller = new AbortController();\n      const timer = setTimeout(() => controller.abort(), limits.RETRY_DELAY_MS);\n      try {\n        return await fetch(endpoint, { signal: controller.signal });\n      } finally {\n        clearTimeout(timer);\n      }\n    }\n    throw new Error(\"exhausted\");\n  }\n}\n",
    );
    writeFile(
      ws,
      "src/api.ts",
      "import { Dispatcher } from \"./dispatcher\";\n\nconst dispatcher = new Dispatcher();\n\nexport async function run(id: string): Promise<unknown> {\n  const response = await dispatcher.request(`/queues/${id}`);\n  return response.json();\n}\n",
    );
    const chain = await ask(ws, "What default retry delay does Dispatcher.request use?");
    assertValueServed(chain, "RETRY_DELAY_MS: 4500");
  }, 60_000);

  it("control: the module resolves but the queried member is missing -> disclosed, never silently skipped", async () => {
    const ws = makeWorkspace("b3Control");
    writeFile(ws, "package.json", '{ "name": "widgetcjs3", "private": true }\n');
    writeFile(ws, "src/limits.js", LIMITS_CJS);
    writeFile(
      ws,
      "src/dispatcher3.js",
      "const limits = require(\"./limits\");\n\nclass Dispatcher3 {\n  send() {\n    return limits.TIMEOUT_MS_NEVER_DECLARED;\n  }\n}\n\nmodule.exports = { Dispatcher3 };\n",
    );
    const chain = await ask(ws, "What timeout does Dispatcher3.send use?");
    assertHonestValueCompletion(chain, "TIMEOUT_MS_NEVER_DECLARED");
  }, 60_000);
});

// ===========================================================================
// E2E matrix — B4: Rust bare `use`-bound constants and `impl Owner { … }`
// members resolve; never a double disclosure of the bare + qualified form.
// ===========================================================================
describe("E2E matrix — B4: Rust use-bound constants and impl-block members resolve", () => {
  it("a bare name bound by `use crate::mod::NAME;` resolves in its own module", async () => {
    const ws = makeWorkspace("b4UsePlain");
    writeFile(ws, "Cargo.toml", '[package]\nname = "widgetcli"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFile(ws, "src/main.rs", 'mod dispatcher;\nmod limits;\n\nfn main() {\n    println!("{:?}", dispatcher::send("/queues/1"));\n}\n');
    writeFile(ws, "src/limits.rs", "pub const RETRY_DELAY_MS: u64 = 4500;\npub const MAX_BATCH: u32 = 10;\n");
    writeFile(
      ws,
      "src/dispatcher.rs",
      "use crate::limits::RETRY_DELAY_MS;\n\npub fn send(endpoint: &str) -> Option<String> {\n    for _slot in 0..3 {\n        let delay = RETRY_DELAY_MS;\n        if delay > 0 {\n            return Some(endpoint.to_string());\n        }\n    }\n    None\n}\n",
    );
    const chain = await ask(ws, "What default retry delay does send use?");
    assertValueServed(chain, "RETRY_DELAY_MS: u64 = 4500");
  }, 60_000);

  it("a qualified `Owner::MEMBER` resolves inside `impl Owner { … }`, never a double bare+qualified disclosure", async () => {
    const ws = makeWorkspace("b4Impl");
    writeFile(ws, "Cargo.toml", '[package]\nname = "widgetcli2"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFile(ws, "src/main.rs", 'mod dispatcher2;\nmod limits2;\n\nfn main() {\n    println!("{:?}", dispatcher2::send2("/queues/1"));\n}\n');
    writeFile(
      ws,
      "src/limits2.rs",
      "pub struct Limits {\n    pub label: &'static str,\n}\n\nimpl Limits {\n    pub const RETRY_DELAY_MS: u64 = 4500;\n    pub const MAX_BATCH: u32 = 10;\n}\n",
    );
    writeFile(
      ws,
      "src/dispatcher2.rs",
      "use crate::limits2::Limits;\n\npub fn send2(endpoint: &str) -> Option<String> {\n    for _slot in 0..3 {\n        let delay = Limits::RETRY_DELAY_MS;\n        if delay > 0 {\n            return Some(endpoint.to_string());\n        }\n    }\n    None\n}\n",
    );
    const chain = await ask(ws, "What default retry delay does send2 use?");
    assertValueServed(chain, "RETRY_DELAY_MS: u64 = 4500");
    // Never a double disclosure ("RETRY_DELAY_MS, Limits.RETRY_DELAY_MS") --
    // once genuinely served, NEITHER the bare member half nor the qualified
    // form may still appear in a gap.
    assertNoForbiddenDisclosure(chain, ["RETRY_DELAY_MS"]);
  }, 60_000);
});
