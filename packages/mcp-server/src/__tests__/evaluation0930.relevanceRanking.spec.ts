/**
 * evaluation0930.relevanceRanking.spec.ts — v0.15.0 (2026-09-30), WP-RK.
 * Relevance ranking for `plan.neighbours` (TL_NEIGHBOUR_INDEX,
 * features/task-pack/frontierNeighbours.ts) and relevance-ranked,
 * project-scoped `plan.usages` (TL_USAGE_INVENTORY, features/task-pack/
 * usageInventory.ts). Both flags stay default OFF.
 *
 * Pinned here:
 *  - NBR: the ranking formula (pure scorer over synthetic edges: request
 *    relevance, use in the served slice, importer priority, counterpart
 *    relation, test/vendored/generated penalties, ties, merge-by-path), the
 *    emit/no-emit selection, imports read from the WHOLE file rather than the
 *    served slice, exclusion of paths the model already holds, the byte cap
 *    dropping the lowest-ranked rows, the exact `why` wording, JA queries.
 *  - FUI: candidate extraction and rank categories, the stoplist, the
 *    "adds nothing" drop, query-named / concept-matched / referenced-elsewhere
 *    symbols, string-literal keys, the byte caps (rank order preserved,
 *    top-entry shrink).
 *  - Scope: `inventoryScopeOf` per membership source, and the wire `scope`.
 *  - Flags OFF: the hooks touch nothing.
 *  - Bounded work on a 2,000+ file tree.
 *  - One end-to-end pack over a nested TS + Python fixture with both flags ON.
 *  - Refinement round (2026-09-30): R1 compact entries and trim-before-drop under
 *    the byte cap, R2 the declaring file first, R3 code-only references, R4
 *    ubiquity demotion and qualified-identifier subjects, R5 project-name terms
 *    (NBR and FUI), and symlink safety with the filesystem accesses recorded.
 *  - Final round (2026-09-30, review pass 2): P0-2 linear member globs, P1-6 a
 *    member directory must hold its ecosystem's own manifest, P1-5 the members stay
 *    inside the pack's remaining wire headroom (`PlanAidOptions`), inventory_complete
 *    honesty for skipped files, the 2,000-character query bound, and FUI symbol
 *    choice F1 (ubiquitous concept terms), F2 (absolute ubiquity only), F3
 *    (referenced-not-declared first), F4 (up to 8 symbols).
 *
 * NBR edge resolution itself is other work packages' job: the ranking tests
 * inject synthetic edges (`deps.resolveImports`) or use plain relative TS and
 * Python imports.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Records every filesystem access the modules under test make while `spy.recording` is on, so "a symlink that points out of
// the workspace is never read" is asserted on the accesses themselves (the same technique as evaluation0930.importPythonWeb.spec.ts).
const spy = vi.hoisted(() => ({ recording: false, calls: [] as Array<{ fn: string; path: string }> }));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const wrap = <F extends (...args: any[]) => any>(name: string, fn: F): F =>
    ((...args: any[]) => {
      if (spy.recording) spy.calls.push({ fn: name, path: String(args[0]) });
      return fn(...args);
    }) as F;
  const realpathSync = Object.assign(wrap("realpathSync", actual.realpathSync), { native: wrap("realpathSync.native", actual.realpathSync.native) });
  const wrapped = {
    ...actual,
    readFileSync: wrap("readFileSync", actual.readFileSync),
    statSync: wrap("statSync", actual.statSync),
    lstatSync: wrap("lstatSync", actual.lstatSync),
    readdirSync: wrap("readdirSync", actual.readdirSync),
    opendirSync: wrap("opendirSync", actual.opendirSync),
    openSync: wrap("openSync", actual.openSync),
    realpathSync,
  };
  return { ...wrapped, default: wrapped };
});

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { startDevServer, type ServerHandle } from "./helpers/qualityFirstScenarios.js";
import {
  GENERIC_IDENTIFIER_STOPLIST,
  NEIGHBOUR_WEIGHTS,
  PLAN_AID_KEY_OVERHEAD_BYTES,
  PLAN_AID_MIN_BYTES,
  attachFrontierNeighbourIndex,
  codeLinesOutsideImports,
  computeFrontierNeighbourIndex,
  identifierTokensOf,
  isGeneratedPath,
  isWorkspaceRelativePath,
  listDirectoryChecked,
  readCapped,
  isTestPath,
  isVendoredPath,
  neighbourWhy,
  planAidCap,
  projectNameTermsOf,
  projectRootsChecked,
  rankNeighbourCandidates,
  requestTermsOf,
  selectNeighbours,
  stemWord,
  subWordsOf,
  withoutProjectTerms,
  type NeighbourEdge,
  type PlanAidOptions,
  type RequestTerms,
} from "../features/task-pack/frontierNeighbours.js";
import {
  USAGE_SYMBOL_STOPLIST,
  attachUsageInventory,
  collectUsageCandidates,
  computeUsageInventory,
  declaresSymbol,
  inventoryScopeOf,
  proseCodeSpans,
  rankUsageCandidates,
  servedLineSpans,
  surfaceKindOf,
  type UsageCandidate,
  type UsageEntry,
} from "../features/task-pack/usageInventory.js";
import { conceptTermsIn } from "../features/task-pack/requestFacets.js";
import { jaBridgeVocabPerCallStorage } from "../features/retrieval/jaBridgeWorkspaceVocab.js";
import { buildJaBridgeVocabulary } from "../features/retrieval/jaQueryBridge.js";
import type { ResolvedImport } from "../features/task-pack/importGraphShared.js";
import type { TaskPackResult, TaskPackSurface } from "../features/task-pack/model.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  delete process.env["TL_NEIGHBOUR_INDEX"];
  delete process.env["TL_USAGE_INVENTORY"];
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeWorkspace(tag: string, files: Readonly<Record<string, string>> = {}): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-e0930-rk-${tag}-`));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) put(ws, rel, content);
  return ws;
}

function put(ws: string, rel: string, content: string): void {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function surface(p: string, code: string, over: Partial<TaskPackSurface> = {}): TaskPackSurface {
  const lines = code.split(/\r?\n/).length;
  return { role: "domain", handle: `h-${p}`, path: p, range: `1-${lines}`, code, ...over };
}

function fakeResult(surfaces: TaskPackSurface[], extra: Partial<TaskPackResult> = {}): TaskPackResult {
  return { mode: "task_pack", coverage: "partial", surfaces, missing: [], ...extra };
}

/** A synthetic edge for the pure scorer. */
function edge(
  p: string,
  over: Partial<Pick<NeighbourEdge, "importer" | "importerIndex" | "importerIsTest" | "sliceTokens" | "projectTerms">> & {
    names?: readonly string[];
    line?: number;
    kind?: ResolvedImport["kind"];
  } = {},
): NeighbourEdge {
  return {
    edge: { path: p, line: over.line ?? 1, kind: over.kind ?? "import", names: [...(over.names ?? [])] },
    importer: over.importer ?? "src/main.ts",
    importerIndex: over.importerIndex ?? 0,
    importerIsTest: over.importerIsTest ?? false,
    sliceTokens: over.sliceTokens,
    ...(over.projectTerms !== undefined ? { projectTerms: over.projectTerms } : {}),
  };
}

const NO_TERMS: RequestTerms = requestTermsOf(undefined);
const tokens = (...names: string[]): ReadonlySet<string> => new Set(names);
const order = (ranked: ReadonlyArray<{ path: string }>): string[] => ranked.map((r) => r.path);

/** A resolver that finds `import { X } from './name.js'` lines (TS) — independent of the real resolvers. */
function lineResolver(dir: string): (workspace: string, filePath: string, body: string) => ResolvedImport[] {
  return (_workspace, _filePath, body) => {
    const out: ResolvedImport[] = [];
    body.split(/\r?\n/).forEach((text, i) => {
      const m = /^import \{ ([\w, ]+) \} from '\.\/([\w./-]+?)(?:\.js)?';/.exec(text);
      if (m) out.push({ path: `${dir}/${m[2]}.ts`, line: i + 1, kind: "import", names: m[1]!.split(",").map((s) => s.trim()) });
    });
    return out;
  };
}

// ===========================================================================
// NBR — request terms, sub-words, path classifiers
// ===========================================================================

describe("NBR — sub-words, stems and request terms", () => {
  it("subWordsOf splits humps, acronym runs, separators and digit boundaries", () => {
    expect(subWordsOf("priorityQueue")).toEqual(["priority", "queue"]);
    expect(subWordsOf("HTTPServer2Config_v3")).toEqual(["http", "server", "config"]);
    expect(subWordsOf("MAX_RETRY-COUNT.value/path")).toEqual(["max", "retry", "count", "value", "path"]);
    expect(subWordsOf("a1 b22")).toEqual([]);
  });

  it("stemWord stays in step with conceptTermsIn's private stemmer", () => {
    for (const word of ["retries", "statuses", "queues", "policies", "class", "boxes", "uploads", "orders", "address", "status"]) {
      expect(conceptTermsIn(word)).toEqual([stemWord(word)]);
    }
  });

  it("requestTermsOf: explicit identifiers, concept stems, no scaffolding, path spans become files", () => {
    const terms = requestTermsOf("Where is the retry timeout configured for uploads in src/net/client.ts? See `retries` and MAX_RETRIES.");
    expect(terms.identifiers).toEqual(["retries", "MAX_RETRIES"]);
    expect(terms.concepts).toEqual(expect.arrayContaining(["retry", "timeout", "upload", "max"]));
    for (const generic of ["where", "see", "configured", "src"]) expect(terms.concepts).not.toContain(generic);
    expect(terms.files).toEqual(["src/net/client.ts"]);
    expect(terms.present).toBe(true);
    expect(terms.mentionsTests).toBe(false);
  });

  it("requestTermsOf: the sub-words of an explicit identifier are concepts; its lower-cased spelling is not", () => {
    const terms = requestTermsOf("Who calls applyDiscount?");
    expect(terms.identifiers).toEqual(["applyDiscount"]);
    expect(terms.concepts).toContain("discount");
    expect(terms.concepts).not.toContain("applydiscount");
  });

  it("requestTermsOf: test and import intent, and an absent query", () => {
    expect(requestTermsOf("Add a unit test for the parser").mentionsTests).toBe(true);
    expect(requestTermsOf("テストを追加したい").mentionsTests).toBe(true);
    expect(requestTermsOf("List the imports of the scheduler").asksImports).toBe(true);
    expect(requestTermsOf("Explain the scheduler").asksImports).toBe(false);
    expect(requestTermsOf(undefined).present).toBe(false);
    expect(requestTermsOf("   ").present).toBe(false);
  });

  it("requestTermsOf: a Japanese query reaches the glossary stems", () => {
    const terms = requestTermsOf("注文の割引の計算方法を教えてください");
    expect(terms.concepts).toEqual(expect.arrayContaining(["order", "discount"]));
    expect(terms.present).toBe(true);
  });

  it("requestTermsOf: katakana loanwords bridge only through a vocabulary the pack build ALREADY cached", () => {
    const query = "キャンセルの仕組みを教えてください";
    const workspace = "/virtual/ws";
    // no cached vocabulary (or no pack-build scope at all): the bridge is never built from here
    expect(requestTermsOf(query, workspace).concepts).not.toContain("cancel");
    expect(jaBridgeVocabPerCallStorage.run(new Map(), () => requestTermsOf(query, workspace).concepts)).not.toContain("cancel");
    // vocabulary present in this pack build's scope: the phonetic bridge contributes its words
    const vocab = buildJaBridgeVocabulary(["cancel", "order", "refund", "ledger"]);
    const bridged = jaBridgeVocabPerCallStorage.run(new Map([[workspace, vocab]]), () => requestTermsOf(query, workspace));
    expect(bridged.concepts).toContain("cancel");
  });
});

describe("NBR — test / vendored / generated path classifiers", () => {
  it("isTestPath", () => {
    for (const p of [
      "src/__tests__/a.ts", "tests/test_a.py", "pkg/a_test.go", "src/a.test.tsx", "src/a.spec.js", "src/test/java/com/x/A.java",
      "src/main/java/com/x/OrderServiceTest.java", "lib/foo_test.cc", "pkg/conftest.py", "spec/models/user.rb",
    ]) expect(isTestPath(p), p).toBe(true);
    for (const p of ["src/latest.ts", "src/contest.js", "src/Contest.java", "src/attest/a.ts", "src/protest.py"]) expect(isTestPath(p), p).toBe(false);
  });

  it("isVendoredPath", () => {
    for (const p of ["vendor/x/y.go", "src/third_party/z.c", "a/third-party/b.js", "external/lib/a.h", "deps/a/b.py", "node_modules/a/b.js"]) {
      expect(isVendoredPath(p), p).toBe(true);
    }
    for (const p of ["src/vendorSelect.ts", "src/external.ts", "src/deps.ts"]) expect(isVendoredPath(p), p).toBe(false);
  });

  it("isGeneratedPath", () => {
    for (const p of ["api/user.pb.go", "api/user_pb2.py", "api/user_pb2_grpc.py", "src/schema.generated.ts", "src/models_generated.go", "gen/a.ts", "dist/a.js", "build/x.js", "out/y.js", "web/app.min.js"]) {
      expect(isGeneratedPath(p), p).toBe(true);
    }
    for (const p of ["src/generator.ts", "src/building.ts", "src/output.ts"]) expect(isGeneratedPath(p), p).toBe(false);
  });
});

describe("NBR — capped, boundary-safe file reads", () => {
  it("reads at most maxBytes and says so; a directory, a missing file and a traversal path read nothing", () => {
    const ws = makeWorkspace("read-capped", { "src/big.ts": "x".repeat(5000), "src/small.ts": "abc\n" });
    const big = readCapped(ws, "src/big.ts", 1000)!;
    expect(big.text).toHaveLength(1000);
    expect(big.truncated).toBe(true);
    expect(readCapped(ws, "src/small.ts", 1000)).toEqual({ text: "abc\n", truncated: false });
    expect(readCapped(ws, "src", 1000)).toBeUndefined();
    expect(readCapped(ws, "src/missing.ts", 1000)).toBeUndefined();
    expect(readCapped(ws, "../outside.ts", 1000)).toBeUndefined();
    expect(readCapped(ws, "/etc/passwd", 1000)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("refuses a symlink whose target leaves the workspace, allows one that stays inside", () => {
    const outside = makeWorkspace("read-outside", { "secret.txt": "top secret\n" });
    const ws = makeWorkspace("read-links", { "src/real.ts": "export const a = 1;\n" });
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "src/escape.ts"));
    fs.symlinkSync(path.join(ws, "src/real.ts"), path.join(ws, "src/alias.ts"));
    expect(readCapped(ws, "src/escape.ts", 1000)).toBeUndefined();
    expect(readCapped(ws, "src/alias.ts", 1000)?.text).toBe("export const a = 1;\n");
  });
});

describe("NBR — served-slice use vocabulary", () => {
  it("re-exports, dynamic imports and require bindings are import statements too", () => {
    const code = "export * from './a.js';\nexport { b } from './b.js';\nconst c = require('./c.js');\nimport('./d.js').then(() => 0);\nexport function f() { return used; }\n";
    const set = identifierTokensOf(code, "web");
    expect([...set].sort()).toEqual(["export", "f", "function", "return", "used"]);
  });

  it("import statements (single- and multi-line), comments and quoted strings never count as use", () => {
    const code = [
      "import { alpha } from './a.js';",
      "import {",
      "  beta,",
      "  gamma as delta,",
      "} from './b.js';",
      "// epsilon is only mentioned in a comment",
      "export function run() {",
      "  const label = 'zeta';",
      "  return alpha + theta;",
      "}",
    ].join("\n");
    const set = identifierTokensOf(code, "web");
    expect(set.has("alpha")).toBe(true); // used in code
    expect(set.has("theta")).toBe(true);
    for (const missing of ["beta", "gamma", "delta", "epsilon", "zeta"]) expect(set.has(missing), missing).toBe(false);
  });

  it("a Python docstring is prose: a name mentioned only there is not used", () => {
    const code = 'def total(x):\n    """Applies applyDiscount to x.\n\n    See also legacyRounding.\n    """\n    y = x  # roundHalfUp\n    return y + realUse(x)\n\ndef other():\n    """single line mentions ghostName"""\n    return 1\n';
    const set = identifierTokensOf(code, "python");
    expect(set.has("realUse")).toBe(true);
    for (const missing of ["applyDiscount", "legacyRounding", "roundHalfUp", "ghostName"]) expect(set.has(missing), missing).toBe(false);
  });

  it("Python and Go import blocks are skipped, code lines are kept", () => {
    const py = "from pkg.mod import (\n    one,\n    two,\n)\nimport three\n\ndef f():\n    return one + four\n";
    expect(codeLinesOutsideImports(py, "python").join("\n")).toBe("\ndef f():\n    return one + four\n");
    const go = 'package main\n\nimport (\n\t"fmt"\n\tledger "shop/ledger"\n)\n\nfunc main() {\n\tledger.Post()\n}\n';
    expect(codeLinesOutsideImports(go, "go").join("\n")).toContain("ledger.Post()");
    expect(codeLinesOutsideImports(go, "go").join("\n")).not.toContain("shop/ledger");
  });
});

// ===========================================================================
// NBR — the pure scorer
// ===========================================================================

describe("rankNeighbourCandidates — request relevance", () => {
  it("an explicit identifier the import binds outranks earlier unrelated imports", () => {
    const terms = requestTermsOf("How does scheduleJob decide the order?");
    const ranked = rankNeighbourCandidates(
      [
        edge("src/logger.ts", { line: 1, names: ["logger"] }),
        edge("src/config.ts", { line: 2, names: ["loadConfig"] }),
        edge("src/jobs.ts", { line: 3, names: ["scheduleJob"] }),
      ],
      terms,
    );
    expect(order(ranked)).toEqual(["src/jobs.ts", "src/logger.ts", "src/config.ts"]);
    expect(ranked[0]!.matched).toBe("scheduleJob");
    expect(ranked[0]!.relevance).toBe(NEIGHBOUR_WEIGHTS.identifierName + 2 * NEIGHBOUR_WEIGHTS.termName /* schedule + job */);
    expect(ranked[1]!.signalled).toBe(false);
  });

  it("case-insensitive identifier match is weaker than an exact one", () => {
    const terms = requestTermsOf("What does `parsefile` return?");
    const ranked = rankNeighbourCandidates([edge("a.ts", { names: ["parseFile"] }), edge("b.ts", { names: ["parsefile"] })], terms);
    expect(order(ranked)).toEqual(["b.ts", "a.ts"]);
    expect(ranked[0]!.relevance).toBeGreaterThan(ranked[1]!.relevance);
  });

  it("a concept term matches a sub-word of a bound name or of the path below the project root", () => {
    const terms = requestTermsOf("How does the priority queue break ties?");
    const ranked = rankNeighbourCandidates(
      [
        edge("src/logger.ts", { names: ["logger"] }),
        edge("src/heap/PriorityQueue.ts", { names: ["PriorityQueue"] }),
        edge("src/ordering/tieBreaker.ts", { names: [] }),
      ],
      terms,
      { rootOf: () => "src" },
    );
    expect(ranked[0]!.path).toBe("src/heap/PriorityQueue.ts");
    expect(ranked[0]!.matched).toBe("priority");
    // the directory `src` is below-root noise: only `ordering`/`tie`/`breaker` words remain for the third file
    expect(ranked.find((r) => r.path === "src/ordering/tieBreaker.ts")!.relevance).toBe(NEIGHBOUR_WEIGHTS.termPath /* tie */);
  });

  it("one weak concept match does not beat a used import; two do", () => {
    const used = tokens("heapPush");
    const one = rankNeighbourCandidates(
      [edge("src/heap.ts", { names: ["heapPush"], sliceTokens: used }), edge("src/priority.ts", { names: ["p"], sliceTokens: used })],
      requestTermsOf("explain the priority handling"),
    );
    expect(order(one)[0]).toBe("src/heap.ts");
    const two = rankNeighbourCandidates(
      [edge("src/heap.ts", { names: ["heapPush"], sliceTokens: used }), edge("src/priorityQueue.ts", { names: ["p"], sliceTokens: used })],
      requestTermsOf("explain the priority queue"),
    );
    expect(order(two)[0]).toBe("src/priorityQueue.ts");
  });

  it("the query naming a file outranks everything, matched by base name or path tail", () => {
    const terms = requestTermsOf("Compare it with lib/rateTable.ts");
    const ranked = rankNeighbourCandidates([edge("src/a.ts", { names: ["x"] }), edge("src/lib/rateTable.ts", { names: [] })], terms);
    expect(ranked[0]!.path).toBe("src/lib/rateTable.ts");
    expect(ranked[0]!.matched).toBe("rateTable.ts");
    expect(ranked[0]!.relevance).toBeGreaterThanOrEqual(NEIGHBOUR_WEIGHTS.fileNamed);
  });

  it("an explicit identifier equal to the file stem matches regardless of case and separators", () => {
    const ranked = rankNeighbourCandidates(
      [edge("src/other.py", { names: [] }), edge("pkg/order_service.py", { names: [] })],
      requestTermsOf("What does OrderService do?"),
    );
    expect(ranked[0]!.path).toBe("pkg/order_service.py");
    expect(ranked[0]!.relevance).toBeGreaterThanOrEqual(NEIGHBOUR_WEIGHTS.identifierPath);
  });

  it("declarations of the candidate count: the file that declares the named identifier wins", () => {
    const declared = new Map([
      ["src/util.ts", [{ symbol: "applyDiscount", line: 1, exported: true, kind: "function" as const }]],
      ["src/misc.ts", [{ symbol: "noop", line: 1, exported: true, kind: "function" as const }]],
    ]);
    const ranked = rankNeighbourCandidates(
      [edge("src/misc.ts", { names: ["misc"] }), edge("src/util.ts", { names: ["util"] })],
      requestTermsOf("Who calls applyDiscount?"),
      { declared },
    );
    expect(ranked[0]!.path).toBe("src/util.ts");
    expect(ranked[0]!.relevance).toBeGreaterThanOrEqual(NEIGHBOUR_WEIGHTS.identifierDeclared);
  });

  it("a term matching over half of a sizeable candidate set is ignored", () => {
    const edges = Array.from({ length: 6 }, (_, i) => edge(`src/request${i}.ts`, { names: [`handler${i}`], line: i + 1 }));
    edges.push(edge("src/pricing.ts", { names: ["price"], line: 9 }));
    const ranked = rankNeighbourCandidates(edges, requestTermsOf("How is the request price computed?"));
    // "request" is in 6 of 7 paths → ignored; "price" is not
    expect(ranked[0]!.path).toBe("src/pricing.ts");
    expect(ranked.filter((r) => r.relevance > 0).map((r) => r.path)).toEqual(["src/pricing.ts"]);
  });
});

describe("rankNeighbourCandidates — use, importer, relation, penalties, ties", () => {
  it("an import used in the served slice outranks an unused one (later in the file)", () => {
    const ranked = rankNeighbourCandidates(
      [
        edge("src/unused.ts", { line: 1, names: ["unusedFn"], sliceTokens: tokens("usedFn") }),
        edge("src/used.ts", { line: 2, names: ["usedFn"], sliceTokens: tokens("usedFn") }),
      ],
      NO_TERMS,
    );
    expect(order(ranked)).toEqual(["src/used.ts", "src/unused.ts"]);
    expect(ranked[0]!.used).toBe(1);
    expect(ranked[0]!.score - ranked[1]!.score).toBe(NEIGHBOUR_WEIGHTS.used);
  });

  it("use counts extra names, capped", () => {
    const one = rankNeighbourCandidates([edge("a.ts", { names: ["a1", "a2", "a3", "a4", "a5"], sliceTokens: tokens("a1") })], NO_TERMS)[0]!;
    const many = rankNeighbourCandidates([edge("a.ts", { names: ["a1", "a2", "a3", "a4", "a5"], sliceTokens: tokens("a1", "a2", "a3", "a4", "a5") })], NO_TERMS)[0]!;
    expect(many.score - one.score).toBe(NEIGHBOUR_WEIGHTS.usedExtraCap);
  });

  it("a name-less include uses the candidate's declared symbols", () => {
    const declared = new Map([["include/queue.h", [{ symbol: "queue_push", line: 3, exported: true, kind: "function" as const }]]]);
    const ranked = rankNeighbourCandidates(
      [
        edge("include/log.h", { kind: "include", line: 1, sliceTokens: tokens("queue_push") }),
        edge("include/queue.h", { kind: "include", line: 2, sliceTokens: tokens("queue_push") }),
      ],
      NO_TERMS,
      { declared },
    );
    expect(order(ranked)).toEqual(["include/queue.h", "include/log.h"]);
    expect(ranked[0]!.used).toBe(1);
    expect(ranked[1]!.used).toBe(0);
  });

  it("the first served surface ranks above the second at equal relevance and use", () => {
    const ranked = rankNeighbourCandidates(
      [edge("src/b.ts", { importerIndex: 1, importer: "src/second.ts", line: 1 }), edge("src/a.ts", { importerIndex: 0, importer: "src/first.ts", line: 9 })],
      NO_TERMS,
    );
    expect(order(ranked)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("a counterpart of the FIRST surface ranks with used imports; of a later surface it does not", () => {
    const used = tokens("helper");
    const ranked = rankNeighbourCandidates(
      [
        edge("src/other.h", { kind: "include", line: 1, names: [], sliceTokens: used }),
        edge("src/widget.h", { kind: "counterpart", line: 0, importerIndex: 0, importer: "src/widget.cc", sliceTokens: used }),
        edge("src/util.h", { kind: "import", line: 2, names: ["helper"], sliceTokens: used }),
        edge("src/gadget.h", { kind: "counterpart", line: 0, importerIndex: 1, importer: "src/gadget.cc", sliceTokens: used }),
      ],
      NO_TERMS,
    );
    const byPath = new Map(ranked.map((r) => [r.path, r]));
    expect(byPath.get("src/widget.h")!.score).toBeGreaterThanOrEqual(byPath.get("src/util.h")!.score - NEIGHBOUR_WEIGHTS.importer[0]! + NEIGHBOUR_WEIGHTS.importer[0]!);
    expect(byPath.get("src/widget.h")!.score).toBeGreaterThan(byPath.get("src/other.h")!.score);
    expect(byPath.get("src/gadget.h")!.score).toBeLessThan(byPath.get("src/widget.h")!.score);
    expect(byPath.get("src/widget.h")!.signalled).toBe(true);
    expect(byPath.get("src/gadget.h")!.signalled).toBe(true);
  });

  it("test, vendored and generated candidates are penalized; a test importer, a test query or a vendored importer lift it", () => {
    const base = { names: ["thing"], sliceTokens: tokens("thing") } as const;
    const plain = rankNeighbourCandidates([edge("src/thing.ts", base)], NO_TERMS)[0]!;
    for (const p of ["src/thing.test.ts", "vendor/thing.go", "third_party/thing.c", "external/thing.h", "deps/thing.py", "src/thing.pb.go", "src/thing_pb2.py", "src/thing.generated.ts", "gen/thing.ts", "dist/thing.js", "build/thing.js", "out/thing.js"]) {
      const ranked = rankNeighbourCandidates([edge(p, base)], NO_TERMS)[0]!;
      expect(ranked.penalty, p).toBe(NEIGHBOUR_WEIGHTS.penalty);
      expect(ranked.score, p).toBe(plain.score - NEIGHBOUR_WEIGHTS.penalty);
    }
    expect(rankNeighbourCandidates([edge("src/thing.test.ts", { ...base, importer: "src/a.test.ts", importerIsTest: true })], NO_TERMS)[0]!.penalty).toBe(0);
    expect(rankNeighbourCandidates([edge("src/thing.test.ts", base)], requestTermsOf("Update the tests for thing"))[0]!.penalty).toBe(0);
    expect(rankNeighbourCandidates([edge("vendor/thing.go", { ...base, importer: "vendor/other.go" })], NO_TERMS)[0]!.penalty).toBe(0);
    // a penalized candidate sinks below an unpenalized one even when it is the better match
    const mixed = rankNeighbourCandidates([edge("src/thing.test.ts", base), edge("src/other.ts", { names: ["o"], sliceTokens: tokens("o") })], NO_TERMS);
    expect(order(mixed)).toEqual(["src/other.ts", "src/thing.test.ts"]);
  });

  it("ties break on importer, then statement line (0 last), then path", () => {
    const ranked = rankNeighbourCandidates(
      [
        edge("src/z.ts", { line: 5 }),
        edge("src/a.ts", { line: 5 }),
        edge("src/m.ts", { line: 2 }),
        edge("src/ref.ts", { kind: "reference", line: 0 }),
        edge("src/later.ts", { importerIndex: 3, importer: "src/x.ts", line: 1 }),
      ],
      NO_TERMS,
    );
    expect(order(ranked)).toEqual(["src/m.ts", "src/a.ts", "src/z.ts", "src/ref.ts", "src/later.ts"]);
  });

  it("edges to the same file merge, keeping the best-scoring provenance", () => {
    const ranked = rankNeighbourCandidates(
      [
        edge("src/shared.ts", { importer: "src/first.ts", importerIndex: 0, line: 1, names: ["s"], sliceTokens: tokens() }),
        edge("src/shared.ts", { importer: "src/second.ts", importerIndex: 1, line: 7, names: ["s"], sliceTokens: tokens("s") }),
      ],
      NO_TERMS,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.importer).toBe("src/second.ts");
    expect(ranked[0]!.edge.line).toBe(7);
  });
});

describe("selectNeighbours — what is emitted", () => {
  const ranked = (terms: RequestTerms, ...edges: NeighbourEdge[]) => selectNeighbours(rankNeighbourCandidates(edges, terms), terms);

  it("only candidates with a signal; the rest are dropped", () => {
    const rows = ranked(NO_TERMS, edge("src/used.ts", { names: ["u"], sliceTokens: tokens("u") }), edge("src/idle.ts", { names: ["i"], sliceTokens: tokens("u") }));
    expect(order(rows)).toEqual(["src/used.ts"]);
  });

  it("terms present and nothing matches or is used: nothing (no first-imports guess)", () => {
    const rows = ranked(requestTermsOf("Explain the retry policy"), edge("src/a.ts", { names: ["a"], sliceTokens: tokens("x") }), edge("src/b.ts", { names: ["b"], sliceTokens: tokens("x") }));
    expect(rows).toEqual([]);
  });

  it("no terms and nothing used: the first imports, in statement order", () => {
    const rows = ranked(NO_TERMS, edge("src/b.ts", { line: 2, names: ["b"], sliceTokens: tokens() }), edge("src/a.ts", { line: 1, names: ["a"], sliceTokens: tokens() }));
    expect(order(rows)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("a query about the imports themselves keeps every candidate", () => {
    const terms = requestTermsOf("List the imports of this module");
    expect(terms.asksImports).toBe(true);
    const rows = ranked(terms, edge("src/a.ts", { line: 1, names: ["a"], sliceTokens: tokens() }), edge("src/b.ts", { line: 2, names: ["b"], sliceTokens: tokens() }));
    expect(order(rows)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("at most 8", () => {
    const edges = Array.from({ length: 12 }, (_, i) => edge(`src/m${i}.ts`, { line: i + 1, names: [`n${i}`], sliceTokens: tokens(`n${i}`) }));
    expect(ranked(NO_TERMS, ...edges)).toHaveLength(8);
  });

  it("`why` wording by edge kind", () => {
    const why = (kind: ResolvedImport["kind"], line: number) => neighbourWhy({ edge: { path: "x", line, kind, names: [] }, importer: "src/a.cc" });
    expect(why("import", 12)).toBe("imported by src/a.cc:12");
    expect(why("include", 3)).toBe("included by src/a.cc:3");
    expect(why("reference", 8)).toBe("referenced by src/a.cc:8");
    expect(why("reference", 0)).toBe("referenced by src/a.cc");
    expect(why("counterpart", 0)).toBe("counterpart of src/a.cc");
  });
});

// ===========================================================================
// NBR — computeFrontierNeighbourIndex (injected edge resolver)
// ===========================================================================

describe("computeFrontierNeighbourIndex — imports come from the whole file", () => {
  const HEAD = [
    "import { logger } from './logger.js';",
    "import { loadConfig } from './config.js';",
    "import { PriorityQueue } from './priorityQueue.js';",
    "import { heapPush } from './heap.js';",
    "",
  ].join("\n");
  const BODY = "export function schedule(q: number) {\n  return heapPush(q);\n}\n";
  const FILES: Record<string, string> = { "src/sched.ts": HEAD + BODY };
  for (const f of ["logger", "config", "priorityQueue", "heap"]) FILES[`src/${f}.ts`] = `export const ${f}X = 1;\n`;

  it("a pack that served only a slice (no import head) still gets rows, with the file's real line numbers", () => {
    const ws = makeWorkspace("slice", FILES);
    let receivedBody = "";
    const resolve = lineResolver("src");
    const result = fakeResult([surface("src/sched.ts", BODY, { range: "6-8" })]);
    const rows = computeFrontierNeighbourIndex(result, ws, undefined, {
      resolveImports: (w, p, b) => {
        receivedBody = b;
        return resolve(w, p, b);
      },
    });
    expect(receivedBody).toBe(HEAD + BODY);
    expect(rows.map((r) => r.path)).toEqual(["src/heap.ts"]); // the only import the served slice uses
    expect(rows[0]!.why).toBe("imported by src/sched.ts:4");
    expect(rows[0]!.handle.length).toBeGreaterThan(0);
  });

  it("a query-relevant import outranks earlier unrelated ones; the match suffix has one pinned form", () => {
    const ws = makeWorkspace("relevant", FILES);
    const result = fakeResult([surface("src/sched.ts", BODY, { range: "6-8" })]);
    const rows = computeFrontierNeighbourIndex(result, ws, "How does the priority queue break ties?", { resolveImports: lineResolver("src") });
    expect(rows.map((r) => r.path)).toEqual(["src/priorityQueue.ts", "src/heap.ts"]);
    expect(rows[0]!.why).toBe('imported by src/sched.ts:3 (matches "priority")');
    expect(rows[1]!.why).toBe("imported by src/sched.ts:4");
  });

  it("an explicit identifier the query names is the recorded match", () => {
    const ws = makeWorkspace("explicit", FILES);
    const result = fakeResult([surface("src/sched.ts", BODY, { range: "6-8" })]);
    const rows = computeFrontierNeighbourIndex(result, ws, "What does loadConfig return?", { resolveImports: lineResolver("src") });
    expect(rows[0]!.path).toBe("src/config.ts");
    expect(rows[0]!.why).toBe('imported by src/sched.ts:2 (matches "loadConfig")');
  });

  it("the request has terms but no import matches or is used: no rows", () => {
    const ws = makeWorkspace("nomatch", FILES);
    const result = fakeResult([surface("src/sched.ts", "export const zero = 0;\n", { range: "6-6" })]);
    expect(computeFrontierNeighbourIndex(result, ws, "Explain the pagination cursor", { resolveImports: lineResolver("src") })).toEqual([]);
  });

  it("no query and nothing used: the first imports in statement order", () => {
    const ws = makeWorkspace("noquery", FILES);
    const result = fakeResult([surface("src/sched.ts", "export const zero = 0;\n", { range: "6-6" })]);
    const rows = computeFrontierNeighbourIndex(result, ws, undefined, { resolveImports: lineResolver("src") });
    expect(rows.map((r) => r.path)).toEqual(["src/logger.ts", "src/config.ts", "src/priorityQueue.ts", "src/heap.ts"]);
  });

  it("a `code_unchanged` surface takes its use vocabulary from the file's own range", () => {
    const ws = makeWorkspace("unchanged", FILES);
    // range 6-8 holds the use of heapPush; range 1-4 (the import head) holds no use at all
    const held = fakeResult([surface("src/sched.ts", "", { code: undefined, code_unchanged: "served earlier", range: "6-8" })]);
    expect(computeFrontierNeighbourIndex(held, ws, undefined, { resolveImports: lineResolver("src") }).map((r) => r.path)).toEqual(["src/heap.ts"]);
    const head = fakeResult([surface("src/sched.ts", "", { code: undefined, code_unchanged: "served earlier", range: "1-4" })]);
    expect(computeFrontierNeighbourIndex(head, ws, undefined, { resolveImports: lineResolver("src") }).map((r) => r.path)).toEqual([
      "src/logger.ts", "src/config.ts", "src/priorityQueue.ts", "src/heap.ts",
    ]);
  });

  it("never offers a path the model already holds: this response, frontier_index or served_earlier", () => {
    const ws = makeWorkspace("known", FILES);
    const result = fakeResult(
      [surface("src/sched.ts", HEAD + BODY), surface("src/heap.ts", "export const heapX = 1;\n")],
      {
        frontier_index: [{ path: "src/logger.ts", role: "import-neighbor" }, { path: "src/", role: "dir-rollup:+3" }],
        served_earlier: [{ path: "src/config.ts", role: "domain" }],
      },
    );
    const rows = computeFrontierNeighbourIndex(result, ws, "How does the priority queue work?", { resolveImports: lineResolver("src") });
    expect(rows.map((r) => r.path)).toEqual(["src/priorityQueue.ts"]);
  });

  it("the byte cap drops the LOWEST-ranked rows and keeps the order", () => {
    // eight used imports with long paths; the LAST statement is the query-relevant one, so it ranks first
    const dir = "src/" + "deeply/nested/directory/chain/".repeat(2);
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "priorityQueue"];
    const head = names.map((n) => `import { ${n}Fn } from './${n}.js';`).join("\n");
    const body = "\nexport function go() {\n  return " + names.map((n) => `${n}Fn()`).join(" + ") + ";\n}\n";
    const files: Record<string, string> = { [`${dir}hub.ts`]: head + body };
    for (const n of names) files[`${dir}${n}.ts`] = `export const ${n}Fn = () => 1;\n`;
    const ws = makeWorkspace("bytes", files);
    const result = fakeResult([surface(`${dir}hub.ts`, body, { range: "9-12" })]);
    const rows = computeFrontierNeighbourIndex(result, ws, "How is the priority queue used?", { resolveImports: lineResolver(dir.replace(/\/$/, "")) });
    expect(Buffer.byteLength(JSON.stringify(rows), "utf8")).toBeLessThanOrEqual(1024);
    expect(rows.length).toBeLessThan(8);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]!.path).toBe(`${dir}priorityQueue.ts`);
    // survivors are the top of the ranking: the rest follow in statement order
    expect(rows.slice(1).map((r) => path.posix.basename(r.path, ".ts"))).toEqual(names.slice(0, rows.length - 1));
  });

  it("a row for a file that vanished or is unreadable is skipped, never guessed", () => {
    const ws = makeWorkspace("vanish", { "src/sched.ts": HEAD + BODY, "src/heap.ts": "export const heapX = 1;\n" });
    const result = fakeResult([surface("src/sched.ts", BODY, { range: "6-8" })]);
    const rows = computeFrontierNeighbourIndex(result, ws, undefined, { resolveImports: lineResolver("src") });
    expect(rows.map((r) => r.path)).toEqual(["src/heap.ts"]); // logger/config/priorityQueue do not exist on disk here
    fs.rmSync(path.join(ws, "src/heap.ts"));
    expect(computeFrontierNeighbourIndex(result, ws, undefined, { resolveImports: lineResolver("src") })).toEqual([]);
  });

  it("a Japanese query reaches the candidate through the glossary", () => {
    const files = {
      "src/checkout.ts": "import { log } from './logger.js';\nimport { discountRules } from './discountRules.js';\nimport { taxFor } from './tax.js';\n\nexport const total = (n: number) => n;\n",
      "src/logger.ts": "export const log = 1;\n",
      "src/discountRules.ts": "export const discountRules = 1;\n",
      "src/tax.ts": "export const taxFor = 1;\n",
    };
    const ws = makeWorkspace("ja", files);
    const result = fakeResult([surface("src/checkout.ts", files["src/checkout.ts"])]);
    const rows = computeFrontierNeighbourIndex(result, ws, "割引の計算はどこで行われますか", { resolveImports: lineResolver("src") });
    expect(rows[0]!.path).toBe("src/discountRules.ts");
    expect(rows[0]!.why).toMatch(/^imported by src\/checkout\.ts:2 \(matches "discount"\)$/);
    // the unrelated, unused imports are not emitted
    expect(rows.map((r) => r.path)).toEqual(["src/discountRules.ts"]);
  });

  it("declarations of the best candidates are read: a file that declares the named identifier is found by content", () => {
    const files = {
      "src/checkout.ts": "import { helpers } from './helpers.js';\nimport { misc } from './misc.js';\n\nexport const total = 1;\n",
      "src/helpers.ts": "export function applyDiscount(x: number): number {\n  return x;\n}\n",
      "src/misc.ts": "export function noop(): void {}\n",
    };
    const ws = makeWorkspace("decl", files);
    const result = fakeResult([surface("src/checkout.ts", files["src/checkout.ts"])]);
    const rows = computeFrontierNeighbourIndex(result, ws, "Who calls applyDiscount?", { resolveImports: lineResolver("src") });
    expect(rows.map((r) => r.path)).toEqual(["src/helpers.ts"]);
    expect(rows[0]!.why).toBe('imported by src/checkout.ts:1 (matches "applyDiscount")');
  });
});

describe("computeFrontierNeighbourIndex — declaration cache", () => {
  it("a candidate's declarations are cached by mtime+size: an edited file is re-read", () => {
    const files = {
      "src/checkout.ts": "import { helpers } from './helpers.js';\n\nexport const total = 1;\n",
      "src/helpers.ts": "export function applyDiscount(x: number): number {\n  return x;\n}\n",
    };
    const ws = makeWorkspace("declcache", files);
    const result = fakeResult([surface("src/checkout.ts", files["src/checkout.ts"])]);
    const ask = () => computeFrontierNeighbourIndex(result, ws, "Who calls applyDiscount?", { resolveImports: lineResolver("src") }).map((r) => r.path);
    expect(ask()).toEqual(["src/helpers.ts"]);
    expect(ask()).toEqual(["src/helpers.ts"]); // served from the cache
    put(ws, "src/helpers.ts", "export function somethingElseEntirely(x: number): number {\n  return x + 1;\n}\n// padded so the size changes\n");
    expect(ask()).toEqual([]);
  });
});

describe("computeFrontierNeighbourIndex — real TS and Python relative imports", () => {
  it("TS: the request-relevant import is first, from a slice without the import head", () => {
    const head = [
      "import { logger } from './logger.js';",
      "import { loadConfig } from './config.js';",
      "import { retryDelay } from './retryPolicy.js';",
      "import { heapPush } from './heap.js';",
      "",
    ].join("\n");
    const body = "export function submit(n: number): number {\n  heapPush(n);\n  return retryDelay(n);\n}\n";
    const files: Record<string, string> = { "src/checkout.ts": head + body };
    for (const f of ["logger", "config", "retryPolicy", "heap"]) files[`src/${f}.ts`] = `export const ${f}X = 1;\n`;
    const ws = makeWorkspace("ts-real", files);
    const result = fakeResult([surface("src/checkout.ts", body, { range: "6-9" })]);
    const rows = computeFrontierNeighbourIndex(result, ws, "How long is the retry delay?");
    expect(rows.map((r) => r.path)).toEqual(["src/retryPolicy.ts", "src/heap.ts"]);
    expect(rows[0]!.why).toBe('imported by src/checkout.ts:3 (matches "retry")');
  });

  it("Python: a used `from .mod import name` outranks an unused `import pkg.mod`", () => {
    const a = "from .discountRules import applyDiscount\nimport catalog.pricing\n\ndef total(x):\n    return applyDiscount(x)\n";
    const ws = makeWorkspace("py-real", {
      "shop/checkout.py": a,
      "shop/discountRules.py": "def applyDiscount(x):\n    return x * 0.9\n",
      "catalog/pricing.py": "def base(x):\n    return x + 1\n",
    });
    const result = fakeResult([surface("shop/checkout.py", a)]);
    const rows = computeFrontierNeighbourIndex(result, ws);
    expect(rows.map((r) => r.path)).toEqual(["shop/discountRules.py"]);
    expect(rows[0]!.why).toBe("imported by shop/checkout.py:1");
  });
});

describe("attachFrontierNeighbourIndex — flag and best effort", () => {
  const FILES = {
    "src/orderMath.ts": "import { widgetTotal } from './priceUtil.js';\nexport function sumWidgets(n: number): number { return widgetTotal(n); }\n",
    "src/priceUtil.ts": "export function widgetTotal(n: number): number { return n * 7; }\n",
  } as const;

  it("OFF: returns on the first line — the result is not even read", () => {
    const result = fakeResult([]);
    Object.defineProperty(result, "surfaces", { get: () => { throw new Error("read while OFF"); } });
    expect(() => attachFrontierNeighbourIndex(result, "/nonexistent", "q")).not.toThrow();
    expect(() => attachUsageInventory(result, "/nonexistent", "q")).not.toThrow();
  });

  it("OFF leaves a pack byte-identical", () => {
    const ws = makeWorkspace("off", FILES);
    const result = fakeResult([surface("src/orderMath.ts", FILES["src/orderMath.ts"])]);
    const before = JSON.stringify(result);
    attachFrontierNeighbourIndex(result, ws, "priceUtil");
    attachUsageInventory(result, ws, "sumWidgets");
    expect(JSON.stringify(result)).toBe(before);
  });

  it("ON: a failure while ranking leaves the pack exactly as it was", () => {
    process.env["TL_NEIGHBOUR_INDEX"] = "1";
    process.env["TL_USAGE_INVENTORY"] = "1";
    const ws = makeWorkspace("boom", FILES);
    const bad = surface("src/orderMath.ts", "x");
    Object.defineProperty(bad, "code", { get: () => { throw new Error("boom"); } });
    const result = fakeResult([bad]);
    expect(() => attachFrontierNeighbourIndex(result, ws, "q")).not.toThrow();
    expect(() => attachUsageInventory(result, ws, "q")).not.toThrow();
    expect(result.neighbours).toBeUndefined();
    expect(result.usages).toBeUndefined();
  });

  it("ON: attaches ranked rows", () => {
    process.env["TL_NEIGHBOUR_INDEX"] = "1";
    const ws = makeWorkspace("on", FILES);
    const result = fakeResult([surface("src/orderMath.ts", FILES["src/orderMath.ts"])]);
    attachFrontierNeighbourIndex(result, ws, "What does orderMath take from priceUtil?");
    expect(result.neighbours).toEqual([{ path: "src/priceUtil.ts", handle: expect.any(String), why: 'imported by src/orderMath.ts:1 (matches "priceUtil")' }]);
  });
});

// ===========================================================================
// FUI — stoplist, candidates, ranking
// ===========================================================================

describe("usage stoplist", () => {
  it("is one exported set holding the generic words, keywords and builtins (matched case-insensitively)", () => {
    for (const word of ["get", "set", "run", "main", "init", "data", "value", "self", "this", "true", "false", "null", "None", "String", "Object", "List", "Map", "int", "str"]) {
      expect(USAGE_SYMBOL_STOPLIST.has(word.toLowerCase()), word).toBe(true);
    }
    for (const word of ["return", "const", "function", "def", "func", "struct", "console", "Promise"]) expect(USAGE_SYMBOL_STOPLIST.has(word.toLowerCase()), word).toBe(true);
    expect(GENERIC_IDENTIFIER_STOPLIST.has("run")).toBe(true);
  });
});

describe("collectUsageCandidates / rankUsageCandidates", () => {
  const slice = (text: string, index = 0, p = "web/src/order.ts") => ({ index, path: p, text });
  const symbols = (cands: readonly UsageCandidate[]): string[] => cands.map((c) => c.symbol);

  it("references: CONST_CASE, PascalCase and the member of a qualified reference; not keywords, builtins, comments or imports", () => {
    const text = [
      "import { OtherThing } from './other';",
      "// MENTIONED_IN_A_COMMENT is not a reference",
      "export function submit(order: Order) {",
      "  if (order.items.length > MAX_ITEMS) throw new Error('x');",
      "  const s = OrderStatus.PENDING;",
      "  console.log(data, value, String(s));",
      "  return helperFn(order) + Config::LIMIT_HARD;",
      "}",
    ].join("\n");
    const cands = collectUsageCandidates([slice(text)], requestTermsOf(undefined));
    const found = symbols(cands);
    expect(found).toEqual(expect.arrayContaining(["submit", "MAX_ITEMS", "OrderStatus", "PENDING", "Order", "LIMIT_HARD"]));
    for (const absent of ["OtherThing", "MENTIONED_IN_A_COMMENT", "console", "log", "data", "value", "String", "Error", "helperFn", "items", "length", "return", "const"]) {
      expect(found, absent).not.toContain(absent);
    }
    const pending = cands.find((c) => c.symbol === "PENDING")!;
    expect(pending.qualifier).toBe("OrderStatus");
    expect(pending.kind).toBe("enum-member");
    expect(cands.find((c) => c.symbol === "MAX_ITEMS")!.kind).toBe("constant");
    expect(cands.find((c) => c.symbol === "OrderStatus")!.kind).toBe("type");
    expect(cands.find((c) => c.symbol === "MAX_ITEMS")!.declared).toBe(false);
    expect(cands.find((c) => c.symbol === "submit")!.declared).toBe(true);
  });

  it("a plain lower-case identifier enters the pool only when the request names or matches it", () => {
    const text = "export function submit() {\n  return retryDelay() + pageSize();\n}\n";
    expect(symbols(collectUsageCandidates([slice(text)], requestTermsOf(undefined)))).not.toContain("retryDelay");
    expect(symbols(collectUsageCandidates([slice(text)], requestTermsOf("How long is the retry delay?")))).toContain("retryDelay");
    expect(symbols(collectUsageCandidates([slice(text)], requestTermsOf("What does `pageSize` do?")))).toContain("pageSize");
  });

  it("a lower-case word that merely echoes a domain noun of the request (a parameter, a local) is not a candidate; a distinctive name is", () => {
    const text = "def total(invoice, order):\n    apply_discount(invoice)\n    return order.price\n";
    const found = symbols(collectUsageCandidates([slice(text, 0, "svc/billing.py")], requestTermsOf("How is the invoice order price discount applied?")));
    expect(found).not.toContain("invoice");
    expect(found).not.toContain("order");
    expect(found).not.toContain("price");
    expect(found).toContain("apply_discount");
  });

  it("well-known library exceptions and generic acronyms are not candidates", () => {
    const text = "throw new IllegalStateException(msg); throw new TypeError(); const u = API_URL + HTTP_OK; raise ValueError(x)\nsql = SQL_TEXT\n";
    const found = symbols(collectUsageCandidates([slice(text, 0, "svc/x.ts")], requestTermsOf(undefined)));
    for (const absent of ["IllegalStateException", "TypeError", "ValueError"]) expect(found, absent).not.toContain(absent);
    expect(found).toEqual(expect.arrayContaining(["API_URL", "HTTP_OK", "SQL_TEXT"])); // project constants with an acronym inside are still constants
  });

  it("`this.x` members count only when the request matches them; a distinctive member of a project type does, of a library type does not", () => {
    const text = [
      "export class Worker {",
      "  go() {",
      "    this.retryCount += 1;",
      "    this.pageSize = 3;",
      "    return OrderService.calculateTotalDue() + Promise.calculateEverythingNow();",
      "  }",
      "}",
      "",
    ].join("\n");
    const none = symbols(collectUsageCandidates([slice(text)], requestTermsOf(undefined)));
    expect(none).not.toContain("retryCount");
    expect(none).toContain("calculateTotalDue"); // OrderService.<distinctive>
    expect(none).not.toContain("calculateEverythingNow"); // Promise.<distinctive>: a library qualifier
    const found = symbols(collectUsageCandidates([slice(text)], requestTermsOf("How does the retry count grow?")));
    expect(found).toContain("retryCount");
    expect(found).not.toContain("pageSize");
  });

  it("a stoplisted word is inventoried only when the request names it explicitly", () => {
    const text = "def run():\n    return main(data)\n";
    expect(symbols(collectUsageCandidates([slice(text, 0, "svc/app.py")], requestTermsOf(undefined)))).toEqual([]);
    expect(symbols(collectUsageCandidates([slice(text, 0, "svc/app.py")], requestTermsOf("Who calls `run`?")))).toEqual(["run"]);
  });

  it("hyphenated / dotted tokens inside string literals count only when they hold a request concept term", () => {
    const text = 'export const view = () => <div className="btn priority-critical" data-event="order.created" />;\n';
    const withTerm = symbols(collectUsageCandidates([slice(text, 0, "web/src/View.tsx")], requestTermsOf("Where is the priority styling applied?")));
    expect(withTerm).toContain("priority-critical");
    expect(withTerm).not.toContain("order.created");
    expect(symbols(collectUsageCandidates([slice(text, 0, "web/src/View.tsx")], requestTermsOf(undefined)))).not.toContain("priority-critical");
    expect(symbols(collectUsageCandidates([slice(text, 0, "web/src/View.tsx")], requestTermsOf("When is the order.created event emitted?")))).toContain("order.created");
  });

  it("names in trailing comments (and strings inside them) are not references", () => {
    const text = 'export function f() {\n  return 1; // uses MAX_IN_COMMENT and "priority-in-comment"\n}\nexport const ok = "priority-real"; // fine\n';
    const found = symbols(collectUsageCandidates([slice(text)], requestTermsOf("Where is the priority set?")));
    expect(found).toContain("priority-real");
    expect(found).not.toContain("priority-in-comment");
    expect(found).not.toContain("MAX_IN_COMMENT");
    const py = "def f():\n    return 1  # MAX_IN_COMMENT_PY\nLIMIT_REAL = 3  # note\n";
    const pyFound = symbols(collectUsageCandidates([slice(py, 0, "svc/x.py")], requestTermsOf(undefined)));
    expect(pyFound).toContain("LIMIT_REAL");
    expect(pyFound).not.toContain("MAX_IN_COMMENT_PY");
  });

  it("style files contribute their hyphenated names under the same rule", () => {
    const css = ".btn { color: var(--color-priority-critical); }\n.priority-critical { font-weight: bold; }\n";
    const found = symbols(collectUsageCandidates([slice(css, 0, "web/src/app.css")], requestTermsOf("priority colors")));
    expect(found).toEqual(expect.arrayContaining(["color-priority-critical", "priority-critical"]));
  });

  it("rank: named > concept match (referenced constants first) > referenced elsewhere > first surface's declarations (exported first) > rest", () => {
    const text = [
      "function localHelper() { return 1; }",
      "export function exportedOne() { return MAX_RETRIES + SLOT_COUNT + RETRY_BACKOFF; }",
      "export function retryPolicy() { return 2; }",
      "",
    ].join("\n");
    const other = { index: 1, path: "web/src/other.ts", text: "export function secondSurfaceFn() { return 1; }\n" };
    const terms = requestTermsOf("How does the retry backoff work? See `exportedOne`.");
    const ranked = rankUsageCandidates(collectUsageCandidates([slice(text), other], terms), terms);
    const bySym = new Map(ranked.map((r) => [r.symbol, r]));
    expect(bySym.get("exportedOne")!.category).toBe(1);
    expect(bySym.get("RETRY_BACKOFF")!.category).toBe(2);
    expect(bySym.get("retryPolicy")!.category).toBe(2);
    // referenced-elsewhere constant beats a declared function inside category 2
    expect(ranked.findIndex((r) => r.symbol === "RETRY_BACKOFF")).toBeLessThan(ranked.findIndex((r) => r.symbol === "retryPolicy"));
    expect(bySym.get("MAX_RETRIES")!.category).toBe(2); // "retry"
    expect(bySym.get("SLOT_COUNT")!.category).toBe(3);
    expect(bySym.get("localHelper")!.category).toBe(4);
    expect(bySym.get("secondSurfaceFn")!.category).toBe(5);
    expect(ranked.findIndex((r) => r.symbol === "SLOT_COUNT")).toBeLessThan(ranked.findIndex((r) => r.symbol === "localHelper"));
    expect(ranked.findIndex((r) => r.symbol === "localHelper")).toBeGreaterThan(ranked.findIndex((r) => r.symbol === "SLOT_COUNT"));
  });

  it("rank: the exact spelling of a named identifier beats a case-insensitive one; exported declarations come first in category 4", () => {
    const text = "export function alphaTask() {}\nfunction betaTask() {}\nexport function gammaTask() {}\n";
    const terms = requestTermsOf("Look at `GAMMATASK`");
    const ranked = rankUsageCandidates(collectUsageCandidates([slice(text)], terms), terms);
    expect(ranked[0]!.symbol).toBe("gammaTask");
    expect(ranked[0]!.category).toBe(1);
    expect(ranked.slice(1).map((r) => r.symbol)).toEqual(["alphaTask", "betaTask"]);
  });

  it("rank: a container that shares only ONE concept term with the request does not lift its members", () => {
    const member: UsageCandidate = { symbol: "SENT", surfaceIndex: 0, path: "svc/status.py", kind: "enum-member", declared: true, declSurface: 0, exported: true, refs0: 0, literal: false, container: "InvoiceStatus", order: 0 };
    const terms = requestTermsOf("How is the invoice total computed?");
    expect(rankUsageCandidates([member], terms)[0]!.category).toBe(4);
    const two = requestTermsOf("How does the invoice status change?");
    expect(rankUsageCandidates([member], two)[0]!.category).toBe(2);
  });

  it("rank: members of a type the request is about follow the concept matches (container from the declaration scan)", () => {
    const members: UsageCandidate[] = ["PENDING", "SHIPPED"].map((symbol, i) => ({
      symbol, surfaceIndex: 0, path: "svc/Status.java", kind: "enum-member", declared: true, declSurface: 0, exported: true, refs0: 0, literal: false, container: "OrderStatus", order: i,
    }));
    const other: UsageCandidate = { symbol: "unrelatedThing", surfaceIndex: 0, path: "svc/Status.java", kind: "function", declared: true, declSurface: 0, exported: true, refs0: 0, literal: false, order: 5 };
    const terms = requestTermsOf("How does the OrderStatus lifecycle work?");
    const ranked = rankUsageCandidates([other, ...members], terms);
    expect(ranked.map((r) => r.symbol)).toEqual(["PENDING", "SHIPPED", "unrelatedThing"]);
    expect(ranked[0]!.category).toBe(2);
  });
});

describe("servedLineSpans — what the model already holds", () => {
  it("range minus remaining_ranges plus appended windows; a bodyless surface serves nothing", () => {
    const partial = surface("a.ts", "x", { range: "1-100", remaining_ranges: ["30-40", "90-100"], appended_windows: [{ marker: "m", range: "200-210" }] });
    const bodyless = surface("b.ts", "x", { range: "1-10" });
    delete (bodyless as { code?: string }).code;
    const unchanged = surface("c.ts", "x", { range: "5-9", code: undefined, code_unchanged: "same as before" });
    const spans = servedLineSpans([partial, bodyless, unchanged]);
    expect(spans.get("a.ts")).toEqual([[1, 29], [41, 89], [200, 210]]);
    expect(spans.has("b.ts")).toBe(false);
    expect(spans.get("c.ts")).toEqual([[5, 9]]);
  });
});

// ===========================================================================
// FUI — computeUsageInventory
// ===========================================================================

describe("computeUsageInventory — ranking against the request", () => {
  it("a query-named constant beats the first exported declaration", () => {
    const served = [
      "import { MAX_RETRIES } from './policy';",
      "export function firstExported() { return 1; }",
      "export function secondExported() { return MAX_RETRIES; }",
      "",
    ].join("\n");
    const ws = makeWorkspace("named", {
      "src/checkout.ts": served,
      "src/policy.ts": "export const MAX_RETRIES = 3;\n",
      "src/worker.ts": "import { MAX_RETRIES } from './policy';\nexport const w = MAX_RETRIES + 1;\n",
      "src/other.ts": "import { firstExported } from './checkout';\nexport const o = firstExported();\n",
    });
    const result = fakeResult([surface("src/checkout.ts", served)]);
    const rows = computeUsageInventory(result, ws, "Where is MAX_RETRIES enforced?");
    expect(rows[0]!.symbol).toBe("MAX_RETRIES");
    expect(rows[0]!.files.map((f) => f.path)).toEqual(["src/policy.ts", "src/worker.ts", "src/checkout.ts"]); // files with new matches first
    expect(rows.map((r) => r.symbol)).toContain("firstExported"); // still listed, after the query-named one
    // without a query the referenced constant still leads (declared elsewhere), then the declarations
    const noQuery = computeUsageInventory(result, ws);
    expect(noQuery[0]!.symbol).toBe("MAX_RETRIES");
  });

  it("an English concept term matches a sub-word: a referenced constant declared elsewhere leads", () => {
    const served = [
      "export function alphaFirst() { return 1; }",
      "export function retryLoop() { return RETRY_BACKOFF_MS + PAGE_SIZE; }",
      "",
    ].join("\n");
    const ws = makeWorkspace("concept-en", {
      "src/loop.ts": served,
      "src/consts.ts": "export const RETRY_BACKOFF_MS = 250;\nexport const PAGE_SIZE = 20;\n",
      "src/use.ts": "import { RETRY_BACKOFF_MS, PAGE_SIZE } from './consts';\nexport const a = RETRY_BACKOFF_MS + PAGE_SIZE;\nexport const b = alphaFirst;\n",
    });
    const result = fakeResult([surface("src/loop.ts", served)]);
    const rows = computeUsageInventory(result, ws, "How does the retry backoff grow?");
    expect(rows[0]!.symbol).toBe("RETRY_BACKOFF_MS");
    expect(rows.map((r) => r.symbol).indexOf("PAGE_SIZE")).toBeGreaterThan(0);
  });

  it("a Japanese concept term matches through the glossary", () => {
    const served = [
      "export function zetaFirst() { return 1; }",
      "export function price(n: number) { return n * DISCOUNT_RATE + TAX_RATE; }",
      "",
    ].join("\n");
    const ws = makeWorkspace("concept-ja", {
      "src/price.ts": served,
      "src/rates.ts": "export const DISCOUNT_RATE = 0.9;\nexport const TAX_RATE = 1.1;\n",
      "src/report.ts": "import { DISCOUNT_RATE, TAX_RATE } from './rates';\nexport const r = [DISCOUNT_RATE, TAX_RATE, zetaFirst];\n",
    });
    const result = fakeResult([surface("src/price.ts", served)]);
    const rows = computeUsageInventory(result, ws, "割引はどのように計算されますか");
    expect(rows[0]!.symbol).toBe("DISCOUNT_RATE");
  });

  it("a constant referenced in the first surface but declared elsewhere precedes that surface's own declarations", () => {
    const served = "export function computeTotal(n: number) { return n * TAX_RATE; }\nexport function otherThing() { return 1; }\n";
    const ws = makeWorkspace("elsewhere", {
      "src/total.ts": served,
      "src/rates.ts": "export const TAX_RATE = 1.1;\n",
      "src/ui.ts": "import { TAX_RATE } from './rates';\nimport { computeTotal, otherThing } from './total';\nexport const x = [TAX_RATE, computeTotal, otherThing];\n",
    });
    const result = fakeResult([surface("src/total.ts", served)]);
    const rows = computeUsageInventory(result, ws);
    expect(rows.map((r) => r.symbol)).toEqual(["TAX_RATE", "computeTotal", "otherThing"]);
  });

  it("the first SERVED surface is the one with a body: a bodyless first surface does not demote referenced constants", () => {
    const served = "export function computeTotal(n: number) { return n * TAX_RATE; }\nexport function otherThing() { return 1; }\n";
    const ws = makeWorkspace("bodyless-first", {
      "src/stub.ts": "export const stub = 1;\n",
      "src/total.ts": served,
      "src/rates.ts": "export const TAX_RATE = 1.1;\n",
      "src/ui.ts": "import { TAX_RATE } from './rates';\nimport { computeTotal, otherThing } from './total';\nexport const x = [TAX_RATE, computeTotal, otherThing];\n",
    });
    const stub = surface("src/stub.ts", "");
    delete (stub as { code?: string }).code;
    const rows = computeUsageInventory(fakeResult([stub, surface("src/total.ts", served)]), ws);
    expect(rows.map((r) => r.symbol).slice(0, 3)).toEqual(["TAX_RATE", "computeTotal", "otherThing"]);
  });

  it("adds nothing: a symbol whose every match lies inside the served slices is left out", () => {
    const served = "export function alone() { return LOCAL_ONLY + SHARED_LIMIT; }\nconst LOCAL_ONLY = 1;\n";
    const ws = makeWorkspace("nothing-new", {
      "src/alone.ts": served,
      "src/lib.ts": "export const SHARED_LIMIT = 5;\n",
    });
    const result = fakeResult([surface("src/alone.ts", served)]);
    const symbols = computeUsageInventory(result, ws).map((r) => r.symbol);
    expect(symbols).toContain("SHARED_LIMIT");
    expect(symbols).not.toContain("LOCAL_ONLY");
    expect(symbols).not.toContain("alone"); // declared and used only in the served slice
  });

  it("adds nothing is decided per LINE: a use in an unserved span of the same file is new", () => {
    const file = [
      "export function first() { return CAP; }", // 1 (served)
      "// filler",                                 // 2 (served)
      "export function later() { return CAP; }",  // 3 (NOT served)
      "export const CAP = 4;",                    // 4 (served)
    ].join("\n") + "\n";
    const ws = makeWorkspace("partial", { "src/cap.ts": file });
    const servedText = "export function first() { return CAP; }\n// filler\n";
    const partial = fakeResult([surface("src/cap.ts", servedText, { range: "1-4", remaining_ranges: ["3-4"], content_completeness: "partial" })]);
    const rows = computeUsageInventory(partial, ws, "How is CAP applied?");
    const cap = rows.find((r) => r.symbol === "CAP")!;
    expect(cap).toBeDefined();
    expect(cap.files).toEqual([{ path: "src/cap.ts", lines: [1, 3, 4] }]);
    expect(cap.total).toBe(3);
    // the same file served whole: nothing new
    const whole = fakeResult([surface("src/cap.ts", file)]);
    expect(computeUsageInventory(whole, ws, "How is CAP applied?").map((r) => r.symbol)).not.toContain("CAP");
  });

  it("stoplisted generic words are never inventoried unless the request names them", () => {
    const served = "def run(data, value):\n    return main(data) + value\n";
    const ws = makeWorkspace("stop", { "svc/app.py": served, "svc/use.py": "from app import run, main\nrun(1, 2)\nmain(3)\n" });
    const result = fakeResult([surface("svc/app.py", served)]);
    expect(computeUsageInventory(result, ws)).toEqual([]);
    expect(computeUsageInventory(result, ws, "Who calls `run`?").map((r) => r.symbol)).toEqual(["run"]);
  });

  it("a request-explained string-literal key is inventoried with the files that use it", () => {
    const served = 'export const Badge = () => <span className="priority-critical">!</span>;\n';
    const ws = makeWorkspace("css", {
      "web/src/Badge.tsx": served,
      "web/src/app.css": ".priority-critical { color: red; }\n.other { color: blue; }\n",
      "web/src/List.tsx": 'export const L = () => <li className="priority-critical" />;\n',
    });
    const result = fakeResult([surface("web/src/Badge.tsx", served)]);
    const rows = computeUsageInventory(result, ws, "Where is the priority styling defined?");
    const entry = rows.find((r) => r.symbol === "priority-critical")!;
    expect(entry).toBeDefined();
    expect(entry.files.map((f) => f.path).sort()).toEqual(["web/src/Badge.tsx", "web/src/List.tsx", "web/src/app.css"]);
    expect(computeUsageInventory(result, ws).map((r) => r.symbol)).not.toContain("priority-critical");
  });

  it("files list the declaring file first, then files with a match the model does not hold, then the ones it already holds", () => {
    // v0.15.0 refinement R2 — old: a fixture whose served file DECLARED the symbol listed the unserved user first
    // (["src/z_other.ts", "src/a_served.ts"]); the definition site now leads (see the R2 tests below).
    const served = "import { LIMIT } from './lib';\nexport function tally() { return LIMIT; }\n";
    const ws = makeWorkspace("order-files", {
      "src/lib.ts": "export const LIMIT = 3;\n",
      "src/served.ts": served,
      "src/y_other.ts": "import { LIMIT } from './lib';\nexport const y = LIMIT;\n",
      "src/z_other.ts": "import { LIMIT } from './lib';\nexport const z = LIMIT;\n",
    });
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, "What is LIMIT?");
    expect(rows[0]!.files.map((f) => f.path)).toEqual(["src/lib.ts", "src/y_other.ts", "src/z_other.ts", "src/served.ts"]);
    // a symbol the SERVED file declares: that declaration still leads, the user the model does not hold follows
    const own = "export function tally() { return OWN_LIMIT; }\nexport const OWN_LIMIT = 3;\n";
    const ws2 = makeWorkspace("order-files2", { "src/a_served.ts": own, "src/z_other.ts": "import { OWN_LIMIT } from './a_served';\nexport const z = OWN_LIMIT;\n" });
    const rows2 = computeUsageInventory(fakeResult([surface("src/a_served.ts", own)]), ws2, "What is OWN_LIMIT?");
    expect(rows2[0]!.files.map((f) => f.path)).toEqual(["src/a_served.ts", "src/z_other.ts"]);
  });
});

// ===========================================================================
// Scope
// ===========================================================================

describe("inventoryScopeOf", () => {
  it("no manifest at all: the whole workspace", () => {
    const ws = makeWorkspace("scope-none", { "src/a.ts": "" });
    expect(inventoryScopeOf(ws, "src/a.ts")).toBe("");
  });

  it("a nested project with its own manifest and no workspace root: its own root", () => {
    const ws = makeWorkspace("scope-own", { "web/package.json": "{}", "web/src/a.ts": "", "svc/pyproject.toml": "", "svc/app/b.py": "" });
    expect(inventoryScopeOf(ws, "web/src/a.ts")).toBe("web");
    expect(inventoryScopeOf(ws, "svc/app/b.py")).toBe("svc");
  });

  it("npm workspaces: a member climbs to the workspace root (array and {packages} forms)", () => {
    const ws = makeWorkspace("scope-npm", { "package.json": JSON.stringify({ workspaces: ["packages/*"] }), "packages/web/package.json": "{}", "packages/web/src/a.ts": "" });
    expect(inventoryScopeOf(ws, "packages/web/src/a.ts")).toBe("");
    const ws2 = makeWorkspace("scope-npm2", { "package.json": JSON.stringify({ workspaces: { packages: ["apps/**"] } }), "apps/x/y/package.json": "{}", "apps/x/y/a.ts": "" });
    expect(inventoryScopeOf(ws2, "apps/x/y/a.ts")).toBe("");
  });

  it("a nested project under a repository-root package.json that does NOT list it: its own root", () => {
    const ws = makeWorkspace("scope-nonmember", {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/web/package.json": "{}",
      "tools/cli/package.json": "{}",
      "tools/cli/src/a.ts": "",
    });
    expect(inventoryScopeOf(ws, "tools/cli/src/a.ts")).toBe("tools/cli");
    const ws2 = makeWorkspace("scope-nows", { "package.json": '{"name":"root"}', "web/package.json": "{}", "web/a.ts": "" });
    expect(inventoryScopeOf(ws2, "web/a.ts")).toBe("web");
  });

  it("pnpm-workspace.yaml globs with negation", () => {
    const yaml = "packages:\n  - 'packages/*'\n  - \"apps/**\"\n  - '!packages/legacy'\n";
    const files = { "package.json": "{}", "pnpm-workspace.yaml": yaml, "packages/a/package.json": "{}", "packages/a/x.ts": "", "packages/legacy/package.json": "{}", "packages/legacy/x.ts": "" };
    const ws = makeWorkspace("scope-pnpm", files);
    expect(inventoryScopeOf(ws, "packages/a/x.ts")).toBe("");
    expect(inventoryScopeOf(ws, "packages/legacy/x.ts")).toBe("packages/legacy"); // excluded → not a member
  });

  it("lerna.json packages", () => {
    const ws = makeWorkspace("scope-lerna", { "package.json": '{"name":"root"}', "lerna.json": JSON.stringify({ packages: ["pkgs/*"] }), "pkgs/a/package.json": "{}", "pkgs/a/x.ts": "" });
    expect(inventoryScopeOf(ws, "pkgs/a/x.ts")).toBe("");
  });

  it("go.work `use` (block and single forms)", () => {
    const ws = makeWorkspace("scope-gowork", {
      "go.work": "go 1.22\n\nuse (\n\t./svc/api\n\t./svc/worker\n)\nuse ./tools/gen\n",
      "svc/api/go.mod": "module a\n", "svc/api/main.go": "package main\n",
      "tools/gen/go.mod": "module g\n", "tools/gen/g.go": "package gen\n",
      "other/go.mod": "module o\n", "other/o.go": "package o\n",
    });
    expect(inventoryScopeOf(ws, "svc/api/main.go")).toBe("");
    expect(inventoryScopeOf(ws, "tools/gen/g.go")).toBe("");
    expect(inventoryScopeOf(ws, "other/o.go")).toBe("other");
  });

  it("Maven <modules> aggregates a chain of modules", () => {
    const ws = makeWorkspace("scope-pom", {
      "pom.xml": "<project><modules><module>services</module><!-- <module>ghost</module> --></modules></project>",
      "services/pom.xml": "<project><modules><module>api</module></modules></project>",
      "services/api/pom.xml": "<project/>",
      "services/api/src/main/java/a/A.java": "class A {}",
      "standalone/pom.xml": "<project/>",
      "standalone/src/main/java/b/B.java": "class B {}",
    });
    expect(inventoryScopeOf(ws, "services/api/src/main/java/a/A.java")).toBe("");
    expect(inventoryScopeOf(ws, "standalone/src/main/java/b/B.java")).toBe("standalone");
  });

  it("Gradle settings include (Groovy and Kotlin DSL, ':a:b' project paths)", () => {
    const ws = makeWorkspace("scope-gradle", {
      "settings.gradle": "rootProject.name = 'r'\ninclude ':app', ':libs:core'\n",
      "app/build.gradle": "", "app/src/A.java": "",
      "libs/core/build.gradle": "", "libs/core/src/C.java": "",
      "loose/build.gradle": "", "loose/src/L.java": "",
    });
    expect(inventoryScopeOf(ws, "app/src/A.java")).toBe("");
    expect(inventoryScopeOf(ws, "libs/core/src/C.java")).toBe("");
    expect(inventoryScopeOf(ws, "loose/src/L.java")).toBe("loose");
    const kts = makeWorkspace("scope-gradle-kts", { "settings.gradle.kts": 'include(":app", ":lib")\n', "lib/build.gradle.kts": "", "lib/L.kt": "" });
    expect(inventoryScopeOf(kts, "lib/L.kt")).toBe("");
  });

  it("CMake add_subdirectory names the project or one of its ancestors", () => {
    // (final round, P1-6: a listed directory is a member only when it holds a CMakeLists.txt of its own — `libs` now does, as a
    // real `add_subdirectory(libs)` requires; before, the fixture listed a directory that was no CMake project at all)
    const ws = makeWorkspace("scope-cmake", {
      "CMakeLists.txt": "project(top)\nadd_subdirectory(libs)\nadd_subdirectory(\"apps/cli\")\n# add_subdirectory(ghost)\n",
      "libs/CMakeLists.txt": "add_subdirectory(foo)\n",
      "libs/foo/CMakeLists.txt": "project(foo)\n", "libs/foo/foo.c": "",
      "apps/cli/CMakeLists.txt": "project(cli)\n", "apps/cli/main.c": "",
      "third/bar/CMakeLists.txt": "project(bar)\n", "third/bar/bar.c": "",
    });
    expect(inventoryScopeOf(ws, "libs/foo/foo.c")).toBe(""); // `libs` is an ancestor of libs/foo
    expect(inventoryScopeOf(ws, "apps/cli/main.c")).toBe("");
    expect(inventoryScopeOf(ws, "third/bar/bar.c")).toBe("third/bar"); // not listed
  });

  it("Cargo [workspace] members and exclude, uv workspace members, Meson subdir", () => {
    const cargo = makeWorkspace("scope-cargo", {
      "Cargo.toml": '[workspace]\nmembers = [\n  "crates/*", # all crates\n]\nexclude = ["crates/skip"]\n',
      "crates/a/Cargo.toml": "[package]\n", "crates/a/src/lib.rs": "",
      "crates/skip/Cargo.toml": "[package]\n", "crates/skip/src/lib.rs": "",
    });
    expect(inventoryScopeOf(cargo, "crates/a/src/lib.rs")).toBe("");
    expect(inventoryScopeOf(cargo, "crates/skip/src/lib.rs")).toBe("crates/skip");
    const uv = makeWorkspace("scope-uv", {
      "pyproject.toml": '[project]\nname = "root"\n[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      "packages/a/pyproject.toml": "[project]\n", "packages/a/a/mod.py": "",
    });
    expect(inventoryScopeOf(uv, "packages/a/a/mod.py")).toBe("");
    const meson = makeWorkspace("scope-meson", {
      "meson.build": "project('p')\nsubdir('src')\n", "src/meson.build": "subdir('core')\n", "src/core/meson.build": "", "src/core/core.c": "",
      "vendorish/meson.build": "", "vendorish/v.c": "",
    });
    expect(inventoryScopeOf(meson, "src/core/core.c")).toBe("");
    expect(inventoryScopeOf(meson, "vendorish/v.c")).toBe("vendorish");
  });

  it("a config-only manifest (tsconfig.json, Makefile) beside or below a project root is transparent", () => {
    const ws = makeWorkspace("scope-weak", {
      "package.json": '{"name":"root"}', "src/tsconfig.json": "{}", "src/a.ts": "",
      "lib/Makefile": "all:\n", "lib/x.c": "",
    });
    expect(inventoryScopeOf(ws, "src/a.ts")).toBe(""); // src/tsconfig.json is not a project of its own
    expect(inventoryScopeOf(ws, "lib/x.c")).toBe(""); // nearest STRONG root is the workspace's package.json
    const weakOnly = makeWorkspace("scope-weak-only", { "libfoo/Makefile": "all:\n", "libfoo/x.c": "", "libbar/Makefile": "all:\n", "libbar/y.c": "" });
    expect(inventoryScopeOf(weakOnly, "libfoo/x.c")).toBe("libfoo");
  });

  it("an autotools or Bazel project root (configure.ac, WORKSPACE, MODULE.bazel) is a project of its own; a recursive Makefile below it is not", () => {
    const ws = makeWorkspace("scope-autotools", {
      "pkg/configure.ac": "AC_INIT([pkg],[1])\n", "pkg/src/Makefile": "all:\n", "pkg/src/a.c": "",
      "mono/WORKSPACE": "workspace(name = 'mono')\n", "mono/lib/BUILD": "", "mono/lib/b.cc": "",
      "bz/MODULE.bazel": "module(name = 'bz')\n", "bz/app/Makefile": "all:\n", "bz/app/c.c": "",
    });
    expect(inventoryScopeOf(ws, "pkg/src/a.c")).toBe("pkg");
    expect(inventoryScopeOf(ws, "mono/lib/b.cc")).toBe("mono");
    expect(inventoryScopeOf(ws, "bz/app/c.c")).toBe("bz");
  });

  it("manifests are cached by mtime+size: an edited manifest is re-read", () => {
    const ws = makeWorkspace("scope-cache", { "package.json": '{"name":"root"}', "web/package.json": "{}", "web/a.ts": "" });
    expect(inventoryScopeOf(ws, "web/a.ts")).toBe("web");
    put(ws, "package.json", JSON.stringify({ name: "root", workspaces: ["web"] }));
    expect(inventoryScopeOf(ws, "web/a.ts")).toBe("");
  });

  it("never reads outside the workspace: a member path that escapes is not a member", () => {
    const ws = makeWorkspace("scope-escape", { "package.json": JSON.stringify({ workspaces: ["../elsewhere", "web/../../x"] }), "web/package.json": "{}", "web/a.ts": "" });
    expect(inventoryScopeOf(ws, "web/a.ts")).toBe("web");
  });
});

describe("computeUsageInventory — scope on the wire", () => {
  const SERVED = [
    "import { MAX_ITEMS } from './limits';",
    "export function addItem(cart: number[]) {",
    "  if (cart.length >= MAX_ITEMS) throw new Error('full');",
    "  return cart.length;",
    "}",
    "",
  ].join("\n");

  it("a nested project scans only itself: the same name in a sibling project does not appear, and `scope` says so", () => {
    const ws = makeWorkspace("wire-scope", {
      "package.json": '{"name":"repo","private":true}',
      "web/package.json": '{"name":"web"}',
      "web/src/checkout.ts": SERVED,
      "web/src/limits.ts": "export const MAX_ITEMS = 10;\n",
      "web/src/cart.ts": "import { MAX_ITEMS } from './limits';\nexport const cap = MAX_ITEMS * 2;\n",
      "svc/pyproject.toml": "[project]\nname='svc'\n",
      "svc/app/limits.py": "MAX_ITEMS = 10\nprint(MAX_ITEMS)\n",
    });
    const result = fakeResult([surface("web/src/checkout.ts", SERVED)]);
    const rows = computeUsageInventory(result, ws, "How is MAX_ITEMS enforced?");
    const entry = rows.find((r) => r.symbol === "MAX_ITEMS")!;
    expect(entry.scope).toBe("web");
    expect(entry.files.map((f) => f.path).sort()).toEqual(["web/src/cart.ts", "web/src/checkout.ts", "web/src/limits.ts"]);
    expect(JSON.stringify(rows)).not.toContain("svc/");
    expect(entry.total).toBe(5);
    expect(entry.inventory_complete).toBe(true);
  });

  it("a whole-workspace scan carries no `scope`", () => {
    const ws = makeWorkspace("wire-noscope", {
      "src/checkout.ts": SERVED,
      "src/limits.ts": "export const MAX_ITEMS = 10;\n",
      "svc/limits.py": "MAX_ITEMS = 10\n",
    });
    const rows = computeUsageInventory(fakeResult([surface("src/checkout.ts", SERVED)]), ws, "How is MAX_ITEMS enforced?");
    const entry = rows.find((r) => r.symbol === "MAX_ITEMS")!;
    expect("scope" in entry).toBe(false);
    expect(entry.files.map((f) => f.path)).toContain("svc/limits.py");
  });

  it("a workspace member scans the whole build (the sibling member is included)", () => {
    const ws = makeWorkspace("wire-member", {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "packages/web/package.json": "{}",
      "packages/web/src/checkout.ts": SERVED,
      "packages/shared/package.json": "{}",
      "packages/shared/src/limits.ts": "export const MAX_ITEMS = 10;\n",
    });
    const rows = computeUsageInventory(fakeResult([surface("packages/web/src/checkout.ts", SERVED)]), ws, "How is MAX_ITEMS enforced?");
    const entry = rows.find((r) => r.symbol === "MAX_ITEMS")!;
    expect("scope" in entry).toBe(false);
    expect(entry.files.map((f) => f.path)).toContain("packages/shared/src/limits.ts");
  });

  it("surfaces of two projects: each symbol is scanned in the project of the surface it came from", () => {
    const ws = makeWorkspace("wire-two", {
      "web/package.json": "{}",
      "web/src/a.ts": "export function webFn() { return WEB_LIMIT; }\n",
      "web/src/consts.ts": "export const WEB_LIMIT = 1;\n",
      "svc/pyproject.toml": "[project]\n",
      "svc/app/b.py": "def svc_fn():\n    return SVC_LIMIT\n",
      "svc/app/consts.py": "SVC_LIMIT = 2\n",
    });
    const result = fakeResult([
      surface("web/src/a.ts", "export function webFn() { return WEB_LIMIT; }\n"),
      surface("svc/app/b.py", "def svc_fn():\n    return SVC_LIMIT\n"),
    ]);
    const rows = computeUsageInventory(result, ws, "Explain WEB_LIMIT and SVC_LIMIT");
    expect(rows.find((r) => r.symbol === "WEB_LIMIT")!.scope).toBe("web");
    expect(rows.find((r) => r.symbol === "SVC_LIMIT")!.scope).toBe("svc");
  });
});

// ===========================================================================
// Byte caps
// ===========================================================================

describe("computeUsageInventory — caps and R1 (breadth over depth)", () => {
  const SEG = "long_directory_segment_name_that_pads_paths";

  /**
   * `count` constants named by the query in order; each is matched on 4 lines of each of `fileCount` files
   * (`src/<dir>N/mN.ts`, `dirLen` characters of directory name) plus once in the served file.
   */
  function crowd(count: number, fileCount: number, dirLen: number): {
    files: Record<string, string>;
    served: string;
    symbols: string[];
    dir: string;
    fullEntries: (filesShown: number, linesShown: number) => UsageEntry[];
  } {
    const symbols = Array.from({ length: count }, (_, i) => `CROWD_${String.fromCharCode(65 + i)}_LIMIT`);
    const served = `export function servedCrowd() { return ${symbols.join(" + ")}; }\n`;
    const dir = "d".repeat(dirLen);
    const files: Record<string, string> = { "src/served.ts": served };
    for (let f = 0; f < fileCount; f++) {
      files[`src/${dir}${f}/m${f}.ts`] = symbols.flatMap((s) => [1, 2, 3, 4].map((k) => `export const u${f}_${s}_${k} = ${s};`)).join("\n") + "\n";
    }
    // exactly what the inventory renders when `filesShown` files of `linesShown` lines are kept for every symbol
    const fullEntries = (filesShown: number, linesShown: number): UsageEntry[] => symbols.map((symbol, s) => ({
      symbol,
      files: Array.from({ length: Math.min(filesShown, fileCount) }, (_, f) => ({
        path: `src/${dir}${f}/m${f}.ts`,
        lines: [1, 2, 3, 4].slice(0, linesShown).map((k) => s * 4 + k),
      })),
      total: 4 * fileCount + 1,
      inventory_complete: false,
    }));
    return { files, served, symbols, dir, fullEntries };
  }
  const bytesOf = (entries: readonly UsageEntry[]): number => Buffer.byteLength(JSON.stringify(entries), "utf8");

  it("R1: an entry lists at most 4 files of 3 lines, `total` stays exact, and a trimmed entry says so", () => {
    const { files, served, symbols } = crowd(1, 7, 4);
    const ws = makeWorkspace("r1-caps", files);
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, `Explain ${symbols[0]}`);
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.files).toHaveLength(4);
    for (const file of entry.files) expect(file.lines).toHaveLength(3);
    expect(entry.total).toBe(4 * 7 + 1); // every matched line, listed or not
    expect(entry.inventory_complete).toBe(false);
    // an entry that fits whole is complete: 2 files x 2 lines
    const small = makeWorkspace("r1-small", { "src/served.ts": "export function s() { return SMALL_LIMIT; }\n", "src/a.ts": "import {SMALL_LIMIT} from './b';\nvoid SMALL_LIMIT;\n", "src/b.ts": "export const SMALL_LIMIT = 1;\n" });
    const done = computeUsageInventory(fakeResult([surface("src/served.ts", "export function s() { return SMALL_LIMIT; }\n")]), small, "Explain SMALL_LIMIT")[0]!;
    expect(done.inventory_complete).toBe(true);
    expect(done.files.length).toBeLessThanOrEqual(4);
  });

  it("R1: under the byte cap LINES are trimmed first (lowest-ranked entry first) — no entry loses a file while that is enough", () => {
    const { files, served, symbols, fullEntries } = crowd(6, 5, 9);
    // the fixture forces the cap: untrimmed the six entries overflow, with one line per file they fit
    expect(bytesOf(fullEntries(4, 3))).toBeGreaterThan(1536);
    expect(bytesOf(fullEntries(4, 1))).toBeLessThanOrEqual(1536);
    const ws = makeWorkspace("r1-lines", files);
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, `Explain ${symbols.join(", ")}`);
    expect(bytesOf(rows)).toBeLessThanOrEqual(1536);
    expect(rows.map((r) => r.symbol)).toEqual(symbols); // all six survive, in rank order
    for (const row of rows) {
      expect(row.files).toHaveLength(4); // no file was needed
      expect(row.total).toBe(4 * 5 + 1);
      expect(row.inventory_complete).toBe(false);
    }
    const maxLines = rows.map((r) => Math.max(...r.files.map((f) => f.lines.length)));
    for (let i = 1; i < maxLines.length; i++) expect(maxLines[i]!).toBeLessThanOrEqual(maxLines[i - 1]!); // detail never grows down the ranking
    expect(maxLines[maxLines.length - 1]).toBe(1); // the lowest-ranked entry is the one that gave up its lines
    expect(maxLines[0]).toBeGreaterThan(1); // the top entry kept some
  });

  it("R1: only when lines cannot make it fit are FILES trimmed, lowest-ranked first; an entry is dropped last of all", () => {
    const { files, served, symbols, fullEntries } = crowd(6, 5, 16);
    expect(bytesOf(fullEntries(4, 1))).toBeGreaterThan(1536); // one line per file is not enough here
    expect(bytesOf(fullEntries(1, 1))).toBeLessThanOrEqual(1536);
    const ws = makeWorkspace("r1-files", files);
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, `Explain ${symbols.join(", ")}`);
    expect(bytesOf(rows)).toBeLessThanOrEqual(1536);
    expect(rows.map((r) => r.symbol)).toEqual(symbols); // still all six symbols
    for (const row of rows) for (const file of row.files) expect(file.lines).toHaveLength(1); // lines were trimmed first, everywhere
    const fileCounts = rows.map((r) => r.files.length);
    for (let i = 1; i < fileCounts.length; i++) expect(fileCounts[i]!).toBeLessThanOrEqual(fileCounts[i - 1]!);
    expect(fileCounts[fileCounts.length - 1]).toBeLessThan(fileCounts[0]!);
    for (const row of rows) expect(row.total).toBe(4 * 5 + 1);
  });

  it("R1: entries are dropped, lowest-ranked first and never reordered, only when every entry is already one file of one line", () => {
    const { files, served, symbols } = crowd(6, 5, 200);
    const ws = makeWorkspace("r1-drop", files);
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, `Explain ${symbols.join(", ")}`);
    expect(bytesOf(rows)).toBeLessThanOrEqual(1536);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(6);
    expect(rows.map((r) => r.symbol)).toEqual(symbols.slice(0, rows.length));
    for (const row of rows) {
      expect(row.files).toHaveLength(1);
      expect(row.files[0]!.lines).toHaveLength(1);
    }
  });

  it("a top entry that alone overflows is shrunk and marked incomplete, not dropped", () => {
    const deep = Array.from({ length: 6 }, (_, i) => `${SEG}${i}`).join("/");
    const served = "export function servedFn() { return HUGE_LIMIT; }\n";
    const files: Record<string, string> = { "src/served.ts": served };
    for (let f = 0; f < 8; f++) files[`src/${deep}_${f}/${deep}/m${f}.ts`] = "export const x = HUGE_LIMIT;\nexport const y = HUGE_LIMIT;\n";
    const ws = makeWorkspace("cap-top", files);
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, "Explain HUGE_LIMIT");
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.symbol).toBe("HUGE_LIMIT");
    expect(bytesOf(rows)).toBeLessThanOrEqual(1536);
    expect(entry.inventory_complete).toBe(false);
    expect(entry.files.length).toBeLessThan(4); // below even the 4-file default: the cap trimmed it
    expect(entry.files.length).toBeGreaterThan(0);
    expect(entry.total).toBe(1 + 8 * 2); // honest count: the served use line plus 2 lines in each of the 8 files
  });

  it("at most 8 symbols, 4 files per symbol, 3 lines per file", () => {
    // v0.15.0 refinement R1 — old: 8 files x 8 lines per symbol; final round F4 — old: at most 6 symbols
    const symbols = Array.from({ length: 9 }, (_, i) => `CAPPED_${String.fromCharCode(65 + i)}_VALUE`);
    const served = `export function servedFn() { return ${symbols.join(" + ")}; }\n`;
    const files: Record<string, string> = { "src/served.ts": served };
    for (let f = 0; f < 10; f++) files[`src/m${f}.ts`] = Array.from({ length: 10 }, () => `export const z = ${symbols[0]};`).join("\n") + "\n" + symbols.map((s) => `void ${s};`).join("\n") + "\n";
    const ws = makeWorkspace("cap-counts", files);
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, `Explain ${symbols.join(" ")}`);
    expect(rows.length).toBeLessThanOrEqual(8);
    const first = rows[0]!;
    expect(first.files.length).toBeLessThanOrEqual(4);
    expect(first.files.every((f) => f.lines.length <= 3)).toBe(true);
    expect(first.inventory_complete).toBe(false);
  });
});

// ===========================================================================
// Refinement round — R2 the declaring file first
// ===========================================================================

describe("R2 — the declaring file leads an entry", () => {
  it("declaresSymbol recognises the declaration forms of the common languages and rejects uses", () => {
    const cases: Array<[string, string, boolean]> = [
      ["export const MAX_RETRIES = 3;", "MAX_RETRIES", true],
      ["class Foo extends Bar {", "Foo", true], ["class Foo extends Bar {", "Bar", false],
      ["def total(x):", "total", true], ["async def total(x):", "total", true],
      ["#define BUF_SIZE 256", "BUF_SIZE", true], ["# define BUF_SIZE 256", "BUF_SIZE", true],
      ["typedef struct store store_t;", "store_t", true],
      ["func (s *Store) Post(e Entry) error {", "Post", true], ["func Post(e Entry) error {", "Post", true],
      ["  PENDING = 'pending',", "PENDING", true],
      ["let y: Foo = make()", "Foo", false], ["let y: Foo = make()", "y", true], ["let mut count = 0;", "count", true],
      ["x = MAX_RETRIES + 1", "MAX_RETRIES", false], ["if (MAX == 3) {", "MAX", false], ["if MAX == 3:", "MAX", false],
      ["using Alias = std::string;", "Alias", true], ["using namespace std;", "std", false], ["namespace std {", "std", true],
      ["public static final int LIMIT = 3;", "LIMIT", true], ["…static final int LIMIT = 3;", "LIMIT", true],
      ["MAX_RETRIES := 5", "MAX_RETRIES", true],
      ["static Foo instance;", "Foo", false], ["static Foo instance;", "instance", true],
      ["const std::string NAME = \"x\";", "NAME", true], ["const char *NAME[] = {", "NAME", true],
      ["catch (final Exception e) {", "e", false], ["var y Foo = x", "Foo", false], ["var y Foo = x", "y", true],
      ["enum class Color { Red };", "Color", true], ["enum Status { PENDING }", "Status", true],
      ["interface Repo<T> {", "Repo", true], ["type Entry struct {", "Entry", true], ["type Entry = { a: 1 }", "Entry", true],
      ["const x = new Foo();", "Foo", false], ["import Foo from './foo';", "Foo", false], ["return Foo;", "Foo", false],
      ["struct Foo *p = NULL;", "Foo", false], ["struct Foo {", "Foo", true],
      ["fn compute(x: u32) -> u32 {", "compute", true], ["fun compute(x: Int): Int {", "compute", true], ["val LIMIT = 3", "LIMIT", true],
      ["macro_rules! my_macro {", "my_macro", true], ["object Registry {", "Registry", true],
    ];
    for (const [text, symbol, expected] of cases) expect(declaresSymbol(text, symbol), `${symbol} <- ${text}`).toBe(expected);
    // stylesheets: a custom property or a selector defines the name, a use does not
    expect(declaresSymbol("--color-priority: red;", "color-priority", true)).toBe(true);
    expect(declaresSymbol(".priority-critical {", "priority-critical", true)).toBe(true);
    expect(declaresSymbol(".btn.priority-critical:hover,", "priority-critical", true)).toBe(true);
    expect(declaresSymbol("  color: var(--color-priority);", "color-priority", true)).toBe(false);
  });

  it("the file whose matched line declares the symbol comes first, and the declaring line is among its kept lines", () => {
    const served = "export function useIt() { return LATE_CONSTANT; }\n";
    const files: Record<string, string> = { "src/a_served.ts": served };
    for (let i = 1; i <= 5; i++) files[`src/b${i}.ts`] = Array.from({ length: 4 }, (_, k) => `void LATE_CONSTANT; // ${k}`).join("\n") + "\n";
    // the definition sorts LAST, has six use lines before the declaration on line 8 — more matched lines than the 3 that fit
    files["src/z_definition.ts"] = "// definitions\n" + Array.from({ length: 6 }, (_, i) => `export const f${i} = LATE_CONSTANT * ${i};`).join("\n") + "\nexport const LATE_CONSTANT = 9;\n";
    const ws = makeWorkspace("r2-decl", files);
    const rows = computeUsageInventory(fakeResult([surface("src/a_served.ts", served)]), ws, "Where is LATE_CONSTANT defined?");
    const entry = rows.find((r) => r.symbol === "LATE_CONSTANT")!;
    expect(entry.files[0]!.path).toBe("src/z_definition.ts");
    expect(entry.files[0]!.lines).toEqual([2, 3, 8]); // two uses and the declaration itself — never cut
    expect(entry.files.map((f) => f.path).slice(1)).toEqual(["src/b1.ts", "src/b2.ts", "src/b3.ts"]); // then the others, in the usual order
    expect(entry.total).toBe(1 + 5 * 4 + 7);
    expect(entry.inventory_complete).toBe(false);
  });

  it("the declaring line survives the byte cap's line trimming too", () => {
    const symbols = Array.from({ length: 6 }, (_, i) => `TRIM_${String.fromCharCode(65 + i)}_LIMIT`);
    const served = `export function servedTrim() { return ${symbols.join(" + ")}; }\n`;
    const dir = "e".repeat(9);
    const files: Record<string, string> = { "src/served.ts": served };
    for (let f = 0; f < 5; f++) {
      files[`src/${dir}${f}/m${f}.ts`] = symbols.flatMap((s) => [1, 2, 3, 4].map((k) => `export const u${f}_${s}_${k} = ${s};`)).join("\n") + "\n";
    }
    // the definitions live in the LAST file, after the uses
    files["src/zz_defs/defs.ts"] = symbols.map((s) => `export const ${s} = 1;`).join("\n") + "\n";
    const ws = makeWorkspace("r2-trim", files);
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, `Explain ${symbols.join(", ")}`);
    expect(Buffer.byteLength(JSON.stringify(rows), "utf8")).toBeLessThanOrEqual(1536);
    for (const [i, row] of rows.entries()) {
      expect(row.files[0]!.path).toBe("src/zz_defs/defs.ts");
      expect(row.files[0]!.lines).toEqual([i + 1]); // the declaration line, alone after trimming
    }
  });

  it("through declarationsIn when no keyword rule sees the declaration (a Java enum constant)", () => {
    const alpha = "package acme;\n\npublic class Alpha {\n  boolean waiting(WorkflowState s) { return s == WorkflowState.AWAITING_REVIEW; }\n}\n";
    const ws = makeWorkspace("r2-enum", {
      "src/main/java/acme/Alpha.java": alpha,
      "src/main/java/acme/Beta.java": "package acme;\n\npublic class Beta {\n  boolean ok(WorkflowState s) { return s != WorkflowState.AWAITING_REVIEW; }\n}\n",
      // sorts last; the constant has no `=`, so only the declaration scan can tell this file declares it
      "src/main/java/acme/WorkflowState.java": "package acme;\n\npublic enum WorkflowState {\n  DRAFT,\n  AWAITING_REVIEW,\n  PUBLISHED\n}\n",
    });
    const rows = computeUsageInventory(fakeResult([surface("src/main/java/acme/Alpha.java", alpha)]), ws, "Where is AWAITING_REVIEW defined?");
    const entry = rows.find((r) => r.symbol === "AWAITING_REVIEW")!;
    expect(entry.files.map((f) => f.path)).toEqual([
      "src/main/java/acme/WorkflowState.java",
      "src/main/java/acme/Beta.java",
      "src/main/java/acme/Alpha.java",
    ]);
    expect(entry.files[0]!.lines).toEqual([5]);
  });
});

// ===========================================================================
// Refinement round — R3 code-only references
// ===========================================================================

describe("R3 — only code surfaces contribute referenced identifiers", () => {
  const sl = (index: number, p: string, text: string) => ({ index, path: p, text });
  const symbolsOf = (cands: readonly UsageCandidate[]): string[] => cands.map((c) => c.symbol);

  it("surfaceKindOf: code, stylesheets, templates, and everything else is prose", () => {
    for (const p of ["a.ts", "a.tsx", "a.py", "a.go", "a.java", "a.kt", "a.c", "a.h", "a.cpp", "a.rs", "a.rb", "a.php", "a.cs", "a.swift", "a.sql", "a.sh"]) {
      expect(surfaceKindOf(p), p).toBe("code");
    }
    for (const p of ["a.css", "a.scss", "a.less"]) expect(surfaceKindOf(p), p).toBe("style");
    for (const p of ["a.html", "a.vue", "a.svelte", "a.erb"]) expect(surfaceKindOf(p), p).toBe("markup");
    for (const p of ["CHANGELOG.md", "README.rst", "notes.txt", "guide.adoc", "data.json", "conf.yaml", "Makefile", "LICENSE", "a.toml"]) {
      expect(surfaceKindOf(p), p).toBe("prose");
    }
  });

  it("proseCodeSpans: inline identifier-shaped backtick spans only; fenced blocks and prose-shaped spans excluded", () => {
    const text = [
      "Fixed `Foo` crash on Windows; `Markup.render()` too; see `MAX_RETRIES` and ``double``.",
      "```",
      "fenced_only `Bad`",
      "```",
      "Run `npm run build` then `x = 1`, or use `a::b`.",
    ].join("\n");
    expect(proseCodeSpans(text)).toEqual(["Foo", "Markup.render", "MAX_RETRIES", "double", "a::b"]);
  });

  it("a CHANGELOG contributes nothing but its backticked identifiers", () => {
    const changelog = [
      "## 1.4.0",
      "- Fixed the crash on Windows when Issue tracking is off (Markup handling)",
      "- Changed `OrderService.calculateTotal()` to round half up; new `MAX_RETRIES` limit",
      "```ts",
      "const Ignored = FencedCode();",
      "```",
    ].join("\n");
    const terms = requestTermsOf(undefined);
    const found = symbolsOf(collectUsageCandidates([sl(0, "CHANGELOG.md", changelog)], terms));
    for (const noise of ["Fixed", "Windows", "Issue", "Markup", "Changed", "Ignored", "FencedCode"]) expect(found, noise).not.toContain(noise);
    expect(found).toEqual(expect.arrayContaining(["MAX_RETRIES", "calculateTotal"]));
    // the same words in CODE are candidates as ever
    const code = "export class Windows {}\nexport const x = new Markup(Issue, Fixed);\n";
    expect(symbolsOf(collectUsageCandidates([sl(0, "src/a.ts", code)], terms))).toEqual(expect.arrayContaining(["Windows", "Markup", "Issue", "Fixed"]));
  });

  it("documentation, text and data surfaces of every kind read nothing but their backticks", () => {
    const prose = "Overview of PaymentGateway and RetryPolicy. Configure `retry.maxAttempts` or set `DEFAULT_TIMEOUT`.\n";
    for (const p of ["docs/guide.rst", "docs/notes.txt", "docs/manual.adoc", "conf/app.json", "conf/app.yaml", "Makefile"]) {
      const found = symbolsOf(collectUsageCandidates([sl(0, p, prose)], requestTermsOf(undefined)));
      expect(found, p).toEqual(["DEFAULT_TIMEOUT"]); // `retry.maxAttempts` is neither const-case nor a distinctive member of a type
    }
  });

  it("a template contributes only the keys inside its string literals, when the request explains them", () => {
    const html = '<h1>Order Summary</h1>\n<div class="priority-critical banner">Fixed Window</div>\n';
    const found = symbolsOf(collectUsageCandidates([sl(0, "web/index.html", html)], requestTermsOf("Where is the priority styling applied?")));
    expect(found).toEqual(["priority-critical"]);
    expect(symbolsOf(collectUsageCandidates([sl(0, "web/index.html", html)], requestTermsOf(undefined)))).toEqual([]);
  });

  it("end to end: a pack that served only a CHANGELOG gets no inventory, though the workspace uses those words", () => {
    const changelog = "## 2.0.0\n- Fixed an Issue on Windows (Markup)\n";
    const ws = makeWorkspace("r3-e2e", {
      "CHANGELOG.md": changelog,
      "src/a.ts": "export class Windows {}\nexport const Fixed = 1;\nexport const Issue = 2;\nexport const Markup = 3;\n",
      "src/b.ts": "import { Windows, Fixed, Issue, Markup } from './a';\nvoid [Windows, Fixed, Issue, Markup];\n",
    });
    expect(computeUsageInventory(fakeResult([surface("CHANGELOG.md", changelog)]), ws)).toEqual([]);
  });
});

// ===========================================================================
// Refinement round — R4 specificity
// ===========================================================================

describe("R4 — specificity", () => {
  /** A served file that references `WIDE_COUNT` (twice, so it outranks) and `NARROW_COUNT`, both declared in `consts.ts`. */
  function tier(wideFiles: number, wideLinesPerFile: number): { ws: string; result: TaskPackResult } {
    const served = "export function measure() { return WIDE_COUNT + WIDE_COUNT + NARROW_COUNT; }\n";
    const files: Record<string, string> = {
      "src/served.ts": served,
      "src/consts.ts": "export const WIDE_COUNT = 1;\nexport const NARROW_COUNT = 2;\n",
      "src/narrow1.ts": "void NARROW_COUNT;\n",
      "src/narrow2.ts": "void NARROW_COUNT;\n",
    };
    for (let f = 0; f < wideFiles; f++) files[`src/wide/w${String(f).padStart(3, "0")}.ts`] = Array.from({ length: wideLinesPerFile }, () => "void WIDE_COUNT;").join("\n") + "\n";
    const ws = makeWorkspace(`r4-tier-${wideFiles}-${wideLinesPerFile}`, files);
    return { ws, result: fakeResult([surface("src/served.ts", served)]) };
  }

  it("F2 — no relative rule: a candidate matched on far more lines than the rest of its tier keeps its rank while under 200 lines", () => {
    // (final round — old: the relative clause demoted a candidate matched on more than 10x the lines of the tier's least matched
    // one, so WIDE_COUNT (62 lines against 4) moved BELOW NARROW_COUNT; only the absolute threshold below survives)
    const { ws, result } = tier(60, 1);
    const rows = computeUsageInventory(result, ws);
    const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
    expect(bySymbol.get("WIDE_COUNT")!.total).toBe(60 + 2); // 60 files + the declaration + the served line
    expect(bySymbol.get("NARROW_COUNT")!.total).toBe(4); // the declaration, the served line and two users
    // both are "constants the first surface references but does not declare": the same tier, the more used one first
    expect(rows.map((r) => r.symbol).slice(0, 2)).toEqual(["WIDE_COUNT", "NARROW_COUNT"]);
    const flat = tier(1, 1);
    expect(computeUsageInventory(flat.result, flat.ws).map((r) => r.symbol).slice(0, 2)).toEqual(["WIDE_COUNT", "NARROW_COUNT"]);
  });

  it("more than 200 matching lines is ubiquitous by itself; two ubiquitous candidates keep their own order", () => {
    const { ws, result } = tier(1, 300);
    expect(computeUsageInventory(result, ws).map((r) => r.symbol).slice(0, 2)).toEqual(["NARROW_COUNT", "WIDE_COUNT"]);
    // both ubiquitous: nothing less ubiquitous to yield to
    const served = "export function both() { return BIG_ONE + BIG_ONE + BIG_TWO; }\n";
    const ws2 = makeWorkspace("r4-both", {
      "src/served.ts": served,
      "src/consts.ts": "export const BIG_ONE = 1;\nexport const BIG_TWO = 2;\n",
      "src/one.ts": Array.from({ length: 260 }, () => "void BIG_ONE;").join("\n") + "\n",
      "src/two.ts": Array.from({ length: 240 }, () => "void BIG_TWO;").join("\n") + "\n",
    });
    expect(computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws2).map((r) => r.symbol).slice(0, 2)).toEqual(["BIG_ONE", "BIG_TWO"]);
  });

  it("the demotion stays inside a tier: a ubiquitous query-named symbol still precedes a specific concept match", () => {
    const served = "export function pick() { return HUGE_NAMED + RETRY_SPECIFIC; }\n";
    const ws = makeWorkspace("r4-tiers", {
      "src/served.ts": served,
      "src/consts.ts": "export const HUGE_NAMED = 1;\nexport const RETRY_SPECIFIC = 2;\n",
      "src/use.ts": Array.from({ length: 300 }, () => "void HUGE_NAMED;").join("\n") + "\nvoid RETRY_SPECIFIC;\n",
    });
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, "Explain HUGE_NAMED and the retry limit");
    expect(rows.map((r) => r.symbol).slice(0, 2)).toEqual(["HUGE_NAMED", "RETRY_SPECIFIC"]);
  });

  it("requestTermsOf: the member of a qualified identifier is the subject; its qualifier is only the place to look", () => {
    for (const [query, owner, member] of [
      ["How does HttpClient.fetchJson retry?", "HttpClient", "fetchJson"],
      ["How does HttpClient::fetchJson retry?", "HttpClient", "fetchJson"],
      ["How does HttpClient#fetchJson retry?", "HttpClient", "fetchJson"],
      ["Explain Invoice.total", "Invoice", "total"], // a plain word is still the subject
    ] as const) {
      const terms = requestTermsOf(query);
      expect(terms.identifiers, query).toContain(member);
      expect(terms.qualifiers, query).toEqual([owner]);
    }
    // an owner the query also names on its own is a subject in its own right
    expect(requestTermsOf("Compare HttpClient with HttpClient.fetchJson").qualifiers).toEqual([]);
    // file names are not qualified references
    const files = requestTermsOf("What is in Node.js and README.md?");
    expect(files.qualifiers).toEqual([]);
    expect(files.identifiers).not.toContain("js");
  });

  it("rank: the member is tier 1 and the qualifier tier 2, at the top of it", () => {
    const cand = (symbol: string, over: Partial<UsageCandidate> = {}): UsageCandidate => ({
      symbol, surfaceIndex: 0, path: "src/a.ts", kind: "identifier", declared: true, declSurface: 0, exported: true, refs0: 0, literal: false, order: 0, ...over,
    });
    const terms = requestTermsOf("How does HttpClient.fetchJson retry after a failure?");
    const ranked = rankUsageCandidates(
      [cand("HttpClient", { kind: "type", order: 0 }), cand("retryDelay", { order: 1 }), cand("fetchJson", { kind: "function", order: 2 }), cand("RETRY_MAX", { kind: "constant", declared: false, order: 3 })],
      terms,
    );
    const category = new Map(ranked.map((r) => [r.symbol, r.category]));
    expect(category.get("fetchJson")).toBe(1);
    expect(category.get("HttpClient")).toBe(2);
    expect(ranked.map((r) => r.symbol)[0]).toBe("fetchJson");
    expect(ranked.filter((r) => r.category === 2)[0]!.symbol).toBe("HttpClient"); // above the concept matches of its tier
    // named alone as well: tier 1 again
    const alone = rankUsageCandidates([cand("HttpClient", { kind: "type" })], requestTermsOf("Compare HttpClient with HttpClient.fetchJson"));
    expect(alone[0]!.category).toBe(1);
  });

  it("end to end: `HttpClient.fetchJson` inventories the member before the class it lives in", () => {
    const served = "export class HttpClient {\n  fetchJson(url: string) { return url; }\n}\n";
    const ws = makeWorkspace("r4-qualified", {
      "src/http.ts": served,
      "src/a.ts": "import { HttpClient } from './http';\nnew HttpClient().fetchJson('a');\n",
      "src/b.ts": "import { HttpClient } from './http';\nnew HttpClient().fetchJson('b');\n",
    });
    const rows = computeUsageInventory(fakeResult([surface("src/http.ts", served)]), ws, "How does HttpClient.fetchJson handle errors?");
    expect(rows.map((r) => r.symbol).slice(0, 2)).toEqual(["fetchJson", "HttpClient"]);
    // a plain word is the subject too, though it is on the generic stoplist and would never be inventoried on its own
    const ledger = "export class LedgerBook {\n  total() { return 1; }\n}\n";
    const ws2 = makeWorkspace("r4-qualified-plain", {
      "src/ledger.ts": ledger,
      "src/a.ts": "import { LedgerBook } from './ledger';\nconsole.log(new LedgerBook().total());\n",
      "src/b.ts": "import { LedgerBook } from './ledger';\nconsole.log(new LedgerBook().total());\n",
    });
    const plain = computeUsageInventory(fakeResult([surface("src/ledger.ts", ledger)]), ws2, "Explain LedgerBook.total");
    expect(plain.map((r) => r.symbol).slice(0, 2)).toEqual(["total", "LedgerBook"]);
  });
});

// ===========================================================================
// Refinement round — R5 project-name terms
// ===========================================================================

describe("R5 — a term that names the project itself is no relevance signal inside it", () => {
  it("projectNameTermsOf: the root directory's name and the manifest's package/module name, per ecosystem", () => {
    const ws = makeWorkspace("r5-names", {
      "package.json": '{"name":"rootpkg"}',
      "x.ts": "",
      "libfoo/package.json": '{"name":"@acme/libfoo-core"}', "libfoo/src/a.ts": "",
      "analytics/pyproject.toml": '[build-system]\nrequires = ["x"]\n[project]\nname = "site-analytics"\nversion = "1"\n', "analytics/app/a.py": "",
      "crate_x/Cargo.toml": '[package]\nname = "fast-parser"\n', "crate_x/src/lib.rs": "",
      "ledger/go.mod": "module github.com/acme/ledger-store/v2\n\ngo 1.22\n", "ledger/main.go": "",
      "billing/pom.xml": "<project><parent><artifactId>parent-pom</artifactId></parent><artifactId>billing-api</artifactId></project>", "billing/src/A.java": "",
      "native/CMakeLists.txt": "cmake_minimum_required(VERSION 3.20)\nproject(fastlib LANGUAGES C)\n", "native/a.c": "",
      "app/settings.gradle": "rootProject.name = 'shopfront'\n", "app/src/A.kt": "",
    });
    const forms = (file: string, scope?: string) => projectNameTermsOf(ws, file, scope);
    expect([...forms("libfoo/src/a.ts")].sort()).toEqual(expect.arrayContaining(["libfoo", "acme", "core"]));
    expect(forms("libfoo/src/a.ts").has("src")).toBe(false);
    expect(forms("analytics/app/a.py")).toEqual(expect.objectContaining({ size: expect.any(Number) }));
    for (const term of ["site", "analytics", "analytic"]) expect(forms("analytics/app/a.py").has(term), term).toBe(true);
    for (const term of ["fast", "parser", "crate"]) expect(forms("crate_x/src/lib.rs").has(term), term).toBe(true);
    for (const term of ["acme", "ledger", "store"]) expect(forms("ledger/main.go").has(term), term).toBe(true);
    expect(forms("ledger/main.go").has("github")).toBe(false); // the host is not the project
    for (const term of ["billing", "api"]) expect(forms("billing/src/A.java").has(term), term).toBe(true);
    expect(forms("billing/src/A.java").has("parent")).toBe(false); // the parent pom's artifact is not this project's
    for (const term of ["fastlib", "native"]) expect(forms("native/a.c").has(term), term).toBe(true);
    expect(forms("app/src/A.kt").has("shopfront")).toBe(true);
    // a root at the workspace itself contributes its manifest's name only — not the directory the caller happened to open
    expect([...forms("x.ts")]).toEqual(["rootpkg"]);
    // the scanned scope adds its own names
    expect(forms("libfoo/src/a.ts", "").has("rootpkg")).toBe(true);
    // no manifest anywhere: no names
    const bare = makeWorkspace("r5-bare", { "src/a.ts": "" });
    expect(projectNameTermsOf(bare, "src/a.ts").size).toBe(0);
  });

  it("projectNameTermsOf follows an edited manifest (cache validated by mtime + size)", () => {
    const ws = makeWorkspace("r5-cache", { "web/package.json": '{"name":"alpha"}', "web/a.ts": "" });
    expect(projectNameTermsOf(ws, "web/a.ts").has("alpha")).toBe(true);
    put(ws, "web/package.json", '{"name":"bravo-service"}');
    const terms = projectNameTermsOf(ws, "web/a.ts");
    expect(terms.has("alpha")).toBe(false);
    expect(terms.has("bravo")).toBe(true);
  });

  it("withoutProjectTerms drops only the project's words", () => {
    const terms = requestTermsOf("How does libfoo retry uploads?");
    expect(terms.concepts).toEqual(expect.arrayContaining(["libfoo", "retry", "upload"]));
    const trimmed = withoutProjectTerms(terms, new Set(["libfoo"]));
    expect(trimmed.concepts).not.toContain("libfoo");
    expect(trimmed.concepts).toEqual(expect.arrayContaining(["retry", "upload"]));
    expect(withoutProjectTerms(terms, new Set(["unrelated"]))).toBe(terms);
    expect(withoutProjectTerms(terms, undefined)).toBe(terms);
  });

  it("NBR scorer: the project's name earns no relevance and never becomes the row's label; other terms still do", () => {
    const terms = requestTermsOf("How does libfoo retry uploads?");
    const projectTerms = new Set(["libfoo"]);
    const edges = [
      edge("libfoo/src/libfooTransport.ts", { names: ["libfooTransport"], line: 1 }),
      edge("libfoo/src/retryPolicy.ts", { names: ["policy"], line: 2 }),
    ];
    const without = rankNeighbourCandidates(edges.map((e) => ({ ...e, projectTerms })), terms);
    expect(order(without)).toEqual(["libfoo/src/retryPolicy.ts", "libfoo/src/libfooTransport.ts"]);
    expect(without[0]!.matched).toBe("retry");
    expect(without[1]!.relevance).toBe(0);
    expect(without[1]!.signalled).toBe(false);
    // the same request in a project that is NOT named libfoo: the term is a signal
    const kept = rankNeighbourCandidates(edges, terms);
    expect(kept.find((r) => r.path.endsWith("libfooTransport.ts"))!.matched).toBe("libfoo");
    expect(kept.find((r) => r.path.endsWith("libfooTransport.ts"))!.relevance).toBeGreaterThan(0);
  });

  it("NBR end to end: imports matching only the project's name are not offered; a control project keeps them", () => {
    const importer = [
      "import { libfooTransport } from './libfooTransport.js';",
      "import { retryPolicy } from './retryPolicy.js';",
      "import { logger } from './logger.js';",
      "",
      "export const send = () => 1;",
      "",
    ].join("\n");
    const build = (root: string, tag: string, manifest: boolean) => {
      const files: Record<string, string> = {
        [`${root}/src/client.ts`]: importer,
        [`${root}/src/libfooTransport.ts`]: "export const libfooTransport = 1;\n",
        [`${root}/src/retryPolicy.ts`]: "export const retryPolicy = 1;\n",
        [`${root}/src/logger.ts`]: "export const logger = 1;\n",
      };
      if (manifest) files[`${root}/package.json`] = '{"name":"libfoo"}';
      return makeWorkspace(tag, files);
    };
    const query = "How does libfoo retry a failed send?";
    const inProject = build("libfoo", "r5-nbr-in", true);
    const rows = computeFrontierNeighbourIndex(fakeResult([surface("libfoo/src/client.ts", "export const send = () => 1;\n", { range: "5-5" })]), inProject, query, { resolveImports: lineResolver("libfoo/src") });
    expect(rows.map((r) => r.path)).toEqual(["libfoo/src/retryPolicy.ts"]);
    expect(rows[0]!.why).toBe('imported by libfoo/src/client.ts:2 (matches "retry")');
    // control: a project called something else — "libfoo" is an ordinary word of the request there
    const control = build("pkg", "r5-nbr-ctl", false);
    const kept = computeFrontierNeighbourIndex(fakeResult([surface("pkg/src/client.ts", "export const send = () => 1;\n", { range: "5-5" })]), control, query, { resolveImports: lineResolver("pkg/src") });
    expect(kept.map((r) => r.path)).toEqual(["pkg/src/libfooTransport.ts", "pkg/src/retryPolicy.ts"]);
    expect(kept[0]!.why).toBe('imported by pkg/src/client.ts:1 (matches "libfoo")');
  });

  it("NBR: a request whose only term is the project's name is a request without terms", () => {
    const importer = "import { alpha } from './alpha.js';\nimport { beta } from './beta.js';\n\nexport const zero = 0;\n";
    const ws = makeWorkspace("r5-only", {
      "libfoo/package.json": '{"name":"libfoo"}',
      "libfoo/src/client.ts": importer,
      "libfoo/src/alpha.ts": "export const alpha = 1;\n",
      "libfoo/src/beta.ts": "export const beta = 1;\n",
    });
    const result = fakeResult([surface("libfoo/src/client.ts", "export const zero = 0;\n", { range: "4-4" })]);
    const deps = { resolveImports: lineResolver("libfoo/src") };
    const named = computeFrontierNeighbourIndex(result, ws, "Explain libfoo", deps);
    const none = computeFrontierNeighbourIndex(result, ws, undefined, deps);
    expect(named.map((r) => r.path)).toEqual(["libfoo/src/alpha.ts", "libfoo/src/beta.ts"]); // the first imports, as for no query at all
    expect(named.map((r) => r.why)).toEqual(none.map((r) => r.why));
  });

  it("FUI: a string key promoted only by the project's name is no candidate; another request term still promotes it", () => {
    const served = 'export const sink = "libfoo.logging.writers";\nexport const backoff = "retry.max_attempts";\n';
    const files = (root: string): Record<string, string> => ({
      [`${root}/src/conf.ts`]: served,
      [`${root}/src/use.ts`]: 'export const a = "libfoo.logging.writers";\nexport const b = "retry.max_attempts";\n',
    });
    const inProject = makeWorkspace("r5-fui-in", { ...files("libfoo"), "libfoo/package.json": '{"name":"libfoo"}' });
    const at = (query: string, ws = inProject, root = "libfoo") => computeUsageInventory(fakeResult([surface(`${root}/src/conf.ts`, served)]), ws, query).map((r) => r.symbol);
    expect(at("How does libfoo choose its output?")).toEqual([]); // "libfoo" is the only term the key matches — and it names the project
    expect(at("How does libfoo choose its logging output?")).toContain("libfoo.logging.writers"); // "logging" still does
    // control: a project of another name — the term is a signal
    const control = makeWorkspace("r5-fui-ctl", files("pkg"));
    expect(at("How does libfoo choose its output?", control, "pkg")).toContain("libfoo.logging.writers");
  });

  it("FUI rank: the project's name does not earn tier 2", () => {
    const candidate: UsageCandidate = { symbol: "LIBFOO_TIMEOUT", surfaceIndex: 0, path: "libfoo/src/a.ts", kind: "constant", declared: false, declSurface: -1, exported: false, refs0: 1, literal: false, order: 0 };
    const terms = requestTermsOf("How is libfoo configured?"); // "libfoo" is the only concept term
    expect(rankUsageCandidates([candidate], terms)[0]!.category).toBe(2);
    expect(rankUsageCandidates([candidate], terms, { projectTermsOf: () => new Set(["libfoo"]) })[0]!.category).toBe(3);
    // another term of the request still earns it: "timeout"
    const both = requestTermsOf("How is the libfoo timeout configured?");
    expect(rankUsageCandidates([candidate], both, { projectTermsOf: () => new Set(["libfoo"]) })[0]!.category).toBe(2);
  });
});

// ===========================================================================
// Refinement round — symlinks that point out of the workspace
// ===========================================================================

describe("symlinks that point out of the workspace are never read (filesystem accesses recorded)", () => {
  const outsideOf = (ws: string): string => {
    const dir = path.join(path.dirname(ws), `${path.basename(ws)}-outside`);
    fs.mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  };
  const record = <T>(fn: () => T): { value: T; calls: Array<{ fn: string; path: string }> } => {
    spy.calls.length = 0;
    spy.recording = true;
    try {
      return { value: fn(), calls: [...spy.calls] };
    } finally {
      spy.recording = false;
    }
  };
  /** Accesses to `target` (or below it) that could read its content or list it: everything but resolving the link itself. */
  const contentAccess = (calls: ReadonlyArray<{ fn: string; path: string }>, target: string) =>
    calls.filter((c) => (c.path === target || c.path.startsWith(target + path.sep)) && !c.fn.startsWith("realpathSync"));
  const anywhereBelow = (calls: ReadonlyArray<{ fn: string; path: string }>, dir: string) => calls.filter((c) => c.path === dir || c.path.startsWith(dir + path.sep));

  it.skipIf(process.platform === "win32")("a scope manifest that is a symlink out of the workspace declares nothing and is never stat'ed or read", () => {
    const ws = makeWorkspace("sym-manifest", { "web/package.json": '{"name":"web"}', "web/src/a.ts": "export const a = 1;\n" });
    const outside = outsideOf(ws);
    // if this manifest were read, it would list `web` as a member and the scope would climb to the whole workspace
    fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "evil-root", workspaces: ["web"] }));
    const link = path.join(ws, "package.json");
    fs.symlinkSync(path.join(outside, "package.json"), link);
    const { value, calls } = record(() => ({ scope: inventoryScopeOf(ws, "web/src/a.ts"), names: projectNameTermsOf(ws, "web/src/a.ts", "") }));
    expect(value.scope).toBe("web");
    expect(value.names.has("evil")).toBe(false);
    expect(contentAccess(calls, link)).toEqual([]);
    expect(anywhereBelow(calls, outside)).toEqual([]);
    // control: the identical manifest as a regular file inside the workspace is read, and does climb
    const control = makeWorkspace("sym-manifest-ctl", { "web/package.json": '{"name":"web"}', "web/src/a.ts": "", "package.json": JSON.stringify({ name: "root", workspaces: ["web"] }) });
    expect(inventoryScopeOf(control, "web/src/a.ts")).toBe("");
  });

  it.skipIf(process.platform === "win32")("a candidate that is a symlink out of the workspace is never stat'ed, opened or read (neighbour rows)", () => {
    const importer = "import { leaked } from './linked.js';\nexport const a = leaked;\n";
    const ws = makeWorkspace("sym-candidate", { "web/package.json": '{"name":"web"}', "web/src/a.ts": importer, "web/src/inside.ts": "export const inside = 1;\n" });
    const outside = outsideOf(ws);
    fs.writeFileSync(path.join(outside, "linked.ts"), "export function leakedSecret() { return 'secret'; }\n");
    const link = path.join(ws, "web/src/linked.ts");
    fs.symlinkSync(path.join(outside, "linked.ts"), link);
    const resolve = () => [{ path: "web/src/linked.ts", line: 1, kind: "import" as const, names: ["leaked"] }, { path: "web/src/inside.ts", line: 2, kind: "import" as const, names: [] }];
    const { value, calls } = record(() => computeFrontierNeighbourIndex(fakeResult([surface("web/src/a.ts", importer)]), ws, "Where does leakedSecret come from?", { resolveImports: resolve }));
    expect(value.map((r) => r.path)).not.toContain("web/src/linked.ts");
    expect(contentAccess(calls, link)).toEqual([]);
    expect(anywhereBelow(calls, outside)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("a served surface that is a symlink out of the workspace is not read for its imports", () => {
    const ws = makeWorkspace("sym-importer", { "web/package.json": '{"name":"web"}', "web/src/dep.ts": "export const dep = 1;\n" });
    const outside = outsideOf(ws);
    fs.writeFileSync(path.join(outside, "importer.ts"), "import { dep } from './dep.js';\nexport const x = dep;\n");
    const link = path.join(ws, "web/src/importer.ts");
    fs.symlinkSync(path.join(outside, "importer.ts"), link);
    const seen: string[] = [];
    const { calls } = record(() => computeFrontierNeighbourIndex(fakeResult([surface("web/src/importer.ts", "export const x = dep;\n", { range: "2-2" })]), ws, undefined, {
      resolveImports: (_w, _p, body) => {
        seen.push(body);
        return [];
      },
    }));
    expect(seen).toEqual(["export const x = dep;\n"]); // the served slice stood in: the linked file's own text never reached the resolver
    expect(contentAccess(calls, link)).toEqual([]);
    expect(anywhereBelow(calls, outside)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("a directory symlink out of the workspace is never listed: no project roots, no names, no scope", () => {
    const ws = makeWorkspace("sym-dir", { "web/package.json": '{"name":"web"}' });
    const outside = outsideOf(ws);
    fs.writeFileSync(path.join(outside, "package.json"), '{"name":"outsidepkg"}');
    fs.writeFileSync(path.join(outside, "x.ts"), "export const x = 1;\n");
    const linkDir = path.join(ws, "web/linkdir");
    fs.symlinkSync(outside, linkDir, "dir");
    const { value, calls } = record(() => ({
      roots: projectRootsChecked(ws, "web/linkdir/x.ts"),
      listing: listDirectoryChecked(ws, "web/linkdir"),
      names: projectNameTermsOf(ws, "web/linkdir/x.ts"),
      scope: inventoryScopeOf(ws, "web/linkdir/x.ts"),
    }));
    expect(value.roots).toEqual([]);
    expect(value.listing).toEqual([]);
    expect(value.names.size).toBe(0);
    expect(value.scope).toBe("");
    expect(contentAccess(calls, linkDir)).toEqual([]);
    expect(anywhereBelow(calls, outside)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("the usage scan never reads a symlinked file, and a symlinked file never shows up in an inventory", () => {
    const served = "export function use() { return OUTSIDE_ONLY_NAME + LOCAL_LIMIT; }\n";
    const ws = makeWorkspace("sym-scan", { "web/package.json": '{"name":"web"}', "web/src/a.ts": served, "web/src/b.ts": "void LOCAL_LIMIT;\n" });
    const outside = outsideOf(ws);
    fs.writeFileSync(path.join(outside, "leak.ts"), "export const OUTSIDE_ONLY_NAME = 1;\nvoid LOCAL_LIMIT;\n");
    const link = path.join(ws, "web/src/leak.ts");
    fs.symlinkSync(path.join(outside, "leak.ts"), link);
    const { value, calls } = record(() => computeUsageInventory(fakeResult([surface("web/src/a.ts", served)]), ws, "Explain OUTSIDE_ONLY_NAME and LOCAL_LIMIT"));
    expect(JSON.stringify(value)).not.toContain("leak.ts");
    expect(contentAccess(calls, link)).toEqual([]);
    expect(anywhereBelow(calls, outside)).toEqual([]);
    expect(value.map((r) => r.symbol)).toContain("LOCAL_LIMIT");
  });

  it.skipIf(process.platform === "win32")("P1-6: a member's own manifest that is a symlink out of the workspace makes no member, and is never stat'ed", () => {
    const ws = makeWorkspace("sym-member", {
      "package.json": JSON.stringify({ name: "root", workspaces: ["modules/*"] }),
      "modules/linked/go.mod": "module example.test/linked\n", // gives the directory a project root of its own
      "modules/linked/src/a.ts": "export const a = 1;\n",
    });
    const outside = outsideOf(ws);
    fs.writeFileSync(path.join(outside, "package.json"), '{"name":"outside"}');
    const link = path.join(ws, "modules/linked/package.json");
    fs.symlinkSync(path.join(outside, "package.json"), link);
    const { value, calls } = record(() => inventoryScopeOf(ws, "modules/linked/src/a.ts"));
    expect(value).toBe("modules/linked"); // the glob lists it, but its package.json is not a file of this workspace
    expect(contentAccess(calls, link)).toEqual([]);
    expect(anywhereBelow(calls, outside)).toEqual([]);
    // control: a package.json that is a regular file makes it a member
    const control = makeWorkspace("sym-member-ctl", {
      "package.json": JSON.stringify({ name: "root", workspaces: ["modules/*"] }),
      "modules/linked/go.mod": "module example.test/linked\n",
      "modules/linked/package.json": '{"name":"linked"}',
      "modules/linked/src/a.ts": "export const a = 1;\n",
    });
    expect(inventoryScopeOf(control, "modules/linked/src/a.ts")).toBe("");
  });

  it("absolute, empty and escaping surface paths yield no project roots and cost no time", () => {
    const ws = makeWorkspace("sym-paths", { "package.json": "{}" });
    for (const p of ["/abs/path.ts", "C:/x/y.ts", "C:\\x\\y.ts", "", "../up.ts", "..", "/"]) {
      expect(isWorkspaceRelativePath(p), p).toBe(false);
      expect(projectRootsChecked(ws, p), p).toEqual([]);
    }
    expect(isWorkspaceRelativePath("a/b.ts")).toBe(true);
    expect(isWorkspaceRelativePath("./a/b.ts")).toBe(true);
    expect(inventoryScopeOf(ws, "/abs/path.ts")).toBe("");
    expect(projectNameTermsOf(ws, "/abs/path.ts").size).toBe(0);
  });
});

// ===========================================================================
// Robustness
// ===========================================================================

describe("hostile input costs rows, never an exception or unbounded time", () => {
  it("odd queries, paths and bodies are survived quickly", () => {
    const NUL = String.fromCharCode(0);
    const queries: Array<string | undefined> = [
      undefined,
      "",
      "a.b.c.".repeat(1500),
      "x".repeat(20000),
      `${NUL}${NUL} \u{1F600} \u202e priority${NUL}queue`,
      "`" + "`".repeat(500),
      "MAX_" + "A".repeat(5000),
      "注文".repeat(3000),
    ];
    const minified = "var a=" + "\"x\",".repeat(60000) + ";";
    const surfaces = [
      surface("src/a.ts", minified),
      surface("../escape.ts", "import { x } from './x.js';\nexport const y = x;\n"),
      surface("/abs/path.ts", "export const z = 1;\n"),
      surface("", "export const w = 1;\n"),
      surface("src/bin.ts", NUL.repeat(3000) + "PRIORITY_MAX" + NUL.repeat(3000)),
      surface("src/big.ts", "export const big = 1;\n".repeat(120000)),
    ];
    const ws = makeWorkspace("hostile", { "src/a.ts": minified, "src/x.ts": "export const x = 1;\n" });
    process.env["TL_NEIGHBOUR_INDEX"] = "1";
    process.env["TL_USAGE_INVENTORY"] = "1";
    const start = performance.now();
    for (const query of queries) {
      const result = fakeResult(surfaces.map((s) => ({ ...s })));
      expect(() => attachFrontierNeighbourIndex(result, ws, query)).not.toThrow();
      expect(() => attachUsageInventory(result, ws, query)).not.toThrow();
      expect(() => computeFrontierNeighbourIndex(result, ws, query)).not.toThrow();
      expect(() => computeUsageInventory(result, ws, query)).not.toThrow();
    }
    expect(performance.now() - start).toBeLessThan(15000);
    // a single 20,000-letter "word" is no concept; a long run of ordinary words is still read (the first 2,000 characters)
    expect(requestTermsOf("x".repeat(20000)).present).toBe(false);
    expect(requestTermsOf("retry ".repeat(5000)).concepts).toEqual(["retry"]);
  });
});

// ===========================================================================
// Bounded work
// ===========================================================================

describe("bounded work on a 2,000+ file tree", () => {
  it("scope, neighbour ranking and the usage inventory stay fast on a warm cache", () => {
    const files: Record<string, string> = { "package.json": '{"name":"big"}', "web/package.json": "{}" };
    const IMPORTS = 30;
    const head = Array.from({ length: IMPORTS }, (_, i) => `import { fn${i} } from './lib/mod${i}.js';`).join("\n");
    files["web/src/hub.ts"] = head + "\nexport function hub() { return SHARED_CAP + " + Array.from({ length: IMPORTS }, (_, i) => `fn${i}()`).join(" + ") + "; }\n";
    for (let i = 0; i < IMPORTS; i++) files[`web/src/lib/mod${i}.ts`] = `export const fn${i} = () => ${i};\nexport function helper${i}() { return SHARED_CAP; }\n`;
    files["web/src/consts.ts"] = "export const SHARED_CAP = 10;\n";
    for (let d = 0; d < 40; d++) for (let f = 0; f < 52; f++) files[`web/src/gen/d${d}/f${f}.ts`] = `export const v${d}_${f} = ${f};\n// line\n// line\n`;
    const ws = makeWorkspace("bounded", files);
    let count = 0;
    const walk = (dir: string): void => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(dir, e.name)); else count++; } };
    walk(ws);
    expect(count).toBeGreaterThanOrEqual(2000);

    const hub = files["web/src/hub.ts"]!;
    const result = fakeResult([surface("web/src/hub.ts", hub)]);
    const resolve = lineResolver("web/src");

    // warm-up (module load, fs cache), then measure
    inventoryScopeOf(ws, "web/src/hub.ts");
    computeFrontierNeighbourIndex(result, ws, "How is the shared cap applied?", { resolveImports: resolve });
    computeUsageInventory(result, ws, "How is SHARED_CAP applied?");

    const t0 = performance.now();
    for (let i = 0; i < 50; i++) inventoryScopeOf(ws, "web/src/hub.ts");
    const scopeMs = (performance.now() - t0) / 50;

    const t1 = performance.now();
    const rows = computeFrontierNeighbourIndex(result, ws, "How is the shared cap applied?", { resolveImports: resolve });
    const nbrMs = performance.now() - t1;

    const t2 = performance.now();
    const usages = computeUsageInventory(result, ws, "How is SHARED_CAP applied?");
    const fuiMs = performance.now() - t2;

    expect(rows.length).toBeGreaterThan(0);
    expect(usages[0]!.symbol).toBe("SHARED_CAP");
    expect(usages[0]!.scope).toBe("web");
    // stated bounds (measured values are several times lower): 5 ms per scope lookup, 250 ms for the ranking of 30 candidates incl. declaration reads, 3 s for a scan of 2,000+ files
    expect(scopeMs).toBeLessThan(5);
    expect(nbrMs).toBeLessThan(250);
    expect(fuiMs).toBeLessThan(3000);
  });
});

// ===========================================================================
// End to end
// ===========================================================================

describe("wire: plan.neighbours and plan.usages over a nested TS + Python fixture, both flags ON", () => {
  // Each pack serves ONE function (no import head); the import the request is about is the LAST statement of its file.
  const CHECKOUT = [
    'import { logger } from "./logger.js";',
    'import { loadConfig } from "./config.js";',
    'import { auditTrail } from "./auditTrail.js";',
    'import { heapPush } from "./heap.js";',
    'import { MAX_RETRIES } from "./retryPolicy.js";',
    "",
    "export function submitOrder(order: string): number {",
    "  let attempt = 0;",
    "  while (attempt < MAX_RETRIES) {",
    "    heapPush(attempt);",
    "    auditTrail(order);",
    "    attempt += 1;",
    "  }",
    "  return attempt;",
    "}",
    "",
  ].join("\n");
  const WORKER = [
    "import logging",
    "from .audit import audit_trail",
    "from .retry import MAX_RETRIES",
    "from .heap import heap_push",
    "",
    "log = logging.getLogger(__name__)",
    "",
    "def submit_order(order):",
    "    attempt = 0",
    "    while attempt < MAX_RETRIES:",
    "        heap_push(attempt)",
    "        audit_trail(order)",
    "        attempt += 1",
    "    return attempt",
    "",
  ].join("\n");
  // Two independent projects that both define MAX_RETRIES: neither may appear in the other's inventory.
  const FILES: Record<string, string> = {
    "package.json": '{"name":"repo","private":true}',
    "web/package.json": '{"name":"web","private":true}',
    "web/src/checkout.ts": CHECKOUT,
    "web/src/logger.ts": "export const logger = { info: (m: string) => m };\n",
    "web/src/config.ts": "export const loadConfig = () => ({ ok: true });\n",
    "web/src/auditTrail.ts": "export function auditTrail(o: string): void {\n  void o;\n}\n",
    "web/src/heap.ts": "export function heapPush(n: number): number {\n  return n;\n}\n",
    "web/src/retryPolicy.ts": "export const MAX_RETRIES = 3;\n",
    "svc/pyproject.toml": '[project]\nname = "svc"\n',
    "svc/app/__init__.py": "",
    "svc/app/worker.py": WORKER,
    "svc/app/audit.py": "def audit_trail(o):\n    return o\n",
    "svc/app/retry.py": "MAX_RETRIES = 5\n",
    "svc/app/heap.py": "def heap_push(n):\n    return n\n",
    "svc/app/other.py": "from .retry import MAX_RETRIES\n\nCAP = MAX_RETRIES * 2\n",
  };

  type Wire = {
    plan?: {
      neighbours?: Array<{ path: string; handle: string; why: string }>;
      usages?: Array<{ symbol: string; files: Array<{ path: string }>; scope?: string; total: number; inventory_complete: boolean }>;
    };
    evidence?: Array<{ path: string }>;
  };

  async function ask(tag: string, query: string, flagsOn: boolean): Promise<Record<string, any>> {
    if (flagsOn) {
      process.env["TL_NEIGHBOUR_INDEX"] = "1";
      process.env["TL_USAGE_INVENTORY"] = "1";
    }
    const ws = makeWorkspace(tag, FILES);
    const server = startDevServer(ws, "default");
    servers.push(server);
    await server.initialize();
    const { body } = await server.callTool("tl_read_file", { query, task: { profile: "answer", epoch: "new" }, cwd: ws });
    expect(body.kind).toBe("read.task_pack");
    return body;
  }

  it("ON, TS project: neighbours are ranked by the request (last import first), usages are scoped to `web`", async () => {
    const body = (await ask("e2e-ts", "Explain the retry loop in submitOrder.", true)) as Wire;
    const served = new Set((body.evidence ?? []).map((e) => e.path));
    expect(served.has("web/src/checkout.ts")).toBe(true);

    const neighbours = body.plan?.neighbours;
    expect(Array.isArray(neighbours)).toBe(true);
    // ranked, not in statement order: the request's own word ("retry") lifts the last import; the two used ones follow in file order;
    // the imports the request never touches and the slice never uses are not offered
    expect(neighbours!.map((r) => r.path)).toEqual(["web/src/retryPolicy.ts", "web/src/auditTrail.ts", "web/src/heap.ts"]);
    expect(neighbours![0]!.why).toBe('imported by web/src/checkout.ts:5 (matches "retry")');
    expect(neighbours![1]!.why).toBe("imported by web/src/checkout.ts:3");
    for (const row of neighbours!) {
      expect(served.has(row.path)).toBe(false); // never evidence, never a served file
      expect(row.handle.length).toBeGreaterThan(0);
    }

    const usages = body.plan?.usages;
    expect(Array.isArray(usages)).toBe(true);
    expect(usages![0]!.symbol).toBe("MAX_RETRIES");
    for (const entry of usages!) {
      expect(entry.scope).toBe("web");
      for (const file of entry.files) expect(file.path.startsWith("web/")).toBe(true);
    }
    expect(usages![0]!.files.map((f) => f.path)).toContain("web/src/retryPolicy.ts");
    expect(JSON.stringify(usages)).not.toContain("svc/"); // the sibling project's MAX_RETRIES is not this project's
    expect(usages![0]!.inventory_complete).toBe(true);
    expect(JSON.stringify(body)).not.toContain("callers");
  });

  it("ON, Python project: the same ranking and scoping (`svc`), imports resolved below the workspace root", async () => {
    const body = (await ask("e2e-py", "Explain the retry loop in submit_order.", true)) as Wire;
    const served = new Set((body.evidence ?? []).map((e) => e.path));
    expect(served.has("svc/app/worker.py")).toBe(true);
    expect(body.plan?.neighbours?.map((r) => r.path)).toEqual(["svc/app/retry.py", "svc/app/audit.py", "svc/app/heap.py"]);
    expect(body.plan?.neighbours?.[0]?.why).toBe('imported by svc/app/worker.py:3 (matches "retry")');
    const usages = body.plan?.usages;
    expect(usages?.[0]?.symbol).toBe("MAX_RETRIES");
    expect(usages?.every((u) => u.scope === "svc")).toBe(true);
    expect(JSON.stringify(usages)).not.toContain("web/");
  });

  it("OFF (default): neither plan member is present", async () => {
    const body = (await ask("e2e-off", "Explain the retry loop in submitOrder.", false)) as Wire;
    expect(body.plan?.neighbours).toBeUndefined();
    expect(body.plan?.usages).toBeUndefined();
  });
});

// ===========================================================================
// Final round (2026-09-30, review pass 2)
// ===========================================================================

describe("P0-2 — member globs match in linear time (globMatchesPath)", () => {
  const GROUP = "umbrella_of_deployable_services_directory_name"; // 46 characters

  it("a `*?` alternation (exponential as a regular expression) costs microseconds and still decides membership", () => {
    // the glob matches GROUP by shape, but GROUP holds no package.json of its own: not a member, the scope stays the project's
    const ws = makeWorkspace("p02-redos", {
      "package.json": JSON.stringify({ name: "root", workspaces: ["*?".repeat(26)] }),
      [`${GROUP}/web/package.json`]: '{"name":"web"}',
      [`${GROUP}/web/src/a.ts`]: "export const a = 1;\n",
    });
    const started = performance.now();
    expect(inventoryScopeOf(ws, `${GROUP}/web/src/a.ts`)).toBe(`${GROUP}/web`);
    // the regular expression this replaced needed ~1.8 s on this input, and four times longer per two more pairs
    expect(performance.now() - started).toBeLessThan(250);

    // the same glob over a member that does hold a package.json: adopted, and just as fast
    const member = makeWorkspace("p02-redos-member", {
      "package.json": JSON.stringify({ name: "root", workspaces: ["*?".repeat(26)] }),
      [`${GROUP}/package.json`]: '{"name":"group"}',
      [`${GROUP}/src/a.ts`]: "export const a = 1;\n",
    });
    const startedMember = performance.now();
    expect(inventoryScopeOf(member, `${GROUP}/src/a.ts`)).toBe("");
    expect(performance.now() - startedMember).toBeLessThan(250);

    // a glob segment of up to 255 characters matches; a longer one (or a glob over 512 characters) matches nothing — under-matching is the safe side
    for (const [stars, adopted] of [[250, true], [300, false]] as const) {
      const long = makeWorkspace(`p02-long-${stars}`, {
        "package.json": JSON.stringify({ name: "root", workspaces: ["*".repeat(stars)] }),
        [`${GROUP}/package.json`]: '{"name":"group"}',
        [`${GROUP}/src/a.ts`]: "export const a = 1;\n",
      });
      const t = performance.now();
      expect(inventoryScopeOf(long, `${GROUP}/src/a.ts`), `${stars} stars`).toBe(adopted ? "" : GROUP);
      expect(performance.now() - t).toBeLessThan(250);
    }
  });
});

describe("P1-6 — a member directory must hold its ecosystem's own manifest", () => {
  it("an npm workspaces glob does not adopt a Go module: its own scope stays, while a package.json member climbs", () => {
    const ws = makeWorkspace("p16-npm-go", {
      "package.json": JSON.stringify({ name: "mono", workspaces: ["products/*"] }),
      "products/ledger/go.mod": "module example.test/ledger\n",
      "products/ledger/main.go": "package main\n",
      "products/storefront/package.json": '{"name":"storefront"}',
      "products/storefront/src/page.ts": "export {};\n",
    });
    expect(inventoryScopeOf(ws, "products/ledger/main.go")).toBe("products/ledger");
    expect(inventoryScopeOf(ws, "products/storefront/src/page.ts")).toBe("");
  });

  it("every membership source needs its own manifest in the member: go.mod, Cargo.toml, pyproject.toml, pom.xml, build.gradle(.kts), CMakeLists.txt, meson.build, package.json", () => {
    const sources: Array<{ name: string; root: Record<string, string>; own: [string, string]; foreign: [string, string] }> = [
      { name: "npm workspaces", root: { "package.json": JSON.stringify({ name: "r", workspaces: ["mod"] }) }, own: ["package.json", '{"name":"m"}'], foreign: ["go.mod", "module x\n"] },
      { name: "pnpm-workspace.yaml", root: { "package.json": '{"name":"r"}', "pnpm-workspace.yaml": "packages:\n  - 'mod'\n" }, own: ["package.json", '{"name":"m"}'], foreign: ["go.mod", "module x\n"] },
      { name: "lerna.json", root: { "package.json": '{"name":"r"}', "lerna.json": JSON.stringify({ packages: ["mod"] }) }, own: ["package.json", '{"name":"m"}'], foreign: ["go.mod", "module x\n"] },
      { name: "go.work", root: { "go.work": "go 1.22\n\nuse ./mod\n" }, own: ["go.mod", "module x\n"], foreign: ["package.json", '{"name":"m"}'] },
      { name: "Cargo workspace", root: { "Cargo.toml": '[workspace]\nmembers = ["mod"]\n' }, own: ["Cargo.toml", "[package]\n"], foreign: ["package.json", '{"name":"m"}'] },
      { name: "uv workspace", root: { "pyproject.toml": '[project]\nname = "r"\n[tool.uv.workspace]\nmembers = ["mod"]\n' }, own: ["pyproject.toml", "[project]\n"], foreign: ["package.json", '{"name":"m"}'] },
      { name: "Maven modules", root: { "pom.xml": "<project><modules><module>mod</module></modules></project>" }, own: ["pom.xml", "<project/>"], foreign: ["package.json", '{"name":"m"}'] },
      { name: "Gradle (Groovy)", root: { "settings.gradle": "include 'mod'\n" }, own: ["build.gradle", ""], foreign: ["package.json", '{"name":"m"}'] },
      { name: "Gradle (Kotlin)", root: { "settings.gradle.kts": 'include("mod")\n' }, own: ["build.gradle.kts", ""], foreign: ["package.json", '{"name":"m"}'] },
      { name: "CMake add_subdirectory", root: { "CMakeLists.txt": "project(r)\nadd_subdirectory(mod)\n" }, own: ["CMakeLists.txt", "project(m)\n"], foreign: ["package.json", '{"name":"m"}'] },
      { name: "Meson subdir", root: { "meson.build": "project('r')\nsubdir('mod')\n" }, own: ["meson.build", ""], foreign: ["package.json", '{"name":"m"}'] },
    ];
    for (const source of sources) {
      const tag = source.name.replace(/[^a-z]/gi, "").toLowerCase();
      const own = makeWorkspace(`p16-own-${tag}`, { ...source.root, [`mod/${source.own[0]}`]: source.own[1], "mod/f.ts": "" });
      expect(inventoryScopeOf(own, "mod/f.ts"), `${source.name}: the member holds ${source.own[0]}`).toBe("");
      const foreign = makeWorkspace(`p16-foreign-${tag}`, { ...source.root, [`mod/${source.foreign[0]}`]: source.foreign[1], "mod/f.ts": "" });
      expect(inventoryScopeOf(foreign, "mod/f.ts"), `${source.name}: the member holds only ${source.foreign[0]}`).toBe("mod");
    }
  });
});

describe("P1-5 — the plan-aid members stay inside the pack's remaining wire room", () => {
  const bytesOf = (rows: unknown): number => Buffer.byteLength(JSON.stringify(rows), "utf8");

  it("planAidCap: min(own cap, headroom - 48), nothing under 120 bytes, nothing for a headroom that cannot be trusted", () => {
    expect(PLAN_AID_KEY_OVERHEAD_BYTES).toBe(48);
    expect(PLAN_AID_MIN_BYTES).toBe(120);
    expect(planAidCap(1024)).toBe(1024);
    expect(planAidCap(1024, {})).toBe(1024);
    expect(planAidCap(1024, { headroom: () => 10_000 })).toBe(1024);
    expect(planAidCap(1024, { headroom: () => Number.POSITIVE_INFINITY })).toBe(1024);
    expect(planAidCap(1536, { headroom: () => 500 })).toBe(452);
    expect(planAidCap(1536, { headroom: () => 500.9 })).toBe(452);
    expect(planAidCap(1024, { headroom: () => 168 })).toBe(120); // exactly the floor
    expect(planAidCap(1024, { headroom: () => 167 })).toBeUndefined(); // 119 bytes: not even one row
    expect(planAidCap(1024, { headroom: () => 0 })).toBeUndefined();
    expect(planAidCap(1024, { headroom: () => -300 })).toBeUndefined();
    expect(planAidCap(1024, { headroom: () => Number.NaN })).toBeUndefined();
    expect(planAidCap(1024, { headroom: () => { throw new Error("the pack could not be measured"); } })).toBeUndefined();
  });

  const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  const HUB_HEAD = NAMES.map((n) => `import { ${n}Fn } from './${n}Module.js';`).join("\n");
  const HUB_BODY = "\nexport function runAll() {\n  return " + NAMES.map((n) => `${n}Fn()`).join(" + ") + ";\n}\n";
  const HUB = HUB_HEAD + HUB_BODY;

  it("NBR: the rows are the best-ranked prefix that fits under headroom - 48; no room attaches nothing; the headroom is asked once and only with the flag on", () => {
    const files: Record<string, string> = { "src/hub.ts": HUB };
    for (const n of NAMES) files[`src/${n}Module.ts`] = `export const ${n}Fn = () => 1;\n`;
    const ws = makeWorkspace("p15-nbr", files);
    const attach = (opts?: PlanAidOptions): TaskPackResult => {
      const result = fakeResult([surface("src/hub.ts", HUB)]);
      attachFrontierNeighbourIndex(result, ws, undefined, opts);
      return result;
    };
    let asked = 0;
    const counting: PlanAidOptions = { headroom: () => { asked++; return 100_000; } };

    attach(counting); // OFF: the flag is the first line, the headroom is never evaluated
    expect(asked).toBe(0);

    process.env["TL_NEIGHBOUR_INDEX"] = "1";
    const full = attach().neighbours!;
    expect(full.map((r) => r.path)).toEqual(NAMES.map((n) => `src/${n}Module.ts`));
    expect(bytesOf(full)).toBeLessThanOrEqual(1024);
    expect(attach(counting).neighbours).toEqual(full); // plenty of room: byte-identical to no option at all
    expect(asked).toBe(1);

    // headroom for exactly the first five rows plus the member's own key: five rows; one byte less: four
    const five = bytesOf(full.slice(0, 5));
    expect(attach({ headroom: () => five + PLAN_AID_KEY_OVERHEAD_BYTES }).neighbours).toEqual(full.slice(0, 5));
    expect(attach({ headroom: () => five + PLAN_AID_KEY_OVERHEAD_BYTES - 1 }).neighbours).toEqual(full.slice(0, 4));
    // no room, an untrustworthy headroom: the pack is left exactly as the shed ladder made it
    for (const headroom of [() => 0, () => 100, () => Number.NaN, () => { throw new Error("boom"); }]) {
      expect(attach({ headroom }).neighbours).toBeUndefined();
    }
  });

  it("FUI: the entries are trimmed (lines, files, then the lowest-ranked entries) under headroom - 48, in rank order", () => {
    const symbols = Array.from({ length: 6 }, (_, i) => `ROOM_${String.fromCharCode(65 + i)}_BUDGET`);
    const served = `export function roomy() { return ${symbols.join(" + ")}; }\n`;
    const files: Record<string, string> = { "src/served.ts": served };
    const uses = symbols.flatMap((s) => [`void ${s};`, `void ${s};`]).join("\n") + "\n";
    for (let f = 0; f < 3; f++) files[`src/u${f}/use.ts`] = uses;
    const ws = makeWorkspace("p15-fui", files);
    const query = `Explain ${symbols.join(", ")}`;
    const attach = (opts?: PlanAidOptions): TaskPackResult => {
      const result = fakeResult([surface("src/served.ts", served)]);
      attachUsageInventory(result, ws, query, opts);
      return result;
    };
    let asked = 0;
    const counting: PlanAidOptions = { headroom: () => { asked++; return 100_000; } };

    attach(counting); // OFF
    expect(asked).toBe(0);

    process.env["TL_USAGE_INVENTORY"] = "1";
    const full = attach().usages!;
    expect(full.map((r) => r.symbol)).toEqual(symbols);
    expect(bytesOf(full)).toBeLessThanOrEqual(1536);
    expect(full.every((r) => r.inventory_complete && r.files.length === 4)).toBe(true); // fits whole: nothing trimmed
    expect(attach(counting).usages).toEqual(full);
    expect(asked).toBe(1);

    // 700 bytes of room: entries lose lines, then files (lowest-ranked first) before any symbol is dropped
    const roomy = attach({ headroom: () => 700 + PLAN_AID_KEY_OVERHEAD_BYTES }).usages!;
    expect(bytesOf(roomy)).toBeLessThanOrEqual(700);
    expect(roomy.map((r) => r.symbol)).toEqual(symbols);
    const fileCounts = roomy.map((r) => r.files.length);
    for (let i = 1; i < fileCounts.length; i++) expect(fileCounts[i]!).toBeLessThanOrEqual(fileCounts[i - 1]!);
    expect(fileCounts[fileCounts.length - 1]).toBeLessThan(4);
    expect(roomy.every((r) => r.total === 7)).toBe(true); // `total` stays exact
    expect(roomy[roomy.length - 1]!.inventory_complete).toBe(false);

    // 300 bytes: only entries that fit whole-rank survive — a prefix of the ranking, in order
    const tight = attach({ headroom: () => 300 + PLAN_AID_KEY_OVERHEAD_BYTES }).usages!;
    expect(bytesOf(tight)).toBeLessThanOrEqual(300);
    expect(tight.length).toBeGreaterThan(0);
    expect(tight.length).toBeLessThan(symbols.length);
    expect(tight.map((r) => r.symbol)).toEqual(symbols.slice(0, tight.length));

    for (const headroom of [() => 0, () => 100, () => Number.NaN, () => { throw new Error("boom"); }]) {
      expect(attach({ headroom }).usages).toBeUndefined();
    }
  });
});

describe("inventory_complete — a file of the scope nobody could read makes the entry incomplete", () => {
  const SERVED = "export function gate(n: number) { return n > HONESTY_CAP; }\n";
  const BASE: Record<string, string> = {
    "pkg/package.json": '{"name":"pkg"}',
    "pkg/src/gate.ts": SERVED,
    "pkg/src/cap.ts": "export const HONESTY_CAP = 3;\n",
  };
  const entryOf = (ws: string): UsageEntry => {
    const rows = computeUsageInventory(fakeResult([surface("pkg/src/gate.ts", SERVED)]), ws, "Explain HONESTY_CAP");
    return rows.find((r) => r.symbol === "HONESTY_CAP")!;
  };

  it("control: every file of the scope scanned, every match listed: complete", () => {
    const entry = entryOf(makeWorkspace("honesty-ctl", BASE));
    expect(entry.total).toBe(2);
    expect(entry.inventory_complete).toBe(true);
  });

  it("a file over the walk's size ceiling (1.2 MB) that the scan skipped: not complete, whatever else is listed", () => {
    const ws = makeWorkspace("honesty-big", { ...BASE, "pkg/src/bundle.ts": `// ${"x".repeat(1_200_000)}\nexport const viaBundle = HONESTY_CAP;\n` });
    const entry = entryOf(ws);
    expect(entry.total).toBe(2); // what the scan saw, exactly as in the control
    expect(entry.files.map((f) => f.path).sort()).toEqual(["pkg/src/cap.ts", "pkg/src/gate.ts"]);
    expect(entry.inventory_complete).toBe(false);
  });

  it("a file the scanner cannot decode as text (UTF-16 without a BOM): not complete", () => {
    const ws = makeWorkspace("honesty-utf16", BASE);
    fs.writeFileSync(path.join(ws, "pkg/src/wide.ts"), Buffer.from("export const w = HONESTY_CAP;\n", "utf16le"));
    const entry = entryOf(ws);
    expect(entry.total).toBe(2);
    expect(entry.inventory_complete).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a directory the walk could not list: not complete", () => {
    const ws = makeWorkspace("honesty-locked", { ...BASE, "pkg/src/locked/inner.ts": "void HONESTY_CAP;\n" });
    const locked = path.join(ws, "pkg/src/locked");
    fs.chmodSync(locked, 0o000);
    try {
      const entry = entryOf(ws);
      expect(entry.total).toBe(2);
      expect(entry.inventory_complete).toBe(false);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe("requestTermsOf — only the first 2,000 characters of a query are examined", () => {
  it("a pathological run is cheap, and text past the bound contributes no term", () => {
    // `A.b.` x 1,500 (6,000 characters) cost ~250 ms; the bound leaves ~30 ms
    const started = performance.now();
    requestTermsOf("A.b.".repeat(1500));
    expect(performance.now() - started).toBeLessThan(150);
    const filler = "please explain this part of the flow ".repeat(60); // 2,220 characters, no code-shaped word
    expect(filler.length).toBeGreaterThan(2000);
    const late = requestTermsOf(`${filler} ZebraCrossing.stripeWidth`);
    expect(late.identifiers).toEqual([]);
    expect(late.qualifiers).toEqual([]);
    const early = requestTermsOf(`ZebraCrossing.stripeWidth ${filler}`);
    expect(early.identifiers).toContain("stripeWidth");
    expect(early.qualifiers).toEqual(["ZebraCrossing"]);
  });
});

describe("F1 — a concept term found in over half of a candidate pool is ignored", () => {
  const cand = (symbol: string, order: number): UsageCandidate => ({
    symbol, surfaceIndex: 0, path: "src/a.ts", kind: "constant", declared: false, declSurface: -1, exported: false, refs0: 1, literal: false, order,
  });
  const terms = requestTermsOf("How is the order refund timeout applied?");
  const categories = (names: readonly string[]): Map<string, number> =>
    new Map(rankUsageCandidates(names.map((name, i) => cand(name, i)), terms).map((r) => [r.symbol, r.category]));
  const ORDERS = ["ORDER_STATUS_OPEN", "ORDER_STATUS_PAID", "ORDER_STATUS_SHIPPED", "ORDER_ITEM_LIMIT"];

  it("`order` in 4 of 7 candidates lifts nobody; the terms that tell candidates apart still do", () => {
    const cat = categories([...ORDERS, "REFUND_WINDOW_DAYS", "PAYMENT_TIMEOUT_MS", "CACHE_TTL_SECONDS"]);
    for (const symbol of ORDERS) expect(cat.get(symbol), symbol).toBe(3); // referenced elsewhere, no longer a concept match
    expect(cat.get("REFUND_WINDOW_DAYS")).toBe(2);
    expect(cat.get("PAYMENT_TIMEOUT_MS")).toBe(2);
    expect(cat.get("CACHE_TTL_SECONDS")).toBe(3);
  });

  it("exactly half is not over half, and a pool under 6 is too small to judge", () => {
    const half = categories([...ORDERS.slice(0, 3), "REFUND_WINDOW_DAYS", "PAYMENT_TIMEOUT_MS", "CACHE_TTL_SECONDS"]); // 3 of 6
    for (const symbol of ORDERS.slice(0, 3)) expect(half.get(symbol), symbol).toBe(2);
    const small = categories([...ORDERS.slice(0, 3), "REFUND_WINDOW_DAYS", "PAYMENT_TIMEOUT_MS"]); // 3 of 5
    for (const symbol of ORDERS.slice(0, 3)) expect(small.get(symbol), symbol).toBe(2);
    const over = categories([...ORDERS, "REFUND_WINDOW_DAYS", "PAYMENT_TIMEOUT_MS"]); // 4 of 6
    for (const symbol of ORDERS) expect(over.get(symbol), symbol).toBe(3);
  });
});

describe("F3 — inside a tier, what the served code references but does not declare comes first", () => {
  const cand = (symbol: string, over: Partial<UsageCandidate> = {}): UsageCandidate => ({
    symbol, surfaceIndex: 0, path: "src/a.ts", kind: "identifier", declared: false, declSurface: -1, exported: false, refs0: 0, literal: false, order: 0, ...over,
  });

  it("referenced-not-declared before served declarations, most used first; tiers keep their order; the exact spelling of a named identifier still leads", () => {
    const terms = requestTermsOf("How does the hold retry limit work?");
    const ranked = rankUsageCandidates([
      cand("HOLD_RETRY_LIMIT", { kind: "constant", declared: true, declSurface: 0, exported: true, refs0: 1, order: 0 }), // three concept matches: the old top
      cand("releaseHold", { kind: "function", declared: true, declSurface: 0, exported: true, order: 1 }),
      cand("sendWithRetry", { refs0: 1, order: 2 }),
      cand("backoffForHold", { refs0: 3, order: 3 }),
      cand("PLAIN_UNRELATED", { kind: "constant", refs0: 4, order: 4 }), // a lower tier, however used
    ], terms);
    expect(ranked.map((r) => r.symbol)).toEqual(["backoffForHold", "sendWithRetry", "HOLD_RETRY_LIMIT", "releaseHold", "PLAIN_UNRELATED"]);
    expect(ranked.map((r) => r.category)).toEqual([2, 2, 2, 2, 3]);
    // tier 1: exact case first, then use
    const named = rankUsageCandidates([cand("RETRY_CAP", { kind: "constant", refs0: 5, order: 0 }), cand("Retry_Cap", { kind: "constant", refs0: 1, order: 1 })], requestTermsOf("Look at `Retry_Cap`"));
    expect(named.map((r) => r.symbol)).toEqual(["Retry_Cap", "RETRY_CAP"]);
  });

  it("end to end: the identifiers the served code leans on lead the inventory, the served definitions follow", () => {
    const served = [
      "export const HOLD_RETRY_LIMIT = 3;",
      "export function releaseHold(id: string) {",
      "  const a = sendWithRetry(id);",
      "  return a + backoffForHold(id) + backoffForHold(a) + backoffForHold(HOLD_RETRY_LIMIT);",
      "}",
      "",
    ].join("\n");
    const ws = makeWorkspace("f3-e2e", {
      "src/hold.ts": served,
      "src/net.ts": "export function sendWithRetry(id: string) { return id; }\nexport function backoffForHold(id: string) { return id; }\n",
      "src/use.ts": "import { releaseHold, HOLD_RETRY_LIMIT } from './hold';\nimport { sendWithRetry, backoffForHold } from './net';\nexport const all = [releaseHold, HOLD_RETRY_LIMIT, sendWithRetry, backoffForHold];\n",
    });
    const rows = computeUsageInventory(fakeResult([surface("src/hold.ts", served)]), ws, "How does the hold retry limit work?");
    expect(rows.map((r) => r.symbol)).toEqual(["backoffForHold", "sendWithRetry", "HOLD_RETRY_LIMIT", "releaseHold"]);
  });
});

describe("F4 — up to 8 symbols fit the same 1.5 KiB cap", () => {
  it("eight entries, in rank order, whole; the ninth candidate is left out", () => {
    const symbols = Array.from({ length: 9 }, (_, i) => `SLOT_${String.fromCharCode(65 + i)}_QUOTA`);
    const served = `export function allocate() { return ${symbols.join(" + ")}; }\n`;
    const uses = symbols.map((s) => `void ${s};`).join("\n") + "\n";
    const ws = makeWorkspace("f4-eight", { "src/served.ts": served, "src/u1.ts": uses, "src/u2.ts": uses });
    const rows = computeUsageInventory(fakeResult([surface("src/served.ts", served)]), ws, `Explain ${symbols.join(", ")}`);
    expect(rows.map((r) => r.symbol)).toEqual(symbols.slice(0, 8));
    expect(Buffer.byteLength(JSON.stringify(rows), "utf8")).toBeLessThanOrEqual(1536);
    expect(rows.every((r) => r.total === 3 && r.inventory_complete)).toBe(true); // nothing had to be trimmed to fit eight
  });
});
