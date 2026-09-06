/**
 * sfDemoteTrace.spec.ts — W-DEMOTE trace wiring follow-up (§6 P-2).
 *
 * decisionWire.ts's `semanticFrontierDemotionCounters` is a pure, exported
 * function whose own doc comment is explicit: "NOT WIRED INTO
 * `semantic_frontier_attestation` (protocol/envelope.ts) or the trace seed
 * (features/task-pack/semanticFrontier.ts) this wave ... a follow-up wave
 * with envelope.ts in scope can fold these two counts into the existing
 * trace event's privacy-safe counts without changing anything below." This
 * spec covers exactly that follow-up:
 *
 *   - protocol/envelope.ts's `observeSemanticFrontierWire` calls the counters
 *     function over the FINAL wire's own `evidence` array — never over
 *     internal snapshot/ledger state (see envelope.ts's
 *     `semanticFrontierWireExemptPaths` doc comment) — only when
 *     TL_SF_DEMOTE is on; the fields are ABSENT (not zero) when it is off,
 *     so the legacy/off trace shape stays byte-identical.
 *   - features/task-pack/semanticFrontier.ts's `SemanticFrontierWireObservation`
 *     carries the two counts through to the emitted
 *     `semantic_frontier_attestation` record via its existing observation
 *     spread, unchanged.
 *   - `emitSemanticFrontierFinalTrace` emits a trace-only
 *     `sf_demote_invariant_violation` event (never a throw into the
 *     response) whenever `re_suppression_count` is ever nonzero, so the
 *     P-2 invariant is independently checkable from the trace stream alone.
 *
 * These tests drive the REAL production funnel (`runWithProtocolCall` +
 * `finalizeProtocolResponse`), the same low-level pattern
 * semanticFrontierTrace.spec.ts's own "attests once, honestly" / "concurrent"
 * / "nested" cases already use, with hand-built final `evidence` rows — the
 * exact shape `observeSemanticFrontierWire` reads off the actual codec'd
 * wire. Driving the full canonicalDecision/sfSatisfaction machinery that
 * PRODUCES a real demoted row is sfDemote.spec.ts's job; decisionWire.ts's
 * own doc comment for `semanticFrontierDemotionCounters` is explicit that it
 * is "independently checkable from the PROJECTED wire shape alone, without
 * re-deriving eligibility" — so exercising THIS wiring from a hand-built
 * wire shape is the intended, targeted way to test it, including the one
 * shape (a re-suppression) the real production pipeline is designed to
 * never produce.
 *
 * FX-R3d (D10, 2026-09-04) UPDATE. A hand-built wire is no longer sufficient
 * on its own: `demoted_count` counts only rows the demotion pass MARKED and
 * the final wire still ships bodyless, and a third field
 * (`withheld_named_count`) carries D8's caller-named bodyless rows instead of
 * letting them masquerade as demotions. These cases therefore state the
 * producer's marks alongside the wire — exactly where `projectEvidence`
 * publishes them in production. The unmarked-bodyless, regained-body and
 * caller-named cases live in `fxR3dDemotionMeasurement.spec.ts`.
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
import type { SemanticFrontierTraceSeed } from "../features/task-pack/semanticFrontier.js";

const roots: string[] = [];

function workspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-sf-demote-trace-${tag}-`)));
  roots.push(root);
  return root;
}

function recordsAfter(tracePath: string, before: number): Record<string, unknown>[] {
  return fs.existsSync(tracePath)
    ? fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean)
      .slice(before).map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
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

/** A served (fresh-body) final evidence row — NOT the demoted shape. */
function servedRow(evidencePath: string, handle: string): Record<string, unknown> {
  return { handle, path: evidencePath, range: "1-1", body: "x" };
}

/** A demoted final evidence row: bodyless, prior-less, full `remaining` (§3.5.1). */
function demotedRow(evidencePath: string, handle: string): Record<string, unknown> {
  return { handle, path: evidencePath, remaining: ["1-999"] };
}

function taskPackText(evidence: Record<string, unknown>[]): string {
  return JSON.stringify({
    task: { id: "task-sf-demote-trace", coverage: "complete" },
    profile: "generic",
    evidence,
    decision: { kind: "done" },
  });
}

/**
 * FX-R3d (D10, 2026-09-04): a hand-built wire is no longer enough to make a
 * row count as demoted. `demoted_count` is the intersection of the demotion
 * pass's OWN marks with the final wire, so these tests must state the
 * producer's claim too — `demotedMarks` is the stand-in for
 * `applySemanticFrontierDemotion` having taken those bodies, published exactly
 * where `projectEvidence` publishes it in production. A row left unmarked is
 * the SF05 case: bodyless on the wire, but nothing withheld it, so it does not
 * count (see `fxR3dDemotionMeasurement.spec.ts`).
 */
function emitFinal(
  root: string,
  seedTag: string,
  evidence: Record<string, unknown>[],
  marks: { demoted?: Record<string, unknown>[]; named?: Record<string, unknown>[] } = {},
): void {
  runWithProtocolCall({ tool: "read_file", kind: "read.task_pack", workspace: root }, () => {
    noteSemanticFrontierTraceSeed(traceSeed(seedTag));
    for (const row of marks.demoted ?? []) noteSemanticFrontierWithholding("demoted", row);
    for (const row of marks.named ?? []) noteSemanticFrontierWithholding("named", row);
    finalizeProtocolResponse("read_file", { content: [{ type: "text", text: taskPackText(evidence) }] });
  });
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  setTraceEnabledForTest(false);
  delete process.env["TL_SF_DEMOTE"];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("W-DEMOTE trace wiring (§6 P-2)", () => {
  it("flag off: the attestation record carries no demoted_count/re_suppression_count key at all (byte-identical legacy shape)", () => {
    const root = workspace("flag-off");
    const tracePath = getTracePath(root);
    setTraceEnabledForTest(true);
    // No TL_SF_DEMOTE override in this test: the flag defaults off.
    emitFinal(root, "flag-off", [
      servedRow("src/a.ts", "h-a"),
      demotedRow("src/b.ts", "h-b"),
    ]);
    const events = recordsAfter(tracePath, 0).filter((record) => record["event"] === "semantic_frontier_attestation");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).not.toHaveProperty("demoted_count");
    expect(event).not.toHaveProperty("re_suppression_count");
    const violations = recordsAfter(tracePath, 0).filter((record) => record["event"] === "sf_demote_invariant_violation");
    expect(violations).toHaveLength(0);
  });

  it("flag on, clean demotion: demoted_count equals the WITHHELD rows still shipping bodyless, and re_suppression_count is 0", () => {
    withEnv({ TL_SF_DEMOTE: "1" }, () => {
      const root = workspace("flag-on-clean");
      const tracePath = getTracePath(root);
      setTraceEnabledForTest(true);
      const withheld = [
        demotedRow("src/optional-1.ts", "h-optional-1"),
        demotedRow("src/optional-2.ts", "h-optional-2"),
      ];
      emitFinal(
        root,
        "flag-on-clean",
        [servedRow("src/required.ts", "h-required"), ...withheld],
        { demoted: withheld },
      );
      const events = recordsAfter(tracePath, 0).filter((record) => record["event"] === "semantic_frontier_attestation");
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event["demoted_count"]).toBe(2);
      expect(event["re_suppression_count"]).toBe(0);
      const violations = recordsAfter(tracePath, 0).filter((record) => record["event"] === "sf_demote_invariant_violation");
      expect(violations).toHaveLength(0);
    });
  });

  it("flag on, synthetic re-suppression: a demoted row sharing a path with an already-served row counts as 1, and is reported trace-only without throwing", () => {
    withEnv({ TL_SF_DEMOTE: "1" }, () => {
      const root = workspace("flag-on-resuppress");
      const tracePath = getTracePath(root);
      setTraceEnabledForTest(true);
      // The real production pipeline never produces this shape by
      // construction (isSemanticFrontierDemotionEligible is opt-in and
      // fails closed per I-2/D4) — this hand-built evidence array
      // constructs the wire-observable signature directly, to prove the
      // trace-only invariant check fires without ever throwing into the
      // response itself.
      const withheld = [
        demotedRow("src/dup.ts", "h-dup-demoted"),
        demotedRow("src/clean.ts", "h-clean-demoted"),
      ];
      expect(() => emitFinal(
        root,
        "flag-on-resuppress",
        [servedRow("src/dup.ts", "h-dup-served"), ...withheld],
        { demoted: withheld },
      )).not.toThrow();
      const events = recordsAfter(tracePath, 0).filter((record) => record["event"] === "semantic_frontier_attestation");
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event["demoted_count"]).toBe(2);
      expect(event["re_suppression_count"]).toBe(1);
      const violations = recordsAfter(tracePath, 0).filter((record) => record["event"] === "sf_demote_invariant_violation");
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ re_suppression_count: 1, demoted_count: 2 });
      // Privacy: the violation event never carries the colliding path itself.
      expect(JSON.stringify(violations[0])).not.toContain("src/dup.ts");
    });
  });
});
