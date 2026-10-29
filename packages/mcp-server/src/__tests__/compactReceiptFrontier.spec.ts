import { afterEach, describe, expect, it } from "vitest";
import type { TaskExecutionContract } from "@tokenlighten/types";
import { handleTable, shaOfText } from "../util/handles.js";
import {
  bindReceiptExecutionAddresses, getExecutionFence, guardExecutionEdit,
  recordExecutionContract, recordServedRange, recordWithheldEditAddresses,
  resetAll, runWithSessionLane, type ReceiptExecutionAddress,
} from "../state/session.js";

const root = "/workspace/receipt-frontier";
const query = "fix the pricing boundary";
const fileSha = shaOfText("old\nline two\nline three\n");

function fixture() {
  const entry = handleTable.upsert({
    kind: "range", workspaceRoot: root, path: "src/pricing.py", range: "1-3", sha: fileSha,
  });
  const contract: TaskExecutionContract = {
    version: 1, state: "ready", readiness: "edit-ready", discovery_complete: true,
    next_action: "edit", max_additional_discovery_calls: 0, reason: "verified receipt",
    readiness_certificate: {
      version: 1, id: "receipt-proof", task_fingerprint: "pricing-task", profile: "generic",
      obligations: [{ id: "surface-content", kind: "surface-content", status: "proved", required: true }],
      evidence_handles: [entry.id], action_frontier: [entry.id],
    },
    typestate: { phase: "prepared", certificate_id: "receipt-proof", allowed_actions: ["edit", "challenge"], challenge_required_for: ["read", "search"] },
  };
  const address: ReceiptExecutionAddress = {
    handle: entry.id, path: entry.path!, range: entry.range!, fileSha, totalLines: 3,
    handleIdentity: { ...entry },
  };
  recordServedRange(root, address.path, fileSha, 1, 3, 3);
  return { entry, contract, address };
}

function edit(target: Record<string, unknown>) {
  return guardExecutionEdit(root, { edits: [{ ...target, search: "old", replace: "new", precondition: "unique-match" }] });
}

afterEach(() => { resetAll(); handleTable.reset(); });

describe("compact receipt frontier address binding", () => {
  it("restores only a certified write handle's paired path without changing the compact proof or frontier", () => {
    const { contract, address } = fixture();
    const before = JSON.stringify(contract);
    bindReceiptExecutionAddresses(root, contract, [address]);
    // The read-side postprocessor shallow-copies the contract.
    recordExecutionContract(root, query, { ...contract });
    expect(JSON.stringify(contract)).toBe(before);
    expect(getExecutionFence(root)).toMatchObject({
      actionFrontier: [address.handle], actionPaths: [address.path],
      actionTargetPairs: [{ handle: address.handle, path: address.path }],
    });
    expect(edit({ path: address.path })).toEqual({ allowed: true });
    expect(edit({ path: "src/never-certified.py" }).allowed).toBe(false);
  });

  it("does not promote an auxiliary handle or its path into the write frontier", () => {
    const { contract, address } = fixture();
    const auxiliary = handleTable.upsert({ kind: "range", workspaceRoot: root, path: "src/context.py", range: "1-3", sha: fileSha });
    recordServedRange(root, auxiliary.path!, fileSha, 1, 3, 3);
    bindReceiptExecutionAddresses(root, contract, [address, {
      ...address, handle: auxiliary.id, path: auxiliary.path!, handleIdentity: { ...auxiliary },
    }]);
    recordExecutionContract(root, query, contract);
    expect(getExecutionFence(root)?.actionPaths).toEqual([address.path]);
    expect(edit({ path: auxiliary.path }).allowed).toBe(false);
    expect(edit({ handle: auxiliary.id }).allowed).toBe(false);
  });

  it.each([
    ["other path", (a: ReceiptExecutionAddress) => { a.path = "src/other.py"; }],
    ["different range", (a: ReceiptExecutionAddress) => { a.range = "2-3"; }],
    ["range beyond EOF", (a: ReceiptExecutionAddress) => { a.totalLines = 2; }],
    ["different file version", (a: ReceiptExecutionAddress) => { a.fileSha = shaOfText("new version"); }],
    ["different handle version", (a: ReceiptExecutionAddress) => { a.handleIdentity = { ...a.handleIdentity, sha: "old-slice-sha" }; }],
    ["different capability generation", (a: ReceiptExecutionAddress) => { a.handleIdentity = { ...a.handleIdentity, createdAt: -1 }; }],
    ["foreign workspace", (a: ReceiptExecutionAddress) => { a.handleIdentity = { ...a.handleIdentity, workspaceRoot: "/workspace/foreign" }; }],
  ] as const)("does not recover a path from %s", (_name, mutate) => {
    const { contract, address } = fixture();
    mutate(address);
    bindReceiptExecutionAddresses(root, contract, [address]);
    recordExecutionContract(root, query, contract);
    expect(getExecutionFence(root)?.actionPaths).toEqual([]);
    expect(edit({ path: "src/pricing.py" }).allowed).toBe(false);
  });

  it("revalidates the live handle and current served version at installation", () => {
    const { contract, address, entry } = fixture();
    bindReceiptExecutionAddresses(root, contract, [address]);
    entry.sha = "changed-after-binding";
    recordExecutionContract(root, query, contract);
    expect(edit({ path: address.path }).allowed).toBe(false);
    entry.sha = address.handleIdentity.sha;
    recordServedRange(root, address.path, shaOfText("new disk bytes"), 1, 3, 3);
    recordExecutionContract(root, query, contract);
    expect(edit({ path: address.path }).allowed).toBe(false);
  });

  it("does not recover from an unknown handle or an unserved subrange", () => {
    const { contract, address } = fixture();
    bindReceiptExecutionAddresses(root, contract, [address]);
    handleTable.reset();
    recordExecutionContract(root, query, contract);
    expect(edit({ path: address.path }).allowed).toBe(false);
    resetAll();
    const next = fixture();
    resetAll();
    recordServedRange(root, next.address.path, fileSha, 1, 1, 3);
    bindReceiptExecutionAddresses(root, next.contract, [next.address]);
    recordExecutionContract(root, query, next.contract);
    expect(edit({ path: next.address.path }).allowed).toBe(false);
  });

  it("keeps the withheld-address gate even when a receipt has a matching address", () => {
    const { contract, address } = fixture();
    recordWithheldEditAddresses(root, { handles: [address.handle], paths: [address.path] });
    bindReceiptExecutionAddresses(root, contract, [address]);
    recordExecutionContract(root, query, contract);
    expect(getExecutionFence(root)?.actionPaths).toEqual([]);
    expect(edit({ path: address.path }).allowed).toBe(false);
    expect(edit({ handle: address.handle }).allowed).toBe(false);
  });

  it("binds to the exact certificate object and never a copied id", () => {
    const { contract, address } = fixture();
    bindReceiptExecutionAddresses(root, contract, [address]);
    recordExecutionContract(root, query, structuredClone(contract));
    expect(edit({ path: address.path }).allowed).toBe(false);
  });

  it("cannot reuse address metadata after its certificate identity changes", () => {
    const { contract, address } = fixture();
    bindReceiptExecutionAddresses(root, contract, [address]);
    contract.readiness_certificate!.id = "another-proof";
    recordExecutionContract(root, query, contract);
    expect(edit({ path: address.path }).allowed).toBe(false);
  });

  it("cannot reuse old binding after the session-reset path", () => {
    const { contract, address } = fixture();
    bindReceiptExecutionAddresses(root, contract, [address]);
    resetAll(); // testing/sessionReset.ts calls this same resetSessions hook.
    recordServedRange(root, address.path, fileSha, 1, 3, 3);
    recordExecutionContract(root, query, contract);
    expect(edit({ path: address.path }).allowed).toBe(false);
  });

  it("cannot transfer a binding to another lane", () => {
    const { contract, address } = fixture();
    bindReceiptExecutionAddresses(root, contract, [address]);
    runWithSessionLane("other", () => {
      recordServedRange(root, address.path, fileSha, 1, 3, 3);
      recordExecutionContract(root, query, contract);
      expect(edit({ path: address.path }).allowed).toBe(false);
    });
  });
});
