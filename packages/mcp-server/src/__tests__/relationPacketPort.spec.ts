// ---------------------------------------------------------------------------
// relationPacketPort.spec.ts — W-RELATION-WIRE acceptance tests.
//
// Covers: the D5 qualified-anchor resolver's class-scoping surfaced through
// `createWorkspaceRelationGraphPort`'s `resolveDefinition` (never binds
// `Class::method` to a different class's same-named member), an ambiguous
// bare symbol resolving to nothing (never a guess), the port's own bounded
// fan-out for callers/callees (capped at `budget.maxEdges * 2` raw hits
// BEFORE compileRelationPacket ever ranks or truncates them), test-path
// deprioritization via the real repository classifier, `mintRelationHandles`
// producing REAL, round-trippable handles (never an `unresolved:*`
// placeholder), the reconciled `maxBytes` default, and the "not wired into
// any response this wave" purity fence for this module.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createWorkspaceRelationGraphPort,
  mintRelationHandles,
} from "../features/graph-evidence/relationGraphPort.js";
import {
  compileRelationPacket,
  DEFAULT_RELATION_PACKET_BUDGET,
  projectRelationPacketToEvidenceGraph,
} from "../features/graph-evidence/relationPacket.js";
import type { GraphIndex, GraphLocation } from "../graph/index.js";
import { isTestPath as skeletonIsTestPath } from "@tokenlighten/skeleton-engine";
// F7 (round 11): the D5 resolver is now INJECTED into the port rather than
// imported by it (breaks the graph-evidence <-> task-pack import cycle) — a
// test exercising qualified-anchor resolution must pass the real resolver
// through itself, exactly as `features/task-pack/sfRelationSeam.ts` (the
// port's one sanctioned production caller) does.
import { resolveQualifiedSymbolAnchors } from "../features/task-pack/readCodeTaskPack.js";

// ---------------------------------------------------------------------------
// Fixture workspaces
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function write(root: string, rel: string, text: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
}

function mkWorkspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-relation-port-${tag}-`)));
  roots.push(root);
  return root;
}

/** Two C++ classes that both declare and define an `isHealthy() const` member — the D5 class-scoping trap. */
function writeCppEstimatorWorkspace(root: string): void {
  const sibling = (className: string, stem: string, flag: string): void => {
    write(root, `include/estimator/${stem}.hpp`, [
      "#pragma once",
      "namespace est {",
      `class ${className} {`,
      " public:",
      "  void update(float dt);",
      "  bool isHealthy() const;",
      " private:",
      `  bool ${flag} = false;`,
      "};",
      "}  // namespace est",
      "",
    ].join("\n"));
    write(root, `src/estimator/${stem}.cpp`, [
      `#include "estimator/${stem}.hpp"`,
      "namespace est {",
      `void ${className}::update(float dt) {`,
      `  ${flag} = dt > 0.0f;`,
      "}",
      `bool ${className}::isHealthy() const { return ${flag}; }`,
      "}  // namespace est",
      "",
    ].join("\n"));
  };
  sibling("EKF", "ekf", "converged_");
  sibling("AltitudeEstimator", "altitude_estimator", "baro_valid_");
}

/**
 * FX-U2 (round 19B finding 1): a single-class C++ fixture with a qualified
 * anchor (`Sensor::isHealthy`) that has TWO real callers, mirroring the
 * round-19B report's own `Sensor::isHealthy` reproduction exactly (same
 * class name, same two-caller shape) — `isHealthy` is declared on exactly
 * ONE class here, so the bare member name is unambiguous.
 */
function writeSensorWorkspace(root: string): void {
  write(root, "include/hw/sensor.hpp", [
    "#pragma once",
    "namespace hw {",
    "class Sensor {",
    " public:",
    "  bool isHealthy() const;",
    "};",
    "}  // namespace hw",
    "",
  ].join("\n"));
  write(root, "src/hw/sensor.cpp", [
    "#include \"hw/sensor.hpp\"",
    "namespace hw {",
    "bool Sensor::isHealthy() const { return true; }",
    "}  // namespace hw",
    "",
  ].join("\n"));
  write(root, "src/monitor.cpp", [
    "#include \"hw/sensor.hpp\"",
    "void poll(hw::Sensor& s) {",
    "  s.isHealthy();",
    "}",
    "",
  ].join("\n"));
  write(root, "src/app/main.cpp", [
    "#include \"hw/sensor.hpp\"",
    "void tick(hw::Sensor& s) {",
    "  s.isHealthy();",
    "}",
    "",
  ].join("\n"));
}

/** A TS workspace with an unambiguous free function and a name that collides across two classes. */
function writeTsAmbiguityWorkspace(root: string): void {
  write(root, "src/target.ts", ["export function run(): void {", "  return;", "}", ""].join("\n"));
  write(root, "src/widgetA.ts", [
    "export class WidgetA {",
    "  isHealthy(): boolean {",
    "    return true;",
    "  }",
    "}",
    "",
  ].join("\n"));
  write(root, "src/widgetB.ts", [
    "export class WidgetB {",
    "  isHealthy(): boolean {",
    "    return false;",
    "  }",
    "}",
    "",
  ].join("\n"));
  write(root, "src/__tests__/target.spec.ts", [
    'import { run } from "../target.js";',
    "run();",
    "",
  ].join("\n"));
}

/**
 * FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)): defaults
 * `hasCallEdges` to `true` — this file's `fakeGraphIndex` stands in for "a
 * real, PROVEN call-edge source" throughout sections 3-4d below (bounded
 * fan-out, ambiguity handling, mint-handles mechanics — none of which are
 * about the SPECIFIC token-vs-SCIP distinction FX-V2 introduced). A test
 * that specifically wants to exercise "a `GraphIndex` present but NOT a
 * call-edge source" (the actual production shape for `tlGraphReader.ts`,
 * the common case) passes `hasCallEdges: () => false` as an override — see
 * the "FX-V2 — hasCallEdges capability gate" describe block below.
 */
function fakeGraphIndex(overrides: Partial<GraphIndex>): GraphIndex {
  return {
    definition: () => undefined,
    references: () => [],
    importsOf: () => [],
    exportsOf: () => [],
    rootHash: () => "fixture-root-hash",
    hasCallEdges: () => true,
    ...overrides,
  };
}

async function readFileByHandle(handle: string, cwd: string): Promise<Record<string, unknown>> {
  const { callTool } = (await import("../server.js")) as unknown as {
    callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };
  const response = await callTool("read_file", { targets: [{ handle }], cwd, content: "full" });
  return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. Qualified-anchor class scoping (D5), through the real port
// ---------------------------------------------------------------------------

describe("resolveDefinition — qualified anchor class scoping", () => {
  it("never binds Class::method to a different class's same-named member", async () => {
    const root = mkWorkspace("qualified");
    writeCppEstimatorWorkspace(root);
    const port = await createWorkspaceRelationGraphPort({
      workspaceRoot: root,
      qualifiedResolver: resolveQualifiedSymbolAnchors,
    });

    const ekf = port.resolveDefinition({ qualified: { class: "EKF", member: "isHealthy" } });
    const altitude = port.resolveDefinition({ qualified: { class: "AltitudeEstimator", member: "isHealthy" } });

    expect(ekf?.node.path).toBe("src/estimator/ekf.cpp");
    expect(altitude?.node.path).toBe("src/estimator/altitude_estimator.cpp");
    expect(ekf?.node.path).not.toBe(altitude?.node.path);
  });

  it("also resolves a distinct declaration site for the same class-scoped anchor", async () => {
    const root = mkWorkspace("qualified-decl");
    writeCppEstimatorWorkspace(root);
    const port = await createWorkspaceRelationGraphPort({
      workspaceRoot: root,
      qualifiedResolver: resolveQualifiedSymbolAnchors,
    });

    const anchor = { qualified: { class: "EKF", member: "isHealthy" } } as const;
    const definition = port.resolveDefinition(anchor);
    expect(definition).toBeDefined();
    const declaration = port.resolveDeclaration?.(anchor, definition!);
    expect(declaration?.node.path).toBe("include/estimator/ekf.hpp");
  });

  it("F7 (round 11): a qualified anchor resolves to undefined, never a guess, when no qualifiedResolver is injected", async () => {
    const root = mkWorkspace("qualified-no-resolver");
    writeCppEstimatorWorkspace(root);
    // Deliberately NOT passing `qualifiedResolver` — this proves the port no
    // longer imports `resolveQualifiedSymbolAnchors` itself (that import
    // created the graph-evidence <-> task-pack cycle this fix removes).
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root });
    expect(port.resolveDefinition({ qualified: { class: "EKF", member: "isHealthy" } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Bare symbol resolution — unique only
// ---------------------------------------------------------------------------

describe("resolveDefinition — bare symbol, unique match only", () => {
  it("resolves an unambiguous bare symbol", async () => {
    const root = mkWorkspace("bare-unique");
    writeTsAmbiguityWorkspace(root);
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root });

    const site = port.resolveDefinition({ symbol: "run" });
    expect(site?.node.path).toBe("src/target.ts");
  });

  it("an ambiguous bare symbol resolves to nothing, never a guess", async () => {
    const root = mkWorkspace("bare-ambiguous");
    writeTsAmbiguityWorkspace(root);
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root });

    // "isHealthy" is declared identically on WidgetA and WidgetB — no unique
    // owner, so this must come back undefined rather than picking either.
    const site = port.resolveDefinition({ symbol: "isHealthy" });
    expect(site).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Bounded fan-out for callers/callees (§3.7.2: cap requests at
//    budget.maxEdges * 2 BEFORE ranking — independent of compileRelationPacket's
//    own maxNodes/maxEdges truncation, which relationPacket.spec.ts covers).
// ---------------------------------------------------------------------------

describe("edgesFor — bounded fan-out over the real GraphIndex", () => {
  it("surfaces every real caller up to the raw fan-out cap, and compileRelationPacket truncates honestly from there", async () => {
    const root = mkWorkspace("fanout-60");
    writeTsAmbiguityWorkspace(root);
    const locations: GraphLocation[] = Array.from({ length: 70 }, (_, i) => ({
      path: `src/caller${String(i).padStart(3, "0")}.ts`,
      line: 1,
      column: 0,
    }));
    const index = fakeGraphIndex({ references: (symbol) => (symbol === "run" ? locations : []) });
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fixture-gen-1" });

    const definition = port.resolveDefinition({ symbol: "run" });
    expect(definition).toBeDefined();
    const calledBy = port.edgesFor(definition!.node).filter((edge) => edge.type === "CALLED_BY");
    // 70 < DEFAULT_RELATION_PACKET_BUDGET.maxEdges * 2 (96) — nothing capped at the port yet.
    expect(calledBy.length).toBe(70);

    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.resolved).toBe(true);
    expect(packet.callers!.length).toBeLessThan(70);
    expect(packet.truncated.callers).toBeGreaterThan(0);
    expect(packet.callers!.length + packet.truncated.callers!).toBe(70);
  });

  it("caps the raw fetch at budget.maxEdges * 2 before any ranking happens", async () => {
    const root = mkWorkspace("fanout-cap");
    writeTsAmbiguityWorkspace(root);
    const locations: GraphLocation[] = Array.from({ length: 500 }, (_, i) => ({
      path: `src/many${String(i).padStart(3, "0")}.ts`,
      line: 1,
      column: 0,
    }));
    const index = fakeGraphIndex({ references: (symbol) => (symbol === "run" ? locations : []) });
    const port = await createWorkspaceRelationGraphPort({
      workspaceRoot: root,
      index,
      generation: "fixture-gen-2",
      budget: { maxEdges: 48 },
    });

    const definition = port.resolveDefinition({ symbol: "run" });
    const calledBy = port.edgesFor(definition!.node).filter((edge) => edge.type === "CALLED_BY");
    expect(calledBy.length).toBe(96); // maxEdges (48) * 2
  });

  // F3 (round 11): `calleesOf` used to treat "does `name` appear ANYWHERE in
  // the anchor's own file" as proof of a call — a file-level co-occurrence,
  // not a call edge. Neither `GraphIndex` nor the parsed symbol table
  // exposes a real call edge anywhere in this codebase today, so per the
  // fix `calleesOf` stays honestly empty rather than fabricate one.
  it("never fabricates a callee edge from a mere file-level reference, even when the reference is genuinely a call", async () => {
    const root = mkWorkspace("callees");
    write(root, "src/target.ts", ["export function run(): void {", "  helper();", "}", ""].join("\n"));
    write(root, "src/helper.ts", ["export function helper(): void {", "  return;", "}", ""].join("\n"));
    const index = fakeGraphIndex({
      references: (symbol) => (symbol === "helper" ? [{ path: "src/target.ts", line: 2, column: 2 }] : []),
      definition: (symbol) => (symbol === "helper" ? { path: "src/helper.ts", line: 1, column: 0 } : undefined),
    });
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fixture-gen-3" });

    const definition = port.resolveDefinition({ symbol: "run" });
    expect(definition).toBeDefined();
    const calls = port.edgesFor(definition!.node).filter((edge) => edge.type === "CALLS");
    expect(calls).toEqual([]);
  });

  it("a file that references a name textually but never calls it yields no callee edge", async () => {
    const root = mkWorkspace("callees-textual-only");
    // `run`'s own body never mentions "isHealthy" at all — the ONLY mention
    // is a comment inside a DIFFERENT function in the SAME file. A
    // file-level (not call-site-scoped) heuristic would have fabricated a
    // callee edge from `run` to `isHealthy` here.
    write(root, "src/target.ts", [
      "export function run(): void {",
      "  return;",
      "}",
      "export function isHealthy(): boolean {",
      "  return true;",
      "}",
      "export function textualOnly(): void {",
      "  // isHealthy referenced here in a comment; run() never calls it",
      "}",
      "",
    ].join("\n"));
    const index = fakeGraphIndex({
      references: (symbol) => (symbol === "isHealthy" ? [{ path: "src/target.ts", line: 8, column: 2 }] : []),
      definition: (symbol) => (symbol === "isHealthy" ? { path: "src/target.ts", line: 4, column: 0 } : undefined),
    });
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fixture-gen-4" });

    const definition = port.resolveDefinition({ symbol: "run" });
    expect(definition).toBeDefined();
    const calls = port.edgesFor(definition!.node).filter((edge) => edge.type === "CALLS");
    expect(calls).toEqual([]);
  });

  it("same-named members in two classes never cross into each other's callees", async () => {
    const root = mkWorkspace("callees-no-cross");
    writeCppEstimatorWorkspace(root);
    // Both EKF and AltitudeEstimator declare `isHealthy` identically — a
    // bare-name lookup is ambiguous by construction, and a qualified lookup
    // is never wired into `calleesOf` at all. Either way, querying one
    // class's callees must never surface anything grounded in the other's
    // file.
    const index = fakeGraphIndex({
      references: (symbol) =>
        symbol === "isHealthy" ? [{ path: "src/estimator/altitude_estimator.cpp", line: 1, column: 0 }] : [],
    });
    const port = await createWorkspaceRelationGraphPort({
      workspaceRoot: root,
      index,
      generation: "fixture-gen-5",
      qualifiedResolver: resolveQualifiedSymbolAnchors,
    });

    const ekfDefinition = port.resolveDefinition({ qualified: { class: "EKF", member: "isHealthy" } });
    expect(ekfDefinition).toBeDefined();
    const calls = port.edgesFor(ekfDefinition!.node).filter((edge) => edge.type === "CALLS");
    expect(calls.some((edge) => edge.to.path === "src/estimator/altitude_estimator.cpp")).toBe(false);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Test-path deprioritization — the real repository classifier
// ---------------------------------------------------------------------------

describe("isTestPath — the real repository classifier, not a bespoke one", () => {
  it("matches @tokenlighten/skeleton-engine's isTestPath exactly", async () => {
    const root = mkWorkspace("testpath");
    writeTsAmbiguityWorkspace(root);
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root });
    expect(port.isTestPath).toBeDefined();

    for (const candidate of ["src/__tests__/target.spec.ts", "src/target.ts", "src/widgetA.ts"]) {
      expect(port.isTestPath!(candidate)).toBe(skeletonIsTestPath(candidate));
    }
    expect(port.isTestPath!("src/__tests__/target.spec.ts")).toBe(true);
    expect(port.isTestPath!("src/target.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4b. FX-G-B (round 12, MEDIUM finding 4): this port discloses "callees" as
// structurally unavailable, unconditionally — there is no real call-edge
// source (see the `calleesOf` removal note in `relationGraphPort.ts`), so a
// `RelationPacket` this port compiles must never present `callees: []` as if
// the class had been attempted and found empty.
//
// 4c. FX-R2 (round 18B finding 2, HIGH): the SYMMETRIC case for callers.
// Before this fix, `callersOf` returned `[]` unconditionally whenever
// `graphIndex === undefined` (no `.tokenlighten/index/tl-graph.json`/
// `scip.binpb` on disk — the default for any workspace TL has not indexed,
// since TL never writes that file itself) — a computed-and-empty result
// masquerading a "no source at all" gap, exactly the FX-G-B `callees` defect
// this codebase already fixed once. These tests reproduce round-18B's
// `p6_port.mts` against a REAL workspace with a REAL caller on disk (never a
// mock/fixture graph) and prove: (a) with no index, `callers` is OMITTED
// (never `[]`) and BOTH classes land in `unavailableRelations`/`unavailable`,
// sorted; (b) with a real index present, callers are computed normally and
// ONLY `callees` is unavailable (no regression to the FX-G-B case); (c) the
// omission survives `mintRelationHandles` unchanged, exactly like `callees`.
// ---------------------------------------------------------------------------

describe("unavailableRelations — callees disclosed as unsupported, not silently empty", () => {
  it("always reports callees unavailable, and never attaches a calleesOf capability", async () => {
    const root = mkWorkspace("unavailable-callees");
    writeTsAmbiguityWorkspace(root);
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root });
    // FX-R2: this workspace has no `.tokenlighten/index/` at all, so — as of
    // this fix — `callers` is unavailable here too (see describe block 4c
    // below for the full HIGH-finding reproduction). This assertion widens
    // from the pre-fix `["callees"]` to also name the newly-disclosed gap.
    expect(port.unavailableRelations).toEqual(["callees", "callers"]);
  });
});

describe("FX-R2 — callers disclosed as unsupported when no real GraphIndex exists (round 18B finding 2, HIGH)", () => {
  it("PRE-FIX REPRO: with no index on disk, a REAL on-disk caller is never surfaced, and the port must disclose callers as unavailable rather than silently empty", async () => {
    const root = mkWorkspace("unavailable-callers-no-index");
    // A real caller: `run()` is called from `src/__tests__/target.spec.ts`.
    // No `.tokenlighten/index/` directory is ever created in this workspace —
    // `createWorkspaceRelationGraphPort` below is given no `index` option and
    // none is loaded from disk, matching round-18B's `p6_port.mts` exactly
    // (a fresh workspace, the real port factory, zero test-only injection).
    writeTsAmbiguityWorkspace(root);
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root });

    expect(port.unavailableRelations).toEqual(["callees", "callers"]);

    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.resolved).toBe(true);
    // The defect this reproduces: pre-fix, `packet.callers` was `[]` here —
    // a fabricated "computed, no callers" even though `run()` genuinely has
    // a caller on disk. Post-fix, `callers` is OMITTED (never `[]`), and
    // `truncated.callers` is omitted alongside it.
    expect(packet.callers).toBeUndefined();
    expect(Object.hasOwn(packet, "callers")).toBe(false);
    expect(packet.truncated.callers).toBeUndefined();
    expect(Object.hasOwn(packet.truncated, "callers")).toBe(false);
    // Sorted, and names BOTH structurally-uncomputable classes.
    expect(packet.unavailable).toEqual(["callees", "callers"]);

    // The omission survives handle minting unchanged, exactly like `callees`
    // (FX-G-B's own `mintRelationHandles carries the omission... unchanged`
    // test, mirrored here for the symmetric class).
    const { packet: minted, dropped } = mintRelationHandles(packet, root);
    expect(dropped.some((d) => d.category === "callers")).toBe(false);
    expect(minted.callers).toBeUndefined();
    expect(Object.hasOwn(minted.truncated, "callers")).toBe(false);
    expect(minted.unavailable).toEqual(["callees", "callers"]);
  });

  it("with a real GraphIndex present, callers are computed normally and ONLY callees stays unavailable (no regression)", async () => {
    const root = mkWorkspace("callers-available-with-index");
    writeTsAmbiguityWorkspace(root);
    // A real (injected, but genuinely queried) GraphIndex — mirrors this
    // file's own `fakeGraphIndex` convention used throughout section 3 above.
    // FX-V2: `hasCallEdges: () => true` marks it a PROVEN call-edge source —
    // without this, `callersOf` would no longer be attached at all (see the
    // "FX-V2 — hasCallEdges capability gate" describe block below for the
    // `false` case this test used to conflate with "no index").
    const index: GraphIndex = {
      definition: () => undefined,
      references: (symbol) => (symbol === "run" ? [{ path: "src/__tests__/target.spec.ts", line: 2, column: 0 }] : []),
      importsOf: () => [],
      exportsOf: () => [],
      rootHash: () => "fixture-root-hash",
      hasCallEdges: () => true,
    };
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fixture-gen-callers" });

    // Only the FX-G-B gap remains — callers has a real source now.
    expect(port.unavailableRelations).toEqual(["callees"]);

    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.resolved).toBe(true);
    expect(packet.callers).toBeDefined();
    expect(packet.callers!.length).toBe(1);
    expect(packet.callers![0]!.path).toBe("src/__tests__/target.spec.ts");
    expect(packet.truncated.callers).toBe(0);
    expect(packet.unavailable).toEqual(["callees"]);
  });
});

// ---------------------------------------------------------------------------
// 4d. FX-U2 (round 19B finding 1, HIGH, 2026-09-04): `resolveDefinition`
// keyed the `callersOf` query by the anchor's QUALIFIED spelling
// ("Sensor::isHealthy"), but `tlGraphReader.ts`'s `references()` is an
// exact-string lookup keyed by the graph builder's BARE symbol name only —
// so `callersOf` was a guaranteed-empty lookup for EVERY qualified anchor,
// in every workspace, regardless of how many real callers existed, while
// `port.unavailableRelations` still reported `callers` as available
// (`graphIndex !== undefined`). The packet therefore asserted a computed,
// empty `callers: []` — "no callers" — when the truth was "never attempted
// with a key that could match". These tests reproduce round-19B's
// `p5c_qualified_wire.mts`/`p5d_qualified_key_mismatch.mts` (the flagship
// `Sensor::isHealthy` / `PaymentGateway::authorize` anchor shape) at the
// port level and prove the fix: (a) an unambiguous qualified anchor's real
// callers are now attributed via the bare member name; (b) a bare name that
// collides across two classes (no per-reference class-scope in this index
// schema to disambiguate) is disclosed as `unavailable` rather than guessed
// — never a fabricated `callers:[]`; (c) a bare-symbol anchor's existing
// behavior is unchanged (no regression).
// ---------------------------------------------------------------------------

describe("FX-U2 — qualified anchor callers attribution (round 19B finding 1, HIGH)", () => {
  it("PRE-FIX REPRO: an unambiguous qualified anchor's real callers are attributed via the BARE member name, never the qualified spelling the index never records", async () => {
    const root = mkWorkspace("fxu2-unambiguous");
    writeSensorWorkspace(root);
    // The real `tlGraphReader.ts` never records a "Class::member" key —
    // only "isHealthy" — so this mock, keyed the same way, mirrors
    // production exactly; `definitionCount` reports exactly one definition
    // site for "isHealthy" (only `Sensor` declares it here).
    const index = fakeGraphIndex({
      references: (symbol) =>
        symbol === "isHealthy"
          ? [
              { path: "src/monitor.cpp", line: 3, column: 2 },
              { path: "src/app/main.cpp", line: 3, column: 2 },
            ]
          : [],
      definitionCount: (symbol) => (symbol === "isHealthy" ? 1 : 0),
    });
    const port = await createWorkspaceRelationGraphPort({
      workspaceRoot: root,
      index,
      generation: "fixture-gen-fxu2-unambiguous",
      qualifiedResolver: resolveQualifiedSymbolAnchors,
    });

    const anchor = { qualified: { class: "Sensor", member: "isHealthy" } } as const;
    expect(port.unavailableRelationsForAnchor?.(anchor)).toEqual([]);
    // Port-wide capability is unaffected — only the per-anchor hook changes.
    expect(port.unavailableRelations).toEqual(["callees"]);

    const packet = compileRelationPacket({ anchor, graph: port });
    expect(packet.resolved).toBe(true);
    expect(Object.hasOwn(packet, "callers")).toBe(true);
    expect(packet.callers!.map((c) => c.path).sort()).toEqual(["src/app/main.cpp", "src/monitor.cpp"]);
    expect(packet.truncated.callers).toBe(0);
    expect(packet.unavailable).toEqual(["callees"]);

    // Handles mint and the wire projection carries a real `direct_calls`
    // relation — never an `unresolved:*` placeholder.
    const { packet: minted } = mintRelationHandles(packet, root);
    expect(minted.callers!.every((c) => c.handle !== undefined && !c.handle.startsWith("unresolved:"))).toBe(true);
    const projected = projectRelationPacketToEvidenceGraph(minted);
    expect(projected.relations.some((r) => r.kind === "direct_calls")).toBe(true);
    expect(projected.unavailable).toEqual(["callees"]);
  });

  it("a bare name colliding across two classes: callers is OMITTED (never callers:[]) and unavailable names 'callers', for EITHER class", async () => {
    const root = mkWorkspace("fxu2-collision");
    writeCppEstimatorWorkspace(root); // EKF and AltitudeEstimator both declare isHealthy.
    // A real index built from this workspace would ALSO conflate references
    // across both classes' definitions under the shared bare name
    // (`graphBuilder.ts`'s `refsByName` is one merged list per bare name,
    // regardless of how many definitions share it) — this mock mirrors that
    // by returning a real caller site under the bare name both classes
    // share, with `definitionCount` correctly reporting the collision.
    const index = fakeGraphIndex({
      references: (symbol) => (symbol === "isHealthy" ? [{ path: "src/app/main.cpp", line: 1, column: 0 }] : []),
      definitionCount: (symbol) => (symbol === "isHealthy" ? 2 : 0),
    });
    const port = await createWorkspaceRelationGraphPort({
      workspaceRoot: root,
      index,
      generation: "fixture-gen-fxu2-collision",
      qualifiedResolver: resolveQualifiedSymbolAnchors,
    });

    for (const className of ["EKF", "AltitudeEstimator"] as const) {
      const anchor = { qualified: { class: className, member: "isHealthy" } } as const;
      expect(port.unavailableRelationsForAnchor?.(anchor)).toEqual(["callers"]);

      const packet = compileRelationPacket({ anchor, graph: port });
      expect(packet.resolved).toBe(true);
      // Never a fabricated empty array — the class is OMITTED and named.
      expect(packet.callers).toBeUndefined();
      expect(Object.hasOwn(packet, "callers")).toBe(false);
      expect(packet.truncated.callers).toBeUndefined();
      expect(Object.hasOwn(packet.truncated, "callers")).toBe(false);
      expect(packet.unavailable).toEqual(["callees", "callers"]);

      // Survives handle minting unchanged, exactly like the FX-R2/FX-G-B cases.
      const { packet: minted, dropped } = mintRelationHandles(packet, root);
      expect(dropped.some((d) => d.category === "callers")).toBe(false);
      expect(minted.callers).toBeUndefined();
      expect(minted.unavailable).toEqual(["callees", "callers"]);
    }
  });

  it("bare-symbol anchor control: unchanged by FX-U2 — a port with no `definitionCount` at all still surfaces real callers exactly as before", async () => {
    const root = mkWorkspace("fxu2-bare-control");
    writeTsAmbiguityWorkspace(root);
    // Deliberately omits `definitionCount` — the exact shape of the
    // pre-existing "with a real GraphIndex present" test above — proving
    // the permissive fallback when a `GraphIndex` does not implement the
    // new optional accessor at all. `hasCallEdges: () => true` IS required
    // here (FX-V2): unlike `definitionCount`, an absent `hasCallEdges` is
    // never permissive — see the "FX-V2 — hasCallEdges capability gate"
    // describe block below for that (opposite-default) case.
    const index: GraphIndex = {
      definition: () => undefined,
      references: (symbol) => (symbol === "run" ? [{ path: "src/__tests__/target.spec.ts", line: 2, column: 0 }] : []),
      importsOf: () => [],
      exportsOf: () => [],
      rootHash: () => "fixture-root-hash",
      hasCallEdges: () => true,
    };
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fixture-gen-fxu2-bare" });

    expect(port.unavailableRelationsForAnchor?.({ symbol: "run" })).toEqual([]);
    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.callers).toBeDefined();
    expect(packet.callers!.length).toBe(1);
    expect(packet.callers![0]!.path).toBe("src/__tests__/target.spec.ts");
    expect(packet.unavailable).toEqual(["callees"]);
  });
});

// ---------------------------------------------------------------------------
// 4e. FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)): a
// `GraphIndex` being present, even one whose bare name is genuinely
// unambiguous (`definitionCount(name) <= 1`) and whose `references()`
// returns a real on-disk caller, is NOT sufficient to attach `callersOf` —
// only `hasCallEdges() === true` is. `tlGraphReader.ts`'s bare-identifier-
// token-counting index (the common production case) always reports `false`
// (see `graph/tlGraphReader.ts`'s own `hasCallEdges` doc); round-20B proved
// that the pre-fix gate ("an index is present") fabricated a `direct_calls`
// relation for a file that merely mentions the anchored method's bare name
// in a comment or an unrelated local, at the SAME confidence as a genuine
// caller. These tests prove the gate now REQUIRES the capability flag,
// independent of `definitionCount`/ambiguity, and that a proven source
// (`hasCallEdges: () => true`) is unaffected (no regression).
// ---------------------------------------------------------------------------

describe("FX-V2 — hasCallEdges capability gate (round 20B finding 1, HIGH)", () => {
  it("hasCallEdges: () => false — callers is OMITTED and unavailable names 'callers', even for an unambiguous bare name with a real on-disk reference", async () => {
    const root = mkWorkspace("fxv2-no-call-edges");
    writeTsAmbiguityWorkspace(root);
    // Mirrors `tlGraphReader.ts`'s actual shape: a real reference and an
    // unambiguous `definitionCount`, but `hasCallEdges` explicitly `false` —
    // exactly what a bare-identifier-token count can honestly claim.
    const index = fakeGraphIndex({
      references: (symbol) =>
        symbol === "run" ? [{ path: "src/__tests__/target.spec.ts", line: 2, column: 0 }] : [],
      definitionCount: (symbol) => (symbol === "run" ? 1 : 0),
      hasCallEdges: () => false,
    });
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fixture-gen-fxv2-no-edges" });

    expect(port.unavailableRelations).toEqual(["callees", "callers"]);
    expect(port.unavailableRelationsForAnchor?.({ symbol: "run" })).toEqual([]);

    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.resolved).toBe(true);
    // Never a fabricated `callers: []` — never the real reference either.
    expect(packet.callers).toBeUndefined();
    expect(Object.hasOwn(packet, "callers")).toBe(false);
    expect(packet.truncated.callers).toBeUndefined();
    expect(packet.unavailable).toEqual(["callees", "callers"]);

    const { packet: minted, dropped } = mintRelationHandles(packet, root);
    expect(dropped.some((d) => d.category === "callers")).toBe(false);
    expect(minted.callers).toBeUndefined();
    expect(minted.unavailable).toEqual(["callees", "callers"]);
  });

  it("hasCallEdges omitted entirely (a hand-built test double predating FX-V2) is treated as false, never permissively as true — the OPPOSITE default from definitionCount", async () => {
    const root = mkWorkspace("fxv2-omitted-capability");
    writeTsAmbiguityWorkspace(root);
    // No `hasCallEdges` key at all, and no `definitionCount` either — the
    // exact literal shape a pre-FX-V2 hand-built `GraphIndex` double has.
    const index: GraphIndex = {
      definition: () => undefined,
      references: (symbol) => (symbol === "run" ? [{ path: "src/__tests__/target.spec.ts", line: 2, column: 0 }] : []),
      importsOf: () => [],
      exportsOf: () => [],
      rootHash: () => "fixture-root-hash",
    };
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fixture-gen-fxv2-omitted" });

    expect(port.unavailableRelations).toEqual(["callees", "callers"]);
    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.callers).toBeUndefined();
    expect(packet.unavailable).toEqual(["callees", "callers"]);
  });

  it("hasCallEdges: () => true — a real caller is admitted and callers is NOT named unavailable (no regression)", async () => {
    const root = mkWorkspace("fxv2-has-call-edges");
    writeTsAmbiguityWorkspace(root);
    const index = fakeGraphIndex({
      references: (symbol) =>
        symbol === "run" ? [{ path: "src/__tests__/target.spec.ts", line: 2, column: 0 }] : [],
      hasCallEdges: () => true,
    });
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fixture-gen-fxv2-has-edges" });

    expect(port.unavailableRelations).toEqual(["callees"]);
    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.callers).toBeDefined();
    expect(packet.callers!.length).toBe(1);
    expect(packet.callers![0]!.path).toBe("src/__tests__/target.spec.ts");
    expect(packet.unavailable).toEqual(["callees"]);
  });
});

// ---------------------------------------------------------------------------
// 5. mintRelationHandles — real, round-trippable handles, never a placeholder
// ---------------------------------------------------------------------------

describe("mintRelationHandles", () => {
  it("mints a real handle for the definition site that read_file can serve", async () => {
    const root = mkWorkspace("mint");
    writeTsAmbiguityWorkspace(root);
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root });
    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.definition?.handle).toBeUndefined(); // the compiler never mints handles itself

    const { packet: minted, dropped } = mintRelationHandles(packet, root);
    expect(dropped).toEqual([]);
    expect(minted.definition?.handle).toBeDefined();
    expect(minted.definition!.handle).not.toMatch(/^unresolved:/);

    const body = await readFileByHandle(minted.definition!.handle!, root);
    expect(JSON.stringify(body)).toContain("src/target.ts");
  });

  // FX-R2 (round 18B finding 4, MEDIUM): before this fix, `mintRelationHandles`
  // built its returned `core` object with no `over_budget` key at all, so
  // even after `projectRelationPacketToEvidenceGraph` was fixed to forward
  // `over_budget`, the ONE production caller (`sfRelationSeam.ts`'s
  // `compileSfRelationPackets`, which always mints before projecting) would
  // still have silently lost the disclosure one seam earlier.
  it("carries over_budget forward unchanged, exactly like unavailable", () => {
    const packet = {
      anchor: { symbol: "authorize" },
      truncated: { definition: 0, declaration: 0, implementations: 0, referencedBy: 0 },
      bytes: 10,
      resolved: false,
      over_budget: true as const,
    };
    const { packet: minted } = mintRelationHandles(packet, "/does-not-matter");
    expect(minted.over_budget).toBe(true);
  });

  it("drops a site instead of emitting an unresolved:* placeholder when a handle cannot be minted", () => {
    const root = mkWorkspace("mint-drop");
    const packet = {
      anchor: { symbol: "ghost" },
      definition: { path: "src/does-not-exist.ts" },
      callers: [],
      callees: [],
      truncated: { definition: 0, declaration: 0, callers: 0, callees: 0, implementations: 0, referencedBy: 0 },
      bytes: 0,
      resolved: true,
    };
    const { packet: minted, dropped } = mintRelationHandles(packet, root);
    expect(minted.definition).toBeUndefined();
    expect(dropped).toEqual([{ category: "definition", path: "src/does-not-exist.ts", reason: expect.any(String) }]);
    expect(minted.truncated.definition).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. The reconciled maxBytes default (§3.7.2: SF_RELATION_PACKET_BYTES = 4096)
// ---------------------------------------------------------------------------

describe("DEFAULT_RELATION_PACKET_BUDGET", () => {
  it("maxBytes is reconciled to SF_RELATION_PACKET_BYTES = 4096", () => {
    expect(DEFAULT_RELATION_PACKET_BUDGET.maxBytes).toBe(4096);
    expect(DEFAULT_RELATION_PACKET_BUDGET.maxNodes).toBe(24);
    expect(DEFAULT_RELATION_PACKET_BUDGET.maxEdges).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// 7. Purity guard — not wired into any response this wave (flag-off fence)
// ---------------------------------------------------------------------------

describe("relationGraphPort is not wired into any response this wave", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC_DIR = path.resolve(HERE, "..");
  const MODULE_FILE = path.join(SRC_DIR, "features", "graph-evidence", "relationGraphPort.ts");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, out);
      else if (entry.isFile() && absolute.endsWith(".ts")) out.push(absolute);
    }
    return out;
  }

  function importSpecifiers(code: string): string[] {
    const found: string[] = [];
    const patterns = [
      /\bfrom\s*["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']/g,
      /\brequire\s*\(\s*["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        if (match[1] !== undefined) found.push(match[1]);
      }
    }
    return found;
  }

  function isTestFile(absolute: string): boolean {
    return absolute.split(path.sep).includes("__tests__") || /\.(spec|test)\.tsx?$/.test(absolute);
  }

  it("finds the module it is asserting about", () => {
    expect(fs.existsSync(MODULE_FILE)).toBe(true);
  });

  // W-RELATION-SEAM (2026-09-02): features/task-pack/sfRelationSeam.ts is now
  // the ONE sanctioned production importer (the task_pack seam that builds
  // the port once per pack and compiles relation packets from it).
  const SANCTIONED_PRODUCTION_IMPORTER = "features/task-pack/sfRelationSeam.ts";

  it("no production file other than the sanctioned seam imports features/graph-evidence/relationGraphPort", () => {
    const offenders: string[] = [];
    for (const absolute of walk(SRC_DIR)) {
      if (absolute === MODULE_FILE) continue;
      if (isTestFile(absolute)) continue;
      const specifiers = importSpecifiers(fs.readFileSync(absolute, "utf8"));
      if (specifiers.some((s) => s.includes("graph-evidence/relationGraphPort"))) {
        offenders.push(path.relative(SRC_DIR, absolute));
      }
    }
    expect(
      offenders,
      "relationGraphPort must be imported only by tests, plus its one " +
        `sanctioned production seam (${SANCTIONED_PRODUCTION_IMPORTER})`,
    ).toEqual([SANCTIONED_PRODUCTION_IMPORTER]);
  });
});
