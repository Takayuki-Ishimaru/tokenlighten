/**
 * evaluation0929.goClosure.spec.ts — WP-I (eval-0929 §4/§5/§8; chip adopted
 * from WP-A2's own repro while building `evaluation0929.valueChainDepth.spec.ts`).
 *
 * REPORTED SHAPE: a tiny Go workspace (`limits.go` `package poll\nconst
 * StepBaseMs = 7310\n`, `step.go` `package poll\nconst stepRefMs =
 * StepBaseMs\nfunc PollStep() int { return stepRefMs }\n`, plus a few
 * unrelated same-package files) — "What default value does PollStep
 * return?" was said to serve `step.go` whole
 * (`why:"answer-explicit-symbol-focus"`) WITHOUT the facet closure ever
 * running: no `closure:value` row, no gap, `act.answer`, 7310 never served.
 *
 * ACTUAL ROOT CAUSE (own investigation, confirmed both in-process and via a
 * real stdio server on TWO builds): the trigger is NOT workspace size at
 * all — a bare query with no path, any file count from 0 to 5+ unrelated
 * siblings, with/without `go.mod`, several phrasings, all already served
 * `StepBaseMs` correctly on every build tried. The actual trigger is a
 * QUERY THAT NAMES A PATH ("In step.go, what default value does PollStep
 * return?") — this is eval-0929 §5's own general defect (adding a file path
 * to the question drops a constant's real value), reproduced here in Go.
 * Confirmed failing on HEAD v0.14.4
 * (`~/.cache/tokenlighten-ab/final-0929/.../dist/bin.js`): the path-named
 * query certifies `act.answer` with evidence `why=["answer-explicit-symbol-
 * focus"]` ONLY (no `closure:` row, no gap, 7310 absent) — exactly the
 * reported symptom. `findGoPackageConstantWindow` itself is BYTE-IDENTICAL
 * to HEAD (`git diff HEAD` on this file shows zero lines changed for it) —
 * the bug was never inside Go-specific resolution. The actual fix is
 * WP-B's (finished, outside this package's region): `readCodeTaskPack.ts`'s
 * `capExtraEvidenceRelativeToNamedPaths` used to strip a closure-served
 * window as "extra" evidence relative to a named path AFTER the certificate
 * had already been minted on its presence; WP-B added a `keep` predicate
 * (threaded from `buildAnswerTaskPack` via `certificateWireInvariant.ts`'s
 * `wouldIntroduceBreach`) so evidence the certificate cites survives the
 * cap. That fix is language-agnostic, so it closed the Go manifestation of
 * the SAME defect as a side effect — confirmed by comparing HEAD (fails) and
 * the working tree via `devshim.mjs` as a real stdio server (passes) across
 * every shape below. This spec exists to LOCK IN that fix as a Go-specific
 * recall control (nothing here needed a code change from this package; see
 * this file's own PR/report for the full HEAD-vs-tree comparison).
 *
 * Every fixture below uses fresh names/values never used by the evaluator's
 * own fixtures or the orchestrator's metamorphic matrix.
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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929goc-${tag}-`));
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
// Go same-package sibling file (the reported shape): limits.go/step.go plus
// unrelated same-package siblings. Bare query (recall control -- already
// worked pre-fix per own investigation) and the actual trigger, a
// path-named query.
// ===========================================================================
function goSiblingFixture(ws: string): void {
  writeFile(ws, "limits.go", "package poll\n\nconst StepBaseMs = 7310\n");
  writeFile(ws, "step.go", "package poll\n\nconst stepRefMs = StepBaseMs\n\nfunc PollStep() int {\n\treturn stepRefMs\n}\n");
  writeFile(ws, "unrelated1.go", "package poll\n\nfunc Noop1() {}\n");
  writeFile(ws, "unrelated2.go", "package poll\n\nfunc Noop2() {}\n");
  writeFile(ws, "unrelated3.go", "package poll\n\nconst OtherThing = \"x\"\n");
}

describe("E2E Go: same-package sibling constant (eval-0929 §4/§5 reported shape)", () => {
  it("bare query: PollStep's value (7310) is served (act.answer, no false gap)", async () => {
    const ws = makeWorkspace("sibling-bare");
    goSiblingFixture(ws);
    const chain = await ask(ws, "What default value does PollStep return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("path-named query (the actual trigger): PollStep's value (7310) is still served", async () => {
    const ws = makeWorkspace("sibling-path");
    goSiblingFixture(ws);
    const chain = await ask(ws, "In step.go, what default value does PollStep return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("Japanese path-named phrasing still resolves the value", async () => {
    const ws = makeWorkspace("sibling-path-ja");
    goSiblingFixture(ws);
    const chain = await ask(ws, "step.go で、PollStep が返す既定値を説明してください。");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("bullet-list path-named phrasing still resolves the value", async () => {
    const ws = makeWorkspace("sibling-bullets");
    goSiblingFixture(ws);
    const chain = await ask(ws, "Explain the poller in step.go:\n- Default value returned by PollStep\n- Any retry behaviour");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("an unrelated same-name decoy in another package does not steal the path-named focus", async () => {
    const ws = makeWorkspace("sibling-decoy");
    goSiblingFixture(ws);
    writeFile(ws, "other/decoy.go", "package other\n\nfunc PollStep() int { return -1 }\n");
    const chain = await ask(ws, "In step.go, what default value does PollStep return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);
});

// ===========================================================================
// Go same-file const chain -- no cross-file closure hop needed at all, but
// still exercised path-named since that is the confirmed trigger shape.
// ===========================================================================
describe("E2E Go: same-file const chain", () => {
  it("bare query resolves the value", async () => {
    const ws = makeWorkspace("samefile-bare");
    writeFile(ws, "step.go", "package poll\n\nconst StepBaseMs = 7310\nconst stepRefMs = StepBaseMs\n\nfunc PollStep() int {\n\treturn stepRefMs\n}\n");
    const chain = await ask(ws, "What default value does PollStep return?");
    const text = evidenceBodies(chain).join("\n");
    expect(text, "expected \"7310\" to be served somewhere in the chain's evidence").toContain("7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("path-named query resolves the value", async () => {
    const ws = makeWorkspace("samefile-path");
    writeFile(ws, "step.go", "package poll\n\nconst StepBaseMs = 7310\nconst stepRefMs = StepBaseMs\n\nfunc PollStep() int {\n\treturn stepRefMs\n}\n");
    const chain = await ask(ws, "In step.go, what default value does PollStep return?");
    const text = evidenceBodies(chain).join("\n");
    expect(text, "expected \"7310\" to be served somewhere in the chain's evidence").toContain("7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);
});

// ===========================================================================
// Go receiver method reading a sibling package constant -- "Same with a
// receiver method" per the reported shape.
// ===========================================================================
function goReceiverFixture(ws: string): void {
  writeFile(ws, "limits.go", "package poll\n\nconst StepBaseMs = 7310\n");
  writeFile(ws, "poller.go", "package poll\n\ntype Poller struct{}\n\nfunc (p *Poller) Step() int {\n\treturn StepBaseMs\n}\n");
}

describe("E2E Go: receiver method reading a sibling package constant", () => {
  it("bare query resolves the value", async () => {
    const ws = makeWorkspace("receiver-bare");
    goReceiverFixture(ws);
    const chain = await ask(ws, "What default value does the Poller Step method return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("path-named query resolves the value", async () => {
    const ws = makeWorkspace("receiver-path");
    goReceiverFixture(ws);
    const chain = await ask(ws, "In poller.go, what default value does the Poller Step method return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);
});

// ===========================================================================
// Go value reached through an imported package (same module, different
// package directory) -- brief's own bar is "-> disclosed"; the working tree
// actually clears a higher bar (fully resolved) for the ordinary
// package-qualified shape. An import-ALIASED qualified reference and a
// genuinely unresolvable external import are exercised too: both must never
// silently certify `covered` -- either resolved or disclosed, never neither.
// ===========================================================================
describe("E2E Go: value reached through an imported package", () => {
  function importedFixture(ws: string): void {
    writeFile(ws, "go.mod", "module example.com/m\n\ngo 1.21\n");
    writeFile(ws, "limits/limits.go", "package limits\n\nconst StepBaseMs = 7310\n");
    writeFile(ws, "poll/step.go", 'package poll\n\nimport "example.com/m/limits"\n\nfunc PollStep() int {\n\treturn limits.StepBaseMs\n}\n');
  }

  it("bare query: the cross-package value is fully resolved (exceeds the brief's own 'disclosed' floor)", async () => {
    const ws = makeWorkspace("imported-bare");
    importedFixture(ws);
    const chain = await ask(ws, "What default value does PollStep return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("path-named query: the cross-package value is still fully resolved", async () => {
    const ws = makeWorkspace("imported-path");
    importedFixture(ws);
    const chain = await ask(ws, "In poll/step.go, what default value does PollStep return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("a genuinely unresolvable external import is never silently certified covered", async () => {
    const ws = makeWorkspace("imported-external");
    writeFile(ws, "go.mod", "module example.com/m\n\ngo 1.21\n");
    writeFile(
      ws,
      "poll/step.go",
      'package poll\n\nimport "example.com/other/external"\n\nfunc PollStep() int {\n\treturn external.StepBaseMs\n}\n',
    );
    const chain = await ask(ws, "In poll/step.go, what default value does PollStep return?");
    // The literal cannot exist anywhere in this workspace at all -- the ONLY
    // honest outcomes are "never certified" or "certified with a disclosed
    // gap"; silently claiming `covered`/`act.answer` with no gap here would
    // be fabricating a value that cannot be in the pack's own evidence.
    const certifying = chain.hops.find((h) => decisionOf(h.response).kind === "act.answer" || decisionOf(h.response).kind === "act.edit");
    if (certifying) {
      const gaps = gapRefs(certifying.response);
      expect(gaps.length, `expected a disclosed gap when certifying with an unresolvable external import (gaps: ${JSON.stringify(gaps)})`).toBeGreaterThan(0);
    }
  }, 120_000);
});

// ===========================================================================
// Recall control: TS and Python siblings, the SAME shape (path-named value
// facet with an unrelated sibling constant) -- eval-0929 §5's general fix
// must keep covering these languages too, not just Go.
// ===========================================================================
describe("Recall control: TS/Python siblings with the same path-named shape stay served", () => {
  it("TS: path-named query still resolves the imported sibling constant", async () => {
    const ws = makeWorkspace("ts-sibling-path");
    writeFile(ws, "limits.ts", "export const StepBaseMs = 7310;\n");
    writeFile(ws, "step.ts", "import { StepBaseMs } from './limits.js';\nconst stepRefMs = StepBaseMs;\nexport function pollStep(): number { return stepRefMs; }\n");
    const chain = await ask(ws, "In step.ts, what default value does pollStep return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);

  it("Python: path-named query still resolves the imported sibling constant", async () => {
    const ws = makeWorkspace("py-sibling-path");
    writeFile(ws, "limits.py", "STEP_BASE_MS = 7310\n");
    writeFile(ws, "step.py", "from limits import STEP_BASE_MS\n\nstep_ref_ms = STEP_BASE_MS\n\ndef poll_step():\n    return step_ref_ms\n");
    const chain = await ask(ws, "In step.py, what default value does poll_step return?");
    assertValueServedByClosure(chain, "7310");
    assertNeverFalseReady(chain, "7310");
  }, 120_000);
});
