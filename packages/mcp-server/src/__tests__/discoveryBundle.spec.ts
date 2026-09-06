import { describe, expect, it } from "vitest";
import {
  applyCanonicalTaskDecision,
  canonicalTaskDecisionInvariantViolations,
  deriveCanonicalTaskDecision,
  discoveryBundleAdvisory,
  discoveryBundleNext,
  semanticFrontierNextAllowed,
  sanitizeSemanticFrontierNext,
} from "../features/task-pack/canonicalDecision.js";
import { annotateSemanticFrontierContinuation } from "../features/task-pack/semanticFrontier.js";

function markOptional(result: any, path: string): void {
  for (const surface of result.surfaces) if (surface.path !== path) surface.code = "--semantic-frontier";
  annotateSemanticFrontierContinuation(result, "--semantic-frontier flag", true);
}

describe("discovery bundle next", () => {
  it("leaves legacy partial projector records eligible when surfaces are absent", () => {
    // Capability-gap projection deliberately supplies only contract fields;
    // lack of a surface array is not proof of an optional lexical carrier.
    expect(semanticFrontierNextAllowed({})).toBe(true);
    expect(sanitizeSemanticFrontierNext({}, {
      tool: "search_files", arguments: { action: "find", query: "missing-capability" },
    } as any)).toEqual({ tool: "search_files", arguments: { action: "find", query: "missing-capability" } });
  });

  it("emits the exact bounded qref task-pack bundle for known candidates", () => {
    const result = {
      mode: "task_pack", qref: "q-known", coverage: "partial", coverage_reason: "candidate-list",
      surfaces: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/a.ts" }], missing: [],
    } as any;
    markOptional(result, "src/lexical-only.ts");
    expect(discoveryBundleNext(result)).toEqual({
      tool: "read_file", arguments: { mode: "task_pack", qref: "q-known", paths: ["src/a.ts", "src/b.ts"] },
    });
    expect(discoveryBundleAdvisory(result)).toBe(
      "advisory: bundled paths are limited to files already related by served candidates or evidence edges",
    );
  });

  it("excludes optional lexical surfaces from a candidate-list bundle", () => {
    // This exercises guard-ON suppression semantics explicitly; the guard now
    // defaults OFF (packages/mcp-server/src/util/flags.ts), so force it on for
    // the duration of this assertion and restore whatever was there before.
    const previousGuard = process.env["TL_SEMANTIC_FRONTIER_GUARD"];
    process.env["TL_SEMANTIC_FRONTIER_GUARD"] = "1";
    try {
      const result = {
        mode: "task_pack", qref: "q-required-only", coverage: "partial", coverage_reason: "candidate-list",
        surfaces: [
          { path: "src/required-a.ts" },
          { path: "src/lexical-only.ts", required: false, continuation_optional: true },
          { path: "src/required-b.ts", required: true },
        ], missing: [],
      } as any;
      markOptional(result, "src/lexical-only.ts");
      expect(discoveryBundleNext(result)?.arguments["paths"])
        .toEqual(["src/required-a.ts", "src/required-b.ts"]);
    } finally {
      if (previousGuard === undefined) delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
      else process.env["TL_SEMANTIC_FRONTIER_GUARD"] = previousGuard;
    }
  });

  it("keeps a required remainder on wire evidence as the zoom affordance", async () => {
    const { projectEvidence } = await import("../protocol/decisionWire.js");
    expect(projectEvidence([{
      path: "src/required.ts", handle: "h-required", required: true,
      remaining_ranges: ["31-60"],
    }])).toEqual([{
      path: "src/required.ts", handle: "h-required", remaining: ["31-60"],
    }]);
  });

  it("does not offer a bundle for a complete single-file pack", () => {
    expect(discoveryBundleNext({
      mode: "task_pack", qref: "q-complete", coverage: "complete", surfaces: [{ path: "src/a.ts" }], missing: [],
    } as any)).toBeUndefined();
  });

  it("caps a candidate bundle at eight paths, in surface order", () => {
    const surfaces = Array.from({ length: 11 }, (_, i) => ({ path: `src/f${String(i).padStart(2, "0")}.ts` }));
    const next = discoveryBundleNext({
      mode: "task_pack", qref: "q-cap", coverage: "partial", coverage_reason: "candidate-list",
      surfaces, missing: [],
    } as any);
    expect(next?.arguments["paths"]).toEqual(surfaces.slice(0, 8).map((s) => s.path));
  });

  it("sanitizes optional-only addresses across contract, continuation, and gap carriers while preserving legacy required", () => {
    // Guard-ON suppression semantics; force the flag on for this assertion
    // since it now defaults OFF (see flags.ts semanticFrontierGuardEnabled).
    const previousGuard = process.env["TL_SEMANTIC_FRONTIER_GUARD"];
    process.env["TL_SEMANTIC_FRONTIER_GUARD"] = "1";
    try {
      const result = { mode: "task_pack", coverage: "partial", missing: [], surfaces: [
        { path: "src/required.ts", handle: "h-required" },
        { path: "src/optional.ts", handle: "h-optional", required: false, continuation_optional: true },
        { path: "src/shared.ts", handle: "h-shared", required: false },
        { path: "src/shared.ts", handle: "h-shared", required: true },
      ] } as any;
      markOptional(result, "src/optional.ts");
      for (const call of [
        { tool: "read_file", arguments: { paths: ["src/required.ts", "src/optional.ts", "src/shared.ts"] } },
        { tool: "read_file", arguments: { handles: ["h-required", "h-optional", "h-shared"] } },
        { tool: "read_file", arguments: { targets: [{ path: "src/optional.ts" }, { handle: "h-required" }, { handle: "h-shared" }] } },
      ] as any[]) {
        expect(sanitizeSemanticFrontierNext(result, call)?.arguments).not.toMatchObject({ path: "src/optional.ts" });
        expect(JSON.stringify(sanitizeSemanticFrontierNext(result, call))).not.toContain("h-optional");
        expect(JSON.stringify(sanitizeSemanticFrontierNext(result, call))).toContain("shared");
      }
      expect(sanitizeSemanticFrontierNext(result, { tool: "read_file", arguments: { path: "src/optional.ts" } } as any)).toBeUndefined();
      expect(sanitizeSemanticFrontierNext(result, { tool: "search_files", arguments: { action: "find", query: "only-query" } } as any)).toBeDefined();
    } finally {
      if (previousGuard === undefined) delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
      else process.env["TL_SEMANTIC_FRONTIER_GUARD"] = previousGuard;
    }
  });

  it("uses only graph endpoints when partial discovery has evidence relations", () => {
    const result = {
      mode: "task_pack", qref: "q-graph", coverage: "partial", surfaces: [], missing: [],
      wiring: { evidence_graph: {
        nodes: [{ id: "a", path: "src/producer.ts" }, { id: "b", path: "src/consumer.ts" }, { id: "noise", path: "src/noise.ts" }],
        relations: [{ from: "a", to: "b" }],
      } },
    } as any;
    expect(discoveryBundleNext(result)?.arguments).toEqual({
      mode: "task_pack", qref: "q-graph", paths: ["src/producer.ts", "src/consumer.ts"],
    });
  });
});

// ---------------------------------------------------------------------------
// W9 (2026-08-22) — the bundle through the DECISION, not just the helper.
//
// `discoveryBundleNext` was already unit-tested above, but on a live candidate
// list it was unreachable: `deriveCanonicalTaskDecision` returned at the
// `awaiting-input` check BEFORE the bundle branch could run, because
// readCodeTaskPack.ts builds a choose-candidate pack straight into
// `awaiting-input` (the 2026-07-19a edit-safety fence). Measured cost on the
// a4 m365-drive-mount repro: the caller had to invent the same re-pack by
// hand, without the `qref`, with the paths copied out of the candidate list.
//
// These cases exercise the decision, so a future re-ordering that makes the
// helper unreachable again fails here rather than only in a bench run.
// ---------------------------------------------------------------------------
const chooseCandidateContract = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  state: "needs-followup",
  readiness: "choose-candidate",
  discovery_complete: false,
  next_action: "request-user-input",
  max_additional_discovery_calls: 0,
  reason: "choose-candidate: every candidate body is served inline (handles ha,hb,hc); pick the surface matching the task",
  await_input_code: "choose-candidate",
  typestate: {
    phase: "awaiting-input",
    allowed_actions: ["answer", "edit", "request-user-input"],
    challenge_required_for: [],
  },
  semantic_closure: {
    version: 1, state: "awaiting-input", closure_id: "open-w9",
    obligations_total: 2, obligations_proved: 1, unresolved: ["behavior-body"],
  },
  ...overrides,
});

const candidateListPack = (selected: string, contractOverrides: Record<string, unknown> = {}) => ({
  mode: "task_pack",
  qref: "q-w9",
  coverage: "partial",
  coverage_reason: "candidate-list",
  surfaces: [
    { path: "src/Cli/MountCommand.ts", handle: "ha", range: "1-30", code: "a", required: true },
    { path: "src/Services/DriveMounter.ts", handle: "hb", range: "1-30", code: "b", required: true },
    { path: "src/Native/NativeMethods.ts", handle: "hc", range: "1-30", code: "c", required: true },
  ],
  missing: [],
  route: { action: "confirm_candidates", reason: "several plausible targets", max_additional_tl_calls: 0 },
  profile_binding: { requested: "auto", selected, source: "inferred", confidence: 0.8, reason: "shape" },
  execution_contract: chooseCandidateContract(contractOverrides),
}) as never;

const EXPECTED_BUNDLE = {
  tool: "read_file",
  arguments: {
    mode: "task_pack",
    qref: "q-w9",
    paths: ["src/Cli/MountCommand.ts", "src/Services/DriveMounter.ts", "src/Native/NativeMethods.ts"],
  },
};

describe("discovery bundle next — read-only candidate list reaches the decision (W9)", () => {
  it("an ANSWER-profile choose-candidate pack decides `discover` with the bounded qref bundle", () => {
    const decision = deriveCanonicalTaskDecision(candidateListPack("answer"));
    expect(decision?.kind).toBe("discover");
    expect(decision?.next_call).toEqual(EXPECTED_BUNDLE);
  });

  it("a DECLARED answer profile carried on `task_profile` decides the same way", () => {
    const result = candidateListPack("generic");
    (result as unknown as { task_profile: string }).task_profile = "answer";
    expect(deriveCanonicalTaskDecision(result)?.kind).toBe("discover");
  });

  it("EDIT SAFETY: a generic-profile choose-candidate pack still awaits the caller's choice", () => {
    const decision = deriveCanonicalTaskDecision(candidateListPack("generic"));
    expect(decision?.kind).toBe("await-input");
    expect(decision?.next_call).toBeUndefined();
  });

  it("only the choose-candidate branch moves — tied concerns still await the intended target", () => {
    const decision = deriveCanonicalTaskDecision(
      candidateListPack("answer", { await_input_code: "name-intended-target" }),
    );
    expect(decision?.kind).toBe("await-input");
  });

  it("never invents a bundle: one candidate path, or no qref, keeps the await", () => {
    const single = candidateListPack("answer");
    (single as unknown as { surfaces: unknown[] }).surfaces = [
      { path: "src/only.ts", handle: "ha", range: "1-30", code: "a", required: true },
    ];
    expect(deriveCanonicalTaskDecision(single)?.kind).toBe("await-input");

    const noQref = candidateListPack("answer");
    delete (noQref as unknown as { qref?: string }).qref;
    expect(deriveCanonicalTaskDecision(noQref)?.kind).toBe("await-input");
  });

  it("the shared exit REPAIRS the contract onto discovery — no phase/decision disagreement survives", () => {
    const result = candidateListPack("answer");
    const decision = applyCanonicalTaskDecision(result);
    expect(decision?.kind).toBe("discover");
    const contract = (result as unknown as { execution_contract: Record<string, unknown> }).execution_contract;
    expect((contract["typestate"] as { phase: string }).phase).toBe("discovery");
    expect(contract["next_call"]).toEqual(EXPECTED_BUNDLE);
    // A discovery contract must not keep claiming a pending human choice.
    expect(contract["await_input_code"]).toBeUndefined();
    expect(canonicalTaskDecisionInvariantViolations(result)).toEqual([]);
  });

  it("does not turn optional partial evidence into a wire zoom or canonical document discovery", async () => {
    // `projectEvidence` has no guardEnabled parameter — it always reads the
    // live flag, which now defaults OFF (flags.ts semanticFrontierGuardEnabled).
    // Force guard-ON for the duration of this suppression assertion.
    const previousGuard = process.env["TL_SEMANTIC_FRONTIER_GUARD"];
    process.env["TL_SEMANTIC_FRONTIER_GUARD"] = "1";
    try {
      const { projectEvidence } = await import("../protocol/decisionWire.js");
      const optionalSurface = {
        path: "docs/supporting.md", handle: "h-optional", required: false, continuation_optional: true,
        remaining_ranges: ["31-60"],
      } as any;
      annotateSemanticFrontierContinuation({ mode: "task_pack", coverage: "partial", missing: [], surfaces: [optionalSurface] } as any, "--semantic-frontier flag", true);
      expect(projectEvidence([optionalSurface])).toEqual([{ path: "docs/supporting.md", handle: "h-optional" }]);

      const optionalDocument = {
        mode: "task_pack", coverage: "partial", surfaces: [{
        path: "docs/supporting.md", handle: "h-optional", required: false, continuation_optional: true,
          remaining_ranges: ["31-60"],
        }], missing: [],
        route: { action: "answer_from_handles", reason: "supporting", max_additional_tl_calls: 1 },
        execution_contract: {
          typestate: { phase: "awaiting-input", allowed_actions: ["request-user-input"], challenge_required_for: [] },
          reason: "need a user choice",
        },
      } as any;
      markOptional(optionalDocument, "docs/supporting.md");
      expect(deriveCanonicalTaskDecision(optionalDocument)?.kind).toBe("await-input");
    } finally {
      if (previousGuard === undefined) delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
      else process.env["TL_SEMANTIC_FRONTIER_GUARD"] = previousGuard;
    }
  });

  it("the wire decision carries the bundle plus the standing bounded-paths advisory", async () => {
    const { projectTaskDecision, projectEvidence } = await import("../protocol/decisionWire.js");
    const result = candidateListPack("answer");
    applyCanonicalTaskDecision(result);
    const contract = (result as unknown as { execution_contract: unknown }).execution_contract;
    const decision = projectTaskDecision({
      result: result as unknown as Record<string, unknown>,
      contract: contract as never,
      canonicalKind: deriveCanonicalTaskDecision(result)?.kind,
      evidence: projectEvidence((result as unknown as { surfaces: unknown }).surfaces),
    });
    expect(decision).toMatchObject({ kind: "discover", next: EXPECTED_BUNDLE });
    expect((decision as { advisory?: string }).advisory).toContain("bundled paths are limited");
  });
});
