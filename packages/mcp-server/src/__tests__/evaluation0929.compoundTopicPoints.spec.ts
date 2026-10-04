/**
 * evaluation0929.compoundTopicPoints.spec.ts — R2-T2 (2026-09-30, final Fable
 * review of the eval-0929 wave, findings P0-5 and P1-2; orchestrator RULINGS
 * extending brief-wp-c3.md).
 *
 * P0-5: "Explain shouldRetry and the health probe." (and its JA mirror)
 * extracted to ONE request item, which the identifier's own evidence then
 * covered — the second subject was never served, never disclosed. RULING: a
 * coordinated conjunct that is its own determiner-led noun phrase ("X and the
 * NP", "X, the NP and the NP2", "the NP and the NP2", JA 「X と NP について/を」,
 * 「X と NP の…」) is its OWN topic point — located or disclosed; a head noun
 * shared across the conjunction ("the retry and backoff logic",
 * 「リトライとバックオフの処理」) keeps ONE point. A coordinated point whose
 * candidates were not served is disclosed `request-item-undetermined` (never
 * left silently open).
 *
 * P1-2: an adjective in an identifier-free topic clause was certified
 * `request-item-absent` ("intermittent", "slow"). RULING: only the noun
 * phrase's nouns are absence-eligible (unit coverage in
 * evaluation0929.descriptorModifierEligibility.spec.ts; end-to-end here).
 *
 * Katakana RULING (same package): a katakana loanword that neither the
 * workspace bridge nor the glossary can spell in English is never certified
 * absent (the workspace would spell the concept in English) — it is disclosed
 * undetermined, and rides an intermediate `discover` under the additive gap
 * code `request-item-undetermined`; a katakana term the glossary spells is
 * checked by that spelling and can still be certified absent.
 *
 * Round-2 follow-up (orchestrator, combined run): subject eligibility is the
 * topic noun phrase of an identifier-free clause that no facet frames — never
 * a relative clause, a prepositional adjunct, an anaphoric reference, a
 * facet-framed clause's participants or a predicate (sections 7a and 7; the
 * complement of a phrasal request verb, "walk me through …", is the topic).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { TaskCapabilityGap, TaskExecutionContract } from "@tokenlighten/types";
import { extractRequestItems, isLiteralEligibleTerm, katakanaGlossarySpellings, topicNounPhraseWords } from "../features/task-pack/requestItems.js";
import { projectTaskDecision } from "../protocol/decisionWire.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  collectDisclosureTexts,
  finalDecisionKind,
  buildCredentialsWorkspace,
  type ChainResult,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

// ---------------------------------------------------------------------------
// 1. Unit: which clauses split into their own points.
// ---------------------------------------------------------------------------

const itemTexts = (query: string): string[] => extractRequestItems(query).map((item) => item.text.trim());
const coordinatedTexts = (query: string): string[] => extractRequestItems(query).filter((item) => item.coordinated === true).map((item) => item.text.trim());

describe("extractRequestItems — a determiner-led noun-phrase conjunct is its own point", () => {
  // [query, the items, how many trailing items carry `coordinated`]
  const splits: ReadonlyArray<readonly [string, readonly string[], number]> = [
    ["Explain shouldRetry and the health probe.", ["Explain shouldRetry", "the health probe."], 2],
    ["Explain the retry policy and the health probe.", ["Explain the retry policy", "the health probe."], 2],
    ["Explain the health probe and shouldRetry.", ["Explain the health probe", "shouldRetry."], 2],
    ["Explain shouldRetry, the health probe and the retry codes.", ["Explain shouldRetry", "the health probe", "the retry codes."], 2],
    ["Explain shouldRetry and the health checks.", ["Explain shouldRetry", "the health checks."], 2],
    ["Describe computeFee and the audit trail.", ["Describe computeFee", "the audit trail."], 2],
    ["shouldRetry とヘルスプローブについて説明してください。", ["shouldRetry", "ヘルスプローブについて説明してください。"], 2],
    ["shouldRetry とヘルスチェックとバックオフについて説明してください。", ["shouldRetry", "ヘルスチェック", "バックオフについて説明してください。"], 3],
    ["shouldRetry とヘルスチェックの仕組みを説明してください。", ["shouldRetry", "ヘルスチェックの仕組みを説明してください。"], 2],
    ["リトライとバックオフについて説明してください。", ["リトライ", "バックオフについて説明してください。"], 2],
    // A relation clause ("how X decides …") keeps its own decision/relation
    // item; a noun-phrase conjunct in its OBJECT is cut off into its own point.
    ["Explain how shouldRetry decides and the health probe.", ["how shouldRetry decides", "the health probe."], 1],
    ["Explain how the parser uses the token cache and the lexer.", ["how the parser uses the token cache", "the lexer."], 1],
  ];
  for (const [query, expected, coordinatedCount] of splits) {
    it(`splits: ${JSON.stringify(query)}`, () => {
      expect(itemTexts(query)).toEqual(expected);
      expect(coordinatedTexts(query)).toEqual(expected.slice(expected.length - coordinatedCount));
    });
  }

  it("a bullet line splits the same way a sentence does", () => {
    const texts = itemTexts("Explain the HTTP client:\n- shouldRetry and the health probe\n- the default timeout");
    expect(texts).toContain("the health probe");
    expect(texts).toContain("shouldRetry");
  });

  const kept: ReadonlyArray<readonly [string, string]> = [
    ["Explain the retry and backoff logic.", "a head noun shared across the conjunction"],
    ["リトライとバックオフの処理を説明してください。", "JA shared head (plain nouns, の + a content noun)"],
    ["Explain shouldRetry and its callers.", "an anaphoric possessive conjunct"],
    ["Explain shouldRetry and the reason it returns false.", "an anaphoric conjunct headed by a question-kind noun"],
    ["Explain tokenlighten.displayLanguage and the settings in src/new-config.ts.", "a descriptor-only conjunct (facet-owned)"],
    ["Update shouldRetry and the health probe to use the new codes.", "an edit/mutation lead"],
    ["shouldRetry とヘルスプローブを修正してください。", "a JA edit lead"],
    ["Explain how data flows through TransferBuffer and GraphClient.", "no determiner (a compound object)"],
    ["The widget module exposes createWidget and disposeWidget.", "an identifier list after a clause"],
    ["Explain why shouldRetry fails and the client gives up.", "a coordinated clause (its verb is no head noun)"],
    ["Explain how the cache works and the queue is drained.", "a coordinated clause with an auxiliary"],
    ["CONTRACT.md の取り決めを起点に wiring と imports をたどり", "plain English words inside JA prose"],
    ["ステータスが 200 と等しい場合を説明してください。", "a quotative と"],
    ["Audit the decks for drift between the architecture deck and the roadmap deck.", "the two arguments of one relation (shared relational head)"],
    ["How is the display language decided? Explain how the status bar and the update checker reflect the decided language.", "a relation clause's own actor list"],
    ["Fix how shouldRetry decides and the health probe.", "an edit lead around a relation clause"],
  ];
  for (const [query, why] of kept) {
    it(`keeps one point (${why}): ${JSON.stringify(query)}`, () => {
      const items = extractRequestItems(query);
      expect(items.some((item) => item.coordinated === true), JSON.stringify(items.map((item) => item.text))).toBe(false);
    });
  }
});

describe("katakanaGlossarySpellings — the workspace-independent English spelling of a katakana run", () => {
  it("a run the glossary covers completely has a known spelling", () => {
    expect(katakanaGlossarySpellings("ダッシュボード")).toEqual(["dashboard"]);
    expect(katakanaGlossarySpellings("エラーコード")).toEqual(["error", "code"]);
  });
  it("a run with any uncovered part has none", () => {
    expect(katakanaGlossarySpellings("ヘルスプローブ")).toBeUndefined();
    expect(katakanaGlossarySpellings("レディスキャッシュ")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end fixtures and helpers.
// ---------------------------------------------------------------------------

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

const PKG = { "package.json": "{\"name\":\"x\",\"private\":true,\"type\":\"module\"}\n" };
const HTTP: Record<string, string> = {
  ...PKG,
  "src/config.ts": "export const DEFAULT_TIMEOUT_MS = 4200;\nexport const RETRY_CODES = new Set([429, 502, 503]);\nexport const MAX_ATTEMPTS = 3;\n",
  "src/retry.ts": "import { RETRY_CODES, MAX_ATTEMPTS } from './config.js';\nexport function shouldRetry(status: number, attempt: number): boolean {\n  if (attempt >= MAX_ATTEMPTS) return false;\n  return RETRY_CODES.has(status);\n}\nexport function backoffMs(attempt: number): number {\n  return 100 * 2 ** attempt;\n}\n",
  "src/client.ts": "import { DEFAULT_TIMEOUT_MS } from './config.js';\nimport { shouldRetry, backoffMs } from './retry.js';\nexport async function fetchWithRetry(url: string): Promise<number> {\n  let attempt = 0;\n  for (;;) {\n    const status = await doFetch(url, DEFAULT_TIMEOUT_MS);\n    if (!shouldRetry(status, attempt)) return status;\n    await sleep(backoffMs(attempt));\n    attempt += 1;\n  }\n}\nasync function doFetch(url: string, timeoutMs: number): Promise<number> { return url.length + timeoutMs; }\nasync function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }\n",
  "src/health.ts": "import { fetchWithRetry } from './client.js';\nexport async function checkHealth(): Promise<boolean> { return (await fetchWithRetry('/health')) === 200; }\n",
  "README.md": "# HTTP client\n\nA small client with retry and a health probe.\n",
};
const HTTP_README_ONLY: Record<string, string> = Object.fromEntries(Object.entries(HTTP).filter(([rel]) => rel !== "src/health.ts"));
const HTTP_MONITOR: Record<string, string> = {
  ...HTTP_README_ONLY,
  "src/monitor.ts": "import { fetchWithRetry } from './client.js';\n// Liveness probe used by the load balancer health endpoint.\nexport async function probeLiveness(): Promise<boolean> { return (await fetchWithRetry('/live')) === 200; }\n",
};
const FEES: Record<string, string> = {
  ...PKG,
  "src/fees.ts": "const FEE_RATE = 0.025;\nexport function computeFee(amount: number): number {\n  return Math.round(amount * FEE_RATE * 100) / 100;\n}\n",
  "src/audit.ts": "export interface AuditEntry { at: number; action: string; }\nconst trail: AuditEntry[] = [];\nexport function appendAuditEntry(action: string): void { trail.push({ at: Date.now(), action }); }\n",
  "README.md": "# Fees\n\nFee calculation with an audit trail.\n",
};
const RETRY_ONLY: Record<string, string> = {
  ...PKG,
  "src/retry.ts": "export const MAX_RETRIES = 3;\n\n/**\n * Retries fn up to MAX_RETRIES times.\n */\nexport async function withRetry<T>(fn: () => Promise<T>): Promise<T> {\n  let lastError: unknown;\n  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {\n    try {\n      return await fn();\n    } catch (error) {\n      lastError = error;\n    }\n  }\n  throw lastError;\n}\n",
};

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-ctp-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function ask(
  files: Record<string, string>,
  query: string,
  profile: "answer" | undefined = "answer",
  allowWrite = false,
  toolSurface: "code" | "full" = "code",
): Promise<{ chain: ChainResult; disclosures: string[]; served: Set<string> }> {
  const ws = workspace(files);
  const server = startDevServer(ws, "default", { allowWrite, toolSurface });
  servers.push(server);
  await server.initialize();
  const chain = await followNextToEnd(
    server,
    { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", ...(profile ? { profile } : {}) } } },
    { cwd: ws, hopCap: 6 },
  );
  const served = new Set<string>();
  for (const hop of chain.hops) {
    for (const entry of (hop.response?.["evidence"] ?? []) as Array<Record<string, unknown>>) {
      if (typeof entry["body"] === "string" && typeof entry["path"] === "string") served.add(entry["path"]);
    }
  }
  return { chain, disclosures: collectDisclosureTexts(chain), served };
}

const absent = (disclosures: readonly string[]): string[] => disclosures.filter((d) => /request-item-absent/u.test(d));
const undetermined = (disclosures: readonly string[]): string[] => disclosures.filter((d) => /request-item-undetermined/u.test(d));

// ---------------------------------------------------------------------------
// 3. End-to-end P0-5: the second subject is located (served) or disclosed.
// ---------------------------------------------------------------------------

describe("end-to-end: a coordinated noun-phrase point is located or disclosed, never silently covered", () => {
  const located: ReadonlyArray<readonly [string, Record<string, string>, string, string]> = [
    ["EN 'X and the NP'", HTTP, "Explain shouldRetry and the health probe.", "src/health.ts"],
    ["EN 'the NP and X'", HTTP, "Explain the health probe and shouldRetry.", "src/health.ts"],
    ["EN 'X, the NP and the NP2'", HTTP, "Explain shouldRetry, the health probe and the retry codes.", "src/health.ts"],
    ["EN bullets", HTTP, "Explain the HTTP client:\n- shouldRetry and the health probe\n- the default timeout", "src/health.ts"],
    ["EN 'the NP and the NP2'", HTTP, "Explain the retry policy and the health probe.", "src/health.ts"],
    ["JA 「X と NP について」 (mapped katakana)", HTTP, "shouldRetry とヘルスチェックについて説明してください。", "src/health.ts"],
    ["EN, a second fixture", FEES, "Explain computeFee and the audit trail.", "src/audit.ts"],
    ["EN relation clause 'how X decides and the NP'", HTTP, "Explain how shouldRetry decides and the health probe.", "src/health.ts"],
    ["control: the named-path phrasing", HTTP, "Explain shouldRetry and the health probe in src/health.ts.", "src/health.ts"],
    ["control: the concept alone", HTTP, "Explain the health probe.", "src/health.ts"],
  ];
  for (const [label, files, query, target] of located) {
    it(`${label}: ${target} is served`, async () => {
      const { chain, disclosures, served } = await ask(files, query);
      expect([...served], JSON.stringify(disclosures)).toContain(target);
      expect(absent(disclosures).filter((d) => /health|probe|check|ヘルス|audit|trail/iu.test(d)), JSON.stringify(disclosures)).toEqual([]);
      expect(finalDecisionKind(chain)).toBe("act.answer");
    }, 60_000);
  }

  it("a coordinated point whose only candidate is not served is disclosed undetermined with that candidate (README-only concept)", async () => {
    const { chain, disclosures } = await ask(HTTP_README_ONLY, "Explain shouldRetry and the health probe.");
    expect(absent(disclosures), JSON.stringify(disclosures)).toEqual([]);
    expect(undetermined(disclosures).some((d) => /health|probe/iu.test(d) && /README\.md/u.test(d)), JSON.stringify(disclosures)).toBe(true);
    expect(finalDecisionKind(chain)).toBe("act.answer");
  }, 60_000);

  // Follow-up ruling (mixed-kind loop): beside a decision point ("how X
  // decides"), a coordinated point whose only candidate is doc prose has
  // nothing fetchable — it is disclosed non-blocking and the pack certifies;
  // one with a live code candidate keeps blocking with an executable next.
  it("mixed-kind: a coordinated point whose only candidate is doc prose is disclosed non-blocking, and the pack certifies", async () => {
    const { chain, disclosures } = await ask(HTTP_README_ONLY, "Explain how shouldRetry decides and the health probe.");
    expect(absent(disclosures), JSON.stringify(disclosures)).toEqual([]);
    expect(undetermined(disclosures).some((d) => /health|probe/iu.test(d) && /README\.md/u.test(d)), JSON.stringify(disclosures)).toBe(true);
    for (const hop of chain.hops) {
      if (hop.response?.["decision"]?.["kind"] === "discover") expect(hop.response["decision"]["next"], JSON.stringify(hop.response["decision"])).toBeDefined();
    }
    expect(finalDecisionKind(chain)).toBe("act.answer");
  }, 60_000);

  it("mixed-kind control: a coordinated point with a live code candidate keeps blocking with an executable next, then is served", async () => {
    const { chain, served } = await ask(HTTP_MONITOR, "Explain how shouldRetry decides and the liveness probe.");
    const first = chain.hops[0]?.response as Record<string, any> | undefined;
    expect(first?.["decision"]?.["kind"], JSON.stringify(first?.["decision"])).toBe("discover");
    expect(JSON.stringify(first?.["decision"]?.["next"] ?? {}), JSON.stringify(first?.["decision"])).toContain("src/monitor.ts");
    expect(served.has("src/monitor.ts"), JSON.stringify([...served])).toBe(true);
    expect(finalDecisionKind(chain)).toBe("act.answer");
  }, 60_000);

  it("recall control: a coordinated concept the workspace lacks is still certified absent through its subject noun", async () => {
    const { disclosures } = await ask(HTTP, "Explain shouldRetry and the rate limiter.");
    expect(absent(disclosures).some((d) => /request-item-absent:(?:rate|limiter)\b/u.test(d)), JSON.stringify(disclosures)).toBe(true);
  }, 60_000);

  it("control: a shared head noun stays one point — no disclosure about its parts", async () => {
    const { disclosures, served } = await ask(HTTP, "Explain the retry and backoff logic.");
    expect(served.has("src/retry.ts"), JSON.stringify([...served])).toBe(true);
    expect([...absent(disclosures), ...undetermined(disclosures)].filter((d) => /retry|backoff/iu.test(d)), JSON.stringify(disclosures)).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. End-to-end P1-2: an adjective is never certified absent.
// ---------------------------------------------------------------------------

describe("end-to-end: adjectives in identifier-free topic clauses are never certified absent", () => {
  it("'…why intermittent failures are retried' never certifies the adjective", async () => {
    const { disclosures } = await ask(HTTP, "Explain shouldRetry, and why intermittent failures are retried.");
    expect(absent(disclosures).filter((d) => /intermittent/iu.test(d)), JSON.stringify(disclosures)).toEqual([]);
  }, 60_000);

  it("'…why transient errors are retried' never certifies the adjective", async () => {
    const { disclosures } = await ask(HTTP, "Explain shouldRetry, and why transient errors are retried.");
    expect(absent(disclosures).filter((d) => /transient|errors/iu.test(d)), JSON.stringify(disclosures)).toEqual([]);
  }, 60_000);

  it("a context sentence's adjective is never certified; the compound subject noun still is (recall)", async () => {
    const { disclosures } = await ask(
      HTTP,
      "I'm debugging slow requests. Explain the default timeout, how the backoff grows between attempts, and whether the circuit breaker trips after repeated failures.",
    );
    expect(absent(disclosures).filter((d) => /\b(?:slow|debugging|grows)\b/iu.test(d)), JSON.stringify(disclosures)).toEqual([]);
    expect(absent(disclosures).some((d) => /request-item-absent:circuit\b/u.test(d)), JSON.stringify(disclosures)).toBe(true);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// 5. End-to-end katakana ruling.
// ---------------------------------------------------------------------------

describe("end-to-end: a katakana term is certified absent only through a known English spelling", () => {
  it("an unmapped katakana concept present only in English prose is disclosed undetermined, never absent", async () => {
    const { chain, disclosures } = await ask(HTTP, "shouldRetry とヘルスプローブについて説明してください。");
    expect(absent(disclosures), JSON.stringify(disclosures)).toEqual([]);
    expect(undetermined(disclosures).some((d) => /ヘルスプローブ/u.test(d) && /katakana term with no known English spelling/u.test(d)), JSON.stringify(disclosures)).toBe(true);
    expect(finalDecisionKind(chain)).toBe("act.answer");
  }, 60_000);

  it("a mapped katakana concept that exists is unchanged: served, nothing disclosed about it", async () => {
    const { disclosures, served } = await ask(HTTP, "shouldRetry とヘルスチェックについて説明してください。");
    expect(served.has("src/health.ts")).toBe(true);
    expect([...absent(disclosures), ...undetermined(disclosures)].filter((d) => /ヘルスチェック/u.test(d)), JSON.stringify(disclosures)).toEqual([]);
  }, 60_000);

  it("hop 0 names an undetermined katakana point in whichever channel it has (discover gaps or certificate), never as absent", async () => {
    // The first response's KIND for this edit-continuation shape depends on
    // the ambient server configuration (a discover whose next is a plain range
    // read, or a direct certificate); either way the point must be named on
    // hop 0 — before the undetermined gap code, a discover named it nowhere.
    const { chain } = await ask(RETRY_ONLY, "src/retry.ts の MAX_RETRIES の役割を説明し、ドキュメントを更新してください。", undefined, true);
    const first = chain.hops[0]?.response as Record<string, any> | undefined;
    const decision = first?.["decision"] as Record<string, any> | undefined;
    if (decision?.["kind"] === "discover") {
      const gaps = (decision["gaps"] ?? []) as Array<{ code?: string; refs?: string[] }>;
      expect(gaps.some((gap) => gap.code === "request-item-undetermined" && (gap.refs ?? []).includes("ドキュメント")), JSON.stringify(gaps)).toBe(true);
      expect(gaps.filter((gap) => gap.code === "request-item-absent" && (gap.refs ?? []).includes("ドキュメント")), JSON.stringify(gaps)).toEqual([]);
    } else {
      const certificateGaps = (decision?.["certificate"]?.["gaps"] ?? []) as string[];
      expect(certificateGaps.some((gap) => /^explicit-gap:request-item-undetermined:ドキュメント /u.test(gap)), JSON.stringify(decision)).toBe(true);
      expect(certificateGaps.filter((gap) => /request-item-absent:ドキュメント/u.test(gap)), JSON.stringify(decision)).toEqual([]);
    }
  }, 60_000);

  it("control: the EN mirror keeps its verified absence under request-item-absent", async () => {
    const { chain } = await ask(RETRY_ONLY, "Explain how MAX_RETRIES works in src/retry.ts, and update the changelog.", undefined, true);
    const gaps = (chain.hops[0]?.response?.["decision"]?.["gaps"] ?? []) as Array<{ code?: string; refs?: string[] }>;
    expect(gaps.some((gap) => gap.code === "request-item-absent" && (gap.refs ?? []).includes("changelog")), JSON.stringify(gaps)).toBe(true);
  }, 60_000);

  it("an undetermined katakana point is non-blocking: an identifier-free compound still certifies its served point (qualityFirst0143 Q02 jp-to-particle)", async () => {
    // The katakana ruling turned the migration point from a verified absence
    // into a could-not-determine disclosure; the all-topic pass then counted
    // it as OPEN and never discharged `analysis-source`, so the chain stopped
    // on a bare range read instead of certifying the served auth answer.
    const root = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-q02-"));
    tmpDirs.push(root);
    buildCredentialsWorkspace(root);
    const files: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files[path.relative(root, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
      }
    };
    walk(root);
    const { chain, disclosures } = await ask(files, "認証情報の検証方法と、データベースマイグレーションの実行方法を説明してください。");
    expect(finalDecisionKind(chain)).toBe("act.answer");
    expect(JSON.stringify(chain.hops.map((hop) => hop.response))).toMatch(/validateCredentials/u);
    expect(undetermined(disclosures).some((d) => /マイグレーション/u.test(d) && /katakana term with no known English spelling/u.test(d)), JSON.stringify(disclosures)).toBe(true);
    expect(absent(disclosures).filter((d) => /マイグレーション/u.test(d)), JSON.stringify(disclosures)).toEqual([]);
  }, 60_000);

  it("a genuinely absent concept whose katakana the glossary spells is still certified absent", async () => {
    const { disclosures } = await ask(HTTP, "shouldRetry とダッシュボードについて説明してください。");
    expect(absent(disclosures).some((d) => /request-item-absent:ダッシュボード/u.test(d)), JSON.stringify(disclosures)).toBe(true);
    expect(undetermined(disclosures).filter((d) => /ダッシュボード/u.test(d)), JSON.stringify(disclosures)).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 7a. Unit (orchestrator follow-up on the round-2 combined run): subject
//     eligibility is the topic noun phrase of an identifier-free clause that
//     no facet frames — never a relative clause, a prepositional adjunct, an
//     anaphoric reference, a facet-framed clause's participants or a
//     predicate. Recall controls: the complement of a phrasal request verb
//     ("walk me through …"), a topic preposition's object, a possessive owner
//     and an "including" point keep their eligibility.
// ---------------------------------------------------------------------------

const eligibleWords = (clause: string): string[] =>
  [...topicNounPhraseWords(clause)].filter((word) => isLiteralEligibleTerm(word, clause)).sort();

describe("isLiteralEligibleTerm — only the topic noun phrase of an identifier-free, facet-free clause is absence-eligible", () => {
  const never: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["a relative clause after a facet descriptor", "callers that go through a retry scheduler", ["retry", "scheduler", "callers"]],
    ["a participle modifier phrase", "callers passing a weight above 5", ["weight", "passing", "callers"]],
    ["a condition-framed clause's participants", "under which conditions is a customer refused a refund", ["customer", "refund", "refused"]],
    ["an anaphoric of-complement", "what is the default length of that period?", ["length", "period"]],
    ["an anaphoric determiner", "Does the checkout use the same grace period?", ["grace", "period"]],
    ["a predicate participle after a wh-subject and 'are'", "and what error codes are emitted?", ["emitted", "error"]],
    ["another predicate participle", "what exit codes are printed?", ["printed", "exit"]],
    ["a lone predicate participle after 'is'", "what is recorded?", ["recorded"]],
    ["a prepositional adjunct (the wh-clause subject stays eligible)", "Explain how requests flow through the rate limiter.", ["rate", "limiter"]],
    ["plain words of an identifier-bearing clause", "Does chargeCard use the same grace period as renewPlan", ["grace", "period"]],
    // The ruling's "condition-facet clause = facet-owned → never" holds for a
    // definite subject too: a clause that OPENS with the facet phrase is owned
    // by that facet (the point is covered by it or disclosed undetermined).
    ["a clause that opens with the facet phrase", "Under which conditions does the circuit breaker open?", ["circuit", "breaker"]],
    ["the same with the verb inside the wh-phrase run", "Explain which conditions trigger the circuit breaker", ["circuit", "breaker"]],
    ["a wh-phrase that is a preposition's object is no subject; its condition noun frames the clause", "in what cases is an invoice voided", ["invoice", "voided"]],
    ["a degree word after 'how' and an anaphoric noun", "how long is that window?", ["long", "window"]],
    ["a prefixed irregular participle after 'are'", "which are rethrown?", ["rethrown"]],
  ];
  for (const [shape, clause, words] of never) {
    it(`${shape}: ${JSON.stringify(clause)}`, () => {
      const eligible = eligibleWords(clause);
      for (const word of words) expect(eligible, `${word} must never be eligible`).not.toContain(word);
    });
  }

  const recall: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["the complement of a phrasal request verb", "Walk me through the rate limiter.", ["rate", "limiter"]],
    ["the same before a trailing descriptor", "Walk me through the backoff dispatch flow", ["backoff", "dispatch"]],
    ["look into", "Look into the circuit breaker.", ["circuit", "breaker"]],
    ["an imperative marked by its 'me' object", "Take me through the audit trail.", ["audit", "trail"]],
    ["a phrasal request verb outside the lead-verb list", "Go over the retry policy.", ["retry", "policy"]],
    ["a complement beside a facet-framed conjunct", "Walk me through the rate limiter and its callers", ["rate", "limiter"]],
    ["a topic preposition's object in a facet-framed clause", "the conditions of the quorblex vault", ["quorblex", "vault"]],
    ["a possessive owner in a facet-framed clause", "what is the quorblex constant's configured value", ["quorblex", "constant"]],
    ["an 'including' point", "including the actual numeric queue depth value it returns.", ["queue", "depth"]],
    ["the subject of a do-support question", "which file does the quorblex parser read?", ["quorblex", "parser"]],
    ["the subject of a how-question", "how does the flux capacitor work?", ["flux", "capacitor"]],
    ["a descriptor phrase in a later adjunct frames nothing", "Why does the circuit breaker open after repeated errors?", ["circuit", "breaker"]],
    ["nor does one in a later object", "Explain the flux capacitor and its error codes", ["flux", "capacitor"]],
    ["the descriptor's own 'for' complement", "What are the default values for the circuit breaker?", ["circuit", "breaker"]],
    ["the complement of a wh-subject's verb", "What happens to the audit trail when errors occur?", ["audit", "trail"]],
  ];
  for (const [shape, clause, words] of recall) {
    it(`recall control (${shape}): ${JSON.stringify(clause)}`, () => {
      const eligible = eligibleWords(clause);
      for (const word of words) expect(eligible, `${word} must stay eligible`).toContain(word);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Round-2 combined run (orchestrator follow-up): with the NAMED identifier
//    absent no facet binds a focal, and a clause's plain words used to fall
//    back to subject eligibility. Eligibility is structural now: only the
//    topic noun phrase of an identifier-free clause — never a relative clause,
//    a prepositional adjunct, an anaphoric reference, a facet-framed clause's
//    participants or a predicate. Fixture: a copy of the evaluator's HTTP
//    service fixture (core files).
// ---------------------------------------------------------------------------

const EVAL_SERVICE: Record<string, string> = {
  "package.json": "{\n  \"name\": \"tl-evaluation-fixture\",\n  \"type\": \"module\"\n}\n",
  "README.md": "# Transport service\n\nA small HTTP service with retry, timeout and environment configuration.\n",
  "src/retry.ts": "export const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);\nexport function shouldRetry(status: number, attempt: number, maxAttempts: number): boolean {\n  return RETRYABLE_STATUSES.has(status) && attempt + 1 < maxAttempts;\n}\nexport function retryDelay(attempt: number, baseMs: number): number {\n  return baseMs * 2 ** attempt;\n}\n",
  "src/config.ts": "export interface ClientOptions {\n  timeoutMs: number;\n  maxAttempts: number;\n  retryDelayMs: number;\n}\n// The timeout is applied per attempt, not to the whole retry sequence.\nexport const DEFAULT_OPTIONS: ClientOptions = {\n  timeoutMs: 5000,\n  maxAttempts: 3,\n  retryDelayMs: 100,\n};\nexport function loadOptions(env: Record<string, string | undefined>): ClientOptions {\n  return { ...DEFAULT_OPTIONS, timeoutMs: Number(env.HTTP_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs) };\n}\n",
  "src/httpClient.ts": "import { ClientOptions, DEFAULT_OPTIONS } from './config.js';\nimport { shouldRetry, retryDelay } from './retry.js';\nexport async function fetchWithRetry(url: string, options: ClientOptions = DEFAULT_OPTIONS): Promise<Response> {\n  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {\n    const controller = new AbortController();\n    const timer = setTimeout(() => controller.abort(), options.timeoutMs);\n    try {\n      const response = await fetch(url, { signal: controller.signal });\n      if (!shouldRetry(response.status, attempt, options.maxAttempts)) return response;\n    } finally {\n      clearTimeout(timer);\n    }\n    await new Promise(resolve => setTimeout(resolve, retryDelay(attempt, options.retryDelayMs)));\n  }\n  throw new Error('RETRY_EXHAUSTED');\n}\n",
  "src/routes.ts": "import { loadOptions } from './config.js';\nimport { fetchWithRetry } from './httpClient.js';\nexport async function handleHealthRequest(env: Record<string, string | undefined>) {\n  const options = loadOptions(env);\n  const response = await fetchWithRetry('https://example.test/health', options);\n  return { status: response.status, ok: response.ok };\n}\n",
  "tests/retry.test.ts": "import { shouldRetry, retryDelay } from '../src/retry.js';\nexport function checkRetryPolicy() {\n  if (!shouldRetry(429, 0, 3)) throw new Error('retry 429');\n  if (shouldRetry(401, 0, 3)) throw new Error('do not retry auth failures');\n  if (shouldRetry(503, 2, 3)) throw new Error('stop after three attempts');\n  if (retryDelay(1, 100) !== 200) throw new Error('exponential delay');\n}\n",
};

describe("end-to-end: an absent named identifier never turns a clause's plain words into certified absences", () => {
  const shapes: ReadonlyArray<{ label: string; query: string; identifier?: RegExp; never: RegExp; undeterminedAbout?: RegExp }> = [
    {
      label: "facet-owned bullet with a prepositional adjunct inside a relative clause",
      query: "Who calls sendInvoice?\n- direct callers\n- callers that go through a retry scheduler\n- callers passing a weight above 5",
      identifier: /sendInvoice/u,
      never: /request-item-absent[^)]*\b(?:scheduler|retry|weight|passing|direct|callers)\b/iu,
    },
    {
      label: "condition-framed bullet: its participants are never the subject",
      query: "For the grace_table in the billing service:\n- what are the error codes returned for each plan\n- under which conditions is a customer refused a refund",
      identifier: /grace_table/u,
      never: /request-item-absent[^)]*\b(?:customer|refund|refused|plan|codes)\b/iu,
      undeterminedAbout: /customer|refund/u,
    },
    {
      label: "identifier-bearing clause + anaphoric value clause",
      query: "Does chargeCard use the same grace period as renewPlan, and what is the default length of that period?",
      identifier: /chargeCard/u,
      never: /request-item-absent[^)]*\b(?:period|length|grace)\b/iu,
      undeterminedAbout: /period/u,
    },
    {
      label: "a predicate participle after a wh-subject and 'are' (after a path lead)",
      query: "In src/jobs/runner.ts, what are the conditions that cause a job to be moved to the retry_backlog, and what error codes are emitted?",
      identifier: /retry_backlog/u,
      never: /request-item-absent[^)]*\b(?:emitted|moved|job|codes)\b/iu,
    },
    {
      label: "the same with another predicate",
      query: "In src/jobs/runner.ts, what are the conditions that cause a job to be moved to the retry_backlog, and what exit codes are printed?",
      identifier: /retry_backlog/u,
      never: /request-item-absent[^)]*\b(?:printed|exit|moved|job)\b/iu,
    },
    // Fresh analogues: the facet owns a bullet or clause through the lead's
    // identifier (requestFacets inheritance) whatever the clause's own shape.
    {
      label: "'when' condition bullets under an identifier lead",
      query: "For the grace_table in the billing service:\n- when does a refund get rejected\n- when is the customer refused the refund",
      identifier: /grace_table/u,
      never: /request-item-absent[^)]*\b(?:refund|customer|rejected|refused)\b/iu,
    },
    {
      label: "value bullets under an identifier lead",
      query: "What does settleLedger return?\n- the value when the ledger is empty\n- the error when an account is frozen",
      identifier: /settleLedger/u,
      never: /request-item-absent[^)]*\b(?:ledger|empty|account|frozen)\b/iu,
      undeterminedAbout: /ledger/u,
    },
    {
      label: "callers bullets with prepositional adjuncts",
      query: "Who calls sendInvoice?\n- callers inside the nightly batch job\n- the callers from the payment gateway",
      identifier: /sendInvoice/u,
      never: /request-item-absent[^)]*\b(?:inside|nightly|batch|job|payment|gateway)\b/iu,
    },
    {
      label: "a value clause after an identifier-bearing clause, without anaphora",
      query: "Does chargeCard use the same grace period as renewPlan, and what is the default duration?",
      identifier: /chargeCard/u,
      never: /request-item-absent[^)]*\b(?:duration|default|grace|period)\b/iu,
      undeterminedAbout: /duration/u,
    },
    {
      label: "a degree question over an anaphoric noun",
      query: "Does chargeCard use the same grace period as renewPlan, and how long is that window?",
      identifier: /chargeCard/u,
      never: /request-item-absent[^)]*\b(?:long|window)\b/iu,
      undeterminedAbout: /window/u,
    },
    {
      label: "participle predicates after a path lead",
      query: "In src/jobs/runner.ts, which exceptions are swallowed and which are rethrown?",
      never: /request-item-absent[^)]*\b(?:swallowed|rethrown|exceptions)\b/iu,
    },
  ];
  for (const { label, query, identifier, never, undeterminedAbout } of shapes) {
    it(`${label}: only the named identifier is certified absent`, async () => {
      const { disclosures } = await ask(EVAL_SERVICE, query);
      expect(disclosures.filter((d) => never.test(d)), JSON.stringify(disclosures)).toEqual([]);
      if (identifier !== undefined) expect(absent(disclosures).some((d) => identifier.test(d)), JSON.stringify(disclosures)).toBe(true);
      if (undeterminedAbout !== undefined) {
        expect(undetermined(disclosures).some((d) => undeterminedAbout.test(d)), JSON.stringify(disclosures)).toBe(true);
      }
    }, 90_000);
  }

  const controls: ReadonlyArray<readonly [string, string]> = [
    ["callers shape", "Who calls fetchWithRetry?\n- direct callers\n- callers that go through a retry scheduler\n- callers passing a weight above 5"],
    ["condition shape", "For the DEFAULT_OPTIONS in the client config:\n- what are the error codes returned for each plan\n- under which conditions is a customer refused a refund"],
    ["anaphoric value shape", "Does shouldRetry use the same retry delay as fetchWithRetry, and what is the default length of that delay?"],
    ["predicate shape", "In src/httpClient.ts, what are the conditions that cause a request to be retried, and what error codes are emitted?"],
  ];
  for (const [label, query] of controls) {
    it(`control (${label}, the named identifier present): nothing is certified absent and the chain certifies`, async () => {
      const { chain, disclosures } = await ask(EVAL_SERVICE, query);
      expect(absent(disclosures), JSON.stringify(disclosures)).toEqual([]);
      expect(finalDecisionKind(chain)).toBe("act.answer");
    }, 90_000);
  }

  it("recall control: an identifier-free clause beside an identifier still certifies its absent subject", async () => {
    const { disclosures } = await ask(EVAL_SERVICE, "What does shouldRetry do, and how does the flux capacitor work?");
    expect(absent(disclosures).some((d) => /request-item-absent:[^ ]*\b(?:flux|capacitor)\b/u.test(d)), JSON.stringify(disclosures)).toBe(true);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// 6. The additive gap code `request-item-undetermined` reaches `decision.gaps`
//    on a discover, exactly parallel to `request-item-absent`.
// ---------------------------------------------------------------------------

function discoverGaps(gaps: TaskCapabilityGap[]): Array<{ code: string; refs?: string[] }> {
  const decision = projectTaskDecision({
    result: {},
    contract: {
      version: 1,
      state: "needs-followup",
      readiness: "needs-followup",
      discovery_complete: false,
      next_action: "followup",
      max_additional_discovery_calls: 1,
      reason: "synthetic contract for the gap projection",
      typestate: { phase: "discovery", certificate_id: "cert-r2t2" },
      next_call: { tool: "tl_read_file", arguments: { targets: [{ path: "src/retry.ts", range: "2-16" }] } },
      capability_gaps: gaps,
    } as unknown as TaskExecutionContract,
    canonicalKind: "discover",
    evidence: [],
  });
  expect(decision?.kind).toBe("discover");
  return ((decision as { gaps?: Array<{ code: string; refs?: string[] }> }).gaps ?? []);
}

describe("decision.gaps — request-item-undetermined is its own additive code, never coerced onto request-item-absent", () => {
  it("an undetermined request item rides a discover as {code:'request-item-undetermined', refs:[id, term]}", () => {
    const gaps = discoverGaps([
      { kind: "request-item-undetermined", recoverable: false, reason: "ドキュメント: katakana term with no known English spelling", obligation_ids: ["ri-2", "ドキュメント"] },
    ]);
    expect(gaps).toEqual([{ code: "request-item-undetermined", refs: ["ri-2", "ドキュメント"] }]);
  });

  it("control: request-item-absent is unchanged beside it", () => {
    const gaps = discoverGaps([
      { kind: "request-item-absent", recoverable: false, reason: "no occurrence of changelog", obligation_ids: ["ri-2", "changelog"] },
      { kind: "request-item-undetermined", recoverable: false, reason: "not a verified absence", obligation_ids: ["ri-3", "ドキュメント"] },
    ]);
    expect(gaps.map((gap) => gap.code)).toEqual(["request-item-absent", "request-item-undetermined"]);
  });
});
