/**
 * evaluation0927.reviewFindingsR2ValuesFlowClosure.spec.ts — R3-A2 (round-3
 * wave, 2026-09-28): regression coverage for review-findings-fable-r2.md's
 * "values, flow, closure" findings — P0-3, P1-4, P1-5, P1-6, P1-8, P2-11,
 * P2-16. Each fixture below is written fresh against the DESCRIBED defect
 * class (never copied from the reviewer's own harness fixtures), so a fix
 * that only special-cases the reviewer's exact file/identifier names would
 * still fail here.
 *
 * Fast, no-server unit tests first (declarationRealExtent,
 * declarationIsCallable, salientWords' phrasing-idiom masking); spawned
 * dev-server end-to-end cases follow, one describe block per finding.
 *
 * P2-11(b)'s own describe block below was SUPERSEDED by round-4's P0-4
 * ruling (2026-09-28, see evidenceClosure.ts's own doc comment on
 * `declarationIsCallable`): the old "literal-like" filter excluded ANY
 * initializer with a non-allowlisted call, which wrongly dropped computed
 * constants (`parseInt(...)`), call-built objects (`defineConfig({...})`)
 * and objects with function-valued members from required VALUE windows. The
 * new rule excludes ONLY a binding that is itself CALLABLE (function/arrow/
 * class) — updated in place rather than deleted, since it is still the one
 * fast, no-server regression fence for this predicate's contract.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  extractNext,
  followNextToEnd,
  startDevServer,
  type ChainResult,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import {
  declarationIsCallable,
  declarationRealExtent,
  MAX_CLOSURE_BYTES_PER_PACK,
} from "../features/task-pack/evidenceClosure.js";
import { salientWords } from "../features/task-pack/requestItems.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r3a2-${tag}-`));
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

/** Anchors the primary surface on the query-matched symbol alone (matches evaluation0927.fab2FlowFacetClass.spec.ts's own `askWithTarget`) — a bare query lets the ordinary locator paginate the whole file regardless of the facet closure, masking a class-flow-specific defect. */
async function askWithTarget(ws: string, query: string, relPath: string, hopCap = 14): Promise<ChainResult> {
  const s = await spawnedServer(ws);
  return followNextToEnd(
    s,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, targets: [{ path: relPath }], cwd: ws } },
    { cwd: ws, hopCap },
  );
}

function allBodies(chain: ChainResult): string {
  return chain.hops
    .flatMap((hop) => ((hop.response as any)?.evidence ?? []).map((e: any) => String(e?.body ?? "")))
    .join("\n---\n");
}

function decisionOf(response: unknown): any {
  return (response as any)?.decision ?? {};
}

// ---------------------------------------------------------------------------
// P0-3 — Go same-package resolution lists the owner's directory, never a
// whole-workspace walk prefix.
// ---------------------------------------------------------------------------
describe("P0-3 — Go same-package constant resolution scopes to the owner's directory", () => {
  it("finds a sibling package constant even with 45 unrelated Go files sorting before it in the workspace", async () => {
    const ws = makeWorkspace("go-pkg");
    writeFile(ws, "go.mod", "module example.com/httpx2\n\ngo 1.22\n");
    for (let i = 0; i < 45; i++) {
      writeFile(ws, `aaa/pad${String(i).padStart(2, "0")}.go`, `package aaa\n\nfunc Pad${i}(n int) int {\n\treturn n * ${i}\n}\n`);
    }
    writeFile(
      ws,
      "httpx2/config.go",
      "package httpx2\n\nimport \"time\"\n\nconst DefaultTimeout = 4 * time.Second\n\nconst MaxAttempts = 3\n",
    );
    writeFile(
      ws,
      "httpx2/retry.go",
      "package httpx2\n\nvar retryableStatuses = map[int]bool{429: true, 503: true}\n\nfunc ShouldRetry(status int, attempt int) bool {\n\treturn retryableStatuses[status] && attempt+1 < MaxAttempts\n}\n",
    );
    writeFile(
      ws,
      "httpx2/client.go",
      "package httpx2\n\nimport (\n\t\"context\"\n\t\"net/http\"\n)\n\nfunc FetchWithRetry(ctx context.Context, url string) (*http.Response, error) {\n\tfor attempt := 0; ; attempt++ {\n\t\tctx, cancel := context.WithTimeout(ctx, DefaultTimeout)\n\t\tresp, err := http.DefaultClient.Do(mustRequest(ctx, url))\n\t\tcancel()\n\t\tif err == nil && !ShouldRetry(resp.StatusCode, attempt) {\n\t\t\treturn resp, nil\n\t\t}\n\t}\n}\n\nfunc mustRequest(ctx context.Context, url string) *http.Request {\n\treq, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)\n\treturn req\n}\n",
    );
    const chain = await ask(ws, "What is the default timeout FetchWithRetry uses, and which statuses does ShouldRetry retry?", 16);
    const bodies = allBodies(chain);
    expect(bodies).toContain("DefaultTimeout = 4 * time.Second");
    expect(bodies).toContain("retryableStatuses = map[int]bool{429: true, 503: true}");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P1-4 — ESM specifiers ending .js/.jsx/.mjs/.cjs also resolve to their TS
// source.
// ---------------------------------------------------------------------------
describe("P1-4 — a TS import specifier ending .js resolves to the .ts source file", () => {
  it("import ... from \"./config.js\" resolves to config.ts, not a nonexistent config.js", async () => {
    const ws = makeWorkspace("esm-js");
    writeFile(ws, "package.json", '{ "name": "esmr3a2", "private": true, "type": "module" }\n');
    writeFile(ws, "tsconfig.json", '{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }\n');
    writeFile(ws, "src/settings.ts", "export const DEFAULT_SETTINGS = {\n  retries: 5,\n  waitMs: 6200,\n};\n");
    writeFile(
      ws,
      "src/engine.ts",
      "import { DEFAULT_SETTINGS } from \"./settings.js\";\n\nexport function loadSettings(env: Record<string, string | undefined>) {\n  return { ...DEFAULT_SETTINGS, waitMs: Number(env.WAIT_MS ?? DEFAULT_SETTINGS.waitMs) };\n}\n",
    );
    const chain = await ask(ws, "What is the default waitMs value that loadSettings falls back to?", 12);
    expect(allBodies(chain)).toContain("waitMs: 6200");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P1-5 — a barrel with several `export *` re-exports is followed
// breadth-first: every sibling specifier is tried, not just the first that
// happens to resolve to a real file.
// ---------------------------------------------------------------------------
describe("P1-5 — a barrel's several export * re-exports are all tried before giving up", () => {
  it("the declaration is in the SECOND of two wildcard re-exports", async () => {
    const ws = makeWorkspace("barrel");
    writeFile(ws, "package.json", '{ "name": "barrelr3a2", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/opts/flags.ts",
      "export function isEnabled(env: Record<string, string | undefined>): boolean {\n  return env.FEATURE === \"1\";\n}\n",
    );
    writeFile(
      ws,
      "src/opts/values.ts",
      "export const DEFAULT_SETTINGS = {\n  retries: 5,\n  waitMs: 7300,\n};\n",
    );
    writeFile(ws, "src/opts/index.ts", "export * from \"./flags\";\nexport * from \"./values\";\n");
    writeFile(
      ws,
      "src/engine.ts",
      "import { DEFAULT_SETTINGS } from \"./opts\";\n\nexport function loadSettings(env: Record<string, string | undefined>) {\n  return { ...DEFAULT_SETTINGS, waitMs: Number(env.WAIT_MS ?? DEFAULT_SETTINGS.waitMs) };\n}\n",
    );
    const chain = await ask(ws, "What is the default waitMs value that loadSettings falls back to?", 12);
    expect(allBodies(chain)).toContain("waitMs: 7300");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P1-6 — a truncated constant's continuation targets the declaration's REAL
// extent, never literal EOF.
// ---------------------------------------------------------------------------
describe("P1-6 — a truncated constant's continuation stops at its real close, not EOF", () => {
  it("declarationRealExtent finds the real close of an 82-line declaration ahead of 100 unrelated padding lines", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `  ${400 + i}: { retry: ${i % 3 === 0} },`);
    const declaration = ["export const RETRY_POLICY_BY_STATUS = {", ...rows, "};"];
    const padding = Array.from({ length: 100 }, (_, i) => `export function pad${i}(): number {\n  return ${i};\n}`);
    const lines = [...declaration, ...padding].join("\n").split("\n");
    const win = declarationRealExtent(lines, 1, false);
    expect(win.end).toBe(declaration.length);
    expect(win.truncated).toBe(false);
  });

  it("a big declaration bigger than even the real-extent ceiling still reports truncated, never an out-of-bounds end", () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `  v${i}: ${i},`);
    const lines = ["export const HUGE = {", ...rows, "};"];
    const win = declarationRealExtent(lines, 1, false);
    expect(win.truncated).toBe(true);
    expect(win.end).toBeLessThan(lines.length);
  });

  it("end-to-end: the continuation never reads past the declaration's real close into unrelated padding", async () => {
    const ws = makeWorkspace("longtail");
    writeFile(ws, "package.json", '{ "name": "longtail", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/config.ts",
      "export const DEFAULT_SETTINGS = {\n  retries: 5,\n  waitMs: 8100,\n};\n\nexport function loadSettings(env: Record<string, string | undefined>) {\n  return { ...DEFAULT_SETTINGS, waitMs: Number(env.WAIT_MS ?? DEFAULT_SETTINGS.waitMs) };\n}\n",
    );
    const rows = Array.from({ length: 60 }, (_, i) => `  ${400 + i}: { retry: ${i % 3 === 0}, delayMs: ${100 + i * 11} },`);
    const padding = Array.from({ length: 150 }, (_, i) => `export function pad${i}(): number {\n  return ${i};\n}\n`).join("\n");
    writeFile(
      ws,
      "src/retry.ts",
      `export const RETRY_POLICY_BY_STATUS = {\n${rows.join("\n")}\n};\n\nexport function shouldRetry(status: number, attempt: number, maxAttempts: number): boolean {\n  const policy = (RETRY_POLICY_BY_STATUS as Record<number, { retry: boolean }>)[status];\n  return policy !== undefined && policy.retry && attempt + 1 < maxAttempts;\n}\n${padding}`,
    );
    writeFile(
      ws,
      "src/client.ts",
      "import { loadSettings } from \"./config\";\nimport { shouldRetry } from \"./retry\";\n\nexport async function fetchWithRetry(url: string): Promise<Response> {\n  const options = loadSettings(process.env);\n  for (let attempt = 0; ; attempt++) {\n    const response = await fetch(url, { signal: AbortSignal.timeout(options.waitMs) });\n    if (!shouldRetry(response.status, attempt, 5)) return response;\n  }\n}\n",
    );
    const declarationRealCloseLine = 1 + rows.length + 1; // "export const ...{" + rows + "};"
    // shouldRetry's own function body legitimately follows the declaration
    // (blank line + 4-line function) -- the ordinary named-symbol locator may
    // serve IT too, unrelated to the constant-continuation fix under test.
    const shouldRetryFunctionEndLine = declarationRealCloseLine + 1 + 4;
    const paddingStartsAtLine = shouldRetryFunctionEndLine + 1;
    const chain = await ask(ws, "Explain the default waitMs value and the shouldRetry conditions.", 10);
    // Never serve a line from the padding tail -- the EOF-reading bug would
    // have walked on into it within just a handful of hops given the file's
    // total size (declaration + shouldRetry + 150 padding functions).
    for (const hop of chain.hops) {
      for (const ev of (hop.response as any)?.evidence ?? []) {
        if (ev?.path !== "src/retry.ts" || typeof ev.range !== "string") continue;
        const m = /^(\d+)-(\d+)$/.exec(ev.range);
        if (!m) continue;
        expect(
          Number(m[2]),
          `hop served src/retry.ts:${ev.range}, into the padding tail starting at line ${paddingStartsAtLine}`,
        ).toBeLessThan(paddingStartsAtLine);
      }
    }
    expect(chain.capped).toBe(false);
    expect(chain.hops.length).toBeLessThanOrEqual(8);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P1-8 — a class-focal flow member counts as served when its span is covered
// by ANY served surface; the member cap limits what the closure ADDS, never
// what the gate accepts. Plus: phrasing idioms never become false absence
// disclosures.
// ---------------------------------------------------------------------------
describe("P1-8 — a class flow whose matching members exceed the old per-hop expansion cap, but are already fully served, is covered", () => {
  it("four matching members (constructor + three methods) served whole-file certify covered, no flow gap", async () => {
    const ws = makeWorkspace("classflow");
    writeFile(ws, "package.json", '{ "name": "classflowr3a2", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/OrderFlow.ts",
      [
        "export class OrderFlow {",
        "  constructor(private readonly shippingService: { requestLabel(): void }) {}",
        "",
        "  place(): void {",
        "    this.payment();",
        "    this.inventory();",
        "  }",
        "",
        "  private payment(): void {",
        "    console.log(\"charge\");",
        "  }",
        "",
        "  private inventory(): void {",
        "    console.log(\"reserve\");",
        "  }",
        "",
        "  fulfil(): void {",
        "    this.shippingService.requestLabel();",
        "    this.transition();",
        "  }",
        "",
        "  private transition(): void {",
        "    console.log(\"done\");",
        "  }",
        "}",
        // Module-level padding (unrelated top-level helpers) pushes the file
        // past MAX_FACET_FOCAL_LINES (80) -- matching the review's own
        // orderFlowTs fixture shape, so the class itself is never REQUIRED as
        // its own "focal" window (only its members/constants/callees are),
        // isolating the P1-8 member-completeness question from that
        // unrelated dimension.
        ...Array.from({ length: 14 }, (_, i) =>
          `\nexport function ofHelper${i}(items: number[]): number {\n  return items.reduce((sum, item) => sum + item * ${i}, ${i * 3});\n}\n`),
      ].join("\n") + "\n",
    );
    const chain = await askWithTarget(ws, "How does OrderFlow handle payment and shipping, step by step?", "src/OrderFlow.ts", 10);
    const last = chain.hops[chain.hops.length - 1]!;
    const decision = decisionOf(last.response);
    expect(decision.kind).toBe("act.answer");
    const gaps: string[] = decision.certificate?.gaps ?? [];
    expect(gaps.some((g) => g.includes("flow")), `unexpected flow gap: ${JSON.stringify(gaps)}`).toBe(false);
    const bodies = allBodies(chain);
    expect(bodies).toContain("this.payment();");
    expect(bodies).toContain("this.shippingService.requestLabel();");
  }, 60_000);
});

describe("P1-8b — phrasing idioms never become false absence disclosures", () => {
  it("masks the fixed idiom shapes but keeps the real subject/object words", () => {
    const words = salientWords("How does OrderFlow handle payment and shipping, step by step?");
    expect(words).not.toContain("step");
    expect(words.map((w) => w.toLowerCase())).not.toContain("handle");
    expect(words).toContain("OrderFlow");
    expect(words).toContain("payment");
    expect(words).toContain("shipping");
  });

  it("masks 'in its lifecycle' and 'in what order' too", () => {
    const a = salientWords("Explain how OrderFlow sequences payment, inventory and shipping in its lifecycle.");
    expect(a).not.toContain("lifecycle");
    expect(a).toContain("inventory");
    const b = salientWords("Trace fetchWithRetry end-to-end: which functions run and in what order?");
    expect(b.map((w) => w.toLowerCase())).not.toContain("order");
    expect(b).toContain("fetchWithRetry");
  });

  it("recall control: 'order' and 'handle' used as ordinary domain words OUTSIDE the fixed idioms stay searchable", () => {
    const words = salientWords("Explain the sort order used by the request handler cache.");
    expect(words.map((w) => w.toLowerCase())).toContain("order");
    expect(words.map((w) => w.toLowerCase())).toContain("handler");
  });
});

// ---------------------------------------------------------------------------
// P2-11(a) — closure over-serving: a window ships as its own declaration
// window (never promoted to a whole tiny file past the closure budget).
//
// P2-11(b) — SUPERSEDED by round-4's P0-4 (this file's own top-of-file note):
// a module binding is excluded from required VALUE windows only when it is
// itself CALLABLE (function/arrow/class); a computed constant, a call-built
// object, an object with a function-valued member, `new X(...)` and
// `require(...)` are all required value windows now.
// ---------------------------------------------------------------------------
describe("P0-4 — a module binding is a required VALUE unless it is itself callable", () => {
  it("object/number/boolean literals, Set(...)/Object.freeze(...), computed constants, call-built objects, new X(...) and require(...) are all NOT callable", () => {
    expect(declarationIsCallable(["export const DEFAULT_SETTINGS = {", "  waitMs: 8100,", "};"], false)).toBe(false);
    expect(declarationIsCallable(["export const RETRYABLE_STATUSES = new Set([408, 429, 503]);"], false)).toBe(false);
    expect(declarationIsCallable(["export const FROZEN = Object.freeze({ a: 1 });"], false)).toBe(false);
    expect(declarationIsCallable(["const DefaultTimeout = 4 * time.Second"], false)).toBe(false);
    expect(declarationIsCallable(["export const enum Status {", "  Active,", "  Inactive,", "}"], false)).toBe(false);
    // P0-4's own new coverage: a computed constant built by an arbitrary
    // call, an object built by a call, `new X(...)`, and `require(...)` are
    // all values now (the exact class of binding the old filter wrongly
    // excluded — computedConstTs/configByCallTs/pyComputedFloat/
    // goComputedDuration in the round-4 review harness).
    expect(declarationIsCallable(["const MAX_ATTEMPTS = parseInt(process.env.HTTP_MAX_ATTEMPTS ?? \"3\", 10);"], false)).toBe(false);
    expect(declarationIsCallable(["export const config = defineConfig({", "  timeoutMs: 6500,", "});"], false)).toBe(false);
    expect(declarationIsCallable(["const client = new HttpClient(baseUrl);"], false)).toBe(false);
    expect(declarationIsCallable(["const parseConfig = require(\"./configParser\");"], false)).toBe(false);
    // An object literal with a function-VALUED MEMBER is still a value: only
    // the binding's own top-level shape is tested, never a member deep
    // inside it (fnMemberObjectTs).
    expect(declarationIsCallable(["export const DEFAULT_OPTIONS = {", "  timeoutMs: 7200,", "  delayMs: (attempt) => 100 * attempt,", "};"], false)).toBe(false);
  });

  it("a function declaration/expression, an arrow function, a Python lambda, a Go function literal, and a class ARE callable", () => {
    expect(declarationIsCallable(["const loadOptions = (env) => {", "  return env;", "};"], false)).toBe(true);
    expect(declarationIsCallable(["export const shouldRetry = (status, attempt) => RETRYABLE_STATUSES.has(status) && attempt < 4;"], false)).toBe(true);
    expect(declarationIsCallable(["const handler = function (req) {", "  return req;", "};"], false)).toBe(true);
    expect(declarationIsCallable(["default_timeout = lambda: 5.5"], true)).toBe(true);
    expect(declarationIsCallable(["var handler = func(x int) int {", "\treturn x * 2", "}"], false)).toBe(true);
    expect(declarationIsCallable(["const Base = class {", "  run() {}", "};"], false)).toBe(true);
  });
});

describe("P2-11(a) — a closure window ships as its own declaration window, not a whole tiny file", () => {
  it("ten small imported constants stay small closure windows instead of ballooning into ten whole-file serves", async () => {
    const ws = makeWorkspace("fanin");
    writeFile(ws, "package.json", '{ "name": "faninr3a2", "private": true, "type": "module" }\n');
    const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
    for (const n of names) {
      const helpers = Array.from({ length: 14 }, (_, i) => `\nexport function ${n}Helper${i}(items: number[]): number {\n  return items.reduce((sum, item) => sum + item * ${i}, ${i * 3});\n}\n`).join("");
      writeFile(ws, `src/infra/${n}.ts`, `export const ${n} = {\n  name: "${n}",\n  enabled: true,\n  tags: ["a", "b"],\n  level: 1,\n};\n${helpers}`);
    }
    writeFile(
      ws,
      "src/config.ts",
      "export const DEFAULT_SETTINGS = {\n  retries: 5,\n  waitMs: 9100,\n};\n",
    );
    const usageLines = names.map((n) => `  if (${n}.enabled) console.log(${n}.name);`).join("\n");
    writeFile(
      ws,
      "src/client.ts",
      `${names.map((n) => `import { ${n} } from "./infra/${n}";`).join("\n")}\nimport { DEFAULT_SETTINGS } from "./config";\n\nexport async function fetchWithRetry(url: string): Promise<Response> {\n${usageLines}\n  const waitMs = Number(process.env.WAIT_MS ?? DEFAULT_SETTINGS.waitMs);\n  return fetch(url, { signal: AbortSignal.timeout(waitMs) });\n}\n`,
    );
    const chain = await ask(ws, "What is the default waitMs value fetchWithRetry falls back to?", 12);
    expect(allBodies(chain)).toContain("waitMs: 9100");
    // The whole chain's closure-shaped evidence for the ten tiny infra files
    // must stay small -- a whole-file promotion of even a handful of them
    // would already exceed MAX_CLOSURE_BYTES_PER_PACK on its own (each infra
    // file's whole body is ~60 lines including its own padding helpers).
    let infraBytes = 0;
    for (const hop of chain.hops) {
      for (const ev of (hop.response as any)?.evidence ?? []) {
        if (typeof ev?.path === "string" && ev.path.startsWith("src/infra/") && typeof ev.body === "string") {
          infraBytes += Buffer.byteLength(ev.body, "utf8");
        }
      }
    }
    expect(infraBytes).toBeLessThan(MAX_CLOSURE_BYTES_PER_PACK * 2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-16 — a facet `next` never targets lines this task already shipped.
// ---------------------------------------------------------------------------
describe("P2-16 — a facet next never re-targets lines an earlier hop of this task already shipped in full", () => {
  it("a budget-paged big constant never wastes a hop re-requesting an already-fully-served range", async () => {
    const ws = makeWorkspace("bigconst");
    writeFile(ws, "package.json", '{ "name": "bigconstr3a2", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/config.ts",
      "export interface ClientOptions {\n  waitMs: number;\n  retries: number;\n}\n\nexport const DEFAULT_SETTINGS: ClientOptions = {\n  waitMs: 9500,\n  retries: 6,\n};\n\nexport function loadSettings(env: Record<string, string | undefined>): ClientOptions {\n  return { ...DEFAULT_SETTINGS, waitMs: Number(env.WAIT_MS ?? DEFAULT_SETTINGS.waitMs) };\n}\n",
    );
    const rows = Array.from({ length: 80 }, (_, i) => `  ${400 + i}: { retry: ${i % 3 === 0}, delayMs: ${100 + i * 11} },`);
    writeFile(
      ws,
      "src/retry.ts",
      `export const RETRY_POLICY_BY_STATUS = {\n${rows.join("\n")}\n};\n\nexport function shouldRetry(status: number, attempt: number, maxAttempts: number): boolean {\n  const policy = (RETRY_POLICY_BY_STATUS as Record<number, { retry: boolean }>)[status];\n  return policy !== undefined && policy.retry && attempt + 1 < maxAttempts;\n}\n`,
    );
    writeFile(
      ws,
      "src/client.ts",
      "import { loadSettings } from \"./config\";\nimport { shouldRetry } from \"./retry\";\n\nexport async function fetchWithRetry(url: string): Promise<Response> {\n  const options = loadSettings(process.env);\n  for (let attempt = 0; ; attempt++) {\n    const response = await fetch(url, { signal: AbortSignal.timeout(options.waitMs) });\n    if (!shouldRetry(response.status, attempt, options.retries)) return response;\n  }\n}\n",
    );
    const s = await spawnedServer(ws);
    const chain = await followNextToEnd(
      s,
      {
        tool: "tl_read_file",
        arguments: {
          query: "Explain the default waitMs value and the shouldRetry conditions.",
          task: { epoch: "new", profile: "answer" },
          budget: { bytes: 6144 },
          cwd: ws,
        },
      },
      { cwd: ws, hopCap: 24 },
    );
    // Cumulative, per-path, of lines a body actually carried in an EARLIER hop.
    const shippedLines = new Map<string, Set<number>>();
    chain.hops.forEach((hop, i) => {
      const { next } = extractNext(hop.response);
      const targets = (next?.arguments as any)?.targets;
      if (Array.isArray(targets)) {
        for (const target of targets) {
          const range = target?.range;
          const targetPath = target?.path;
          if (typeof targetPath !== "string" || typeof range !== "string") continue;
          const m = /^(\d+)-(\d+)$/.exec(range);
          if (!m) continue;
          const already = shippedLines.get(targetPath);
          if (already === undefined) continue;
          let fullyCovered = true;
          for (let line = Number(m[1]); line <= Number(m[2]); line++) {
            if (!already.has(line)) { fullyCovered = false; break; }
          }
          expect(fullyCovered, `hop ${i}'s next re-requests ${targetPath}:${range}, already fully shipped by an earlier hop`).toBe(false);
        }
      }
      for (const ev of (hop.response as any)?.evidence ?? []) {
        if (typeof ev?.path !== "string" || typeof ev.body !== "string" || typeof ev.range !== "string") continue;
        const m = /^(\d+)-(\d+)$/.exec(ev.range);
        if (!m) continue;
        const set = shippedLines.get(ev.path) ?? new Set<number>();
        // A `remaining` sub-range inside this body was NOT actually shipped.
        const remaining: string[] = Array.isArray(ev.remaining) ? ev.remaining : [];
        const unshipped = new Set<number>();
        for (const r of remaining) {
          const rm = /^(\d+)-(\d+)$/.exec(String(r));
          if (!rm) continue;
          for (let line = Number(rm[1]); line <= Number(rm[2]); line++) unshipped.add(line);
        }
        for (let line = Number(m[1]); line <= Number(m[2]); line++) {
          if (!unshipped.has(line)) set.add(line);
        }
        shippedLines.set(ev.path, set);
      }
    });
  }, 60_000);
});
