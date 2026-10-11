/**
 * independentReview0151.spec.ts — the independent v0.15.1 runtime review
 * (2026-10-06, `TokenLighten_v0.15.1_評価レポート.md`).
 *
 * The reviewer drove the v0.15.1 server over stdio against TokenLighten's own
 * VS Code extension sources and synthetic TypeScript/Python/CommonJS fixtures.
 * Its findings, each kept here as the reviewer's own call shape plus
 * variants:
 *
 *   TL-REVIEW-1 (high)  "Explain the save debounce duration and watched
 *         languages of WorkspaceWatcher in src/watcher.ts." was certified
 *         `act.answer` with the class body only — DEBOUNCE_MS = 5000 and
 *         WATCHED_LANGUAGES (lines 15-19) never served, no gap, no next.
 *   TL-REVIEW-2 (high)  comment projection broke body/source-range fidelity —
 *         independentReview0151.lineFidelity.spec.ts.
 *   TL-REVIEW-3 (medium) 「http.ts の retry 関数について…」 asked the caller to
 *         choose between http.ts and the settings.ts constants retry reads,
 *         and the four-file reproduction asked it to choose http.ts as the
 *         ONE candidate.
 *   TL-REVIEW-4 (low)   端数処理 was disclosed as an undetermined source term
 *         beside a pack that served `Math.floor(...)`.
 *   TL-REVIEW-5 (low)   a `discover` followed by its own bundle `next` ended in
 *         `read.receipt`/`pack-unchanged` with no decision at all.
 *
 * plus the defects the fixes exposed: "<value> used by <callable>" read as a
 * callers question, a package namespace reached only through its members
 * (`https.get`, `vscode.workspace`) disclosed as a missing value, "including
 * same-file callers" bound to an unrelated subject, a bare basename two roots
 * share answered from one of them silently, and a TypeScript method with a
 * declared return type not counted as a callable body.
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { TaskExecutionContract } from "@tokenlighten/types";

import {
  REVIEW_0151_JA_FILES,
  REVIEW_0151_SYNTHETIC_FILES,
  reviewUpdateCheckerFiles,
  reviewWatcherFiles,
} from "./helpers/independentReview0151Fixture.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";
import { hasValuePositionOccurrence } from "../features/task-pack/evidenceClosure.js";
import { isSupportingEvidenceWhy } from "../features/task-pack/canonicalDecision.js";
import { projectTaskDecision } from "../protocol/decisionWire.js";

const HOME = os.homedir();
const dirs: string[] = [];
const servers: ServerHandle[] = [];

afterAll(async () => {
  for (const server of servers) await server.kill();
  for (const dir of dirs) await rmDirWithRetry(dir);
});

function workspace(files: Readonly<Record<string, string>>): string {
  const base = fs.realpathSync(shortTmpDir(HOME, ".tl-review0151-"));
  dirs.push(base);
  const ws = path.join(base, "workspace");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function start(ws: string): Promise<ServerHandle> {
  const server = startDevServer(ws, "default", { toolSurface: "full" });
  servers.push(server);
  await server.initialize();
  return server;
}

/** A fresh workspace and server; the first call, then each decision's own `next` up to `hops` times (the reviewer's `read_chain`). */
async function chain(
  files: Readonly<Record<string, string>>,
  first: Record<string, unknown>,
  hops = 3,
): Promise<any[]> {
  const server = await start(workspace(files));
  const responses = [(await server.callTool("tl_read_file", first)).body];
  for (let i = 0; i < hops; i += 1) {
    const next = responses[responses.length - 1]?.decision?.next;
    if (next === undefined || typeof next.tool !== "string") break;
    responses.push((await server.callTool(next.tool, next.arguments)).body);
  }
  return responses;
}

const ask = (query: string): Record<string, unknown> => ({ query, task: { epoch: "new", profile: "answer" } });

/** Every served evidence body across `responses`, joined. */
function bodies(responses: readonly any[]): string {
  return responses
    .flatMap((response) => (response?.evidence ?? []) as Array<{ body?: string }>)
    .map((entry) => entry.body ?? "")
    .join("\n");
}

function gapsOf(response: any): string[] {
  return (response?.decision?.certificate?.gaps ?? []) as string[];
}

const brief = (responses: readonly any[]): string => JSON.stringify(responses.map((response) => ({
  kind: response?.kind,
  decision: response?.decision,
  evidence: (response?.evidence ?? []).map((e: any) => `${e.path}:${e.range} ${e.why ?? ""}${e.body === undefined ? " (no body)" : ""}`),
}))).slice(0, 2400);

const WATCHER_QUERY = "Explain the save debounce duration and watched languages of WorkspaceWatcher in src/watcher.ts.";
const JA_RETRY_QUERY = "http.ts の retry 関数について、タイムアウトの値、最大試行回数、再試行するステータスコードを説明してください。";
const RETRY_VALUES = ["export const BASE_TIMEOUT_MS = 7300;", "export const RETRY_LIMIT = 4;", "export const RETRY_STATUS_CODES = [408, 429, 503];"];

describe("TL-REVIEW-1 — a class served whole carries the module values its methods read", () => {
  it("the reviewer's WorkspaceWatcher question serves DEBOUNCE_MS and WATCHED_LANGUAGES before act.answer", async () => {
    const responses = await chain(reviewWatcherFiles(), ask(WATCHER_QUERY), 0);
    const [first] = responses;
    expect(first?.decision?.kind, brief(responses)).toBe("act.answer");
    const text = bodies(responses);
    expect(text, brief(responses)).toContain("const DEBOUNCE_MS = 5000;");
    expect(text, brief(responses)).toContain("const WATCHED_LANGUAGES = new Set([");
    expect(text).toContain("export class WorkspaceWatcher {");
    // `vscode` (a package namespace used through its members) is no missing value.
    expect(gapsOf(first), brief(responses)).toEqual([]);
    const whys = (first.evidence as Array<{ why?: string }>).map((entry) => entry.why ?? "");
    expect(whys).toContain("closure:value DEBOUNCE_MS (read by WorkspaceWatcher)");
    expect(whys).toContain("closure:value WATCHED_LANGUAGES (read by WorkspaceWatcher)");
  }, 120_000);

  it("Japanese, paraphrased and behavioural forms of the question keep both values", async () => {
    for (const query of [
      "src/watcher.ts の WorkspaceWatcher について、保存時のデバウンス時間と監視対象の言語を説明してください。",
      "What debounce delay and which languages does WorkspaceWatcher in src/watcher.ts use?",
      "How does WorkspaceWatcher in src/watcher.ts decide which documents to track?",
    ]) {
      const responses = await chain(reviewWatcherFiles(), ask(query));
      expect(responses[responses.length - 1]?.decision?.kind, `${query}: ${brief(responses)}`).toBe("act.answer");
      const text = bodies(responses);
      expect(text, `${query}: ${brief(responses)}`).toContain("const DEBOUNCE_MS = 5000;");
      expect(text, `${query}: ${brief(responses)}`).toContain("const WATCHED_LANGUAGES = new Set([");
    }
  }, 240_000);

  it("a Python class, and a TypeScript class reading an imported constant through typed methods", async () => {
    const python = await chain({
      "poller.py": "POLL_SECONDS = 30\nMAX_BACKOFF = 300\n\n\nclass Poller:\n    def __init__(self, client):\n        self.client = client\n\n    def wait(self, attempt):\n        return min(POLL_SECONDS * (2 ** attempt), MAX_BACKOFF)\n",
    }, ask("Explain the polling interval and backoff cap of Poller in poller.py."), 0);
    expect(python[0]?.decision?.kind, brief(python)).toBe("act.answer");
    expect(bodies(python), brief(python)).toContain("POLL_SECONDS = 30");
    expect(bodies(python), brief(python)).toContain("MAX_BACKOFF = 300");

    // Every method declares a return type: before the fix `behavior-body`
    // found no callable body in the served class, and the `discover` it left
    // ended in a bare range read of the import lines with no decision.
    const scanner = {
      "limits.ts": "export const MAX_FILES = 250;\n",
      "scanner.ts": "import { MAX_FILES } from \"./limits\";\n\nexport class WorkspaceScanner {\n  scan(paths: string[]): string[] {\n    return paths.slice(0, MAX_FILES);\n  }\n}\n",
    };
    for (const query of [
      "Explain how many files WorkspaceScanner in scanner.ts scans.",
      "Explain the file limit of WorkspaceScanner in scanner.ts.",
    ]) {
      const responses = await chain(scanner, ask(query), 0);
      expect(responses[0]?.decision?.kind, `${query}: ${brief(responses)}`).toBe("act.answer");
      expect(bodies(responses), `${query}: ${brief(responses)}`).toContain("export const MAX_FILES = 250;");
    }
  }, 240_000);

  it("a question that only locates the class chases no values", async () => {
    const responses = await chain(reviewWatcherFiles(), ask("Where is WorkspaceWatcher defined?"), 0);
    expect(responses[0]?.decision?.kind, brief(responses)).toBe("act.answer");
    const whys = (responses[0].evidence as Array<{ why?: string }>).map((entry) => entry.why ?? "");
    expect(whys.filter((why) => why.startsWith("closure:")), brief(responses)).toEqual([]);
  }, 120_000);
});

describe("TL-REVIEW-3 — a named file and function are the target; their supporting files are no rival", () => {
  it("reproduce.py's four-file Japanese case certifies in one call with all three values", async () => {
    const responses = await chain(REVIEW_0151_JA_FILES, ask(JA_RETRY_QUERY), 0);
    expect(responses[0]?.decision?.kind, brief(responses)).toBe("act.answer");
    for (const value of RETRY_VALUES) expect(bodies(responses), brief(responses)).toContain(value);
    expect(bodies(responses)).toContain("export async function retry(url: string): Promise<Response> {");
  }, 120_000);

  it("the thirteen-file fixture: the Japanese question and its English forms certify in one call", async () => {
    for (const [query, values] of [
      [JA_RETRY_QUERY, RETRY_VALUES],
      ["Explain the retry function in http.ts.", []],
      ["Explain the timeout, maximum retries, and retryable status codes of retry in http.ts.", RETRY_VALUES],
    ] as const) {
      const responses = await chain(REVIEW_0151_SYNTHETIC_FILES, ask(query), 0);
      expect(responses[0]?.decision?.kind, `${query}: ${brief(responses)}`).toBe("act.answer");
      expect(bodies(responses)).toContain("export async function retry(url: string): Promise<Response> {");
      for (const value of values) expect(bodies(responses), `${query}: ${brief(responses)}`).toContain(value);
    }
  }, 240_000);

  it("the reviewer's explicit-target workaround still certifies", async () => {
    const responses = await chain(REVIEW_0151_SYNTHETIC_FILES, { ...ask(JA_RETRY_QUERY), targets: [{ path: "http.ts" }] });
    expect(responses.length, brief(responses)).toBeLessThanOrEqual(2);
    expect(responses[responses.length - 1]?.decision?.kind, brief(responses)).toBe("act.answer");
    for (const value of RETRY_VALUES) expect(bodies(responses), brief(responses)).toContain(value);
  }, 120_000);

  it("a basename two roots share is never silently one of them", async () => {
    const twoRetries = {
      "a/http.ts": "import { RETRY_LIMIT } from \"./settings\";\nexport function retry() { return RETRY_LIMIT; }\n",
      "a/settings.ts": "export const RETRY_LIMIT = 4;\n",
      "b/http.ts": "import { RETRY_LIMIT } from \"./settings\";\nexport function retry() { return RETRY_LIMIT * 2; }\n",
      "b/settings.ts": "export const RETRY_LIMIT = 9;\n",
    };
    // A plain-word subject over the shared name: the answer either covers
    // both files or says which one it served and that the name matches two.
    for (const query of ["http.ts の retry 関数について、最大試行回数を説明してください。", "Explain the retry function in http.ts."]) {
      const responses = await chain(twoRetries, ask(query));
      const last = responses[responses.length - 1];
      expect(last?.decision?.kind, `${query}: ${brief(responses)}`).toBe("act.answer");
      const text = bodies(responses);
      const coversBoth = text.includes("return RETRY_LIMIT;") && text.includes("return RETRY_LIMIT * 2;");
      const disclosed = gapsOf(last).some((gap) => gap.includes("http.ts names 2 files (a/http.ts, b/http.ts)"));
      expect(coversBoth || disclosed, `${query}: ${brief(responses)}`).toBe(true);
    }
    // An explicit identifier: the shared basename binds neither declaration;
    // both are served and the certificate names the ambiguity.
    const twoLimits = {
      "a/settings.ts": "export const RETRY_LIMIT = 4;\n",
      "b/settings.ts": "export const RETRY_LIMIT = 9;\n",
      "a/http.ts": "import { RETRY_LIMIT } from \"./settings\";\nexport function retryWithBackoff() { return RETRY_LIMIT; }\n",
    };
    const shared = await chain(twoLimits, ask("What is the value of RETRY_LIMIT in settings.ts?"));
    const sharedLast = shared[shared.length - 1];
    expect(sharedLast?.decision?.kind, brief(shared)).toBe("act.answer");
    expect(bodies(shared), brief(shared)).toContain("export const RETRY_LIMIT = 4;");
    expect(bodies(shared), brief(shared)).toContain("export const RETRY_LIMIT = 9;");
    expect(gapsOf(sharedLast).join("\n"), brief(shared)).toContain("RETRY_LIMIT is declared in 2 files (a/settings.ts, b/settings.ts)");
    // The path written out names one file: that one, and no disclosure.
    const named = await chain(twoLimits, ask("What is the value of RETRY_LIMIT in a/settings.ts?"));
    const namedLast = named[named.length - 1];
    expect(namedLast?.decision?.kind, brief(named)).toBe("act.answer");
    expect(bodies(named), brief(named)).toContain("export const RETRY_LIMIT = 4;");
    expect(bodies(named), brief(named)).not.toContain("export const RETRY_LIMIT = 9;");
    expect(gapsOf(namedLast), brief(named)).toEqual([]);
  }, 360_000);

  it("the wire never offers a supporting window, or one lone file, as a choice", () => {
    const contract = {
      version: 1,
      state: "needs-followup",
      readiness: "choose-candidate",
      discovery_complete: false,
      next_action: "request-user-input",
      max_additional_discovery_calls: 0,
      reason: "choose-candidate",
      await_input_code: "choose-candidate",
      typestate: { phase: "awaiting-input", allowed_actions: ["edit", "request-user-input"], challenge_required_for: [] },
    } as unknown as TaskExecutionContract;
    const surfaces = [
      { handle: "h1", path: "http.ts", range: "1-18", why: "answer-query-evidence-symbol-focus" },
      { handle: "h2", path: "settings.ts", range: "1-3", why: "closure:value MAX_RETRIES (read by retry)" },
      { handle: "h3", path: "app.ts", range: "1-7", why: "imports http.ts (readiness-falsification-counterexample)" },
      { handle: "h4", path: "billing.ts", range: "4-9", why: "answer-query-evidence-symbol-focus" },
    ];
    const evidence = surfaces.map(({ handle, path: p, range }) => ({ handle, path: p, range, body: "…" }));
    // Two genuine targets: a choice, between exactly those two.
    const choice = projectTaskDecision({ result: { coverage_reason: "candidate-list", surfaces }, contract, canonicalKind: "await-input", evidence });
    expect(choice?.kind).toBe("await_input");
    expect((choice as { candidates?: Array<{ path: string }> }).candidates?.map((candidate) => candidate.path)).toEqual(["http.ts", "billing.ts"]);
    // One target and its supporting windows, with a window still unserved:
    // nothing to choose between — fetch what is left instead.
    const single = projectTaskDecision({
      result: { coverage_reason: "candidate-list", surfaces: surfaces.slice(0, 3) },
      contract,
      canonicalKind: "await-input",
      evidence: [{ handle: "h1", path: "http.ts", range: "1-10", body: "…", remaining: ["11-18"] }, ...evidence.slice(1, 3)],
    });
    expect(single?.kind).toBe("discover");
    expect((single as { next?: { arguments?: Record<string, unknown> } }).next?.arguments).toEqual({ handle: "h1", range: "11-18" });
    expect(isSupportingEvidenceWhy("closure:callers retry")).toBe(true);
    expect(isSupportingEvidenceWhy("is imported by http.ts (readiness-falsification-counterexample)")).toBe(true);
    expect(isSupportingEvidenceWhy("answer-explicit-symbol-focus")).toBe(false);
    expect(isSupportingEvidenceWhy(undefined)).toBe(false);
  });
});

describe("TL-REVIEW-4 — rounding words describe the answer; they are no source term", () => {
  it("端数処理 and its relatives certify with no undetermined gap", async () => {
    for (const query of [
      "billing.ts の calculateTotal の金額計算と端数処理を説明してください。",
      "billing.ts の calculateTotal の丸め方と切り捨てを説明してください。",
      "billing.ts の calculateTotal は四捨五入しますか？端数の扱いを教えてください。",
      "Explain the rounding of calculateTotal in billing.ts.",
    ]) {
      const responses = await chain(REVIEW_0151_SYNTHETIC_FILES, ask(query));
      const last = responses[responses.length - 1];
      expect(last?.decision?.kind, `${query}: ${brief(responses)}`).toBe("act.answer");
      expect(bodies(responses)).toContain("return Math.floor(subtotal * (1 - discount) * (1 + TAX_RATE));");
      expect(gapsOf(last).join("\n"), `${query}: ${brief(responses)}`).not.toMatch(/端数|丸め|切り捨て|四捨五入|rounding/u);
    }
  }, 300_000);
});

describe("TL-REVIEW-5 — a re-pack that certifies over bytes the caller holds says act.answer", () => {
  // `src/` + `lib/` share `http.ts`, so the first pack cannot take the named
  // file as its target and ships the reviewer's `discover` + bundle `next`;
  // the bundle re-pack certifies over windows the first pack already served.
  const shared = {
    ...Object.fromEntries(Object.entries(REVIEW_0151_SYNTHETIC_FILES).map(([rel, content]) => [`src/${rel}`, content])),
    "lib/http.ts": "export function get(url: string): Promise<Response> {\n  return fetch(url);\n}\n",
  };
  const query = "Explain the timeout, maximum retries, and retryable status codes of retry in http.ts.";

  it("discover → its own next → act.answer, never a decision-less pack-unchanged", async () => {
    const server = await start(workspace(shared));
    const first = (await server.callTool("tl_read_file", ask(query))).body;
    expect(first?.decision?.kind, brief([first])).toBe("discover");
    for (const value of RETRY_VALUES) expect(bodies([first]), brief([first])).toContain(value);
    const next = first.decision.next;
    const second = (await server.callTool(next.tool, next.arguments)).body;
    expect(second?.kind, brief([first, second])).toBe("read.task_pack");
    expect(second?.decision?.kind, brief([first, second])).toBe("act.answer");
    // The windows the first pack served are restated, not re-sent.
    const restated = (second.evidence as Array<{ path?: string; prior?: string; body?: string }>)
      .filter((entry) => entry.path === "src/http.ts" || entry.path === "src/settings.ts");
    expect(restated.length, brief([first, second])).toBeGreaterThan(0);
    for (const entry of restated) {
      expect(entry.body, brief([first, second])).toBeUndefined();
      expect(typeof entry.prior, brief([first, second])).toBe("string");
    }
    // Once the decision is on the wire, the same re-pack is the compact receipt again.
    const third = (await server.callTool(next.tool, next.arguments)).body;
    expect(third?.kind, brief([third])).toBe("read.receipt");
    expect(third?.receipt?.receipt).toBe("pack-unchanged");
  }, 120_000);

  it("a byte cap's withheld row is never restated `prior`, and a partly served body is never re-sent", async () => {
    // The capped half: a pack that shipped `src/anchor.ts` without a body,
    // then a re-pack naming it — the old subset receipt said `prior` for
    // bytes no call had sent; now the re-pack ships them.
    const pricing: Record<string, string> = {};
    for (let module = 0; module < 8; module += 1) {
      const lines = [`// module ${module}: orderTotal pricing surface`];
      for (let fn = 0; fn < 40; fn += 1) {
        lines.push(`export function orderTotal_${module}_${fn}(qty: number, price: number): number {`, `  // pricing rule ${module}.${fn} for orderTotal`, `  return qty * price + ${fn};`, "}");
      }
      pricing[`src/pricing_${module}.ts`] = `${lines.join("\n")}\n`;
    }
    pricing["src/anchor.ts"] = "export function applyQuantityDiscount(x: number): number {\n  // orderTotal quantity discount anchor\n  return x;\n}\n";
    const capped = await start(workspace(pricing));
    const first = (await capped.callTool("tl_read_file", {
      query: "Update orderTotal pricing rules across the pricing modules so quantity discounts apply.",
      task: { profile: "generic", epoch: "new" },
      budget: { bytes: 6144 },
    })).body;
    const anchorRow = (first.evidence as Array<{ path?: string; body?: string }>).find((row) => row.path === "src/anchor.ts");
    expect(anchorRow?.body, brief([first])).toBeUndefined();
    const second = (await capped.callTool("tl_read_file", {
      query: "Update applyQuantityDiscount so orderTotal quantity discounts apply.",
      targets: [{ path: "src/anchor.ts" }],
      task: { profile: "generic" },
    })).body;
    const rows = (second.evidence ?? second.receipt?.evidence ?? []) as Array<{ path?: string; body?: string; prior?: string }>;
    const anchor = rows.find((row) => row.path === "src/anchor.ts");
    expect(anchor?.prior, brief([second])).toBeUndefined();
    expect(anchor?.body, brief([second])).toContain("return x;");

    // The partial half: a body too large to embed ships a slice; a re-ask
    // over the same surface must not send that slice again.
    const huge = ["export function targetCalculateRate(key: string): number {"];
    for (let i = 0; i < 600; i += 1) {
      huge.push(`  // body line ${i} of the huge calculateRate function — this single`, "  // function spans hundreds of lines so no per-surface cap can embed it whole.", `  if (key === "case-${i}") { return ${i}; }`);
    }
    huge.push("  return -1;", "}");
    const partial = await start(workspace({ "src/ratingEngine.ts": huge.join("\n") }));
    const seed = (await partial.callTool("tl_read_file", { query: "fix targetCalculateRate to use the provided key", targets: [{ path: "src/ratingEngine.ts" }] }));
    expect(bodies([seed.body]).length, brief([seed.body])).toBeGreaterThan(1000);
    const reask = (await partial.callTool("tl_read_file", {
      query: "please rewrite the rate calculation helper so unknown keys return a sentinel instead of -1",
      targets: [{ path: "src/ratingEngine.ts" }],
    }));
    expect(bodies([reask.body]), brief([reask.body])).toBe("");
    expect(reask.textBytes, brief([reask.body])).toBeLessThan(4096);
  }, 180_000);
});

describe("defects the fixes exposed", () => {
  it("'<value> used by <callable>' asks for the value, never for the callable's callers", async () => {
    const facets = (query: string): string[] => extractFacetRequirements(query).map((requirement) => requirement.facet);
    expect(facets("Explain the timeout and maximum response size used by fetchLatestRelease in src/updateChecker.ts.")).toEqual(["value"]);
    expect(facets("Which statuses are read by canRetry?")).not.toContain("callers");
    // Still callers: the user is the unknown.
    expect(facets("Which functions is parseConfig used by?")).toContain("callers");
    expect(facets("The timeout used by which modules?")).toContain("callers");
    expect(facets("Where is MAX_UPLOAD_SIZE used by the upload handler?")).toContain("callers");

    // The reviewer's real-source call: no callers obligation, no gap.
    const responses = await chain(reviewUpdateCheckerFiles(), ask("Explain the timeout and maximum response size used by fetchLatestRelease in src/updateChecker.ts."), 0);
    const first = responses[0];
    expect(first?.decision?.kind, brief(responses)).toBe("act.answer");
    expect(bodies(responses)).toContain("const RESPONSE_LIMIT_BYTES = 1024 * 1024;");
    expect(bodies(responses)).toContain("const REQUEST_TIMEOUT_MS = 8_000;");
    expect((first.decision.certificate.obligations as string[]).join(" "), brief(responses)).not.toMatch(/callers/u);
    expect(gapsOf(first), brief(responses)).toEqual([]);
  }, 120_000);

  it("a package namespace reached only through its members is no missing value", async () => {
    const lines = [
      "const request = https.get(url, (response) => resolve(response));",
      "const folders = vscode.workspace.workspaceFolders;",
      "const limit = TIMEOUT_MS;",
    ];
    expect(hasValuePositionOccurrence(lines, false, "https")).toBe(true);
    expect(hasValuePositionOccurrence(lines, false, "https", undefined, true)).toBe(false);
    expect(hasValuePositionOccurrence(lines, false, "vscode", undefined, true)).toBe(false);
    // A bare read of the alias itself still counts.
    expect(hasValuePositionOccurrence(["register(https);"], false, "https", undefined, true)).toBe(true);

    const responses = await chain({
      "src/fetcher.ts": [
        "import * as https from \"node:https\";",
        "",
        "const TIMEOUT_MS = 8000;",
        "const MAX_BODY_BYTES = 65536;",
        "",
        "export function fetchJson(url: string): Promise<string> {",
        "  return new Promise((resolve, reject) => {",
        "    const request = https.get(url, (response) => {",
        "      let body = \"\";",
        "      response.on(\"data\", (chunk) => {",
        "        body += chunk;",
        "        if (body.length > MAX_BODY_BYTES) request.destroy();",
        "      });",
        "      response.on(\"end\", () => resolve(body));",
        "    });",
        "    request.setTimeout(TIMEOUT_MS, () => request.destroy());",
        "    request.on(\"error\", reject);",
        "  });",
        "}",
        "",
      ].join("\n"),
    }, ask("Explain the timeout and maximum body size used by fetchJson in src/fetcher.ts."), 0);
    expect(responses[0]?.decision?.kind, brief(responses)).toBe("act.answer");
    expect(bodies(responses)).toContain("const TIMEOUT_MS = 8000;");
    expect(bodies(responses)).toContain("const MAX_BODY_BYTES = 65536;");
    expect(gapsOf(responses[0]), brief(responses)).toEqual([]);
  }, 120_000);

  it("a namespace a callee reads through its members is no missing value either (the dependency path)", async () => {
    // "default" makes this a value question, so the value facet's closure
    // follows WorkspaceWatcher's methods as callees; `isTracked` reads
    // `vscode.workspace.workspaceFolders`, and that read was disclosed "vscode
    // (read by isTracked in src/watcher.ts) could not be resolved" beside a
    // pack that served the whole file.
    const query = "What are the default debounce duration and watched languages of WorkspaceWatcher in src/watcher.ts?";
    const responses = await chain(reviewWatcherFiles(), ask(query), 0);
    const [first] = responses;
    expect(first?.decision?.kind, brief(responses)).toBe("act.answer");
    expect(first.decision.certificate.obligations, brief(responses)).toContain("request-item:facet-1:value");
    expect(bodies(responses)).toContain("const DEBOUNCE_MS = 5000;");
    expect(bodies(responses)).toContain("const WATCHED_LANGUAGES = new Set([");
    expect(gapsOf(first), brief(responses)).toEqual([]);

    // A constant-shaped member a callee reads through a package namespace is
    // still a value no served body holds, and is still disclosed.
    const callee = await chain({
      "src/poller.ts": [
        "import * as limits from \"@acme/limits\";",
        "",
        "function retryCap(): number {",
        "  return limits.MAX_RETRIES;",
        "}",
        "",
        "export function nextAttempt(attempt: number): number {",
        "  return Math.min(attempt + 1, retryCap());",
        "}",
        "",
      ].join("\n"),
    }, ask("What is the default retry limit used by nextAttempt in src/poller.ts?"), 0);
    expect(gapsOf(callee[callee.length - 1]).join(" "), brief(callee)).toMatch(/MAX_RETRIES|limits/u);
  }, 240_000);

  it("'including same-file callers' refines the callers facet instead of binding a subject of its own", async () => {
    const requirements = extractFacetRequirements("Explain retry and all of its callers, including same-file callers.");
    expect(requirements.map((requirement) => requirement.facet)).toEqual(["callers"]);
    expect(requirements[0]!.subjectTerms).toEqual(["retry"]);
    expect(extractFacetRequirements("retry の呼び出し元を、同じファイル内の呼び出し元も含めて説明してください。").map((requirement) => requirement.facet)).toEqual(["callers"]);
    // The qualifier IS the request when nothing asked for callers before it.
    expect(extractFacetRequirements("Explain retry, including its callers.").map((requirement) => requirement.facet)).toEqual(["callers"]);

    const responses = await chain(REVIEW_0151_SYNTHETIC_FILES, ask("Explain retry and all of its callers, including same-file callers."));
    const last = responses[responses.length - 1];
    expect(last?.decision?.kind, brief(responses)).toBe("act.answer");
    const text = bodies(responses);
    for (const caller of ["export async function loadInternalDashboard() {", "export async function loadProfile() {", "export async function loadFeed() {"]) {
      expect(text, brief(responses)).toContain(caller);
    }
    expect(gapsOf(last), brief(responses)).toEqual([]);
  }, 120_000);
});
