/**
 * evaluation0927.reviewFindingsR3ValueClosure.spec.ts — R4-B (round-4 wave,
 * 2026-09-28): regression coverage for review-findings-fable-r3.md's value
 * closure findings — P0-4, P2-12, P2-16.
 *
 * Every fixture below is written FRESH against the DESCRIBED defect class
 * (different names, different files, different query wording from the
 * reviewer's own harness cases — computedConstTs/configByCallTs/
 * fnMemberObjectTs/pyComputedFloat/goComputedDuration/arrowCalleeCondition/
 * p0en/manyCallers in `$SCRATCH/review3/cases3.mjs`), so a fix that only
 * special-cases the reviewer's exact file/identifier names would still fail
 * here.
 *
 * Fast, no-server unit tests first (declarationIsCallable's own languages are
 * covered by evaluation0927.reviewFindingsR2ValuesFlowClosure.spec.ts's
 * updated P0-4 block; this file adds the NEW over-serving-guard unit
 * coverage `constantLikeReferencesIn` needs); spawned dev-server end-to-end
 * cases follow, one describe block per finding.
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
import { constantLikeReferencesIn } from "../features/task-pack/evidenceClosure.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r4b-${tag}-`));
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
    { tool: "read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
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

function gapRefs(response: unknown): string[] {
  const gaps = decisionOf(response).certificate?.gaps ?? decisionOf(response).gaps ?? [];
  const out: string[] = [];
  for (const g of gaps) {
    if (typeof g === "string") out.push(g);
    else if (Array.isArray(g?.refs)) out.push(...g.refs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// P0-4 unit coverage NOT already added to the R2 spec's declarationIsCallable
// block: the over-serving guard inside constantLikeReferencesIn.
// ---------------------------------------------------------------------------
describe("P0-4's over-serving guard: a binding used ONLY as a bare-statement call receiver is not a value candidate", () => {
  it("excludes a name used only as `name.method(...)` with its result discarded", () => {
    const body = [
      "  logger.info(\"charge\");",
      "  await logger.flush();",
    ];
    const refs = constantLikeReferencesIn(body, false, "place", new Set());
    expect(refs).not.toContain("logger");
  });

  it("recall control: the SAME shape used inside a condition/return/logical expression is NOT excluded (RETRYABLE_STATUSES.has(status) must always be reachable)", () => {
    const body = ["  return RETRYABLE_STATUSES.has(status) || Status.Active === status;"];
    expect(constantLikeReferencesIn(body, false, "shouldRetry", new Set(["status"]))).toContain("RETRYABLE_STATUSES");
  });

  it("recall control: a receiver ALSO read as a plain property elsewhere in the same body is not excluded (config.timeoutMs, config.maxAttempts)", () => {
    const body = [
      "  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {",
      "    const response = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) });",
      "  }",
    ];
    expect(constantLikeReferencesIn(body, false, "fetchWithRetry", new Set())).toContain("config");
  });

  it("a name used BOTH as a discarded receiver call and as a bare value stays a candidate (not ONLY a receiver)", () => {
    const body = [
      "  logger.info(\"start\");",
      "  return logger;",
    ];
    expect(constantLikeReferencesIn(body, false, "run", new Set())).toContain("logger");
  });
});

// ---------------------------------------------------------------------------
// P0-4 end to end: six fresh fixtures, one per review case shape, each
// asking a value/condition question whose answer sits behind exactly the
// initializer shape the old "literal-like" filter wrongly excluded.
// ---------------------------------------------------------------------------
describe("P0-4 end-to-end — every non-callable binding shape is a served value window", () => {
  it("TS: a constant computed by an arbitrary call (parseInt) is served", async () => {
    const ws = makeWorkspace("computed-ts");
    writeFile(ws, "package.json", '{ "name": "r4b-computed", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/limits.ts",
      "export const MAX_RETRIES = parseInt(process.env.MAX_RETRIES_ENV ?? \"4\", 10);\n",
    );
    writeFile(
      ws,
      "src/sender.ts",
      "import { MAX_RETRIES } from \"./limits\";\n\nexport async function sendRequest(url: string): Promise<Response> {\n  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {\n    const response = await fetch(url);\n    if (response.ok) return response;\n  }\n  throw new Error(\"exhausted\");\n}\n",
    );
    const chain = await ask(ws, "How many retries does sendRequest use?");
    expect(allBodies(chain)).toContain("?? \"4\"");
  }, 60_000);

  it("TS: an object built by a call (a config loader) is served", async () => {
    const ws = makeWorkspace("callbuilt-ts");
    writeFile(ws, "package.json", '{ "name": "r4b-callbuilt", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/loader.ts",
      "export function buildSettings<T>(value: T): T {\n  return value;\n}\n",
    );
    writeFile(
      ws,
      "src/settings.ts",
      "import { buildSettings } from \"./loader\";\n\nexport const settings = buildSettings({\n  delayMs: 750,\n  maxAttempts: 5,\n});\n",
    );
    writeFile(
      ws,
      "src/sender.ts",
      "import { settings } from \"./settings\";\n\nexport async function sendRequest(url: string): Promise<Response> {\n  for (let attempt = 0; attempt < settings.maxAttempts; attempt++) {\n    const response = await fetch(url, { signal: AbortSignal.timeout(settings.delayMs) });\n    if (response.ok) return response;\n  }\n  throw new Error(\"exhausted\");\n}\n",
    );
    const chain = await ask(ws, "What delay value does sendRequest use before retrying?");
    expect(allBodies(chain)).toContain("delayMs: 750");
  }, 60_000);

  it("TS: an object with a function-valued member is still a value (the member's own shape never leaks into the binding's own callable test)", async () => {
    const ws = makeWorkspace("fnmember-ts");
    writeFile(ws, "package.json", '{ "name": "r4b-fnmember", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/handlers.ts",
      "export const HANDLERS = {\n  attempts: 6,\n  onError: (e: Error): void => {\n    console.error(e);\n  },\n};\n",
    );
    writeFile(
      ws,
      "src/sender.ts",
      "import { HANDLERS } from \"./handlers\";\n\nexport async function sendRequest(url: string): Promise<Response> {\n  for (let attempt = 0; attempt < HANDLERS.attempts; attempt++) {\n    const response = await fetch(url);\n    if (response.ok) return response;\n  }\n  throw new Error(\"exhausted\");\n}\n",
    );
    const chain = await ask(ws, "How many attempts does sendRequest use before giving up?");
    expect(allBodies(chain)).toContain("attempts: 6");
  }, 60_000);

  it("Python: a computed float and a frozenset are both served", async () => {
    const ws = makeWorkspace("py-computed");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r4b-py\"\nversion = \"0.1.0\"\n");
    writeFile(
      ws,
      "r4bpy/settings.py",
      "import os\n\nIDLE_SECONDS = float(os.environ.get(\"IDLE_SECONDS\", \"2.5\"))\nSKIP_CODES = frozenset({401, 403})\n",
    );
    writeFile(
      ws,
      "r4bpy/client.py",
      "from .settings import IDLE_SECONDS, SKIP_CODES\nimport requests\n\n\ndef poll(url):\n    response = requests.get(url, timeout=IDLE_SECONDS)\n    if response.status_code in SKIP_CODES:\n        return None\n    return response\n",
    );
    const chain = await ask(ws, "What idle timeout does poll use and which status codes does it skip?");
    const bodies = allBodies(chain);
    expect(bodies).toContain("\"2.5\"");
    expect(bodies).toContain("frozenset({401, 403})");
  }, 60_000);

  it("Go: a computed duration and a call-built set are both served", async () => {
    const ws = makeWorkspace("go-computed");
    writeFile(ws, "go.mod", "module example.com/r4bgo\n\ngo 1.22\n");
    writeFile(
      ws,
      "netpoll/settings.go",
      "package netpoll\n\nimport \"time\"\n\nvar PollInterval = time.Duration(750) * time.Millisecond\n\nvar skipCodes = buildSkip(401, 403)\n\nfunc buildSkip(codes ...int) map[int]bool {\n\tout := map[int]bool{}\n\tfor _, c := range codes {\n\t\tout[c] = true\n\t}\n\treturn out\n}\n",
    );
    writeFile(
      ws,
      "netpoll/client.go",
      "package netpoll\n\nimport (\n\t\"context\"\n\t\"net/http\"\n)\n\nfunc Poll(ctx context.Context, url string) (*http.Response, error) {\n\tctx, cancel := context.WithTimeout(ctx, PollInterval)\n\tdefer cancel()\n\tresp, err := http.DefaultClient.Do(mustRequest(ctx, url))\n\tif err == nil && skipCodes[resp.StatusCode] {\n\t\treturn nil, nil\n\t}\n\treturn resp, err\n}\n\nfunc mustRequest(ctx context.Context, url string) *http.Request {\n\treq, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)\n\treturn req\n}\n",
    );
    const chain = await ask(ws, "What poll interval does Poll use and which status codes does it skip?", 16);
    const bodies = allBodies(chain);
    expect(bodies).toContain("time.Duration(750)");
    expect(bodies).toContain("buildSkip(401, 403)");
  }, 60_000);

  it("TS: a condition read through a callable intermediary (an arrow-function callee) reaches the real constant one hop further", async () => {
    const ws = makeWorkspace("arrow-callee");
    writeFile(ws, "package.json", '{ "name": "r4b-arrowcallee", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/policy.ts",
      "export const RETRY_CODES = new Set([500, 502]);\n\nexport const isRetryable = (code: number): boolean => RETRY_CODES.has(code);\n",
    );
    writeFile(
      ws,
      "src/sender.ts",
      "import { isRetryable } from \"./policy\";\n\nexport async function sendRequest(url: string): Promise<Response> {\n  for (let attempt = 0; ; attempt++) {\n    const response = await fetch(url);\n    if (!isRetryable(response.status)) return response;\n  }\n}\n",
    );
    const chain = await ask(ws, "Which status codes does sendRequest retry?");
    expect(allBodies(chain)).toContain("new Set([500, 502])");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-12 end-to-end: (a) a closure window promoted to its whole small file
// restores a single server hop when the FOCAL and the CONSTANT it reads
// share that file; (b) an identifier obligation sees a post-certification
// anchor in the SAME response, never a self-contradictory "missing" gap.
// ---------------------------------------------------------------------------
describe("P2-12 — closure whole-file promotion restores a single hop; no gap contradicts its own response", () => {
  it("a focal and the constant it reads, sharing one small file, resolve in ONE server-driven hop", async () => {
    const ws = makeWorkspace("wholefile");
    writeFile(ws, "package.json", '{ "name": "r4b-wholefile", "private": true, "type": "module" }\n');
    // Mirrors the V01 flagship shape: an interface, a small DEFAULT_ options
    // constant, and a reading function all in ONE 15-line file — the
    // constant's OWN window (a handful of lines) and the function's OWN
    // window are two DISJOINT ranges of the same small file.
    writeFile(
      ws,
      "src/netconfig.ts",
      [
        "export interface NetOptions {",
        "  idleMs: number;",
        "  maxAttempts: number;",
        "}",
        "",
        "export const DEFAULT_NET_OPTIONS: NetOptions = {",
        "  idleMs: 4000,",
        "  maxAttempts: 3,",
        "};",
        "",
        "export function loadNetOptions(env: Record<string, string | undefined>): NetOptions {",
        "  return { ...DEFAULT_NET_OPTIONS, idleMs: Number(env.NET_IDLE_MS ?? DEFAULT_NET_OPTIONS.idleMs) };",
        "}",
        "",
      ].join("\n"),
    );
    const chain = await ask(ws, "Explain the default NET_IDLE_MS value that loadNetOptions falls back to.", 8);
    const last = chain.hops[chain.hops.length - 1]!;
    expect(decisionOf(last.response).kind).toBe("act.answer");
    // serverHops: count non-qref-repack calls -- exactly one call this
    // response ever needed the server to compute new evidence for.
    const serverHops = chain.hops.filter((hop) => {
      const args = (hop.call as any).arguments ?? {};
      return !Object.keys(args).every((k) => k === "qref" || k === "cwd");
    });
    expect(serverHops.length, `expected 1 server-driven hop, got ${serverHops.length}: ${JSON.stringify(chain.hops.map((h) => h.call))}`).toBe(1);
    expect(allBodies(chain)).toContain("idleMs: 4000");
  }, 60_000);

  it("no identifier obligation is disclosed missing while an anchor row containing it ships in the SAME response", async () => {
    const ws = makeWorkspace("anchorconsist");
    writeFile(ws, "package.json", '{ "name": "r4b-anchorconsist", "private": true, "type": "module" }\n');
    // A deliberately BIGGER file so the constant's closure window is NOT
    // promotable to the whole file (padding pushes it well past
    // MAX_CLOSURE_BYTES_PER_PACK) -- isolating THIS finding (the anchor/
    // readiness ordering) from the whole-file-promotion fix above: even
    // when promotion cannot apply, the gap text must never contradict the
    // anchor evidence the SAME response carries.
    const padding = Array.from({ length: 40 }, (_, i) =>
      `export function netPad${i}(items: number[]): number {\n  return items.reduce((sum, item) => sum + item * ${i}, ${i});\n}\n`).join("\n");
    writeFile(
      ws,
      "src/netconfig.ts",
      `export const DEFAULT_NET_OPTIONS = {\n  idleMs: 4000,\n  maxAttempts: 3,\n};\n\nexport function loadNetOptions(env: Record<string, string | undefined>) {\n  return { ...DEFAULT_NET_OPTIONS, idleMs: Number(env.NET_IDLE_MS ?? DEFAULT_NET_OPTIONS.idleMs) };\n}\n\n${padding}`,
    );
    const chain = await ask(ws, "Explain the default NET_IDLE_MS value that loadNetOptions falls back to.", 8);
    for (const hop of chain.hops) {
      const refs = gapRefs(hop.response);
      if (refs.length === 0) continue;
      const servedTexts = ((hop.response as any)?.evidence ?? [])
        .filter((e: any) => typeof e?.body === "string")
        .map((e: any) => String(e.body));
      for (const ref of refs) {
        const m = /^identifier:(.+)$/.exec(ref);
        if (!m) continue;
        const named = m[1]!;
        const shippedInThisHop = servedTexts.some((text: string) => text.includes(named));
        expect(
          shippedInThisHop,
          `hop disclosed "${ref}" as missing while its OWN evidence already contains "${named}": ${JSON.stringify(servedTexts).slice(0, 300)}`,
        ).toBe(false);
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-16 end-to-end: a dependency-definitions gap never names a runtime
// global, and never lists a definition the SAME response already served.
// ---------------------------------------------------------------------------
describe("P2-16 — dependency-definitions gaps never name a runtime global or an already-served definition", () => {
  it("28 callers each invoking a JS global (encodeURIComponent) alongside the focal never gap either as an unresolved dependency", async () => {
    const ws = makeWorkspace("depdefs");
    writeFile(ws, "package.json", '{ "name": "r4b-depdefs", "private": true, "type": "module" }\n');
    writeFile(
      ws,
      "src/netClient.ts",
      "export async function fetchResource(url: string): Promise<Response> {\n  return fetch(url);\n}\n",
    );
    for (let i = 0; i < 28; i++) {
      writeFile(
        ws,
        `src/routes/route${String(i).padStart(2, "0")}.ts`,
        `import { fetchResource } from "../netClient";\n\nexport async function handleRoute${i}(id: string): Promise<unknown> {\n  const res = await fetchResource(\`/items/\${encodeURIComponent(id)}\`);\n  return res.json();\n}\n`,
      );
    }
    const chain = await ask(ws, "Who calls fetchResource? List every caller.", 20);
    for (const hop of chain.hops) {
      for (const ref of gapRefs(hop.response)) {
        expect(ref, `gap wrongly names a JS runtime global as an unresolved dependency: ${ref}`)
          .not.toMatch(/dependency-definitions:encodeURIComponent\b/);
        expect(ref, `gap wrongly lists the query's own already-served focal as an unresolved dependency: ${ref}`)
          .not.toMatch(/dependency-definitions:fetchResource\b/);
      }
    }
    const last = chain.hops[chain.hops.length - 1]!;
    expect(decisionOf(last.response).kind).toBe("act.answer");
  }, 60_000);
});
