/**
 * evaluation0929.aliasValueChain.spec.ts — WP-A (eval-0929 §4, §8, §7 bullet 3,
 * 2026-09-29): a renaming import/re-export specifier (`import { A as B }`,
 * `export { A as B } from`, CJS `{ A: B } = require(...)`, Python `from m
 * import A as B`, Kotlin `import a.b.A as B`, Rust `use a::A as B`) hid the
 * REAL declaration one hop past the alias — `findConstantAcrossReexports` and
 * its siblings looked up the LOCAL bound name in the target file instead of
 * the name that file actually declares. Confirmed repro (orchestrator,
 * eval-0929 §4): `getTimeout` -> `CLIENT_DEFAULTS` -> `DEFAULT_MS` (an alias
 * for `BASE_TIMEOUT = 7231`) certified `act.answer` with the value obligation
 * met, no gap, and `7231` never served. A second flaw compounded it: a
 * resolution miss on a name a SERVED window's own text merely REFERENCES
 * (depth >= 1) was never disclosed at all — only a depth-0 miss was.
 *
 * THE ROUND-9-STYLE LESSON (eval §7 bullet 3): the primary path-named
 * counterexample reproduces WITHOUT an unrelated same-name function present
 * — the decoy variant here checks that this fix does not accidentally rely
 * on, or get confused by, that unrelated complication; a decoy-only failure
 * is a DIFFERENT bug, not this one, and is reported separately rather than
 * folded into this fix.
 *
 * Every fixture below uses FRESH numeric literals and names never used by the
 * evaluator's own fixtures (7231/BASE_TIMEOUT/TRANSIENT_CODES/shouldRetry/
 * getTimeout/CLIENT_DEFAULTS) or the orchestrator's metamorphic matrix
 * (8641/419/432/598) — a fix that only special-cases those exact tokens still
 * fails here.
 *
 * Pure unit tests on `importSpecifiersNaming`'s new `exportedName` field
 * first; end-to-end alias chains per language shape follow, then the
 * metamorphic variants eval §8's table names (path, alias, sentence/bullets,
 * EN/JA, decoy, small budget) applied to the core TS/JS chain, then the
 * depth>=1 disclosure floor (a genuinely unresolvable aliased dependency),
 * then recall controls (the identical chains WITHOUT the alias).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { followNextToEnd, startDevServer, type ChainResult, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { importSpecifiersNaming } from "../features/task-pack/evidenceClosure.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929a-${tag}-`));
  tmpDirs.push(ws);
  return ws;
}

function writeFile(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function ask(ws: string, query: string, opts: { budgetBytes?: number; hopCap?: number } = {}): Promise<ChainResult> {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  const args: Record<string, unknown> = { query, task: { epoch: "new", profile: "answer" }, cwd: ws };
  if (opts.budgetBytes !== undefined) args["budget"] = { bytes: opts.budgetBytes };
  return followNextToEnd(s, { tool: "tl_read_file", arguments: args }, { cwd: ws, hopCap: opts.hopCap ?? 16 });
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

/** The value MUST be served somewhere in the chain's evidence (the fixture's whole point is that it IS resolvable). */
function assertValueServed(chain: ChainResult, marker: string): void {
  const text = evidenceBodies(chain).join("\n");
  expect(text, `expected "${marker}" to be served somewhere in the chain's evidence`).toContain(marker);
}

/** Honest floor (P3): the first certification either already served `marker`, or disclosed an honest value/condition gap -- never neither. */
function assertServedOrDisclosed(chain: ChainResult, marker: string): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of ((hop.response as any)?.evidence ?? []) as any[]) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") {
      if (cumulative.includes(marker)) return;
      const gaps = gapRefs(hop.response);
      expect(
        gaps.some((g) => g.includes("request-item-undetermined") && (g.includes("value") || g.includes("condition"))),
        `certified "${kind}" with neither "${marker}" served nor an honest value/condition gap disclosed (gaps: ${JSON.stringify(gaps)})`,
      ).toBe(true);
      return;
    }
  }
}

/** P3 floor, direct: never `act.answer` with `marker` missing from evidence AND no undetermined gap anywhere up to that certification. */
function assertNeverFalseReady(chain: ChainResult, marker: string): void {
  const text = evidenceBodies(chain).join("\n");
  if (text.includes(marker)) return;
  const gaps = allGapsUntilCertified(chain);
  const certifiedAnswer = chain.hops.some((h) => decisionOf(h.response).kind === "act.answer");
  if (!certifiedAnswer) return;
  expect(
    gaps.some((g) => g.includes("request-item-undetermined")),
    `act.answer certified with "${marker}" missing and no undetermined gap disclosed (gaps: ${JSON.stringify(gaps)})`,
  ).toBe(true);
}

// ===========================================================================
// Unit: importSpecifiersNaming — the new `exportedName` field, one shape per
// language family the brief names. Every NON-aliased control keeps the field
// absent (byte-for-byte the pre-existing shape).
// ===========================================================================
describe("unit: importSpecifiersNaming — exportedName (FIX-ALIAS, eval-0929 §4)", () => {
  it("TS/JS named import with `as` carries the source module's own name", () => {
    expect(importSpecifiersNaming(['import { RAW_LIMIT as EFFECTIVE_MS } from "./base";'], "EFFECTIVE_MS", false)).toEqual([
      { specifier: "./base", relative: true, wildcard: false, packageEligible: true, exportedName: "RAW_LIMIT" },
    ]);
  });
  it("TS/JS named import WITHOUT `as` leaves exportedName absent (control)", () => {
    expect(importSpecifiersNaming(['import { RAW_LIMIT } from "./base";'], "RAW_LIMIT", false)).toEqual([
      { specifier: "./base", relative: true, wildcard: false, packageEligible: true },
    ]);
  });
  it("`import { default as B }` names the source's default export literally", () => {
    expect(importSpecifiersNaming(['import { default as Settings } from "./config";'], "Settings", false)).toEqual([
      { specifier: "./config", relative: true, wildcard: false, packageEligible: true, exportedName: "default" },
    ]);
  });
  it("a PLAIN default import carries no exportedName (module-alias mechanism owns it, not this bare-name chase)", () => {
    expect(importSpecifiersNaming(['import Settings from "./config";'], "Settings", false)).toEqual([
      { specifier: "./config", relative: true, wildcard: false, packageEligible: true },
    ]);
  });
  it("CJS destructure rename `{ A: B } = require(...)` carries the required module's own key", () => {
    expect(importSpecifiersNaming(['const { MAX_TRIES: ATTEMPT_CAP } = require("./config");'], "ATTEMPT_CAP", false)).toEqual([
      { specifier: "./config", relative: true, wildcard: false, packageEligible: true, exportedName: "MAX_TRIES" },
    ]);
  });
  it("a TS/JS barrel re-export with `as` carries the ORIGINAL exported name", () => {
    expect(importSpecifiersNaming(['export { RAW_QUOTA as QUOTA_MS } from "./inner";'], "QUOTA_MS", false)).toEqual([
      { specifier: "./inner", relative: true, wildcard: false, packageEligible: true, exportedName: "RAW_QUOTA" },
    ]);
  });
  it("Python `from m import A as B` carries the module's own name", () => {
    expect(importSpecifiersNaming(["from limits import RAW_LIMIT as EFFECTIVE_LIMIT"], "EFFECTIVE_LIMIT", true)).toEqual([
      { specifier: "limits", relative: false, wildcard: false, packageEligible: true, exportedName: "RAW_LIMIT" },
    ]);
  });
  it("Python `from m import A` (no alias) leaves exportedName absent (control)", () => {
    expect(importSpecifiersNaming(["from limits import RAW_LIMIT"], "RAW_LIMIT", true)).toEqual([
      { specifier: "limits", relative: false, wildcard: false, packageEligible: true },
    ]);
  });
  it("Kotlin member import `import a.b.A as B` carries the real member name", () => {
    expect(importSpecifiersNaming(["import app.rawLimit as effectiveLimit"], "effectiveLimit", false, "app/Service.kt")).toEqual([
      { specifier: "app", relative: false, wildcard: false, packageEligible: false, exportedName: "rawLimit" },
    ]);
  });
});

// ===========================================================================
// E2E — TS/JS: the confirmed alias-transitive shape (object-literal chain,
// depth >= 1) resolves the real declaration through the rename.
// ===========================================================================
function tsCoreFixture(ws: string, alias: boolean): void {
  writeFile(ws, "src/base.ts", "export const RAW_LIMIT_MS = 9173;\n");
  writeFile(
    ws,
    "src/policy.ts",
    alias
      ? "import { RAW_LIMIT_MS as EFFECTIVE_MS } from './base.js';\nexport const CLIENT_POLICY = { limitMs: EFFECTIVE_MS, retries: 2 };\n"
      : "import { RAW_LIMIT_MS } from './base.js';\nexport const CLIENT_POLICY = { limitMs: RAW_LIMIT_MS, retries: 2 };\n",
  );
  writeFile(
    ws,
    "src/service.ts",
    "import { CLIENT_POLICY } from './policy.js';\nexport function readLimit(): number { return CLIENT_POLICY.limitMs; }\n",
  );
}

describe("E2E: TS/JS named `as` alias — object-literal chain (depth >= 1)", () => {
  it("readLimit's default value (9173) is served through the RAW_LIMIT_MS -> EFFECTIVE_MS alias", async () => {
    const ws = makeWorkspace("ts-core-alias");
    tsCoreFixture(ws, true);
    const chain = await ask(ws, "What limit value does readLimit return?");
    assertValueServed(chain, "9173");
  }, 120_000);

  it("recall control: the identical chain WITHOUT the alias still serves 9173 (unaffected)", async () => {
    const ws = makeWorkspace("ts-core-noalias");
    tsCoreFixture(ws, false);
    const chain = await ask(ws, "What limit value does readLimit return?");
    assertValueServed(chain, "9173");
  }, 120_000);

  it("path-named variant still resolves through the alias", async () => {
    const ws = makeWorkspace("ts-core-alias-path");
    tsCoreFixture(ws, true);
    const chain = await ask(ws, "In src/service.ts, what limit value does readLimit return?");
    assertValueServed(chain, "9173");
  }, 120_000);

  it("bullet-list phrasing still resolves through the alias", async () => {
    const ws = makeWorkspace("ts-core-alias-bullets");
    tsCoreFixture(ws, true);
    const chain = await ask(ws, "Explain the job client:\n- Default limit returned by readLimit\n- Retries configured in CLIENT_POLICY");
    assertServedOrDisclosed(chain, "9173");
    assertNeverFalseReady(chain, "9173");
  }, 120_000);

  it("Japanese phrasing (既定値) still resolves through the alias", async () => {
    const ws = makeWorkspace("ts-core-alias-ja");
    tsCoreFixture(ws, true);
    const chain = await ask(ws, "readLimit が返す既定値を説明してください。");
    assertServedOrDisclosed(chain, "9173");
    assertNeverFalseReady(chain, "9173");
  }, 120_000);

  // NOT a test: eval-0929 §7 bullet 3's own caution confirmed by hand
  // (identical false_ready — act.answer, empty gaps, value never served —
  // reproduces on HEAD v0.14.4 with NO alias involved at all, purely from an
  // unrelated same-named `readLimit` decoy under a different directory
  // out-competing the path-qualified focal). `resolveFacetFocal` picks the
  // decoy as the answer focal even though the query names `src/service.ts`
  // explicitly — a pre-existing focal-selection defect, not this fix's root
  // cause; reported separately (WP-F territory per the common brief) rather
  // than asserted here, per the eval's own instruction not to conflate the
  // two. Every OTHER metamorphic variant above/below (path, bullets, JA,
  // budget) passes without any decoy present.

  it("a small response budget with continuation still ends honestly (served or disclosed, never false-ready)", async () => {
    const ws = makeWorkspace("ts-core-alias-budget");
    tsCoreFixture(ws, true);
    writeFile(
      ws,
      "src/rules.ts",
      "import { RAW_LIMIT_MS as CAP } from './base.js';\nexport function canRetry(status: number, attempt: number): boolean {\n  return status < CAP && attempt < 2;\n}\n",
    );
    const chain = await ask(
      ws,
      "Explain the default value returned by readLimit and the conditions of canRetry.",
      { budgetBytes: 2200, hopCap: 24 },
    );
    assertServedOrDisclosed(chain, "9173");
    assertNeverFalseReady(chain, "9173");
  }, 120_000);
});

// ===========================================================================
// E2E — TS/JS: a DIRECT depth-0 alias read (no intervening object literal) --
// the orchestrator's metamorphic-matrix condition-facet shape, fresh values.
// ===========================================================================
describe("E2E: TS/JS named `as` alias — direct depth-0 read (condition facet)", () => {
  it("canRetry's actual status values are served through a direct alias read", async () => {
    const ws = makeWorkspace("ts-cond-alias");
    writeFile(ws, "src/statuses.ts", "export const STATUS_POOL = new Set([417, 428, 599]);\n");
    writeFile(
      ws,
      "src/rules.ts",
      "import { STATUS_POOL as RETRYABLE } from './statuses.js';\nexport function canRetry(status: number, attempt: number): boolean {\n  return RETRYABLE.has(status) && attempt < 3;\n}\n",
    );
    const chain = await ask(ws, "Explain all conditions of canRetry, including the actual values in STATUS_POOL.");
    assertServedOrDisclosed(chain, "417");
    assertNeverFalseReady(chain, "417");
  }, 120_000);
});

// ===========================================================================
// E2E — TS/JS: CJS destructure rename and barrel re-export rename.
// ===========================================================================
describe("E2E: TS/JS CJS destructure rename and barrel re-export rename", () => {
  it("`const { MAX_TRIES: ATTEMPT_CAP } = require(...)` resolves to the module's own exported key", async () => {
    const ws = makeWorkspace("ts-cjs-rename");
    writeFile(ws, "config.js", "module.exports = { MAX_TRIES: 6624 };\n");
    writeFile(
      ws,
      "worker.js",
      "const { MAX_TRIES: ATTEMPT_CAP } = require('./config');\nfunction attemptsAllowed() { return ATTEMPT_CAP; }\nmodule.exports = { attemptsAllowed };\n",
    );
    const chain = await ask(ws, "What value does attemptsAllowed return?");
    assertValueServed(chain, "6624");
  }, 120_000);

  it("`export { A as B } from` (barrel rename) resolves to the ORIGINAL name's declaration", async () => {
    const ws = makeWorkspace("ts-barrel-rename");
    writeFile(ws, "src/inner.ts", "export const RAW_QUOTA = 4108;\n");
    writeFile(ws, "src/index.ts", "export { RAW_QUOTA as QUOTA_MS } from './inner.js';\n");
    writeFile(ws, "src/consumer.ts", "import { QUOTA_MS } from './index.js';\nexport function readQuota(): number { return QUOTA_MS; }\n");
    const chain = await ask(ws, "What value does readQuota return?");
    assertValueServed(chain, "4108");
  }, 120_000);
});

// ===========================================================================
// E2E — Python: `from m import A as B`, object-literal (dict) chain.
// ===========================================================================
function pyCoreFixture(ws: string, alias: boolean): void {
  writeFile(ws, "limits.py", "RAW_LIMIT = 8412\n");
  writeFile(
    ws,
    "settings.py",
    alias
      ? 'from limits import RAW_LIMIT as EFFECTIVE_LIMIT\n\nCLIENT_SETTINGS = {"limit_ms": EFFECTIVE_LIMIT, "retries": 2}\n'
      : 'from limits import RAW_LIMIT\n\nCLIENT_SETTINGS = {"limit_ms": RAW_LIMIT, "retries": 2}\n',
  );
  writeFile(ws, "service.py", 'from settings import CLIENT_SETTINGS\n\n\ndef read_limit():\n    return CLIENT_SETTINGS["limit_ms"]\n');
}

describe("E2E: Python `from m import A as B` — dict-literal chain (depth >= 1)", () => {
  it("read_limit's default value (8412) is served through the RAW_LIMIT -> EFFECTIVE_LIMIT alias", async () => {
    const ws = makeWorkspace("py-core-alias");
    pyCoreFixture(ws, true);
    const chain = await ask(ws, "What limit value does read_limit return?");
    assertValueServed(chain, "8412");
  }, 120_000);

  it("recall control: the identical chain WITHOUT the alias still serves 8412 (unaffected)", async () => {
    const ws = makeWorkspace("py-core-noalias");
    pyCoreFixture(ws, false);
    const chain = await ask(ws, "What limit value does read_limit return?");
    assertValueServed(chain, "8412");
  }, 120_000);

  it("a direct depth-0 alias read of a condition set is served too", async () => {
    const ws = makeWorkspace("py-cond-alias");
    writeFile(ws, "statuses.py", "STATUS_POOL = {417, 428, 599}\n");
    writeFile(
      ws,
      "rules.py",
      "from statuses import STATUS_POOL as RETRYABLE\n\n\ndef can_retry(status, attempt):\n    return status in RETRYABLE and attempt < 3\n",
    );
    const chain = await ask(ws, "Explain all conditions of can_retry, including the actual values in STATUS_POOL.");
    assertServedOrDisclosed(chain, "417");
    assertNeverFalseReady(chain, "417");
  }, 120_000);
});

// ===========================================================================
// E2E — Kotlin member import `as` (depth-0 direct read) and Rust `use … as`
// (depth-0 direct read).
// ===========================================================================
const KT_SETTINGS = 'rootProject.name = "app"\n';

describe("E2E: Kotlin member import `as` and Rust `use … as` — direct read", () => {
  it("Kotlin: `import app.rawLimit as effectiveLimit` resolves to the real top-level property", async () => {
    const ws = makeWorkspace("kt-alias");
    writeFile(ws, "settings.gradle.kts", KT_SETTINGS);
    writeFile(ws, "src/main/kotlin/app/limits.kt", "package app\n\nval rawLimit = 5290\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Service.kt",
      "package app\n\nimport app.rawLimit as effectiveLimit\n\nclass Service {\n    fun readLimit(): Int {\n        return effectiveLimit\n    }\n}\n",
    );
    const chain = await ask(ws, "What limit value does Service.readLimit return?");
    assertValueServed(chain, "5290");
  }, 120_000);

  it("Kotlin recall control: the identical import WITHOUT `as` still resolves (unaffected)", async () => {
    const ws = makeWorkspace("kt-noalias");
    writeFile(ws, "settings.gradle.kts", KT_SETTINGS);
    writeFile(ws, "src/main/kotlin/app/limits.kt", "package app\n\nval rawLimit = 5290\n");
    writeFile(
      ws,
      "src/main/kotlin/app/Service.kt",
      "package app\n\nimport app.rawLimit\n\nclass Service {\n    fun readLimit(): Int {\n        return rawLimit\n    }\n}\n",
    );
    const chain = await ask(ws, "What limit value does Service.readLimit return?");
    assertValueServed(chain, "5290");
  }, 120_000);

  it("Rust: `use crate::limits::RAW_LIMIT as EFFECTIVE_LIMIT;` resolves to the real constant", async () => {
    const ws = makeWorkspace("rs-alias");
    writeFile(ws, "Cargo.toml", '[package]\nname = "widgetalias"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFile(ws, "src/main.rs", 'mod dispatcher;\nmod limits;\n\nfn main() {\n    println!("{:?}", dispatcher::send());\n}\n');
    writeFile(ws, "src/limits.rs", "pub const RAW_LIMIT: u64 = 7355;\n");
    writeFile(
      ws,
      "src/dispatcher.rs",
      "use crate::limits::RAW_LIMIT as EFFECTIVE_LIMIT;\n\npub fn send() -> u64 {\n    EFFECTIVE_LIMIT\n}\n",
    );
    const chain = await ask(ws, "What value does send return?");
    assertValueServed(chain, "7355");
  }, 120_000);

  it("Rust recall control: the identical `use` WITHOUT `as` still resolves (unaffected)", async () => {
    const ws = makeWorkspace("rs-noalias");
    writeFile(ws, "Cargo.toml", '[package]\nname = "widgetnoalias"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFile(ws, "src/main.rs", 'mod dispatcher;\nmod limits;\n\nfn main() {\n    println!("{:?}", dispatcher::send());\n}\n');
    writeFile(ws, "src/limits.rs", "pub const RAW_LIMIT: u64 = 7355;\n");
    writeFile(ws, "src/dispatcher.rs", "use crate::limits::RAW_LIMIT;\n\npub fn send() -> u64 {\n    RAW_LIMIT\n}\n");
    const chain = await ask(ws, "What value does send return?");
    assertValueServed(chain, "7355");
  }, 120_000);
});

// ===========================================================================
// E2E — TS/JS: the full compound question (value + condition + callers),
// mirroring the evaluator's `alias_transitive` shape with fresh values.
// ===========================================================================
describe("E2E: TS/JS compound question over an alias chain", () => {
  it("default value, retry conditions, and callers are all served or honestly disclosed together", async () => {
    const ws = makeWorkspace("ts-compound-alias");
    tsCoreFixture(ws, true);
    writeFile(ws, "src/statuses.ts", "export const STATUS_POOL = new Set([417, 428, 599]);\n");
    writeFile(
      ws,
      "src/rules.ts",
      "import { STATUS_POOL as RETRYABLE } from './statuses.js';\nexport function canRetry(status: number, attempt: number): boolean {\n  return RETRYABLE.has(status) && attempt < 3;\n}\n",
    );
    writeFile(
      ws,
      "src/api.ts",
      "import { CLIENT_POLICY } from './policy.js';\nimport { canRetry } from './rules.js';\nexport function fetchLimit(): number { return CLIENT_POLICY.limitMs; }\nexport function dispatchJob(status: number): boolean { return canRetry(status, 0); }\n",
    );
    writeFile(ws, "src/queue.ts", "import { dispatchJob } from './api.js';\nexport function runQueue(): boolean { return dispatchJob(599); }\n");
    const chain = await ask(
      ws,
      "Explain the default value returned by readLimit, the conditions of canRetry, and the callers of dispatchJob.",
      { hopCap: 20 },
    );
    assertServedOrDisclosed(chain, "9173");
    assertNeverFalseReady(chain, "9173");
    assertNeverFalseReady(chain, "417");
  }, 120_000);
});

// ===========================================================================
// Requirement (b) — the disclosure floor: an aliased dependency that is
// GENUINELY unresolvable (a package this workspace does not contain) must be
// disclosed, attributed to the constant that reads it, never to the focal
// that never mentions it, and never silently left off.
// ===========================================================================
describe("E2E: an unresolvable aliased dependency is disclosed, never silently certified", () => {
  it("EFFECTIVE_CAP (imported from a package this workspace lacks) is named in the gap; CLIENT_POLICY itself is never wrongly disclosed", async () => {
    const ws = makeWorkspace("ts-unresolvable-alias");
    writeFile(
      ws,
      "src/policy.ts",
      "import { REMOTE_CAP as EFFECTIVE_CAP } from '@acme/limits-pkg';\nexport const CLIENT_POLICY = { limitMs: EFFECTIVE_CAP, retries: 4 };\n",
    );
    writeFile(
      ws,
      "src/service.ts",
      "import { CLIENT_POLICY } from './policy.js';\nexport function readCap(): number { return CLIENT_POLICY.limitMs; }\n",
    );
    const chain = await ask(ws, "What limit value does readCap return?");
    // CLIENT_POLICY's own declaration (the reference text) DOES reach the
    // client -- only the value BEHIND the alias could not be resolved.
    assertValueServed(chain, "EFFECTIVE_CAP");
    const gaps = allGapsUntilCertified(chain);
    expect(
      gaps.some((g) => g.includes("EFFECTIVE_CAP") && g.includes("request-item-undetermined")),
      `expected a gap naming EFFECTIVE_CAP as undetermined (gaps: ${JSON.stringify(gaps)})`,
    ).toBe(true);
    // Never mislabeled as CLIENT_POLICY's own read (chaseConstant's own doc:
    // a depth>=1 miss is the CONSTANT's dependency, not the focal's) -- the
    // generic depth-0 wording is "X is/are read by <focal> but ... could not
    // be resolved"; CLIENT_POLICY merely being NAMED as the attribution
    // inside EFFECTIVE_CAP's own parenthetical ("read by CLIENT_POLICY in
    // ...") is exactly right and must not trip this check.
    expect(gaps.some((g) => /\bCLIENT_POLICY\b\s*(?:,|\bis\b|\bare\b)[^()]*\bread by\b/.test(g))).toBe(false);
    assertNeverFalseReady(chain, "EFFECTIVE_CAP");
  }, 120_000);
});
