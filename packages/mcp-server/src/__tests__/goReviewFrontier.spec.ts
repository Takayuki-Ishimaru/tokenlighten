import {describe, expect, it} from "vitest";
import type {TaskDecision, TaskExecutionContract} from "@tokenlighten/types";
import {bindGoReviewOrigin} from "../goReturnedLocalReview.js";
import {bindJavaLoopGuardOrigin} from "../javaLoopGuardReview.js";
import {bindEnumStyleReviewOrigin} from "../enumStyleReview.js";
import {projectEvidence, projectTaskDecision, relocateGoReviewsToFrontier} from "../protocol/decisionWire.js";

// 2026-10-22 (codex-copilot-proxy r18 T07): the Go returned-local review rides the `act.edit` frontier entry of
// its file (`decision.frontier[].review`) instead of the evidence row's `why`, which the agent guide never
// mentions. Every other reply keeps the text in `why`, byte for byte, and `projectEvidence` itself still
// appends it (the move happens where the evidence and the decision are combined).
const BODY = [
  "func Build() (Result, error) {", "  out := Result{}",
  "  if err := out.Apply(); err != nil { return Result{}, err }", "  var err error",
  "  out.Score, err = left.Minus(right)", "  if err != nil { return Result{}, err }",
  "  return out, nil", "}",
].join("\n");
const PATH = "pkg/sample/build.go";
const RANGE = "101-108";
const TEXT = "pkg/sample/build.go: return out L107 returns the out.Score assigned at L105 (out.Score, err = left.Minus(right)), not one set by out.Apply() L103.";
const WORKSPACE = {
  fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  scope: "evidence-plus-inventory", evidence_files: 2, inventory_files: 2, inventory_complete: true,
};

function goRow(overrides: Record<string, unknown> = {}, handle = "hgo"): Record<string, unknown> {
  const row: Record<string, unknown> = {handle, path: PATH, range: RANGE, code: BODY, why: "caller-supplied", ...overrides};
  bindGoReviewOrigin(row, {path: PATH, body: BODY, range: RANGE, text: TEXT});
  return row;
}
const contract = (handles: string[]): TaskExecutionContract => ({
  version: 1, state: "ready", readiness: "edit-ready", discovery_complete: true, next_action: "edit",
  max_additional_discovery_calls: 0, reason: "proof-carrying edit frontier passed falsification and risk gates",
  workspace_state: WORKSPACE,
  readiness_certificate: {id: "ready-go-review", obligations: [{id: "surface-content"}], action_frontier: handles},
  typestate: {phase: "prepared", certificate_id: "ready-go-review", allowed_actions: ["edit"], challenge_required_for: []},
} as unknown as TaskExecutionContract);
const editDecision = (evidence: ReturnType<typeof projectEvidence>, handles: string[]): TaskDecision => {
  const decision = projectTaskDecision({result: {}, contract: contract(handles), canonicalKind: "act-edit", evidence});
  if (decision?.kind !== "act.edit") throw new Error("expected act.edit, got " + JSON.stringify(decision));
  return decision;
};
const frontierOf = (decision: TaskDecision | undefined): Array<Record<string, unknown>> =>
  ((decision as {frontier?: Array<Record<string, unknown>>} | undefined)?.frontier ?? []);
const whyOf = (row: unknown): unknown => (row as {why?: unknown}).why;

describe("Go returned-local review on the act.edit frontier", () => {
  it("moves the review to the frontier entry of its file and leaves the row's own why", () => {
    const evidence = projectEvidence([goRow()]);
    expect(whyOf(evidence[0])).toBe("caller-supplied; " + TEXT); // projectEvidence is unchanged
    const decision = editDecision(evidence, ["hgo"]);
    expect(frontierOf(decision)).toEqual([{handle: "hgo", path: PATH, writable: true}]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(frontierOf(decision)).toEqual([{handle: "hgo", path: PATH, writable: true, review: TEXT}]);
    expect(Object.keys(frontierOf(decision)[0]!)).toEqual(["handle", "path", "writable", "review"]);
    expect(whyOf(evidence[0])).toBe("caller-supplied");
    const wire = JSON.stringify({decision, evidence});
    expect(wire.split(TEXT)).toHaveLength(2); // exactly once, on the frontier entry
    expect(Buffer.byteLength(TEXT, "utf8")).toBeLessThanOrEqual(200);
  });

  // 2026-10-24 (generality audit §3.9.1): the function served as a window of a larger file (the rest of the file remaining).
  it("moves the review of a function served as a window of a larger file, whose row names the rest of the file as remaining", () => {
    const evidence = projectEvidence([goRow({remaining_ranges: ["1-100", "109-519"]})]);
    expect(whyOf(evidence[0])).toBe("caller-supplied; " + TEXT);
    expect(evidence[0]).toMatchObject({remaining: ["1-100", "109-519"]});
    const decision = editDecision(evidence, ["hgo"]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(frontierOf(decision)[0]!["review"]).toBe(TEXT);
    expect(whyOf(evidence[0])).toBe("caller-supplied");
    expect(evidence[0]).toMatchObject({remaining: ["1-100", "109-519"]});
    // A remainder that touches the window means the body is not all of it: no review, on the row or the frontier.
    const cut = projectEvidence([goRow({remaining_ranges: ["105-130"]})]);
    expect(whyOf(cut[0])).toBe("caller-supplied");
    const cutDecision = editDecision(cut, ["hgo"]);
    relocateGoReviewsToFrontier(cutDecision, cut);
    expect(frontierOf(cutDecision)).toEqual([{handle: "hgo", path: PATH, writable: true}]);
  });

  it("drops the why key when the review created it", () => {
    const row = goRow();
    delete row["why"];
    const evidence = projectEvidence([row]);
    expect(whyOf(evidence[0])).toBe(TEXT);
    const keysWithReview = Object.keys(evidence[0]!);
    const decision = editDecision(evidence, ["hgo"]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(frontierOf(decision)[0]!["review"]).toBe(TEXT);
    expect(evidence[0]).not.toHaveProperty("why");
    expect(Object.keys(evidence[0]!)).toEqual(keysWithReview.filter(key => key !== "why"));
    expect(JSON.stringify(evidence)).not.toContain("out.Score assigned");
  });

  it("matches by path: another handle of the same file carries the entry", () => {
    const evidence = projectEvidence([goRow({}, "hsurface")]);
    const decision = editDecision([...evidence, {handle: "hfrontier", path: PATH, range: "1-5", body: "x"}], ["hfrontier"]);
    expect(frontierOf(decision)).toEqual([{handle: "hfrontier", path: PATH, writable: true}]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(frontierOf(decision)[0]!["review"]).toBe(TEXT);
    expect(whyOf(evidence[0])).toBe("caller-supplied");
  });

  it("changes nothing without a frontier entry for the file", () => {
    const other = {handle: "hother", path: "pkg/sample/other.go", range: "1-3", body: "package sample"};
    const evidence = [...projectEvidence([goRow()]), other];
    const before = JSON.stringify(evidence);
    const decision = editDecision(evidence, ["hother"]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(frontierOf(decision)).toEqual([{handle: "hother", path: "pkg/sample/other.go", writable: true}]);
    expect(JSON.stringify(evidence)).toBe(before);
    expect(whyOf(evidence[0])).toBe("caller-supplied; " + TEXT);
  });

  it("changes nothing on any other decision", () => {
    for (const decision of [
      undefined,
      {kind: "done"},
      {kind: "discover", next: {tool: "tl_read_file", arguments: {handle: "hgo", range: "1-5"}}},
      {kind: "await_input", code: "no-grounded-call-remains"},
      // Only an act.edit's frontier is a write target, whatever else a malformed decision carries.
      {kind: "discover", next: {tool: "tl_read_file", arguments: {handle: "hgo", range: "1-5"}},
        frontier: [{handle: "hgo", path: PATH, writable: true}]},
      {kind: "act.answer", certificate: {id: "ready-go-review", obligations: ["surface-content"], workspace: WORKSPACE}},
      {kind: "act.edit", certificate: {id: "ready-go-review", obligations: ["surface-content"], workspace: WORKSPACE},
        create_target: {path: "pkg/sample/new.go", directory_evidence: [PATH]}},
    ] as Array<TaskDecision | undefined>) {
      const evidence = projectEvidence([goRow()]);
      const before = JSON.stringify({decision, evidence});
      relocateGoReviewsToFrontier(decision, evidence);
      expect(JSON.stringify({decision, evidence}), JSON.stringify(decision)).toBe(before);
      expect(whyOf(evidence[0])).toBe("caller-supplied; " + TEXT);
    }
  });

  it("moves a review once: a second pass finds nothing to move", () => {
    const evidence = projectEvidence([goRow()]);
    const decision = editDecision(evidence, ["hgo"]);
    relocateGoReviewsToFrontier(decision, evidence);
    const once = JSON.stringify({decision, evidence});
    relocateGoReviewsToFrontier(decision, evidence);
    expect(JSON.stringify({decision, evidence})).toBe(once);
  });

  it("keeps the remembered move off the wire and off copies of the row", () => {
    const row = goRow();
    const wireBefore = JSON.stringify(projectEvidence([row]));
    const evidence = projectEvidence([row]);
    expect(JSON.stringify(evidence)).toBe(wireBefore);
    expect(Object.keys(evidence[0]!)).not.toContain("tl.goReviewRelocation");
    expect(JSON.stringify(evidence)).not.toMatch(/Relocation|relocation/);
    const decision = editDecision(evidence, ["hgo"]);
    // A copy made before the move (the pack is spread and cloned along the way) carries no memory of it.
    relocateGoReviewsToFrontier(decision, [{...evidence[0]!}]);
    expect(frontierOf(decision)[0]).not.toHaveProperty("review");
  });

  it("states the fact once when a second row of the file carries the same review", () => {
    const evidence = projectEvidence([goRow({}, "hgo"), goRow({}, "hgo2")]);
    expect(whyOf(evidence[1])).toBe("caller-supplied; " + TEXT);
    const decision = editDecision(evidence, ["hgo"]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(frontierOf(decision)[0]!["review"]).toBe(TEXT);
    expect(whyOf(evidence[0])).toBe("caller-supplied");
    expect(whyOf(evidence[1])).toBe("caller-supplied");
    expect(JSON.stringify({decision, evidence}).split(TEXT)).toHaveLength(2);
  });

  it("keeps the why of a second row whose review says something else", () => {
    const other = "pkg/sample/build.go: another fact about the same file.";
    const second = goRow({}, "hgo2");
    bindGoReviewOrigin(second, {path: PATH, body: BODY, range: RANGE, text: other});
    const evidence = projectEvidence([goRow({}, "hgo"), second]);
    const decision = editDecision(evidence, ["hgo"]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(frontierOf(decision)[0]!["review"]).toBe(TEXT);
    expect(whyOf(evidence[0])).toBe("caller-supplied");
    expect(whyOf(evidence[1])).toBe("caller-supplied; " + other);
  });

  // Fail-open (review of the r18 T07 change): the move is an improvement of placement, never a way to lose the
  // fact or to fail a reply. Whatever cannot take it leaves the row's why exactly as projected.
  it("never throws and keeps the why when the frontier entry cannot take a key", () => {
    const locks: Array<[string, (value: object) => unknown]> = [
      ["freeze", Object.freeze], ["seal", Object.seal], ["preventExtensions", Object.preventExtensions],
    ];
    for (const [name, lock] of locks) {
      const evidence = projectEvidence([goRow()]);
      const decision = editDecision(evidence, ["hgo"]);
      for (const entry of frontierOf(decision)) lock(entry);
      expect(() => relocateGoReviewsToFrontier(decision, evidence), name).not.toThrow();
      expect(frontierOf(decision), name).toEqual([{handle: "hgo", path: PATH, writable: true}]);
      expect(whyOf(evidence[0]), name).toBe("caller-supplied; " + TEXT);
    }
    // A decision frozen all the way down, as a later pass might seal it.
    const evidence = projectEvidence([goRow()]);
    const decision = editDecision(evidence, ["hgo"]);
    Object.freeze(frontierOf(decision)[0]!);
    Object.freeze(frontierOf(decision));
    Object.freeze(decision);
    expect(() => relocateGoReviewsToFrontier(decision, evidence)).not.toThrow();
    expect(whyOf(evidence[0])).toBe("caller-supplied; " + TEXT);
  });

  it("never throws and keeps the fact in the row when the row cannot be restored", () => {
    // A frozen row (the review rode a why that existed), and a frozen row whose why the review created.
    for (const created of [false, true]) {
      const row = goRow();
      if (created) delete row["why"];
      const evidence = projectEvidence([row]);
      Object.freeze(evidence[0]);
      const decision = editDecision(evidence, ["hgo"]);
      expect(() => relocateGoReviewsToFrontier(decision, evidence), String(created)).not.toThrow();
      // The entry's key is taken back: the fact rides once, in the why, as before this change.
      expect(frontierOf(decision), String(created)).toEqual([{handle: "hgo", path: PATH, writable: true}]);
      expect(whyOf(evidence[0]), String(created)).toBe(created ? TEXT : "caller-supplied; " + TEXT);
    }
  });

  it("never throws on a rejecting entry or on rows that are not rows, and still moves the others", () => {
    const evidence = projectEvidence([goRow()]);
    const decision = editDecision(evidence, ["hgo"]);
    Object.defineProperty(frontierOf(decision)[0]!, "review", {
      configurable: true, enumerable: true, get: () => undefined, set: () => { throw new Error("rejected"); },
    });
    expect(() => relocateGoReviewsToFrontier(decision, evidence)).not.toThrow();
    expect(whyOf(evidence[0])).toBe("caller-supplied; " + TEXT);

    const sound = projectEvidence([goRow()]);
    const intact = editDecision(sound, ["hgo"]);
    expect(() => relocateGoReviewsToFrontier(intact, [null, undefined, 7, ...sound] as never)).not.toThrow();
    expect(frontierOf(intact)[0]!["review"]).toBe(TEXT);
    expect(whyOf(sound[0])).toBe("caller-supplied");
    // A decision that is not a decision at all.
    expect(() => relocateGoReviewsToFrontier({kind: "act.edit", frontier: 7} as never, sound)).not.toThrow();
    expect(() => relocateGoReviewsToFrontier(null as never, sound)).not.toThrow();
  });

  it("leaves the Java loop-guard and enum-style reviews in why, frontier or not", () => {
    const java = {handle: "hjava", path: "src/Retry.java", range: "4-10", code: "class Retry {}", why: "caller-supplied"};
    bindJavaLoopGuardOrigin(java, {path: java.path, range: java.range, body: java.code, text: "L912 Thread.sleep(backoffMs) requires L910 (attempt < MAX)."});
    const css = {handle: "hcss", path: "apps/web/tokens.css", range: "1-4", code: ":root {}", why: "caller-supplied"};
    bindEnumStyleReviewOrigin(css, {path: css.path, range: css.range, body: css.code, text: "tokens.css: --priority-urgent has no sibling for critical."});
    const evidence = projectEvidence([java, css]);
    const before = JSON.stringify(evidence);
    expect(whyOf(evidence[0])).toContain("Thread.sleep(backoffMs)");
    expect(whyOf(evidence[1])).toContain("--priority-urgent");
    const decision = editDecision(evidence, ["hjava", "hcss"]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(JSON.stringify(evidence)).toBe(before);
    for (const entry of frontierOf(decision)) expect(entry).not.toHaveProperty("review");
  });

  it("restores exactly the why the row would have had without the Go review when another origin also applies", () => {
    const row = goRow();
    bindJavaLoopGuardOrigin(row, {path: PATH, range: RANGE, body: BODY, text: "L1 loop guard fact."});
    const evidence = projectEvidence([row]);
    expect(whyOf(evidence[0])).toBe("caller-supplied; " + TEXT + "; L1 loop guard fact.");
    const decision = editDecision(evidence, ["hgo"]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(whyOf(evidence[0])).toBe("caller-supplied; L1 loop guard fact.");
    expect(frontierOf(decision)[0]!["review"]).toBe(TEXT);
  });

  it("does not move a review that was not projected beside its exact source", () => {
    // The row's body no longer matches the one the review was computed from: projectEvidence appends nothing,
    // so there is nothing to move and the frontier entry stays as it was.
    const evidence = projectEvidence([goRow({code: BODY.slice(0, -1)})]);
    expect(whyOf(evidence[0])).toBe("caller-supplied");
    const decision = editDecision(evidence, ["hgo"]);
    relocateGoReviewsToFrontier(decision, evidence);
    expect(frontierOf(decision)).toEqual([{handle: "hgo", path: PATH, writable: true}]);
    expect(whyOf(evidence[0])).toBe("caller-supplied");
  });
});
