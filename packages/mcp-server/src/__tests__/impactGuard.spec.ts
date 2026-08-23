// impactGuard.spec.ts — V11-06 Known-Local Fast Path v2: Cheap Impact Guard.
//
// Two halves, tested separately per write/impactGuard.ts's own architecture:
//   - evaluateCheapImpactSignals / evaluateGraphImpactSignal / combine* /
//     isFastPathEligible are PURE — driven by hand-built fixtures, no I/O.
//   - attemptGraphImpactProbe performs real I/O against a REAL temp
//     workspace with a real tl-graph.json, mirroring
//     features/graph-evidence/__tests__/adapters.spec.ts's own fixture
//     pattern — this is what proves the "cross-cutting fixture ⇒ not-local"
//     acceptance criterion end-to-end rather than merely at the pure
//     interpretation layer.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resetMissingLoggedForTest } from "../graph/index.js";
import {
  evaluateCheapImpactSignals,
  evaluateGraphImpactSignal,
  combineImpactGuardSignals,
  evaluateImpactGuard,
  isFastPathEligible,
  attemptGraphImpactProbe,
  type ImpactGuardResult,
  type GraphProbeAttempt,
} from "../write/impactGuard.js";
import { EMPTY_TRUNCATION_REPORT } from "../features/graph-evidence/bounds.js";
import { EMPTY_STALE_REPORT } from "../features/graph-evidence/stale.js";
import { fileNode, symbolNode, type Coverage } from "../features/graph-evidence/model.js";
import type { ImpactNodeResult, ImpactResult, ImpactTier } from "../features/graph-evidence/impact.js";

// ---------------------------------------------------------------------------
// (b) Cheap local checks — pure, no I/O.
// ---------------------------------------------------------------------------

describe("evaluateCheapImpactSignals", () => {
  it("clean local edit ⇒ local, no reasons", () => {
    const result = evaluateCheapImpactSignals({
      path: "src/internal/helper.ts",
      searchText: "  const x = compute();",
      replaceText: "  const x = computeFast();",
    });
    expect(result).toEqual({ verdict: "local", reasons: [] });
  });

  it("exported/public keyword in the edited text ⇒ not-local", () => {
    const result = evaluateCheapImpactSignals({ path: "src/a.ts", searchText: "export function foo() {}" });
    expect(result.verdict).toBe("not-local");
    expect(result.reasons).toContain("exported-or-public-surface");
  });

  it("module.exports assignment ⇒ not-local", () => {
    const result = evaluateCheapImpactSignals({ path: "src/a.js", searchText: "module.exports = foo;" });
    expect(result.reasons).toContain("exported-or-public-surface");
  });

  it("a declaration/signature line (class/interface/function/...) ⇒ not-local", () => {
    const result = evaluateCheapImpactSignals({ path: "src/a.ts", searchText: "export function foo(a: number): void {" });
    expect(result.reasons).toContain("declaration-or-signature-edit");
  });

  it("fileText-assisted: a bare identifier fragment sitting on a declaration LINE is still caught", () => {
    const fileText = ["// header", "export function helper() {", "  return 1;", "}"].join("\n");
    const result = evaluateCheapImpactSignals({ path: "src/a.ts", searchText: "helper", fileText });
    expect(result.reasons).toContain("declaration-or-signature-edit");
    // The bare fragment "helper" alone carries no "export" keyword — proves
    // this came from the CONTAINING-LINE lookup, not the raw searchText scan.
    expect(result.reasons).not.toContain("exported-or-public-surface");
  });

  it("a generated-source path ⇒ not-local (reuses graph-evidence's classifyPathRole)", () => {
    const result = evaluateCheapImpactSignals({ path: "src/schema.pb.ts", searchText: "x" });
    expect(result.reasons).toContain("generated-source-path");
  });

  it("a shared/common directory path ⇒ not-local", () => {
    const result = evaluateCheapImpactSignals({ path: "src/shared/constants.ts", searchText: "x" });
    expect(result.reasons).toContain("shared-constant-schema-surface");
  });

  it("a schema-extension file (e.g. .proto) ⇒ not-local", () => {
    const result = evaluateCheapImpactSignals({ path: "api/thing.proto", searchText: "x" });
    expect(result.reasons).toContain("shared-constant-schema-surface");
  });

  it("multiple signals accumulate — every fired reason is reported, not just the first", () => {
    const result = evaluateCheapImpactSignals({ path: "src/shared/schema.proto", searchText: "export class Foo {" });
    expect(result.verdict).toBe("not-local");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["exported-or-public-surface", "declaration-or-signature-edit", "shared-constant-schema-surface"]),
    );
  });
});

// ---------------------------------------------------------------------------
// (a) Graph-evidence probe — pure interpretation half.
// ---------------------------------------------------------------------------

function fakeNode(tier: ImpactTier, depth: number, filePath: string, symbol?: string): ImpactNodeResult {
  const graphNode = symbol !== undefined ? symbolNode(filePath, symbol, "reference-index") : fileNode(filePath, "reference-index");
  return {
    node: graphNode,
    tier,
    depth,
    evidenceClass: "direct",
    proofs: ["reference-index"],
    via: [],
    reason: depth === 0 ? "seed" : "direct-path",
  };
}

function fakeImpactResult(opts: { coverage: Coverage; nodes: readonly ImpactNodeResult[] }): ImpactResult {
  return {
    seeds: [],
    nodes: opts.nodes,
    edges: [],
    counts: { required: 0, likely: 0, informational: 0 },
    coverage: opts.coverage,
    coverageReasons: [],
    truncation: EMPTY_TRUNCATION_REPORT,
    stale: EMPTY_STALE_REPORT,
    providers: [],
    closure: { canClose: opts.coverage === "complete", reasons: [] },
  };
}

describe("evaluateGraphImpactSignal (pure)", () => {
  it("attempted:false (or undefined) ⇒ local, no opinion — TL_GRAPH_EVIDENCE off contributes nothing", () => {
    expect(evaluateGraphImpactSignal({ attempted: false })).toEqual({ verdict: "local", reasons: [] });
    expect(evaluateGraphImpactSignal(undefined)).toEqual({ verdict: "local", reasons: [] });
  });

  it("attempted but unavailable ⇒ unknown — an overlay that couldn't prove anything is never read as 'no impact found'", () => {
    const probe: GraphProbeAttempt = { attempted: true, available: false };
    const result = evaluateGraphImpactSignal(probe);
    expect(result.verdict).toBe("unknown");
    expect(result.reasons).toContain("graph-unavailable");
  });

  it("available but coverage is not 'complete' ⇒ unknown", () => {
    const probe: GraphProbeAttempt = { attempted: true, available: true, result: fakeImpactResult({ coverage: "partial", nodes: [] }) };
    const result = evaluateGraphImpactSignal(probe);
    expect(result.verdict).toBe("unknown");
    expect(result.reasons[0]).toMatch(/^graph-coverage-incomplete:partial/);
  });

  it("complete coverage, only the seed's own depth-0 nodes ⇒ local — the symbol seed's companion FILE node must NOT count as a consumer", () => {
    const nodes = [fakeNode("required", 0, "src/a.ts", "Target"), fakeNode("required", 0, "src/a.ts")];
    const probe: GraphProbeAttempt = { attempted: true, available: true, result: fakeImpactResult({ coverage: "complete", nodes }) };
    expect(evaluateGraphImpactSignal(probe)).toEqual({ verdict: "local", reasons: [] });
  });

  it("complete coverage, exactly ONE required-tier consumer (depth>0) ⇒ local — the threshold is >1, not >0", () => {
    const nodes = [
      fakeNode("required", 0, "src/a.ts", "Target"),
      fakeNode("required", 0, "src/a.ts"),
      fakeNode("required", 1, "src/consumer1.ts"),
    ];
    const probe: GraphProbeAttempt = { attempted: true, available: true, result: fakeImpactResult({ coverage: "complete", nodes }) };
    expect(evaluateGraphImpactSignal(probe).verdict).toBe("local");
  });

  it("complete coverage, 2+ required-tier consumers (depth>0) ⇒ not-local", () => {
    const nodes = [
      fakeNode("required", 0, "src/a.ts", "Target"),
      fakeNode("required", 0, "src/a.ts"),
      fakeNode("required", 1, "src/consumer1.ts"),
      fakeNode("required", 1, "src/consumer2.ts"),
    ];
    const probe: GraphProbeAttempt = { attempted: true, available: true, result: fakeImpactResult({ coverage: "complete", nodes }) };
    const result = evaluateGraphImpactSignal(probe);
    expect(result.verdict).toBe("not-local");
    expect(result.reasons).toContain("graph-required-consumers:2");
  });

  it("likely/informational-tier nodes never count as required-tier consumers, however many there are", () => {
    const nodes = [
      fakeNode("required", 0, "src/a.ts", "Target"),
      fakeNode("required", 0, "src/a.ts"),
      fakeNode("likely", 1, "src/maybe1.ts"),
      fakeNode("informational", 1, "src/maybe2.ts"),
      fakeNode("informational", 2, "src/maybe3.ts"),
    ];
    const probe: GraphProbeAttempt = { attempted: true, available: true, result: fakeImpactResult({ coverage: "complete", nodes }) };
    expect(evaluateGraphImpactSignal(probe).verdict).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Combination and the composed decision
// ---------------------------------------------------------------------------

describe("combineImpactGuardSignals", () => {
  const local: ImpactGuardResult = { verdict: "local", reasons: [] };
  const notLocal: ImpactGuardResult = { verdict: "not-local", reasons: ["cheap-x"] };
  const unknown: ImpactGuardResult = { verdict: "unknown", reasons: ["graph-y"] };

  it("all local ⇒ local", () => {
    expect(combineImpactGuardSignals(local, local)).toEqual({ verdict: "local", reasons: [] });
  });

  it("not-local beats local, and carries its own reasons", () => {
    expect(combineImpactGuardSignals(local, notLocal)).toEqual({ verdict: "not-local", reasons: ["cheap-x"] });
  });

  it("unknown beats local", () => {
    expect(combineImpactGuardSignals(local, unknown)).toEqual({ verdict: "unknown", reasons: ["graph-y"] });
  });

  it("not-local beats unknown — 受入基準 treats both as orchestrated, but the STRONGER exclusion is reported when both fired", () => {
    const combined = combineImpactGuardSignals(unknown, notLocal);
    expect(combined.verdict).toBe("not-local");
    expect(combined.reasons).toEqual(["graph-y", "cheap-x"]);
  });

  it("no signals ⇒ local, empty", () => {
    expect(combineImpactGuardSignals()).toEqual({ verdict: "local", reasons: [] });
  });
});

describe("evaluateImpactGuard (composed cheap + graph)", () => {
  it("a clean cheap signal with no graph attempt ⇒ local", () => {
    const result = evaluateImpactGuard({ path: "src/internal/helper.ts", searchText: "x", replaceText: "y" });
    expect(result.verdict).toBe("local");
  });

  it("an exported-surface cheap signal, graph absent ⇒ not-local regardless", () => {
    const result = evaluateImpactGuard({ path: "src/a.ts", searchText: "export function foo() {}" });
    expect(result.verdict).toBe("not-local");
  });

  it("a clean cheap signal but graph unavailable ⇒ unknown — the graph half still gates it", () => {
    const result = evaluateImpactGuard({
      path: "src/internal/helper.ts",
      searchText: "x",
      graph: { attempted: true, available: false },
    });
    expect(result.verdict).toBe("unknown");
  });
});

describe("isFastPathEligible", () => {
  it("true only when the selection succeeded AND the guard verdict is local", () => {
    expect(isFastPathEligible({ verdict: "local", reasons: [] }, { ok: true })).toBe(true);
  });

  it("false when selection refused, regardless of the guard verdict", () => {
    expect(isFastPathEligible({ verdict: "local", reasons: [] }, { ok: false })).toBe(false);
  });

  it.each(["not-local", "unknown"] as const)(
    "false when the guard verdict is %s, even given a clean selection — 0 false fast path",
    (verdict) => {
      expect(isFastPathEligible({ verdict, reasons: ["x"] }, { ok: true })).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// (a) Graph-evidence probe — real I/O half, against a real temp workspace.
// Mirrors features/graph-evidence/__tests__/adapters.spec.ts's own fixture
// pattern (real tmp dir, real tl-graph.json, real graph/index.ts read).
// ---------------------------------------------------------------------------

describe("attemptGraphImpactProbe (real I/O, TL_GRAPH_EVIDENCE)", () => {
  const tmpDirs: string[] = [];
  let workspace = "";
  let savedFlag: string | undefined;

  function write(relative: string, content: string): void {
    const absolute = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }

  beforeEach(() => {
    resetMissingLoggedForTest();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tl-impact-guard-"));
    tmpDirs.push(workspace);
    savedFlag = process.env["TL_GRAPH_EVIDENCE"];
  });

  afterEach(() => {
    resetMissingLoggedForTest();
    if (savedFlag === undefined) delete process.env["TL_GRAPH_EVIDENCE"];
    else process.env["TL_GRAPH_EVIDENCE"] = savedFlag;
    for (const dir of tmpDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("TL_GRAPH_EVIDENCE off ⇒ attempted:false, no I/O even attempted", () => {
    delete process.env["TL_GRAPH_EVIDENCE"];
    const probe = attemptGraphImpactProbe({
      workspace,
      path: "src/registry.ts",
      symbol: "Registry",
      fileText: "export class Registry {}\n",
    });
    expect(probe).toEqual({ attempted: false });
  });

  it("flag on, no tl-graph.json present ⇒ attempted:true, available:false ⇒ guard unknown, not local", () => {
    process.env["TL_GRAPH_EVIDENCE"] = "1";
    const probe = attemptGraphImpactProbe({
      workspace,
      path: "src/registry.ts",
      symbol: "Registry",
      fileText: "export class Registry {}\n",
    });
    expect(probe).toEqual({ attempted: true, available: false });
    expect(evaluateGraphImpactSignal(probe).verdict).toBe("unknown");
  });

  it("cross-cutting fixture: an exported symbol with >1 real referencing files ⇒ guard says not-local", () => {
    process.env["TL_GRAPH_EVIDENCE"] = "1";
    const registryText = "export class Registry {\n  register(name: string): void {}\n}\n";
    const pluginText = 'import { Registry } from "./registry.js";\nexport class Plugin extends Registry {}\n';
    const consumerText = 'import { Registry } from "./registry.js";\nexport function consume(r: Registry): void {}\n';
    write("src/registry.ts", registryText);
    write("src/plugin.ts", pluginText);
    write("src/consumer.ts", consumerText);
    write(
      path.join(".tokenlighten", "index", "tl-graph.json"),
      JSON.stringify({
        version: 1,
        rootHash: "root-cross-cutting",
        symbols: [
          {
            name: "Registry",
            definition: { path: "src/registry.ts", line: 1, column: 0 },
            references: [
              { path: "src/plugin.ts", line: 1, column: 0 },
              { path: "src/consumer.ts", line: 1, column: 0 },
            ],
          },
        ],
        files: [],
      }),
    );

    const probe = attemptGraphImpactProbe({ workspace, path: "src/registry.ts", symbol: "Registry", fileText: registryText });
    expect(probe.attempted).toBe(true);
    if (!probe.attempted || !probe.available) throw new Error(`probe not available: ${JSON.stringify(probe)}`);
    expect(probe.available).toBe(true);
    expect(probe.result.coverage).toBe("complete");

    const guard = evaluateGraphImpactSignal(probe);
    expect(guard.verdict).toBe("not-local");
    expect(guard.reasons).toContain("graph-required-consumers:2");
  });

  it("the SAME symbol with only 1 referencing file ⇒ local — proves the threshold is >1, not merely >0", () => {
    process.env["TL_GRAPH_EVIDENCE"] = "1";
    const registryText = "export class Registry {}\n";
    const pluginText = 'import { Registry } from "./registry.js";\nexport class Plugin extends Registry {}\n';
    write("src/registry.ts", registryText);
    write("src/plugin.ts", pluginText);
    write(
      path.join(".tokenlighten", "index", "tl-graph.json"),
      JSON.stringify({
        version: 1,
        rootHash: "root-single-consumer",
        symbols: [
          {
            name: "Registry",
            definition: { path: "src/registry.ts", line: 1, column: 0 },
            references: [{ path: "src/plugin.ts", line: 1, column: 0 }],
          },
        ],
        files: [],
      }),
    );

    const probe = attemptGraphImpactProbe({ workspace, path: "src/registry.ts", symbol: "Registry", fileText: registryText });
    expect(evaluateGraphImpactSignal(probe).verdict).toBe("local");
  });

  it("bounds are respected: maxFanout caps how many referencing files are ever READ, and the uncounted rest fail closed to unknown rather than being silently ignored", () => {
    process.env["TL_GRAPH_EVIDENCE"] = "1";
    const registryText = "export class Registry {}\n";
    write("src/registry.ts", registryText);
    const referencePaths: Array<{ path: string; line: number; column: number }> = [];
    for (let i = 0; i < 5; i++) {
      const p = `src/consumer${i}.ts`;
      write(p, `import { Registry } from "./registry.js";\nexport const c${i} = new Registry();\n`);
      referencePaths.push({ path: p, line: 1, column: 0 });
    }
    write(
      path.join(".tokenlighten", "index", "tl-graph.json"),
      JSON.stringify({
        version: 1,
        rootHash: "root-bounded",
        symbols: [{ name: "Registry", definition: { path: "src/registry.ts", line: 1, column: 0 }, references: referencePaths }],
        files: [],
      }),
    );

    let reads = 0;
    const probe = attemptGraphImpactProbe({
      workspace,
      path: "src/registry.ts",
      symbol: "Registry",
      fileText: registryText,
      // maxDepth:2, not 1 — see DEFAULT_GRAPH_PROBE_BOUNDS's doc comment in
      // write/impactGuard.ts for why maxDepth:1 would spuriously truncate
      // (and degrade coverage) the instant ANY depth-1 consumer is found.
      bounds: { maxNodes: 32, maxDepth: 2, maxFanout: 2, maxBytes: 131072, maxDurationMs: 200 },
      readReferencingFile: (relPath) => {
        reads += 1;
        try {
          return fs.readFileSync(path.join(workspace, relPath), "utf8");
        } catch {
          return undefined;
        }
      },
    });
    expect(reads).toBeLessThanOrEqual(2);
    if (!probe.attempted || !probe.available) throw new Error(`probe not available: ${JSON.stringify(probe)}`);
    // The 3 references this probe never read cannot re-prove their edge's
    // source sha (stale.ts's "source-sha-unknown"), so they are EXCLUDED —
    // never silently trusted and never silently dropped from the count. That
    // exclusion alone degrades coverage below "complete", so the verdict
    // fails closed to unknown (orchestrated) rather than confidently
    // asserting not-local from a partial read. This is the SAME "an overlay
    // that couldn't prove everything must never be read as having proven
    // enough" invariant this guard exists to enforce, now demonstrated at
    // its own read-budget boundary rather than at TL_GRAPH_EVIDENCE being off.
    expect(probe.result.coverage).not.toBe("complete");
    expect(probe.result.stale.excluded).toBeGreaterThan(0);
    expect(evaluateGraphImpactSignal(probe).verdict).toBe("unknown");
  });
});
