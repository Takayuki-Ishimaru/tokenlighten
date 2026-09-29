/**
 * evaluation0927.r5bValueFlowFacets.spec.ts — R5-B (round-5 wave, 2026-09-28):
 * regression coverage for review-findings-fable-r4.md's P0-3, P1-4, P1-10,
 * P2-13 and P2-14 findings (values/flow/facet-extraction section of the
 * round-5 brief).
 *
 * Every fixture below is written FRESH against the DESCRIBED defect class —
 * different names, different files, different query wording from the
 * reviewer's own harness cases (the classMethod family, arrowChainDepth3,
 * callersNegatedParen, jaCallersYobu, externalPackageConst, pipelineSequences —
 * `$SCRATCH/review4/cases4.mjs`) — so a fix that only special-cases the
 * reviewer's exact identifiers would still fail here.
 *
 * Fast, no-server unit tests first (the pure evidenceClosure.ts/
 * requestFacets.ts functions this wave added or widened); spawned
 * dev-server end-to-end cases follow, one describe block per finding.
 *
 * P2-16 (expressRouterValue, over-serving a factory-call binding used only
 * as a call argument/receiver) has NO fix in this wave — see the round-5
 * report for why no syntax-only rule was found safe (it would also exclude
 * a genuine scalar constant passed the same way, confirmed against this
 * exact fixture's own DEFAULT_REQUEST_TIMEOUT_MS) — so it has no test here
 * either; that is a documented residual, not an oversight.
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
import { findOwnerPropertyWindow, selfPropertyReferencesIn, type OwnerMemberSpan } from "../features/task-pack/evidenceClosure.js";
import { extractFacetRequirements } from "../features/task-pack/requestFacets.js";

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
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r5b-${tag}-`));
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

function evidenceOf(response: unknown): any[] {
  return ((response as any)?.evidence ?? []) as any[];
}

/**
 * Mirrors the reviewer's OWN "false completion" metric (review4/probe4.mjs's
 * `falseCompletions`): walks the chain hop by hop, and — the FIRST time any
 * hop certifies `act.answer`/`act.edit` — every one of `markers` must
 * already be present in the CUMULATIVE served evidence bodies up to and
 * including that hop. A test that only checked the chain's FINAL bytes could
 * pass even when an EARLIER hop certified prematurely (a later qref replay
 * or whole-file promotion papering over the real defect) — this checks the
 * moment of certification itself, the exact shape of P0-3/P1-4/P2-14's bugs.
 */
function assertNoFalseCompletion(chain: ChainResult, markers: readonly string[]): void {
  let cumulative = "";
  for (const hop of chain.hops) {
    for (const e of evidenceOf(hop.response)) if (typeof e?.body === "string") cumulative += `${e.body}\n`;
    const kind = decisionOf(hop.response).kind;
    if (kind === "act.answer" || kind === "act.edit") {
      for (const marker of markers) {
        expect(cumulative, `certified "${kind}" without "${marker}" anywhere in the served evidence so far`).toContain(marker);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// P0-3 unit coverage: selfPropertyReferencesIn / findOwnerPropertyWindow
// ---------------------------------------------------------------------------
describe("P0-3 unit: selfPropertyReferencesIn", () => {
  it("finds this.p and self.p, first component only, deduplicated, in appearance order", () => {
    const body = [
      "  const a = this.options.timeoutMs;",
      "  return this.options.maxAttempts + this.retries;",
    ];
    expect(selfPropertyReferencesIn(body, false)).toEqual(["options", "retries"]);
  });
  it("Python: self.p is captured the same way", () => {
    expect(selfPropertyReferencesIn(["value = self.timeout"], false)).toEqual(["timeout"]);
  });
  it("ignores a bare .p access with no this/self prefix", () => {
    expect(selfPropertyReferencesIn(["return other.value;"], false)).toEqual([]);
  });
});

describe("P0-3 unit: findOwnerPropertyWindow", () => {
  it("TS: a field initializer outside any method", () => {
    const lines = [
      "export class Widget {",
      "  private readonly limit = MAX_LIMIT;",
      "",
      "  run(): number {",
      "    return this.limit;",
      "  }",
      "}",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 4, end: 6, name: "run" }];
    expect(findOwnerPropertyWindow(lines, 1, 7, methodSpans, "limit", false)).toEqual({ start: 2, end: 2, truncated: false });
  });

  it("TS: a constructor parameter property with a default", () => {
    const lines = [
      "export class Widget {",
      "  constructor(private readonly limit = MAX_LIMIT) {}",
      "",
      "  run(): number {",
      "    return this.limit;",
      "  }",
      "}",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 2, end: 2, name: "constructor" }, { start: 4, end: 6, name: "run" }];
    expect(findOwnerPropertyWindow(lines, 1, 7, methodSpans, "limit", false)).toEqual({ start: 2, end: 2, truncated: false });
  });

  it("TS: a constructor-body assignment whose RHS is directly the constant", () => {
    const lines = [
      "export class Widget {",
      "  private readonly limit: number;",
      "",
      "  constructor() {",
      "    this.limit = MAX_LIMIT;",
      "  }",
      "",
      "  run(): number {",
      "    return this.limit;",
      "  }",
      "}",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 4, end: 6, name: "constructor" }, { start: 8, end: 10, name: "run" }];
    expect(findOwnerPropertyWindow(lines, 1, 11, methodSpans, "limit", false)).toEqual({ start: 5, end: 5, truncated: false });
  });

  it("Python: a constructor-body assignment whose RHS is a DIFFERENTLY-named parameter with its own default (one hop further)", () => {
    const lines = [
      "class Widget:",
      "    def __init__(self, limit_value=MAX_LIMIT):",
      "        self.limit = limit_value",
      "",
      "    def run(self):",
      "        return self.limit",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 2, end: 3, name: "__init__" }, { start: 5, end: 6, name: "run" }];
    expect(findOwnerPropertyWindow(lines, 1, 6, methodSpans, "limit", true)).toEqual({ start: 2, end: 2, truncated: false });
  });

  it("returns undefined when the property has no textual assignment this module can see", () => {
    const lines = ["export class Widget {", "  run(): number { return this.limit; }", "}"];
    const methodSpans: OwnerMemberSpan[] = [{ start: 2, end: 2, name: "run" }];
    expect(findOwnerPropertyWindow(lines, 1, 3, methodSpans, "limit", false)).toBeUndefined();
  });

  it("a same-shaped bare reassignment inside an UNRELATED method is never mistaken for the field declaration", () => {
    const lines = [
      "export class Widget {",
      "  helper(): void {",
      "    limit = 999;",
      "  }",
      "",
      "  run(): number {",
      "    return this.limit;",
      "  }",
      "}",
    ];
    const methodSpans: OwnerMemberSpan[] = [{ start: 2, end: 4, name: "helper" }, { start: 6, end: 8, name: "run" }];
    expect(findOwnerPropertyWindow(lines, 1, 9, methodSpans, "limit", false)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P1-10 / P2-14 unit coverage: extractFacetRequirements (no server needed —
// pure clause/facet detection)
// ---------------------------------------------------------------------------
describe("P1-10 unit: a negated-instruction parenthetical never drops the question it sits in", () => {
  it("EN: a trailing (do not change it) still resolves the callers facet", () => {
    const reqs = extractFacetRequirements("Who calls renderReport (do not change it)?");
    expect(reqs.some((r) => r.facet === "callers" && r.subjectIdentifiers.includes("renderReport"))).toBe(true);
  });
  it("EN: a full-width parenthetical negated instruction is excised too", () => {
    const reqs = extractFacetRequirements("Who calls renderReport （do not modify anything）?");
    expect(reqs.some((r) => r.facet === "callers" && r.subjectIdentifiers.includes("renderReport"))).toBe(true);
  });
  it("EN: a comma-split standalone negated clause is still dropped (unchanged control)", () => {
    const reqs = extractFacetRequirements("Who calls renderReport, and please do not modify anything?");
    expect(reqs.some((r) => r.facet === "callers" && r.subjectIdentifiers.includes("renderReport"))).toBe(true);
  });
  it("JA: Xを呼ぶのは(どこ) resolves to callers", () => {
    const reqs = extractFacetRequirements("renderReportを呼ぶのはどこですか。");
    expect(reqs.some((r) => r.facet === "callers")).toBe(true);
  });
  it("JA: Xを呼んでいるのは resolves to callers", () => {
    const reqs = extractFacetRequirements("renderReportを呼んでいるのは誰ですか。");
    expect(reqs.some((r) => r.facet === "callers")).toBe(true);
  });
});

describe("P2-14 unit: 'sequence(s)' as a verb, and 'in what sequence', trigger the flow facet", () => {
  it("EN: 'how X sequences A, B and C'", () => {
    const reqs = extractFacetRequirements("Explain how Renderer sequences fetch, transform and paint.");
    expect(reqs.some((r) => r.facet === "flow")).toBe(true);
  });
  it("EN: 'in what sequence'", () => {
    const reqs = extractFacetRequirements("In what sequence does Renderer run its steps?");
    expect(reqs.some((r) => r.facet === "flow")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-3 end-to-end
// ---------------------------------------------------------------------------
describe("P0-3 end-to-end: a member focal's this.p/self.p chase reaches the owner's module constant", () => {
  it("TS: constructor parameter property default", async () => {
    const ws = makeWorkspace("p0-ctor");
    writeFile(ws, "package.json", '{ "name": "r5b-p0", "private": true, "type": "module" }\n');
    writeFile(ws, "src/limits.ts", "export const DEFAULT_LIMITS = {\n  maxItems: 42,\n  windowMs: 9000,\n};\n");
    writeFile(
      ws,
      "src/queue.ts",
      "import { DEFAULT_LIMITS } from \"./limits\";\n\nexport class WorkQueue {\n  constructor(private readonly limits = DEFAULT_LIMITS) {}\n\n  capacity(): number {\n    return this.limits.maxItems;\n  }\n}\n",
    );
    const chain = await ask(ws, "What default max items does WorkQueue.capacity use?");
    assertNoFalseCompletion(chain, ["maxItems: 42"]);
  }, 60_000);

  it("Python: a constructor-assigned property whose default lives on a differently-named parameter", async () => {
    const ws = makeWorkspace("p0-py");
    writeFile(ws, "pyproject.toml", "[project]\nname = \"r5bpy\"\nversion = \"0.1.0\"\n");
    writeFile(ws, "r5bpy/limits.py", "MAX_ITEMS = 42\n");
    writeFile(
      ws,
      "r5bpy/queue.py",
      "from .limits import MAX_ITEMS\n\n\nclass WorkQueue:\n    def __init__(self, cap=MAX_ITEMS):\n        self.cap = cap\n\n    def capacity(self):\n        return self.cap\n",
    );
    const chain = await ask(ws, "What default max items does WorkQueue.capacity use?");
    assertNoFalseCompletion(chain, ["MAX_ITEMS = 42"]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P1-4 end-to-end
// ---------------------------------------------------------------------------
describe("P1-4 end-to-end: a callable chain three pass-through hops deep still reaches its constant", () => {
  it("TS: focal -> layerC -> layerB -> layerA -> constant", async () => {
    const ws = makeWorkspace("p1-4-chain");
    writeFile(ws, "package.json", '{ "name": "r5b-p14", "private": true, "type": "module" }\n');
    writeFile(ws, "src/constants.ts", "export const ALLOWED_CODES = new Set([201, 204, 304]);\n");
    writeFile(ws, "src/layerA.ts", "import { ALLOWED_CODES } from \"./constants\";\n\nexport const layerA = (code: number): boolean => ALLOWED_CODES.has(code);\n");
    writeFile(ws, "src/layerB.ts", "import { layerA } from \"./layerA\";\n\nexport const layerB = (code: number): boolean => layerA(code);\n");
    writeFile(ws, "src/layerC.ts", "import { layerB } from \"./layerB\";\n\nexport const layerC = (code: number): boolean => layerB(code);\n");
    writeFile(
      ws,
      "src/handle.ts",
      "import { layerC } from \"./layerC\";\n\nexport async function handleResponse(code: number): Promise<string> {\n  return layerC(code) ? \"ok\" : \"retry\";\n}\n",
    );
    const chain = await ask(ws, "Which codes does handleResponse accept?", 16);
    assertNoFalseCompletion(chain, ["new Set([201, 204, 304])"]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-13 end-to-end
// ---------------------------------------------------------------------------
describe("P2-13 end-to-end: an external-package constant with no underscore is disclosed, never silently dropped", () => {
  it("TS: a value read through a non-relative package import is an honest undetermined gap", async () => {
    const ws = makeWorkspace("p2-13");
    writeFile(ws, "package.json", '{ "name": "r5b-p213", "private": true, "type": "module", "dependencies": { "@acme/limits": "^1.0.0" } }\n');
    writeFile(
      ws,
      "src/gate.ts",
      "import { LIMITS } from \"@acme/limits\";\n\nexport async function admit(count: number): Promise<boolean> {\n  return count < LIMITS.maxAdmitted;\n}\n",
    );
    const chain = await ask(ws, "What max admitted value does admit use?");
    const last = chain.hops[chain.hops.length - 1]!;
    const refs = gapRefs(last.response);
    // P2-10 (round-6 fable finding, externalPackageConst): the disclosure
    // names the PACKAGE; round 7: it never claims "declared outside the
    // workspace" (a workspace package or a path alias would make it false).
    expect(refs.some((g) => g.includes("LIMITS") && g.includes("imported from package @acme/limits"))).toBe(true);
    expect(refs.some((g) => g.includes("declared outside the workspace"))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P1-10 end-to-end
// ---------------------------------------------------------------------------
describe("P1-10 end-to-end: a negated-instruction parenthetical never silences the callers facet", () => {
  it("TS: callers are served even with a trailing (do not change it)", async () => {
    const ws = makeWorkspace("p1-10");
    writeFile(ws, "package.json", '{ "name": "r5b-p110", "private": true, "type": "module" }\n');
    writeFile(ws, "src/render.ts", "export function renderReport(id: string): string {\n  return `report-${id}`;\n}\n");
    writeFile(ws, "src/page.ts", "import { renderReport } from \"./render\";\n\nexport function showPage(id: string): string {\n  return renderReport(id);\n}\n");
    const chain = await ask(ws, "Who calls renderReport (do not change it)?");
    // The `why` tag is only carried on the hop that FIRST serves a body (a
    // qref replay's evidence entries reference `prior` instead) -- the
    // callers facet's own recognition is what this test guards, so it
    // checks every hop's certificate obligations (stable across replays)
    // AND the one hop with a fresh body for the actual caller-site tag.
    expect(chain.hops.some((h) => decisionOf(h.response).certificate?.obligations?.some((o: string) => /request-item:facet-\d+:callers/.test(o)))).toBe(true);
    expect(chain.hops.some((h) => evidenceOf(h.response).some((e) => String(e?.why ?? "").includes("closure:callers")))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// P2-14 end-to-end
// ---------------------------------------------------------------------------
describe("P2-14 end-to-end: 'sequences' as a verb produces a flow answer covering every named step", () => {
  it("TS: a class whose method sequences three private steps", async () => {
    const ws = makeWorkspace("p2-14");
    writeFile(
      ws,
      "package.json",
      '{ "name": "r5b-p214", "private": true, "type": "module" }\n',
    );
    writeFile(
      ws,
      "src/Renderer.ts",
      "export class Renderer {\n  run(input: string): string {\n    const fetched = this.fetch(input);\n    const shaped = this.transform(fetched);\n    return this.paint(shaped);\n  }\n\n  private fetch(input: string): string {\n    return `raw:${input}`;\n  }\n\n  private transform(value: string): string {\n    return `shaped:${value}`;\n  }\n\n  private paint(value: string): string {\n    return `painted:${value}`;\n  }\n}\n",
    );
    const chain = await ask(ws, "Explain how Renderer sequences fetch, transform and paint.");
    assertNoFalseCompletion(chain, ["shaped:${value}", "painted:${value}"]);
  }, 60_000);
});
