/**
 * evaluation0929.sameNameFocal.spec.ts — WP-F (eval-0929 §7 bullet 3, §8 row
 * 4, `same_name_distractor`, and the adopted chip task_b5ca96e5): a
 * value/condition facet's own subject identifier — a function
 * (`shouldRetry`/`readLimit`/`canRetry`) or a constant (`RETRY_STATUSES`) —
 * used to bind to whichever same-named declaration happened to sort first
 * among the pack's already-selected candidates, never checking whether a
 * DIFFERENT file declaring the identical name was the question's real
 * subject. Two confirmed live P0s:
 *
 *  1. `same_name_distractor` (evalkit `advanced`): "Explain the default
 *     value returned by getTimeout, the conditions of shouldRetry, and the
 *     callers of sendRequest" bound the condition facet to an unrelated
 *     decoy's always-false `shouldRetry` (`src/decoy.ts`, alphabetically
 *     first) instead of the real one `src/client.ts` imports from
 *     `src/policy.ts` — certified `explicit-gap:request-item-empty:condition:
 *     shouldRetry (... reads no module constant and holds no literal)`,
 *     and 408/425/507 were never served.
 *  2. The readLimit/RAW_LIMIT_MS chip (task_b5ca96e5, found by WP-A):
 *     "In src/service.ts, what limit value does readLimit return?" bound the
 *     value facet to `src/legacy/readLimit.ts` (`return -1`) even though the
 *     question named `src/service.ts` explicitly — `act.answer`, no gaps,
 *     9173 never reached.
 *
 * FIX (readCodeTaskPack.ts `findDeclaredCallableAmong`, `resolveFacetFocal`'s
 * value/condition branch): when more than one FILE declares the exact same
 * subject identifier, bind by evidence, never by declaration order —
 * (a) an explicit file path the question itself named; (b) an import
 * relation from a file this pack already anchors on (another facet's own
 * resolved focal, an `answer-explicit-symbol-focus` surface, or the SAME
 * file declaring the identifier directly beside that anchor, no import
 * needed); (c) otherwise honestly `undetermined`, naming every candidate
 * file, never an arbitrary `covered`/`empty`. Every value/condition subject
 * goes through this — a constant exactly like a callable, since
 * `findAllDeclaredCallablesNamed` matches a parsed symbol by name only,
 * never by kind (the orchestrator's own `condvals_path` addition,
 * RETRY_STATUSES).
 *
 * Every fixture below uses names/values from the brief's own reported
 * findings (shouldRetry/getTimeout/sendRequest/TRANSIENT_CODES/408/425/507,
 * readLimit/RAW_LIMIT_MS/9173, canRetry/RETRY_STATUSES/419/432/598) — these
 * ARE the reported repros, reused deliberately, never invented decoys of
 * convenience. The fix itself keys on nothing but file/import structure.
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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0929f-${tag}-`));
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

function firstCertifiedKind(chain: ChainResult): string | undefined {
  for (const hop of chain.hops) {
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") return kind;
  }
  return undefined;
}

/** The value MUST be served somewhere in the chain's evidence. */
function assertValueServed(chain: ChainResult, marker: string): void {
  const text = evidenceBodies(chain).join("\n");
  expect(text, `expected "${marker}" to be served somewhere in the chain's evidence`).toContain(marker);
}

/** P3 floor: never `act.answer` with `marker` missing AND no undetermined gap disclosed anywhere up to that certification. */
function assertNeverFalseReady(chain: ChainResult, marker: string): void {
  const text = evidenceBodies(chain).join("\n");
  if (text.includes(marker)) return;
  const gaps = allGapsUntilCertified(chain);
  const certifiedAnswer = firstCertifiedKind(chain) === "act.answer";
  if (!certifiedAnswer) return;
  expect(
    gaps.some((g) => g.includes("request-item-undetermined")),
    `act.answer certified with "${marker}" missing and no undetermined gap disclosed (gaps: ${JSON.stringify(gaps)})`,
  ).toBe(true);
}

/** P0-2's own policy, applied to value/condition: a decoy's own empty/degenerate body must never be certified `request-item-empty` for the REAL subject. */
function assertNeverFalseEmpty(chain: ChainResult, facetSubstring: string): void {
  const gaps = allGapsUntilCertified(chain);
  expect(
    gaps.some((g) => g.includes("request-item-empty") && g.includes(facetSubstring)),
    `found a false request-item-empty for "${facetSubstring}" (gaps: ${JSON.stringify(gaps)})`,
  ).toBe(false);
}

// ===========================================================================
// TS: the exact same_name_distractor shape (value + condition + callers).
// ===========================================================================
function aliasFixture(ws: string, decoyPath?: string): void {
  writeFile(ws, "src/constants.ts", "export const BASE_TIMEOUT = 7231;\nexport const TRANSIENT_CODES = new Set([408, 425, 507]);\n");
  writeFile(ws, "src/policy.ts", "import { TRANSIENT_CODES } from './constants.js';\nexport function shouldRetry(code: number, attempt: number): boolean {\n  return TRANSIENT_CODES.has(code) && attempt < 4;\n}\n");
  writeFile(ws, "src/client.ts", "import { BASE_TIMEOUT } from './constants.js';\nimport { shouldRetry } from './policy.js';\nexport function getTimeout(): number { return BASE_TIMEOUT; }\nexport function sendRequest(code: number): boolean { return shouldRetry(code, 0); }\n");
  writeFile(ws, "src/handler.ts", "import { sendRequest } from './client.js';\nexport function handleJob(): boolean { return sendRequest(503); }\n");
  if (decoyPath) {
    writeFile(ws, decoyPath, "export const BASE_TIMEOUT = 11999;\nexport const TRANSIENT_CODES = new Set([418, 451, 599]);\nexport function shouldRetry(code: number): boolean { return false; }\n");
  }
}

const COMPOUND_QUERY = "Explain the default value returned by getTimeout, the conditions of shouldRetry, and the callers of sendRequest.";

describe("same_name_distractor: an import relation settles which same-named file the question means", () => {
  it("recall control: no decoy present — 408/425/507 served exactly as before", async () => {
    const ws = makeWorkspace("ts-nodecoy");
    aliasFixture(ws);
    const chain = await ask(ws, COMPOUND_QUERY);
    assertValueServed(chain, "408");
    assertValueServed(chain, "425");
    assertValueServed(chain, "507");
    expect(gapRefs(chain.hops[chain.hops.length - 1]!.response)).toEqual([]);
  }, 120_000);

  it("decoy sorts FIRST (alphabetically before every real file) — still resolves through client.ts's import", async () => {
    const ws = makeWorkspace("ts-decoyfirst");
    aliasFixture(ws, "src/aaa_decoy.ts");
    const chain = await ask(ws, COMPOUND_QUERY);
    assertValueServed(chain, "408");
    assertValueServed(chain, "425");
    assertValueServed(chain, "507");
    assertNeverFalseEmpty(chain, "condition:shouldRetry");
  }, 120_000);

  it("decoy sorts LAST (alphabetically after every real file) — still resolves through client.ts's import", async () => {
    const ws = makeWorkspace("ts-decoylast");
    aliasFixture(ws, "src/zzz_decoy.ts");
    const chain = await ask(ws, COMPOUND_QUERY);
    assertValueServed(chain, "408");
    assertValueServed(chain, "425");
    assertValueServed(chain, "507");
    assertNeverFalseEmpty(chain, "condition:shouldRetry");
  }, 120_000);
});

// ===========================================================================
// TS: the readLimit/RAW_LIMIT_MS chip (task_b5ca96e5) — explicit path wins,
// with its no-path control.
// ===========================================================================
function readLimitFixture(ws: string): void {
  writeFile(ws, "src/base.ts", "export const RAW_LIMIT_MS = 9173;\n");
  writeFile(ws, "src/policy.ts", "import { RAW_LIMIT_MS } from './base.js';\nexport const CLIENT_POLICY = { limitMs: RAW_LIMIT_MS, retries: 2 };\n");
  writeFile(ws, "src/service.ts", "import { CLIENT_POLICY } from './policy.js';\nexport function readLimit(): number { return CLIENT_POLICY.limitMs; }\n");
  writeFile(ws, "src/legacy/readLimit.ts", "export function readLimit(): number { return -1; }\n");
}

describe("readLimit/RAW_LIMIT_MS chip (task_b5ca96e5): the explicitly named path wins the focal binding", () => {
  it("the exact reported repro: 9173 is served, -1 never becomes the certified value", async () => {
    const ws = makeWorkspace("ts-readlimit-path");
    readLimitFixture(ws);
    const chain = await ask(ws, "In src/service.ts, what limit value does readLimit return?");
    assertValueServed(chain, "9173");
    const lastGaps = gapRefs(chain.hops[chain.hops.length - 1]!.response);
    expect(lastGaps, `expected no false-ready gaps (gaps: ${JSON.stringify(lastGaps)})`).toEqual([]);
  }, 120_000);

  it("no-path control: with no anchor to disambiguate, the ambiguity is disclosed by name — never a silent -1", async () => {
    const ws = makeWorkspace("ts-readlimit-nopath");
    readLimitFixture(ws);
    const chain = await ask(ws, "What limit value does readLimit return?");
    assertNeverFalseReady(chain, "9173");
    // Never the false-ready shape the chip reported: act.answer, no gaps, -1
    // standing in as the only served value.
    const last = chain.hops[chain.hops.length - 1]!.response;
    const bodies = evidenceBodies(chain).join("\n");
    if (decisionOf(last).kind === "act.answer" && !bodies.includes("9173")) {
      expect(gapRefs(last).some((g) => g.includes("request-item-undetermined"))).toBe(true);
    }
  }, 120_000);
});

// ===========================================================================
// TS: the orchestrator's condvals_path addition — a CONSTANT-subject value
// facet (RETRY_STATUSES), not a callable, binds through its focal's own
// import, never to a same-named decoy constant.
// ===========================================================================
function retryFixture(ws: string, decoyPath?: string): void {
  writeFile(ws, "src/limits.ts", "export const BASE_LIMIT = 8641;\nexport const RETRY_STATUSES = new Set([419, 432, 598]);\n");
  writeFile(ws, "src/rules.ts", "import { RETRY_STATUSES } from './limits.js';\nexport function canRetry(status: number, attempt: number): boolean {\n  return RETRY_STATUSES.has(status) && attempt < 3;\n}\n");
  if (decoyPath) {
    writeFile(ws, decoyPath, "export const BASE_LIMIT = 12000;\nexport const RETRY_STATUSES = new Set([401, 403]);\nexport function canRetry(status: number): boolean { return false; }\n");
  }
}

describe("condvals_path (orchestrator addition): a constant-subject value facet binds through its focal's own import", () => {
  it("RETRY_STATUSES real values (419/432/598) served; the decoy's (401/403) never certified as the value", async () => {
    const ws = makeWorkspace("ts-retry-decoy");
    retryFixture(ws, "src/aa_legacy.ts");
    const chain = await ask(ws, "In src/rules.ts, explain all conditions of canRetry, including the actual values in RETRY_STATUSES.");
    assertValueServed(chain, "419");
    assertValueServed(chain, "432");
    assertValueServed(chain, "598");
    const lastGaps = gapRefs(chain.hops[chain.hops.length - 1]!.response);
    expect(lastGaps, `expected no false-ready gaps (gaps: ${JSON.stringify(lastGaps)})`).toEqual([]);
  }, 120_000);

  it("Python twin: rules.py's own import of RETRY_STATUSES from limits.py wins over aa_legacy.py's decoy", async () => {
    const ws = makeWorkspace("py-retry-decoy");
    writeFile(ws, "limits.py", "BASE_LIMIT = 8641\nRETRY_STATUSES = {419, 432, 598}\n");
    writeFile(ws, "rules.py", "from limits import RETRY_STATUSES\n\n\ndef can_retry(status, attempt):\n    return status in RETRY_STATUSES and attempt < 3\n");
    writeFile(ws, "aa_legacy.py", "BASE_LIMIT = 12000\nRETRY_STATUSES = {401, 403}\n\n\ndef can_retry(status):\n    return False\n");
    const chain = await ask(ws, "In rules.py, explain all conditions of can_retry, including the actual values in RETRY_STATUSES.");
    assertValueServed(chain, "419");
    assertValueServed(chain, "432");
    assertValueServed(chain, "598");
    const lastGaps = gapRefs(chain.hops[chain.hops.length - 1]!.response);
    expect(lastGaps, `expected no false-ready gaps (gaps: ${JSON.stringify(lastGaps)})`).toEqual([]);
  }, 120_000);
});

// ===========================================================================
// Python: should_retry declared in the SAME file as the query's other
// subjects (no import to chase at all) — rule (b)'s same-file extension.
// ===========================================================================
describe("Python same-file decoy: no import to chase, but a prior facet's own focal already ties the pack to the real file", () => {
  it("should_retry beside get_timeout/send_request in client.py wins over decoy.py's always-false stand-in", async () => {
    const ws = makeWorkspace("py-samefile-decoy");
    writeFile(ws, "config.py", "DEFAULT_TIMEOUT = 7231\nRETRYABLE_CODES = {408, 425, 507}\n");
    writeFile(ws, "client.py", "from config import DEFAULT_TIMEOUT, RETRYABLE_CODES\n\ndef get_timeout():\n    return DEFAULT_TIMEOUT\n\ndef should_retry(code, attempt):\n    return code in RETRYABLE_CODES and attempt < 4\n\ndef send_request(code):\n    return should_retry(code, 0)\n");
    writeFile(ws, "main.py", "from client import send_request\n\ndef handle_job():\n    return send_request(503)\n");
    writeFile(ws, "decoy.py", "BASE_TIMEOUT = 11999\nRETRYABLE_CODES = {418, 451, 599}\n\n\ndef should_retry(code):\n    return False\n");
    const chain = await ask(
      ws,
      "Explain the default value returned by get_timeout, the conditions of should_retry, and the callers of send_request.",
    );
    assertValueServed(chain, "408");
    assertValueServed(chain, "425");
    assertValueServed(chain, "507");
    assertNeverFalseEmpty(chain, "condition:should_retry");
  }, 120_000);

  it("Python twin proper: should_retry in its OWN policy module, imported into client.py (mirrors the TS alias shape)", async () => {
    const ws = makeWorkspace("py-twin-proper");
    writeFile(ws, "constants.py", "BASE_TIMEOUT = 7231\nTRANSIENT_CODES = {408, 425, 507}\n");
    writeFile(ws, "policy.py", "from constants import TRANSIENT_CODES\n\n\ndef should_retry(code, attempt):\n    return code in TRANSIENT_CODES and attempt < 4\n");
    writeFile(ws, "client.py", "from constants import BASE_TIMEOUT\nfrom policy import should_retry\n\n\ndef get_timeout():\n    return BASE_TIMEOUT\n\n\ndef send_request(code):\n    return should_retry(code, 0)\n");
    writeFile(ws, "handler.py", "from client import send_request\n\n\ndef handle_job():\n    return send_request(503)\n");
    writeFile(ws, "decoy.py", "BASE_TIMEOUT = 11999\nTRANSIENT_CODES = {418, 451, 599}\n\n\ndef should_retry(code):\n    return False\n");
    const chain = await ask(
      ws,
      "Explain the default value returned by get_timeout, the conditions of should_retry, and the callers of send_request.",
    );
    assertValueServed(chain, "408");
    assertValueServed(chain, "425");
    assertValueServed(chain, "507");
    assertNeverFalseEmpty(chain, "condition:should_retry");
  }, 120_000);
});

// ===========================================================================
// Genuinely ambiguous: no path, no import, no prior-facet connection at all
// — rule (c) must disclose, naming both files, never guess.
// ===========================================================================
describe("genuinely ambiguous (no import/path context): undetermined naming both files, never an arbitrary empty/covered", () => {
  it("two unrelated files each declaring the same condition function — disclosed, not guessed", async () => {
    const ws = makeWorkspace("ts-genuinely-ambiguous");
    writeFile(ws, "src/moduleA.ts", "export function isEligible(score: number): boolean {\n  return score > 50;\n}\n");
    writeFile(ws, "src/moduleB.ts", "export function isEligible(score: number): boolean {\n  return score > 90;\n}\n");
    const chain = await ask(ws, "What are the conditions of isEligible?");
    const last = chain.hops[chain.hops.length - 1]!.response;
    if (decisionOf(last).kind === "act.answer") {
      const gaps = gapRefs(last);
      expect(
        gaps.some((g) => g.includes("request-item-undetermined") && g.includes("moduleA.ts") && g.includes("moduleB.ts")),
        `expected an undetermined gap naming both candidate files (gaps: ${JSON.stringify(gaps)})`,
      ).toBe(true);
      expect(gaps.some((g) => g.includes("request-item-empty"))).toBe(false);
    }
  }, 120_000);
});
