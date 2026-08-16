/**
 * wireLadder.spec.ts — the P3a S3 shed ladder, at the mechanics level.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT. The fifteen §6.1(b) pins, the
 * replay corpus and `wireBudgetCalibration.spec.ts` prove the ladder is
 * BYTE-INVISIBLE at the calibrated budgets — that is the §0.3 invariant, and it
 * is proved by responses, not by unit tests. This file proves the opposite
 * half: that when the ladder DOES engage, it engages correctly. It reaches that
 * region through `emitFinalizedPayload`'s test-only `budgetOverrideBytes`,
 * which changes WHEN the ladder runs and never what a rung may cut.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT is the C-wave incident (`d7150ec3`,
 * 2026-08-09): a ladder that "removed 3,158 B to close a 1,465 B overage, ran
 * to its last rung, and deleted the authority doc's surface entirely… while
 * leaving 1.7 KB of budget unused". Every assertion below is one clause of
 * that sentence turned into a check.
 */

import { describe, expect, it } from "vitest";

import { runLadder } from "../protocol/budget/ladder.js";
import { validateProtocolBody } from "../protocol/budget/validate.js";
import { SHEDDERS } from "../protocol/budget/shedders/index.js";
import { mergeWireLimit, RUNG_OMITTED_CLASS } from "../protocol/budget/wireLimit.js";
import type { ShedRecord } from "../protocol/budget/wireBudget.js";
import { emitFinalizedPayload } from "../protocol/emit.js";
import type { ProtocolCallContext } from "../protocol/envelope.js";

type Body = Record<string, unknown>;

/** One emission through the real funnel tail, at a chosen budget. */
function emit(
  payload: Body,
  kind: Parameters<typeof emitFinalizedPayload>[1],
  budgetOverrideBytes: number,
  args?: Record<string, unknown>,
): { body: Body; bytes: number; shed: readonly ShedRecord[]; context: ProtocolCallContext; isError: boolean } {
  const context: ProtocolCallContext = { tool: "read_file", ...(args === undefined ? {} : { args }) };
  const result = emitFinalizedPayload(payload, kind, context, { budgetOverrideBytes });
  const text = result.content[0]?.text ?? "";
  return {
    body: JSON.parse(text) as Body,
    bytes: Buffer.byteLength(text, "utf8"),
    shed: context.shedRecords ?? [],
    context,
    isError: result.isError === true,
  };
}

function bytesOf(payload: Body): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

// ---------------------------------------------------------------------------
// Fixtures — real member shapes, sized so a chosen budget engages a chosen rung
// ---------------------------------------------------------------------------

function taskPack(): Body {
  return {
    v: 1,
    kind: "read.task_pack",
    task: { id: "t-ladder", coverage: "complete" },
    profile: "generic",
    evidence: [
      { handle: "h1", path: "src/contract.ts", range: "1-40", role: "contract", body: "C".repeat(300) },
      { handle: "h2", path: "src/api.ts", range: "1-40", role: "api", body: "A".repeat(300) },
      { handle: "h3", path: "src/thing.test.ts", range: "1-40", role: "test", body: "T".repeat(900) },
      { handle: "h4", path: "docs/guide.md", range: "1-40", role: "doc", body: "D".repeat(900) },
    ],
    decision: { kind: "act.edit", frontier: [{ handle: "h1", path: "src/contract.ts", writable: true }] },
    plan: {
      evidence_model: { claims: ["E".repeat(400)] },
      wiring: { evidence_graph: { nodes: ["G".repeat(400)] }, endpoints: ["e1"] },
      change_contract: { obligations: [{ action: "edit", target: "h1", reason: "R".repeat(200) }] },
    },
    profile_binding: {
      requested: "generic",
      selected: "generic",
      source: "declared",
      reason: "the caller declared the profile",
    },
    server_build: "build-abcdef",
    qref: "qref-1",
    create_target: { path: "src/new.ts", dir: "src" },
  };
}

function findMatches(): Body {
  return {
    v: 1,
    kind: "search.matches",
    matches: {
      form: "find",
      query: "needle",
      files: [
        { path: "a.ts", lines: [1, 2, 3], snippets: ["S".repeat(400)] },
        { path: "b.ts", lines: [4, 5, 6], snippets: ["S".repeat(400)] },
        { path: "c.ts", lines: [7, 8, 9], snippets: ["S".repeat(400)] },
      ],
      total_files: 42,
      total_matches: 907,
      literal: true,
      note: "N".repeat(120),
      hint: "H".repeat(120),
    },
  };
}

function pagedReferences(): Body {
  return {
    v: 1,
    kind: "search.references",
    symbol: "resolveHandle",
    references: [
      { path: "a.ts", line: 10, text: "R".repeat(300) },
      { path: "b.ts", line: 20, text: "R".repeat(300) },
    ],
    files: [{ path: "a.ts", snippets: ["S".repeat(400)] }],
    total: 87,
    hint: "H".repeat(120),
    limit: {
      cause: "records",
      omitted: ["results"],
      next: {
        tool: "search_files",
        arguments: { action: "references", symbol: "resolveHandle", cursor: "opaque-cursor-token" },
      },
    },
  };
}

// ---------------------------------------------------------------------------

describe("the S3/S6 interface contract", () => {
  it("`emitFinalizedPayload` declares a FOURTH parameter with no default value", () => {
    // The sweep harness feature-detects the override with
    // `emitFinalizedPayload.length >= 4`, and a JS default value would exclude
    // the parameter from `Function.length` — silently turning every sweep case
    // into a default-budget one. Pinned here so the shape cannot drift.
    expect(emitFinalizedPayload.length).toBe(4);
  });

  it("publishes the shed history on the call context, present-but-empty when nothing shed", () => {
    const payload = taskPack();
    const out = emit(payload, "read.task_pack", bytesOf(payload) + 1);
    expect(out.context.shedRecords).toEqual([]);
  });
});

describe("shed ladder — the C-wave properties (plan §4.3)", () => {
  it("stops at the FIRST rung that fits: removing the last record would have left it over budget", () => {
    const payload = taskPack();
    const budget = bytesOf(payload) - 300;

    const out = emit(payload, "read.task_pack", budget);

    expect(out.shed.length).toBeGreaterThan(0);
    expect(out.bytes).toBeLessThanOrEqual(budget);

    // P8, the negative form: the LAST accepted step was necessary. Restoring
    // the bytes it recovered would put the response back over budget. This is
    // the assertion the C-wave ladder would have failed by 1.7 KB.
    const last = out.shed[out.shed.length - 1]!;
    expect(out.bytes + last.bytes).toBeGreaterThan(budget);
  });

  it("runs NO step at all on a payload that already fits", () => {
    const payload = taskPack();
    const out = emit(payload, "read.task_pack", bytesOf(payload) + 1);

    expect(out.shed).toEqual([]);
    expect(out.body).toEqual(payload);
  });

  it("re-measures after every accepted step: the records account for the whole delta", () => {
    const payload = taskPack();
    // A budget reachable by rungs 1 and 3 alone, which emit no `limit` (E5) —
    // so the final bytes and the sum of the records are exactly comparable,
    // with no disclosure bytes added afterwards.
    const budget = bytesOf(payload) - 200;
    const out = emit(payload, "read.task_pack", budget);

    const recovered = out.shed.reduce((total, record) => total + record.bytes, 0);
    expect(out.shed.every((record) => record.rung === 1 || record.rung === 3)).toBe(true);
    expect(out.body["limit"]).toBeUndefined();
    expect(bytesOf(payload) - out.bytes).toBe(recovered);
    expect(out.shed.every((record) => record.bytes > 0)).toBe(true);
  });

  it("never books the reserved-empty rung 2, in any registered ladder or any emission", () => {
    for (const shedder of Object.values(SHEDDERS)) {
      expect(shedder.rungs.every((entry) => entry.rung !== 2)).toBe(true);
    }
    expect(RUNG_OMITTED_CLASS[2]).toBeUndefined();

    const out = emit(taskPack(), "read.task_pack", 1);
    expect(out.shed.every((record) => record.rung !== 2)).toBe(true);
  });
});

describe("erratum E5 — which rungs may emit a `limit`", () => {
  it("rungs 1 and 3 record a ShedRecord and emit NO limit", () => {
    const payload = taskPack();
    const out = emit(payload, "read.task_pack", bytesOf(payload) - 200);

    expect(out.shed.length).toBeGreaterThan(0);
    expect(out.shed.some((record) => record.rung === 1)).toBe(true);
    expect(out.body["limit"]).toBeUndefined();
  });

  it("a rung-4 shed emits `limit{cause:'wire'}` WITH an executable next", () => {
    const payload = taskPack();
    // Deep enough to exhaust rungs 1 and 3 and reach the evidence axis.
    const out = emit(payload, "read.task_pack", 1600);

    expect(out.shed.some((record) => record.rung === 4)).toBe(true);
    const limit = out.body["limit"] as Body;
    expect(limit).toBeDefined();
    expect(limit["cause"]).toBe("wire");
    expect(limit["next"]).toBeDefined();
    expect(limit["omitted"]).toContain("evidence");
    // E3's stable order: metadata < evidence < results.
    expect(limit["omitted"]).toEqual(["metadata", "evidence"]);
  });

  it("declines rather than shed when no executable `next` exists (search.tree with no depth)", () => {
    const noDepth: Body = {
      v: 1,
      kind: "search.tree",
      root: "packages",
      tree: ["a", "b", "c", "d", "e", "f"].map((entry) => entry.repeat(60)).join("\n"),
      note: "N".repeat(120),
    };
    // Run the ladder to EXHAUSTION rather than through `emit`: with no rung
    // able to close the gap the funnel would fail closed to a refusal, and what
    // is under test here is what the ladder did before that, not what the tail
    // did about it.
    const exhausted = runLadder({
      payload: noDepth,
      kind: "search.tree",
      budget: 1,
      context: {},
      validate: (candidate) => validateProtocolBody(candidate, "search.tree").ok,
    });

    // Rung 1 fires; rung 6 has no shallower call to name, so nothing is cut.
    expect(exhausted.records.every((record) => record.rung === 1)).toBe(true);
    expect(exhausted.payload["tree"]).toBe(noDepth["tree"]);
    expect(exhausted.payload["limit"]).toBeUndefined();

    // With a depth to narrow, the same payload DOES shed and names the call.
    const withDepth = emit({ ...noDepth, depth: 3 }, "search.tree", 420);
    expect(withDepth.shed.some((record) => record.rung === 6)).toBe(true);
    const limit = withDepth.body["limit"] as Body;
    expect(limit["cause"]).toBe("wire");
    expect((limit["next"] as Body)["arguments"]).toMatchObject({ action: "tree", depth: 2 });
  });
});

describe("erratum E3 — the five-clause merge (wireLimit.ts)", () => {
  const prose: ShedRecord[] = [{ rung: 1, bytes: 10 }];
  const results: ShedRecord[] = [{ rung: 6, bytes: 10 }];
  const boundaryNext = { tool: "read_file" as const, arguments: { mode: "slice", handle: "h1" } };
  const emitterNext = { tool: "search_files" as const, arguments: { action: "references", cursor: "tok" } };

  it("clause 2: nothing limit-bearing shed -> the emitter's limit is untouched", () => {
    const emitter = { cause: "capped", omitted: ["results"] };
    expect(mergeWireLimit(emitter, prose, boundaryNext)).toBeUndefined();
    expect(mergeWireLimit(emitter, [], boundaryNext)).toBeUndefined();
    expect(mergeWireLimit(undefined, prose, boundaryNext)).toBeUndefined();
  });

  it("clause 3: rung 4/5/6 with no emitter limit -> a fresh wire limit from the mapping", () => {
    const merged = mergeWireLimit(undefined, [...prose, ...results], boundaryNext);
    expect(merged?.limit).toEqual({
      cause: "wire",
      omitted: ["metadata", "results"],
      next: boundaryNext,
    });
  });

  it("clause 4: an emitter `records` limit keeps its cause AND its cursor", () => {
    const emitter = { cause: "records", omitted: ["results"], next: emitterNext };
    const merged = mergeWireLimit(emitter, [...prose, ...results], boundaryNext);

    expect(merged?.limit).toEqual({
      cause: "records",
      omitted: ["metadata", "results"],
      next: emitterNext,
    });
  });

  it("clause 5: a next-less emitter arm is promoted to wire with the boundary's next", () => {
    for (const cause of ["source", "capped"]) {
      const merged = mergeWireLimit({ cause, omitted: ["evidence"] }, results, boundaryNext);
      expect(merged?.limit).toEqual({
        cause: "wire",
        omitted: ["evidence", "results"],
        next: boundaryNext,
      });
    }
  });

  it("clause 5 residual: a next-less arm with no boundary next stays next-less", () => {
    const merged = mergeWireLimit({ cause: "capped" }, results, undefined);
    expect(merged?.limit).toEqual({ cause: "capped", omitted: ["results"] });
  });

  it("clause 3 with no constructible next says nothing rather than emit a next-less wire limit", () => {
    expect(mergeWireLimit(undefined, results, undefined)).toBeUndefined();
  });

  it("integration: a paged `search.references` shed never displaces the cursor", () => {
    const payload = pagedReferences();
    const out = emit(payload, "search.references", 900);

    expect(out.shed.some((record) => record.rung === 6)).toBe(true);
    const limit = out.body["limit"] as Body;
    expect(limit["cause"]).toBe("records");
    expect((limit["next"] as Body)["arguments"]).toMatchObject({ cursor: "opaque-cursor-token" });
    expect(limit["omitted"]).toEqual(["metadata", "results"]);
  });
});

describe("the evidence rungs (R6 / erratum E4)", () => {
  it("rung 4 keeps the addressing triple, populates `remaining`, and mints no `prior`", () => {
    const payload = taskPack();
    const out = emit(payload, "read.task_pack", 1600);

    const evidence = out.body["evidence"] as Body[];
    const stripped = evidence.filter((entry) => entry["body"] === undefined);
    expect(stripped.length).toBeGreaterThan(0);

    for (const entry of stripped) {
      expect(typeof entry["handle"]).toBe("string");
      expect(typeof entry["path"]).toBe("string");
      expect(typeof entry["range"]).toBe("string");
      // A.8.2 E-8: `!body` implies `prior` or `remaining` — and E4 forbids the
      // `prior` repair, so `remaining` is the only honest one and it names this
      // entry's own window.
      expect(entry["remaining"]).toEqual([entry["range"]]);
    }
    // E4 / R5 ruling 2, as an unconditional negative: the boundary shedder must
    // never assert the client already holds bytes.
    expect(evidence.every((entry) => entry["prior"] === undefined)).toBe(true);
  });

  it("rung 5 drops the lowest-role-priority entry first and never an authority surface", () => {
    const payload = taskPack();
    const { payload: shed } = runLadder({
      payload,
      kind: "read.task_pack",
      budget: 1,
      context: {},
      validate: (candidate) => validateProtocolBody(candidate, "read.task_pack").ok,
    });

    const roles = (shed["evidence"] as Body[]).map((entry) => entry["role"]);
    // `doc` and `test` are droppable; `contract` and `api` are the authority
    // class the C-wave deleted, and both survive a ladder run to exhaustion.
    expect(roles).toContain("contract");
    expect(roles).toContain("api");
    expect(roles).not.toContain("doc");
  });

  it("`read.text` rung 4 TRUNCATES: the surviving range names only what shipped", () => {
    const payload: Body = {
      v: 1,
      kind: "read.text",
      evidence: [
        {
          handle: "h1",
          path: "src/big.ts",
          range: "1-8",
          body: Array.from({ length: 8 }, (_, i) => `line ${i + 1} ${"x".repeat(200)}`).join("\n"),
        },
      ],
      note: "N".repeat(100),
    };
    // Sized so exactly ONE halving closes the gap: the prose goes first, then a
    // single rung-4 cut brings the published response (limit included) under.
    const out = emit(payload, "read.text", 1400);

    const entry = (out.body["evidence"] as Body[])[0]!;
    expect(entry["range"]).toBe("1-4");
    expect(entry["remaining"]).toEqual(["5-8"]);
    expect(String(entry["body"]).split("\n")).toHaveLength(4);
    const limit = out.body["limit"] as Body;
    expect(limit["cause"]).toBe("wire");
    expect((limit["next"] as Body)["arguments"]).toMatchObject({ handle: "h1", range: "5-8" });
  });
});

describe("the unsheddables", () => {
  it("`create_target` survives a task_pack ladder run to exhaustion (ruling 6)", () => {
    const payload = taskPack();
    const { payload: shed } = runLadder({
      payload,
      kind: "read.task_pack",
      budget: 1,
      context: {},
      validate: (candidate) => validateProtocolBody(candidate, "read.task_pack").ok,
    });

    expect(shed["create_target"]).toEqual({ path: "src/new.ts", dir: "src" });
    // …and so does the required set the member exists to carry.
    expect(shed["task"]).toBeDefined();
    expect(shed["profile"]).toBe("generic");
    expect(shed["decision"]).toBeDefined();
    // The structured-rare members it CAN shed did go.
    expect(shed["qref"]).toBeUndefined();
    expect(shed["server_build"]).toBeUndefined();
  });

  it("P16: a `search.matches` shed never reduces the inventory counts", () => {
    const payload = findMatches();
    const out = emit(payload, "search.matches", 900, { query: "needle" });

    expect(out.shed.some((record) => record.rung === 6)).toBe(true);
    const matches = out.body["matches"] as Body;
    expect(matches["total_files"]).toBe(42);
    expect(matches["total_matches"]).toBe(907);
    // The cut is real: something left.
    expect(JSON.stringify(matches).length).toBeLessThan(JSON.stringify(payload["matches"]).length);
  });

  it("`search.references` `limit.next` is never shed at any rung", () => {
    const payload = pagedReferences();
    const { payload: shed } = runLadder({
      payload,
      kind: "search.references",
      budget: 1,
      context: {},
      validate: (candidate) => validateProtocolBody(candidate, "search.references").ok,
    });

    const limit = shed["limit"] as Body;
    expect(limit["next"]).toBeDefined();
    expect((limit["next"] as Body)["arguments"]).toMatchObject({ cursor: "opaque-cursor-token" });
  });
});

describe("the SE-STABLE trio (ruling 7)", () => {
  const applied: Body = {
    v: 1,
    kind: "edit.applied",
    core: {
      paths: ["a.ts"],
      counts: { files: 1, edits: 1 },
      workspace: {
        fingerprint: "fp",
        scope: "served-evidence",
        evidence_files: 1,
        inventory_files: 1,
        inventory_complete: true,
      },
    },
    applied: [{ path: "a.ts", range: "1-4" }],
    applied_note: "N".repeat(400),
    hint: "H".repeat(400),
  };

  it("has zero rungs and sheds nothing, even at a budget of one byte", () => {
    for (const kind of ["edit.applied", "edit.rolled_back", "edit.state_unknown"] as const) {
      expect(SHEDDERS[kind].rungs).toEqual([]);
      expect(SHEDDERS[kind].refusalConvertible).toBe(false);
    }

    const out = emit(applied, "edit.applied", 1);
    expect(out.shed).toEqual([]);
    expect(out.body).toEqual(applied);
  });

  it("is emitted as itself and NEVER converted to a refusal", () => {
    const out = emit(applied, "edit.applied", 1);
    expect(out.body["kind"]).toBe("edit.applied");
    expect(out.isError).toBe(false);
  });

  it("fails closed as a state-unknown refusal for a side-effect body missing SideEffectCore in production mode", () => {
    const malformed = { ...applied };
    delete malformed["core"];
    const out = emit(malformed, "edit.applied", 1);
    expect(out.isError).toBe(true);
    expect(out.body["kind"]).toBe("refusal");
    expect(out.body["code"]).toBe("invalid-input");
    expect(out.body["retry"]).toBe("none");
    expect(String(out.body["detail"])).toMatch(/fail-closed side-effect/);
  });

  it("refuses an unknown runtime kind before budget lookup", () => {
    const malformedKind = "edit.future" as Parameters<typeof emitFinalizedPayload>[1];
    const context: ProtocolCallContext = { tool: "read_file" };
    const result = emitFinalizedPayload({ v: 1, kind: malformedKind }, malformedKind, context, { budgetOverrideBytes: 1 });
    const body = JSON.parse(result.content[0]?.text ?? "{}") as Body;
    expect(body).toMatchObject({ kind: "refusal", code: "invalid-input", retry: "none" });
    expect(String(body["detail"])).toContain("unknown runtime kind");
    expect(result.isError).toBe(true);
    expect((context as ProtocolCallContext & { protocolViolationCount?: number }).protocolViolationCount).toBe(1);
  });
});

describe("§4.3's fail-closed tail", () => {
  it("converts a convertible kind that cannot fit into a refusal naming the limit", () => {
    const payload = findMatches();
    const out = emit(payload, "search.matches", 40, { query: "needle" });

    expect(out.body["kind"]).toBe("refusal");
    expect(out.body["for"]).toBe("read_file");
    expect(out.body["code"]).toBe("cap-exceeded");
    expect(out.body["retry"]).toBe("call");
    expect(String(out.body["detail"])).toContain("wire budget");
    expect(out.isError).toBe(true);
  });

  it("emits `read.closure` regardless of the budget, and records the violation", () => {
    const closure: Body = {
      v: 1,
      kind: "read.closure",
      open: ["check-a", "check-b"],
      done: 1,
      total: 3,
      note: "N".repeat(200),
    };
    const out = emit(closure, "read.closure", 10);

    expect(out.body["kind"]).toBe("read.closure");
    expect(out.body["open"]).toEqual(["check-a", "check-b"]);
    expect(
      (out.context.protocolViolations ?? []).some((violation) =>
        violation.violated.some((id) => id.startsWith("wire/floor-exceeds-budget")),
      ),
    ).toBe(true);
    expect((out.context as ProtocolCallContext & { protocolViolationCount?: number }).protocolViolationCount).toBe(1);
  });

  it("never converts a `refusal` into another refusal", () => {
    const refusal: Body = {
      v: 1,
      kind: "refusal",
      for: "edit_file",
      code: "search-not-unique",
      next: { tool: "edit_file", arguments: { handle: "h1", search: "a", replace: "b" } },
      field: "search",
      did_you_mean: "precondition",
      keys: ["search", "replace", "precondition"],
      detail: "D".repeat(500),
      retry: "call",
    };
    const out = emit(refusal, "refusal", 200);

    expect(out.body["kind"]).toBe("refusal");
    // §5.8: `detail` goes first; `next`, `did_you_mean` and `field` never do.
    expect(out.body["detail"]).toBeUndefined();
    expect(out.body["next"]).toBeDefined();
    expect(out.body["did_you_mean"]).toBe("precondition");
    expect(out.body["field"]).toBe("search");
    expect(out.shed.every((record) => record.rung === 1 || record.rung === 3)).toBe(true);
  });
});
