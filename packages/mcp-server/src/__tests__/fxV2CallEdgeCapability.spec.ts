// ---------------------------------------------------------------------------
// fxV2CallEdgeCapability.spec.ts — FX-V2 (round 20B finding 1, HIGH,
// 2026-09-04, ruling (y)) capability-gate certification.
//
// RULING (y), binding: the tl-graph token index (`indexStore.ts`'s whole-file
// identifier-token counting; `graph.ts`'s `LANG_PATTERNS`, which do not even
// capture TS/JS class methods) is NOT a call-edge source. `callers` may be
// emitted ONLY from a real call-edge source — a SCIP index (`scip.binpb`)
// with call/reference occurrences attributed to the definition, or any
// future provider that yields call sites with file+line — exactly the
// standard FX-D/FX-G-B already applies to `callees`. Otherwise `callers` is
// omitted and `unavailable` includes `"callers"` (with `"callees"`), for
// every anchor shape and language.
//
// SUPERSEDED IN PART BY FX-W1 (round 21B finding 1, HIGH, 2026-09-04, ruling
// (z)): round-21B proved SCIP occurrence roles (Definition/Import/
// ReadAccess/WriteAccess/…) do not prove a call EITHER — SCIP has no
// dedicated call role at all, so `parseScip`'s real `hasCallEdges()` now
// returns `false` too (see `fxW1ScipReferencedByCapability.spec.ts` for the
// full certification of that reader-level fix and the new, weaker
// `hasReferenceOccurrences`/`referenced_by` capability it introduces).
// Section 1's `parseScip` assertion below is updated accordingly. Sections
// 2-3 are UNCHANGED and still certify a real, general mechanism this
// codebase keeps for a FUTURE genuine call-graph provider: they drive
// `createWorkspaceRelationGraphPort` with a hand-built `GraphIndex` double
// whose `hasCallEdges` is directly configurable — they were never a claim
// that today's real SCIP reader is such a provider, only that the port's own
// capability gate works correctly when one exists.
//
// This file certifies the mechanism end to end at three levels:
//
//  1. The REAL reader implementations report the capability correctly:
//     `parseTlGraph` (graph/tlGraphReader.ts) -> `hasCallEdges() === false`
//     unconditionally; `parseScip` (graph/scipReader.ts) -> `hasCallEdges()
//     === false` unconditionally (FX-W1, superseding this file's original
//     `=== true` claim — see above) — both independent of the parsed
//     content, matching `GraphIndex.hasCallEdges`'s doc (graph/index.ts):
//     the capability is a property of the FORMAT, never of any one query.
//
//  2. A minimal in-memory `GraphIndex` double shaped like what a FUTURE
//     genuine call-graph provider would report (`hasCallEdges: () => true`,
//     real occurrence-backed `references()`, no `definitionCount` at all)
//     drives the REAL `createWorkspaceRelationGraphPort` ->
//     `compileRelationPacket` -> `mintRelationHandles` pipeline and proves
//     callers ARE emitted, with real handles, when a proven call-edge
//     source is present — the mechanism this codebase keeps ready, even
//     though no real reader sets `hasCallEdges()` true today.
//
//  3. The SAME double with only `hasCallEdges` flipped to `false` (the
//     token-index — and, as of FX-W1, the SCIP — shape) proves callers are
//     OMITTED and `unavailable` names `"callers"` — the negative control
//     that isolates the capability flag, independent of
//     `definitionCount`/ambiguity/anything else about the double's data.
//
// Every fix-proving assertion below was verified to FAIL against the
// pre-FX-V2 `relationGraphPort.ts` (temporarily reverting the
// `hasCallEdgeSource` gate to `graphIndex !== undefined`): section 2 still
// passes (a `GraphIndex` was present), but section 3's negative control
// fails — callers is emitted from the `hasCallEdges:false` double exactly as
// dishonestly as it was from the real token index in round-20B's report. See
// this task's final report for the exact revert/restore transcript.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseTlGraph } from "../graph/tlGraphReader.js";
import { parseScip } from "../graph/scipReader.js";
import type { GraphIndex } from "../graph/index.js";
import {
  createWorkspaceRelationGraphPort,
  mintRelationHandles,
} from "../features/graph-evidence/relationGraphPort.js";
import { compileRelationPacket } from "../features/graph-evidence/relationPacket.js";

// ---------------------------------------------------------------------------
// 1. Real reader implementations — the capability is a property of the
//    FORMAT, independent of parsed content.
// ---------------------------------------------------------------------------

describe("GraphIndex.hasCallEdges — real reader implementations report the correct capability", () => {
  it("parseTlGraph (tlGraphReader.ts): hasCallEdges() is false, even for a graph with real symbols and references", () => {
    const index = parseTlGraph(
      JSON.stringify({
        version: 1,
        symbols: [
          {
            name: "isHealthy",
            definition: { path: "src/hw/sensor.cpp", line: 3, column: 0 },
            references: [
              { path: "src/monitor.cpp", line: 3, column: 2 },
              { path: "src/app/main.cpp", line: 3, column: 2 },
            ],
          },
        ],
        files: [],
      }),
    );
    expect(index.hasCallEdges?.()).toBe(false);
  });

  it("parseTlGraph: hasCallEdges() is false even for an entirely empty graph", () => {
    const index = parseTlGraph(JSON.stringify({ version: 1, symbols: [], files: [] }));
    expect(index.hasCallEdges?.()).toBe(false);
  });

  it("parseScip (scipReader.ts): hasCallEdges() is false, independent of parsed content (FX-W1, round 21B finding 1, ruling (z) — SUPERSEDES this test's original `true` expectation)", () => {
    // An empty SCIP Index message (zero documents) is still valid protobuf —
    // `hasCallEdges` is a property of the FORMAT, not of whether any
    // occurrence was actually found, so this must read `false` even with
    // nothing decoded — SCIP's occurrence roles (Definition/Import/
    // ReadAccess/WriteAccess/…) never include a "call" role, so no content
    // shape could ever make this `true` (see `fxW1ScipReferencedByCapability
    // .spec.ts` for the full role-decoding certification).
    const index = parseScip(Buffer.alloc(0));
    expect(index.hasCallEdges?.()).toBe(false);
    expect(index.hasReferenceOccurrences?.()).toBe(true);
    expect(index.references("anything")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixture workspace (shared by sections 2 and 3)
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-fxv2-capability-${tag}-`)));
  roots.push(root);
  return root;
}

function writeTsWorkspace(root: string): void {
  write(root, "src/target.ts", ["export function run(): void {", "  return;", "}", ""].join("\n"));
  write(root, "src/__tests__/target.spec.ts", [
    'import { run } from "../target.js";',
    "run();",
    "",
  ].join("\n"));
}

/**
 * A minimal in-memory `GraphIndex` double shaped exactly like
 * `scipReader.ts`'s real `buildGraphIndex` return value: `hasCallEdges`
 * present and configurable, `definitionCount` NOT implemented at all (SCIP's
 * real reader never adds it — see `graph/index.ts`'s own doc: "a `GraphIndex`
 * that does not implement it... `scipReader.ts`'s SCIP-backed index
 * today... is queried with `?.()` and MUST be treated permissively"), and
 * `references()` backed by a REAL occurrence location (not a placeholder).
 */
function scipShapedDouble(hasCallEdges: boolean): GraphIndex {
  return {
    definition: (symbol) => (symbol === "run" ? { path: "src/target.ts", line: 1, column: 0 } : undefined),
    references: (symbol) =>
      symbol === "run" ? [{ path: "src/__tests__/target.spec.ts", line: 2, column: 0 }] : [],
    importsOf: () => [],
    exportsOf: () => [],
    rootHash: () => undefined,
    hasCallEdges: () => hasCallEdges,
  };
}

// ---------------------------------------------------------------------------
// 2. Positive: hasCallEdges: true — callers ARE emitted, with real handles.
// ---------------------------------------------------------------------------

describe("FX-V2: a SCIP-shaped double (hasCallEdges: true) — real callers reach the compiled packet and mint real handles", () => {
  it("compiles definition + caller with a real (non-placeholder) handle; unavailable names only 'callees'", async () => {
    const root = mkWorkspace("scip-true");
    writeTsWorkspace(root);
    const index = scipShapedDouble(true);
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fxv2-scip-true" });

    expect(port.unavailableRelations).toEqual(["callees"]);

    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.resolved).toBe(true);
    expect(packet.callers).toBeDefined();
    expect(packet.callers!.length).toBe(1);
    expect(packet.callers![0]!.path).toBe("src/__tests__/target.spec.ts");
    expect(packet.unavailable).toEqual(["callees"]);

    const { packet: minted, dropped } = mintRelationHandles(packet, root);
    expect(dropped).toEqual([]);
    expect(minted.callers).toBeDefined();
    for (const caller of minted.callers!) {
      expect(caller.handle).toBeDefined();
      expect(caller.handle).not.toMatch(/^unresolved:/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Negative control: SAME double, hasCallEdges: false — callers is
//    OMITTED, isolating the capability flag from every other property of
//    the double's data (real occurrence, no ambiguity).
// ---------------------------------------------------------------------------

describe("FX-V2: the SAME SCIP-shaped double with hasCallEdges: false — callers is OMITTED and unavailable names 'callers' (the token-index shape)", () => {
  it("never emits the real occurrence as a caller once hasCallEdges reports false — isolates the capability flag as the sole gate", async () => {
    const root = mkWorkspace("scip-false");
    writeTsWorkspace(root);
    const index = scipShapedDouble(false);
    const port = await createWorkspaceRelationGraphPort({ workspaceRoot: root, index, generation: "fxv2-scip-false" });

    expect(port.unavailableRelations).toEqual(["callees", "callers"]);
    expect(port.unavailableRelationsForAnchor?.({ symbol: "run" })).toEqual([]);

    const packet = compileRelationPacket({ anchor: { symbol: "run" }, graph: port });
    expect(packet.resolved).toBe(true);
    // Never a fabricated `callers: []` — OMITTED entirely.
    expect(packet.callers).toBeUndefined();
    expect(Object.hasOwn(packet, "callers")).toBe(false);
    expect(packet.truncated.callers).toBeUndefined();
    expect(packet.unavailable).toEqual(["callees", "callers"]);

    const { packet: minted, dropped } = mintRelationHandles(packet, root);
    expect(dropped.some((d) => d.category === "callers")).toBe(false);
    expect(minted.callers).toBeUndefined();
    expect(minted.unavailable).toEqual(["callees", "callers"]);
  });
});
