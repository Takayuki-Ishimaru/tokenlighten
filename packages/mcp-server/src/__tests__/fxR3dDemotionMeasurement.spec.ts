/**
 * fxR3dDemotionMeasurement.spec.ts — FX-R3d, defect D10 (2026-09-04).
 *
 * THE DEFECT, MEASURED LIVE. `demoted_count` and `re_suppression_count` were
 * computed from WIRE SHAPE: any evidence row with no `body`, no `prior` and a
 * non-empty `remaining` counted as "demoted". After D8 (FX-R3c) a caller-named
 * file JOINS the frontier bodyless whenever it exceeds the join's inline bound
 * or the pack's byte cap — and on the sealed SF05 replay exactly that shape
 * shipped (a 1514-line caller-named document as `remaining:["1-1514"]`). The
 * attestation read `demoted_count:1, committed:true` while
 * `applySemanticFrontierDemotion` had withheld ZERO bodies.
 *
 * WHY IT MATTERS. `committed` is the engagement signal for the deterministic
 * v2 gate, the smoke floor and the paid A/B. Counting a non-demotion as
 * engagement inflates the treatment arm's own headline claim with a row the
 * lever never touched.
 *
 * THE CONTRACT THIS FILE PINS.
 *   - a marked row that still ships bodyless        -> counted;
 *   - a marked row that ends up with a body/`prior` -> NOT counted;
 *   - an unmarked bodyless row                      -> NEVER counted;
 *   - caller-named D8 rows shipped bodyless are reported separately as
 *     `withheld_named_count`, which never enters `committed`;
 *   - with TL_SF_DEMOTE off all three are ABSENT (not 0), so the legacy trace
 *     shape stays byte-identical (§4.4).
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getTracePath, setTraceEnabledForTest } from "../util/trace.js";
import { finalizeProtocolResponse, runWithProtocolCall } from "../protocol/envelope.js";
import {
  noteSemanticFrontierTraceSeed,
  noteSemanticFrontierWithholding,
} from "../protocol/semanticFrontierTraceContext.js";
import { projectEvidence } from "../protocol/decisionWire.js";
import {
  applyCanonicalTaskDecision,
  applySemanticFrontierDemotion,
  attachSfDemotionResidency,
  isSemanticFrontierDemotionEligible,
} from "../features/task-pack/canonicalDecision.js";
import { annotateSemanticFrontierContinuation } from "../features/task-pack/semanticFrontier.js";
import type { SemanticFrontierTraceSeed } from "../features/task-pack/semanticFrontier.js";
import {
  attachSfPackContext,
  resetSfPackContextTokensForTest,
} from "../features/task-pack/sfSatisfaction.js";
import type { SfStructuralConcern } from "../features/task-pack/sfConcerns.js";
import { markSemanticFrontierNamedJoin } from "../features/task-pack/sfWithholdingMarks.js";
import { resetSfStateForTests, type SfServedLedgerReader } from "../task-state/sfState.js";

// ---------------------------------------------------------------------------
// Harness — the REAL protocol funnel, exactly as sfDemoteTrace.spec.ts drives it
// ---------------------------------------------------------------------------

const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** TL_SF_DEMOTE's own preconditions; the legacy guard stays OFF (exclusive). */
const DEMOTE_ON = {
  TL_SF_STATEFUL: "1",
  TL_SF_DEMOTE: "1",
  TL_SF_STRUCTURAL_CONCERNS: "1",
  TL_SEMANTIC_FRONTIER_GUARD: undefined,
} as const;

afterEach(() => {
  setTraceEnabledForTest(false);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  resetSfPackContextTokensForTest();
  resetSfStateForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-fxr3d-${tag}-`)));
  roots.push(root);
  return root;
}

function traceSeed(tag: string): SemanticFrontierTraceSeed {
  return {
    attestation: {
      schema_version: 1,
      eligible: true,
      attempted: true,
      origin_id: `sha256:${tag}`,
      concerns: [],
      candidates: [],
      relations: [],
      unresolved: [],
      truncated_count: {},
    },
    guard_enabled: false,
    marker_count: 0,
  };
}

function taskPackText(evidence: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    task: { id: "task-fxr3d", coverage: "complete" },
    profile: "generic",
    evidence,
    decision: { kind: "done" },
  });
}

function attestationIn(tracePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(tracePath)) return undefined;
  return fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((record) => record["event"] === "semantic_frontier_attestation");
}

/**
 * Run one whole response through the funnel: publish the seed, publish the
 * producer's withholding marks where `projectEvidence` publishes them, ship
 * `evidence` as the final wire, and return the emitted attestation.
 */
function attestationFor(
  tag: string,
  evidence: readonly Record<string, unknown>[],
  marks: { demoted?: readonly Record<string, unknown>[]; named?: readonly Record<string, unknown>[] } = {},
): Record<string, unknown> | undefined {
  const root = workspace(tag);
  const tracePath = getTracePath(root);
  setTraceEnabledForTest(true);
  runWithProtocolCall({ tool: "read_file", kind: "read.task_pack", workspace: root }, () => {
    noteSemanticFrontierTraceSeed(traceSeed(tag));
    for (const row of marks.demoted ?? []) noteSemanticFrontierWithholding("demoted", row);
    for (const row of marks.named ?? []) noteSemanticFrontierWithholding("named", row);
    finalizeProtocolResponse("read_file", { content: [{ type: "text", text: taskPackText(evidence) }] });
  });
  setTraceEnabledForTest(false);
  return attestationIn(tracePath);
}

// ---------------------------------------------------------------------------
// (1) The exact SF05 shape: a caller-named row joined past the cap
// ---------------------------------------------------------------------------

describe("FX-R3d D10 (1) — a caller-named row that joined the frontier bodyless is not a demotion", () => {
  it("reports demoted_count 0, committed false and withheld_named_count 1", () => {
    setEnv(DEMOTE_ON);
    // The sealed SF05 first call, reduced to its wire shape: one served body,
    // plus the caller-named 1514-line document D8 joined past the inline
    // bound — bodyless, addressable, and never touched by W-DEMOTE.
    const named = {
      handle: "h-contract",
      path: "docs/CONTRACT.md",
      range: "1-1514",
      role: "domain",
      remaining: ["1-1514"],
    };
    const attestation = attestationFor(
      "sf05-shape",
      [{ handle: "h-primary", path: "src/main.c", range: "1-40", body: "int main(void){return 0;}\n" }, named],
      { named: [named] },
    );
    expect(attestation).toBeDefined();
    // PRE-FIX: 1 — the bodyless shape alone was counted.
    expect(attestation?.["demoted_count"]).toBe(0);
    // PRE-FIX: true — engagement claimed for a row the lever never touched.
    expect(attestation?.["committed"]).toBe(false);
    // The row stays VISIBLE: an unserved caller-named address is worth
    // seeing, just not as engagement.
    expect(attestation?.["withheld_named_count"]).toBe(1);
    expect(attestation?.["re_suppression_count"]).toBe(0);
  });

  it("a caller-named row that DID ship its body is not withheld at all", () => {
    setEnv(DEMOTE_ON);
    const named = {
      handle: "h-small",
      path: "docs/SMALL.md",
      range: "1-4",
      role: "domain",
      body: "# small\n",
    };
    const attestation = attestationFor(
      "sf05-inlined",
      [{ handle: "h-primary", path: "src/main.c", range: "1-40", body: "int main(void){return 0;}\n" }, named],
      { named: [named] },
    );
    expect(attestation?.["withheld_named_count"]).toBe(0);
    expect(attestation?.["demoted_count"]).toBe(0);
    expect(attestation?.["committed"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (2) A REAL demotion, driven by the pass itself
// ---------------------------------------------------------------------------

/** A ledger that has NEVER served anything — the ordinary D4 precondition. */
const neverServed: SfServedLedgerReader = {
  hasServedPath: () => false,
  wasFullyServed: () => false,
  servedRangeCoverage: () => undefined,
};

function attachCtx(result: object, concerns: readonly SfStructuralConcern[] = []): void {
  attachSfPackContext(result, {
    snapshot: {
      active: true,
      reason: undefined,
      taskRef: "t-fxr3d",
      lane: "default",
      key: "k-fxr3d",
      stateVersion: 1,
      stateHash: "sha256:fxr3d",
      concerns: [],
      satisfied: [],
      evidenceCount: 0,
      requiredAddresses: [],
      forceServe: false,
      epochFresh: true,
      openNonAdvisory: [],
      allNonAdvisoryClosed: true,
      ledgerWired: true,
    } as never,
    concerns,
    satisfaction: { satisfied: [], proofs: {}, untouched: [], alreadySatisfied: [], openVerify: [] } as never,
    observationOnly: false,
  });
  attachSfDemotionResidency(result, { workspaceRoot: "/ws-fxr3d", ledger: neverServed } as never);
}

/**
 * The deterministic bench's `engagement-catalog` shape, as
 * `fxR3bEngagementMarking.spec.ts` reproduces it: a grounded primary that
 * keeps its body and one large lexical-only supporting surface whose body is
 * what the lever is supposed to withhold.
 */
function engagementCatalogPack(): { result: any; primary: any; supporting: any } {
  const primary = {
    path: "src/engagement.ts",
    handle: "h-engagement",
    range: "1-4",
    role: "unknown",
    code: 'export const ENGAGEMENT_WITNESS = "--semantic-frontier";\n',
    remaining_ranges: [],
  };
  const supporting = {
    path: "src/supporting_notes.ts",
    handle: "h-supporting",
    range: "1-17",
    role: "domain",
    remaining_ranges: ["1-17"],
  };
  return { result: { surfaces: [primary, supporting] }, primary, supporting };
}

describe("FX-R3d D10 (2) — a body the demotion pass actually withheld IS engagement", () => {
  it("reports demoted_count 1, re_suppression_count 0 and committed true", () => {
    setEnv(DEMOTE_ON);
    const { result, supporting } = engagementCatalogPack();
    // The legacy classifier marks the zero-binding row optional; the sigil in
    // the primary's body is what binds the primary and keeps it out.
    annotateSemanticFrontierContinuation(result as never, "--semantic-frontier flag", true);
    // The lever can only withhold a body that exists — this is the byte the
    // response would otherwise have sent.
    supporting.code = "// 17 lines of supporting lexical context\n";
    attachCtx(result);
    applyCanonicalTaskDecision(result as never);
    expect(isSemanticFrontierDemotionEligible(supporting)).toBe(true);
    expect(applySemanticFrontierDemotion(result as never)).toBe(1);
    expect(supporting.code, "the pass took the body").toBeUndefined();

    // The whole chain in ONE call context, exactly as the funnel runs it: the
    // projector publishes the pass's marks, the envelope observes them against
    // the wire it is about to ship.
    const root = workspace("real-demotion");
    const tracePath = getTracePath(root);
    setTraceEnabledForTest(true);
    runWithProtocolCall({ tool: "read_file", kind: "read.task_pack", workspace: root }, () => {
      noteSemanticFrontierTraceSeed(traceSeed("real-demotion"));
      const evidence = projectEvidence(result.surfaces) as unknown as Record<string, unknown>[];
      const demotedRow = evidence.find((row) => row["path"] === "src/supporting_notes.ts");
      expect(demotedRow?.["body"], "a demoted row is bodyless").toBeUndefined();
      expect(demotedRow?.["remaining"]).toEqual(["1-17"]);
      finalizeProtocolResponse("read_file", { content: [{ type: "text", text: taskPackText(evidence) }] });
    });
    setTraceEnabledForTest(false);

    const attestation = attestationIn(tracePath);
    expect(attestation?.["demoted_count"]).toBe(1);
    expect(attestation?.["re_suppression_count"]).toBe(0);
    expect(attestation?.["withheld_named_count"]).toBe(0);
    expect(attestation?.["committed"]).toBe(true);
  });

  it("the pass's mark rides a Symbol-keyed own property that never reaches the wire", () => {
    setEnv(DEMOTE_ON);
    const { result, supporting } = engagementCatalogPack();
    annotateSemanticFrontierContinuation(result as never, "--semantic-frontier flag", true);
    supporting.code = "// supporting\n";
    attachCtx(result);
    applyCanonicalTaskDecision(result as never);
    applySemanticFrontierDemotion(result as never);
    // Ruling (bb): enumerable, so `{...surface}` carries it; symbol-keyed, so
    // `JSON.stringify` drops it. Both halves, asserted.
    const copy = { ...supporting };
    expect(JSON.stringify(supporting)).not.toContain("sfWithheldBody");
    expect(Object.keys(supporting)).not.toContain("sfWithheldBody");
    expect(Object.getOwnPropertySymbols(copy).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (3) A marked row that regained its body
// ---------------------------------------------------------------------------

describe("FX-R3d D10 (3) — a marked row that ships bytes after all is not counted", () => {
  it("a body on the final wire (force_serve re-serve) un-counts the mark", () => {
    setEnv(DEMOTE_ON);
    const marked = { handle: "h-x", path: "src/x.ts", range: "1-9", remaining: ["1-9"] };
    // The mark is taken against the addressing triple; the row that actually
    // SHIPS carries a body (a `task.force_serve` re-serve bypasses dedup and
    // puts the bytes back on the wire).
    const attestation = attestationFor(
      "regained-body",
      [
        { handle: "h-primary", path: "src/main.ts", range: "1-3", body: "ok\n" },
        { ...marked, body: "export const x = 1;\n" },
      ],
      { demoted: [marked] },
    );
    expect(attestation?.["demoted_count"]).toBe(0);
    expect(attestation?.["committed"]).toBe(false);
  });

  it("a `prior` restatement on the final wire also un-counts the mark", () => {
    setEnv(DEMOTE_ON);
    const marked = { handle: "h-y", path: "src/y.ts", range: "1-9", remaining: ["1-9"] };
    const attestation = attestationFor(
      "regained-prior",
      [
        { handle: "h-primary", path: "src/main.ts", range: "1-3", body: "ok\n" },
        { ...marked, prior: "read_file mode=task_pack (earlier in this session)" },
      ],
      { demoted: [marked] },
    );
    expect(attestation?.["demoted_count"]).toBe(0);
    expect(attestation?.["committed"]).toBe(false);
  });

  it("an UNMARKED bodyless row never counts, whatever its shape", () => {
    setEnv(DEMOTE_ON);
    const attestation = attestationFor("unmarked-bodyless", [
      { handle: "h-primary", path: "src/main.ts", range: "1-3", body: "ok\n" },
      { handle: "h-capped", path: "src/capped.ts", range: "1-900", remaining: ["1-900"] },
    ]);
    expect(attestation?.["demoted_count"]).toBe(0);
    expect(attestation?.["withheld_named_count"]).toBe(0);
    expect(attestation?.["committed"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (4) The legacy arm
// ---------------------------------------------------------------------------

describe("FX-R3d D10 (4) — with TL_SF_DEMOTE off the counters are ABSENT, not zero", () => {
  it("emits no demoted_count / re_suppression_count / withheld_named_count key at all", () => {
    setEnv({ TL_SF_DEMOTE: undefined, TL_SEMANTIC_FRONTIER_GUARD: undefined });
    const named = { handle: "h-contract", path: "docs/CONTRACT.md", range: "1-1514", remaining: ["1-1514"] };
    const attestation = attestationFor(
      "legacy-arm",
      [{ handle: "h-primary", path: "src/main.c", range: "1-40", body: "x\n" }, named],
      { named: [named] },
    );
    expect(attestation).toBeDefined();
    expect(attestation).not.toHaveProperty("demoted_count");
    expect(attestation).not.toHaveProperty("re_suppression_count");
    expect(attestation).not.toHaveProperty("withheld_named_count");
  });
});

// ---------------------------------------------------------------------------
// The D8 join marks its own rows (the producer half of case (1))
// ---------------------------------------------------------------------------

describe("FX-R3d D10 — the caller-named frontier join is what marks a named row", () => {
  it("marks a joined row so the projector can tell it from a demotion", () => {
    const joined = { path: "docs/CONTRACT.md", handle: "h-contract", range: "1-1514" };
    markSemanticFrontierNamedJoin(joined);
    // An unmarked row of the same shape stays unmarked: marking is opt-in,
    // asserted by the producer, never inferred.
    const unmarked = { path: "docs/OTHER.md", handle: "h-other", range: "1-10" };
    expect(Object.getOwnPropertySymbols(joined).length).toBe(1);
    expect(Object.getOwnPropertySymbols(unmarked).length).toBe(0);
    expect(JSON.stringify(joined)).not.toContain("sfNamedJoin");
  });
});
