import { describe, expect, it, vi } from "vitest";
import {
  bindLedgerCertificate,
  bindLedgerCertificateFromScope,
  ledgerCertificateBindingValid,
} from "../protocol/ledgerCertificateBinding.js";
import { ObligationLedger } from "../state/obligationLedger.js";
import { emitFinalizedPayload } from "../protocol/emit.js";

describe("ledger certificate binding", () => {
  it("rejects a producer payload when its act certificate diverges from the internal discharge binding", () => {
    const payload = { decision: { kind: "act.answer", certificate: { id: `ready-${"0".repeat(16)}-${"1".repeat(16)}` } } };
    bindLedgerCertificate(payload, {
      certificateId: `ready-${"f".repeat(16)}-${"1".repeat(16)}`,
      ledgerDigest: "fedcba9876543210fedcba9876543210",
      discharged: true,
    });
    expect(ledgerCertificateBindingValid(payload)).toBe(false);
  });

  it("accepts only a discharged digest-bound act certificate", () => {
    const ledgerSnapshot = new ObligationLedger().snapshot();
    const id = `ready-${ledgerSnapshot.digest.slice(0, 16)}-${"a".repeat(16)}`;
    const payload = {
      task: { id: "task-accepted", replay: "replay-accepted" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(payload, {
      certificateId: id,
      ledgerDigest: ledgerSnapshot.digest,
      ledgerSnapshot,
      discharged: true,
      workspaceIdentity: "/workspace/accepted",
      lane: "accepted-lane",
      taskHandle: "task-accepted",
      taskReplay: "replay-accepted",
    });
    expect(ledgerCertificateBindingValid(payload)).toBe(true);
  });

  it("retains the binding across the emitter's string-key projection", () => {
    const ledgerSnapshot = new ObligationLedger().snapshot();
    const id = `ready-${ledgerSnapshot.digest.slice(0, 16)}-${"c".repeat(16)}`;
    const payload = {
      task: { id: "task-projected", replay: "replay-projected" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(payload, {
      certificateId: id,
      ledgerDigest: ledgerSnapshot.digest,
      ledgerSnapshot,
      discharged: true,
      taskHandle: "task-projected",
      taskReplay: "replay-projected",
      workspaceIdentity: "/workspace/projected",
      lane: "projected-lane",
    });
    const projected = { ...payload };
    expect(ledgerCertificateBindingValid(projected)).toBe(true);
    const wireProjection = JSON.parse(JSON.stringify(payload));
    expect(ledgerCertificateBindingValid(wireProjection)).toBe(false);
  });

  it("fails closed for same certificate ids across workspace/task projections", () => {
    const ledgerSnapshot = new ObligationLedger().snapshot();
    const id = `ready-${ledgerSnapshot.digest.slice(0, 16)}-${"d".repeat(16)}`;
    const makePayload = (taskHandle: string, taskReplay: string) => ({
      task: { id: taskHandle, replay: taskReplay },
      decision: { kind: "act.answer", certificate: { id } },
    });
    const first = makePayload("task-a", "replay-a");
    const second = makePayload("task-b", "replay-b");
    const common = {
      certificateId: id,
      ledgerDigest: ledgerSnapshot.digest,
      ledgerSnapshot,
      discharged: true,
      lane: "same-lane",
    } as const;
    bindLedgerCertificate(first, {
      ...common,
      workspaceIdentity: "/workspace/a",
      taskHandle: "task-a",
      taskReplay: "replay-a",
    });
    bindLedgerCertificate(second, {
      ...common,
      workspaceIdentity: "/workspace/b",
      taskHandle: "task-b",
      taskReplay: "replay-b",
    });
    const firstProjection = { ...first };
    const secondProjection = { ...second };
    expect(ledgerCertificateBindingValid(firstProjection)).toBe(true);
    expect(ledgerCertificateBindingValid(secondProjection)).toBe(true);
    const forged = { ...firstProjection, task: { id: "task-b", replay: "replay-a" } };
    expect(ledgerCertificateBindingValid(forged)).toBe(false);
  });

  it("retains a binding through top-level shedding without force_serve bypass", () => {
    const ledgerSnapshot = new ObligationLedger().snapshot();
    const id = `ready-${ledgerSnapshot.digest.slice(0, 16)}-${"e".repeat(16)}`;
    const payload = {
      v: 1,
      kind: "read.task_pack",
      task: { id: "task-shed", coverage: "complete", replay: "replay-shed" },
      profile: "answer",
      server_build: { stamp: "x".repeat(2_000) },
      evidence: [{ handle: "h-shed", path: "src/shed.ts", range: "1-2", role: "domain", body: "const ok = true;" }],
      decision: { kind: "act.answer", certificate: { id } },
    } as Record<string, unknown>;
    bindLedgerCertificate(payload, {
      certificateId: id,
      ledgerDigest: ledgerSnapshot.digest,
      ledgerSnapshot,
      discharged: true,
      lane: "shed-lane",
      taskHandle: "task-shed",
      taskReplay: "replay-shed",
      workspaceIdentity: "/workspace/shed",
    });
    const emitted = emitFinalizedPayload(payload, "read.task_pack", { tool: "read_file" }, { budgetOverrideBytes: 900 });
    expect(emitted.isError).not.toBe(true);
    const body = JSON.parse(emitted.content[0]!.text) as Record<string, unknown>;
    expect(body.kind).toBe("read.task_pack");
    expect((body.decision as Record<string, unknown>)?.kind).toBe("act.answer");
  });

  /**
   * A-F3 NEGATIVE CASE (2026-08-28). Every other case in this file builds its
   * snapshot from `new ObligationLedger()` — an EMPTY ledger, over which
   * "discharged" is vacuously true — so nothing here ever exercised the claim
   * the field actually makes. `discharged` was a producer-set boolean and the
   * validators checked only that the digest recomputed, which proves the
   * snapshot was not tampered with and says nothing about its proofs. A
   * faithfully-hashed ledger of entirely unproved obligations therefore
   * validated. The discharge rule is now re-applied to the snapshot bytes.
   */
  it("rejects a binding whose faithfully-hashed ledger still holds an unproved obligation", () => {
    const ledger = new ObligationLedger();
    ledger.add({ kind: "dependency-definitions", target: "applyTax", polarity: "evidence", origin: "query" });
    ledger.add({ kind: "dependency-definitions", target: "applyDiscount", polarity: "evidence", origin: "query" });
    ledger.prove({ kind: "dependency-definitions", target: "applyTax", polarity: "evidence" }, { type: "served", witness: "h-tax" });
    const ledgerSnapshot = ledger.snapshot();
    const id = `ready-${ledgerSnapshot.digest.slice(0, 16)}-${"b".repeat(16)}`;
    const payload = {
      task: { id: "task-unproved", replay: "replay-unproved" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(payload, {
      certificateId: id,
      // The digest is HONEST: it is the real hash of this exact snapshot.
      ledgerDigest: ledgerSnapshot.digest,
      ledgerSnapshot,
      // The claim is not.
      discharged: true,
      workspaceIdentity: "/workspace/unproved",
      lane: "unproved-lane",
      taskHandle: "task-unproved",
      taskReplay: "replay-unproved",
    });
    expect(ledgerCertificateBindingValid(payload)).toBe(false);

    // Discharging the remaining obligation — including by an explicit gap,
    // which A-6(2) counts as a discharge — makes the same act admissible.
    ledger.prove(
      { kind: "dependency-definitions", target: "applyDiscount", polarity: "evidence" },
      { type: "explicit-gap", witness: "re-export chain is not resolvable" },
    );
    const proved = ledger.snapshot();
    const provedId = `ready-${proved.digest.slice(0, 16)}-${"b".repeat(16)}`;
    const provedPayload = {
      task: { id: "task-proved", replay: "replay-proved" },
      decision: { kind: "act.answer", certificate: { id: provedId } },
    };
    bindLedgerCertificate(provedPayload, {
      certificateId: provedId,
      ledgerDigest: proved.digest,
      ledgerSnapshot: proved,
      discharged: true,
      workspaceIdentity: "/workspace/proved",
      lane: "proved-lane",
      taskHandle: "task-proved",
      taskReplay: "replay-proved",
    });
    expect(ledgerCertificateBindingValid(provedPayload)).toBe(true);
  });

  it("rejects an unregistered act and a binding without its ledger snapshot", () => {
    const payload = { decision: { kind: "act.edit", certificate: { id: `ready-${"a".repeat(16)}-${"b".repeat(16)}` } } };
    expect(ledgerCertificateBindingValid(payload)).toBe(false);
    bindLedgerCertificate(payload, {
      certificateId: `ready-${"a".repeat(16)}-${"b".repeat(16)}`,
      ledgerDigest: "0".repeat(64),
      discharged: true,
    });
    expect(ledgerCertificateBindingValid(payload)).toBe(false);
  });

  it("rejects a producer binding whose claimed digest differs from recomputation", () => {
    const ledgerSnapshot = new ObligationLedger().snapshot();
    const id = `ready-${ledgerSnapshot.digest.slice(0, 16)}-${"a".repeat(16)}`;
    const payload = { decision: { kind: "act.answer", certificate: { id } } };
    bindLedgerCertificate(payload, {
      certificateId: id,
      ledgerDigest: "f".repeat(64),
      ledgerSnapshot,
      discharged: true,
    });
    expect(ledgerCertificateBindingValid(payload)).toBe(false);
  });

  it("keeps the emit funnel green only for a bound producer payload", () => {
    const ledgerSnapshot = new ObligationLedger().snapshot();
    const id = `ready-${ledgerSnapshot.digest.slice(0, 16)}-${"b".repeat(16)}`;
    const payload = {
      v: 1,
      kind: "read.task_pack",
      task: { id: "task-funnel", coverage: "complete", replay: "q-funnel" },
      profile: "answer",
      evidence: [{ handle: "h-funnel", path: "src/funnel.ts", range: "1-2", role: "domain", body: "const ok = true;" }],
      decision: { kind: "act.answer", certificate: { id } },
    } as Record<string, unknown>;
    bindLedgerCertificate(payload, {
      certificateId: id,
      ledgerDigest: ledgerSnapshot.digest,
      ledgerSnapshot,
      discharged: true,
      lane: "track-c-luna",
      taskHandle: "task-funnel",
      taskReplay: "q-funnel",
      workspaceIdentity: "/workspace/funnel",
    });
    const emitted = emitFinalizedPayload(payload, "read.task_pack", { tool: "read_file" });
    expect(emitted.isError).not.toBe(true);
  });

  /**
   * A-F3 / A-7: the funnel's ONE sanctioned intervention.
   *
   * Demotion belongs to the producer, and it is there — an undischarged ledger
   * fails `ledgerEstablished` in buildTaskExecutionContract, and server.ts now
   * computes `discharged` from the snapshot instead of asserting it, so it
   * withholds the binding rather than vouching for an act it cannot verify.
   * This pins the backstop for a violation that nonetheless reaches emit: the
   * response is REPLACED by a refusal, never shipped as an unverifiable act.
   * Strict mode is vitest-only and throws instead, so it is disabled here to
   * exercise the production path.
   */
  it("replaces an unverifiable act with a refusal at the emit funnel", () => {
    const previous = process.env["TL_DECISION_INVARIANT_STRICT"];
    process.env["TL_DECISION_INVARIANT_STRICT"] = "off";
    try {
      const ledger = new ObligationLedger();
      ledger.add({ kind: "all-callers", target: "applyOrder", polarity: "evidence", origin: "query" });
      const ledgerSnapshot = ledger.snapshot();
      const id = `ready-${ledgerSnapshot.digest.slice(0, 16)}-${"d".repeat(16)}`;
      const payload = {
        v: 1,
        kind: "read.task_pack",
        task: { id: "task-unverifiable", coverage: "complete", replay: "q-unverifiable" },
        profile: "answer",
        evidence: [{ handle: "h-u", path: "src/u.ts", range: "1-2", role: "domain", body: "const ok = true;" }],
        decision: { kind: "act.answer", certificate: { id } },
      } as Record<string, unknown>;
      bindLedgerCertificate(payload, {
        certificateId: id,
        ledgerDigest: ledgerSnapshot.digest,
        ledgerSnapshot,
        discharged: true,
        lane: "unverifiable-lane",
        taskHandle: "task-unverifiable",
        taskReplay: "q-unverifiable",
        workspaceIdentity: "/workspace/unverifiable",
      });
      const emitted = emitFinalizedPayload(payload, "read.task_pack", { tool: "read_file" });
      expect(emitted.isError).toBe(true);
      const body = JSON.parse((emitted.content as Array<{ text: string }>)[0]!.text) as { kind?: string };
      expect(body.kind).toBe("refusal");
    } finally {
      if (previous === undefined) delete process.env["TL_DECISION_INVARIANT_STRICT"];
      else process.env["TL_DECISION_INVARIANT_STRICT"] = previous;
    }
  });

  it("rejects a single foreign scoped candidate after reconstruction", () => {
    const snapshot = new ObligationLedger().snapshot();
    const id = "ready-" + snapshot.digest.slice(0, 16) + "-" + "6".repeat(16);
    const bound = {
      task: { id: "same-visible-task", replay: "same-visible-replay" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(bound, {
      certificateId: id,
      ledgerDigest: snapshot.digest,
      ledgerSnapshot: snapshot,
      discharged: true,
      workspaceIdentity: "/workspace/foreign-only",
      lane: "foreign-only",
      taskHandle: "same-visible-task",
      taskReplay: "same-visible-replay",
    });
    const reconstructed = JSON.parse(JSON.stringify(bound));
    expect(ledgerCertificateBindingValid(reconstructed)).toBe(false);
  });

  it("rejects a full-digest collision behind the same certificate prefix", () => {
    const snapshot = new ObligationLedger().snapshot();
    const id = "ready-" + snapshot.digest.slice(0, 16) + "-" + "7".repeat(16);
    const first = {
      task: { id: "collision-visible-task", replay: "collision-visible-replay" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    const second = {
      task: { id: "collision-visible-task", replay: "collision-visible-replay" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(first, {
      certificateId: id,
      ledgerDigest: snapshot.digest,
      ledgerSnapshot: snapshot,
      discharged: true,
      workspaceIdentity: "/workspace/collision-first",
      lane: "collision-lane",
      taskHandle: "collision-visible-task",
      taskReplay: "collision-visible-replay",
    });
    bindLedgerCertificate(second, {
      certificateId: id,
      ledgerDigest: "f".repeat(64),
      ledgerSnapshot: snapshot,
      discharged: true,
      workspaceIdentity: "/workspace/collision-second",
      lane: "collision-lane",
      taskHandle: "collision-visible-task",
      taskReplay: "collision-visible-replay",
    });
    const reconstructed = JSON.parse(JSON.stringify(first));
    expect(ledgerCertificateBindingValid(reconstructed)).toBe(false);
  });

  it("expires direct, symbol, and reconstructed binding records", () => {
    vi.useFakeTimers();
    try {
      const snapshot = new ObligationLedger().snapshot();
      const id = "ready-" + snapshot.digest.slice(0, 16) + "-" + "8".repeat(16);
      const payload = {
        task: { id: "expiry-task", replay: "expiry-replay" },
        decision: { kind: "act.answer", certificate: { id } },
      };
      bindLedgerCertificate(payload, {
        certificateId: id,
        ledgerDigest: snapshot.digest,
        ledgerSnapshot: snapshot,
        discharged: true,
        workspaceIdentity: "/workspace/expiry",
        lane: "expiry-lane",
        taskHandle: "expiry-task",
        taskReplay: "expiry-replay",
      });
      const symbolProjection = { ...payload };
      const reconstructed = JSON.parse(JSON.stringify(payload));
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(ledgerCertificateBindingValid(payload)).toBe(false);
      expect(ledgerCertificateBindingValid(symbolProjection)).toBe(false);
      expect(ledgerCertificateBindingValid(reconstructed)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed after the reconstructed index sheds its oldest entry", () => {
    const snapshot = new ObligationLedger().snapshot();
    const firstId = "ready-" + snapshot.digest.slice(0, 16) + "-" + "9".repeat(16);
    const first = {
      task: { id: "cap-first-task", replay: "cap-first-replay" },
      decision: { kind: "act.answer", certificate: { id: firstId } },
    };
    bindLedgerCertificate(first, {
      certificateId: firstId,
      ledgerDigest: snapshot.digest,
      ledgerSnapshot: snapshot,
      discharged: true,
      workspaceIdentity: "/workspace/cap-first",
      lane: "cap-lane",
      taskHandle: "cap-first-task",
      taskReplay: "cap-first-replay",
    });
    for (let index = 0; index < 512; index += 1) {
      const id = "ready-" + snapshot.digest.slice(0, 16) + "-" + index.toString(16).padStart(16, "0");
      const payload = {
        task: { id: "cap-task-" + index, replay: "cap-replay-" + index },
        decision: { kind: "act.answer", certificate: { id } },
      };
      bindLedgerCertificate(payload, {
        certificateId: id,
        ledgerDigest: snapshot.digest,
        ledgerSnapshot: snapshot,
        discharged: true,
        workspaceIdentity: "/workspace/cap-" + index,
        lane: "cap-lane",
        taskHandle: "cap-task-" + index,
        taskReplay: "cap-replay-" + index,
      });
    }
    const reconstructed = JSON.parse(JSON.stringify(first));
    expect(ledgerCertificateBindingValid(reconstructed)).toBe(false);
  });

  it("atomically promotes one producer record across repeated same-task projections", () => {
    const snapshot = new ObligationLedger().snapshot();
    const id = `ready-${snapshot.digest.slice(0, 16)}-${"a".repeat(16)}`;
    const producer = {
      task: { id: "repeat-task", replay: "repeat-replay" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(producer, {
      certificateId: id,
      ledgerDigest: snapshot.digest,
      ledgerSnapshot: snapshot,
      discharged: true,
      taskHandle: "repeat-task",
      taskReplay: "repeat-replay",
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const projection = JSON.parse(JSON.stringify(producer)) as Record<string, unknown>;
      expect(bindLedgerCertificateFromScope(projection, "/workspace/repeat", "repeat-lane")).toBe(true);
      expect(ledgerCertificateBindingValid(projection)).toBe(true);
    }
  });

  it("does not promote a foreign workspace or lane candidate", () => {
    const snapshot = new ObligationLedger().snapshot();
    const id = `ready-${snapshot.digest.slice(0, 16)}-${"b".repeat(16)}`;
    const foreign = {
      task: { id: "foreign-task", replay: "foreign-replay" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(foreign, {
      certificateId: id,
      ledgerDigest: snapshot.digest,
      ledgerSnapshot: snapshot,
      discharged: true,
      workspaceIdentity: "/workspace/foreign",
      lane: "foreign-lane",
      taskHandle: "foreign-task",
      taskReplay: "foreign-replay",
    });
    const projection = JSON.parse(JSON.stringify(foreign)) as Record<string, unknown>;
    expect(bindLedgerCertificateFromScope(projection, "/workspace/target", "target-lane")).toBe(false);
    expect(ledgerCertificateBindingValid(projection)).toBe(false);
  });

  it("fails closed when a foreign scoped candidate shadows a lane-only producer", () => {
    const snapshot = new ObligationLedger().snapshot();
    const id = `ready-${snapshot.digest.slice(0, 16)}-${"c".repeat(16)}`;
    const producer = {
      task: { id: "corpus-task", replay: "corpus-replay" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(producer, {
      certificateId: id,
      ledgerDigest: snapshot.digest,
      ledgerSnapshot: snapshot,
      discharged: true,
      lane: "corpus-lane",
      taskHandle: "corpus-task",
      taskReplay: "corpus-replay",
    });
    const foreign = {
      task: { id: "corpus-task", replay: "corpus-replay" },
      decision: { kind: "act.answer", certificate: { id } },
    };
    bindLedgerCertificate(foreign, {
      certificateId: id,
      ledgerDigest: snapshot.digest,
      ledgerSnapshot: snapshot,
      discharged: true,
      workspaceIdentity: "/workspace/foreign",
      lane: "foreign-lane",
      taskHandle: "corpus-task",
      taskReplay: "corpus-replay",
    });
    const projection = JSON.parse(JSON.stringify(producer)) as Record<string, unknown>;
    expect(bindLedgerCertificateFromScope(projection, "/workspace/target", "corpus-lane")).toBe(false);
    expect(ledgerCertificateBindingValid(projection)).toBe(false);
  });
});
