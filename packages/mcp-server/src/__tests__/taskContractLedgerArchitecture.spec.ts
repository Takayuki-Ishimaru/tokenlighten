import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTaskContract,
  clearTaskContractsForLane,
  bindTaskContractHandle,
  MAX_TASK_CONTRACTS_PER_LANE,
  queryTaskContract,
  recordAuthoritativeAbsentConcerns,
  recordEvidenceExpansion,
  recordExplicitGap,
  recordTaskContract,
  resetTaskContractStoreForTest,
  taskContractLedgerSnapshotForTest,
  TASK_CONTRACT_STATE_TTL_MS,
  type TaskContractScope,
} from "../features/task-pack/taskContractStore.js";
import { CAPACITY_OBLIGATION, MAX_LEDGER_OBLIGATIONS } from "../state/obligationLedger.js";
import { resetStateStoresForTests } from "../state/stateStore.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) clearTaskContract(root);
  resetTaskContractStoreForTest();
  resetStateStoresForTests();
});

describe("task-contract ledger architecture", () => {
  it("binds each ledger to lane and task handle instead of workspace alone", () => {
    const root = `/tmp/tl-contract-architecture-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const alpha: TaskContractScope = { lane: "alpha", taskHandle: "handle-a" };
    const beta: TaskContractScope = { lane: "beta", taskHandle: "handle-b" };

    recordTaskContract(root, ["invoice", "total"], {
      query: "invoice total",
      requiredRoles: ["domain"],
      servedRoles: ["domain"],
    }, alpha);
    recordTaskContract(root, ["invoice", "total"], {
      query: "invoice total",
      requiredRoles: ["test"],
    }, beta);

    expect(queryTaskContract(root, ["invoice", "total"], alpha)?.requiredRoles).toEqual(["domain"]);
    expect(queryTaskContract(root, ["invoice", "total"], beta)?.requiredRoles).toEqual(["test"]);
    expect(queryTaskContract(root, ["invoice", "total"], { lane: "other", taskHandle: "handle-a" })).toBeUndefined();
  });

  it("clears every durable handle in only the new-task lane", () => {
    const root = `/tmp/tl-contract-lane-clear-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const alphaOne: TaskContractScope = { lane: "alpha", taskHandle: "stable-one" };
    const alphaTwo: TaskContractScope = { lane: "alpha", taskHandle: "stable-two" };
    const beta: TaskContractScope = { lane: "beta", taskHandle: "stable-one" };
    for (const scope of [alphaOne, alphaTwo, beta]) {
      recordTaskContract(root, ["invoice", "total"], {
        query: "invoice total",
        requiredRoles: [scope.lane],
      }, scope);
    }

    // Simulate a restart: the epoch boundary must enumerate the durable lane
    // index, not merely delete the default in-memory workspace record.
    resetTaskContractStoreForTest();
    clearTaskContractsForLane(root, "alpha");
    resetTaskContractStoreForTest();
    expect(taskContractLedgerSnapshotForTest(root, alphaOne)).toBeUndefined();
    expect(taskContractLedgerSnapshotForTest(root, alphaTwo)).toBeUndefined();
    expect(taskContractLedgerSnapshotForTest(root, beta)).toBeDefined();
  });

  it("clears both the fresh default source and stable handle at a lane epoch boundary", () => {
    const root = `/tmp/tl-contract-durable-move-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const source: TaskContractScope = { lane: "alpha" };
    const destination = bindTaskContractHandle(root, source, "stable-task");
    // Binding before a producer has recorded its ledger is intentionally a no-op.
    expect(taskContractLedgerSnapshotForTest(root, destination)).toBeUndefined();

    recordTaskContract(root, ["invoice", "total"], {
      query: "invoice total",
      requiredRoles: ["domain"],
    }, source);
    const moved = bindTaskContractHandle(root, source, "stable-task");
    resetTaskContractStoreForTest();
    // The source remains readable during the response that minted the opaque
    // task handle; new-epoch clear below is its explicit lifetime boundary.
    expect(taskContractLedgerSnapshotForTest(root, source)).toBeDefined();
    expect(taskContractLedgerSnapshotForTest(root, moved)).toBeDefined();

    clearTaskContractsForLane(root, "alpha");
    resetTaskContractStoreForTest();
    expect(taskContractLedgerSnapshotForTest(root, source)).toBeUndefined();
    expect(taskContractLedgerSnapshotForTest(root, moved)).toBeUndefined();
  });

  it("replaces a same-identity destination with the current source ledger on rebind", () => {
    const root = `/tmp/tl-contract-rebind-same-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const source: TaskContractScope = { lane: "rebind-same" };
    const destination = bindTaskContractHandle(root, source, "stable-task");
    recordTaskContract(root, ["invoice", "total"], {
      query: "invoice total",
      requiredRoles: ["domain"],
      servedRoles: ["domain"],
    }, source);
    bindTaskContractHandle(root, source, "stable-task");
    const staleDigest = taskContractLedgerSnapshotForTest(root, destination)?.digest;

    // The source is the current pack's ledger.  Its certificate digest must
    // remain the destination digest after a same-task rebind.
    recordTaskContract(root, ["invoice", "total"], {
      query: "invoice total",
      requiredRoles: ["test"],
      servedRoles: ["test"],
    }, source);
    const sourceDigest = taskContractLedgerSnapshotForTest(root, source)?.digest;
    expect(sourceDigest).not.toBe(staleDigest);

    const rebound = bindTaskContractHandle(root, source, "stable-task");
    expect(rebound).toEqual(destination);
    expect(taskContractLedgerSnapshotForTest(root, rebound)?.digest).toBe(sourceDigest);
    expect(taskContractLedgerSnapshotForTest(root, rebound)?.obligations).toContainEqual(expect.objectContaining({
      kind: "required-role", target: "test", proof: { type: "served", witness: "test" },
    }));
  });

  it("refuses to let a different task identity take over an existing destination handle", () => {
    const root = `/tmp/tl-contract-rebind-foreign-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const destination = bindTaskContractHandle(root, { lane: "rebind-foreign" }, "stable-task");
    recordTaskContract(root, ["invoice", "total"], {
      query: "invoice total",
      requiredRoles: ["domain"],
      servedRoles: ["domain"],
    }, { lane: "rebind-foreign" });
    bindTaskContractHandle(root, { lane: "rebind-foreign" }, "stable-task");
    const destinationDigest = taskContractLedgerSnapshotForTest(root, destination)?.digest;

    const foreign: TaskContractScope = { lane: "rebind-foreign" };
    recordTaskContract(root, ["unrelated", "deployment"], {
      query: "unrelated deployment",
      requiredRoles: ["test"],
      servedRoles: ["test"],
    }, foreign);
    const foreignDigest = taskContractLedgerSnapshotForTest(root, foreign)?.digest;
    expect(foreignDigest).not.toBe(destinationDigest);

    expect(bindTaskContractHandle(root, foreign, "stable-task")).toEqual(destination);
    expect(taskContractLedgerSnapshotForTest(root, destination)?.digest).toBe(destinationDigest);
    expect(taskContractLedgerSnapshotForTest(root, destination)?.obligations).not.toContainEqual(expect.objectContaining({
      kind: "required-role", target: "test",
    }));
  });

  it("round-trips the sole obligation ledger through the persistent state store", () => {
    const root = `/tmp/tl-contract-roundtrip-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const scope: TaskContractScope = { lane: "roundtrip", taskHandle: "task-1" };
    recordTaskContract(root, ["status", "report"], {
      query: "status report",
      requiredRoles: ["domain"],
      concernTokens: ["status"],
      servedRoles: ["domain"],
      coveredConcernTokens: ["status"],
    }, scope);
    const before = taskContractLedgerSnapshotForTest(root, scope);
    expect(before?.obligations).toHaveLength(2);
    expect(before?.digest).toMatch(/^[0-9a-f]{64}$/);

    // Simulate a process restart: the in-memory projection is gone, but the
    // state-store record remains and must reconstruct the same ledger digest.
    resetTaskContractStoreForTest();
    resetStateStoresForTests();
    const after = taskContractLedgerSnapshotForTest(root, scope);
    expect(after).toEqual(before);
    expect(queryTaskContract(root, ["status", "report"], scope)).toMatchObject({
      ledgerDigest: before?.digest,
      requiredRoles: ["domain"],
      concernTokens: ["status"],
    });
  });

  it("caps persisted task handles independently per lane and retains the newest scopes after restart", () => {
    const root = `/tmp/tl-contract-lane-cap-${Date.now()}-${Math.random()}`;
    roots.push(root);
    for (let index = 0; index <= MAX_TASK_CONTRACTS_PER_LANE; index += 1) {
      recordTaskContract(root, ["invoice", "total"], { query: "invoice total", requiredRoles: [`role-${index}`] }, { lane: "alpha", taskHandle: `task-${index}` });
    }
    expect(taskContractLedgerSnapshotForTest(root, { lane: "alpha", taskHandle: "task-0" })).toBeUndefined();
    expect(taskContractLedgerSnapshotForTest(root, { lane: "alpha", taskHandle: `task-${MAX_TASK_CONTRACTS_PER_LANE}` })).toBeDefined();
    // A different lane has its own cap budget, rather than competing with alpha.
    recordTaskContract(root, ["invoice", "total"], { query: "invoice total", requiredRoles: ["beta"] }, { lane: "beta", taskHandle: "task-0" });
    resetTaskContractStoreForTest();
    resetStateStoresForTests();
    expect(taskContractLedgerSnapshotForTest(root, { lane: "alpha", taskHandle: "task-0" })).toBeUndefined();
    expect(taskContractLedgerSnapshotForTest(root, { lane: "alpha", taskHandle: `task-${MAX_TASK_CONTRACTS_PER_LANE}` })).toBeDefined();
    expect(taskContractLedgerSnapshotForTest(root, { lane: "beta", taskHandle: "task-0" })).toBeDefined();
  });

  /**
   * A-F4 (2026-08-28): the store's own write sites are the hot path.
   *
   * This is the P0-2 REPAIR FLOW, verbatim through the public API: an
   * expansion capability limit proves the open-universe obligation as an
   * explicit gap, and the prescribed absence then proves the SAME obligation
   * as `authoritative-absent`. Under the pre-A-F4 ledger the second call threw
   * "obligation proof is immutable once recorded" out of a live search_files
   * dispatch. Proof immutability is still enforced — the first witness stands.
   */
  it("survives the repair flow's conflicting re-prove without throwing", () => {
    const root = `/tmp/tl-contract-reprove-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const scope: TaskContractScope = { lane: "repair", taskHandle: "task-1" };
    recordTaskContract(root, ["refunded", "invoicestatus"], {
      query: "Add REFUNDED everywhere InvoiceStatus is used.",
      concernTokens: ["REFUNDED"],
    }, scope);
    recordExplicitGap(root, "dependency-definitions", "open-universe", "1-hop expansion cap", scope);

    expect(() => recordAuthoritativeAbsentConcerns(root, ["REFUNDED"], scope)).not.toThrow();
    const openUniverse = taskContractLedgerSnapshotForTest(root, scope)?.obligations
      .find((entry) => entry.kind === "dependency-definitions" && entry.target === "open-universe");
    expect(openUniverse?.proof).toEqual({ type: "explicit-gap", witness: "1-hop expansion cap" });
  });

  // P1-a (2026-08-28 review-fix wave): `polarity:"edit"` was cast in the type
  // but never minted anywhere. An additive open-universe mutation's requested
  // value (REFUNDED here) is a requirement on the EDIT, not on evidence —
  // epochConcernTokensFor's doc comment in readCodeTaskPack.ts states the
  // classification; this pins the ledger actually carrying it. The token's
  // absence-consumption must ADD a distinct polarity:"edit" twin next to the
  // existing polarity:"evidence" obligation (monotone-add, never a rewrite of
  // the evidence entry) and progress it straight to a terminal proof, so the
  // pack has nothing further to search for and is free to advance to an edit
  // frontier over the served enum/consumer surfaces.
  it("converts an absence-proven additive-mutation token into a discharged edit-polarity obligation", () => {
    const root = `/tmp/tl-contract-edit-polarity-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const scope: TaskContractScope = { lane: "edit-polarity", taskHandle: "task-1" };
    const query = "Add REFUNDED everywhere InvoiceStatus is used.";
    recordTaskContract(root, ["refunded", "invoicestatus"], {
      query,
      concernTokens: ["REFUNDED"],
    }, scope);

    const before = taskContractLedgerSnapshotForTest(root, scope)?.obligations ?? [];
    expect(before.some((entry) => entry.target === "REFUNDED" && entry.polarity === "edit")).toBe(false);
    const evidenceBefore = before.find((entry) => entry.kind === "concern-token" && entry.target === "REFUNDED");
    expect(evidenceBefore?.polarity).toBe("evidence");
    expect(evidenceBefore?.proof).toBeUndefined();

    recordAuthoritativeAbsentConcerns(root, ["REFUNDED"], scope);

    const after = taskContractLedgerSnapshotForTest(root, scope)?.obligations ?? [];
    // The pre-existing evidence-polarity obligation keeps its own proof type,
    // untouched by the new edit-polarity twin — purely additive, so every
    // pre-wave assertion about this exact shape (sequenceCorpus I1/I3's
    // absence-consumed wire behavior) still holds unchanged.
    const evidenceAfter = after.find((entry) => entry.kind === "concern-token" && entry.target === "REFUNDED" && entry.polarity === "evidence");
    expect(evidenceAfter?.proof).toEqual({ type: "authoritative-absent", witness: "REFUNDED" });
    // The NEW edit-polarity obligation: minted with a prescribed-next origin
    // (it exists only because a prescribed find's result revealed it) and
    // discharged in the same step — an edit requirement that is already known
    // to be true needs no further evidence call to close.
    const editAfter = after.find((entry) => entry.kind === "concern-token" && entry.target === "REFUNDED" && entry.polarity === "edit");
    expect(editAfter).toMatchObject({
      kind: "concern-token",
      target: "REFUNDED",
      polarity: "edit",
      origin: "prescribed-next",
      proof: { type: "authoritative-absent", witness: "REFUNDED" },
    });
    // Both twins carry a proof: nothing about REFUNDED is left open on the
    // ledger, so a subsequent pack for this task/lane has an edit frontier to
    // advance to rather than a standing, permanently-unresolvable requirement.
    expect(after.filter((entry) => entry.target === "REFUNDED").every((entry) => entry.proof !== undefined)).toBe(true);
  });

  it("discloses rather than throws when evidence expansion overruns the ledger bound", () => {
    const root = `/tmp/tl-contract-capacity-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const scope: TaskContractScope = { lane: "capacity", taskHandle: "task-1" };
    recordTaskContract(root, ["invoice", "total"], { query: "invoice total", requiredRoles: ["domain"] }, scope);
    const targets = Array.from({ length: MAX_LEDGER_OBLIGATIONS * 2 }, (_, index) => `callee-${index}`);

    expect(() => recordEvidenceExpansion(root, targets, [], scope)).not.toThrow();
    const snapshot = taskContractLedgerSnapshotForTest(root, scope);
    expect(snapshot?.obligations.length).toBeLessThanOrEqual(MAX_LEDGER_OBLIGATIONS + 1);
    expect(snapshot?.obligations).toContainEqual(expect.objectContaining({
      ...CAPACITY_OBLIGATION,
      proof: expect.objectContaining({ type: "explicit-gap" }),
    }));
  });

  it("expires durable task-contract and lane-index state after the named TTL", () => {
    vi.useFakeTimers();
    const root = `/tmp/tl-contract-ttl-${Date.now()}-${Math.random()}`;
    roots.push(root);
    const scope: TaskContractScope = { lane: "ttl", taskHandle: "task" };
    recordTaskContract(root, ["status", "report"], { query: "status report", requiredRoles: ["domain"] }, scope);
    vi.advanceTimersByTime(TASK_CONTRACT_STATE_TTL_MS + 1);
    resetTaskContractStoreForTest();
    resetStateStoresForTests();
    expect(taskContractLedgerSnapshotForTest(root, scope)).toBeUndefined();
    vi.useRealTimers();
  });
});
