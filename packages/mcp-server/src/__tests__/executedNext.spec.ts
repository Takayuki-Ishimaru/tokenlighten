import { beforeEach, describe, expect, it } from "vitest";
import {
  clearExecutedNextForLane,
  clearExecutedNextForWorkspace,
  executedNextRecordForTest,
  hasExecutedNext,
  MAX_EXECUTED_NEXT_FINGERPRINTS_PER_LEDGER,
  MAX_EXECUTED_NEXT_LEDGERS,
  nextFingerprint,
  recordExecutedNext,
  resetPackServeLogForTest,
} from "../util/packServeLog.js";

describe("executed next result consumption", () => {
  beforeEach(resetPackServeLogForTest);
  it("binds read and every search action to epoch and result digest, including empty results", () => {
    const workspace = "/workspace";
    const lane = "a3";
    for (const [tool, args] of [
      ["read_file", { mode: "slice", handle: "h1", taskEpoch: "epoch-1" }],
      ["search_files", { action: "find", query: "absent", taskEpoch: "epoch-1" }],
      ["search_files", { action: "references", query: "none", taskEpoch: "epoch-1" }],
      ["search_files", { action: "tree", path: "src", taskEpoch: "epoch-1" }],
    ] as const) {
      expect(recordExecutedNext(workspace, lane, tool, args, "sha256:empty-result")).toBe(false);
      expect(hasExecutedNext(workspace, lane, tool, args)).toBe(true);
      expect(executedNextRecordForTest(workspace, lane, tool, args)).toEqual({ taskEpoch: "epoch-1", resultDigest: "sha256:empty-result" });
    }
  });

  // P1-c(iii): action lives on its own fingerprint tuple slot now, not folded
  // into the sorted-args blob — renaming/reordering an UNRELATED argument must
  // not change whether two calls that share the same (tool, action) and the
  // same remaining args are considered the same fingerprint.
  it("keys the fingerprint on (tool, action, args) as a shape-independent triple", () => {
    const sameShapeReordered = nextFingerprint("search_files", { query: "REFUNDED", action: "find" });
    const sameShapeCanonicalOrder = nextFingerprint("search_files", { action: "find", query: "REFUNDED" });
    expect(sameShapeReordered).toBe(sameShapeCanonicalOrder);
    // A different action with the identical remaining args is NOT the same call.
    const differentAction = nextFingerprint("search_files", { action: "references", query: "REFUNDED" });
    expect(differentAction).not.toBe(sameShapeCanonicalOrder);
    // No action at all (read_file's ordinary shape) stays distinguishable from
    // an action-bearing call on the same tool.
    const noAction = nextFingerprint("search_files", { query: "REFUNDED" });
    expect(noAction).not.toBe(sameShapeCanonicalOrder);
  });

  it("unifies legacy producer calls with their canonical wire forms", () => {
    const equivalentPairs: Array<{
      tool: string;
      legacy: Record<string, unknown>;
      canonical: Record<string, unknown>;
    }> = [
      {
        tool: "search_files",
        legacy: { action: "find", query: "find" },
        canonical: { action: "find", queries: ["find"] },
      },
      {
        tool: "read_file",
        legacy: {
          mode: "task_pack",
          query: "Find all enum variants that represent REFUNDED.",
          surfaceRoles: ["contract"],
        },
        canonical: {
          query: "Find all enum variants that represent REFUNDED.",
          scope: { surfaceRoles: ["contract"] },
        },
      },
      {
        tool: "read_file",
        legacy: { mode: "slice", handle: "h-router", range: "1-2" },
        canonical: {
          targets: [{ handle: "h-router", range: "1-2" }],
          content: "auto",
        },
      },
    ];

    for (const { tool, legacy, canonical } of equivalentPairs) {
      expect(nextFingerprint(tool, legacy)).toBe(nextFingerprint(tool, canonical));
      expect(recordExecutedNext("/workspace-canonical", "default", tool, canonical)).toBe(false);
      expect(hasExecutedNext("/workspace-canonical", "default", tool, legacy)).toBe(true);
    }
  });

  // P1-c(i): the real defect this closes — a stale fingerprint from an
  // EARLIER task on this lane must not permanently suppress an unrelated
  // LATER task's first, legitimate attempt at the identical call shape.
  // `taskEpoch:"new"` is the epoch boundary; readCodeTaskPack.ts's
  // `clearPackDedupeForWorkspace` calls clearExecutedNextForLane there,
  // exactly like it already does for taskContractStore's sibling ledger.
  it("forgets a lane's executed-next fingerprints at a taskEpoch:\"new\" boundary, leaving other lanes untouched", () => {
    const workspace = "/workspace-epoch";
    const call = { action: "find", query: "REFUNDED" } as const;
    expect(recordExecutedNext(workspace, "alpha", "search_files", call)).toBe(false);
    expect(recordExecutedNext(workspace, "beta", "search_files", call)).toBe(false);
    expect(hasExecutedNext(workspace, "alpha", "search_files", call)).toBe(true);
    expect(hasExecutedNext(workspace, "beta", "search_files", call)).toBe(true);

    clearExecutedNextForLane(workspace, "alpha");

    // Task A's fingerprint is gone: a later, unrelated task on the SAME lane
    // gets a genuine first attempt at the identical call shape, not a
    // permanent "already ran this" suppression.
    expect(hasExecutedNext(workspace, "alpha", "search_files", call)).toBe(false);
    // A sibling lane that never hit the epoch boundary is untouched.
    expect(hasExecutedNext(workspace, "beta", "search_files", call)).toBe(true);
    expect(recordExecutedNext(workspace, "alpha", "search_files", call)).toBe(false);
  });

  it("forgets every lane for a workspace via the legacy no-lane clear path", () => {
    const workspace = "/workspace-legacy-clear";
    const other = "/workspace-unrelated";
    const call = { action: "find", query: "REFUNDED" } as const;
    recordExecutedNext(workspace, "alpha", "search_files", call);
    recordExecutedNext(workspace, "beta", "search_files", call);
    recordExecutedNext(other, "alpha", "search_files", call);

    clearExecutedNextForWorkspace(workspace);

    expect(hasExecutedNext(workspace, "alpha", "search_files", call)).toBe(false);
    expect(hasExecutedNext(workspace, "beta", "search_files", call)).toBe(false);
    // A different workspace's ledger is a different partition entirely.
    expect(hasExecutedNext(other, "alpha", "search_files", call)).toBe(true);
  });

  // P1-c(ii): named bound + LRU on the PER-LANE fingerprint set — a task that
  // issues far more than the bound's worth of distinct calls must not grow
  // this ledger unboundedly; the OLDEST fingerprint is evicted first.
  it("caps fingerprints per lane and evicts the oldest first", () => {
    const workspace = "/workspace-fingerprint-cap";
    const lane = "cap-lane";
    for (let index = 0; index <= MAX_EXECUTED_NEXT_FINGERPRINTS_PER_LEDGER; index += 1) {
      recordExecutedNext(workspace, lane, "search_files", { action: "find", query: `token-${index}` });
    }
    expect(hasExecutedNext(workspace, lane, "search_files", { action: "find", query: "token-0" })).toBe(false);
    expect(hasExecutedNext(
      workspace, lane, "search_files", { action: "find", query: `token-${MAX_EXECUTED_NEXT_FINGERPRINTS_PER_LEDGER}` },
    )).toBe(true);
  });

  // P1-c(ii): named bound + LRU on the OUTER (workspace,lane) ledger map —
  // a long-running server touching far more than the bound's worth of
  // distinct lanes must not grow this store unboundedly either.
  it("caps the number of distinct (workspace,lane) ledgers and evicts the oldest first", () => {
    const call = { action: "find", query: "REFUNDED" } as const;
    for (let index = 0; index <= MAX_EXECUTED_NEXT_LEDGERS; index += 1) {
      recordExecutedNext("/workspace-ledger-cap", `lane-${index}`, "search_files", call);
    }
    expect(hasExecutedNext("/workspace-ledger-cap", "lane-0", "search_files", call)).toBe(false);
    expect(hasExecutedNext("/workspace-ledger-cap", `lane-${MAX_EXECUTED_NEXT_LEDGERS}`, "search_files", call)).toBe(true);
  });
});
