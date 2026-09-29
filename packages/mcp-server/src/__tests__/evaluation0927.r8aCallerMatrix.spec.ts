/**
 * evaluation0927.r8aCallerMatrix.spec.ts — R8-A (round-8 wave, 2026-09-28):
 * regression matrix for review-findings-fable-r7.md's P0-1
 * (defaultExportedDeclCallerJsdoc/defaultExportedClassDecoratorCaller: the
 * focal's symbol range starts at its doc comment/decorator, so the
 * default-export shape check must be applied to the declaration's own
 * HEADER line, not the trivia line the range happens to start on), P1-2
 * (ktImportAliasCaller: an aliased import explained away by a foreign
 * per-language shape overlap), P1-3 (javaCallerFromScala/rubyCallerFromRake/
 * cCallerFromObjC: a caller in a language this scan never walked at all) and
 * P2-7 (mention noise: a module-specifier-string occurrence, a non-leaf
 * module-path segment, a trailing line comment, and the `const|let|var {`/
 * `import x, {` multi-line openers -- every addition still POSITIVE, never a
 * generic fallback, per THE ROUND-7 PRINCIPLE).
 *
 * Built from the finding CLASS (the round-8 lesson), not only the reported
 * shapes. PART 1 is a fast, exhaustive PURE unit matrix over
 * `focalIsSoleDefaultExport` / `mentionExplainedByImportExportLine` /
 * `mentionExplainedByImportExport` / `isCallerMentionOnlyFile` (all exported
 * from readCodeTaskPack.ts only for this style of spec). PART 2 is the
 * cross-product END-TO-END matrix the round-8 brief itself specifies: for
 * each classified language (TS/JS, Python, Go, Rust, Java, Kotlin, C/C++,
 * Ruby, C#, PHP) the focal's caller shapes (direct call; aliased/namespace
 * import + call; a call from a mention-only language file) never certify
 * `request-item-empty:callers`, while a genuinely caller-less focal still
 * does, and one real caller among 26 type-only importers is not drowned.
 *
 * Every fixture is written FRESH against the DESCRIBED defect class --
 * `computeTotal`/`pricing`, never the reviewer's own `formatBytes`/
 * `debounce`/`format_bytes` identifiers or file names.
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
  focalIsSoleDefaultExport,
  isCallerMentionOnlyFile,
  mentionExplainedByImportExport,
  mentionExplainedByImportExportLine,
} from "../features/task-pack/readCodeTaskPack.js";

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

// =====================================================================
// PART 1 -- pure unit matrix (no server)
// =====================================================================

describe("A1 -- focalIsSoleDefaultExport finds the declaration HEADER past leading trivia", () => {
  const M = "computeTotal";
  const shapes: Array<[string, string[]]> = [
    ["single-line `//` doc comment", ["// Computes the running total.", "export default function computeTotal(n) {", "  return n * 2;", "}"]],
    ["multi-line `/** … */` JSDoc", ["/**", " * Computes the running total.", " * @param n the input", " */", "export default function computeTotal(n) {", "  return n * 2;", "}"]],
    ["a single-line `@decorator()` before a class", ["@injectable()", "export default class computeTotal {", "}"]],
    ["a `@decorator(` spanning several lines", ["@Component({", "  selector: 'x',", "})", "export default class computeTotal {", "}"]],
    ["a `[Attribute]` annotation", ["[Obsolete]", "export default class computeTotal {", "}"]],
    ["blank lines then the declaration", ["", "", "export default function computeTotal(n) {", "  return n * 2;", "}"]],
    ["doc comment THEN a decorator, stacked", ["/** doc */", "@injectable()", "export default class computeTotal {", "}"]],
    ["CJS `module.exports = function m` behind a doc comment", ["/**", " * Computes the running total.", " */", "module.exports = function computeTotal(n) {", "  return n * 2;", "}"]],
    ["a `/** ... */ export default ...` closer with trailing code stays found", ["/**", " * doc", " */", "export default function computeTotal(n) {", "  return n * 2;", "}"]],
  ];
  for (const [label, lines] of shapes) {
    it(`${label} is still recognized as the module's own default export`, () => {
      expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
    });
  }

  // PIN MOVED (R9-A, round-9 wave, 2026-09-29, eval-0927 review-r8 P1-4,
  // defaultExportedLongJsdocCaller): this test pinned the round-8 header
  // walk's OWN internal 40-line cap (`DECLARATION_HEADER_SEARCH_BOUND`,
  // `startLine + 40`) — round 9 removes that flat cap (a JSDoc block longer
  // than 40 lines used to defeat the walk entirely, certifying a false
  // `request-item-empty:callers`) and bounds the walk ONLY by the caller's
  // own `endLine`. This call omits `endLine`, which DEFAULTS to
  // `lines.length` — under the new rule that makes the WHOLE 48-line array
  // the focal's own range, so walking through 45 lines of harmless `//`
  // filler to reach the real declaration below them is now correct, not a
  // false match. The property this test actually guards — the walk must
  // still never cross a caller-supplied `endLine` into an UNRELATED
  // declaration below it — is unaffected and still covered by the very next
  // test ("never walks past the focal's own endLine..."), which passes an
  // explicit, smaller `endLine` and is unchanged by this pin move. See also
  // evaluation0927.r9aCallers.spec.ts's own cell for this exact shape.
  it("no internal 40-line cap: 45 lines of unrelated leading `//` filler no longer defeat the header walk when no smaller endLine is given", () => {
    const filler = Array.from({ length: 45 }, (_, i) => `// filler line ${i}`);
    const lines = [...filler, "export default function computeTotal(n) {", "  return n * 2;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });

  it("never walks past the focal's own endLine into an unrelated declaration below it", () => {
    const lines = [
      "/**",
      " * Some unrelated doc paragraph.",
      " */",
      "function unrelatedHelper() {}",
      "",
      "export default function computeTotal(n) {",
      "  return n * 2;",
      "}",
    ];
    // The focal's OWN range ends at line 4 (`unrelatedHelper`, a SEPARATE
    // declaration) -- the scan must never walk into the real default export
    // sitting below an unrelated symbol's own range.
    expect(focalIsSoleDefaultExport(lines, 1, M, 4)).toBe(false);
  });

  it("control -- unaffected: a declaration with NO leading trivia at the recorded startLine still matches exactly as before", () => {
    const lines = ["export default function computeTotal(n) {", "  return n * 2;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(true);
  });

  it("control -- a documented declaration of a DIFFERENT name never matches", () => {
    const lines = ["/** doc */", "export default function otherHelper(n) {", "  return n;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(false);
  });

  it("control -- a SEPARATE `export default member;` two lines below an unrelated doc comment does not count (only the focal's own declaration header is checked)", () => {
    const lines = ["/** doc for something else */", "function helper() {}", "", "export default computeTotal;", "", "function computeTotal(n) { return n; }"];
    expect(focalIsSoleDefaultExport(lines, 1, M)).toBe(false);
  });
});

describe("A2 -- an aliased import entry is never explained, in every language, including the bare-dotted-with-`as` shape", () => {
  const M = "computeTotal";

  it("Kotlin/Java/Scala-shaped `import a.b.m as x` stays an unexplained mention", () => {
    expect(mentionExplainedByImportExportLine("import pricing.computeTotal as calc", M)).toBe(false);
  });
  it("Python's OWN `import a.m as x` ALSO stays an unexplained mention (not just the foreign-language shape)", () => {
    expect(mentionExplainedByImportExportLine("import pricing.computeTotal as calc", M, "src/pricing.py")).toBe(false);
  });
  it("Scala braced rename `import a.b.{m => x}` stays a mention (unaffected control, already correct)", () => {
    expect(mentionExplainedByImportExportLine("import pricing.util.{computeTotal => calc}", M)).toBe(false);
  });

  it("the SAME bare-dotted shape with NO alias still explains the leaf segment (unaffected control)", () => {
    expect(mentionExplainedByImportExportLine("import pricing.computeTotal", M)).toBe(true);
  });
  it("an aliased leaf's NAMESPACE segment (never itself touched by the alias) still explains", () => {
    expect(mentionExplainedByImportExportLine("import pricing.computeTotal as calc", "pricing")).toBe(true);
  });

  describe("extension gating -- a shape never explains a line from a foreign language's own file", () => {
    it("C/C++ `#include` never fires for a Python file, but is tried when relPath is omitted or matches", () => {
      expect(mentionExplainedByImportExportLine('#include "computeTotal.h"', M)).toBe(true);
      expect(mentionExplainedByImportExportLine('#include "computeTotal.h"', M, "src/pricing.py")).toBe(false);
      expect(mentionExplainedByImportExportLine('#include "computeTotal.h"', M, "src/pricing.cpp")).toBe(true);
    });

    it("C# `using static …;` never fires for a Rust file, but is tried when relPath is omitted or matches", () => {
      expect(mentionExplainedByImportExportLine("using static App.computeTotal;", M)).toBe(true);
      expect(mentionExplainedByImportExportLine("using static App.computeTotal;", M, "src/pricing.rs")).toBe(false);
      expect(mentionExplainedByImportExportLine("using static App.computeTotal;", M, "src/Pricing.cs")).toBe(true);
    });

    it("Python `from x import (...)` never fires for a Kotlin file, but is tried when relPath is omitted or matches", () => {
      expect(mentionExplainedByImportExportLine("from pricing import computeTotal", M)).toBe(true);
      expect(mentionExplainedByImportExportLine("from pricing import computeTotal", M, "src/Pricing.kt")).toBe(false);
      expect(mentionExplainedByImportExportLine("from pricing import computeTotal", M, "src/pricing.py")).toBe(true);
    });

    it("the JVM dotted shape still explains a real Kotlin/Java plain import when relPath is supplied", () => {
      expect(mentionExplainedByImportExportLine("import pricing.computeTotal", M, "src/Pricing.kt")).toBe(true);
      expect(mentionExplainedByImportExportLine("import pricing.computeTotal;", M, "src/Pricing.java")).toBe(true);
    });
  });
});

describe("A4 -- module-specifier strings, non-leaf path segments, trailing comments, and new multi-line openers all still POSITIVE", () => {
  const M = "pricing";

  describe("A4(i) -- an occurrence inside a recognized line's own quoted module specifier is explained", () => {
    const rows: Array<[string, string]> = [
      ["TS type-only named import naming an UNRELATED member, same-named specifier", 'import type { Options } from "./pricing";'],
      ["TS bare side-effect import", 'import "./pricing";'],
      ["TS bare `export * from`", 'export * from "./pricing";'],
      ["TS default import binding an unrelated local name", 'import calc from "./pricing";'],
      ["TS namespace import binding an unrelated local name", 'import * as calc from "./pricing";'],
      ["CJS destructure naming an unrelated member", 'const { total } = require("./pricing");'],
      ["Go bare quoted import", 'import "example.com/app/pricing"'],
    ];
    for (const [label, line] of rows) {
      it(label, () => {
        expect(mentionExplainedByImportExportLine(line, M)).toBe(true);
      });
    }

    it("control -- the specifier fallback never overrides an ALIASED list entry naming the SAME member (A2 still wins)", () => {
      // "pricing" both the imported (aliased) member and, incidentally, the
      // module's own basename -- the aliased-entry rule must still decide
      // this line, never the specifier check.
      expect(mentionExplainedByImportExportLine('import { pricing as calcPricing } from "./pricing";', M)).toBe(false);
    });
  });

  describe("A4(ii) -- a non-leaf module-path segment is explained", () => {
    const rows: Array<[string, string]> = [
      ["Python `from x.y import z`'s own `x.y`", "from pricing.helpers import computeTotal"],
      ["Rust `use a::b::c;`'s own `a::b`", "use crate::pricing::computeTotal;"],
      ["Rust `use a::b::{…};`'s own `a::b`", "use crate::pricing::{computeTotal, other};"],
    ];
    for (const [label, line] of rows) {
      it(label, () => {
        expect(mentionExplainedByImportExportLine(line, M)).toBe(true);
      });
    }
  });

  describe("A4(iii) -- a trailing line comment is stripped before shape matching", () => {
    it("Python `# noqa` after an ordinary import list", () => {
      expect(mentionExplainedByImportExportLine("from app import pricing  # noqa", M)).toBe(true);
    });
    it("TS `// eslint-disable-line` after an ordinary named import", () => {
      expect(mentionExplainedByImportExportLine('import { pricing } from "./pricing"; // eslint-disable-line', M)).toBe(true);
    });
    it("control -- a LEADING `#include` is never mistaken for a trailing comment and truncated away", () => {
      expect(mentionExplainedByImportExportLine('#include "pricing.h"', M)).toBe(true);
    });
    it("control -- a `#` genuinely inside a quoted specifier is never treated as a comment starter", () => {
      expect(mentionExplainedByImportExportLine('import { helper } from "./pricing#fragment";', "fragment")).toBe(true);
    });
  });

  describe("A4(iv) -- new multi-line openers: `const|let|var {` and `import x, {`", () => {
    it("CJS multi-line destructuring require", () => {
      const lines = ["const {", "  pricing,", '} = require("./pricing");'];
      expect(mentionExplainedByImportExport(lines, 2, M)).toBe(true);
    });
    it("`export const {` destructuring require", () => {
      const lines = ["export const {", "  pricing,", '} = require("./pricing");'];
      expect(mentionExplainedByImportExport(lines, 2, M)).toBe(true);
    });
    it("TS default + named combined multi-line import", () => {
      const lines = ["import meta, {", "  pricing,", '} from "./pricing";'];
      expect(mentionExplainedByImportExport(lines, 2, M)).toBe(true);
    });
    it("a `// {` inside a trailing comment is never mistaken for an opener (the backward scan must still find the REAL opener above it)", () => {
      const lines = ["import {", "  other, // {", "  pricing,", '} from "./x";'];
      expect(mentionExplainedByImportExport(lines, 3, M)).toBe(true);
    });
    it("control -- an unrelated multi-line object literal (`export default {`) is never mistaken for a destructuring opener", () => {
      const lines = ["export default {", "  pricing,", "};"];
      expect(mentionExplainedByImportExport(lines, 2, M)).toBe(false);
    });
    it("control -- a destructuring target from an ARBITRARY call (not `require`) is equally safe (never itself a call, whatever the source)", () => {
      const lines = ["const {", "  pricing,", "} = loadSettings();"];
      expect(mentionExplainedByImportExport(lines, 2, M)).toBe(true);
    });
  });
});

describe("A3 -- isCallerMentionOnlyFile's expanded extension list", () => {
  const mentionOnly = [
    "Sources/App/Total.swift", "src/main/scala/Total.scala", "build.sc",
    "lib/total.dart", "src/Total.groovy", "src/Total.gvy", "build.gradle",
    "src/AppDelegate.m", "src/AppDelegate.mm", "lib/tasks/total.rake", "total.gemspec",
    "scripts/total.lua", "lib/total.ex", "lib/total.exs", "src/total.erl", "src/total.hrl",
    "scripts/total.pl", "lib/Total.pm", "scripts/total.sh", "scripts/total.bash",
    "scripts/total.zsh", "scripts/total.ps1", "scripts/Total.psm1",
    "R/total.r", "src/Total.jl", "src/total.clj", "src/total.cljs", "src/total.cljc",
    "src/Total.hs", "src/total.ml", "src/total.mli", "src/Total.fs", "src/Total.fsi",
    "src/Total.fsx", "src/Total.vb", "src/total.coffee", "src/Total.elm", "src/total.nim", "src/total.zig",
  ];
  for (const p of mentionOnly) {
    it(`${p} is mention-only`, () => {
      expect(isCallerMentionOnlyFile(p)).toBe(true);
    });
  }

  const stillClassified = [
    "src/pricing.ts", "src/pricing.js", "src/pricing.py", "src/pricing.go", "src/Pricing.java",
    "src/Pricing.kt", "src/pricing.c", "src/pricing.cpp", "src/pricing.h", "lib/pricing.rb",
    "src/Pricing.cs", "src/Pricing.php", "src/pricing.rs",
  ];
  for (const p of stillClassified) {
    it(`${p} stays classified (a core call-site language, never routed to mention-only)`, () => {
      expect(isCallerMentionOnlyFile(p)).toBe(false);
    });
  }

  it("config/data files stay OUT of the mention-only set (documented residual -- never scanned as callers at all)", () => {
    for (const p of ["config/app.yaml", "config/app.yml", "package.json", "pyproject.toml", "pom.xml"]) {
      expect(isCallerMentionOnlyFile(p)).toBe(false);
    }
  });
});

// =====================================================================
// PART 2 -- end-to-end cross-product matrix (one server per workspace)
// =====================================================================

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r8a-${tag}-`));
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

async function askOn(s: ServerHandle, ws: string, query: string, hopCap = 20): Promise<ChainResult> {
  return followNextToEnd(s, { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } }, { cwd: ws, hopCap });
}

async function ask(ws: string, query: string, hopCap = 20): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return askOn(s, ws, query, hopCap);
}

function allWhy(chain: ChainResult): string {
  return chain.hops
    .flatMap((h) => (h.response?.["evidence"] as Array<Record<string, unknown>> | undefined) ?? [])
    .map((e) => String(e["why"] ?? ""))
    .join(" | ");
}

function allGaps(chain: ChainResult): string {
  return chain.hops
    .map((h) => JSON.stringify((h.response?.["decision"] as Record<string, unknown> | undefined)?.["certificate"] ?? {}))
    .join(" | ");
}

function finalDecisionKind(chain: ChainResult): unknown {
  const finalHop = chain.hops[chain.hops.length - 1]!;
  return (finalHop.response?.["decision"] as Record<string, unknown> | undefined)?.["kind"];
}

function expectNeverFalseEmpty(chain: ChainResult, name: string): void {
  const gaps = allGaps(chain);
  expect(gaps).not.toContain(`request-item-empty:callers:${name} (0 call sites`);
  expect(["act.answer", "discover"]).toContain(finalDecisionKind(chain));
}

interface LangSpec {
  readonly name: string;
  readonly query: string;
  /** A fully self-contained workspace: the focal plus ONE plain caller the classifier must find as a REAL site (control -- proves ordinary code is unaffected). */
  readonly directOnly: ReadonlyArray<{ readonly rel: string; readonly content: string }>;
  /** A fully self-contained workspace: the focal plus only aliased-import / namespace / mention-only-file callers -- none findable BY NAME, so the facet must stay disclosed, never `empty`. */
  readonly indirectOnly: ReadonlyArray<{ readonly rel: string; readonly content: string }>;
}

const LANGS: LangSpec[] = [
  {
    name: "TS/JS",
    query: "Who calls computeTotal?",
    directOnly: [
      { rel: "package.json", content: '{ "name": "r8a-ts-d", "private": true, "type": "module" }\n' },
      { rel: "src/pricing.ts", content: "export function computeTotal(n: number): number {\n  return n * 2;\n}\n" },
      { rel: "src/direct.ts", content: 'import { computeTotal } from "./pricing";\n\nexport function run(n: number): number {\n  return computeTotal(n);\n}\n' },
    ],
    indirectOnly: [
      { rel: "package.json", content: '{ "name": "r8a-ts-i", "private": true, "type": "module" }\n' },
      { rel: "src/pricing.ts", content: "export function computeTotal(n: number): number {\n  return n * 2;\n}\n" },
      { rel: "src/aliased.ts", content: 'import { computeTotal as calcTotal } from "./pricing";\n\nexport function run(n: number): number {\n  return calcTotal(n);\n}\n' },
      { rel: "src/namespace.ts", content: 'import * as pricing from "./pricing";\n\nexport function run(n: number): number {\n  return pricing.computeTotal(n);\n}\n' },
      { rel: "scripts/run.sh", content: "#!/usr/bin/env bash\n# Example: computeTotal(5) from the CLI wrapper.\n" },
    ],
  },
  {
    name: "Python",
    query: "Who calls compute_total?",
    directOnly: [
      { rel: "pyproject.toml", content: '[project]\nname = "r8a-py-d"\n' },
      { rel: "pricing/__init__.py", content: "def compute_total(n):\n    return n * 2\n" },
      { rel: "app/direct.py", content: "from pricing import compute_total\n\n\ndef run(n):\n    return compute_total(n)\n" },
    ],
    indirectOnly: [
      { rel: "pyproject.toml", content: '[project]\nname = "r8a-py-i"\n' },
      { rel: "pricing/__init__.py", content: "def compute_total(n):\n    return n * 2\n" },
      { rel: "app/aliased.py", content: "from pricing import compute_total as calc_total\n\n\ndef run(n):\n    return calc_total(n)\n" },
      { rel: "app/namespace.py", content: "import pricing\n\n\ndef run(n):\n    return pricing.compute_total(n)\n" },
      { rel: "scripts/run.sh", content: "#!/usr/bin/env bash\n# Example: compute_total(5) from the CLI wrapper.\n" },
    ],
  },
  {
    name: "Go",
    query: "Who calls ComputeTotal?",
    directOnly: [
      { rel: "go.mod", content: "module example.com/r8agod\n\ngo 1.22\n" },
      { rel: "pkg/pricing/pricing.go", content: "package pricing\n\nfunc ComputeTotal(n int) int {\n\treturn n * 2\n}\n" },
      { rel: "cmd/direct/main.go", content: "package main\n\nimport (\n\t\"fmt\"\n\n\t\"example.com/r8agod/pkg/pricing\"\n)\n\nfunc main() {\n\tfmt.Println(pricing.ComputeTotal(5))\n}\n" },
    ],
    indirectOnly: [
      { rel: "go.mod", content: "module example.com/r8agoi\n\ngo 1.22\n" },
      { rel: "pkg/pricing/pricing.go", content: "package pricing\n\nfunc ComputeTotal(n int) int {\n\treturn n * 2\n}\n" },
      { rel: "cmd/aliased/main.go", content: "package main\n\nimport (\n\t\"fmt\"\n\n\tp \"example.com/r8agoi/pkg/pricing\"\n)\n\nfunc main() {\n\tfmt.Println(p.ComputeTotal(5))\n}\n" },
      { rel: "scripts/run.sh", content: "#!/usr/bin/env bash\n# Example: ComputeTotal(5) from the CLI wrapper.\n" },
    ],
  },
  {
    name: "Rust",
    query: "Who calls compute_total?",
    directOnly: [
      { rel: "Cargo.toml", content: '[package]\nname = "r8a-rust-d"\nversion = "0.1.0"\nedition = "2021"\n' },
      { rel: "src/pricing.rs", content: "pub fn compute_total(n: i64) -> i64 {\n    n * 2\n}\n" },
      { rel: "src/main.rs", content: "mod pricing;\n\nuse pricing::compute_total;\n\nfn main() {\n    println!(\"{}\", compute_total(5));\n}\n" },
    ],
    indirectOnly: [
      { rel: "Cargo.toml", content: '[package]\nname = "r8a-rust-i"\nversion = "0.1.0"\nedition = "2021"\n' },
      { rel: "src/pricing.rs", content: "pub fn compute_total(n: i64) -> i64 {\n    n * 2\n}\n" },
      { rel: "src/aliased.rs", content: "use crate::pricing::compute_total as calc_total;\n\npub fn run(n: i64) -> i64 {\n    calc_total(n)\n}\n" },
      { rel: "src/main.rs", content: "mod pricing;\nmod aliased;\n\nfn main() {}\n" },
      { rel: "scripts/run.sh", content: "#!/usr/bin/env bash\n# Example: compute_total(5) from the CLI wrapper.\n" },
    ],
  },
  {
    name: "Java",
    query: "Who calls computeTotal?",
    directOnly: [
      { rel: "pom.xml", content: "<project><modelVersion>4.0.0</modelVersion><groupId>app</groupId><artifactId>app</artifactId><version>1</version></project>\n" },
      { rel: "src/main/java/app/Pricing.java", content: "package app;\n\npublic final class Pricing {\n    public static int computeTotal(int n) {\n        return n * 2;\n    }\n}\n" },
      { rel: "src/main/java/app/Direct.java", content: "package app;\n\npublic final class Direct {\n    public static void main(String[] args) {\n        System.out.println(Pricing.computeTotal(5));\n    }\n}\n" },
    ],
    // Java has no import-aliasing syntax at all -- the ONLY indirect shape
    // (P1-3, javaCallerFromScala) is a caller in a language this scan never
    // classifies (Scala).
    indirectOnly: [
      { rel: "pom.xml", content: "<project><modelVersion>4.0.0</modelVersion><groupId>app</groupId><artifactId>app</artifactId><version>1</version></project>\n" },
      { rel: "src/main/java/app/Pricing.java", content: "package app;\n\npublic final class Pricing {\n    public static int computeTotal(int n) {\n        return n * 2;\n    }\n}\n" },
      { rel: "src/main/scala/app/Caller.scala", content: "package app\n\nobject Caller {\n  def run(): Int = Pricing.computeTotal(5)\n}\n" },
    ],
  },
  {
    name: "Kotlin",
    query: "Who calls computeTotal?",
    directOnly: [
      { rel: "build.gradle.kts", content: "plugins { kotlin(\"jvm\") version \"2.0.0\" }\n" },
      { rel: "src/main/kotlin/pricing/Pricing.kt", content: "package pricing\n\nfun computeTotal(n: Long): Long = n * 2\n" },
      { rel: "src/main/kotlin/report/Direct.kt", content: "package report\n\nimport pricing.computeTotal\n\nfun run(total: Long): Long = computeTotal(total)\n" },
    ],
    indirectOnly: [
      { rel: "build.gradle.kts", content: "plugins { kotlin(\"jvm\") version \"2.0.0\" }\n" },
      { rel: "src/main/kotlin/pricing/Pricing.kt", content: "package pricing\n\nfun computeTotal(n: Long): Long = n * 2\n" },
      { rel: "src/main/kotlin/report/Aliased.kt", content: "package report\n\nimport pricing.computeTotal as calc\n\nfun run(total: Long): Long = calc(total)\n" },
      { rel: "scripts/run.sh", content: "#!/usr/bin/env bash\n# Example: computeTotal(5) from the CLI wrapper.\n" },
    ],
  },
  {
    name: "C/C++",
    query: "Who calls compute_total?",
    directOnly: [
      { rel: "Makefile", content: "all:\n\tclang -o app src/*.c\n" },
      { rel: "src/pricing.h", content: "#pragma once\nint compute_total(int n);\n" },
      { rel: "src/pricing.c", content: "#include \"pricing.h\"\n\nint compute_total(int n) {\n  return n * 2;\n}\n" },
      { rel: "src/direct.c", content: "#include \"pricing.h\"\n#include <stdio.h>\n\nint main(void) {\n  printf(\"%d\\n\", compute_total(5));\n  return 0;\n}\n" },
    ],
    // C has no import-aliasing syntax -- the ONLY indirect shape (P1-3,
    // cCallerFromObjC) is a caller in a language this scan never classifies
    // (Objective-C).
    indirectOnly: [
      { rel: "Makefile", content: "all:\n\tclang -o app src/*.c src/*.m\n" },
      { rel: "src/pricing.h", content: "#pragma once\nint compute_total(int n);\n" },
      { rel: "src/pricing.c", content: "#include \"pricing.h\"\n\nint compute_total(int n) {\n  return n * 2;\n}\n" },
      { rel: "src/AppDelegate.m", content: "#import <Foundation/Foundation.h>\n#include \"pricing.h\"\n\n@implementation AppDelegate\n- (void)report {\n  NSLog(@\"%d\", compute_total(5));\n}\n@end\n" },
    ],
  },
  {
    name: "Ruby",
    query: "Who calls compute_total?",
    directOnly: [
      { rel: "Gemfile", content: 'source "https://rubygems.org"\n' },
      { rel: "lib/pricing.rb", content: "def compute_total(n)\n  n * 2\nend\n" },
      { rel: "lib/direct.rb", content: "require_relative \"pricing\"\n\nputs compute_total(5)\n" },
    ],
    // Ruby's `require`/`require_relative` has no aliasing syntax -- the ONLY
    // indirect shape (P1-3, rubyCallerFromRake) is a caller in a file this
    // scan never classifies (a Rake task file).
    indirectOnly: [
      { rel: "Gemfile", content: 'source "https://rubygems.org"\n' },
      { rel: "lib/pricing.rb", content: "def compute_total(n)\n  n * 2\nend\n" },
      { rel: "lib/tasks/total.rake", content: "require_relative \"../pricing\"\n\nnamespace :total do\n  task :run do\n    puts compute_total(5)\n  end\nend\n" },
    ],
  },
  {
    name: "C#",
    query: "Who calls ComputeTotal?",
    directOnly: [
      { rel: "src/Pricing.cs", content: "namespace App {\n  public static class Pricing {\n    public static int ComputeTotal(int n) => n * 2;\n  }\n}\n" },
      { rel: "src/Direct.cs", content: "namespace App {\n  public static class Direct {\n    public static void Run() {\n      System.Console.WriteLine(Pricing.ComputeTotal(5));\n    }\n  }\n}\n" },
    ],
    // C# has no member-level import alias (`using X = …;` aliases a
    // namespace/type, never hides an individual static method's own NAME
    // from a by-text scan) -- the indirect shape here is a mention-only
    // PowerShell caller (A3's new `.ps1` extension).
    indirectOnly: [
      { rel: "src/Pricing.cs", content: "namespace App {\n  public static class Pricing {\n    public static int ComputeTotal(int n) => n * 2;\n  }\n}\n" },
      { rel: "scripts/run.ps1", content: "# Example: ComputeTotal(5) from the deployment script.\n" },
    ],
  },
  {
    name: "PHP",
    query: "Who calls computeTotal?",
    directOnly: [
      { rel: "composer.json", content: '{ "name": "acme/r8a-php-d" }\n' },
      { rel: "src/Pricing.php", content: "<?php\n\nfunction computeTotal(int $n): int\n{\n    return $n * 2;\n}\n" },
      { rel: "src/Direct.php", content: "<?php\n\nrequire __DIR__ . '/Pricing.php';\n\necho computeTotal(5);\n" },
    ],
    indirectOnly: [
      { rel: "composer.json", content: '{ "name": "acme/r8a-php-i" }\n' },
      { rel: "src/Pricing.php", content: "<?php\n\nfunction computeTotal(int $n): int\n{\n    return $n * 2;\n}\n" },
      { rel: "src/Aliased.php", content: "<?php\n\nuse function App\\Pricing\\computeTotal as calcTotal;\n\necho calcTotal(5);\n" },
      { rel: "scripts/run.sh", content: "#!/usr/bin/env bash\n# Example: computeTotal(5) from the CLI wrapper.\n" },
    ],
  },
];

function buildWorkspace(files: ReadonlyArray<{ readonly rel: string; readonly content: string }>, tag: string): string {
  const ws = makeWorkspace(tag);
  for (const f of files) writeFile(ws, f.rel, f.content);
  return ws;
}

function expectCleanlyCovered(chain: ChainResult, name: string): void {
  const gaps = allGaps(chain);
  expect(gaps).not.toContain(`request-item-empty:callers:${name}`);
  expect(gaps).not.toContain(`request-item-undetermined:callers:${name}`);
}

describe("PART 2 -- per-language caller matrix (direct call control; aliased/namespace/mention-only never empty)", () => {
  for (const lang of LANGS) {
    describe(lang.name, () => {
      it("direct call -- an ordinary plain caller resolves cleanly (control, never regresses to undetermined)", async () => {
        const ws = buildWorkspace(lang.directOnly, `direct-${lang.name.replace(/[^a-z0-9]/gi, "")}`);
        const chain = await ask(ws, lang.query);
        expectCleanlyCovered(chain, lang.query.replace(/^Who calls |\?$/g, ""));
      });

      it("aliased/namespace import or a mention-only-file caller -- never certifies `request-item-empty:callers`", async () => {
        const ws = buildWorkspace(lang.indirectOnly, `indirect-${lang.name.replace(/[^a-z0-9]/gi, "")}`);
        const chain = await ask(ws, lang.query);
        expectNeverFalseEmpty(chain, lang.query.replace(/^Who calls |\?$/g, ""));
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The brief's own two explicit controls
// ---------------------------------------------------------------------------

describe("Control -- a genuinely caller-less focal with only plain imports/specifier strings still reaches `empty` (P1 must not be lost)", () => {
  it("several files plainly import the focal but never call it -- the facet still certifies 0 call sites", async () => {
    const ws = makeWorkspace("control-empty");
    writeFile(ws, "package.json", '{ "name": "r8a-control-empty", "private": true, "type": "module" }\n');
    writeFile(ws, "src/pricing.ts", "export function computeTotal(n: number): number {\n  return n * 2;\n}\n");
    for (let i = 1; i <= 3; i++) {
      // Imports `computeTotal` (a PLAIN, unaliased specifier -- explained by
      // A2/A4 as usual) and never mentions the name again anywhere else on
      // the line or file, so no OTHER textual occurrence can itself trip the
      // separate, pre-existing MENTION GUARD (R5-A1) into `undetermined`.
      writeFile(ws, `src/use${i}.ts`, `import { computeTotal } from "./pricing";\n\nexport const unrelatedValue${i}: number = ${i};\n`);
    }
    const chain = await ask(ws, "Who calls computeTotal?");
    expect(allGaps(chain)).toContain("request-item-empty:callers:computeTotal (0 call sites");
  });
});

describe("Control -- one real caller among 26 type-only importers of a same-named module is not drowned", () => {
  it("26 `import type { X } from \"./pricing\"` files never count as mentions (A4(i)); the 1 real call is still served", async () => {
    const ws = makeWorkspace("control-cost");
    writeFile(ws, "package.json", '{ "name": "r8a-control-cost", "private": true, "type": "module" }\n');
    writeFile(ws, "src/pricing.ts", "export interface PricingOptions {\n  markup?: number;\n}\n\nexport function pricing(n: number): number {\n  return n * 2;\n}\n");
    writeFile(ws, "src/caller.ts", 'import { pricing } from "./pricing";\n\nexport function run(n: number): number {\n  return pricing(n);\n}\n');
    for (let i = 1; i <= 26; i++) {
      writeFile(ws, `src/use${i}.ts`, `import type { PricingOptions } from "./pricing";\n\nexport function describe${i}(o: PricingOptions): string {\n  return String(o.markup ?? 0);\n}\n`);
    }
    const chain = await ask(ws, "Who calls pricing?");
    const why = allWhy(chain);
    expect(why).toContain("1 of 1 call sites");
    expect(why).not.toContain("more than");
    expect(allGaps(chain)).not.toContain("request-item-empty:callers:pricing (0 call sites");
  });
});
