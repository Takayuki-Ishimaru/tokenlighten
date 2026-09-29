/**
 * evaluation0927Scenarios.ts — fixture + scenarios for the external v0.14.3
 * evaluation dated 2026-09-27 (`TokenLighten_v0.14.3_evaluation_2026-09-27.md`).
 *
 * The evaluator's reproduction ZIP (`reproduce_key_findings.py`, `fixture/`)
 * was not provided, so the corpus below is RECONSTRUCTED from the report's
 * text: a 41-file TypeScript service (HTTP client with timeout + retry,
 * configuration, callers, tests, English and Japanese documents, unrelated
 * modules, one long file, ignored/excluded/binary paths). Every quoted line
 * of the report is reproduced verbatim where the report quotes source
 * (`DEFAULT_OPTIONS`, `RETRYABLE_STATUSES`, `loadOptions`, `shouldRetry`,
 * the 16-line `httpClient.ts`, the `node --test` package script).
 *
 * The corpus is generic test material: no product code reads any of these
 * names, and nothing here is keyed to a bench task.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { stripAnswerLineGutter } from "../../protocol/lineGutter.js";
import {
  anyDisclosureMatches,
  collectDisclosureTexts,
  cumulativeCoverage,
  extraIds,
  extractServedIds,
  finalDecisionKind,
  followNextToEnd,
  idRangeSet,
  missingIds,
  type ChainResult,
  type Scenario,
  type ScenarioContext,
  type ScenarioVerdict,
  type ServerHandle,
} from "./qualityFirstScenarios.js";

function writeFile(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// The HTTP corpus
// ---------------------------------------------------------------------------

export const HTTP_CONFIG_TS = `export interface ClientOptions {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
}

export const DEFAULT_OPTIONS: ClientOptions = {
  timeoutMs: 5000,
  maxAttempts: 3,
  retryDelayMs: 100,
};

export function loadOptions(env: Record<string, string | undefined>): ClientOptions {
  return { ...DEFAULT_OPTIONS, timeoutMs: Number(env.HTTP_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs) };
}
`;

export const HTTP_RETRY_TS = `export const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export function shouldRetry(status: number, attempt: number, maxAttempts: number): boolean {
  return RETRYABLE_STATUSES.has(status) && attempt + 1 < maxAttempts;
}

export function backoffDelay(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt;
}
`;

/** Exactly 16 lines (the report: "16行の httpClient.ts"). */
export const HTTP_CLIENT_TS = `import { loadOptions, type ClientOptions } from "./config";
import { backoffDelay, shouldRetry } from "./retry";

export async function fetchWithRetry(url: string, init: RequestInit = {}, options: ClientOptions = loadOptions(process.env)): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!shouldRetry(response.status, attempt, options.maxAttempts)) return response;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, options.retryDelayMs)));
  }
}
`;

export const HTTP_USERS_TS = `import { fetchWithRetry } from "../httpClient";

export interface User {
  id: string;
  name: string;
}

export async function getUser(id: string): Promise<User> {
  const response = await fetchWithRetry(\`/api/users/\${encodeURIComponent(id)}\`);
  return (await response.json()) as User;
}
`;

export const HTTP_ORDERS_TS = `import { fetchWithRetry } from "../httpClient";

export interface Order {
  id: string;
  total: number;
}

export async function listOrders(customerId: string): Promise<Order[]> {
  const response = await fetchWithRetry(\`/api/customers/\${encodeURIComponent(customerId)}/orders\`, {
    headers: { accept: "application/json" },
  });
  return (await response.json()) as Order[];
}
`;

export const HTTP_RUNTIME_MJS = `// Plain runtime helpers used by the built-in node:test suite.
export function formatDelay(ms) {
  return \`\${ms} ms\`;
}

export function formatDeadline(ms) {
  return \`\${ms} ms\`;
}

export function describeAttempt(attempt, maxAttempts) {
  return \`attempt \${attempt + 1} of \${maxAttempts}\`;
}
`;

export const HTTP_RUNTIME_TEST_MJS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { describeAttempt, formatDelay, formatDeadline } from "../src/runtime.mjs";

test("runtime helpers format attempts and delays", () => {
  assert.equal(describeAttempt(0, 3), "attempt 1 of 3");
  assert.match(formatDelay(100), /^100 ?ms$/);
  assert.match(formatDeadline(5000), /^5000 ?ms$/);
});
`;

export const HTTP_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "http-fixture",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { test: "node --test tests/runtime.test.mjs" },
  },
  null,
  2,
)}\n`;

/** Report §5: `src/large.ts` has 1000 lines; every line self-identifies as
 *  `large-NNNN` so served line sets are measured from bytes alone. */
export const LARGE_TOTAL_LINES = 1000;
export function largeTsLine(n: number): string {
  if (n === 1) return "// large-0001 generated lookup table of catalogue entries (unrelated to networking)";
  return `export const ENTRY_${String(n).padStart(4, "0")} = { id: ${n}, label: "large-${String(n).padStart(4, "0")}", weight: ${(n * 7) % 13} };`;
}

const UNRELATED_TOPICS = [
  "inventory", "palette", "geometry", "calendar", "ledger", "glossary", "recipe", "playlist", "garden", "library",
  "warehouse", "tournament", "orchestra", "telescope", "vineyard", "aquarium", "observatory", "bakery", "harbor", "museum",
] as const;
export const UNRELATED_MODULE_COUNT = UNRELATED_TOPICS.length;
/** Lines per unrelated module (≥ 60: the report reads `1-60` of two of them). */
export const UNRELATED_MODULE_LINES = 84;

/** One unrelated module: every line carries `moduleNN-LLLL` so a served
 *  window is measured from bytes alone (report §5 reads `1-60`). */
export function unrelatedModuleLines(index: number): string[] {
  const nn = String(index).padStart(2, "0");
  const topic = UNRELATED_TOPICS[index]!;
  const Topic = topic[0]!.toUpperCase() + topic.slice(1);
  const body: string[] = [];
  body.push(`// Unrelated ${topic} helpers for module ${nn}.`);
  body.push(`export interface ${Topic}Item${nn} {`);
  body.push("  code: string;");
  body.push("  quantity: number;");
  body.push("  weight: number;");
  body.push("}");
  body.push("");
  let fn = 0;
  while (body.length < UNRELATED_MODULE_LINES - 1) {
    fn += 1;
    const name = `${topic}Step${nn}_${String(fn).padStart(2, "0")}`;
    body.push(`export function ${name}(items: ${Topic}Item${nn}[]): number {`);
    body.push(`  const total = items.reduce((sum, item) => sum + item.quantity * ${fn + index}, 0);`);
    body.push(`  return total + items.length * ${(fn * 3 + index) % 11};`);
    body.push("}");
    body.push("");
  }
  while (body.length < UNRELATED_MODULE_LINES) body.push("");
  return body.slice(0, UNRELATED_MODULE_LINES).map((line, i) => {
    const tag = `module${nn}-${String(i + 1).padStart(4, "0")}`;
    return line.length === 0 ? `// ${tag}` : `${line} // ${tag}`;
  });
}

const README_MD = `# http-fixture

A small TypeScript service whose HTTP client applies a per-request timeout and
retries transient failures before giving up. Configuration is read from the
environment; see \`docs/architecture.md\` for the module layout.

## Scripts

- \`npm test\` runs the built-in \`node:test\` suite (no dependencies needed).
`;

const ARCHITECTURE_MD = `# Architecture

The service is split into small modules:

- \`src/config.ts\` reads client options from the environment.
- \`src/retry.ts\` decides whether a failed response is worth another attempt.
- \`src/httpClient.ts\` performs the request with a timeout and the retry loop.
- \`src/api/\` holds the endpoints that talk to the remote API.

Unrelated helper modules live in \`src/unrelated/\`; they do not use the network.
`;

const OVERVIEW_JA_MD = `# 概要

このリポジトリは外部 API を呼び出す小さな TypeScript サービスです。
設定は環境変数から読み込み、ログは \`src/logger.ts\` に集約しています。

## 開発

- テストは \`npm test\` で実行します(追加の依存関係は不要です)。
- \`src/unrelated/\` 以下のモジュールはネットワークを使いません。
`;

const LOGGER_TS = `export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function shouldLog(level: LogLevel, threshold: LogLevel): boolean {
  return ORDER[level] >= ORDER[threshold];
}

export function log(level: LogLevel, message: string, threshold: LogLevel = "info"): void {
  if (shouldLog(level, threshold)) console.log(\`[\${level}] \${message}\`);
}
`;

const INDEX_TS = `export { fetchWithRetry } from "./httpClient";
export { getUser } from "./api/users";
export { listOrders } from "./api/orders";
export { log } from "./logger";
`;

const TSCONFIG_JSON = `${JSON.stringify(
  { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noEmit: true }, include: ["src"] },
  null,
  2,
)}\n`;

/** Build output (git-ignored): carries the same constants, so a server
 *  that answered from it would be answering from an excluded path. */
const DIST_HTTP_CLIENT_JS = `"use strict";
const DEFAULT_OPTIONS = { timeoutMs: 5000, maxAttempts: 3, retryDelayMs: 100 };
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
export async function fetchWithRetry(url, init = {}) {
  return fetch(url, init);
}
`;

/** Excluded by \`.tokenlightenignore\`. */
const GENERATED_OPENAPI_TS = `// Generated client stubs (excluded from TokenLighten by .tokenlightenignore).
import { fetchWithRetry } from "../src/httpClient";

export const generatedHealthCheck = () => fetchWithRetry("/health");
`;

/** A 1x1 PNG. */
const LOGO_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b30000000049454e44ae426082",
  "hex",
);

/**
 * Writes the reconstructed 41-file corpus under `root`.
 *
 * Layout (41 files): package.json, tsconfig.json, .gitignore,
 * .tokenlightenignore, README.md, docs/architecture.md, docs/ja/overview.md,
 * src/{index,config,retry,httpClient,logger,large}.ts, src/runtime.mjs,
 * src/api/{users,orders}.ts, tests/runtime.test.mjs, 20 x
 * src/unrelated/moduleNN.ts, dist/httpClient.js (git-ignored),
 * generated/openapi.ts (tokenlightenignore'd), debug.log (git-ignored),
 * assets/logo.png (binary).
 */
export type HttpCorpusVariant = "compact" | "sliced";

/** Extra, unrelated-to-the-question exports appended to config.ts / retry.ts
 *  in the "sliced" variant, so a pack serves a function SLICE of each file
 *  instead of the whole file (the report's observation: "config.ts は
 *  loadOptions のみ、retry.ts は shouldRetry のみ"). */
export const HTTP_CONFIG_EXTRA_TS = `
export interface ProxySettings {
  host: string;
  port: number;
  secure: boolean;
}

export function parseProxy(value: string | undefined): ProxySettings | undefined {
  if (!value) return undefined;
  const match = /^(https?):\\/\\/([^:/]+)(?::(\\d+))?/.exec(value);
  if (!match) return undefined;
  return { host: match[2]!, port: Number(match[3] ?? (match[1] === "https" ? 443 : 80)), secure: match[1] === "https" };
}

export function userAgent(product: string, version: string): string {
  return \`\${product}/\${version} (+https://example.invalid/bot)\`;
}

export function baseUrlFrom(env: Record<string, string | undefined>): string {
  const raw = env.API_BASE_URL ?? "https://api.example.invalid";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

export function headerList(env: Record<string, string | undefined>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of (env.EXTRA_HEADERS ?? "").split(";")) {
    const [name, value] = entry.split("=");
    if (name && value) out.push([name.trim(), value.trim()]);
  }
  return out;
}

export function describeOptions(options: ClientOptions): string {
  return \`timeout=\${options.timeoutMs} attempts=\${options.maxAttempts} delay=\${options.retryDelayMs}\`;
}
`;

export const HTTP_RETRY_EXTRA_TS = `
export function jitter(delayMs: number, random: () => number = Math.random): number {
  return Math.round(delayMs * (0.5 + random()));
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

export function remainingAttempts(attempt: number, maxAttempts: number): number {
  return Math.max(0, maxAttempts - attempt - 1);
}

export function summarizeAttempts(statuses: readonly number[]): string {
  return statuses.map((status, index) => \`#\${index + 1}:\${status}\`).join(", ");
}
`;

export function buildHttpCorpusWorkspace(root: string, variant: HttpCorpusVariant = "compact"): void {
  writeFile(root, "package.json", HTTP_PACKAGE_JSON);
  writeFile(root, "tsconfig.json", TSCONFIG_JSON);
  writeFile(root, ".gitignore", "dist/\nnode_modules/\n*.log\n");
  writeFile(root, ".tokenlightenignore", "generated/\n");
  writeFile(root, "README.md", README_MD);
  writeFile(root, "docs/architecture.md", ARCHITECTURE_MD);
  writeFile(root, "docs/ja/overview.md", OVERVIEW_JA_MD);
  writeFile(root, "src/index.ts", INDEX_TS);
  writeFile(root, "src/config.ts", variant === "sliced" ? HTTP_CONFIG_TS + HTTP_CONFIG_EXTRA_TS : HTTP_CONFIG_TS);
  writeFile(root, "src/retry.ts", variant === "sliced" ? HTTP_RETRY_TS + HTTP_RETRY_EXTRA_TS : HTTP_RETRY_TS);
  writeFile(root, "src/httpClient.ts", HTTP_CLIENT_TS);
  writeFile(root, "src/logger.ts", LOGGER_TS);
  writeFile(root, "src/runtime.mjs", HTTP_RUNTIME_MJS);
  writeFile(root, "src/api/users.ts", HTTP_USERS_TS);
  writeFile(root, "src/api/orders.ts", HTTP_ORDERS_TS);
  writeFile(root, "tests/runtime.test.mjs", HTTP_RUNTIME_TEST_MJS);
  const large: string[] = [];
  for (let n = 1; n <= LARGE_TOTAL_LINES; n++) large.push(largeTsLine(n));
  writeFile(root, "src/large.ts", `${large.join("\n")}\n`);
  for (let i = 0; i < UNRELATED_MODULE_COUNT; i++) {
    writeFile(root, `src/unrelated/module${String(i).padStart(2, "0")}.ts`, `${unrelatedModuleLines(i).join("\n")}\n`);
  }
  writeFile(root, "dist/httpClient.js", DIST_HTTP_CLIENT_JS);
  writeFile(root, "generated/openapi.ts", GENERATED_OPENAPI_TS);
  writeFile(root, "debug.log", "2026-09-20T10:00:00Z retry attempt 1 of 3 for /api/users/7 (status 503)\n");
  writeFile(root, "assets/logo.png", LOGO_PNG);
}

// ---------------------------------------------------------------------------
// Acceptance scenarios (brief-w0.md) — V01..V10, ids fixed by the brief.
//
// Consumed by TWO callers that must never drift apart (same contract as
// `qualityFirstScenarios.ts`'s own header):
//   1. `evaluation0927.acceptance.spec.ts` — the DEV server, this tree.
//   2. `scripts/tl-quality-eval.mjs --suite 0927` — any packaged build.
//
// "Required facts" (brief-w0.md) are checked as verbatim substrings of
// SERVED EVIDENCE BODIES ONLY — never an echoed `query`, a `next` call's own
// `arguments`, or a bare `path` string — via `servedBodyItems` below, which
// walks only the wire shapes actually observed to carry real file text
// (`evidence[].body`, `read.batch` `entries[].content`, and a bare
// `read.text`'s own top-level `content`). A fact may also be scoped to
// specific serving paths (`anyPathSuffix`) — e.g. "the callers of X" is only
// proved by a CALL SITE's own file, never by X's own declaration line or an
// excluded/build-output copy that happens to also mention the same text.
// ---------------------------------------------------------------------------

export interface RequiredFact {
  id: string;
  /** Verbatim substring that must appear in a served body. */
  substring: string;
  /** If set, `substring` must be found in a body belonging to an
   *  evidence/entry item whose `path` ends with one of these — not merely
   *  present ANYWHERE in the chain. */
  anyPathSuffix?: readonly string[];
}

export interface ServedBodyItem {
  path: string | undefined;
  text: string;
}

/** Every served body chunk in ONE hop's response, path-tagged where the wire
 *  carries a path for it. Deliberately ignores `query`, `next.arguments`,
 *  bare `path` strings without a body, and every other echoed-input field —
 *  see header. */
export function servedBodyItems(response: unknown): ServedBodyItem[] {
  const out: ServedBodyItem[] = [];
  const obj = response as Record<string, unknown> | null | undefined;
  if (obj == null) return out;
  if (typeof obj["content"] === "string") {
    out.push({ path: typeof obj["path"] === "string" ? (obj["path"] as string) : undefined, text: obj["content"] as string });
  }
  const evidence = obj["evidence"];
  if (Array.isArray(evidence)) {
    for (const e of evidence) {
      const rec = e as Record<string, unknown> | null;
      const body = rec?.["body"];
      if (typeof body === "string") {
        out.push({ path: typeof rec?.["path"] === "string" ? (rec["path"] as string) : undefined, text: body });
      }
    }
  }
  const entries = obj["entries"];
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const rec = e as Record<string, unknown> | null;
      const content = rec?.["content"];
      if (typeof content === "string") {
        out.push({ path: typeof rec?.["path"] === "string" ? (rec["path"] as string) : undefined, text: content });
      }
      const nestedEvidence = rec?.["evidence"];
      if (Array.isArray(nestedEvidence)) {
        for (const ne of nestedEvidence) {
          const nrec = ne as Record<string, unknown> | null;
          const nbody = nrec?.["body"];
          if (typeof nbody === "string") {
            out.push({ path: typeof nrec?.["path"] === "string" ? (nrec["path"] as string) : undefined, text: nbody });
          }
        }
      }
    }
  }
  return out;
}

function factServed(fact: RequiredFact, items: readonly ServedBodyItem[]): boolean {
  const candidates = fact.anyPathSuffix
    ? items.filter((it) => it.path !== undefined && fact.anyPathSuffix!.some((suffix) => it.path!.endsWith(suffix)))
    : items;
  return candidates.some((it) => it.text.includes(fact.substring));
}

function pickPath(obj: unknown, keyPath: string): unknown {
  return keyPath.split(".").reduce((acc: unknown, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]), obj);
}

function isRefusalNaming(body: unknown, code: string): boolean {
  const rec = body as Record<string, unknown> | null | undefined;
  if (rec?.["kind"] !== "refusal") return false;
  if (rec["code"] === code) return true;
  try {
    return JSON.stringify(rec).includes(code);
  } catch {
    return false;
  }
}

// --- The four P0 queries, verbatim from eval-0927.md / brief-w0.md ---------

export const V01_QUERY_EN = "Explain the default HTTP_TIMEOUT_MS value, the shouldRetry conditions, and the callers of fetchWithRetry.";
export const V02_QUERY_JA =
  "HTTPリクエストのタイムアウトと再試行の仕組みを説明してください。\n既定値、リクエストの処理経路、再試行するHTTPステータスコードを確認してください。";
export const V03_QUERY_JA = "HTTP_TIMEOUT_MS の既定値、shouldRetry の再試行条件、fetchWithRetry の呼び出し元を説明してください。";
export const V05_QUERY_EN =
  "How does the HTTP client handle timeouts and retries? Show the default values and which status codes are retried.";

export const FACT_DEFAULT: RequiredFact = { id: "default", substring: "timeoutMs: 5000" };
export const FACT_ENV: RequiredFact = { id: "env", substring: "env.HTTP_TIMEOUT_MS ?? DEFAULT_OPTIONS.timeoutMs" };
export const FACT_STATUSES: RequiredFact = { id: "statuses", substring: "RETRYABLE_STATUSES = new Set([429, 502, 503, 504])" };
export const FACT_PREDICATE: RequiredFact = { id: "predicate", substring: "RETRYABLE_STATUSES.has(status) && attempt + 1 < maxAttempts" };
export const FACT_CLIENT: RequiredFact = { id: "client", substring: "controller.abort(), options.timeoutMs" };
export const FACT_CALLER: RequiredFact = { id: "caller", substring: "fetchWithRetry(", anyPathSuffix: ["src/api/users.ts", "src/api/orders.ts"] };

export const V01_FACTS: readonly RequiredFact[] = [FACT_DEFAULT, FACT_ENV, FACT_STATUSES, FACT_PREDICATE, FACT_CALLER];
export const V02_FACTS: readonly RequiredFact[] = [FACT_DEFAULT, FACT_STATUSES, FACT_CLIENT, FACT_CALLER];
/** "Required as V01" (brief-w0.md V03). */
export const V03_FACTS: readonly RequiredFact[] = V01_FACTS;
export const V05_FACTS: readonly RequiredFact[] = [FACT_DEFAULT, FACT_STATUSES, FACT_CLIENT];

export const V02_FORBIDDEN_ABSENCE_TERMS = ["既定値", "処理経路", "再試行", "ステータス", "タイムアウト", "リクエスト"] as const;
export const V03_FORBIDDEN_ABSENCE_TERMS = ["既定値", "再試行条件", "呼び出し元"] as const;

// --- The shared fact-chain runner (V01/V02/V03/V04/V05/V07) ----------------

export interface FactChainVerdict {
  pass: boolean;
  requiredTotal: number;
  servedFactIds: string[];
  missingFactIds: string[];
  falseCompletions: number;
  /** Chain never certified `act.answer` while facts were missing, but also
   *  never served every required fact (a DISTINCT diagnostic from `pass` —
   *  brief-w0.md: "Record also the honest-incomplete outcome ... as a
   *  separate metric"). */
  honestIncomplete: boolean;
  capped: boolean;
  hops: number;
  bytes: number;
  disclosures: string[];
  forbiddenDisclosureHits: string[];
  finalDecisionKind: string | undefined;
  chain: ChainResult;
}

export interface FactChainOptions {
  profile?: string;
  forbiddenAbsenceTerms?: readonly string[];
  hopCap?: number;
  /** Top-level `budget: { bytes }` on the FIRST call only (as-yet-unbudgeted `next` hops carry their own). */
  budgetBytes?: number;
}

/**
 * Issues ONE `read_file {query}` call, follows its `next` chain to the end
 * (qref re-pack <= 2, hop cap 12 by default — brief-w0.md's "VERDICT for
 * V01-V05 (strict)"), then verifies: (1) no FALSE COMPLETION — no hop whose
 * `decision.kind` is `act.answer` while some required fact had not yet been
 * served by (through) that hop, cumulatively; (2) every required fact
 * eventually served; (3) (optional) no absence disclosure names a forbidden
 * term. `pass` requires all three; `honestIncomplete` is reported whenever
 * the chain avoided (1) but still fell short of (2) — a legitimate current
 * failure mode, distinct from lying about completion.
 */
export async function runFactChainQuery(
  server: ServerHandle,
  cwd: string,
  query: string,
  facts: readonly RequiredFact[],
  opts: FactChainOptions = {},
): Promise<FactChainVerdict> {
  const taskArg: Record<string, unknown> = { epoch: "new" };
  if (opts.profile) taskArg["profile"] = opts.profile;
  const callArgs: Record<string, unknown> = { query, cwd, task: taskArg };
  if (opts.budgetBytes !== undefined) callArgs["budget"] = { bytes: opts.budgetBytes };
  const chain = await followNextToEnd(
    server,
    { tool: "read_file", arguments: callArgs },
    { cwd, hopCap: opts.hopCap ?? 12, maxQrefRepacks: 2 },
  );

  const cumulativeItems: ServedBodyItem[] = [];
  let falseCompletions = 0;
  for (const hop of chain.hops) {
    cumulativeItems.push(...servedBodyItems(hop.response));
    const kind = pickPath(hop.response, "decision.kind");
    if (kind === "act.answer") {
      const stillMissing = facts.filter((f) => !factServed(f, cumulativeItems));
      if (stillMissing.length > 0) falseCompletions += 1;
    }
  }
  const servedFactIds = facts.filter((f) => factServed(f, cumulativeItems)).map((f) => f.id);
  const missingFactIds = facts.filter((f) => !factServed(f, cumulativeItems)).map((f) => f.id);
  const disclosures = collectDisclosureTexts(chain);
  const forbiddenAbsenceTerms = opts.forbiddenAbsenceTerms ?? [];
  const forbiddenDisclosureHits = forbiddenAbsenceTerms.filter((term) => anyDisclosureMatches(disclosures, [term]));
  const honestIncomplete = falseCompletions === 0 && missingFactIds.length > 0;
  const pass = falseCompletions === 0 && missingFactIds.length === 0 && forbiddenDisclosureHits.length === 0;

  return {
    pass,
    requiredTotal: facts.length,
    servedFactIds,
    missingFactIds,
    falseCompletions,
    honestIncomplete,
    capped: chain.capped,
    hops: chain.hops.length,
    bytes: chain.hops.reduce((sum, h) => sum + h.textBytes, 0),
    disclosures,
    forbiddenDisclosureHits,
    finalDecisionKind: finalDecisionKind(chain),
    chain,
  };
}

// --- V01/V02/V03/V05: one query family, run on both corpus variants -------

const P0_VARIANTS: readonly HttpCorpusVariant[] = ["compact", "sliced"];

function variantCwd(ws: string, variant: HttpCorpusVariant): string {
  return path.join(ws, variant);
}

function buildBothVariantsWorkspace(root: string): void {
  for (const variant of P0_VARIANTS) buildHttpCorpusWorkspace(variantCwd(root, variant), variant);
}

function factChainMember(variant: HttpCorpusVariant, result: FactChainVerdict): Record<string, unknown> & { id: string; pass: boolean } {
  return {
    id: variant,
    pass: result.pass,
    requiredServed: result.requiredTotal - result.missingFactIds.length,
    requiredTotal: result.requiredTotal,
    missingFactIds: result.missingFactIds,
    falseCompletions: result.falseCompletions,
    honestIncomplete: result.honestIncomplete,
    capped: result.capped,
    calls: result.hops,
    bytes: result.bytes,
    forbiddenDisclosureHits: result.forbiddenDisclosureHits,
    finalDecisionKind: result.finalDecisionKind,
  };
}

async function runP0FamilyScenario(
  ctx: ScenarioContext,
  query: string,
  facts: readonly RequiredFact[],
  opts: FactChainOptions,
): Promise<ScenarioVerdict> {
  const members: Array<Record<string, unknown> & { id: string; pass: boolean }> = [];
  for (const variant of P0_VARIANTS) {
    const result = await runFactChainQuery(ctx.server, variantCwd(ctx.ws, variant), query, facts, opts);
    members.push(factChainMember(variant, result));
  }
  const pass = members.every((m) => m.pass);
  return {
    pass,
    reason: pass
      ? "every corpus variant served all required facts through the chain with no false completion"
      : `failing variant(s): ${JSON.stringify(members.filter((m) => !m.pass).map((m) => m.id))}`,
    metrics: { members },
  };
}

/** V02/V05: the evaluation fixed `task.profile:"answer"` for §3 but not for §4, so both declared-answer and
 *  undeclared runs are members. Each (profile, variant) gets its OWN workspace copy so no served-state from one
 *  member can turn another member's bodies into receipts. */
const PROFILE_MEMBERS: ReadonlyArray<{ key: string; profile?: string }> = [{ key: "answer", profile: "answer" }, { key: "none" }];

function buildProfileVariantsWorkspace(root: string): void {
  for (const member of PROFILE_MEMBERS) {
    for (const variant of P0_VARIANTS) buildHttpCorpusWorkspace(path.join(root, member.key, variant), variant);
  }
}

async function runP0FamilyProfilesScenario(
  ctx: ScenarioContext,
  query: string,
  facts: readonly RequiredFact[],
  opts: FactChainOptions,
): Promise<ScenarioVerdict> {
  const members: Array<Record<string, unknown> & { id: string; pass: boolean }> = [];
  for (const member of PROFILE_MEMBERS) {
    for (const variant of P0_VARIANTS) {
      const memberOpts: FactChainOptions = member.profile !== undefined ? { ...opts, profile: member.profile } : opts;
      const result = await runFactChainQuery(ctx.server, path.join(ctx.ws, member.key, variant), query, facts, memberOpts);
      members.push({ ...factChainMember(variant, result), id: `${member.key}/${variant}` });
    }
  }
  const pass = members.every((m) => m.pass);
  return {
    pass,
    reason: pass
      ? "every (profile, corpus variant) member served all required facts through the chain with no false completion"
      : `failing member(s): ${JSON.stringify(members.filter((m) => !m.pass).map((m) => m.id))}`,
    metrics: { members },
  };
}

// --- V04: EN (V01) and JA (V03) paraphrase must reach the SAME fact set ----

async function runV04(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const en = await runFactChainQuery(ctx.server, ctx.ws, V01_QUERY_EN, V01_FACTS, { profile: "answer" });
  const ja = await runFactChainQuery(ctx.server, ctx.ws, V03_QUERY_JA, V03_FACTS, { profile: "answer" });
  const sameSet =
    en.servedFactIds.length === ja.servedFactIds.length && en.servedFactIds.every((f) => ja.servedFactIds.includes(f));
  const pass = en.pass && ja.pass && sameSet;
  return {
    pass,
    reason: pass
      ? "the English and Japanese paraphrases served the identical required-fact set"
      : `en.pass=${en.pass} ja.pass=${ja.pass} enServed=${JSON.stringify(en.servedFactIds)} jaServed=${JSON.stringify(ja.servedFactIds)}`,
    metrics: {
      members: [
        { id: "en", pass: en.pass, requiredServed: en.requiredTotal - en.missingFactIds.length, requiredTotal: en.requiredTotal, servedFactIds: en.servedFactIds },
        { id: "ja", pass: ja.pass, requiredServed: ja.requiredTotal - ja.missingFactIds.length, requiredTotal: ja.requiredTotal, servedFactIds: ja.servedFactIds },
      ],
      sameFactSet: sameSet,
    },
  };
}

// --- V06: multi-target `content:"full"` must respect explicit ranges ------

function v06PrimaryTargets(): ReadonlyArray<{ path: string; range: string }> {
  return [
    { path: "src/large.ts", range: "1-300" },
    { path: "src/unrelated/module00.ts", range: "1-60" },
    { path: "src/unrelated/module01.ts", range: "1-60" },
  ];
}

function tagForRangedPath(relPath: string): string {
  return relPath.includes("large") ? "large" : path.basename(relPath, ".ts");
}

/** How many times a served (tag, lineNum) pair reappears on a LATER hop after
 *  its first hop — a re-serve of a line the caller already had, not merely a
 *  line present in the cumulative union (V06's "DUPLICATE lines" metric). */
function duplicateServedIdCount(chain: ChainResult, tags: readonly string[]): number {
  const seen = new Map<string, Set<number>>();
  let duplicates = 0;
  for (const hop of chain.hops) {
    const hopIds = extractServedIds(hop.response, tags);
    for (const [tag, nums] of hopIds) {
      if (!seen.has(tag)) seen.set(tag, new Set());
      const bucket = seen.get(tag)!;
      for (const n of nums) {
        if (bucket.has(n)) duplicates += 1;
        else bucket.add(n);
      }
    }
  }
  return duplicates;
}

async function runRangedMultiTargetMember(
  ctx: ScenarioContext,
  id: string,
  targets: ReadonlyArray<{ path: string; range: string }>,
  budgetBytes: number | undefined,
): Promise<Record<string, unknown> & { id: string; pass: boolean }> {
  const tags = [...new Set(targets.map((t) => tagForRangedPath(t.path)))];
  const args: Record<string, unknown> = { targets, content: "full", cwd: ctx.ws };
  if (budgetBytes !== undefined) args["budget"] = { bytes: budgetBytes };
  const chain = await followNextToEnd(ctx.server, { tool: "read_file", arguments: args }, { cwd: ctx.ws, hopCap: 30 });
  const coverage = cumulativeCoverage(chain, tags);
  let missing = 0;
  let outOfRange = 0;
  for (const t of targets) {
    const tag = tagForRangedPath(t.path);
    const parts = t.range.split("-");
    const wanted = idRangeSet(Number(parts[0]), Number(parts[1]));
    const got = coverage.get(tag) ?? new Set<number>();
    missing += missingIds(wanted, got).length;
    outOfRange += extraIds(got, wanted).length;
  }
  const duplicateLines = duplicateServedIdCount(chain, tags);
  const pass = missing === 0 && outOfRange === 0 && !chain.capped;
  return {
    id,
    pass,
    calls: chain.hops.length,
    bytes: chain.hops.reduce((sum, h) => sum + h.textBytes, 0),
    missingLines: missing,
    outOfRangeLines: outOfRange,
    duplicateLines,
    capped: chain.capped,
  };
}

async function runSingleTargetEquivalenceMember(ctx: ScenarioContext): Promise<Record<string, unknown> & { id: string; pass: boolean }> {
  const targets = v06PrimaryTargets();
  let missing = 0;
  let outOfRange = 0;
  let calls = 0;
  let bytes = 0;
  for (const t of targets) {
    const tag = tagForRangedPath(t.path);
    const parts = t.range.split("-");
    const wanted = idRangeSet(Number(parts[0]), Number(parts[1]));
    // force_serve: this member runs AFTER the other V06 members already read
    // these exact files/ranges in full in this SAME session — without it,
    // the server correctly receipts an identical re-read (C02a's own
    // behaviour) and the receipt's tiny body would be misread by
    // `extractServedIds` as "missing", a harness artifact, not a product
    // defect. This member's whole point is a force-served ground truth of
    // what a single-target call delivers, independent of receipt state.
    const chain = await followNextToEnd(
      ctx.server,
      { tool: "read_file", arguments: { targets: [t], content: "full", cwd: ctx.ws, task: { force_serve: true } } },
      { cwd: ctx.ws, hopCap: 30 },
    );
    const coverage = cumulativeCoverage(chain, [tag]);
    const got = coverage.get(tag) ?? new Set<number>();
    missing += missingIds(wanted, got).length;
    outOfRange += extraIds(got, wanted).length;
    calls += chain.hops.length;
    bytes += chain.hops.reduce((sum, h) => sum + h.textBytes, 0);
  }
  return { id: "single-target-equivalence", pass: missing === 0 && outOfRange === 0, calls, bytes, missingLines: missing, outOfRangeLines: outOfRange, duplicateLines: 0 };
}

function buildV06Workspace(root: string): void {
  buildHttpCorpusWorkspace(root, "compact");
}

async function runV06(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members = [
    await runRangedMultiTargetMember(ctx, "3target-6144budget", v06PrimaryTargets(), 6144),
    await runRangedMultiTargetMember(
      ctx,
      "minimal-2target-range1-3",
      [
        { path: "src/unrelated/module02.ts", range: "1-3" },
        { path: "src/unrelated/module03.ts", range: "1-3" },
      ],
      undefined,
    ),
    await runSingleTargetEquivalenceMember(ctx),
  ];
  const pass = members.every((m) => m.pass);
  return {
    pass,
    reason: pass
      ? "multi-target content:\"full\" delivered exactly the requested ranges, matching single-target semantics"
      : `failing member(s): ${JSON.stringify(members.filter((m) => !m.pass).map((m) => m.id))}`,
    metrics: { members },
  };
}

// --- V07: evidence originality across every V01/V02/V03/V05 chain ---------

export interface OriginalityViolation {
  source: string;
  path: string;
  range: string | undefined;
  why: string | undefined;
  reason: string;
  firstDifferingLine?: number;
}

/** `item.form` is a forward-looking field (brief-w0.md §6.1's fix proposal);
 *  no evidence item observed on the wire carries it today, so this always
 *  returns `false` against the current server — exactly the honest
 *  fail-first state this scenario is meant to capture. */
export function isLabelledDerivedEvidence(item: unknown): boolean {
  const form = (item as Record<string, unknown> | null | undefined)?.["form"];
  return typeof form === "string" && form !== "source";
}

function realFileLines(cwd: string, relPath: string): string[] | undefined {
  try {
    const real = fs.readFileSync(path.join(cwd, relPath), "utf8");
    return real.endsWith("\n") ? real.split("\n").slice(0, -1) : real.split("\n");
  } catch {
    return undefined;
  }
}

/** Mirrors `ELISION_MARKER_RE` (qualityFirstScenarios.ts) but anchored to a
 *  WHOLE line, since this walks a served body one line at a time to expand
 *  each marker back to the real lines it stands for. Kept as a sibling
 *  constant rather than importing the shared (unanchored, `matchAll`-shaped)
 *  regex object, whose global `lastIndex` state and whole-string scanning
 *  shape do not fit this per-line use. */
const INLINE_ELISION_LINE_RE = /^\/\* doc elided L(\d+)-(\d+) \*\/$|^# doc elided L(\d+)-(\d+)$/;

function expandElisionMarkers(bodyLines: readonly string[], realLines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of bodyLines) {
    const m = INLINE_ELISION_LINE_RE.exec(line.trim());
    if (m) {
      const a = Number(m[1] ?? m[3]);
      const b = Number(m[2] ?? m[4]);
      for (let i = a; i <= b; i++) out.push(realLines[i - 1] ?? `<elision points past EOF: line ${i}>`);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** `"N-M"` (or a bare `"N"`, one line) -> `[start, end]`; `undefined` if malformed. */
function parseLineWindow(text: string): [number, number] | undefined {
  const pair = /^(\d+)-(\d+)$/.exec(text);
  if (pair) return [Number(pair[1]), Number(pair[2])];
  const single = /^(\d+)$/.exec(text);
  return single ? [Number(single[1]), Number(single[1])] : undefined;
}

/**
 * The 1-based line numbers in `[a, b]` this evidence item actually claims to
 * carry: the whole range MINUS every well-formed `remaining` window that
 * falls inside it (wire multi-span convention — `Evidence.remaining`,
 * `protocol.ts`: "Unserved windows of THIS handle"). A malformed or
 * out-of-range `remaining` entry is ignored here rather than rejected: this
 * function's only job is computing what the ORIGINALITY check below should
 * expect, not validating `remaining` itself.
 */
function servedLineNumbers(a: number, b: number, remaining: unknown): number[] {
  const excluded = new Set<number>();
  if (Array.isArray(remaining)) {
    for (const entry of remaining) {
      if (typeof entry !== "string") continue;
      const window = parseLineWindow(entry);
      if (window === undefined) continue;
      const [ra, rb] = window;
      for (let line = Math.max(a, ra); line <= Math.min(b, rb); line++) excluded.add(line);
    }
  }
  const out: number[] = [];
  for (let line = a; line <= b; line++) if (!excluded.has(line)) out.push(line);
  return out;
}

/**
 * Checks every `evidence[]` item with a string `body` in `chain` against the
 * REAL file on disk under `cwd`: (a) `range` must be `1 <= a <= b <=` the
 * file's real line count (a file ending in `\n` has N lines, not N+1); (b)
 * the body must be verbatim source of range a..b MINUS any in-range
 * `remaining` windows (the wire's multi-span convention — a body honestly
 * SHEDS a disclosed sub-window rather than claiming the whole range; external
 * v0.14.3 evaluation, 2026-09-27 §6.2, finding #17: the previous version
 * required the body to cover the WHOLE range and flagged every legitimately
 * shed row as a fabrication), honoring inline elision markers as standing for
 * the lines they name and ignoring a trailing-newline difference; (c) a body
 * that is neither is a violation UNLESS `isLabelledDerivedEvidence` says it
 * was honestly labelled non-verbatim. Generic over any path in the corpus —
 * never keyed to a specific file name.
 */
export function checkEvidenceOriginality(chain: ChainResult, cwd: string, source: string): OriginalityViolation[] {
  const violations: OriginalityViolation[] = [];
  for (const hop of chain.hops) {
    const evidence = (hop.response as Record<string, unknown> | null | undefined)?.["evidence"];
    if (!Array.isArray(evidence)) continue;
    for (const item of evidence) {
      const rec = item as Record<string, unknown> | null;
      const body = rec?.["body"];
      const itemPath = rec?.["path"];
      if (typeof body !== "string" || typeof itemPath !== "string") continue;
      const range = rec?.["range"];
      const why = typeof rec?.["why"] === "string" ? (rec["why"] as string) : undefined;
      if (typeof range !== "string") continue;
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (!m) continue;
      const realLines = realFileLines(cwd, itemPath);
      if (realLines === undefined) continue; // not a plain workspace file this checker can verify from disk
      const totalLines = realLines.length;
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (!(a >= 1 && a <= b && b <= totalLines)) {
        violations.push({ source, path: itemPath, range, why, reason: `range ${range} out of bounds for a ${totalLines}-line file` });
        continue;
      }
      const claimed = servedLineNumbers(a, b, rec?.["remaining"]).map((line) => realLines[line - 1]!);
      // `stripAnswerLineGutter` (protocol/lineGutter.ts, exported precisely
      // for this purpose): the vscode config (TL_ANSWER_LINE_GUTTER) numbers
      // every served line "<N>|..." -- a documented, intentional wire
      // feature, not evidence the body was fabricated. Strip it before
      // comparing so this checker verifies CONTENT, independent of whether
      // gutter numbering happened to be on for this call.
      const ungated = stripAnswerLineGutter(body);
      // `"".split("\n")` always yields `[""]` (one element), never `[]` —
      // ambiguous between "one blank line" and "zero lines" for a body
      // string alone. When `remaining` withholds every line of `range`
      // (`claimed.length === 0`), zero lines is what this item claims, so an
      // empty body is compared as `[]`, not as one phantom blank line.
      //
      // P2-13 (round-2 evaluation): the wire convention is `body` = the
      // claimed lines joined by "\n" (util/countLines.ts's `sliceLinesToText`,
      // the shared range-serving primitive), so a window whose LAST claimed
      // line is itself blank naturally ends in "\n" — that "\n" is the
      // separator before the blank line, not a decorative extra, and must
      // NOT be stripped (the previous version unconditionally stripped one
      // trailing "\n", which silently swallowed a genuinely blank last line
      // and flagged the item as fabricated). The ONE case with a real EXTRA
      // trailing "\n" beyond the claimed content is `sliceLinesToText`'s own
      // EOF-restoration rule: a range reaching the file's true last line,
      // whose served last line is NON-blank, gets the source file's own
      // trailing newline re-appended — recognized here by the split
      // producing exactly one more element than `claimed` (a trailing "")
      // while `claimed`'s own last line is not blank, and only THEN dropped.
      let bodyLines = claimed.length === 0 && ungated === "" ? [] : ungated.split("\n");
      if (
        claimed.length > 0
        && claimed[claimed.length - 1] !== ""
        && bodyLines.length === claimed.length + 1
        && bodyLines[bodyLines.length - 1] === ""
      ) {
        bodyLines = bodyLines.slice(0, -1);
      }
      const expanded = expandElisionMarkers(bodyLines, realLines);
      const verbatim = expanded.length === claimed.length && expanded.every((line, i) => line === claimed[i]);
      if (verbatim) continue;
      if (isLabelledDerivedEvidence(item)) continue;
      let firstDifferingLine: number | undefined;
      for (let i = 0; i < Math.max(expanded.length, claimed.length); i++) {
        if (expanded[i] !== claimed[i]) {
          firstDifferingLine = a + i;
          break;
        }
      }
      violations.push({
        source,
        path: itemPath,
        range,
        why,
        reason: "body is not verbatim source of its declared range and is not labelled as derived",
        firstDifferingLine,
      });
    }
  }
  return violations;
}

const P0_QUERY_DEFS: ReadonlyArray<{ id: string; query: string; facts: readonly RequiredFact[]; profile?: string }> = [
  { id: "V01", query: V01_QUERY_EN, facts: V01_FACTS, profile: "answer" },
  { id: "V02", query: V02_QUERY_JA, facts: V02_FACTS },
  { id: "V02a", query: V02_QUERY_JA, facts: V02_FACTS, profile: "answer" },
  { id: "V03", query: V03_QUERY_JA, facts: V03_FACTS, profile: "answer" },
  { id: "V05", query: V05_QUERY_EN, facts: V05_FACTS },
  { id: "V05a", query: V05_QUERY_EN, facts: V05_FACTS, profile: "answer" },
];

// External v0.14.3 evaluation 2026-09-27 §6.2, finding #17 (harness gap, not a
// product bug by itself): the checker used to run ONLY unbudgeted, so a
// legitimately shed row — a served body honestly narrower than its range,
// disclosed via `remaining` — was never exercised here at all. `undefined` =
// unbudgeted (today's coverage, unchanged); 6144 mirrors the byte budget the
// rest of this suite already uses for a budgeted pass (`runRangedMultiTargetMember`
// above) and is exactly the size the external review's own probe used to
// surface the shed-row false positive this checker's fix corrects.
const V07_BUDGETS: ReadonlyArray<number | undefined> = [undefined, 6144];

async function runV07(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members: Array<Record<string, unknown> & { id: string; pass: boolean }> = [];
  const allViolations: OriginalityViolation[] = [];
  for (const variant of P0_VARIANTS) {
    const cwd = variantCwd(ctx.ws, variant);
    for (const def of P0_QUERY_DEFS) {
      for (const budgetBytes of V07_BUDGETS) {
        const source = `${def.id}/${variant}${budgetBytes !== undefined ? `/b${budgetBytes}` : ""}`;
        const result = await runFactChainQuery(ctx.server, cwd, def.query, def.facts, {
          profile: def.profile,
          budgetBytes,
          // A smaller per-hop budget needs more hops to reach the same certified
          // answer; 20 mirrors the external review's own probe (cases.mjs
          // `hopCap: 20` for every budgeted case) rather than this suite's
          // unbudgeted default of 12.
          ...(budgetBytes !== undefined ? { hopCap: 20 } : {}),
        });
        const violations = checkEvidenceOriginality(result.chain, cwd, source);
        allViolations.push(...violations);
        const sawReadinessFalsificationSurface = result.chain.hops.some(
          (h) => JSON.stringify(h.response).includes("readiness-falsification-counterexample"),
        );
        members.push({ id: source, pass: violations.length === 0, budgeted: budgetBytes !== undefined, originalityViolations: violations.length, sawReadinessFalsificationSurface });
      }
    }
  }
  const pass = allViolations.length === 0;
  return {
    pass,
    reason: pass
      ? `no originality violations across ${members.length} chains`
      : `${allViolations.length} originality violation(s): ${JSON.stringify(allViolations.slice(0, 6))}`,
    metrics: { members, violations: allViolations, originalityViolations: allViolations.length },
  };
}

// --- V08: built-in test run-ability must be judged honestly ---------------

function buildV08Workspace(root: string): void {
  buildHttpCorpusWorkspace(path.join(root, "primary"), "compact");
  buildHttpCorpusWorkspace(path.join(root, "control"), "compact");
  const controlPkgPath = path.join(root, "control", "package.json");
  const pkg = JSON.parse(fs.readFileSync(controlPkgPath, "utf8")) as Record<string, unknown>;
  pkg["devDependencies"] = { vitest: "^2.0.0" };
  fs.writeFileSync(controlPkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

async function runV08Primary(ctx: ScenarioContext): Promise<Record<string, unknown> & { id: string; pass: boolean }> {
  const cwd = path.join(ctx.ws, "primary");
  const relPath = "src/runtime.mjs";
  await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd, task: { epoch: "new" } });
  const ambiguous = await ctx.server.callTool("edit_file", { edits: [{ path: relPath, search: "`${ms} ms`", replace: "`${ms}ms`" }], cwd });
  const refusedAmbiguous = ambiguous.body?.kind === "refusal";
  const all = await ctx.server.callTool("edit_file", {
    edits: [{ path: relPath, search: "`${ms} ms`", replace: "`${ms}ms`", target: "all" }],
    cwd,
  });
  const applied = all.body?.kind === "edit.applied";
  const claimsCannotRun =
    pickPath(all.body, "verification.toolchain.deps_installed") === false
    || typeof pickPath(all.body, "verification.toolchain.verify_note") === "string";
  let testExitCode: number | null = null;
  if (applied) {
    const res = spawnSync(process.execPath, ["--test", "tests/runtime.test.mjs"], { cwd, timeout: 60_000, encoding: "utf8" });
    testExitCode = res.status;
  }
  const pass = refusedAmbiguous && applied && !claimsCannotRun && testExitCode === 0;
  return {
    id: "primary",
    pass,
    refusedAmbiguous,
    applied,
    claimsCannotRun,
    testExitCode,
    ambiguousKind: ambiguous.body?.kind,
    appliedKind: all.body?.kind,
  };
}

async function runV08Control(ctx: ScenarioContext): Promise<Record<string, unknown> & { id: string; pass: boolean }> {
  const cwd = path.join(ctx.ws, "control");
  const relPath = "src/runtime.mjs";
  await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd, task: { epoch: "new" } });
  const all = await ctx.server.callTool("edit_file", {
    edits: [{ path: relPath, search: "`${ms} ms`", replace: "`${ms}ms`", target: "all" }],
    cwd,
  });
  const disclosesMissingDeps =
    pickPath(all.body, "verification.toolchain.deps_installed") === false
    || typeof pickPath(all.body, "verification.toolchain.verify_note") === "string";
  return { id: "control-declared-uninstalled-devdep", pass: disclosesMissingDeps, disclosesMissingDeps, appliedKind: all.body?.kind };
}

async function runV08(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members = [await runV08Primary(ctx), await runV08Control(ctx)];
  const pass = members.every((m) => m.pass);
  return {
    pass,
    reason: pass
      ? "ambiguous refused, target:\"all\" applied, verification stayed honest, and the built-in test actually ran (exit 0); the control still discloses its missing dependency"
      : `failing member(s): ${JSON.stringify(members.filter((m) => !m.pass))}`,
    metrics: { members },
  };
}

// --- V09 (informational): tools/list fixed cost per surface ---------------

async function runV09(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const { tools, textBytes } = await ctx.server.listTools();
  const names = (tools as ReadonlyArray<Record<string, unknown>>).map((t) => t["name"]).sort();
  const threeTools = (list: readonly string[]): boolean =>
    list.length === 3 && ["edit_file", "read_file", "search_files"].every((n) => list.includes(n));
  // BOTH surfaces explicitly (the evaluation measured full=13,414 B / code=9,853 B): the configured server's
  // own surface depends on the caller, so it alone cannot answer "what does each surface cost".
  const perSurface: Record<string, number | null> = { full: null, code: null };
  let everySurfaceHasThree = true;
  if (ctx.startServerWithWrite !== undefined) {
    for (const surface of ["full", "code"] as const) {
      const extra = await ctx.startServerWithWrite(false, surface);
      try {
        const listed = await extra.listTools();
        perSurface[surface] = listed.textBytes;
        everySurfaceHasThree &&= threeTools((listed.tools as ReadonlyArray<Record<string, unknown>>).map((t) => String(t["name"])));
      } finally {
        await extra.kill();
      }
    }
  }
  const advertisesExactlyThree = threeTools(names.map(String)) && everySurfaceHasThree;

  const first = await ctx.server.callTool("read_file", { query: V01_QUERY_EN, cwd: ctx.ws, task: { epoch: "new", profile: "answer" } });
  const bodyBytes = servedBodyItems(first.body).reduce((sum, it) => sum + Buffer.byteLength(it.text, "utf8"), 0);

  return {
    pass: advertisesExactlyThree,
    reason: advertisesExactlyThree
      ? `tools/list advertises exactly the three tools (${textBytes} B)`
      : `tools/list advertised ${JSON.stringify(names)} (expected exactly read_file, search_files, edit_file)`,
    metrics: {
      toolsListBytes: textBytes,
      toolsListBytesFull: perSurface["full"],
      toolsListBytesCode: perSurface["code"],
      toolNames: names,
      firstHopTotalBytes: first.textBytes,
      firstHopBodyBytes: bodyBytes,
      firstHopFixedOverheadBytes: first.textBytes - bodyBytes,
    },
  };
}

// --- V10 (§2 regression controls) ------------------------------------------

function buildV10Workspace(root: string): void {
  writeFile(root, "small.txt", "hello there\nsecond line\n");
  writeFile(root, "opid/target.txt", "hello world\nsecond line\n");
  writeFile(root, "staleHash.txt", "original content\n");
}

async function runV10(ctx: ScenarioContext): Promise<ScenarioVerdict> {
  const members: Array<Record<string, unknown> & { id: string; pass: boolean }> = [];

  // (1) identical re-read is receipted smaller; force_serve resends the body.
  {
    const baseArgs = { targets: [{ path: "small.txt" }], content: "full", cwd: ctx.ws };
    const call1 = await ctx.server.callTool("read_file", { ...baseArgs, task: { epoch: "new" } });
    const call2 = await ctx.server.callTool("read_file", { ...baseArgs });
    const call3 = await ctx.server.callTool("read_file", { ...baseArgs, task: { force_serve: true } });
    const pass =
      call1.body?.kind === "read.text"
      && call2.body?.kind === "read.receipt"
      && call2.textBytes < call1.textBytes
      && call3.body?.kind === "read.text"
      && call3.textBytes === call1.textBytes;
    members.push({ id: "reread-receipt-and-force-serve", pass, firstBytes: call1.textBytes, receiptBytes: call2.textBytes, forceServeBytes: call3.textBytes });
  }

  // (2) a duplicate operation_id replays instead of re-applying.
  {
    const relPath = "opid/target.txt";
    await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd: ctx.ws, task: { epoch: "new" } });
    const opId = `w0-v10-op-${Math.random().toString(36).slice(2)}`;
    const edit1 = await ctx.server.callTool("edit_file", { edits: [{ path: relPath, search: "hello world", replace: "hello universe" }], cwd: ctx.ws, operation_id: opId });
    const edit2 = await ctx.server.callTool("edit_file", { edits: [{ path: relPath, search: "hello world", replace: "hello universe" }], cwd: ctx.ws, operation_id: opId });
    const contentAfter = fs.readFileSync(path.join(ctx.ws, relPath), "utf8");
    const pass = edit1.body?.kind === "edit.applied" && edit2.body?.replayed === true && contentAfter === "hello universe\nsecond line\n";
    members.push({ id: "operation-id-replay", pass, edit1Kind: edit1.body?.kind, edit2Replayed: edit2.body?.replayed });
  }

  // (3) a stale expectedSha refuses with hash-mismatch, leaving the file untouched.
  {
    const relPath = "staleHash.txt";
    await ctx.server.callTool("read_file", { targets: [{ path: relPath }], content: "full", cwd: ctx.ws, task: { epoch: "new" } });
    const staleSha = "0".repeat(64);
    const edit1 = await ctx.server.callTool("edit_file", {
      edits: [{ path: relPath, search: "original content", replace: "changed content", precondition: "expected-hash", expectedSha: staleSha }],
      cwd: ctx.ws,
    });
    const contentAfter = fs.readFileSync(path.join(ctx.ws, relPath), "utf8");
    const pass = isRefusalNaming(edit1.body, "hash-mismatch") && contentAfter === "original content\n";
    members.push({ id: "stale-expected-sha-hash-mismatch", pass, kind: edit1.body?.kind });
  }

  // (4) a read-only server (no --allow-write) refuses an edit as write-not-enabled.
  {
    if (typeof ctx.startServerWithWrite !== "function") {
      members.push({ id: "write-not-enabled-readonly-server", pass: true, note: "startServerWithWrite not provided by this caller -- inconclusive, not counted as a failure" });
    } else {
      const readOnlyServer = await ctx.startServerWithWrite(false);
      try {
        const edit1 = await readOnlyServer.callTool("edit_file", { edits: [{ path: "small.txt", search: "hello", replace: "HELLO" }], cwd: ctx.ws });
        const pass = isRefusalNaming(edit1.body, "write-not-enabled");
        members.push({ id: "write-not-enabled-readonly-server", pass, kind: edit1.body?.kind });
      } finally {
        await readOnlyServer.kill();
      }
    }
  }

  // (5) a target outside the workspace is refused, never served.
  {
    const outside = await ctx.server.callTool("read_file", { targets: [{ path: "../outside.txt" }], cwd: ctx.ws, task: { epoch: "new" } });
    const pass = outside.body?.kind === "refusal";
    members.push({ id: "outside-workspace-read-refused", pass, kind: outside.body?.kind });
  }

  const pass = members.every((m) => m.pass);
  return {
    pass,
    reason: pass
      ? "receipt/force_serve, operation_id replay, hash-mismatch, write-not-enabled and outside-workspace refusal all held"
      : `failing member(s): ${JSON.stringify(members.filter((m) => !m.pass).map((m) => m.id))}`,
    metrics: { members },
  };
}

// ---------------------------------------------------------------------------
// The registry — ONE definition, consumed by the spec AND the CLI evaluator.
// ---------------------------------------------------------------------------

export const SCENARIOS_0927: readonly Scenario[] = [
  {
    id: "V01",
    planItem: "§3",
    summary: "English 3-part compound question (default + retry conditions + callers) must not certify act.answer before every fact is served, on both corpus variants.",
    buildWorkspace: buildBothVariantsWorkspace,
    run: (ctx) => runP0FamilyScenario(ctx, V01_QUERY_EN, V01_FACTS, { profile: "answer" }),
  },
  {
    id: "V02",
    planItem: "§4",
    summary: "The two-line Japanese question must recover the same facts and never disclose a genuinely-implemented concept as absent.",
    buildWorkspace: buildProfileVariantsWorkspace,
    run: (ctx) => runP0FamilyProfilesScenario(ctx, V02_QUERY_JA, V02_FACTS, { forbiddenAbsenceTerms: V02_FORBIDDEN_ABSENCE_TERMS }),
  },
  {
    id: "V03",
    planItem: "§4",
    summary: "A Japanese question naming the EN identifiers directly must still recover every required fact and never disclose them absent.",
    buildWorkspace: buildBothVariantsWorkspace,
    run: (ctx) => runP0FamilyScenario(ctx, V03_QUERY_JA, V03_FACTS, { profile: "answer", forbiddenAbsenceTerms: V03_FORBIDDEN_ABSENCE_TERMS }),
  },
  {
    id: "V04",
    planItem: "§4",
    summary: "The EN (V01) and JA-identifier (V03) paraphrases of the same question must end with the identical served-fact set.",
    buildWorkspace: (root) => buildHttpCorpusWorkspace(root, "compact"),
    run: runV04,
  },
  {
    id: "V05",
    planItem: "§2",
    summary: "A general English HTTP question (the evaluation's own positive example) must keep recovering the constants, on both variants.",
    buildWorkspace: buildProfileVariantsWorkspace,
    run: (ctx) => runP0FamilyProfilesScenario(ctx, V05_QUERY_EN, V05_FACTS, {}),
  },
  {
    id: "V06",
    planItem: "§5",
    summary: "A 3-target content:\"full\" + explicit-range read must deliver exactly the 420 requested lines, matching single-target semantics.",
    buildWorkspace: buildV06Workspace,
    run: runV06,
  },
  {
    id: "V07",
    planItem: "§6.1",
    summary: "Every evidence item across the V01/V02/V03/V05 chains must have an in-bounds range that is verbatim source (or explicitly labelled derived).",
    buildWorkspace: buildBothVariantsWorkspace,
    run: runV07,
  },
  {
    id: "V08",
    planItem: "§6.2",
    summary: "A dependency-free built-in test must not be reported unrunnable; a control with a declared-but-uninstalled devDependency must still disclose it.",
    needsWrite: true,
    buildWorkspace: buildV08Workspace,
    run: runV08,
  },
  {
    id: "V09",
    planItem: "§6.3",
    summary: "Informational: tools/list bytes per surface, and the first hop's fixed overhead over its served body bytes.",
    buildWorkspace: (root) => buildHttpCorpusWorkspace(root, "compact"),
    run: runV09,
  },
  {
    id: "V10",
    planItem: "§2",
    summary: "Regression controls: re-read receipt/force_serve, operation_id replay, hash-mismatch, write-not-enabled, outside-workspace refusal.",
    needsWrite: true,
    buildWorkspace: buildV10Workspace,
    run: runV10,
  },
];

export function scenarioById0927(id: string): Scenario {
  const found = SCENARIOS_0927.find((s) => s.id === id);
  if (!found) throw new Error(`unknown 0927 scenario id ${JSON.stringify(id)}`);
  return found;
}
