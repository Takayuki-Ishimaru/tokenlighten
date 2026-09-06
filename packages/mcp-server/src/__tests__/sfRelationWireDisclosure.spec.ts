// ---------------------------------------------------------------------------
// sfRelationWireDisclosure.spec.ts — FX-I-B (round 13, HIGH): the seam's
// deterministic `mergeEvidenceGraphs` (features/task-pack/sfRelationSeam.ts)
// rebuilt `{version,nodes,relations}` on every merge and silently dropped
// `TaskEvidenceGraph.unavailable` — a field FX-G-B added specifically so
// `plan.wiring.evidence_graph` can disclose "this producer has no callee
// source at all" rather than let an agent read the absence of `callees`
// edges as "computed, found none". With every SF v2 relation flag on,
// `unavailable` was ALWAYS `undefined` on the wire, contradicting guide
// v85's own instruction ("callees iff not `unavailable`").
//
// This file proves two things:
//
//  1. PRODUCTION SHAPE (section 1 below): a real `buildTaskPack()` call
//     against a real C++ workspace, all four SF v2 relation flags on, ends
//     with `plan.wiring.evidence_graph.unavailable` deep-equal to
//     `["callees", "callers"]` — the real production port
//     (`createWorkspaceRelationGraphPort`, relationGraphPort.ts) always
//     reports `"callees"` in `unavailableRelations` (FX-G-B: no real
//     call-edge source exists anywhere in this codebase yet), so this is
//     what every production relation-packet pack's `callees` disclosure
//     looks like today. Flag-off stays `evidence_graph: undefined`,
//     confirming the fix does not fabricate a field where the seam never
//     ran at all.
//
//     FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)) SUPERSEDES
//     FX-U2's own note here: the real, regenerated `.tokenlighten/index/
//     tl-graph.json` `callersOf` queries is a bare-identifier-TOKEN count
//     (`tlGraphReader.ts`'s `hasCallEdges()` correctly reports `false` for
//     it), never a call-site extraction — round-20B proved that attaching
//     `callersOf` to it fabricates a `direct_calls` relation for a file
//     that merely mentions the anchored method's bare name (a comment, an
//     unrelated same-named local, or the definition's own out-of-line body)
//     at the SAME confidence as a genuine caller. `"callers"` is therefore
//     now named in `unavailable` UNCONDITIONALLY for this real (non-SCIP)
//     index — this file's fixture being collision-free no longer matters
//     for that determination; the ambiguity-collision refinement
//     (`unavailableRelationsForAnchor`, still real machinery) only ever
//     runs on TOP of a proven call-edge source, which this workspace's real
//     index is not. See `relationPacketPort.spec.ts`'s "FX-V2 —
//     hasCallEdges capability gate" section for the mechanism proof against
//     an injected SCIP-shaped double, and `fxU2CallerAttribution.spec.ts`
//     for the companion real-`buildTaskPack()` fabrication-repro proof.
//
//  2. THE MERGE ITSELF (section 2): `sfRelationSeam.ts` exports
//     `mergeEvidenceGraphsForTest` (test-only, mirrors this codebase's
//     `*ForTest` convention — see `evidenceResolution.ts`'s
//     `resetEvidenceMemoForTest`) specifically so this file can drive the
//     union/dedupe/omit-when-empty logic directly. That indirection is
//     necessary because the only production port
//     (`createWorkspaceRelationGraphPort`) unconditionally names `callees`
//     unavailable for EVERY anchor — there is no way to reach a real
//     `buildTaskPack()` pack whose relation packet reports callees as
//     AVAILABLE, so the "omitted when neither side names anything" and
//     "present from just one side" branches are unreachable end to end
//     today and must be proven against the merge function itself.
//
// NOTE ON `truncated`: `TaskEvidenceGraph` (`@tokenlighten/types`) has no
// `truncated` field. `packages/agents-md/templates/AGENTS.md.tmpl` (and its
// `.jp` counterpart) claims one on the wire — see this file's own header
// comment in `sfRelationSeam.ts` and the round-13 report for the exact line;
// that is a guide-copy defect to fix in a future wave, not something this
// file (or `sfRelationSeam.ts`) may invent a wire field to satisfy.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildTaskPack, resetPackDedupeCache, resetRoleInventoryCache } from "../features/task-pack/readCodeTaskPack.js";
import { mergeEvidenceGraphsForTest } from "../features/task-pack/sfRelationSeam.js";
import { resetPackServeLogForTest } from "../util/packServeLog.js";
import { resetAll as resetAllSessions } from "../state/session.js";
import { resetStateStoresForTests } from "../state/stateStore.js";
import { resetSfStateForTests } from "../task-state/sfState.js";
import type { TaskEvidenceGraph } from "@tokenlighten/types";

// ---------------------------------------------------------------------------
// Fixture workspace — same minimal C++ shape as sfRelationSeam.spec.ts's own
// "W-RELATION-SEAM task_pack seam" section (a qualified anchor with a real,
// on-disk definition+declaration, resolved via D5's
// `resolveQualifiedSymbolAnchors`, never via `GraphIndex`).
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-relation-wire-${tag}-`)));
  roots.push(root);
  return root;
}

function writeEkfWorkspace(root: string): void {
  write(root, "include/estimator/ekf.hpp", [
    "#pragma once",
    "namespace est {",
    "class EKF {",
    " public:",
    "  bool isHealthy() const;",
    "};",
    "}  // namespace est",
    "",
  ].join("\n"));
  write(root, "src/estimator/ekf.cpp", [
    "#include \"estimator/ekf.hpp\"",
    "namespace est {",
    "bool EKF::isHealthy() const {",
    "  return true;",
    "}",
    "}  // namespace est",
    "",
  ].join("\n"));
  write(root, "src/app/main.cpp", [
    "#include \"estimator/ekf.hpp\"",
    "void tick(est::EKF& ekf) {",
    "  ekf.isHealthy();",
    "}",
    "",
  ].join("\n"));
}

function fixture(tag: string): string {
  const ws = mkWorkspace(tag);
  writeEkfWorkspace(ws);
  return ws;
}

// Same phrasing as sfRelationSeam.spec.ts's own QUERY, deliberately: it
// matches `QUALIFIED_ANCHOR_RE` on "EKF::isHealthy" directly off the query
// text (no `paths`/`targets` needed) and "connect" is a relational verb
// (`sfDisposition.ts`'s `VERBS` table), reopening the qualified anchor's
// definition concern as `relation` under `taskProfile:"generic"`
// (source:"explicit", non-observation-only).
const QUERY = "Trace connect logic for the EKF::isHealthy relation in the estimator loop";

const FLAGS = ["TL_SF_STATEFUL", "TL_SF_STRUCTURAL_CONCERNS", "TL_SF_RELATION_PACKETS", "TL_GRAPH_EVIDENCE"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const flag of FLAGS) saved.set(flag, process.env[flag]);
  for (const flag of FLAGS) delete process.env[flag];
});

afterEach(() => {
  for (const flag of FLAGS) {
    const previous = saved.get(flag);
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  }
});

function enableAllSfRelationFlags(): void {
  process.env["TL_SF_STATEFUL"] = "1";
  process.env["TL_SF_STRUCTURAL_CONCERNS"] = "1";
  process.env["TL_SF_RELATION_PACKETS"] = "1";
  process.env["TL_GRAPH_EVIDENCE"] = "1";
}

function resetPackCaches(): void {
  resetPackDedupeCache();
  resetRoleInventoryCache();
  resetAllSessions();
  resetStateStoresForTests();
  resetSfStateForTests();
  resetPackServeLogForTest();
}

// ---------------------------------------------------------------------------
// 1. Production shape — real buildTaskPack(), all four flags on
// ---------------------------------------------------------------------------

describe("FX-I-B: plan.wiring.evidence_graph.unavailable on the real wire", () => {
  it("all four SF v2 relation flags on: unavailable deep-equals [\"callees\",\"callers\"] — the real port's structural gap reaches the wire (FX-V2: a token index is never a call-edge source)", async () => {
    const ws = fixture("wire-disclosure-on");
    resetPackCaches();
    enableAllSfRelationFlags();

    const pack = await buildTaskPack({ query: QUERY, taskProfile: "generic", lane: "spec" }, ws);

    expect(pack.wiring?.evidence_graph).toBeDefined();
    const graph = pack.wiring!.evidence_graph!;
    // The exact assertion the round-13 finding demanded: before that fix,
    // `mergeEvidenceGraphs` rebuilt `{version,nodes,relations}` and this was
    // always `undefined` regardless of what the port reported. `callees`
    // stays unavailable — this codebase has no real call-edge source for
    // that direction at all (FX-G-B).
    //
    // FX-V2 (round 20B finding 1, HIGH, 2026-09-04, ruling (y)): `callers`
    // is ALSO unavailable here, unconditionally — the real, regenerated
    // `tl-graph.json` `callersOf` queries is a bare-identifier-token count
    // (`hasCallEdges() === false`), never a call-site extraction, so
    // attaching it would fabricate `direct_calls` from mere textual
    // co-occurrence regardless of how unambiguous "isHealthy" is in this
    // fixture. This supersedes FX-U2's prior claim that this fixture's real
    // caller is "attributable" — attributable-but-unverified is exactly the
    // defect FX-V2 closes.
    expect(graph.unavailable).toEqual(["callees", "callers"]);
    // No `direct_calls` relation ever reaches the wire for this real
    // (non-SCIP) index, even though `src/app/main.cpp` genuinely calls
    // `ekf.isHealthy()` on disk — never guessed, never fabricated.
    expect(graph.relations.some((r) => r.kind === "direct_calls")).toBe(false);
  });

  it("flag-off: no evidence_graph at all — the fix does not fabricate `unavailable` where the seam never ran", async () => {
    const ws = fixture("wire-disclosure-off");
    resetPackCaches();

    const pack = await buildTaskPack({ query: QUERY, taskProfile: "generic", lane: "spec" }, ws);

    expect(pack.wiring?.evidence_graph).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The merge itself — union, dedupe, omit-when-empty
// ---------------------------------------------------------------------------

function emptyGraph(): TaskEvidenceGraph {
  return { version: 1, nodes: [], relations: [] };
}

describe("mergeEvidenceGraphsForTest — unavailable union/dedupe/omit (FX-I-B)", () => {
  it("omits `unavailable` entirely when neither side names anything — never a bare `[]`", () => {
    const merged = mergeEvidenceGraphsForTest(undefined, emptyGraph());
    expect(merged.unavailable).toBeUndefined();
    expect("unavailable" in merged).toBe(false);
  });

  it("carries `unavailable` forward from the addition when the existing graph has none", () => {
    const merged = mergeEvidenceGraphsForTest(emptyGraph(), { ...emptyGraph(), unavailable: ["callees"] });
    expect(merged.unavailable).toEqual(["callees"]);
  });

  it("carries `unavailable` forward from the existing graph when the addition has none", () => {
    const merged = mergeEvidenceGraphsForTest({ ...emptyGraph(), unavailable: ["callees"] }, emptyGraph());
    expect(merged.unavailable).toEqual(["callees"]);
  });

  it("dedupes rather than duplicating when both sides name the same class", () => {
    const merged = mergeEvidenceGraphsForTest(
      { ...emptyGraph(), unavailable: ["callees"] },
      { ...emptyGraph(), unavailable: ["callees"] },
    );
    expect(merged.unavailable).toEqual(["callees"]);
  });

  it("existing=undefined, addition unavailable-only (no nodes/relations) still surfaces", () => {
    const merged = mergeEvidenceGraphsForTest(undefined, { ...emptyGraph(), unavailable: ["callees"] });
    expect(merged.unavailable).toEqual(["callees"]);
    expect(merged.nodes).toEqual([]);
    expect(merged.relations).toEqual([]);
  });
});
