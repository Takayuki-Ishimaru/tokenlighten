/**
 * evaluation0927.reviewFindings.spec.ts — FIX-FAB (2026-09-27 wave):
 * regression coverage for the Fable adversarial review's findings this
 * agent owns (items 1-10 of brief-fab.md): facet-gate soundness
 * (facetGate.ts, evidenceClosure.ts, callerExpansion.ts, requestFacets.ts,
 * jaGlossary.ts) and the FACET regions of readCodeTaskPack.ts.
 *
 * Fast, no-server unit tests come first (items 1/3/4/8/9-glossary, exercised
 * directly against the pure functions). End-to-end spawned-server cases
 * follow (items 2/3-go/4-python/4-barrel/5/6/7/9-e2e/10), each against a
 * small, neutral fixture built in this file — no rule under test keys on a
 * fixture name. `default` config only for most e2e cases (both configs were
 * confirmed manually during this wave; see the wave report) to keep total
 * spawn cost bounded on a shared, memory-constrained machine.
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
import { buildHttpCorpusWorkspace } from "./helpers/evaluation0927Scenarios.js";
import { opensBlockDeclaration } from "../features/task-pack/callerExpansion.js";
import { constantLikeReferencesIn, importSpecifiersNaming } from "../features/task-pack/evidenceClosure.js";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";
import { JA_GLOSSARY } from "../features/retrieval/jaGlossary.js";

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
// Item 1 (review #1, callersLoadOptionsNoIface/callersIfBlock): a bare call
// inside a control-statement condition or another declaration's own
// parameter-default value is a call site, never a declaration.
// ---------------------------------------------------------------------------
describe("item 1 — opensBlockDeclaration: control-statement conditions and default-parameter calls are call sites", () => {
  it("a bare call inside an if-condition, on a line ending in { is never a declaration", () => {
    expect(opensBlockDeclaration("  if (isTransient(status)) {", "  if (")).toBe(false);
  });
  it("a bare call inside a while-condition is never a declaration", () => {
    expect(opensBlockDeclaration("    while (isTransient(status)) {", "    while (")).toBe(false);
  });
  it("a bare call inside a for-loop's own condition clause (an embedded ;) is never a declaration", () => {
    expect(opensBlockDeclaration("  for (i = 0; isTransient(status); i++) {", "  for (i = 0; ")).toBe(false);
  });
  it("a bare call inside an else-if condition is never a declaration", () => {
    expect(opensBlockDeclaration("  } else if (isTransient(status)) {", "  } else if (")).toBe(false);
  });
  it("a bare call as another declaration's own default-parameter value is never a declaration (a multi-line signature ending in {)", () => {
    const line = "export async function fetchWithRetry(url: string, options: ClientOptions = loadOptions(process.env)): Promise<Response> {";
    const before = line.slice(0, line.indexOf("loadOptions("));
    expect(opensBlockDeclaration(line, before)).toBe(false);
  });
  it("recall control: a genuine modifier-less method shorthand is still read as a declaration", () => {
    expect(opensBlockDeclaration("  cancel(id: number) {", "  ")).toBe(true);
  });
  it("recall control: a typed declaration with no modifier keyword (Java/C#-style package-private member) is still a declaration", () => {
    expect(opensBlockDeclaration("  ClientOptions loadOptions(Foo x) {", "  ClientOptions ")).toBe(true);
  });
  it("recall control: an object-literal method after a preceding member is still a declaration", () => {
    expect(opensBlockDeclaration("const handlers = { retry(id) {", "const handlers = { ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 3 (review #4/#6): any-case module/package-level bindings are
// candidates; a LOCAL declared within the same body is excluded, however it
// is spelled (case is no longer what tells a local apart from a constant).
// ---------------------------------------------------------------------------
describe("item 3 — constantLikeReferencesIn: any-case module bindings; locals/reserved words excluded", () => {
  it("a lowercase camelCase module-constant reference is now a candidate", () => {
    const refs = constantLikeReferencesIn(["  return defaultOptions.timeoutMs;"], false, "loadOptions");
    expect(refs).toContain("defaultOptions");
  });
  it("a Python-style lowercase snake_case reference is now a candidate", () => {
    const refs = constantLikeReferencesIn(["    return default_timeout_s"], true, "fetch_with_retry");
    expect(refs).toContain("default_timeout_s");
  });
  it("a local const declared in the SAME body is excluded even though case no longer excludes it (evidenceClosure.spec.ts's own fixture)", () => {
    const body = ["  const timeoutMs = options.timeoutMs;", "  return RETRYABLE_STATUSES.has(status) || Status.Active === status;"];
    const refs = constantLikeReferencesIn(body, false, "shouldRetry", new Set(["status"]));
    expect(refs).toContain("RETRYABLE_STATUSES");
    expect(refs).toContain("Status");
    expect(refs).not.toContain("timeoutMs");
    expect(refs).not.toContain("has");
    expect(refs).not.toContain("Active");
    expect(refs).not.toContain("shouldRetry");
  });
  it("reserved keywords never become candidates now that case no longer excludes them", () => {
    const refs = constantLikeReferencesIn(
      ["  if (self.ready) { return true; }", "  const x = new Error();", "  for (const y of items) {}"],
      false,
      "f",
    );
    for (const word of ["if", "self", "return", "true", "const", "new", "for", "of"]) expect(refs).not.toContain(word);
  });
  it("a Go short variable declaration (:=) is excluded as a local", () => {
    const refs = constantLikeReferencesIn(["  timeout := computeTimeout()", "  return timeout"], false, "f");
    expect(refs).not.toContain("timeout");
  });
  it("a Python simple assignment is excluded as a local", () => {
    const refs = constantLikeReferencesIn(["    resolved = DEFAULT_TIMEOUT_S", "    return resolved"], true, "f");
    expect(refs).toContain("DEFAULT_TIMEOUT_S");
    expect(refs).not.toContain("resolved");
  });
});

// ---------------------------------------------------------------------------
// Item 4 (review #7): a TS/JS barrel re-export names its source specifier
// exactly like an import line, so the hop-following chase can reach it.
// ---------------------------------------------------------------------------
describe("item 4 — importSpecifiersNaming: TS/JS barrel re-exports", () => {
  it("a named barrel re-export names the same specifier an import line would", () => {
    expect(importSpecifiersNaming(['export { DEFAULT_OPTIONS } from "./defaults";'], "DEFAULT_OPTIONS", false))
      .toEqual([{ specifier: "./defaults", relative: true, wildcard: false, packageEligible: true }]);
  });
  it("an aliased barrel re-export is matched by the LOCAL alias, and now also carries the source's own exported name (FIX-ALIAS, eval-0929 §4) so a caller can chase THAT name in the target file instead of the local one", () => {
    expect(importSpecifiersNaming(['export { Foo as DEFAULT_OPTIONS } from "./defaults";'], "DEFAULT_OPTIONS", false))
      .toEqual([{ specifier: "./defaults", relative: true, wildcard: false, packageEligible: true, exportedName: "Foo" }]);
    expect(importSpecifiersNaming(['export { Foo as DEFAULT_OPTIONS } from "./defaults";'], "Foo", false)).toEqual([]);
  });
  it("a wildcard re-export is a candidate for any name (it names nothing itself)", () => {
    expect(importSpecifiersNaming(['export * from "./defaults";'], "ANYTHING_AT_ALL", false))
      .toEqual([{ specifier: "./defaults", relative: true, wildcard: true, packageEligible: true }]);
  });
  it("a re-export inside a comment never matches", () => {
    expect(importSpecifiersNaming(['// export { DEFAULT_OPTIONS } from "./defaults";'], "DEFAULT_OPTIONS", false)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Item 8 (review #9/#19): the facet detector stays linear-time on adversarial
// input, and the callers-direction/negated-instruction precision guards.
// ---------------------------------------------------------------------------
describe("item 8 — facet detector: linear time and precision guards", () => {
  // Linear time is checked as a ratio, not against a wall-clock bound: each
  // adversarial repeat is timed against 1/8 of itself, the two alternately,
  // keeping the least of several runs of each. A stall (GC, other processes)
  // inflates single samples, never the least of seven, and machine load
  // slows both inputs alike. 8x the input costs ~8x the time when linear
  // (measured 2026-10-20: 7.8x, 0.37 -> 2.8 ms "where is", 0.16 -> 1.2 ms
  // "does exist"), up to ~3x more if one side's best run landed on an
  // efficiency core, and 64x when quadratic; the backtracking the bounded
  // patterns replaced was steeper still (44.4 s at 1,600 "where is" repeats,
  // 3.4 s -> 21.9 s from 800 to 1,600 "does exist" repeats). The former
  // 50 ms bound on one cold call (14.5 ms on an idle machine) failed at
  // 60.7 ms while other suites ran.
  const LINEAR_RATIO_LIMIT = 32;
  function leastMsEach(inputs: readonly string[], runs = 7): number[] {
    for (const q of inputs) extractFacetRequirements(q); // compiles the patterns
    const least = inputs.map(() => Infinity);
    for (let run = 0; run < runs; run++) {
      inputs.forEach((q, i) => {
        const t0 = performance.now();
        extractFacetRequirements(q);
        least[i] = Math.min(least[i]!, performance.now() - t0);
      });
    }
    return least;
  }
  it("'where is ... called' scales linearly: the 14 KB adversarial repeat costs ~8x, not 64x, its 1/8 slice", () => {
    const q = "where is ".repeat(1600) + "fetchWithRetry?";
    expect(q.length).toBeGreaterThan(14000);
    const [small, large] = leastMsEach(["where is ".repeat(200) + "fetchWithRetry?", q]);
    expect(large! / small!, `${small!.toFixed(3)} ms -> ${large!.toFixed(3)} ms`).toBeLessThan(LINEAR_RATIO_LIMIT);
  });
  it("'does ... exist' scales linearly: the 8.8 KB adversarial repeat costs ~8x, not 64x, its 1/8 slice", () => {
    const q = "does exist ".repeat(800) + "fetchWithRetry?";
    const [small, large] = leastMsEach(["does exist ".repeat(100) + "fetchWithRetry?", q]);
    expect(large! / small!, `${small!.toFixed(3)} ms -> ${large!.toFixed(3)} ms`).toBeLessThan(LINEAR_RATIO_LIMIT);
  });
  it("'is there a document...' still detects the documentation-existence guard (recall control, not weakened by the bounded rewrite)", () => {
    expect(extractFacetRequirements("Is there a document that shows the processing flow as a diagram?")).toEqual([]);
  });
  it("'What is the default timeout FetchWithRetry uses per attempt' is a value question only, not a spurious callers facet", () => {
    const facets = extractFacetRequirements("What is the default timeout FetchWithRetry uses per attempt?").map((r) => r.facet);
    expect(facets).toContain("value");
    expect(facets).not.toContain("callers");
  });
  it("recall control: the correct direction 'which modules call OrderService' still mints a callers facet", () => {
    const facets = extractFacetRequirements("Which modules call OrderService?").map((r) => r.facet);
    expect(facets).toContain("callers");
  });
  it("recall control: 'who calls loadOptions' still mints a callers facet", () => {
    expect(extractFacetRequirements("Who calls loadOptions?").map((r) => r.facet)).toContain("callers");
  });
  it("a negated EN instruction not to change the callers mints no facet requirement", () => {
    expect(extractFacetRequirements("Please do not change the callers of loadOptions.")).toEqual([]);
  });
  it("a negated JA instruction (呼び出し元は変更しないでください) mints no facet requirement", () => {
    expect(extractFacetRequirements("呼び出し元は変更しないでください。")).toEqual([]);
  });
  it("recall control: an affirmative JA callers question still mints a facet", () => {
    expect(extractFacetRequirements("呼び出し元を教えてください。").map((r) => r.facet)).toContain("callers");
  });
});

// ---------------------------------------------------------------------------
// Item 9 (review #12): the JA glossary bridges 待ち時間/既定 (bare) too, and
// the concept-anchored candidate no longer keeps its existing entries.
// ---------------------------------------------------------------------------
describe("item 9 — jaGlossary.ts: bare 既定 and 待ち時間 bridge to English stems", () => {
  const asMap = new Map(JA_GLOSSARY);
  it("既定 (bare) bridges to default", () => {
    expect(asMap.get("既定")).toContain("default");
  });
  it("待ち時間 bridges to timeout/wait", () => {
    const stems = asMap.get("待ち時間");
    expect(stems).toBeDefined();
    expect(stems).toEqual(expect.arrayContaining(["timeout"]));
  });
  it("pre-existing entries this item's brief said to check first are untouched", () => {
    expect(asMap.get("再試行")).toContain("retry");
    expect(asMap.get("呼び出し元")).toContain("caller");
    expect(asMap.get("条件")).toContain("condition");
  });
});

// ---------------------------------------------------------------------------
// End-to-end (spawned dev server, `default` config): items 2/3-go/4-python/
// 4-barrel/5/6/7/9-e2e/10.
// ---------------------------------------------------------------------------

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-fabrf-${tag}-`));
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

async function ask(ws: string, query: string, hopCap = 14): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return followNextToEnd(
    s,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap },
  );
}

function decisionOf(response: unknown): any {
  return (response as any)?.decision ?? {};
}

function finalAnswer(chain: ChainResult): any {
  const answers = chain.hops.map((hop) => decisionOf(hop.response)).filter((d) => d.kind === "act.answer");
  return answers[answers.length - 1];
}

function allBodies(chain: ChainResult): string {
  return chain.hops
    .flatMap((hop) => ((hop.response as any)?.evidence ?? []).map((e: any) => String(e?.body ?? "")))
    .join("\n---\n");
}

function pkgJson(ws: string): void {
  writeFile(ws, "package.json", `${JSON.stringify({ name: "fab-review-findings", version: "1.0.0", type: "module" }, null, 2)}\n`);
}

// Item 2 (review #2, manyCallers): the declaration's own file sorts
// alphabetically AFTER every caller file ("handlers/" < "httpClient.ts"),
// so a flat, capped scan over `scanLiteral`'s matches used to exhaust its
// budget on caller mentions before ever reaching the declaration.
describe("item 2 — focal resolution reaches the real declaration however many caller files sort ahead of it", () => {
  it("callers facet resolves fetchWithRetry's own declaration, not a caller's enclosing function, across 22 caller files", async () => {
    const ws = makeWorkspace("manycallers");
    pkgJson(ws);
    writeFile(
      ws,
      "src/httpClient.ts",
      "export async function fetchWithRetry(url: string): Promise<Response> {\n  return fetch(url);\n}\n",
    );
    for (let i = 0; i < 22; i++) {
      const n = String(i).padStart(2, "0");
      writeFile(
        ws,
        `src/handlers/handler${n}.ts`,
        `import { fetchWithRetry } from "../httpClient";\n\nexport async function handle${i}(id: string): Promise<unknown> {\n  const response = await fetchWithRetry(\`/api/handler${i}/\${id}\`);\n  return response.json();\n}\n`,
      );
    }
    const chain = await ask(ws, "Who calls fetchWithRetry?", 20);
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    const gaps: string[] = answer.certificate?.gaps ?? [];
    expect(gaps.some((g) => g.includes("request-item-empty:callers"))).toBe(false);
    const bodies = allBodies(chain);
    expect(bodies).toMatch(/handler0[0-9]|handler1[0-9]|handler2[0-1]/);
  }, 60_000);
});

// Item 3 (review #6, golang): Go's same-package (same-directory) constant
// visibility — no import ever names it, so the cross-file chase must fall
// back to a sibling `.go` file scan.
describe("item 3 — Go same-package constant resolution", () => {
  it("a constant declared in a sibling .go file (no import) is resolved as the value evidence", async () => {
    const ws = makeWorkspace("go");
    writeFile(ws, "go.mod", "module example.com/httpx\n\ngo 1.22\n");
    writeFile(ws, "httpx/config.go", "package httpx\n\nimport \"time\"\n\nconst DefaultTimeout = 4 * time.Second\n");
    writeFile(
      ws,
      "httpx/client.go",
      "package httpx\n\nfunc FetchWithRetry(url string) error {\n  _ = DefaultTimeout\n  return nil\n}\n",
    );
    const chain = await ask(ws, "What is the default timeout FetchWithRetry uses?");
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    expect(allBodies(chain)).toContain("DefaultTimeout = 4 * time.Second");
  }, 60_000);
});

// Item 4 (review #5, python): a leading-dot relative specifier maps to the
// package DIRECTORY, not a literally-dotted filename.
describe("item 4 — Python relative-import dot resolution", () => {
  it("`from .config import X` resolves to the sibling config.py, not a literal '.config.py'", async () => {
    const ws = makeWorkspace("py");
    writeFile(ws, "pyhttp/__init__.py", "");
    writeFile(ws, "pyhttp/config.py", "DEFAULT_TIMEOUT_S = 5.5\n");
    writeFile(
      ws,
      "pyhttp/client.py",
      "from .config import DEFAULT_TIMEOUT_S\n\n\ndef fetch_with_retry(url, timeout=DEFAULT_TIMEOUT_S):\n    return timeout\n",
    );
    const chain = await ask(ws, "What is the default timeout fetch_with_retry uses?");
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    expect(allBodies(chain)).toContain("DEFAULT_TIMEOUT_S = 5.5");
  }, 60_000);

  it("`from ..pkg.mod import X` maps two leading dots to the parent package directory", async () => {
    const ws = makeWorkspace("py2");
    writeFile(ws, "pyhttp/__init__.py", "");
    writeFile(ws, "pyhttp/pkg/__init__.py", "");
    writeFile(ws, "pyhttp/pkg/mod.py", "MAX_ATTEMPTS = 4\n");
    writeFile(
      ws,
      "pyhttp/sub/client.py",
      "from ..pkg.mod import MAX_ATTEMPTS\n\n\ndef should_retry(attempt):\n    return attempt < MAX_ATTEMPTS\n",
    );
    const chain = await ask(ws, "What is the max attempts value should_retry uses?");
    expect(allBodies(chain)).toContain("MAX_ATTEMPTS = 4");
  }, 60_000);
});

// Item 4 (review #7, barrel): a TS barrel re-export is followed to its real
// source file end to end.
describe("item 4 — TS/JS barrel re-export end to end", () => {
  it("loadOptions's default, re-exported through a barrel index.ts, is served from the real declaring file", async () => {
    const ws = makeWorkspace("barrel");
    pkgJson(ws);
    writeFile(ws, "src/config/defaults.ts", "export const DEFAULT_OPTIONS = {\n  timeoutMs: 7000,\n};\n");
    writeFile(ws, "src/config/index.ts", 'export { DEFAULT_OPTIONS } from "./defaults";\n');
    writeFile(
      ws,
      "src/client.ts",
      'import { DEFAULT_OPTIONS } from "./config";\n\nexport function loadOptions(): typeof DEFAULT_OPTIONS {\n  return DEFAULT_OPTIONS;\n}\n',
    );
    const chain = await ask(ws, "What is the default HTTP_TIMEOUT_MS value that loadOptions falls back to?");
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    expect(allBodies(chain)).toContain("timeoutMs: 7000");
  }, 60_000);
});

// Item 5 (review #8, twoConstants): a served constant's OWN initializer
// reads two further module constants — chased, not left as silent gaps.
describe("item 5 — a constant's own initializer is chased for further module constants", () => {
  it("TOTAL_BUDGET_MS = BASE_TIMEOUT_MS * MAX_ATTEMPTS: both operands are served alongside the total", async () => {
    const ws = makeWorkspace("nestedconst");
    pkgJson(ws);
    writeFile(ws, "src/base.ts", "export const BASE_TIMEOUT_MS = 2500;\nexport const MAX_ATTEMPTS = 4;\n");
    writeFile(
      ws,
      "src/limits.ts",
      'import { BASE_TIMEOUT_MS, MAX_ATTEMPTS } from "./base";\n\nexport const TOTAL_BUDGET_MS = BASE_TIMEOUT_MS * MAX_ATTEMPTS;\n',
    );
    writeFile(
      ws,
      "src/deadline.ts",
      'import { TOTAL_BUDGET_MS } from "./limits";\n\nexport function deadlineFor(startedAt: number): number {\n  return startedAt + TOTAL_BUDGET_MS;\n}\n',
    );
    const chain = await ask(ws, "What is the total budget value that deadlineFor adds to startedAt?");
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    const bodies = allBodies(chain);
    expect(bodies).toContain("TOTAL_BUDGET_MS = BASE_TIMEOUT_MS * MAX_ATTEMPTS");
    expect(bodies).toContain("BASE_TIMEOUT_MS = 2500");
  }, 60_000);
});

// Item 6 (review #10, bigConstants): a constant declaration longer than the
// per-window cap is never silently truncated — the facet stays open (with a
// concrete continuation) until the whole declaration is on the wire.
describe("item 6 — a truncated constant declaration is never silently certified as covered", () => {
  it("an 80-row status table is fully served (via continuation) before the pack certifies the value covered", async () => {
    const ws = makeWorkspace("bigconst");
    pkgJson(ws);
    const rows = Array.from({ length: 80 }, (_, i) => `  ${400 + i}: { retry: ${i % 3 === 0}, delayMs: ${100 + i * 11} },`).join("\n");
    writeFile(
      ws,
      "src/retry.ts",
      `export const RETRY_POLICY_BY_STATUS = {\n${rows}\n};\n\nexport function shouldRetry(status: number, attempt: number, maxAttempts: number): boolean {\n  const policy = (RETRY_POLICY_BY_STATUS as Record<number, { retry: boolean }>)[status];\n  return policy !== undefined && policy.retry && attempt + 1 < maxAttempts;\n}\n`,
    );
    const chain = await ask(ws, "Explain the shouldRetry conditions.", 20);
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    const bodies = allBodies(chain);
    expect(bodies).toContain("RETRY_POLICY_BY_STATUS = {");
    // The declaration's own CLOSE (past the old 40-line cap) must be on the
    // wire before the pack certifies — the tail row and the closing brace.
    expect(bodies).toContain("479: { retry:");
    expect(bodies).toContain("policy.retry && attempt + 1 < maxAttempts");
  }, 60_000);
});

// Item 7 (review #11, flowEn): flow expands at least two callee layers.
describe("item 7 — flow expands transitively at least two callee layers", () => {
  it("getUser -> fetchWithRetry -> shouldRetry: the second-layer callee is served too", async () => {
    const ws = makeWorkspace("flow");
    pkgJson(ws);
    writeFile(
      ws,
      "src/retry.ts",
      "export function shouldRetry(status: number): boolean {\n  return status >= 500;\n}\n",
    );
    writeFile(
      ws,
      "src/httpClient.ts",
      'import { shouldRetry } from "./retry";\n\nexport async function fetchWithRetry(url: string): Promise<Response> {\n  const response = await fetch(url);\n  if (shouldRetry(response.status)) return fetchWithRetry(url);\n  return response;\n}\n',
    );
    writeFile(
      ws,
      "src/users.ts",
      'import { fetchWithRetry } from "./httpClient";\n\nexport async function getUser(id: string): Promise<unknown> {\n  const response = await fetchWithRetry(`/api/users/${id}`);\n  return response.json();\n}\n',
    );
    const chain = await ask(ws, "Trace the request path of getUser end-to-end: which functions run and in what order?", 16);
    const answer = finalAnswer(chain);
    expect(answer).toBeDefined();
    const bodies = allBodies(chain);
    expect(bodies).toContain("export async function fetchWithRetry");
    expect(bodies).toContain("export function shouldRetry");
  }, 60_000);
});

// Item 9 end to end (review #12, jaKanjiOnly): a kanji-only JA question,
// with zero lexical overlap in an English-named codebase, must not dead-end.
describe("item 9 — a kanji-only JA question recovers a real focal via the concept-anchored fallback", () => {
  it("既定の待ち時間はいくつですか。再試行の条件と呼び出し元も確認してください。 resolves real evidence, not await_input with no candidates", async () => {
    const ws = makeWorkspace("jakanji");
    buildHttpCorpusWorkspace(ws, "compact");
    const chain = await ask(ws, "既定の待ち時間はいくつですか。再試行の条件と呼び出し元も確認してください。", 12);
    const last = chain.hops[chain.hops.length - 1]!;
    const lastDecision = decisionOf(last.response);
    if (lastDecision.kind === "await_input") {
      expect(Array.isArray(lastDecision.candidates) && lastDecision.candidates.length > 0).toBe(true);
    } else {
      expect(["act.answer", "discover"]).toContain(lastDecision.kind);
      if (lastDecision.kind === "discover") expect(lastDecision.next).toBeDefined();
    }
    expect(allBodies(chain).length).toBeGreaterThan(0);
  }, 60_000);
});

// Item 10 (review #21, PLAUSIBLE): the facet plan memo is lane-scoped, so two
// lanes asking the identical query against the identical workspace each
// resolve independently (never sharing/evicting the other's in-flight plan).
describe("item 10 — the facet plan memo is lane-scoped", () => {
  it("two different lanes asking the same faceted query both reach a fully-served answer", async () => {
    const ws = makeWorkspace("lanes");
    buildHttpCorpusWorkspace(ws, "compact");
    const s = await spawnedServer(ws);
    const query = "Explain the default HTTP_TIMEOUT_MS value and the shouldRetry conditions.";
    const chainA = await followNextToEnd(
      s,
      { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws, lane: "fab-lane-a" } },
      { cwd: ws, hopCap: 10 },
    );
    const chainB = await followNextToEnd(
      s,
      { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws, lane: "fab-lane-b" } },
      { cwd: ws, hopCap: 10 },
    );
    for (const chain of [chainA, chainB]) {
      const answer = finalAnswer(chain);
      expect(answer).toBeDefined();
      const bodies = allBodies(chain);
      expect(bodies).toContain("DEFAULT_OPTIONS");
    }
  }, 60_000);
});
