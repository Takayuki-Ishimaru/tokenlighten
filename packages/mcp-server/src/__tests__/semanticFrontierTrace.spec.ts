import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTracePath, responseWitnessHmac, setTraceEnabledForTest } from "../util/trace.js";
import { annotateSemanticFrontierContinuation, buildSemanticFrontierAttestation, finalizeSemanticFrontierAttestation, semanticFrontierPathId } from "../features/task-pack/semanticFrontier.js";
import type { SemanticFrontierTraceSeed, SemanticFrontierWireObservation } from "../features/task-pack/semanticFrontier.js";
import { finalizeProtocolResponse, runWithProtocolCall } from "../protocol/envelope.js";
import { projectEvidence, projectTaskDecision } from "../protocol/decisionWire.js";
import {
  noteSemanticFrontierDecisionSuppression,
  noteSemanticFrontierTraceSeed,
} from "../protocol/semanticFrontierTraceContext.js";

const roots: string[] = [];

function workspace(tag: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), `.tl-semantic-trace-${tag}-`)));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, text: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
}

async function readTaskPack(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { callTool } = await import("../server.js") as unknown as {
    callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  };
  const response = await callTool("read_file", args);
  return JSON.parse(response.content[0]!.text) as Record<string, unknown>;
}

function recordsAfter(tracePath: string, before: number): Record<string, unknown>[] {
  return fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean)
    .slice(before).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function traceSeed(tag: string, extra: Record<string, unknown> = {}, guardEnabled = true): SemanticFrontierTraceSeed {
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
      ...extra,
    },
    guard_enabled: guardEnabled,
    marker_count: 1,
  };
}

function finalTrace(root: string, kind: string, text: string, seed: SemanticFrontierTraceSeed): string {
  return runWithProtocolCall({ tool: "read_file", kind: kind as "read.task_pack", workspace: root }, () => {
    noteSemanticFrontierTraceSeed(seed);
    return finalizeProtocolResponse("read_file", { content: [{ type: "text", text }] }).content[0]!.text;
  });
}

const minimalTaskPack = (): string => JSON.stringify({
  task: { id: "task-trace", coverage: "complete" },
  profile: "generic",
  evidence: [],
  decision: { kind: "done" },
});

function decisionContract(nextPath: string): any {
  return {
    next_call: { tool: "read_file", arguments: { targets: [{ path: nextPath, range: "1-1" }] } },
    capability_gaps: [],
  };
}

function projectDecisionWithTrace(
  root: string,
  tag: string,
  result: Record<string, unknown>,
  guardEnabled = true,
): Record<string, unknown> {
  return runWithProtocolCall({ tool: "read_file", kind: "read.task_pack", workspace: root }, () => {
    noteSemanticFrontierTraceSeed(traceSeed(tag, {}, guardEnabled));
    const decision = projectTaskDecision({
      result,
      contract: decisionContract("src/literal.ts"),
      canonicalKind: "discover",
      evidence: [],
    });
    finalizeProtocolResponse("read_file", { content: [{ type: "text", text: JSON.stringify({
      task: { id: "task-trace", coverage: "complete" }, profile: "generic", evidence: [], decision,
    }) }] });
    return decision as unknown as Record<string, unknown>;
  });
}

afterEach(() => {
  setTraceEnabledForTest(false);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("semantic frontier final attestation", () => {
  it("binds the exact final response with a nonce-keyed witness without retaining response text", () => {
    const response = JSON.stringify({ v: 1, kind: "read.task_pack", evidence: [{ path: "/private.ts", body: "secret" }] });
    const first = responseWitnessHmac(response, "nonce-for-response-witness");
    const second = responseWitnessHmac(response, "nonce-for-response-witness");
    expect(first).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(responseWitnessHmac(`${response}!`, "nonce-for-response-witness")).not.toBe(first);
    expect(responseWitnessHmac(response, "other-nonce")).not.toBe(first);
    expect(first).not.toContain("private");
    expect(first).not.toContain("secret");
  });

  it("emits that witness only as bounded trace metadata for the finalized wire", () => {
    const root = workspace("response-witness");
    const tracePath = getTracePath(root);
    const priorNonce = process.env["TL_P1_CAUSAL_RUN_NONCE"];
    try {
      process.env["TL_P1_CAUSAL_RUN_NONCE"] = "nonce-final-wire-witness";
      setTraceEnabledForTest(true);
      const wire = minimalTaskPack();
      const finalizedWire = finalTrace(root, "read.task_pack", wire, traceSeed("response-witness"));
      const event = recordsAfter(tracePath, 0).find((record) => record["event"] === "semantic_frontier_attestation")!;
      expect(event["response_witness"]).toBe(responseWitnessHmac(finalizedWire, "nonce-final-wire-witness"));
      expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(12 * 1024);
    } finally {
      if (priorNonce === undefined) delete process.env["TL_P1_CAUSAL_RUN_NONCE"];
      else process.env["TL_P1_CAUSAL_RUN_NONCE"] = priorNonce;
    }
  });

  it("classifies mechanically-required lexical decoys as supporting while retaining typed providers", () => {
    // `projectEvidence` has no guardEnabled parameter — it always reads the
    // live flag, which now defaults OFF (flags.ts semanticFrontierGuardEnabled).
    // Force guard-ON so the suppression of the decoy's remaining range holds.
    const previousGuard = process.env["TL_SEMANTIC_FRONTIER_GUARD"];
    process.env["TL_SEMANTIC_FRONTIER_GUARD"] = "1";
    try {
    const result: any = {
      surfaces: [
        { path: "src/entry.ts", handle: "h-entry", range: "1-1", role: "unknown", required: true, code: "entry" },
        { path: "src/featureFlags.ts", handle: "h-flag", range: "1-1", role: "config", required: true, code: "FEATURE_FLAG" },
        { path: "src/templateRenderer.ts", handle: "h-render", range: "1-1", role: "unknown", required: true, code: "render" },
        { path: "src/buildGenerator.ts", handle: "h-generator", range: "1-1", role: "unknown", required: true, code: "generate" },
        { path: "CHANGELOG.ts", handle: "h-decoy", range: "1-1", role: "unknown", required: true, code: "flag generated template" , remaining_ranges: ["2-2"] },
      ],
      wiring: {
        evidence_graph: {
          nodes: [
            { id: "flag", path: "src/featureFlags.ts" },
            { id: "render", path: "src/templateRenderer.ts" },
          ],
          relations: [{ from: "render", to: "flag", kind: "imports" }],
        },
      },
    };
    const query = "flag template generated relation";
    annotateSemanticFrontierContinuation(result, query, true);
    const attestation = buildSemanticFrontierAttestation({ result, query, guardEnabled: true });
    const candidates = attestation["candidates"] as Array<{ path_id: string; required: boolean; disposition: string; proof: string }>;
    const byPath = new Map(candidates.map((candidate) => [candidate.path_id, candidate]));
    expect(byPath.get(semanticFrontierPathId("src/featureFlags.ts"))).toMatchObject({ required: true, disposition: "required", proof: "provider-semantic" });
    expect(byPath.get(semanticFrontierPathId("src/templateRenderer.ts"))).toMatchObject({ required: true, disposition: "required", proof: "provider-semantic" });
    expect(byPath.get(semanticFrontierPathId("src/buildGenerator.ts"))).toMatchObject({ required: true, disposition: "required", proof: "provider-semantic" });
    expect(byPath.get(semanticFrontierPathId("CHANGELOG.ts"))).toMatchObject({ required: false, disposition: "supporting", proof: "lexical-only" });
    expect(attestation["relations"]).toHaveLength(1);
    expect(projectEvidence(result.surfaces).find((entry) => entry.handle === "h-decoy")).not.toHaveProperty("remaining");
    } finally {
      if (previousGuard === undefined) delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
      else process.env["TL_SEMANTIC_FRONTIER_GUARD"] = previousGuard;
    }
  });

  for (const fixture of [
    { name: "ready", files: { "src/flag.ts": "export const FEATURE_FLAG = true;\n" }, query: "inspect --feature FEATURE_FLAG relation src/flag.ts" },
    { name: "not-ready", files: { "src/incomplete.ts": "export const FEATURE_FLAG = true;\n" }, query: "inspect --feature generated template relation" },
    { name: "exact", files: { "src/exact.ts": "export const EXACT_FLAG = true;\n" }, query: "inspect --exact EXACT_FLAG src/exact.ts" },
    { name: "absence", files: { "src/other.ts": "export const OTHER = true;\n" }, query: "inspect --missing generated src/missing.ts" },
  ]) {
    it(`emits exactly one final attestation for ${fixture.name}`, async () => {
      const root = workspace(fixture.name);
      for (const [rel, text] of Object.entries(fixture.files)) write(root, rel, text);
      const tracePath = getTracePath(root);
      const before = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).length : 0;
      setTraceEnabledForTest(true);
      const wire = await readTaskPack({ query: fixture.query, task: { epoch: "new", profile: "generic" }, cwd: root });
      const attestations = recordsAfter(tracePath, before).filter((record) => record["event"] === "semantic_frontier_attestation");
      expect(attestations, JSON.stringify(recordsAfter(tracePath, before))).toHaveLength(1);
      const event = attestations[0]!;
      // No TL_SEMANTIC_FRONTIER_GUARD override here: this documents the live
      // server's actual default, which is OFF (flags.ts semanticFrontierGuardEnabled).
      expect(event).toMatchObject({ schema_version: 1, attempted: true, guard_enabled: false });
      expect(typeof event["decision"]).toBe("string");
      expect(typeof event["surface_count"]).toBe("number");
      expect(typeof event["surface_bytes"]).toBe("number");
      const evidence = Array.isArray(wire["evidence"]) ? wire["evidence"] : [];
      const decision = wire["decision"] as Record<string, unknown> | undefined;
      const bodyBytes = evidence.reduce((total, item) => total + Buffer.byteLength(typeof (item as Record<string, unknown>)["body"] === "string" ? (item as Record<string, unknown>)["body"] as string : "", "utf8"), 0);
      const priorBytes = evidence.reduce((total, item) => total + Buffer.byteLength(typeof (item as Record<string, unknown>)["prior"] === "string" ? (item as Record<string, unknown>)["prior"] as string : "", "utf8"), 0);
      const pathIds = evidence.flatMap((item) => typeof (item as Record<string, unknown>)["path"] === "string"
        ? [semanticFrontierPathId((item as Record<string, unknown>)["path"] as string)] : []).sort();
      expect(event["wire_kind"]).toBe(wire["kind"]);
      expect(event["decision_kind"]).toBe(typeof decision?.["kind"] === "string" ? decision["kind"] : null);
      expect(event["evidence_count"]).toBe(evidence.length);
      expect(event["evidence_body_bytes"]).toBe(bodyBytes);
      expect(event["evidence_prior_bytes"]).toBe(priorBytes);
      expect(event["evidence_path_ids"]).toEqual(pathIds);
      expect(event["surface_count"]).toBe(evidence.length);
      expect(event["surface_bytes"]).toBe(bodyBytes + priorBytes);
      expect(Array.isArray(event["unresolved"])).toBe(true);
      expect(Array.isArray(event["candidates"])).toBe(true);
      const serialized = JSON.stringify(event);
      expect(Buffer.byteLength(JSON.stringify({ event: "semantic_frontier_attestation", ts: 0, ...event }), "utf8")).toBeLessThanOrEqual(12 * 1024);
      expect(serialized).not.toContain(fixture.query);
      expect(serialized).not.toContain("src/");
      expect(serialized).not.toContain("export const");
    });
  }

  it("attests once, honestly, for receipt, refusal, and opaque codec exits", () => {
    const root = workspace("non-pack-final");
    const tracePath = getTracePath(root);
    setTraceEnabledForTest(true);
    const cases = [
      { tag: "receipt", kind: "read.receipt", text: JSON.stringify({ receipt: { receipt: "closure-complete", done: 0, total: 0 } }), observed: true, wireKind: "read.receipt" },
      { tag: "refusal", kind: "refusal", text: JSON.stringify({ code: "invalid-request", retry: "none" }), observed: true, wireKind: "refusal" },
      { tag: "opaque", kind: "read.task_pack", text: "this is deliberately not json", observed: false, wireKind: null },
    ];
    for (const testCase of cases) {
      const before = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).length : 0;
      finalTrace(root, testCase.kind, testCase.text, traceSeed(testCase.tag));
      const events = recordsAfter(tracePath, before).filter((record) => record["event"] === "semantic_frontier_attestation");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        wire_observed: testCase.observed,
        wire_kind: testCase.wireKind,
        decision_kind: null,
        committed: false,
      });
    }
  });

  it("consumes a qref-replay seed once when the replay converges to a receipt", async () => {
    const root = workspace("qref-receipt");
    write(root, "src/qref.ts", "export const QREF_FLAG = true;\n");
    // Seed the task with trace disabled so this assertion counts only the qref
    // replay's funnel exit, not the initial pack.
    const first = await readTaskPack({ mode: "task_pack", query: "inspect QREF_FLAG contract", taskProfile: "answer", paths: ["src/qref.ts"], cwd: root });
    const qref = first["qref"];
    expect(typeof qref).toBe("string");
    const tracePath = getTracePath(root);
    const before = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).length : 0;
    setTraceEnabledForTest(true);
    await readTaskPack({ mode: "task_pack", qref, taskProfile: "answer", paths: ["src/qref.ts"], cwd: root });
    const events = recordsAfter(tracePath, before).filter((record) => record["event"] === "semantic_frontier_attestation");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ wire_kind: "read.receipt", committed: false });
  });

  it("keeps concurrent call-local seeds and suppressions isolated", async () => {
    const root = workspace("concurrent");
    const tracePath = getTracePath(root);
    setTraceEnabledForTest(true);
    await Promise.all(["alpha", "beta"].map(async (tag) =>
      runWithProtocolCall({ tool: "read_file", kind: "read.task_pack", workspace: root }, async () => {
        noteSemanticFrontierTraceSeed(traceSeed(tag));
        const next = { tool: "read_file", arguments: { handle: `h-${tag}`, range: "1-1" } };
        noteSemanticFrontierDecisionSuppression(tag, next);
        await new Promise<void>((resolve) => setTimeout(resolve, tag === "alpha" ? 4 : 1));
        finalizeProtocolResponse("read_file", { content: [{ type: "text", text: JSON.stringify({
          task: { id: `task-${tag}`, coverage: "complete" }, profile: "generic", evidence: [],
          decision: { kind: "discover", next },
        }) }] });
      }),
    ));
    const events = recordsAfter(tracePath, 0).filter((record) => record["event"] === "semantic_frontier_attestation");
    expect(events).toHaveLength(2);
    expect(events.map((event) => event["origin_id"]).sort()).toEqual(["sha256:alpha", "sha256:beta"]);
    expect(events.map((event) => (event["suppression_reasons"] as string[])[0]).sort()).toEqual(["alpha", "beta"]);
  });

  it("keeps nested/reentrant trace state isolated", () => {
    const root = workspace("nested");
    const tracePath = getTracePath(root);
    setTraceEnabledForTest(true);
    runWithProtocolCall({ tool: "read_file", kind: "read.task_pack", workspace: root }, () => {
      noteSemanticFrontierTraceSeed(traceSeed("outer"));
      runWithProtocolCall({ tool: "read_file", kind: "read.task_pack", workspace: root }, () => {
        noteSemanticFrontierTraceSeed(traceSeed("inner"));
        finalizeProtocolResponse("read_file", { content: [{ type: "text", text: minimalTaskPack() }] });
      });
      finalizeProtocolResponse("read_file", { content: [{ type: "text", text: minimalTaskPack() }] });
    });
    const events = recordsAfter(tracePath, 0).filter((record) => record["event"] === "semantic_frontier_attestation");
    expect(events.map((event) => event["origin_id"]).sort()).toEqual(["sha256:inner", "sha256:outer"]);
  });

  it("does not commit when a literal-cohort winner makes an optional bundle a loser", () => {
    const root = workspace("literal-winner");
    const tracePath = getTracePath(root);
    setTraceEnabledForTest(true);
    const result: any = {
      coverage: "partial",
      coverage_reason: "candidate-list",
      qref: "q-literal-winner",
      missing: ["source-cohort-remaining"],
      surfaces: [
        { path: "src/literal.ts", required: true },
        { path: "src/optional.ts", required: false },
      ],
    };
    annotateSemanticFrontierContinuation(result, "contract", true);
    const decision = projectDecisionWithTrace(root, "literal-winner", result);
    const event = recordsAfter(tracePath, 0).find((record) => record["event"] === "semantic_frontier_attestation")!;
    expect((decision["next"] as { arguments: { targets: Array<{ path: string }> } }).arguments.targets)
      .toEqual([{ path: "src/literal.ts", range: "1-1" }]);
    expect(event).toMatchObject({ committed: false, suppression_reasons: [] });
  });

  it("commits only when the optional carrier would otherwise win the wire decision", () => {
    // `projectTaskDecision`'s internal `projectSemanticFrontierNext` reads the
    // live flag directly (no override param), which now defaults OFF (flags.ts
    // semanticFrontierGuardEnabled). Force guard-ON so the optional carrier is
    // actually suppressed and the commit fires as this test documents.
    const previousGuard = process.env["TL_SEMANTIC_FRONTIER_GUARD"];
    process.env["TL_SEMANTIC_FRONTIER_GUARD"] = "1";
    try {
      const root = workspace("optional-winner");
      const tracePath = getTracePath(root);
      setTraceEnabledForTest(true);
      const result: any = {
        coverage: "partial",
        qref: "q-optional-winner",
        missing: ["source-cohort-remaining"],
        surfaces: [{ path: "src/literal.ts", required: false }],
      };
      annotateSemanticFrontierContinuation(result, "contract", true);
      const decision = projectDecisionWithTrace(root, "optional-winner", result);
      const event = recordsAfter(tracePath, 0).find((record) => record["event"] === "semantic_frontier_attestation")!;
      expect(decision).toMatchObject({ kind: "await_input", code: "no-grounded-call-remains" });
      expect(event).toMatchObject({ committed: true });
      expect(event["suppression_reasons"]).toEqual(["continuation-target"]);
    } finally {
      if (previousGuard === undefined) delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
      else process.env["TL_SEMANTIC_FRONTIER_GUARD"] = previousGuard;
    }
  });

  it("keeps the guard-OFF golden decision packet byte-for-byte on its optional carrier", () => {
    const previous = process.env["TL_SEMANTIC_FRONTIER_GUARD"];
    process.env["TL_SEMANTIC_FRONTIER_GUARD"] = "0";
    try {
      const root = workspace("guard-off");
      const tracePath = getTracePath(root);
      setTraceEnabledForTest(true);
      const result: any = {
        coverage: "partial", qref: "q-guard-off", missing: ["source-cohort-remaining"],
        surfaces: [{ path: "src/literal.ts", required: false }],
      };
      annotateSemanticFrontierContinuation(result, "contract", true);
      const decision = projectDecisionWithTrace(root, "guard-off", result, false);
      const event = recordsAfter(tracePath, 0).find((record) => record["event"] === "semantic_frontier_attestation")!;
      expect((decision["next"] as { arguments: { targets: Array<{ path: string }> } }).arguments.targets)
        .toEqual([{ path: "src/literal.ts", range: "1-1" }]);
      expect(event).toMatchObject({ guard_enabled: false, committed: false, suppression_reasons: [] });
    } finally {
      if (previous === undefined) delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
      else process.env["TL_SEMANTIC_FRONTIER_GUARD"] = previous;
    }
  });

  it("retains duplicate final evidence path identities for separate ranges", () => {
    const root = workspace("path-multiplicity");
    const tracePath = getTracePath(root);
    setTraceEnabledForTest(true);
    finalTrace(root, "read.task_pack", JSON.stringify({
      task: { id: "task-multiplicity", coverage: "complete" }, profile: "generic",
      evidence: [
        { handle: "h-a", path: "src/same.ts", range: "1-2", body: "first" },
        { handle: "h-a", path: "src/same.ts", range: "3-4", body: "second" },
      ], decision: { kind: "done" },
    }), traceSeed("path-multiplicity"));
    const event = recordsAfter(tracePath, 0).find((record) => record["event"] === "semantic_frontier_attestation")!;
    expect(event["evidence_path_ids"]).toEqual([
      semanticFrontierPathId("src/same.ts"),
      semanticFrontierPathId("src/same.ts"),
    ]);
  });

  it("activates evidence witnesses only for optional evidence that survives the actual shed ladder", () => {
    const root = workspace("shed-witness");
    const tracePath = getTracePath(root);
    const emit = (guardEnabled: boolean, maxBytes: number): { text: string; event: Record<string, unknown> } => {
      const previous = process.env["TL_SEMANTIC_FRONTIER_GUARD"];
      process.env["TL_SEMANTIC_FRONTIER_GUARD"] = guardEnabled ? "1" : "0";
      try {
        const surfaces: any[] = [
          { path: "src/required.ts", handle: "h-required", range: "1-1", required: true, code: "R".repeat(500) },
          { path: "src/optional.ts", handle: "h-optional", range: "1-500", role: "style", required: false, code: "O".repeat(7_000), remaining_ranges: ["501-1000"] },
        ];
        annotateSemanticFrontierContinuation({ mode: "task_pack", coverage: "complete", missing: [], surfaces }, "contract", true);
        const before = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).length : 0;
        const result = runWithProtocolCall({ tool: "read_file", kind: "read.task_pack", workspace: root, args: { maxBytes } }, () => {
          noteSemanticFrontierTraceSeed(traceSeed(`shed-${guardEnabled}`, {}, guardEnabled));
          return finalizeProtocolResponse("read_file", { content: [{ type: "text", text: JSON.stringify({
            task: { id: "task-shed", coverage: "complete" }, profile: "generic",
            evidence: projectEvidence(surfaces), decision: { kind: "done" },
          }) }] });
        });
        const event = recordsAfter(tracePath, before).find((record) => record["event"] === "semantic_frontier_attestation")!;
        return { text: result.content[0]!.text, event };
      } finally {
        if (previous === undefined) delete process.env["TL_SEMANTIC_FRONTIER_GUARD"];
        else process.env["TL_SEMANTIC_FRONTIER_GUARD"] = previous;
      }
    };
    setTraceEnabledForTest(true);
    // At this cap, rung 5 removes the optional `style` entry. The pre-wire
    // projection observed a suppression, but it must not attest to a row that
    // never reached the caller.
    const on = emit(true, 450);
    const off = emit(false, 450);
    const onPacket = JSON.parse(on.text) as { evidence: Array<{ handle: string; remaining?: string[] }> };
    const offPacket = JSON.parse(off.text) as { evidence: Array<{ handle: string; remaining?: string[] }> };
    expect(on.text).toBe(off.text);
    expect(onPacket.evidence).not.toContainEqual(expect.objectContaining({ handle: "h-optional" }));
    expect(offPacket.evidence).not.toContainEqual(expect.objectContaining({ handle: "h-optional" }));
    expect(on.event).toMatchObject({ wire_kind: "read.task_pack", committed: false, suppression_reasons: [] });
    expect(off.event).toMatchObject({ wire_kind: "read.task_pack", committed: false, suppression_reasons: [] });

    // At the normal narrow cap, the same optional row survives rung 4 while
    // the guard removes only its inherited remaining range: this is a real
    // final-wire difference and therefore a committed attestation.
    const retainedOn = emit(true, 1_300);
    const retainedOff = emit(false, 1_300);
    const retainedOnPacket = JSON.parse(retainedOn.text) as { evidence: Array<{ handle: string; remaining?: string[] }> };
    const retainedOffPacket = JSON.parse(retainedOff.text) as { evidence: Array<{ handle: string; remaining?: string[] }> };
    expect(retainedOn.text).not.toBe(retainedOff.text);
    expect(retainedOnPacket.evidence).toContainEqual(expect.objectContaining({ handle: "h-optional", remaining: ["1-500"] }));
    expect(retainedOffPacket.evidence).toContainEqual(expect.objectContaining({ handle: "h-optional", remaining: ["501-1000", "1-500"] }));
    expect(retainedOn.event).toMatchObject({ wire_kind: "read.task_pack", committed: true, suppression_reasons: ["evidence-remaining"] });
    expect(retainedOff.event).toMatchObject({ wire_kind: "read.task_pack", committed: false, suppression_reasons: [] });
  });

  it("shaves large safe arrays while keeping the actual enveloped JSONL line capped", () => {
    const root = workspace("bounded");
    const tracePath = getTracePath(root);
    setTraceEnabledForTest(true);
    const candidates = Array.from({ length: 400 }, (_, index) => ({
      id: `sha256:${index.toString(16).padStart(24, "0")}`,
      path_id: `sha256:${(index + 400).toString(16).padStart(24, "0")}`,
      proof: "provider-semantic",
    }));
    finalTrace(root, "read.task_pack", minimalTaskPack(), traceSeed("bounded", { candidates }));
    const line = fs.readFileSync(tracePath, "utf8").split("\n").find((entry) => entry.includes("semantic_frontier_attestation"))!;
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(12 * 1024);
    expect((event["truncated_count"] as Record<string, unknown>)["trace_arrays"]).toBeGreaterThan(0);
    expect(JSON.stringify(event)).not.toContain("src/");
  });
});

// Round-16 review finding 6 (2026-09-03, FX-N0): `committed` was gated
// solely on `seed.guard_enabled` — the LEGACY `TL_SEMANTIC_FRONTIER_GUARD`
// lever. That lever is mutually exclusive with `TL_SF_DEMOTE`
// (`assertSemanticFrontierV2FlagConsistency`), so under the ten-flag v0.15
// (B) treatment (`SEMANTIC_FRONTIER_V2_FLAG_REGISTRY`, legacy guard unset)
// `guard_enabled` is a structural constant `false`, and therefore so was
// `committed` — even when the treatment's own demotion mechanism visibly
// acted on the final wire (measured live: `demoted_count=1,
// re_suppression_count=0, committed=false`). A smoke certificate's "at
// least one treatment first-commit" floor is then unreachable for the v2
// arm by construction, regardless of what the treatment actually did.
//
// These call `finalizeSemanticFrontierAttestation` directly (unit-level,
// bypassing the full read_file pipeline) so both arms' env shape is
// explicit and isolated: `guard_enabled: true` reproduces the LEGACY arm
// exactly as before (byte-identical — same witness-based signal, same
// result), and `guard_enabled: false` with `demoted_count` reproduces the
// v2 arm's own decision/trace fact (`protocol/envelope.ts`'s
// `observeSemanticFrontierWire`, itself gated on `sfDemoteEnabled()`, so a
// present `demoted_count` already proves the lever was on).
describe("finalizeSemanticFrontierAttestation — committed gate covers both levers (FX-N0)", () => {
  function observation(extra: Partial<SemanticFrontierWireObservation> = {}): SemanticFrontierWireObservation {
    return { wire_observed: true, wire_kind: "read.task_pack", decision_kind: "done", ...extra };
  }

  it("legacy guard arm (guard_enabled: true): an active witness still commits — unchanged", () => {
    const seed = traceSeed("legacy-commit", {}, true);
    const event = finalizeSemanticFrontierAttestation(
      seed,
      observation({ decision_kind: "await_input" }),
      [{ reason: "continuation-target", kind: "decision", id: "sha256:legacy-next", outcome: "await-input" }],
    );
    expect(event).toMatchObject({ guard_enabled: true, committed: true });
  });

  it("legacy guard arm (guard_enabled: true): no active witness and no demotion still does not commit — unchanged", () => {
    const seed = traceSeed("legacy-no-commit", {}, true);
    const event = finalizeSemanticFrontierAttestation(seed, observation(), []);
    expect(event).toMatchObject({ guard_enabled: true, committed: false });
  });

  it("v2 treatment arm (guard_enabled: false): a real final-wire demotion commits even though the legacy guard is off", () => {
    const seed = traceSeed("v2-demote-commit", {}, false);
    const event = finalizeSemanticFrontierAttestation(
      seed,
      observation({ demoted_count: 1, re_suppression_count: 0 }),
      [],
    );
    expect(event).toMatchObject({ guard_enabled: false, committed: true, demoted_count: 1 });
  });

  it("v2 treatment arm (guard_enabled: false): demoted_count present but zero does not commit (honest, not just present)", () => {
    const seed = traceSeed("v2-demote-zero", {}, false);
    const event = finalizeSemanticFrontierAttestation(
      seed,
      observation({ demoted_count: 0, re_suppression_count: 0 }),
      [],
    );
    expect(event).toMatchObject({ guard_enabled: false, committed: false });
  });

  it("both levers off: no witness and no demotion never commits", () => {
    const seed = traceSeed("both-off", {}, false);
    const event = finalizeSemanticFrontierAttestation(seed, observation(), []);
    expect(event).toMatchObject({ guard_enabled: false, committed: false });
    expect(event["demoted_count"]).toBeUndefined();
  });

  it("wire not observed as a read.task_pack never commits, even with a demotion fact present", () => {
    const seed = traceSeed("wrong-kind", {}, false);
    const event = finalizeSemanticFrontierAttestation(
      seed,
      observation({ wire_kind: "read.receipt", demoted_count: 1 }),
      [],
    );
    expect(event["committed"]).toBe(false);
  });
});
