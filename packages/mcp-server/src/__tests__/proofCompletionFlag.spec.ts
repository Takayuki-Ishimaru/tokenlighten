import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTaskExecutionContract, type TaskPackResult } from "../features/task-pack/readCodeTaskPack.js";
import {
  noteProofCompletionPack,
  proofCompletionLiveCounterForTest,
  PROOF_COMPLETION_FLAG_REGISTRY,
  PROOF_COMPLETION_TRACE_MAX_BYTES,
  resetProofCompletionLiveCounterForTest,
} from "../util/flags.js";

const previous = process.env["TL_PROOF_COMPLETION"];

afterEach(() => {
  if (previous === undefined) delete process.env["TL_PROOF_COMPLETION"];
  else process.env["TL_PROOF_COMPLETION"] = previous;
  resetProofCompletionLiveCounterForTest();
});

function answerPack(): TaskPackResult {
  return {
    coverage: "complete",
    surfaces: [{
      kind: "code",
      path: "src/result.ts",
      handle: "h-result",
      code: "export const result = 1;",
      required: true,
      content_completeness: "complete",
    }],
    missing: [],
    route: { action: "answer_from_handles", max_additional_tl_calls: 0 },
    content_sufficiency: "complete",
  } as unknown as TaskPackResult;
}

describe("proof-completion feature gate", () => {
  it("declares the default-ON compatibility matrix and trace channel", () => {
    delete process.env["TL_PROOF_COMPLETION"];
    expect(PROOF_COMPLETION_FLAG_REGISTRY).toEqual({
      flag: "TL_PROOF_COMPLETION",
      default: "on",
      off_compatibility: true,
      engagement_trace_env: "TL_PROOF_COMPLETION_TRACE_PATH",
      // RE-PIN (A-F6, 2026-08-28): was `"none"`, which the implementation
      // contradicted. A discharged ledger contributes its digest to the
      // certificate, so `decision.certificate.id` changes shape between the two
      // modes (`ready-<ledger16>-<proof16>` vs v0.12's `ready-<proof16>`), and
      // `ledgerCertificateBindingValid` discriminates on exactly that form —
      // the id cannot move under the flag without blinding the binding check.
      // The decision distribution likewise differs BY DESIGN on exhaustive
      // queries; that is what the flag is for. The registry says so now.
      wire_effect: "decision-distribution+certificate-id-shape",
    });
  });

  it("gates readCodeTaskPack contract acceptance and records a live enabled counter", () => {
    process.env["TL_PROOF_COMPLETION"] = "on";
    const contract = buildTaskExecutionContract(answerPack(), "answer", "show every direct callee");
    expect(contract.state).toBe("needs-followup");
    expect(proofCompletionLiveCounterForTest()).toBe(1);
  });

  // P2(b) (2026-08-28 review-fix wave): the counter measures live PACK
  // decisions, not internal re-evaluations of one. buildTaskExecutionContract
  // runs at least twice per pack by its own doc comment ("before and after
  // final same-epoch reconciliation") and up to four call sites in
  // readCodeTaskPack.ts can each invoke it for the SAME pack. Re-evaluating
  // the identical TaskPackResult object (the shape every real multi-pass pack
  // build threads through) must count once, not once per pass.
  it("counts one pack once even when buildTaskExecutionContract re-evaluates the same result object", () => {
    process.env["TL_PROOF_COMPLETION"] = "on";
    const pack = answerPack();
    buildTaskExecutionContract(pack, "answer", "show every direct callee");
    buildTaskExecutionContract(pack, "answer", "show every direct callee");
    buildTaskExecutionContract(pack, "answer", "show every direct callee");
    expect(proofCompletionLiveCounterForTest()).toBe(1);

    // A genuinely DIFFERENT pack (a distinct result object) still counts as
    // its own engagement — the dedupe is scoped to one object's identity, not
    // a global "only ever count once" latch.
    buildTaskExecutionContract(answerPack(), "answer", "show every direct callee");
    expect(proofCompletionLiveCounterForTest()).toBe(2);
  });

  // P2(b): the opt-in trace file must not grow without bound if a caller sets
  // TL_PROOF_COMPLETION_TRACE_PATH and never rotates it.
  it("stops appending to the opt-in trace file once it reaches the named size cap", () => {
    const previousTracePath = process.env["TL_PROOF_COMPLETION_TRACE_PATH"];
    const tracePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tl-trace-cap-")), "trace.jsonl");
    try {
      process.env["TL_PROOF_COMPLETION_TRACE_PATH"] = tracePath;
      // Pre-fill the file AT the cap — noteProofCompletionPack's own check is
      // `currentSize < MAX`, so exactly-at-cap must already refuse to grow it
      // further (never one line past the bound).
      fs.writeFileSync(tracePath, "x".repeat(PROOF_COMPLETION_TRACE_MAX_BYTES));
      const sizeBefore = fs.statSync(tracePath).size;
      expect(sizeBefore).toBe(PROOF_COMPLETION_TRACE_MAX_BYTES);

      noteProofCompletionPack();

      expect(fs.statSync(tracePath).size, "append must be skipped once the file is at/over the cap").toBe(sizeBefore);
    } finally {
      if (previousTracePath === undefined) delete process.env["TL_PROOF_COMPLETION_TRACE_PATH"];
      else process.env["TL_PROOF_COMPLETION_TRACE_PATH"] = previousTracePath;
      fs.rmSync(path.dirname(tracePath), { recursive: true, force: true });
    }
  });

  it("still appends to the opt-in trace file while it is under the size cap", () => {
    const previousTracePath = process.env["TL_PROOF_COMPLETION_TRACE_PATH"];
    const tracePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tl-trace-under-cap-")), "trace.jsonl");
    try {
      process.env["TL_PROOF_COMPLETION_TRACE_PATH"] = tracePath;
      noteProofCompletionPack();
      expect(fs.existsSync(tracePath)).toBe(true);
      const firstSize = fs.statSync(tracePath).size;
      expect(firstSize).toBeGreaterThan(0);
      noteProofCompletionPack();
      expect(fs.statSync(tracePath).size).toBeGreaterThan(firstSize);
    } finally {
      if (previousTracePath === undefined) delete process.env["TL_PROOF_COMPLETION_TRACE_PATH"];
      else process.env["TL_PROOF_COMPLETION_TRACE_PATH"] = previousTracePath;
      fs.rmSync(path.dirname(tracePath), { recursive: true, force: true });
    }
  });

  it("preserves the pre-proof compatibility result and counter parity when OFF", () => {
    process.env["TL_PROOF_COMPLETION"] = "off";
    const contract = buildTaskExecutionContract(answerPack(), "answer", "show every direct callee");
    expect(contract.state).toBe("ready");
    expect(proofCompletionLiveCounterForTest()).toBe(0);
  });

  /**
   * A-F6 OFF PARITY = v0.12, NOT "no gate at all".
   *
   * The shipped acceptance rule was `(!proofCompletion || proofComplete) &&
   * (!proofCompletion || ledgerEstablished)`, which is `true` under OFF — so
   * OFF certified on `baseReady` alone, a THIRD behavior looser than both
   * releases. v0.12 (base 23a023e0) accepted on `proofComplete && risk accept`;
   * a pack that fails EITHER of those must therefore still be rejected with the
   * switch OFF, or the compatibility arm is not a compatibility arm.
   */
  it("OFF still enforces the v0.12 premises rather than certifying baseReady alone", () => {
    process.env["TL_PROOF_COMPLETION"] = "off";
    const pack = answerPack();
    // A required surface with no served body: baseReady's route/sufficiency
    // shape is intact, but the readiness obligation over it cannot prove.
    (pack.surfaces as unknown as Array<Record<string, unknown>>).push({
      kind: "code",
      path: "src/dependency.ts",
      handle: "h-dependency",
      required: true,
      content_completeness: "complete",
    });
    const contract = buildTaskExecutionContract(pack, "answer", "explain the result value");
    expect(contract.state).toBe("needs-followup");
    expect(contract.readiness_certificate).toBeUndefined();
  });

  /**
   * A-F3 PRODUCER DEMOTION (A-7), synthesized by withholding the ledger.
   *
   * `ledgerEstablished` read `taskContractDigest(workspace) === undefined` — no
   * ledger at all — as ESTABLISHED, so the one state in which nothing had been
   * proved was the CHEAPEST way to satisfy the theorem, and an exhaustive query
   * could certify having recorded no requirement whatsoever. Demotion is a
   * producer-layer decision (emit.ts's own doc: "honest termination is the
   * producer's decision"), so it is pinned here at the producer: no ledger, no
   * act — the contract never reaches `ready` and mints no certificate, which is
   * what keeps an unverifiable `act.*` off the wire in the first place.
   */
  it("ON refuses to certify an exhaustive task whose ledger was never established", () => {
    process.env["TL_PROOF_COMPLETION"] = "on";
    const workspace = `/tmp/tl-af3-no-ledger-${Date.now()}-${Math.random()}`;
    const contract = buildTaskExecutionContract(
      answerPack(),
      "answer",
      "list every caller of the result value",
      undefined,
      workspace,
    );
    expect(contract.state).toBe("needs-followup");
    expect(contract.readiness_certificate).toBeUndefined();
  });

  /**
   * The other half of A-F3(a): a NON-exhaustive task may still accept with no
   * ledger — that is v0.12 compatibility — but its certificate must not claim a
   * discharge it did not perform. `dischargeCertificate` returns nothing for an
   * empty ledger, so the id stays in the legacy single-segment form, which is
   * the verifiable shape for "no ledger was involved in this decision".
   */
  it("ON accepts a non-exhaustive task with no ledger, without claiming a discharge", () => {
    process.env["TL_PROOF_COMPLETION"] = "on";
    const workspace = `/tmp/tl-af3-legacy-id-${Date.now()}-${Math.random()}`;
    const contract = buildTaskExecutionContract(
      answerPack(),
      "answer",
      "explain the result value",
      undefined,
      workspace,
    );
    expect(contract.state).toBe("ready");
    expect(contract.readiness_certificate?.id).toMatch(/^ready-[a-f0-9]{16}$/);
  });

  /**
   * A-F6(b): risk is the SECOND layer, and it survives the move.  With proof
   * completion ON the theorem is the ledger discharge — but a theorem the risk
   * engine rejects must still be suppressed, exactly as in v0.12. Written
   * against the same synthetic pack so only the risk verdict differs.
   */
  it("ON keeps risk as a second-layer suppression over a holding theorem", () => {
    process.env["TL_PROOF_COMPLETION"] = "on";
    const contract = buildTaskExecutionContract(answerPack(), "answer", "explain the result value");
    // The theorem holds for this fully-served, obligation-free answer pack.
    expect(contract.state).toBe("ready");
    expect(contract.readiness_certificate?.risk?.decision).toBe("accept");
  });
});
