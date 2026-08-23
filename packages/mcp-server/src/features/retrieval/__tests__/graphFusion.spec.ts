/**
 * graphFusion.spec.ts — Wave C (F-A5): applyHybridRetrieval's wiring of the
 * graph axis at the real fusion seam (a real workspace + a real
 * `.tokenlighten/index/tl-graph.json`, same integration-level convention as
 * profileFusion.spec.ts). Covers: absence-of-graph byte identity,
 * quality-gate participation, hard-floor survival under adversarial graph
 * weights, exact top-1 non-degradation on control queries, and no-gold
 * non-regression — graphRetriever.ts's OWN pure-function behavior (lookup
 * strategy, role scoring, bounds) is covered separately in
 * graphRetriever.spec.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyHybridRetrieval } from "../index.js";
import { setTraceEnabledForTest, getTracePath } from "../../../util/trace.js";
import { NEUTRAL_WEIGHTS } from "../profiles.js";
import type { Candidate } from "../../locator/locateTaskContext.js";
import type { FoundFile, WalkOptions } from "../../../tools/walkRepo.js";

const tmpDirs: string[] = [];

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-graph-fusion-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(workspace: string, rel: string, content: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function writeGraph(workspace: string, graph: unknown): void {
  writeFile(workspace, ".tokenlighten/index/tl-graph.json", JSON.stringify(graph));
}

const emptyWalkCache = { get: (_opts: WalkOptions): FoundFile[] => [] };

let savedRrf: string | undefined;
let savedProfiles: string | undefined;
let savedBm25f: string | undefined;
let savedGraphIndex: string | undefined;
let savedHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  savedRrf = process.env["TL_RRF_FUSION"];
  savedProfiles = process.env["TL_RRF_PROFILES"];
  savedBm25f = process.env["TL_BM25F_CANDIDATE"];
  savedGraphIndex = process.env["TL_GRAPH_INDEX"];
  savedHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tl-graph-fusion-home-"));
  process.env.HOME = tmpHome;
  delete process.env["TL_GRAPH_INDEX"]; // auto mode — the production default
  setTraceEnabledForTest(false);
});

afterEach(() => {
  if (savedRrf === undefined) delete process.env["TL_RRF_FUSION"];
  else process.env["TL_RRF_FUSION"] = savedRrf;
  if (savedProfiles === undefined) delete process.env["TL_RRF_PROFILES"];
  else process.env["TL_RRF_PROFILES"] = savedProfiles;
  if (savedBm25f === undefined) delete process.env["TL_BM25F_CANDIDATE"];
  else process.env["TL_BM25F_CANDIDATE"] = savedBm25f;
  if (savedGraphIndex === undefined) delete process.env["TL_GRAPH_INDEX"];
  else process.env["TL_GRAPH_INDEX"] = savedGraphIndex;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  setTraceEnabledForTest(false);
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

/** A workspace whose real source files back the tl-graph.json fixture written separately by each test — mirrors a real declaration+caller relationship, matching skeleton-engine's own graphBuilder.ts output shape. */
function buildOrdersWorkspace(): string {
  const ws = mkWorkspace();
  writeFile(ws, "src/inventory.ts", "export function reserveStock(sku: string): void {\n  // fixture body\n}\n");
  writeFile(
    ws,
    "src/orders.ts",
    ["import { reserveStock } from \"./inventory.js\";", "", "export function createOrder(): void {", "  reserveStock(\"sku\");", "}"].join("\n") + "\n",
  );
  return ws;
}

function reserveStockGraph(): unknown {
  return {
    version: 1,
    symbols: [
      {
        name: "reserveStock",
        definition: { path: "src/inventory.ts", line: 1, column: 0 },
        references: [{ path: "src/orders.ts", line: 1, column: 0 }],
      },
    ],
    files: [],
  };
}

function baseCandidates(): Candidate[] {
  return [
    { path: "src/inventory.ts", line: 1, symbol: "reserveStock", kind: "structural", why: "harness:seed", score: 0.01 },
    { path: "src/orders.ts", line: 1, symbol: "createOrder", kind: "structural", why: "harness:seed", score: 0.01 },
  ];
}

describe("applyHybridRetrieval — Wave C (F-A5) absence-of-graph byte identity", () => {
  it("a workspace with NO .tokenlighten/index/ directory adds zero candidates, for a query that WOULD graph-match if a graph existed", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    delete process.env["TL_RRF_PROFILES"];
    const ws = buildOrdersWorkspace(); // no tl-graph.json written
    const before = baseCandidates();
    const candidates = [...before];

    await applyHybridRetrieval(
      { workspace: ws, query: "rename reserveStock — which callers need updating", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    expect(candidates).toHaveLength(before.length);
    expect(candidates.map((c) => `${c.path}:${c.line}`).sort()).toEqual(before.map((c) => `${c.path}:${c.line}`).sort());
  });

  it("the SAME call with a real graph present DOES report graph hits — a paired control proving the no-graph case above is caused by graph absence, not some other reason", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    delete process.env["TL_RRF_PROFILES"];
    setTraceEnabledForTest(true);
    const ws = buildOrdersWorkspace();
    writeGraph(ws, reserveStockGraph());
    const candidates = baseCandidates();

    await applyHybridRetrieval(
      { workspace: ws, query: "rename reserveStock — which callers need updating", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    const lines = fs.readFileSync(getTracePath(ws), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.filter((r) => r.event === "hybrid_retrieval_applied").at(-1);
    expect(record.graph_hits, JSON.stringify(record)).toBeGreaterThan(0);
  });

  it("trace graph_hits is exactly 0 when no graph index loads", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    setTraceEnabledForTest(true);
    const ws = buildOrdersWorkspace();
    const candidates = baseCandidates();

    await applyHybridRetrieval(
      { workspace: ws, query: "reserveStock", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    const lines = fs.readFileSync(getTracePath(ws), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.filter((r) => r.event === "hybrid_retrieval_applied").at(-1);
    expect(record.graph_hits).toBe(0);
  });

  it("a graph-favoring weight override is inert when no graph index exists (multiplying nothing changes nothing)", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    const ws = buildOrdersWorkspace();

    const withoutOverride = baseCandidates();
    await applyHybridRetrieval(
      { workspace: ws, query: "reserveStock", codeFiles: [], walkCache: emptyWalkCache },
      withoutOverride,
    );

    const withOverride = baseCandidates();
    await applyHybridRetrieval(
      {
        workspace: ws,
        query: "reserveStock",
        codeFiles: [],
        walkCache: emptyWalkCache,
        retrieverWeights: { graph: 9999 },
      },
      withOverride,
    );

    expect(withOverride.map((c) => c.path)).toEqual(withoutOverride.map((c) => c.path));
  });
});

describe("applyHybridRetrieval — Wave C (F-A5) quality-gate participation", () => {
  it("a graph list with real role/match-count spread passes the gate and is NOT recorded in gated_retrievers", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    setTraceEnabledForTest(true);
    const ws = buildOrdersWorkspace();
    writeGraph(ws, reserveStockGraph());
    const candidates = baseCandidates();

    await applyHybridRetrieval(
      { workspace: ws, query: "reserveStock", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    const lines = fs.readFileSync(getTracePath(ws), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.filter((r) => r.event === "hybrid_retrieval_applied").at(-1);
    expect(record.gated_retrievers.some((g: { retriever: string }) => g.retriever === "graph"), JSON.stringify(record.gated_retrievers)).toBe(false);
  });

  it("a flat (all-reference, single-match, uniform-score) graph list is gated OUT of fusion with reason degenerate-scores, but its candidates still enter the pool", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    setTraceEnabledForTest(true);
    const ws = mkWorkspace();
    writeFile(ws, "src/a.ts", "export function a(): void {}\n");
    // A SINGLE token whose references all land at distinct keys with no
    // definition anywhere and no repeated match — every hit therefore
    // scores identically (REFERENCE_ROLE_SCORE, no match-count bonus),
    // which is exactly qualityGate.ts's "degenerate-scores" (flat tie)
    // shape.
    writeGraph(ws, {
      version: 1,
      symbols: [
        {
          name: "lonelyToken",
          references: [
            { path: "src/a.ts", line: 1, column: 0 },
            { path: "src/b.ts", line: 1, column: 0 },
          ],
        },
      ],
      files: [],
    });
    const candidates: Candidate[] = [{ path: "src/seed.ts", line: 1, kind: "structural", why: "seed", score: 0.01 }];

    await applyHybridRetrieval(
      { workspace: ws, query: "lonelyToken", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    const lines = fs.readFileSync(getTracePath(ws), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const record = lines.filter((r) => r.event === "hybrid_retrieval_applied").at(-1);
    expect(record.gated_retrievers).toEqual(
      expect.arrayContaining([expect.objectContaining({ retriever: "graph", passed: false, reason: "degenerate-scores" })]),
    );
    // Gate failure removes the list from FUSION only — the two reference
    // candidates are still physically present in the pool (disclosure, not
    // silent loss).
    expect(candidates.some((c) => c.path === "src/a.ts")).toBe(true);
    expect(candidates.some((c) => c.path === "src/b.ts")).toBe(true);
  });
});

describe("applyHybridRetrieval — Wave C (F-A5) hard floor holds under adversarial graph weights", () => {
  it("an exact-path candidate stays first even when the graph axis is weighted overwhelmingly and every other axis is muted", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    const ws = mkWorkspace();
    for (let i = 0; i < 8; i++) writeFile(ws, `src/decoy${i}.ts`, `export function decoy${i}(): void {}\n`);
    writeFile(ws, "src/exact.ts", "export const target = 1;\n");

    // A graph packed with many strongly-scored (definition-role, high
    // match-count) hits across every decoy file — adversarially favorable
    // to the graph axis.
    writeGraph(ws, {
      version: 1,
      symbols: Array.from({ length: 8 }, (_, i) => ({
        name: `decoy${i}`,
        definition: { path: `src/decoy${i}.ts`, line: 1, column: 0 },
        references: Array.from({ length: 5 }, (_, j) => ({ path: `src/decoy${i}.ts`, line: 1 + j, column: 0 })),
      })),
      files: [],
    });

    const candidates: Candidate[] = [
      { path: "src/exact.ts", line: 1, kind: "text", why: "exact-text", score: 1.2 },
      ...Array.from({ length: 8 }, (_, i) => ({
        path: `src/decoy${i}.ts`, line: 1, kind: "structural" as const, why: "harness:seed", score: 0.01,
      })),
    ];

    await applyHybridRetrieval(
      {
        workspace: ws,
        query: "decoy0 decoy1 decoy2 decoy3 decoy4 decoy5 decoy6 decoy7",
        codeFiles: [],
        walkCache: emptyWalkCache,
        retrieverWeights: { exact: 0, symbol: 0, reference: 0, bm25f: 0, graph: 1000 },
      },
      candidates,
    );

    expect(candidates[0]!.path, JSON.stringify(candidates.map((c) => c.path))).toBe("src/exact.ts");
  });

  it("holds under NEUTRAL_WEIGHTS too (not just an adversarial vector)", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    delete process.env["TL_BM25F_CANDIDATE"];
    const ws = buildOrdersWorkspace();
    writeGraph(ws, reserveStockGraph());
    const candidates: Candidate[] = [
      { path: "src/exact.ts", line: 1, kind: "text", why: "exact-text", score: 1.2 },
      ...baseCandidates(),
    ];
    writeFile(ws, "src/exact.ts", "export const target = 1;\n");

    await applyHybridRetrieval(
      { workspace: ws, query: "reserveStock", codeFiles: [], walkCache: emptyWalkCache, retrieverWeights: NEUTRAL_WEIGHTS },
      candidates,
    );

    expect(candidates[0]!.path).toBe("src/exact.ts");
  });
});

describe("applyHybridRetrieval — Wave C (F-A5) exact top-1 non-degradation on control queries", () => {
  it("an exact-identifier query's declaration stays top-1 even when a real, matching graph index is present", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_BM25F_CANDIDATE"] = "1";
    const ws = buildOrdersWorkspace();
    writeGraph(ws, reserveStockGraph());
    const candidates: Candidate[] = [
      { path: "src/inventory.ts", line: 1, endLine: 3, symbol: "reserveStock", kind: "symbol", why: "exact-symbol", score: 2.0 },
      ...baseCandidates(),
    ];

    await applyHybridRetrieval(
      { workspace: ws, query: "reserveStock", symbol: "reserveStock", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    expect(candidates[0]!.path).toBe("src/inventory.ts");
    expect(candidates[0]!.symbol).toBe("reserveStock");
  });
});

describe("applyHybridRetrieval — Wave C (F-A5) no-gold non-regression", () => {
  it("a genuinely irrelevant query adds zero candidates even though a real (unrelated) graph index exists for this workspace", async () => {
    process.env["TL_RRF_FUSION"] = "1";
    process.env["TL_BM25F_CANDIDATE"] = "1";
    process.env["TL_RRF_PROFILES"] = "1";
    const ws = buildOrdersWorkspace();
    writeGraph(ws, reserveStockGraph());
    const candidates = baseCandidates();
    const before = candidates.length;

    await applyHybridRetrieval(
      { workspace: ws, query: "rotate the database encryption keys immediately", codeFiles: [], walkCache: emptyWalkCache },
      candidates,
    );

    expect(candidates).toHaveLength(before);
  });
});
