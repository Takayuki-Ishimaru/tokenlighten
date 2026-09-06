/**
 * fxR3DemotionSource.spec.ts — FX-R3 (2026-09-04), defects D3 and D4.
 *
 * D3 — RE-SUPPRESSION INVARIANT VIOLATED (TL_SF_DEMOTE). The recursive read
 *      closure minted a second row for a window the pack already served
 *      (D2), the classifier marked that duplicate continuation-optional, and
 *      `demotionEligibleNow` — which knows about caller-named
 *      `requiredAddresses`, open-concern grounding addresses and the
 *      CROSS-CALL served ledger, but nothing about a sibling row minted
 *      moments earlier in the SAME pack — let it be demoted. The recorded
 *      wire (`2026-09-04-semantic-frontier-v2-paid-ab-smoke-r3`, cell
 *      `SF05-aeroctl-contract-wiring-a_tl_sf_v2-r0`, first call) shipped
 *      `drv_baro.h` twice: `1-49` WITH a body and a demoted, bodyless `1-23`
 *      — `demoted_count:2, re_suppression_count:1`, while decisionWire.ts's
 *      own comment claimed the count was "0 by construction".
 *
 *      Two layers ship: (a) an explicit producer `required:true` row is never
 *      marked continuation-optional under the v2 arm, and (b) intra-pack
 *      residency — another row of the same path carrying a body that covers
 *      or overlaps this row's window counts as SERVED (ruling (c): only
 *      `not served` is demotable).
 *
 * D4 — DEMOTABLE MARKING DEPENDED ON THE LEGACY REGEX VOCABULARY. Ruling (i)
 *      fixed only the FLAG gate of `annotateSemanticFrontierContinuation`;
 *      its SOURCE was still `compileConcerns(query)`, so under the ten v2
 *      flags nothing was demotable unless the caller's phrasing matched one
 *      of the five retired regexes. Live proof, same two files:
 *        "Trace ENGAGEMENT_WITNESS continuation relation while retaining the
 *         supporting context."          -> supporting_notes marked optional
 *        "Trace ENGAGEMENT_WITNESS and explain renderEngagement while
 *         retaining the supporting notes."  -> nothing marked at all
 *      Under `sfDemoteEnabled()` the marking source is now the pack's
 *      GROUNDED (non-advisory, bound) structural concern state, supplied by
 *      the pre-booking seam from the SF pack context.
 *
 * The tests drive the REAL production functions
 * (`extractStructuralConcerns`, `annotateSemanticFrontierContinuation`,
 * `applyCanonicalTaskDecision`, `applySemanticFrontierDemotion`,
 * `projectEvidence`, `semanticFrontierDemotionCounters`) over pack shapes
 * assembled to match the recorded wire — the same method, and for the same
 * documented reason, as `fxY2DemotionGroundingRace.spec.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  annotateSemanticFrontierContinuation,
  buildSemanticFrontierAttestation,
  isSemanticFrontierContinuationOptional,
} from "../features/task-pack/semanticFrontier.js";
import {
  applyCanonicalTaskDecision,
  applySemanticFrontierDemotion,
  attachSfDemotionResidency,
  isSemanticFrontierDemotionEligible,
} from "../features/task-pack/canonicalDecision.js";
import {
  projectEvidence,
  semanticFrontierDemotionCounters,
} from "../protocol/decisionWire.js";
import {
  runWithSemanticFrontierTrace,
  semanticFrontierWithholdingMarks,
} from "../protocol/semanticFrontierTraceContext.js";
import type { SemanticFrontierWithholdingMarks } from "../protocol/semanticFrontierTraceContext.js";
import {
  attachSfPackContext,
  resetSfPackContextTokensForTest,
} from "../features/task-pack/sfSatisfaction.js";
import {
  extractStructuralConcerns,
  type SfAnchorResolver,
  type SfStructuralConcern,
  type SfWorkspaceIndex,
} from "../features/task-pack/sfConcerns.js";
import { resetSfStateForTests, type SfServedLedgerReader } from "../task-state/sfState.js";

// ---------------------------------------------------------------------------
// Fixtures (same shapes as sfDemote.spec.ts's own helpers)
// ---------------------------------------------------------------------------

const savedEnv = new Map<string, string | undefined>();

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  resetSfPackContextTokensForTest();
  resetSfStateForTests();
});

/** TL_SF_DEMOTE's own preconditions; the legacy guard stays OFF (exclusive). */
const DEMOTE_ON = {
  TL_SF_STATEFUL: "1",
  TL_SF_DEMOTE: "1",
  TL_SF_STRUCTURAL_CONCERNS: "1",
  TL_SEMANTIC_FRONTIER_GUARD: undefined,
} as const;

function makeSnapshot(overrides: Record<string, unknown> = {}): any {
  return {
    active: true,
    reason: undefined,
    taskRef: "t-fxr3",
    lane: "default",
    key: "k-fxr3",
    stateVersion: 1,
    stateHash: "sha256:fxr3",
    concerns: [],
    satisfied: [],
    evidenceCount: 0,
    requiredAddresses: [],
    forceServe: false,
    epochFresh: true,
    openNonAdvisory: [],
    allNonAdvisoryClosed: true,
    ledgerWired: true,
    ...overrides,
  };
}

function emptySatisfaction(): any {
  return { satisfied: [], proofs: {}, untouched: [], alreadySatisfied: [], openVerify: [] };
}

/** A ledger that has NEVER served anything — the ordinary D4 precondition. */
const neverServed: SfServedLedgerReader = {
  hasServedPath: () => false,
  wasFullyServed: () => false,
  servedRangeCoverage: () => undefined,
};

function attachCtx(result: any, concerns: readonly SfStructuralConcern[] = []): void {
  attachSfPackContext(result, {
    snapshot: makeSnapshot(),
    concerns,
    satisfaction: emptySatisfaction(),
    observationOnly: false,
  });
  attachSfDemotionResidency(result, { workspaceRoot: "/ws-fxr3", ledger: neverServed });
}

/**
 * envelope.ts:435's `semanticFrontierWireExemptPaths`, re-stated here (it is
 * module-private) exactly as the forensic script that reproduced the live
 * violation re-stated it: every projected row that is NOT of the demoted shape
 * exempts its path.
 */
function exemptPathsOf(evidence: readonly any[]): Set<string> {
  const exempt = new Set<string>();
  for (const entry of evidence) {
    // FX-R3d (D10): envelope.ts now exempts a path iff some row for it SHIPS
    // BYTES (a `body`, or a `prior` proving the caller already holds them).
    // A bare or byte-capped bodyless row proves nothing is held, so it no
    // longer confers exemption. Restated here to stay in lockstep.
    if ((entry.body !== undefined || entry.prior !== undefined) && typeof entry.path === "string") {
      exempt.add(entry.path);
    }
  }
  return exempt;
}

/**
 * The projector's RANKING shape — what `semanticFrontierDemotionCounters` USED
 * to count before FX-R3d (D10). Kept here (locally, honestly) so the recorded
 * live observation stays legible in this file while the wire counter itself
 * measures only bodies the demotion pass actually withheld.
 */
function demotedShapeCount(evidence: readonly any[], exemptPaths: ReadonlySet<string>): { shaped: number; exempt: number } {
  let shaped = 0;
  let exempt = 0;
  for (const entry of evidence) {
    if (entry.body !== undefined || entry.prior !== undefined) continue;
    if (!Array.isArray(entry.remaining) || entry.remaining.length === 0) continue;
    shaped += 1;
    if (typeof entry.path === "string" && exemptPaths.has(entry.path)) exempt += 1;
  }
  return { shaped, exempt };
}

/** `projectEvidence` inside the call-local trace state, as the funnel runs it. */
function projectWithMarks(surfaces: unknown): { evidence: any[]; marks: SemanticFrontierWithholdingMarks } {
  return runWithSemanticFrontierTrace(() => ({
    evidence: projectEvidence(surfaces) as any[],
    marks: semanticFrontierWithholdingMarks(),
  }));
}

// ---------------------------------------------------------------------------
// D3 — the exact recorded evidence shape
// ---------------------------------------------------------------------------

describe("FX-R3 D3 — a row whose bytes a sibling row of the same pack already ships is never demoted", () => {
  const QUERY = "--semantic-frontier flag wiring";

  /**
   * The recorded shape: a primary body (the answer floor's survivor), the WIDE
   * served row of `drv_baro.h`, its NARROW bodyless duplicate, and one
   * unrelated supporting candidate that is genuinely demotable.
   */
  function recordedPack(duplicateOverrides: Record<string, unknown> = {}): {
    result: any;
    wide: any;
    duplicate: any;
    unrelated: any;
  } {
    const primary = {
      path: "src/tasks_init.cpp",
      handle: "h-primary",
      range: "386-428",
      role: "unknown",
      code: "// --semantic-frontier primary body\n",
      remaining_ranges: [],
    };
    const wide = {
      path: "include/driver/drv_baro.h",
      handle: "h-baro-wide",
      range: "1-49",
      role: "config",
      code: "// --semantic-frontier baro header, lines 1-49\n",
      remaining_ranges: [],
    };
    // ROLE DEVIATION FROM THE RECORDED WIRE (both rows were `config` there):
    // the legacy classifier's own provider-semantic rule binds ANY `config`
    // row to a `flag` concern, which would make these rows bound and mask the
    // marking step this test needs. The role is cosmetic to the defect — what
    // is under test is the intra-pack residency check, which reads `path`,
    // `range` and the sibling's body.
    const duplicate = {
      path: "include/driver/drv_baro.h",
      handle: "h-baro-narrow",
      range: "1-23",
      role: "domain",
      remaining_ranges: ["1-23"],
      ...duplicateOverrides,
    };
    const unrelated = {
      path: "include/driver/drv_gps.h",
      handle: "h-gps",
      range: "1-58",
      role: "domain",
      remaining_ranges: ["1-58"],
    };
    return { result: { surfaces: [primary, wide, duplicate, unrelated] }, wide, duplicate, unrelated };
  }

  it("FIX-PROVING: the narrow duplicate is INELIGIBLE, the unrelated candidate still demotes, and re_suppression_count is 0", () => {
    setEnv(DEMOTE_ON);
    const { result, wide, duplicate, unrelated } = recordedPack();
    // The legacy guard arm is what marks these rows optional (its `--` sigil
    // concern binds every row carrying the sigil in its body); it is the same
    // classifier the recorded wire ran, and it keeps this test independent of
    // D4's structural source, which the next describe block covers.
    annotateSemanticFrontierContinuation(result, QUERY, true);
    expect(isSemanticFrontierContinuationOptional(duplicate)).toBe(true);
    expect(isSemanticFrontierContinuationOptional(unrelated)).toBe(true);

    attachCtx(result);
    applyCanonicalTaskDecision(result);

    // PRE-FIX: true — the served ledger answers for EARLIER calls only, and
    // no layer looked at the sibling row of this same pack.
    expect(
      isSemanticFrontierDemotionEligible(duplicate),
      "another row of this pack ships bytes covering 1-23",
    ).toBe(false);
    // Unaffected: a candidate with no body-bearing sibling stays demotable.
    expect(isSemanticFrontierDemotionEligible(unrelated)).toBe(true);
    expect(isSemanticFrontierDemotionEligible(wide)).toBe(false);

    // Nothing of the duplicate's path is withheld: the wide row keeps its body
    // and the duplicate keeps whatever it had (nothing).
    applySemanticFrontierDemotion(result);
    expect(typeof wide.code, "the served sibling keeps its body").toBe("string");

    const { evidence, marks } = projectWithMarks(result.surfaces);
    const counters = semanticFrontierDemotionCounters(evidence as any, exemptPathsOf(evidence), marks);
    // The unrelated candidate still ranks into the supporting tail — the
    // eligibility fix is scoped to the duplicate, not a blanket stop.
    expect(
      evidence.some((row: any) => row.path === "include/driver/drv_gps.h" && row.body === undefined),
      "the unrelated candidate is unaffected",
    ).toBe(true);
    // HONEST MEASUREMENT, RESTATED FOR FX-R3d (D10, 2026-09-04).
    //
    // The original note recorded a surprise: the counter was SHAPE-based, so
    // with the closure-minted duplicate still in the pack it read 2/1 even
    // though W-DEMOTE had withheld nothing. That surprise was a defect, and
    // D10 fixed it — `demoted_count` now counts only bodies
    // `applySemanticFrontierDemotion` actually took. Neither of these two rows
    // ever carried one (the recorded pack minted them bodyless), so the honest
    // engagement count for this pack is 0, and the re-suppression witness is 0
    // with it.
    expect(counters.demotedCount).toBe(0);
    expect(counters.reSuppressionCount).toBe(0);
    // The pre-D10 reading, preserved as the recorded observation it was: two
    // rows WEAR the demoted shape, and one of them shares a path with a bodied
    // sibling. D2 is what removes it — the closure no longer mints the row —
    // and `fxR3ClosureRestatement.spec.ts` proves that directly.
    const shape = demotedShapeCount(evidence, exemptPathsOf(evidence));
    expect(shape.shaped).toBe(2);
    expect(shape.exempt).toBe(1);
  });

  it("FIX-PROVING (end state): the pack D2 leaves — one row per served window — projects with re_suppression_count 0", () => {
    setEnv(DEMOTE_ON);
    const { result, duplicate, unrelated } = recordedPack();
    // Exactly what the fixed closure produces: no second row for a window the
    // pack already serves.
    result.surfaces = result.surfaces.filter((surface: any) => surface !== duplicate);
    annotateSemanticFrontierContinuation(result, QUERY, true);
    attachCtx(result);
    applyCanonicalTaskDecision(result);
    expect(isSemanticFrontierDemotionEligible(unrelated)).toBe(true);
    applySemanticFrontierDemotion(result);
    const { evidence, marks } = projectWithMarks(result.surfaces);
    const counters = semanticFrontierDemotionCounters(evidence as any, exemptPathsOf(evidence), marks);
    // PRE-FIX (with the duplicate the closure used to mint): shape 2 / exempt 1.
    expect(counters.reSuppressionCount).toBe(0);
    // FX-R3d (D10): the surviving supporting row was minted bodyless, so no
    // body was withheld and the engagement count is honestly 0. Its RANKING
    // into the supporting tail is what this end state is about.
    expect(counters.demotedCount).toBe(0);
    const shape = demotedShapeCount(evidence, exemptPathsOf(evidence));
    expect(shape.shaped).toBe(1);
    expect(shape.exempt).toBe(0);
    const baroRows = evidence.filter((row: any) => row.path === "include/driver/drv_baro.h");
    expect(baroRows).toHaveLength(1);
    expect(typeof (baroRows[0] as any).body).toBe("string");
  });

  it("an overlapping (not merely contained) sibling window counts as served too", () => {
    setEnv(DEMOTE_ON);
    const { result, duplicate } = recordedPack({ range: "40-80", remaining_ranges: ["40-80"] });
    annotateSemanticFrontierContinuation(result, QUERY, true);
    attachCtx(result);
    applyCanonicalTaskDecision(result);
    expect(isSemanticFrontierDemotionEligible(duplicate)).toBe(false);
  });

  it("a DISJOINT window of the same path is still demotable (the fix is a coverage test, not a path ban)", () => {
    setEnv(DEMOTE_ON);
    const { result, duplicate } = recordedPack({ range: "200-240", remaining_ranges: ["200-240"] });
    annotateSemanticFrontierContinuation(result, QUERY, true);
    attachCtx(result);
    applyCanonicalTaskDecision(result);
    expect(isSemanticFrontierDemotionEligible(duplicate)).toBe(true);
  });

  it("D3(a): an explicit producer `required:true` row is never marked continuation-optional under the v2 arm", () => {
    setEnv(DEMOTE_ON);
    // The closure mints its rows `required:true`; `semanticPrimary` only
    // honors that flag when the producer ALSO used `required:false` somewhere,
    // so on an all-true producer the row was demotable.
    const primary = { path: "src/a.ts", handle: "h-a", range: "1-9", role: "domain", code: "primary\n", remaining_ranges: [] };
    const closureRow = {
      path: "src/b.ts",
      handle: "h-b",
      range: "1-9",
      role: "domain",
      required: true,
      why: "recursive-read-closure",
      code: "closure body\n",
      remaining_ranges: ["1-9"],
    };
    const result: any = { surfaces: [primary, closureRow] };
    const concerns = [groundedConcern("src/a.ts")];
    // The query deliberately carries the legacy `template`/`relation`
    // vocabulary: PRE-FIX that alone marked this row optional (the legacy
    // source, D4), so the assertion below is fix-proving rather than
    // vacuous. `src/b.ts` binds to no grounded concern, so rule (a) is the
    // only thing that can keep its body.
    annotateSemanticFrontierContinuation(
      result,
      "review the contract template wiring relation",
      false,
      concerns,
    );
    expect(isSemanticFrontierContinuationOptional(closureRow)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D4 — the marking source is structure, not phrasing
// ---------------------------------------------------------------------------

/** A grounded (non-advisory, bound) structural concern for `relPath`. */
function groundedConcern(relPath: string): SfStructuralConcern {
  const [concern] = extractStructuralConcerns({
    query: "explain renderEngagement",
    profile: "generic",
    workspaceIndex: { definitionPathsFor: (identifier) => identifier === "renderEngagement" ? [relPath] : [] },
  });
  if (concern === undefined) throw new Error("fixture: the real extractor produced no concern");
  return concern;
}

describe("FX-R3 D4 — under TL_SF_DEMOTE the marking source is the grounded structural concern state", () => {
  const workspaceIndex: SfWorkspaceIndex = {
    definitionPathsFor: (identifier) =>
      identifier === "renderEngagement" || identifier === "ENGAGEMENT_WITNESS" ? ["src/engagement.ts"] : [],
  };
  const anchorResolver: SfAnchorResolver = () => ({});

  const LEGACY_VOCAB_QUERY = "Trace ENGAGEMENT_WITNESS continuation relation while retaining the supporting context.";
  const NO_VOCAB_QUERY = "Trace ENGAGEMENT_WITNESS and explain renderEngagement while retaining the supporting notes.";

  function pack(): { result: any; anchored: any; supporting: any } {
    const anchored = {
      path: "src/engagement.ts",
      handle: "h-engagement",
      range: "1-4",
      role: "domain",
      code: "export function renderEngagement(input: string): string {\n  return input;\n}\n",
      remaining_ranges: [],
    };
    const supporting = {
      path: "src/supporting_notes.ts",
      handle: "h-notes",
      range: "1-2",
      role: "domain",
      code: "export const SUPPORTING_NOTE = 'supporting lexical context';\n",
      remaining_ranges: ["1-2"],
    };
    return { result: { surfaces: [anchored, supporting] }, anchored, supporting };
  }

  function concernsFor(query: string): SfStructuralConcern[] {
    return extractStructuralConcerns({ query, profile: "generic", workspaceIndex, anchorResolver });
  }

  it("sanity: BOTH queries resolve the same grounded structural anchor", () => {
    setEnv(DEMOTE_ON);
    for (const query of [LEGACY_VOCAB_QUERY, NO_VOCAB_QUERY]) {
      const grounded = concernsFor(query).filter((concern) => !concern.advisory && concern.bindings.length > 0);
      expect(grounded.length, query).toBeGreaterThan(0);
      expect(grounded.some((concern) => concern.bindings.includes("src/engagement.ts")), query).toBe(true);
    }
  });

  it("FIX-PROVING: the supporting surface is marked optional for BOTH queries — with and without the legacy vocabulary", () => {
    setEnv(DEMOTE_ON);
    for (const query of [LEGACY_VOCAB_QUERY, NO_VOCAB_QUERY]) {
      const { result, anchored, supporting } = pack();
      annotateSemanticFrontierContinuation(result, query, false, concernsFor(query));
      // PRE-FIX: the second (vocabulary-free) query marked NOTHING, because
      // `compileConcerns(query).length === 0` returned before the loop.
      expect(isSemanticFrontierContinuationOptional(supporting), query).toBe(true);
      expect(isSemanticFrontierContinuationOptional(anchored), query).toBe(false);
    }
  });

  it("a surface bound to a grounded concern by ADDRESS keeps its body even at index >= 1", () => {
    setEnv(DEMOTE_ON);
    const { result, supporting } = pack();
    // Ground the SUPPORTING path instead: now it binds, so it is never marked.
    const concerns = extractStructuralConcerns({
      query: NO_VOCAB_QUERY,
      profile: "generic",
      anchorResolver,
      workspaceIndex: {
        definitionPathsFor: (identifier) =>
          identifier === "renderEngagement" || identifier === "ENGAGEMENT_WITNESS"
            ? ["src/engagement.ts", "src/supporting_notes.ts"]
            : [],
      },
    });
    annotateSemanticFrontierContinuation(result, NO_VOCAB_QUERY, false, concerns);
    expect(isSemanticFrontierContinuationOptional(supporting)).toBe(false);
  });

  it("ZERO grounded structural concerns mark nothing (conservative)", () => {
    setEnv(DEMOTE_ON);
    const { result, supporting } = pack();
    // An advisory-only concern set — exactly what the recorded SF05 query
    // produced — grounds nothing, so the v2 arm marks nothing.
    const advisoryOnly = concernsFor(LEGACY_VOCAB_QUERY).filter((concern) => concern.advisory);
    annotateSemanticFrontierContinuation(result, LEGACY_VOCAB_QUERY, false, advisoryOnly);
    expect(isSemanticFrontierContinuationOptional(supporting)).toBe(false);

    // ...and the same with no concerns supplied at all (the pre-seam call
    // site, where the pack context does not exist yet).
    const fresh = pack();
    annotateSemanticFrontierContinuation(fresh.result, LEGACY_VOCAB_QUERY, false, undefined);
    expect(isSemanticFrontierContinuationOptional(fresh.supporting)).toBe(false);
  });

  it("ATTESTATION: `eligible`/`attempted` report the UNION source under DEMOTE, and the legacy arm is untouched", () => {
    setEnv(DEMOTE_ON);
    const { result } = pack();
    // A query with NO legacy vocabulary at all: `compileConcerns` returns [].
    const query = "explain renderEngagement";
    annotateSemanticFrontierContinuation(result, query, false, concernsFor(NO_VOCAB_QUERY));
    const attestation = buildSemanticFrontierAttestation({ result, query, guardEnabled: false });
    // PRE-FIX both read `false` — the vocabulary was the only source counted,
    // so the v2 arm's own engagement was invisible in its attestation.
    expect(attestation["eligible"]).toBe(true);
    expect(attestation["attempted"]).toBe(true);
    // The enumerated `concerns` array stays the legacy (privacy-safe) list.
    expect(attestation["concerns"]).toEqual([]);
  });

  it("ATTESTATION: with the levers off, the same pack reports the legacy value unchanged", () => {
    setEnv({ TL_SF_STATEFUL: undefined, TL_SF_DEMOTE: undefined, TL_SEMANTIC_FRONTIER_GUARD: undefined });
    const { result } = pack();
    const attestation = buildSemanticFrontierAttestation({
      result,
      query: "explain renderEngagement",
      guardEnabled: false,
    });
    expect(attestation["eligible"]).toBe(false);
    expect(attestation["attempted"]).toBe(false);
  });

  it("LEGACY GUARD ARM unchanged: vocabulary-sourced marking, no structural input consulted", () => {
    setEnv({ TL_SF_STATEFUL: undefined, TL_SF_DEMOTE: undefined, TL_SEMANTIC_FRONTIER_GUARD: "1" });
    const { result, supporting } = pack();
    // The legacy source alone: the vocabulary query marks, and passing
    // structural concerns changes nothing on this arm.
    annotateSemanticFrontierContinuation(result, LEGACY_VOCAB_QUERY, true);
    expect(isSemanticFrontierContinuationOptional(supporting)).toBe(true);

    const withStructural = pack();
    annotateSemanticFrontierContinuation(
      withStructural.result,
      LEGACY_VOCAB_QUERY,
      true,
      concernsFor(LEGACY_VOCAB_QUERY),
    );
    expect(isSemanticFrontierContinuationOptional(withStructural.supporting)).toBe(true);

    // And a vocabulary-free query still marks nothing on the legacy arm —
    // the byte-identical behavior this wave deliberately did not touch.
    const noVocab = pack();
    annotateSemanticFrontierContinuation(noVocab.result, "explain renderEngagement", true);
    expect(isSemanticFrontierContinuationOptional(noVocab.supporting)).toBe(false);
  });
});
