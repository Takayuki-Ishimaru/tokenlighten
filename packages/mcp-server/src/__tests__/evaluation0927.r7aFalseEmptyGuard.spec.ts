/**
 * evaluation0927.r7aFalseEmptyGuard.spec.ts — R7-A (round-7 wave,
 * 2026-09-28): regression coverage for review-findings-fable-r6.md's P0-1
 * (every `export default <expr>` shape the OLD prefix-test-plus-denylist
 * mention guard still explained away), P0-2 (a focal declared as its
 * module's default export must never certify `empty` from zero recorded
 * sites), P1-5 (embedded-code file extensions the caller/mention scan never
 * opened at all), P2-10 (TS `import x = …;`, the same root cause as P0-1)
 * and the P1-6/P2-11 mask-error safety net (A4: only a CONFIDENT masked
 * line is dropped outright; a call on a block-comment CLOSER line is
 * classified from `codeFrom`; the mention guard's own `*`/`/*` line-start
 * shortcuts no longer fire outside a genuine block comment).
 *
 * THE ROUND-7 PRINCIPLE: a mention is explained away only by a POSITIVE,
 * exact match against a fixed shape list — everything else stays an
 * unexplained mention. Most of this file is a FAST, EXHAUSTIVE unit matrix
 * over `mentionExplainedByImportExportLine` / `mentionExplainedByImportExport`
 * / `focalIsSoleDefaultExport` / `isCallerMentionOnlyFile` / `memberOnlyInCommentText`
 * (all exported from readCodeTaskPack.ts only for this spec), plus a
 * handful of end-to-end server chains that prove the wiring from those pure
 * functions through to the certified decision actually holds.
 *
 * Every fixture is written FRESH against the DESCRIBED defect class —
 * `computeTotal`/`pricing.ts`, never the reviewer's own `formatBytes`
 * identifiers or file names (`brief-round5.md`'s own convention for this
 * style of regression spec).
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
  memberOnlyInCommentText,
  mentionExplainedByImportExport,
  mentionExplainedByImportExportLine,
  type MentionCommentLineState,
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

// ---------------------------------------------------------------------------
// Unit matrix — `mentionExplainedByImportExportLine` (single-line shapes)
// ---------------------------------------------------------------------------

describe("mentionExplainedByImportExportLine — P0-1's positive shape list", () => {
  const M = "computeTotal";

  describe("P0-1 (review-r6 finding 1) — every export-default EXPRESSION shape stays an unexplained mention", () => {
    const shapes: Array<[string, string]> = [
      ["object-literal alias (exportDefaultObjAlias)", "export default { calc: computeTotal };"],
      ["call-wrapped reference (exportDefaultCallRef)", "export default wrapWithLogging(computeTotal);"],
      ["array reference (exportDefaultArrayRef)", "export default [computeTotal];"],
      ["parenthesized reference", "export default (computeTotal);"],
      ["curried call reference", "export default connect(mapState)(computeTotal);"],
      ["arrow-body reference", "export default () => computeTotal;"],
      ["shorthand object-literal reference", "export default { computeTotal };"],
    ];
    for (const [label, line] of shapes) {
      it(`${label}: \`${line}\``, () => {
        expect(mentionExplainedByImportExportLine(line, M)).toBe(false);
      });
    }
  });

  it("P0-1 control — a bare `export default member;` rebind also stays a mention (unchanged from before this fix)", () => {
    expect(mentionExplainedByImportExportLine("export default computeTotal;", M)).toBe(false);
  });

  it("P2-10 (review-r6 P2 finding 10, importEqualsAlias) — TS `import x = …;` stays a mention", () => {
    expect(mentionExplainedByImportExportLine("import fmt = F.computeTotal;", M)).toBe(false);
  });

  it("`export = …;` (TS/JS CommonJS-style export assignment) stays a mention", () => {
    expect(mentionExplainedByImportExportLine("export = computeTotal;", M)).toBe(false);
  });

  it("`module.exports = member;` (a SEPARATE reference, not the declaration itself) stays a mention", () => {
    expect(mentionExplainedByImportExportLine("module.exports = computeTotal;", M)).toBe(false);
  });

  it("`exports.x = member;` stays a mention", () => {
    expect(mentionExplainedByImportExportLine("exports.total = computeTotal;", M)).toBe(false);
  });

  describe("aliased entries never explain, in every language this module recognizes", () => {
    const aliased: Array<[string, string]> = [
      ["TS named import `X as Y`", 'import { computeTotal as calcTotal } from "./pricing";'],
      ["TS named re-export `X as Y`", 'export { computeTotal as calcTotal } from "./pricing";'],
      ["CJS destructure rename", 'const { computeTotal: calcTotal } = require("./pricing");'],
      ["Python `import X as Y`", "from pricing import computeTotal as calc_total"],
      ["Rust `use … as`", "use crate::pricing::computeTotal as calc_total;"],
      ["C# alias directive `using X = …;`", "using CalcTotal = App.Pricing.computeTotal;"],
    ];
    for (const [label, line] of aliased) {
      it(label, () => {
        expect(mentionExplainedByImportExportLine(line, M)).toBe(false);
      });
    }
  });

  describe("plain (unaliased) specifiers DO explain, across languages", () => {
    const plain: Array<[string, string]> = [
      ["TS named import", 'import { computeTotal } from "./pricing";'],
      ["TS named import, type-only entry", 'import { type computeTotal } from "./pricing";'],
      ["TS default import", 'import computeTotal from "./pricing";'],
      ["TS default + named import", 'import computeTotal, { helper } from "./pricing";'],
      ["TS namespace import", 'import * as computeTotal from "./pricing";'],
      ["TS named re-export", 'export { computeTotal } from "./pricing";'],
      ["TS named export (local list)", "export { computeTotal };"],
      ["TS namespace re-export", 'export * as computeTotal from "./pricing";'],
      ["CJS destructured require", 'const { computeTotal } = require("./pricing");'],
      ["Python `from x import name`", "from pricing import computeTotal"],
      ["Python `from x import (name)`", "from pricing import (computeTotal)"],
      ["Python dotted `import a.b.m`", "import pricing.computeTotal"],
      ["Java/Kotlin `import static ….m;`", "import static pricing.Pricing.computeTotal;"],
      ["Kotlin plain `import ….m`", "import pricing.computeTotal"],
      ["Dart `show m` combinator", "import 'pricing.dart' show computeTotal;"],
      ["Rust `use ...::m;`", "use crate::pricing::computeTotal;"],
      ["Rust `use ...::{…, m, …};`", "use crate::pricing::{helper, computeTotal};"],
      ["PHP `use function …\\m;`", "use function App\\Pricing\\computeTotal;"],
      ["C# `using static …;`", "using static App.Pricing.computeTotal;"],
      ["C# plain `using …;`", "using App.Pricing.computeTotal;"],
      ["C++ using-declaration `using ns::m;`", "using pricing::computeTotal;"],
      ["C/C++ `#include`", '#include "computeTotal.h"'],
    ];
    for (const [label, line] of plain) {
      it(label, () => {
        expect(mentionExplainedByImportExportLine(line, M)).toBe(true);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit matrix — `mentionExplainedByImportExport` (multi-line list clause)
// ---------------------------------------------------------------------------

describe("mentionExplainedByImportExport — the multi-line-list clause", () => {
  it("a plain entry alone on its own line inside a multi-line TS import list is explained", () => {
    const lines = ["import {", "  computeTotal,", '} from "./pricing";'];
    expect(mentionExplainedByImportExport(lines, 2, "computeTotal")).toBe(true);
  });

  it("a plain entry alone on its own line inside a multi-line Python parenthesized import is explained", () => {
    const lines = ["from pricing import (", "  computeTotal,", ")"];
    expect(mentionExplainedByImportExport(lines, 2, "computeTotal")).toBe(true);
  });

  it("a plain entry alone on its own line inside a multi-line Rust `use` list is explained", () => {
    const lines = ["use crate::pricing::{", "  helper,", "  computeTotal,", "};"];
    expect(mentionExplainedByImportExport(lines, 3, "computeTotal")).toBe(true);
  });

  it("a comma-list continuation line (several entries on one line) is explained", () => {
    const lines = ["import {", "  helper, computeTotal,", '} from "./pricing";'];
    expect(mentionExplainedByImportExport(lines, 2, "computeTotal")).toBe(true);
  });

  it("control — a bare same-named line inside an ORDINARY code block (not a list) is never explained", () => {
    const lines = ["function useIt() {", "  computeTotal", "}"];
    expect(mentionExplainedByImportExport(lines, 2, "computeTotal")).toBe(false);
  });

  it("control — an aliased entry on its own multi-line-list line is never explained", () => {
    const lines = ["import {", "  computeTotal as calcTotal,", '} from "./pricing";'];
    expect(mentionExplainedByImportExport(lines, 2, "computeTotal")).toBe(false);
  });

  it("control — a bare entry past an unrelated closed list higher up is never explained", () => {
    const lines = [
      "import { helper } from \"./helper\";",
      "",
      "const table = {",
      "  computeTotal,",
      "};",
    ];
    // line 4 ("  computeTotal,") sits inside an object LITERAL, not an
    // import/export/use list -- the backward scan must stop at that
    // literal's own opener (line 3), never walk past it to the unrelated,
    // already-closed import list on line 1.
    expect(mentionExplainedByImportExport(lines, 4, "computeTotal")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit matrix — `focalIsSoleDefaultExport` (P0-2)
// ---------------------------------------------------------------------------

describe("focalIsSoleDefaultExport — P0-2's declaration-shape recognizer", () => {
  const shapes: Array<[string, string[], number, string]> = [
    ["`export default function m(...)`", ["export default function computeTotal(n) {", "  return n * 2;", "}"], 1, "computeTotal"],
    ["`export default async function m(...)`", ["export default async function computeTotal(n) {", "  return n * 2;", "}"], 1, "computeTotal"],
    ["`export default class M`", ["export default class ComputeTotal {", "  run() {}", "}"], 1, "ComputeTotal"],
    ["`export default abstract class M`", ["export default abstract class ComputeTotal {", "}"], 1, "ComputeTotal"],
    ["CJS `module.exports = function m(...)`", ["module.exports = function computeTotal(n) {", "  return n * 2;", "}"], 1, "computeTotal"],
    ["CJS `module.exports = class M`", ["module.exports = class ComputeTotal {", "}"], 1, "ComputeTotal"],
  ];
  for (const [label, lines, startLine, member] of shapes) {
    it(`${label} is recognized`, () => {
      expect(focalIsSoleDefaultExport(lines, startLine, member)).toBe(true);
    });
  }

  it("a split `export default\\nfunction m(...)` header (one line before startLine) is still recognized", () => {
    const lines = ["export default", "function computeTotal(n) {", "  return n * 2;", "}"];
    expect(focalIsSoleDefaultExport(lines, 2, "computeTotal")).toBe(true);
  });

  it("control — an ordinary NAMED export declaration is never mistaken for a default export", () => {
    const lines = ["export function computeTotal(n) {", "  return n * 2;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, "computeTotal")).toBe(false);
  });

  it("control — a SEPARATE `export default member;` line elsewhere in the file does not count (only the focal's own declaration header is checked)", () => {
    const lines = ["export default computeTotal;", "", "function computeTotal(n) {", "  return n * 2;", "}"];
    // The focal's OWN declaration starts at line 3 (`function computeTotal`),
    // not the unrelated `export default computeTotal;` two lines above it.
    expect(focalIsSoleDefaultExport(lines, 3, "computeTotal")).toBe(false);
  });

  it("control — a default export of a DIFFERENT name never matches", () => {
    const lines = ["export default function otherHelper(n) {", "  return n;", "}"];
    expect(focalIsSoleDefaultExport(lines, 1, "computeTotal")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit matrix — `isCallerMentionOnlyFile` (A3)
// ---------------------------------------------------------------------------

describe("isCallerMentionOnlyFile — A3's embedded-code extension list", () => {
  const mentionOnly = [
    "src/Page.html", "src/Page.htm", "src/Page.xhtml", "src/Page.cshtml", "src/Page.razor",
    "src/Page.vbhtml", "src/Page.aspx", "src/Widget.ascx", "src/page.jsp", "app/views/page.html.erb",
    "app/views/page.ejs", "views/page.hbs", "views/page.handlebars", "views/page.mustache",
    "templates/page.jinja", "templates/page.jinja2", "templates/page.j2", "templates/page.twig",
    "templates/page.njk", "templates/page.liquid", "views/page.pug", "views/page.jade",
    "views/page.haml", "views/page.slim", "docs/guide.mdx", "notebooks/analysis.ipynb",
  ];
  for (const p of mentionOnly) {
    it(`${p} is mention-only`, () => {
      expect(isCallerMentionOnlyFile(p)).toBe(true);
    });
  }

  const stillClassified = ["src/Total.vue", "src/Total.svelte", "src/Total.astro", "src/pricing.ts", "src/pricing.py", "src/pricing.go"];
  for (const p of stillClassified) {
    it(`${p} stays classified (never routed to mention-only)`, () => {
      expect(isCallerMentionOnlyFile(p)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Unit matrix — `memberOnlyInCommentText` (A4, the mask-error safety net)
// ---------------------------------------------------------------------------

describe("memberOnlyInCommentText — A4's state-aware comment judgment", () => {
  const M = "computeTotal";
  const notMasked: MentionCommentLineState = { masked: false, confident: false, codeFrom: undefined };
  const confidentNoCode: MentionCommentLineState = { masked: true, confident: true, codeFrom: undefined };
  const nonConfidentMasked: MentionCommentLineState = { masked: true, confident: false, codeFrom: undefined };

  it("a CONFIDENT masked line (no trailing code) is comment text outright", () => {
    expect(memberOnlyInCommentText("   Usage: computeTotal(1024) returns bytes.", M, false, confidentNoCode)).toBe(true);
  });

  it("a CONFIDENT closer line: an occurrence BEFORE `codeFrom` is comment text", () => {
    const text = "  discusses computeTotal */ run(2);";
    const codeFrom = text.indexOf("*/") + 2;
    const state: MentionCommentLineState = { masked: false, confident: true, codeFrom };
    expect(memberOnlyInCommentText(text, M, false, state)).toBe(true);
  });

  it("a CONFIDENT closer line: an occurrence AT/AFTER `codeFrom` is real code, never comment", () => {
    const text = "  */ computeTotal(2048);";
    const codeFrom = text.indexOf("*/") + 2;
    const state: MentionCommentLineState = { masked: false, confident: true, codeFrom };
    expect(memberOnlyInCommentText(text, M, false, state)).toBe(false);
  });

  it("P2-8 regression (round-6, `* run(x) = 3;`-shaped): a `*`-led line OUTSIDE any block comment is real code, never comment text", () => {
    // `*out = computeTotal;` (a C pointer-dereference assignment) — starts
    // with `*` but `state.masked` is false: this file position is NOT
    // inside any block comment at all. The OLD blind `startsWith("*")`
    // shortcut hid this unconditionally; A4 requires the file state to
    // actually say so first.
    expect(memberOnlyInCommentText("  *out = computeTotal;", M, false, notMasked)).toBe(false);
  });

  it("a `*`-led doc-continuation line INSIDE a (non-confident) block comment is still comment text", () => {
    expect(memberOnlyInCommentText("   * see computeTotal for details", M, false, nonConfidentMasked)).toBe(true);
  });

  it("a `*`-led line the file state marks NEITHER masked nor confident is real code even when it merely LOOKS like a doc line", () => {
    expect(memberOnlyInCommentText("   * 2 + computeTotal", M, false, notMasked)).toBe(false);
  });

  it("an inline `/* … */` span fully covering the member is comment text", () => {
    expect(memberOnlyInCommentText("  run(/* calls computeTotal internally */ 1);", M, false, notMasked)).toBe(true);
  });

  it("an inline `/* … */` span that does NOT cover the member leaves it real code", () => {
    expect(memberOnlyInCommentText("  /* note */ computeTotal(2048);", M, false, notMasked)).toBe(false);
  });

  it("a trailing `//` line comment still hides everything after it (unchanged behaviour)", () => {
    expect(memberOnlyInCommentText("  run(1); // see computeTotal", M, false, notMasked)).toBe(true);
  });

  it("a trailing `//` line comment never hides a REAL occurrence before it", () => {
    expect(memberOnlyInCommentText("  computeTotal(1); // ok", M, false, notMasked)).toBe(false);
  });

  it("a trailing `#` comment (hash-comment language) hides everything after it", () => {
    expect(memberOnlyInCommentText("  run(1)  # see computeTotal", M, true, notMasked)).toBe(true);
  });

  it("control — an ordinary code line with no comment marker at all is never comment text", () => {
    expect(memberOnlyInCommentText("  return computeTotal(amount);", M, false, notMasked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end wiring — the pure functions above actually reach the certified
// decision, through callSitesForFocalMember/plainFunctionCallerSites/
// sameFileFacetCallSites, facetGate.ts and the wire.
// ---------------------------------------------------------------------------

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r7a-${tag}-`));
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

async function ask(ws: string, query: string, hopCap = 20): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return followNextToEnd(
    s,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap },
  );
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

function pricingWorkspace(ws: string, extra: (ws: string) => void): void {
  writeFile(ws, "package.json", '{ "name": "r7a-guard", "private": true, "type": "module" }\n');
  writeFile(
    ws,
    "src/pricing.ts",
    "export function computeTotal(amount: number): number {\n  return amount * 2;\n}\n\nexport function unrelatedHelper(x: number): number {\n  return x + 1;\n}\n",
  );
  extra(ws);
}

describe("P0-1 end-to-end — an export-default EXPRESSION never certifies a false empty", () => {
  it("`export default { calc: computeTotal };` + `api.calc(2048)`", async () => {
    const ws = makeWorkspace("p01-obj-alias");
    pricingWorkspace(ws, (root) => {
      writeFile(root, "src/handler.ts", "import { computeTotal } from \"./pricing\";\n\nexport default { calc: computeTotal };\n");
      writeFile(root, "src/main.ts", "import api from \"./handler\";\n\nexport function main(): number {\n  return api.calc(5);\n}\n");
    });
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("`export default wrapWithLogging(computeTotal);`", async () => {
    const ws = makeWorkspace("p01-call-ref");
    pricingWorkspace(ws, (root) => {
      writeFile(
        root,
        "src/handler.ts",
        "import { computeTotal } from \"./pricing\";\n\nfunction wrapWithLogging<T>(fn: T): T {\n  return fn;\n}\n\nexport default wrapWithLogging(computeTotal);\n",
      );
      writeFile(root, "src/main.ts", "import scheduled from \"./handler\";\n\nexport function main(): unknown {\n  return scheduled;\n}\n");
    });
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("`export default [computeTotal];`", async () => {
    const ws = makeWorkspace("p01-array-ref");
    pricingWorkspace(ws, (root) => {
      writeFile(root, "src/handler.ts", "import { computeTotal } from \"./pricing\";\n\nexport default [computeTotal];\n");
    });
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });
});

describe("P0-2 end-to-end — a default-exported declaration's callers facet is never empty", () => {
  it("zero by-name sites -> undetermined naming the default-export limitation, never empty", async () => {
    const ws = makeWorkspace("p02-default-decl");
    writeFile(ws, "package.json", '{ "name": "r7a-default-decl", "private": true, "type": "module" }\n');
    writeFile(ws, "src/format.ts", "export default function computeTotal(amount: number): number {\n  return amount * 2;\n}\n");
    writeFile(ws, "src/main.ts", "import fmt from \"./format\";\n\nexport function main(): number {\n  return fmt(5);\n}\n");
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
    expect(allGaps(chain)).toContain("default export");
  });

  it("control — a default-exported CLASS's method is still reached via its own mention (unaffected by this fix)", async () => {
    const ws = makeWorkspace("p02-default-class-control");
    writeFile(ws, "package.json", '{ "name": "r7a-default-class", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/client.ts",
      "export default class HttpClient {\n  request(id: number): number {\n    return id;\n  }\n}\n",
    );
    writeFile(
      ws,
      "src/main.ts",
      "import HttpClient from \"./client\";\n\nexport function main(): number {\n  const client = new HttpClient();\n  return client.request(5);\n}\n",
    );
    const chain = await ask(ws, "Who calls HttpClient.request?");
    expect(["act.answer", "discover"]).toContain(finalDecisionKind(chain));
  });
});

describe("A3 end-to-end — an embedded-code file's call is a mention, never silently dropped", () => {
  it("a Ruby ERB template's real call is disclosed, never certified empty", async () => {
    const ws = makeWorkspace("a3-erb");
    pricingWorkspace(ws, (root) =>
      writeFile(root, "app/views/receipt.html.erb", "<p>Total: <%= computeTotal(2048) %></p>\n"));
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("a Jupyter notebook cell's real call is disclosed, never certified empty", async () => {
    const ws = makeWorkspace("a3-ipynb");
    pricingWorkspace(ws, (root) =>
      writeFile(
        root,
        "notebooks/analysis.ipynb",
        JSON.stringify({
          cells: [{ cell_type: "code", source: ["from pricing import computeTotal\n", "computeTotal(2048)\n"] }],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        }),
      ));
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });
});

describe("P2-10 end-to-end — TS `import x = …;` stays an unexplained mention", () => {
  it("`import fmt = F.computeTotal;` + `fmt(total)`", async () => {
    const ws = makeWorkspace("p2-10-import-equals");
    pricingWorkspace(ws, (root) => {
      writeFile(root, "src/wrap.ts", "import * as F from \"./pricing\";\nimport fmt = F.computeTotal;\n\nexport function run(total: number): number {\n  return fmt(total);\n}\n");
    });
    const chain = await ask(ws, "Who calls computeTotal?");
    expectNeverFalseEmpty(chain, "computeTotal");
  });
});

describe("A4 end-to-end — the mask-error safety net", () => {
  it("P2-11: a call on a block-comment CLOSER line is a real, classified call site (not just a mention)", async () => {
    const ws = makeWorkspace("a4-closer-line");
    pricingWorkspace(ws, (root) =>
      writeFile(
        root,
        "src/caller.ts",
        "import { computeTotal } from \"./pricing\";\n\nexport function run(): number {\n  /* long\n     explanation\n  */ return computeTotal(2048);\n}\n",
      ));
    const chain = await ask(ws, "Who calls computeTotal?");
    expect(allWhy(chain)).toContain("1 of 1 call sites");
    expectNeverFalseEmpty(chain, "computeTotal");
  });

  it("P2-8-adjacent: a `*`-led reference OUTSIDE any block comment is disclosed, never silently swallowed", async () => {
    const ws = makeWorkspace("a4-star-outside-comment");
    pricingWorkspace(ws, (root) =>
      writeFile(
        root,
        "src/registry.ts",
        "import { computeTotal } from \"./pricing\";\n\nconst handlers: Record<string, unknown> = {};\nexport function register(): void {\n  handlers['total']\n    * 1;\n  (handlers as Record<string, unknown>)['fn'] = computeTotal;\n}\n",
      ));
    const chain = await ask(ws, "Who calls computeTotal?");
    // Not a real call site (the reference is a bare assignment target, never
    // invoked) -- must stay disclosed (mention -> undetermined/open), never
    // a plain `request-item-empty:callers:computeTotal (0 call sites`.
    expectNeverFalseEmpty(chain, "computeTotal");
  });
});
