/**
 * evaluation0929.valueChainDepth.spec.ts — WP-A2 (eval-0929 §4, §8; WP-A's
 * own explicitly DEFERRED item (c)): `chaseConstant`'s
 * `MAX_CONSTANT_INITIALIZER_DEPTH` (= 2) stops scanning a resolved window's
 * OWN text for further constant-like references once that cap is hit --
 * correct when the window ALREADY holds the value (a literal), but silently
 * wrong when the window is a PURE REFERENCE (nothing but a name, a qualified
 * name, or an object/array whose members are all names --
 * `isPureReferenceInitializer`, evidenceClosure.ts): nothing was actually
 * served there, yet the closure certified the facet `covered` all the same
 * (own confirmed repro on the working tree BEFORE this fix, and on HEAD
 * v0.14.4: `focal -> CONFIG (object reading a name) -> name -> alias -> name
 * -> literal` -- the literal never reached the client, no gap disclosed).
 *
 * This fix lets a pure-reference hop keep being chased past the ordinary
 * cap under its own separate, still-bounded budget
 * (MAX_PURE_REFERENCE_CHASE_DEPTH = 8, and a files-visited cap mirroring
 * MAX_REEXPORT_FILES_TOTAL) instead of consuming the ordinary value-depth
 * budget, and discloses (never silently drops) whatever name a chain still
 * cannot reach once THAT budget, too, runs out -- including a cyclic
 * reference (`A = B; B = A;`) that never bottoms out in a value at all.
 *
 * Every fixture below uses FRESH numeric literals and names never used by
 * the evaluator's own fixtures (7231/BASE_TIMEOUT/TRANSIENT_CODES/
 * shouldRetry/getTimeout/CLIENT_DEFAULTS), the orchestrator's metamorphic
 * matrix (8641/419/432/598), or WP-A's own aliasValueChain fixtures
 * (9173/RAW_LIMIT_MS/CLIENT_POLICY/8412/RAW_LIMIT/5290/rawLimit/7355/
 * RAW_LIMIT) -- a fix that only special-cases those exact tokens still fails
 * here.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { isPureReferenceInitializer } from "../features/task-pack/evidenceClosure.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929a2-${tag}-`));
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

function evidenceBodies(chain: ChainResult): string[] {
  const out: string[] = [];
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) {
      if (typeof e?.body === "string") out.push(e.body);
    }
  }
  return out;
}

function allGapsUntilCertified(chain: ChainResult): string[] {
  const out: string[] = [];
  for (const hop of chain.hops) {
    out.push(...gapRefs(hop.response));
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") break;
  }
  return out;
}

/** The value MUST be served somewhere in the chain's evidence (every "ends in a literal" fixture below IS resolvable within the new bound). */
function assertValueServed(chain: ChainResult, marker: string): void {
  const text = evidenceBodies(chain).join("\n");
  expect(text, `expected "${marker}" to be served somewhere in the chain's evidence`).toContain(marker);
}

/** P3 floor: never `act.answer`/`act.edit` with `marker` missing from evidence AND no undetermined gap disclosing it anywhere up to that certification. */
function assertNeverFalseReady(chain: ChainResult, marker: string): void {
  const text = evidenceBodies(chain).join("\n");
  if (text.includes(marker)) return;
  const gaps = allGapsUntilCertified(chain);
  const certified = chain.hops.some((h) => decisionOf(h.response).kind === "act.answer" || decisionOf(h.response).kind === "act.edit");
  if (!certified) return;
  expect(
    gaps.some((g) => g.includes("request-item-undetermined")),
    `certified with "${marker}" missing and no undetermined gap disclosed (gaps: ${JSON.stringify(gaps)})`,
  ).toBe(true);
}

/** Exceeded-bound / cyclic floor: the chain MUST terminate (no hop-cap exhaustion) and its first certification (if any) must disclose at least one of `names` as undetermined -- never silently `covered`. */
function assertUndeterminedNaming(chain: ChainResult, names: readonly string[]): void {
  const certifying = chain.hops.find((h) => decisionOf(h.response).kind === "act.answer" || decisionOf(h.response).kind === "act.edit");
  expect(certifying, "expected the chain to reach a certified act.answer/act.edit within the hop cap").toBeDefined();
  const gaps = gapRefs(certifying!.response);
  expect(
    gaps.some((g) => g.includes("request-item-undetermined") && names.some((n) => g.includes(n))),
    `expected a gap naming one of ${JSON.stringify(names)} as undetermined (gaps: ${JSON.stringify(gaps)})`,
  ).toBe(true);
}

// ===========================================================================
// Unit: isPureReferenceInitializer (evidenceClosure.ts) -- the classifier
// `chaseConstant` uses to tell "nothing served yet" from "already served".
// ===========================================================================
describe("unit: isPureReferenceInitializer (WP-A2, eval-0929 §4/§8)", () => {
  it("a bare name is a pure reference", () => {
    expect(isPureReferenceInitializer(["export const A_MS = OTHER_NAME_MS;"], false)).toBe(true);
  });
  it("a dotted qualified name is a pure reference", () => {
    expect(isPureReferenceInitializer(["export const A_MS = Config.Base.timeout;"], false)).toBe(true);
  });
  it("a `::`-qualified name is a pure reference", () => {
    // NOTE (chip filed separately): a type annotation with a digit suffix
    // (Rust `u64`/`i32`/…) trips the SHARED `lineHasLiteralText` heuristic
    // (evidenceClosure.ts) via a single-character lookbehind that does not
    // see the whole identifier token -- deliberately avoided here rather
    // than fixed in this change (see this file's own report / chips).
    expect(isPureReferenceInitializer(["pub const A_MS = crate::limits::RAW;"], false)).toBe(true);
  });
  it("an object literal whose only member is a name is a pure reference", () => {
    expect(isPureReferenceInitializer(["const CFG = { t: OTHER_NAME_MS };"], false)).toBe(true);
  });
  it("an array literal of only names is a pure reference", () => {
    expect(isPureReferenceInitializer(["const POOL = [FIRST_MS, SECOND_MS];"], false)).toBe(true);
  });
  it("a nested object whose innermost members are all names is a pure reference", () => {
    expect(isPureReferenceInitializer(["const CFG = { inner: { t: OTHER_NAME_MS } };"], false)).toBe(true);
  });
  it("a bare literal is NEVER a pure reference (already holds the value)", () => {
    expect(isPureReferenceInitializer(["export const A_MS = 4471;"], false)).toBe(false);
  });
  it("an object with even ONE literal member is NEVER a pure reference (some value already reached this window)", () => {
    expect(isPureReferenceInitializer(["const CFG = { t: OTHER_NAME_MS, n: 4 };"], false)).toBe(false);
  });
  it("a call/construction is NEVER a pure reference (constructionOnlyInitializer's own shape, mutually exclusive)", () => {
    expect(isPureReferenceInitializer(["const CFG = createSettings();"], false)).toBe(false);
    expect(isPureReferenceInitializer(["const CFG = new Settings();"], false)).toBe(false);
  });
  it("a string literal is NEVER a pure reference", () => {
    expect(isPureReferenceInitializer(['export const NAME_MS = "OTHER_NAME_MS";'], false)).toBe(false);
  });
  it("Python bare-name assignment is a pure reference", () => {
    expect(isPureReferenceInitializer(["STEP_ALIAS = RAW_STEP"], true)).toBe(true);
  });
});

// ===========================================================================
// E2E TS/JS: focal -> CONFIG (object reading a name) -> name -> name -> name
// -> literal, 5 chaseConstant-level hops through ONE import plus same-file
// bindings -- exactly the eval §4 shape, one hop further than WP-A's own
// fixtures reach. MAX_CONSTANT_INITIALIZER_DEPTH (= 2) alone would have
// stopped scanning at hop 2's own window, before RAW_STEP_MS (the literal)
// was ever even looked up -- own confirmed repro on the pre-fix tree.
// ===========================================================================
function tsChainFixture(ws: string): void {
  writeFile(ws, "src/rawStep.ts", "export const RAW_STEP_MS = 6613;\n");
  writeFile(ws, "src/stepAlias.ts", "import { RAW_STEP_MS } from './rawStep.js';\nexport const STEP_ALIAS_MS = RAW_STEP_MS;\n");
  writeFile(ws, "src/stepBase.ts", "import { STEP_ALIAS_MS } from './stepAlias.js';\nexport const STEP_BASE_MS = STEP_ALIAS_MS;\n");
  writeFile(
    ws,
    "src/client.ts",
    "import { STEP_BASE_MS } from './stepBase.js';\nconst stepRefMs = STEP_BASE_MS;\nconst STEP_CONFIG = { intervalMs: stepRefMs };\nexport function pollStep(): number { return STEP_CONFIG.intervalMs; }\n",
  );
}

describe("E2E TS/JS: a 5-hop pure-reference chain ends in a literal within the new bound", () => {
  it("pollStep's interval (6613) is served (act.answer, no false gap)", async () => {
    const ws = makeWorkspace("ts-chain");
    tsChainFixture(ws);
    const chain = await ask(ws, "What interval value does pollStep return?");
    assertValueServed(chain, "6613");
    assertNeverFalseReady(chain, "6613");
  }, 120_000);

  it("path-named variant still resolves the whole chain", async () => {
    const ws = makeWorkspace("ts-chain-path");
    tsChainFixture(ws);
    const chain = await ask(ws, "In src/client.ts, what interval value does pollStep return?");
    assertValueServed(chain, "6613");
    assertNeverFalseReady(chain, "6613");
  }, 120_000);

  it("Japanese phrasing still resolves the whole chain", async () => {
    const ws = makeWorkspace("ts-chain-ja");
    tsChainFixture(ws);
    const chain = await ask(ws, "pollStep が返す間隔の既定値を説明してください。");
    assertNeverFalseReady(chain, "6613");
  }, 120_000);

  it("recall control: a 2-hop chain well within the ORIGINAL cap is unaffected", async () => {
    const ws = makeWorkspace("ts-chain-short");
    writeFile(ws, "src/rawStep.ts", "export const RAW_STEP_MS = 2984;\n");
    writeFile(
      ws,
      "src/client.ts",
      "import { RAW_STEP_MS } from './rawStep.js';\nconst STEP_CONFIG = { intervalMs: RAW_STEP_MS };\nexport function pollStep(): number { return STEP_CONFIG.intervalMs; }\n",
    );
    const chain = await ask(ws, "What interval value does pollStep return?");
    assertValueServed(chain, "2984");
  }, 120_000);
});

// ===========================================================================
// E2E Python: the same shape (`from m import NAME`, a dict literal reading a
// same-file local that is itself a pure reference) -- 5 hops.
// ===========================================================================
function pyChainFixture(ws: string): void {
  writeFile(ws, "rawstep.py", "RAW_STEP = 8329\n");
  writeFile(ws, "stepalias.py", "from rawstep import RAW_STEP\n\nSTEP_ALIAS = RAW_STEP\n");
  writeFile(ws, "stepbase.py", "from stepalias import STEP_ALIAS\n\nSTEP_BASE = STEP_ALIAS\n");
  writeFile(
    ws,
    "client.py",
    "from stepbase import STEP_BASE\n\n_STEP_REF = STEP_BASE\nSTEP_CONFIG = {\"interval_ms\": _STEP_REF}\n\n\ndef poll_step():\n    return STEP_CONFIG[\"interval_ms\"]\n",
  );
}

describe("E2E Python: a 5-hop pure-reference chain ends in a literal within the new bound", () => {
  it("poll_step's interval (8329) is served (act.answer, no false gap)", async () => {
    const ws = makeWorkspace("py-chain");
    pyChainFixture(ws);
    const chain = await ask(ws, "What interval value does poll_step return?");
    assertValueServed(chain, "8329");
    assertNeverFalseReady(chain, "8329");
  }, 120_000);

  it("bullet-list phrasing still resolves the whole chain", async () => {
    const ws = makeWorkspace("py-chain-bullets");
    pyChainFixture(ws);
    const chain = await ask(ws, "Explain the poller:\n- Interval value returned by poll_step\n- Any retry behaviour");
    assertNeverFalseReady(chain, "8329");
  }, 120_000);
});

// ===========================================================================
// E2E Kotlin: same-package sibling `val`s (no per-name import at all,
// mirroring WP-A's own confirmed-working `effectiveLimit` shape) -- one
// same-file hop plus three cross-file (same package, different file)
// pure-reference hops, 4 hops.
// ===========================================================================
const KT_CHAIN_SETTINGS = 'rootProject.name = "app"\n';

describe("E2E Kotlin: a 4-hop pure-reference chain (package siblings) ends in a literal within the new bound", () => {
  it("Service.pollStep's value (4557) is served (act.answer, no false gap)", async () => {
    const ws = makeWorkspace("kt-chain");
    writeFile(ws, "settings.gradle.kts", KT_CHAIN_SETTINGS);
    writeFile(ws, "src/main/kotlin/app/limits.kt", "package app\n\nval rawStepMs = 4557\n");
    writeFile(ws, "src/main/kotlin/app/tier1.kt", "package app\n\nval tier1Ms = rawStepMs\n");
    writeFile(ws, "src/main/kotlin/app/tier2.kt", "package app\n\nval tier2Ms = tier1Ms\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Service.kt",
      "package app\n\nval stepRefMs = tier2Ms\n\nclass Service {\n    fun pollStep(): Int {\n        return stepRefMs\n    }\n}\n",
    );
    const chain = await ask(ws, "What value does Service.pollStep return?");
    assertValueServed(chain, "4557");
    assertNeverFalseReady(chain, "4557");
  }, 120_000);
});

// ===========================================================================
// Requirement 2 -- a chain that EXCEEDS the new bound: disclosed, never
// silently `covered`. 11 same-file pure-reference hops (well past
// MAX_PURE_REFERENCE_CHASE_DEPTH = 8); the literal at the very end (9188) is
// never served, and the chain must terminate (no hop-cap exhaustion) with an
// honest disclosure instead.
// ===========================================================================
describe("E2E TS/JS: a pure-reference chain that exceeds the new bound is disclosed, never silently covered", () => {
  it("the literal at hop 10 (9188) is never served; the chain discloses the name it could not reach instead", async () => {
    const ws = makeWorkspace("ts-exceeds");
    writeFile(
      ws,
      "src/chain.ts",
      [
        "export const CHAIN_L10_MS = 9188;",
        "export const CHAIN_L09_MS = CHAIN_L10_MS;",
        "export const CHAIN_L08_MS = CHAIN_L09_MS;",
        "export const CHAIN_L07_MS = CHAIN_L08_MS;",
        "export const CHAIN_L06_MS = CHAIN_L07_MS;",
        "export const CHAIN_L05_MS = CHAIN_L06_MS;",
        "export const CHAIN_L04_MS = CHAIN_L05_MS;",
        "export const CHAIN_L03_MS = CHAIN_L04_MS;",
        "export const CHAIN_L02_MS = CHAIN_L03_MS;",
        "export const CHAIN_L01_MS = CHAIN_L02_MS;",
        "export const CHAIN_L00_MS = CHAIN_L01_MS;",
        "",
      ].join("\n"),
    );
    writeFile(ws, "src/client.ts", "import { CHAIN_L00_MS } from './chain.js';\nexport function chainHead(): number { return CHAIN_L00_MS; }\n");
    const chain = await ask(ws, "What value does chainHead return?", { hopCap: 24 });
    const text = evidenceBodies(chain).join("\n");
    expect(text, "the literal 9188 sits past the bound and must never be served as though it were").not.toContain("9188");
    assertNeverFalseReady(chain, "9188");
    assertUndeterminedNaming(chain, ["CHAIN_L09_MS", "CHAIN_L08_MS"]);
  }, 120_000);
});

// ===========================================================================
// Requirement 2 -- a cyclic reference (`A = B; B = A;`): the ordinary
// same-closure dedup (`visitedConstantNames`) alone would report this
// "already resolved" the second time either name is reached, even though
// NEITHER ever bottoms out in a value. Must terminate (no infinite
// recursion) and disclose, never silently certify `covered`.
// ===========================================================================
describe("E2E TS/JS: a cyclic pure reference terminates and is disclosed, never silently covered", () => {
  it("CHAIN_CYC_A_MS <-> CHAIN_CYC_B_MS never bottoms out; the chain discloses one of them as undetermined", async () => {
    const ws = makeWorkspace("ts-cyclic");
    writeFile(
      ws,
      "src/cyclic.ts",
      "export const CHAIN_CYC_A_MS = CHAIN_CYC_B_MS;\nexport const CHAIN_CYC_B_MS = CHAIN_CYC_A_MS;\n",
    );
    writeFile(ws, "src/client.ts", "import { CHAIN_CYC_A_MS } from './cyclic.js';\nexport function cycHead(): number { return CHAIN_CYC_A_MS; }\n");
    const chain = await ask(ws, "What value does cycHead return?", { hopCap: 24 });
    assertUndeterminedNaming(chain, ["CHAIN_CYC_A_MS", "CHAIN_CYC_B_MS"]);
  }, 120_000);
});
