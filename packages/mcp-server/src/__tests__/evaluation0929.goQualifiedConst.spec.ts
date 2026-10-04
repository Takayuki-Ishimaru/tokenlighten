/**
 * evaluation0929.goQualifiedConst.spec.ts — WP-K (eval-0929 §4/§8; chip
 * adopted from WP-I's own report: "a Go package-qualified constant read is
 * never verified empty").
 *
 * REPORTED SHAPE: `go.mod` `module example.com/app`; `limits/limits.go`
 * `package limits\nconst StepBaseMs = 7310\n`; `poll/step.go` `package
 * poll\nimport lim "example.com/app/limits"\nfunc PollStep() int { return
 * lim.StepBaseMs }`. "What default value does PollStep return?" (answer
 * profile) certified `act.answer` with
 * `explicit-gap:request-item-empty:value:PollStep (PollStep reads no module
 * constant and holds no literal; …)` — a VERIFIED-EMPTY claim while the
 * function plainly reads a package constant through an ALIASED import.
 *
 * ROOT CAUSE (own investigation): `findGoQualifiedPackageConstantWindow`
 * (readCodeTaskPack.ts) resolved a Go package qualifier by scanning the
 * WHOLE workspace for `^package <alias>\b` — correct only when the alias
 * happens to equal the real declared package name (the common, unaliased
 * convention). An EXPLICIT alias (`import lim "…/limits"`, package
 * `limits`) made that scan find nothing, and the caller
 * (`resolveQualifiedReferencesIn`) then silently `continue`d on a miss —
 * never pushed to `unresolved`/`unresolvedPackages`, the SAME disclosure
 * mechanism every other language's alias-miss branch already used. With no
 * served window and no disclosed gap, `facetGate.ts`'s value/condition
 * empty-check (`focal.name reads no module constant and holds no literal`)
 * fired on a body that, textually, plainly does read one.
 *
 * FIX: `findGoQualifiedPackageConstantWindow` now resolves the import PATH
 * (`goImportPathAliasesIn`, evidenceClosure.ts) through the nearest go.mod's
 * `module` line to a workspace DIRECTORY (module-path prefix, a cheap
 * `replace` directive, or a `vendor/` mirror), then searches that
 * directory's own `.go` files directly — never a same-named package
 * elsewhere. A miss (import path outside the workspace/module, or a
 * resolved package that does not declare the member) is now disclosed via
 * `unresolved`/`unresolvedPackages`, exactly like every other language.
 * `isTestConcernPath` (readCodeTaskPack.ts, 18 call sites) also gained the
 * Go `_test.go` suffix convention it was missing (its two existing
 * patterns — a `test`/`spec` directory segment, or a `.test.`/`.spec.`
 * dotted filename — never matched Go's underscore convention at all).
 *
 * Every fixture below uses fresh values never used by the evaluator's own
 * fixtures, the orchestrator's metamorphic matrix, or `evaluation0929.
 * goClosure.spec.ts` (which already locks in the unaliased same-module
 * cross-package shape as a recall control, run — not duplicated — here).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929goq-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function ask(ws: string, query: string, opts: { hopCap?: number } = {}): Promise<ChainResult> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  const args: Record<string, unknown> = { query, task: { epoch: "new", profile: "answer" }, cwd: ws };
  return followNextToEnd(s, { tool: "tl_read_file", arguments: args }, { cwd: ws, hopCap: opts.hopCap ?? 20 });
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

function evidenceWhys(chain: ChainResult): string[] {
  const out: string[] = [];
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) {
      if (typeof e?.why === "string") out.push(e.why);
    }
  }
  return out;
}

function evidenceBodies(chain: ChainResult): string[] {
  const out: string[] = [];
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) {
      if (typeof e?.body === "string") out.push(e.body);
    }
  }
  return out;
}

/** The value MUST be served somewhere in the chain's evidence, via a `closure:value` (or `closure:condition`) row — never merely a same-file coincidence. */
function assertValueServedByClosure(chain: ChainResult, marker: string): void {
  const text = evidenceBodies(chain).join("\n");
  expect(text, `expected "${marker}" to be served somewhere in the chain's evidence`).toContain(marker);
  const whys = evidenceWhys(chain);
  expect(whys.some((w) => w.startsWith("closure:")), `expected a "closure:" evidence row (why=${JSON.stringify(whys)})`).toBe(true);
}

/** P3 floor (eval-0929 §4/§5/§8's own invariant): never `act.answer`/`act.edit` with `marker` missing from evidence AND no undetermined/empty gap disclosing the shortfall anywhere up to that certification. */
function assertNeverFalseReady(chain: ChainResult, marker: string): void {
  const text = evidenceBodies(chain).join("\n");
  if (text.includes(marker)) return;
  const certifying = chain.hops.find((h) => decisionOf(h.response).kind === "act.answer" || decisionOf(h.response).kind === "act.edit");
  if (!certifying) return;
  const gaps = gapRefs(certifying.response);
  expect(
    gaps.some((g) => g.includes("request-item-undetermined") || g.includes("request-item-empty")),
    `certified with "${marker}" missing and no undetermined/empty gap disclosed (gaps: ${JSON.stringify(gaps)})`,
  ).toBe(true);
}

// ===========================================================================
// 1. The reported shape itself: an EXPLICITLY ALIASED cross-package import
// whose alias differs from the real declared package name.
// ===========================================================================
function aliasedFixture(ws: string): void {
  writeFile(ws, "go.mod", "module example.com/app\n\ngo 1.21\n");
  writeFile(ws, "limits/limits.go", "package limits\n\nconst StepBaseMs = 6203\n");
  writeFile(ws, "poll/step.go", 'package poll\n\nimport lim "example.com/app/limits"\n\nfunc PollStep() int {\n\treturn lim.StepBaseMs\n}\n');
}

describe("E2E Go: an aliased cross-package import (the reported false-empty shape)", () => {
  it("bare query: the aliased value is resolved, never verified-empty", async () => {
    const ws = makeWorkspace("alias-bare");
    aliasedFixture(ws);
    const chain = await ask(ws, "What default value does PollStep return?");
    assertValueServedByClosure(chain, "6203");
    assertNeverFalseReady(chain, "6203");
  }, 120_000);

  it("path-named query: the aliased value is still resolved", async () => {
    const ws = makeWorkspace("alias-path");
    aliasedFixture(ws);
    const chain = await ask(ws, "In poll/step.go, what default value does PollStep return?");
    assertValueServedByClosure(chain, "6203");
    assertNeverFalseReady(chain, "6203");
  }, 120_000);
});

// ===========================================================================
// 2. A grouped `import (…)` block mixing an ALIASED entry, an UNALIASED
// entry, and a DOT import — the dot import binds no alias at all and must
// never disturb the other two bindings' own resolution.
// ===========================================================================
describe("E2E Go: grouped import block (alias + unaliased + dot import)", () => {
  it("both grouped package values resolve; the dot import is inert", async () => {
    const ws = makeWorkspace("grouped");
    writeFile(ws, "go.mod", "module example.com/app\n\ngo 1.21\n");
    writeFile(ws, "limitsA/limitsA.go", "package limitsA\n\nconst AlphaMs = 51015\n");
    writeFile(ws, "limitsB/limitsB.go", "package limitsB\n\nconst BetaMs = 2077\n");
    writeFile(
      ws,
      "consumer/combo.go",
      'package consumer\n\nimport (\n\tlim "example.com/app/limitsA"\n\t"example.com/app/limitsB"\n\t. "fmt"\n)\n\nfunc Combo() int {\n\treturn lim.AlphaMs + limitsB.BetaMs\n}\n',
    );
    const chain = await ask(ws, "What default value does Combo return?");
    assertValueServedByClosure(chain, "51015");
    assertValueServedByClosure(chain, "2077");
    assertNeverFalseReady(chain, "51015");
    assertNeverFalseReady(chain, "2077");
  }, 120_000);
});

// ===========================================================================
// 3. A nested module sub-package path (two directories deep under the
// module root) still resolves through go.mod.
// ===========================================================================
describe("E2E Go: a nested module sub-package path", () => {
  it("a two-levels-deep package directory resolves", async () => {
    const ws = makeWorkspace("nested");
    writeFile(ws, "go.mod", "module example.com/app\n\ngo 1.21\n");
    writeFile(ws, "internal/config/limits/limits.go", "package limits\n\nconst DeepMs = 33441\n");
    writeFile(ws, "poll/deep.go", 'package poll\n\nimport dl "example.com/app/internal/config/limits"\n\nfunc DeepStep() int {\n\treturn dl.DeepMs\n}\n');
    const chain = await ask(ws, "What default value does DeepStep return?");
    assertValueServedByClosure(chain, "33441");
    assertNeverFalseReady(chain, "33441");
  }, 120_000);
});

// ===========================================================================
// 4. A go.mod `replace` directive (cheap, local-path-only) and a `vendor/`
// mirror each resolve their own imported package.
// ===========================================================================
describe("E2E Go: go.mod replace directive and a vendor/ mirror", () => {
  it("a replace-redirected package and a vendor-mirrored package both resolve", async () => {
    const ws = makeWorkspace("replace-vendor");
    writeFile(ws, "go.mod", "module example.com/app\n\ngo 1.21\n\nreplace example.com/vendored/alpha => ./thirdparty/alpha\n");
    writeFile(ws, "thirdparty/alpha/alpha.go", "package alpha\n\nconst ReplacedMs = 8814\n");
    writeFile(ws, "vendor/example.com/other/beta/beta.go", "package beta\n\nconst VendoredMs = 47709\n");
    writeFile(
      ws,
      "consumer/combo.go",
      'package consumer\n\nimport (\n\talpha "example.com/vendored/alpha"\n\t"example.com/other/beta"\n)\n\nfunc Combo() int {\n\treturn alpha.ReplacedMs + beta.VendoredMs\n}\n',
    );
    const chain = await ask(ws, "What default value does Combo return?");
    assertValueServedByClosure(chain, "8814");
    assertValueServedByClosure(chain, "47709");
    assertNeverFalseReady(chain, "8814");
    assertNeverFalseReady(chain, "47709");
  }, 120_000);
});

// ===========================================================================
// 5. A same-named package declared elsewhere in the workspace (never
// imported) must never steal the binding -- the by-declared-name text scan
// this fix demotes to a fallback would have matched EITHER file; the decoy
// sorts first alphabetically so a regression back to that scan is likely to
// surface as the WRONG value being served.
// ===========================================================================
describe("E2E Go: a same-name package elsewhere never steals the import's own value", () => {
  it("the imported package's own value is served; the decoy's namesake value never appears", async () => {
    const ws = makeWorkspace("decoy");
    writeFile(ws, "go.mod", "module example.com/app\n\ngo 1.21\n");
    writeFile(ws, "aaa/limits/limits.go", "package limits\n\nconst RealMs = 99999\n");
    writeFile(ws, "zzz/limits/limits.go", "package limits\n\nconst RealMs = 60112\n");
    writeFile(ws, "consumer/step.go", 'package consumer\n\nimport lim "example.com/app/zzz/limits"\n\nfunc Combo() int {\n\treturn lim.RealMs\n}\n');
    const chain = await ask(ws, "What default value does Combo return?");
    assertValueServedByClosure(chain, "60112");
    assertNeverFalseReady(chain, "60112");
    const text = evidenceBodies(chain).join("\n");
    expect(text, "the unrelated decoy package's own value must never be served").not.toContain("99999");
  }, 120_000);
});

// ===========================================================================
// 6. A receiver method reading an ALIASED cross-package constant (the
// reported shape's own "same with a receiver method" note).
// ===========================================================================
describe("E2E Go: a receiver method reading an aliased cross-package constant", () => {
  it("the receiver method's aliased value is resolved", async () => {
    const ws = makeWorkspace("receiver-alias");
    writeFile(ws, "go.mod", "module example.com/app\n\ngo 1.21\n");
    writeFile(ws, "limits/limits.go", "package limits\n\nconst RecvMs = 71536\n");
    writeFile(ws, "poll/poller.go", 'package poll\n\nimport lim "example.com/app/limits"\n\ntype Poller struct{}\n\nfunc (p *Poller) Step() int {\n\treturn lim.RecvMs\n}\n');
    const chain = await ask(ws, "What default value does the Poller Step method return?");
    assertValueServedByClosure(chain, "71536");
    assertNeverFalseReady(chain, "71536");
  }, 120_000);
});

// ===========================================================================
// 7. A genuinely external (out-of-module) import is disclosed by NAME, never
// silently certified covered and never left as a bare, unattributed miss.
// ===========================================================================
describe("E2E Go: a genuinely external import is disclosed by name", () => {
  it("certifying with the value missing names the external package in the gap", async () => {
    const ws = makeWorkspace("external");
    writeFile(ws, "go.mod", "module example.com/app\n\ngo 1.21\n");
    writeFile(ws, "poll/ext.go", 'package poll\n\nimport ext "github.com/external/thirdparty"\n\nfunc ExtStep() int {\n\treturn ext.ExternalMs\n}\n');
    const chain = await ask(ws, "What default value does ExtStep return?");
    const certifying = chain.hops.find((h) => decisionOf(h.response).kind === "act.answer" || decisionOf(h.response).kind === "act.edit");
    if (certifying) {
      const gaps = gapRefs(certifying.response);
      expect(gaps.length, `expected a disclosed gap (gaps: ${JSON.stringify(gaps)})`).toBeGreaterThan(0);
      expect(
        gaps.some((g) => g.includes("github.com/external/thirdparty")),
        `expected the gap to name the external import path (gaps: ${JSON.stringify(gaps)})`,
      ).toBe(true);
    }
  }, 120_000);
});

// ===========================================================================
// Recall controls: TS/Python qualified-alias reads through the SAME
// `resolveQualifiedReferencesIn` loop this fix's Go branch lives in --
// unaffected by this fix's Go-only changes.
// ===========================================================================
describe("Recall control: TS/Python qualified-alias reads stay resolved", () => {
  it("TS: a namespace-import (`import * as ns`) qualified read still resolves", async () => {
    const ws = makeWorkspace("ts-control");
    writeFile(ws, "config/limits.ts", "export const TsAliasMs = 84420;\n");
    writeFile(ws, "poll/step.ts", "import * as ns from '../config/limits.js';\nexport function tsStep(): number { return ns.TsAliasMs; }\n");
    const chain = await ask(ws, "What default value does tsStep return?");
    assertValueServedByClosure(chain, "84420");
    assertNeverFalseReady(chain, "84420");
  }, 120_000);

  it("Python: a module-alias (`import pkg as alias`) qualified read still resolves", async () => {
    const ws = makeWorkspace("py-control");
    writeFile(ws, "pkgconf/limits.py", "PyAliasMs = 55290\n");
    writeFile(ws, "poll/step.py", "import pkgconf.limits as pl\n\ndef py_step():\n    return pl.PyAliasMs\n");
    const chain = await ask(ws, "What default value does py_step return?");
    assertValueServedByClosure(chain, "55290");
    assertNeverFalseReady(chain, "55290");
  }, 120_000);
});
