import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskExecutionContract } from "@tokenlighten/types";

import {
  getExecutionFence,
  getSession,
  guardExecutionDiscovery,
  guardExecutionEdit,
  otherActiveRoots,
  recordExecutionContract,
  recordReadMode,
  recordServedEditAdmissibility,
  recordServedRange,
  recordWithheldEditAddresses,
  resetAll,
  runWithSessionLane,
  type WorkspaceSession,
} from "../util/session.js";
import {
  clearServedSurfaces,
  queryServedSurfaces,
  recordServedSurfaces,
  resetPackServeLogForTest,
} from "../util/packServeLog.js";
import {
  queryPriorPackObligations,
  recordPriorPackObligations,
  resetPriorPackStoreForTest,
  type PriorObligationRecord,
} from "../features/task-pack/priorPackStore.js";
import { clearPackDedupeForWorkspace } from "../features/task-pack/readCodeTaskPack.js";
import { buildVerificationManifest, resetVerificationKitDedupeForTest } from "../util/verificationPack.js";

/**
 * Concurrent-agent session lanes (2026-08-07).
 *
 * A stdio MCP connection carries no per-call client identity, so when an
 * orchestrator multiplexes several agents over ONE server process against the
 * SAME workspace root, every agent used to share one WorkspaceSession: agent
 * A's verifying fence refused agent B's calls by name, B's taskEpoch:"new"
 * silently destroyed A's verify obligation, and served-range receipts claimed
 * "already in your context" for bytes only the OTHER agent held. Isolation is
 * therefore explicit and cooperative: each agent passes its own fixed `lane`
 * value, and lanes share nothing. Omitting `lane` preserves the historical
 * single-session behavior byte-for-byte.
 */

/** Self-contained ready contract, one certificate per (id, handle, path). */
function laneCert(
  certificateId: string,
  handle: string,
  filePath: string,
): TaskExecutionContract {
  return {
    version: 1,
    state: "ready",
    readiness: "edit-ready",
    discovery_complete: true,
    next_action: "edit",
    max_additional_discovery_calls: 0,
    reason: "test proof",
    readiness_certificate: {
      version: 1,
      id: certificateId,
      task_fingerprint: `task-${certificateId}`,
      profile: "change_propagation",
      obligations: [{
        id: "behavior-body",
        kind: "behavior-body",
        status: "proved",
        required: true,
        evidence: [{ handle, path: filePath, range: "1-20", symbol: "fn" }],
        reason: "callable body served",
      }],
      evidence_handles: [handle],
      action_frontier: [handle],
      falsification: { version: 1, checked: ["callable-body"], counterexamples: [], unresolved: [] },
      risk: {
        policy: "selective-reject",
        estimated_false_ready_risk: 0.01,
        max_false_ready_risk: 0.05,
        decision: "accept",
        factors: [],
      },
    },
    typestate: {
      phase: "prepared",
      certificate_id: certificateId,
      allowed_actions: ["edit", "challenge"],
      challenge_required_for: ["read", "search"],
    },
    call_budget: {
      version: 2,
      policy: "expected-decision-change",
      normalized_turn_cost: 0.18,
      expected_decision_change: 0.01,
      expected_value: 0.011,
      decision_threshold: 0.18,
      discovery_allowed: false,
      terminal_action: "edit",
      reason: "low value",
    },
  };
}

afterEach(() => {
  resetAll();
  resetPackServeLogForTest();
  resetPriorPackStoreForTest();
});

/** callTool's MCP result, loosened: isError is present only on refusal branches. */
interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

describe("concurrent-agent session lanes: state partitioning", () => {
  it("getSession partitions by lane; the empty lane is the default session", () => {
    const ROOT = "/workspace/lanes-partition";
    const base = getSession(ROOT);
    const a = runWithSessionLane("agent-a", () => getSession(ROOT));
    const b = runWithSessionLane("agent-b", () => getSession(ROOT));

    expect(a).not.toBe(base);
    expect(b).not.toBe(base);
    expect(a).not.toBe(b);
    // Stable per lane, and "" is exactly the default session.
    expect(runWithSessionLane("agent-a", () => getSession(ROOT))).toBe(a);
    expect(runWithSessionLane("", () => getSession(ROOT))).toBe(base);

    runWithSessionLane("agent-a", () => recordReadMode(ROOT, "slice"));
    expect(a.readsByMode.get("slice")).toBe(1);
    expect(base.readsByMode.get("slice")).toBeUndefined();
    expect(b.readsByMode.get("slice")).toBeUndefined();
  });

  it("one lane's execution fence never gates another lane (the observed mixing incident)", () => {
    const ROOT = "/workspace/lanes-fence";
    runWithSessionLane("agent-b", () =>
      recordExecutionContract(ROOT, "wire pack builder output", laneCert("cert-b", "h-b", "src/pack_builder.ts")));
    expect(runWithSessionLane("agent-b", () => getExecutionFence(ROOT))?.certificateId).toBe("cert-b");

    // Agent A holds no fence: its discovery is unfenced and unrefused.
    expect(runWithSessionLane("agent-a", () => getExecutionFence(ROOT))).toBeUndefined();
    const decision = runWithSessionLane("agent-a", () =>
      guardExecutionDiscovery(ROOT, "read_file", { mode: "slice", handle: "h-a" }));
    expect(decision.allowed).toBe(true);

    // The lane-less default session is untouched by either agent.
    expect(getExecutionFence(ROOT)).toBeUndefined();
  });

  it("taskEpoch:new resets only its own lane, never another agent's obligations", () => {
    const ROOT = "/workspace/lanes-epoch";
    runWithSessionLane("agent-b", () =>
      recordExecutionContract(ROOT, "task b", laneCert("cert-b2", "h-b2", "src/b2.ts")));

    const reset = runWithSessionLane("agent-a", () =>
      guardExecutionDiscovery(ROOT, "read_file", { taskEpoch: "new", query: "totally different task" }));
    expect(reset).toEqual({ allowed: true, resetForNewTask: true });

    expect(runWithSessionLane("agent-b", () => getExecutionFence(ROOT))?.certificateId).toBe("cert-b2");
  });

  it("one lane's replacement pack cannot displace another lane's certificate", () => {
    const ROOT = "/workspace/lanes-replace";
    runWithSessionLane("agent-b", () =>
      recordExecutionContract(ROOT, "task b", laneCert("cert-b3", "h-b3", "src/b3.ts")));
    runWithSessionLane("agent-a", () =>
      recordExecutionContract(ROOT, "task a", laneCert("cert-a3", "h-a3", "src/a3.ts")));

    expect(runWithSessionLane("agent-b", () => getExecutionFence(ROOT))?.certificateId).toBe("cert-b3");
    expect(runWithSessionLane("agent-a", () => getExecutionFence(ROOT))?.certificateId).toBe("cert-a3");
  });

  it("otherActiveRoots reports plain roots, deduped across lanes, never composite keys", () => {
    const ROOT_X = "/workspace/lanes-roots-x";
    const ROOT_Y = "/workspace/lanes-roots-y";
    runWithSessionLane("agent-a", () => getSession(ROOT_X));
    runWithSessionLane("agent-b", () => getSession(ROOT_X));
    getSession(ROOT_Y);

    expect(otherActiveRoots(ROOT_X)).toEqual([ROOT_Y]);
    // Two lanes of ROOT_X collapse to ONE root entry, and no key leaks a
    // lane marker into what callTool prints as cwd candidates.
    expect(otherActiveRoots(ROOT_Y)).toEqual([ROOT_X]);
  });
});

describe("concurrent-agent session lanes: callTool dispatch", () => {
  it("read_file with lane lands its session state in that lane only", async () => {
    // An arbitrary tmpdir is not an admissible cwd (root containment allows
    // only the pinned workspace / registered worktrees), so this exercises
    // the pinned root itself — exactly the shared-root topology the mixing
    // incident had.
    const resolved = realpathSync(process.cwd());

    const { callTool } = await import("../server.js");
    const result = await callTool("read_file", { path: "package.json", mode: "full", lane: "agent-a" }) as ToolResult;
    expect(result.isError, result.content[0]!.text).not.toBe(true);

    // Mode-agnostic session footprint: which counters a given read mode
    // updates is that mode's business — the lane pin is only that the call
    // left SOME footprint in its own lane and NONE in the default session.
    const footprint = (s: WorkspaceSession): number =>
      s.readsByMode.size + s.servedRangeLedger.size + s.fullExpansionsPerPath.size + s.readPaths.size;
    const laneSession = runWithSessionLane("agent-a", () => getSession(resolved));
    const defaultSession = getSession(resolved);
    expect(footprint(laneSession)).toBeGreaterThan(0);
    expect(footprint(defaultSession)).toBe(0);
  });

  it("edit_file accepts lane as a declared argument (never unknown-arguments)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "tl-lanes-"));
    writeFileSync(path.join(ws, "alpha.txt"), "hello lane\n");
    const resolved = realpathSync(ws);

    const { callTool } = await import("../server.js");
    const result = await callTool("edit_file", {
      path: "alpha.txt",
      search: "hello",
      replace: "goodbye",
      cwd: resolved,
      lane: "agent-a",
    }) as ToolResult;
    const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    // Write gating may refuse for its own reasons in this process; the pin is
    // only that a declared partition key is never "unknown".
    expect(body["reason"]).not.toBe("unknown-arguments");
  });

  it("a malformed lane is refused before it can fragment session state", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "tl-lanes-"));
    writeFileSync(path.join(ws, "alpha.txt"), "hello lane\n");
    const resolved = realpathSync(ws);

    const { callTool } = await import("../server.js");
    for (const badLane of [7, { agent: "a" }, "x".repeat(65)]) {
      const result = await callTool("read_file", { path: "alpha.txt", cwd: resolved, lane: badLane }) as ToolResult;
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect(body["code"]).toBe("invalid-lane");
    }
    // A refused partition key must leave no session behind under any lane.
    expect(getSession(resolved).readsByMode.size).toBe(0);
  });
});

/**
 * F-V13-3 (2026-08-30): lane isolation below the WorkspaceSession layer.
 *
 * Lanes shipped as a `WorkspaceSession` property, so only that one layer knew
 * whose call it was serving. The stores UNDER it — packServeLog's served
 * surfaces and priorPackStore's obligations — keyed on the workspace root
 * alone, and both feed `priorEpochActionFrontier`, which turns them into a
 * certificate's `action_frontier`. Two agents against one checkout therefore
 * minted each other's write permissions.
 *
 * These use REAL files under a tmpdir on purpose: `queryServedSurfaces`
 * revalidates every consulted entry by re-statting it, so a virtual path is
 * dropped as unreadable and every assertion below would pass vacuously
 * against an empty array.
 */
describe("F-V13-3: task-pack stores partition by lane", () => {
  function workspaceWith(...files: string[]): string {
    const ws = realpathSync(mkdtempSync(path.join(tmpdir(), "tl-lane-stores-")));
    for (const name of files) writeFileSync(path.join(ws, name), `// ${name}\n`);
    return ws;
  }

  const EPOCH = ["update", "pricing", "rules"];

  function obligation(id: string, filePath: string): PriorObligationRecord {
    return {
      id,
      path: filePath,
      role: "impl",
      kind: "behavior-body",
      action: "edit",
      required: true,
      open: true,
    };
  }

  it("served surfaces are per lane, and the lane-less key is byte-identical to before", () => {
    const ws = workspaceWith("a.ts", "b.ts", "c.ts");
    const served = (p: string) => [{ path: p, role: "impl", handle: `h-${p}` }];

    runWithSessionLane("canon-ledger", () => recordServedSurfaces(ws, ws, served("a.ts"), EPOCH));
    runWithSessionLane("canon-plan", () => recordServedSurfaces(ws, ws, served("b.ts"), EPOCH));
    // No lane at all: the historical shared session, keyed on the bare root.
    recordServedSurfaces(ws, ws, served("c.ts"), EPOCH);

    const paths = (lane: string) =>
      runWithSessionLane(lane, () => queryServedSurfaces(ws, ws, { epochTokens: EPOCH }))
        .map((entry) => entry.path);

    // The live incident: lane `canon-plan` was refused citing a frontier of
    // files only `canon-ledger` had served. Neither lane may see the other's.
    expect(paths("canon-ledger")).toEqual(["a.ts"]);
    expect(paths("canon-plan")).toEqual(["b.ts"]);
    expect(paths("")).toEqual(["c.ts"]);
  });

  it("prior-pack edit obligations are per lane", () => {
    const ws = workspaceWith("a.ts", "b.ts");

    runWithSessionLane("canon-ledger", () =>
      recordPriorPackObligations(ws, EPOCH, [obligation("ob-ledger", "a.ts")]));
    runWithSessionLane("canon-plan", () =>
      recordPriorPackObligations(ws, EPOCH, [obligation("ob-plan", "b.ts")]));

    const ids = (lane: string) =>
      runWithSessionLane(lane, () => queryPriorPackObligations(ws, EPOCH)).map((o) => o.id);

    expect(ids("canon-ledger")).toEqual(["ob-ledger"]);
    expect(ids("canon-plan")).toEqual(["ob-plan"]);
    // An obligation recorded in a lane never leaks into the default session,
    // where priorEpochActionFrontier would hand it to an unrelated caller.
    expect(ids("")).toEqual([]);
  });

  it("one lane's taskEpoch:new epoch boundary leaves every peer lane's state standing", () => {
    const ws = workspaceWith("a.ts", "b.ts");
    runWithSessionLane("canon-ledger", () => {
      recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "impl", handle: "h-a" }], EPOCH);
      recordPriorPackObligations(ws, EPOCH, [obligation("ob-ledger", "a.ts")]);
    });
    runWithSessionLane("canon-plan", () => {
      recordServedSurfaces(ws, ws, [{ path: "b.ts", role: "impl", handle: "h-b" }], EPOCH);
      recordPriorPackObligations(ws, EPOCH, [obligation("ob-plan", "b.ts")]);
    });

    // `canon-plan` declares a fresh task. Pre-fix this cleared the ONE shared
    // slot; the peer lane then wrote it straight back, which is why the live
    // `task.epoch:"new"` escape could not clear the stale certificate.
    runWithSessionLane("canon-plan", () => clearPackDedupeForWorkspace(ws, "canon-plan"));

    expect(
      runWithSessionLane("canon-ledger", () => queryServedSurfaces(ws, ws, { epochTokens: EPOCH }))
        .map((entry) => entry.path),
    ).toEqual(["a.ts"]);
    expect(
      runWithSessionLane("canon-ledger", () => queryPriorPackObligations(ws, EPOCH)).map((o) => o.id),
    ).toEqual(["ob-ledger"]);
    // The declaring lane's own obligations are the ones that go.
    expect(
      runWithSessionLane("canon-plan", () => queryPriorPackObligations(ws, EPOCH)),
    ).toEqual([]);
  });

  /**
   * FX-L (2026-09-03, ruling (r)): per-address byte residency is the new
   * permission input, so it inherits the lane contract or it becomes a
   * cross-agent authority leak in BOTH directions — lane A's withheld row
   * refusing lane B's certificate, or lane A's serve authorising lane B's
   * blind edit. It lives on WorkspaceSession, which `getSession` already
   * lane-scopes; this pins that it stays there.
   */
  it("FX-L: withheld/shipped byte residency is lane-scoped in both directions", () => {
    const ws = workspaceWith("a.ts", "b.ts");
    // Lane A: the file was EMITTED with no body (a capped pack).
    runWithSessionLane("canon-ledger", () =>
      recordWithheldEditAddresses(ws, { handles: ["h-a"], paths: ["a.ts"] }));
    // Lane B: the same file's bytes genuinely shipped.
    runWithSessionLane("canon-plan", () =>
      recordServedEditAdmissibility(ws, { handles: ["h-b"], paths: ["a.ts"] }));

    // Lane A's certificate over that address installs an EMPTY frontier and
    // records the recovery target; lane B's is unaffected by A's withholding.
    runWithSessionLane("canon-ledger", () =>
      recordExecutionContract(ws, "edit a.ts", laneCert("cert-a", "h-a", "a.ts")));
    runWithSessionLane("canon-plan", () =>
      recordExecutionContract(ws, "edit a.ts", laneCert("cert-b", "h-b", "a.ts")));

    expect(runWithSessionLane("canon-ledger", () => getExecutionFence(ws)))
      .toMatchObject({ actionFrontier: [], withheldTargets: [{ handle: "h-a", path: "a.ts" }] });
    expect(runWithSessionLane("canon-plan", () => getExecutionFence(ws)))
      .toMatchObject({ actionFrontier: ["h-b"], actionPaths: ["a.ts"] });
    expect(runWithSessionLane("canon-plan", () => getExecutionFence(ws))?.withheldTargets)
      .toBeUndefined();
  });

  it("clearServedSurfaces clears only the calling lane", () => {
    const ws = workspaceWith("a.ts", "b.ts");
    runWithSessionLane("canon-ledger", () =>
      recordServedSurfaces(ws, ws, [{ path: "a.ts", role: "impl", handle: "h-a" }], EPOCH));
    runWithSessionLane("canon-plan", () =>
      recordServedSurfaces(ws, ws, [{ path: "b.ts", role: "impl", handle: "h-b" }], EPOCH));

    runWithSessionLane("canon-plan", () => clearServedSurfaces(ws));

    expect(
      runWithSessionLane("canon-ledger", () => queryServedSurfaces(ws, ws, { epochTokens: EPOCH }))
        .map((entry) => entry.path),
    ).toEqual(["a.ts"]);
    expect(
      runWithSessionLane("canon-plan", () => queryServedSurfaces(ws, ws, { epochTokens: EPOCH })),
    ).toEqual([]);
  });

  /**
   * FX-M1/B3 (INV-B-3): `util/verificationPack.ts`'s `kitDedupeCache` is a
   * FOURTH module-level, workspace-keyed cache of this exact same shape
   * (`packServeLog.ts`, `priorPackStore.ts`, and `readCodeTaskPack.ts`'s
   * three task_pack caches were the first three named under F-V13-3) — it
   * was simply missed by that remediation pass because it predates
   * `laneKey.ts` itself by a month. Pinned here, alongside its siblings,
   * so this file stays the one place that enumerates every lane-scoped
   * cache in the codebase.
   */
  it("FX-M1/B3: the verification-kit consecutive-dedupe cache partitions by lane", () => {
    resetVerificationKitDedupeForTest();
    // Nested dirs, so a plain workspaceWith (flat filenames only) will not
    // do — matching verificationPack.spec.ts's own K3 fixture shape.
    const ws = realpathSync(mkdtempSync(path.join(tmpdir(), "tl-lane-kit-")));
    mkdirSync(path.join(ws, "src", "mode"), { recursive: true });
    mkdirSync(path.join(ws, "test"), { recursive: true });
    writeFileSync(path.join(ws, "src/mode/mode_manager.cpp"), "void request() {}\n");
    writeFileSync(
      path.join(ws, "test/test_mode_manager.cpp"),
      '#include "mode/mode_manager.hpp"\nvoid t() {}\n',
    );

    const build = () => buildVerificationManifest(ws, ["src/mode/mode_manager.cpp"], { dedupeConsecutive: true });
    const laneAFirst = runWithSessionLane("canon-ledger", build);
    expect(laneAFirst!.kit_unchanged).toBeUndefined();

    // `canon-plan`'s FIRST call in this workspace — must not collapse to
    // kit_unchanged purely because `canon-ledger`'s last kit (never seen by
    // `canon-plan`) fingerprints identically.
    const laneBFirst = runWithSessionLane("canon-plan", build);
    expect(
      laneBFirst!.kit_unchanged,
      "a lane's first-ever verification kit must never read kit_unchanged from another lane's history",
    ).toBeUndefined();
  });
});

/**
 * FX-P1 (INV-I-2, 2026-09-03) — THE WRITE HALF OF THE LANE CONTRACT.
 *
 * Every store above is lane-partitioned; handle-gated write authority was not.
 * `HandleEntry` carried no lane, so lane B — with zero reads in the workspace,
 * and therefore a lane-scoped session that correctly held no fence, no
 * admissible union and no residency — redeemed lane A's handle string and
 * overwrote content only lane A had ever been served (INV-I's
 * `p10_lane_isolation`, reconfirmed at write-time as `kind=edit.applied`).
 *
 * THE RULING: lanes ARE an isolation boundary for writes. Reads are NOT
 * restricted — a read is not write authority and it stages what it serves
 * under the READING lane, so a cross-lane zoom is how a lane earns its own
 * authority over the same bytes (asserted end-to-end in
 * `fxp1EditAdmissibilityPredicate.spec.ts`).
 *
 * WITHOUT THE FIX: the first case reports `{ allowed: true }`.
 */
describe("FX-P1 / INV-I-2: handle write authority is lane-scoped", () => {
  afterEach(() => resetAll());

  const root = "/workspace/fxp1-lane-handles";
  const mintedInA = (handle: string): string | undefined =>
    handle === "h-lane-a" ? "agent-A" : handle === "h-lane-b" ? "agent-B" : undefined;
  const pathOf = (handle: string): string | undefined =>
    handle === "h-lane-a" || handle === "h-lane-b" ? "src/shared.ts" : undefined;
  const editVia = (handle: string): Record<string, unknown> => ({
    edits: [{ handle, content: "// replaced\n" }],
  });

  it("lane B redeeming lane A's handle for a WRITE refuses, with an executable recovery and no false `capped` diagnosis", () => {
    const refused = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root, editVia("h-lane-a"), pathOf, { resolveHandleLane: mintedInA }));
    expect(
      refused.allowed,
      "lane B was never served src/shared.ts; possession of a peer lane's handle is not authority",
    ).toBe(false);
    if (refused.allowed !== false) return;
    expect(refused.refusal["reason"]).toBe("execution-typestate");
    expect(
      refused.refusal["cause"],
      "`capped` is the byte-budget diagnosis; a lane refusal must not borrow it",
    ).toBeUndefined();
    const next = refused.refusal["next_call"] as { tool: string; arguments: Record<string, unknown> };
    expect(next.tool, "not refuse-only: lane B is told how to earn the bytes").toBe("read_file");
    expect(next.arguments["targets"]).toEqual([{ path: "src/shared.ts" }]);
    expect(next.arguments["content"], "the re-read must BOOK what it serves").toBe("full");
  });

  it("a lane's OWN handle writes, and so does an unstamped (lane-less) one — positive evidence only", () => {
    expect(
      runWithSessionLane("agent-B", () =>
        guardExecutionEdit(root, editVia("h-lane-b"), pathOf, { resolveHandleLane: mintedInA })),
      "lane B's own handle is exactly the authority it earned",
    ).toEqual({ allowed: true });
    expect(
      runWithSessionLane("agent-B", () =>
        guardExecutionEdit(root, editVia("h-unstamped"), pathOf, { resolveHandleLane: mintedInA })),
      "an unknown/lane-less mint (including one rehydrated from a pre-FX-P1 store) has no "
      + "provenance to refuse on",
    ).toEqual({ allowed: true });
  });

  it("CONTROL: the lane-less session is unchanged — no lane is bound, no handle carries one", () => {
    expect(
      guardExecutionEdit(root, editVia("h-unstamped"), pathOf, { resolveHandleLane: () => undefined }),
    ).toEqual({ allowed: true });
  });

  it("round-18A finding 6, negative control: shipping a DIFFERENT path in the redeeming lane does not admit the foreign handle", () => {
    runWithSessionLane("agent-B", () => {
      recordServedEditAdmissibility(root, { paths: ["src/other.ts"] });
    });
    const refused = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root, editVia("h-lane-a"), pathOf, { resolveHandleLane: mintedInA }));
    expect(
      refused.allowed,
      "shipping an unrelated path must not launder authority over src/shared.ts",
    ).toBe(false);
  });
});

/**
 * FX-Q2 (ruling (w), round-19A, 2026-09-03) — THE FOREIGN-LANE EXCEPTION IS
 * RANGE-GRANULAR, NOT FILE-GRANULAR (REVOKES FX-Q1's exception above).
 *
 * MEASURED, live (`scratchpad/r19a/a1_range_foreign.mts`,
 * `a3_range_foreign_searchreplace.mts`, both SF-flag arms): lane A reads only
 * lines 500-510 of a 700-line file and mints a range-scoped handle; lane B,
 * having read only lines 1-10 of the SAME file (so it already held FX-Q1's
 * file-granular "shipped" residency), redeemed lane A's handle and
 * blind-overwrote lines 500-510 — bytes lane B never received — for both
 * `{handle,content}` and `{handle,search,replace}`. The suite above's own
 * "round-18A finding 6 / ruling (r)-(u-2)" test used to PIN this as intended
 * behavior (mark the path shipped via `recordServedEditAdmissibility`, expect
 * admission); ruling (w) retracts that pin and replaces it with the tests
 * below.
 *
 * THE FIX: the exception now asks the redeeming lane's own SETTLED
 * `servedRangeLedger` (the same per-address ledger `servedRangeReceipt`
 * answers same-lane receipts from) whether it covers the handle's own line
 * `range` in full — not merely whether SOME part of the file shipped. A
 * whole-file handle (no `range` on its table entry) needs whole-file
 * coverage. `recordServedRange` is the ledger's real writer (what an honest
 * `read_file` serve — including the cross-lane refusal's own `content:"full"`
 * recovery — actually calls), so these tests use it directly instead of the
 * coarser `recordServedEditAdmissibility` helper the retired test used.
 *
 * WITHOUT THE FIX (verified by temporarily reverting `guardExecutionEdit`'s
 * foreign-lane filter to the FX-Q1 `_editAddressResidency(...) === "shipped"`
 * check): the "does NOT admit … disjoint range" test below reports
 * `{allowed:true}` from a lane that read only lines 1-10, exactly reproducing
 * `a1_range_foreign.mts`'s live `edit.applied`.
 */
describe("FX-Q2 / ruling (w): foreign-lane handle admission is RANGE-granular", () => {
  afterEach(() => resetAll());

  const root2 = "/workspace/fxq2-range-handles";
  const mintedInA2 = (handle: string): string | undefined =>
    handle.startsWith("h-lane-a") ? "agent-A" : undefined;
  const pathOf2 = (): string | undefined => "src/big.ts";
  const rangeOf2 = (handle: string): string | undefined =>
    handle === "h-lane-a-range" ? "500-510" : undefined; // "h-lane-a-whole" -> undefined (whole-file)
  const editVia2 = (handle: string): Record<string, unknown> => ({
    edits: [{ handle, content: "// replaced\n" }],
  });
  const opts2 = { resolveHandleLane: mintedInA2, resolveHandleRange: rangeOf2 };

  it("does NOT admit a foreign RANGE handle merely because the redeeming lane shipped a DISJOINT range of the same file (the FX-Q1 exception is revoked)", () => {
    runWithSessionLane("agent-B", () => {
      // Lane B genuinely read lines 1-10 — real ledger bytes, not merely a
      // file-granular admissibility mark.
      recordServedRange(root2, "src/big.ts", "sha-big", 1, 10, 700);
    });
    const refused = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root2, editVia2("h-lane-a-range"), pathOf2, opts2));
    expect(
      refused.allowed,
      "lane B never received lines 500-510; its own unrelated 1-10 serve must not launder a "
      + "foreign handle naming a disjoint range",
    ).toBe(false);
    if (refused.allowed !== false) return;
    expect(refused.refusal["reason"]).toBe("execution-typestate");
  });

  it("admits a foreign RANGE handle once the redeeming lane's own ledger genuinely covers that EXACT range", () => {
    runWithSessionLane("agent-B", () => {
      recordServedRange(root2, "src/big.ts", "sha-big", 495, 520, 700);
    });
    const admitted = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root2, editVia2("h-lane-a-range"), pathOf2, opts2));
    expect(
      admitted,
      "lane B's own 495-520 serve fully covers the foreign handle's 500-510 — this is the same "
      + "authority an honest lane-B read of that span would have earned under its own handle",
    ).toEqual({ allowed: true });
  });

  it("a PARTIAL overlap is not enough — the redeeming lane's ledger must cover the handle's FULL range", () => {
    runWithSessionLane("agent-B", () => {
      recordServedRange(root2, "src/big.ts", "sha-big", 495, 505, 700); // covers 500-505, not 506-510
    });
    const refused = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root2, editVia2("h-lane-a-range"), pathOf2, opts2));
    expect(refused.allowed, "half of the requested range is not the whole of it").toBe(false);
  });

  it("a WHOLE-FILE foreign handle (no `range` on its entry) is refused after only a partial serve, even a large one", () => {
    runWithSessionLane("agent-B", () => {
      recordServedRange(root2, "src/big.ts", "sha-big", 1, 699, 700); // one line short of complete
    });
    const refused = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root2, editVia2("h-lane-a-whole"), pathOf2, opts2));
    expect(
      refused.allowed,
      "a whole-file handle names the WHOLE file; 699 of 700 lines is still not whole-file coverage",
    ).toBe(false);
  });

  it("a WHOLE-FILE foreign handle is admitted once the redeeming lane's ledger shows COMPLETE coverage", () => {
    runWithSessionLane("agent-B", () => {
      recordServedRange(root2, "src/big.ts", "sha-big", 1, 700, 700); // the whole file
    });
    const admitted = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root2, editVia2("h-lane-a-whole"), pathOf2, opts2));
    expect(
      admitted,
      "a real content:\"full\" serve (or a code_unchanged restatement of one) leaves nothing "
      + "unserved, which is exactly what a whole-file handle requires",
    ).toEqual({ allowed: true });
  });

  it("CONTROL: no ledger entry at all for the path refuses the foreign handle, same as before", () => {
    const refused = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root2, editVia2("h-lane-a-range"), pathOf2, opts2));
    expect(refused.allowed, "lane B has never touched this file").toBe(false);
  });
});

/**
 * FX-V1 (ruling (x), round-20A adversarial review finding 1, 2026-09-04) —
 * `_foreignHandleRangeCovered` MUST ALSO ACCEPT SHIPPED ∪ ELIDED.
 *
 * FX-Q2's own suite above never exercises a file `elideDocComments`
 * (`util/formatCompress.ts`) actually collapses anything in — every fixture
 * is `bigFileWorkspace`, plain `export const V<n> = <n>;` lines with zero
 * comments. Round-20A's live finding: for ANY file containing a 2+-line
 * doc-comment block, a whole-file foreign handle could never be redeemed —
 * not even by a lane that read the ENTIRE file itself — because the elided
 * lines never rode the wire and `recordServedRange` never booked them, so
 * whole-file `servedRangeReceipt` subsumption over `1..totalLines` was
 * permanently unreachable. The fix: `_stageElisionGap` (called from
 * `recordServedRange`) detects the gap between the caller's declared window
 * and each surviving shipped span and stages it into
 * `ServedRangeLedgerState.elided`; `_foreignHandleRangeCovered` (ONLY that
 * predicate — `servedRangeReceipt` stays elision-blind) now accepts
 * `spans ∪ elided` as covering the requested range.
 *
 * End-to-end (`callTool`, both write forms, `ranges[]` handles, both env
 * arms) and the fuller ledger-mechanics matrix (settle confirm/retract,
 * receipt-blindness, cross-window non-contamination) live in
 * `fxv1ElidedWindowForeignHandleCoverage.spec.ts`. This suite adds the ONE
 * case that belongs beside FX-Q2's own tests above: the fix benefits the
 * RANGE-scoped branch of the SAME predicate, not merely the whole-file one.
 */
describe("FX-V1 / ruling (x): whole-file AND range-scoped coverage extend to TL's own elided windows", () => {
  afterEach(() => resetAll());

  const root3 = "/workspace/fxv1-elision-lanes";
  const mintedInA3 = (handle: string): string | undefined => (handle.startsWith("h-a") ? "agent-A" : undefined);
  const pathOf3 = (): string | undefined => "src/tiny.ts";
  const editVia3 = (handle: string): Record<string, unknown> => ({ edits: [{ handle, content: "// replaced\n" }] });

  it("a WHOLE-FILE foreign handle admits on shipped(4-4) ∪ elided(1-3) — the r20a minimal 2-line-JSDoc shape", () => {
    runWithSessionLane("agent-B", () => {
      // The exact shape `readCodeSmallFile.ts`'s small_file serve (the
      // plain DEFAULT read mode) records for a 4-line file whose lines 1-3
      // are one elided JSDoc block: only line 4 ever reaches the wire.
      recordServedRange(root3, "src/tiny.ts", "sha-tiny", 4, 4, 4, { mode: "small_file", range: "1-4", call: 1 });
    });
    const admitted = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root3, editVia3("h-a-whole"), pathOf3, {
        resolveHandleLane: mintedInA3, resolveHandleRange: () => undefined,
      }));
    expect(admitted).toEqual({ allowed: true });
  });

  it("a RANGE-scoped foreign handle whose range straddles a genuinely-elided sub-block is admitted once shipped ∪ elided covers that EXACT range (not merely the whole file)", () => {
    runWithSessionLane("agent-B", () => {
      // `appendFresh`'s own real shape: ONE fresh window (8-16 of a 20-line
      // file) whose interior lines 11-14 are a single elided comment block —
      // two recordServedRange calls sharing one (call, range) pair.
      recordServedRange(root3, "src/mid.ts", "sha-mid", 8, 10, 20, { mode: "slice", range: "8-16", call: 5 });
      recordServedRange(root3, "src/mid.ts", "sha-mid", 15, 16, 20, { mode: "slice", range: "8-16", call: 5 });
    });
    const rangeOpts = {
      resolveHandleLane: mintedInA3,
      resolveHandleRange: (h: string): string | undefined => (h === "h-a-mid" ? "8-16" : undefined),
    };
    const admitted = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root3, { edits: [{ handle: "h-a-mid", content: "// replaced\n" }] }, () => "src/mid.ts", rangeOpts));
    expect(
      admitted,
      "shipped 8-10 + 15-16 plus the staged elision gap 11-14 together cover the handle's own "
      + "8-16 range — this is the RANGE branch of the same predicate the whole-file test above "
      + "exercises",
    ).toEqual({ allowed: true });

    // CONTROL: a foreign handle naming a WIDER range than what was actually
    // covered (17-16 -> 8-17, one line past the shipped+elided union) still
    // refuses — the fix does not silently widen coverage past its own union.
    const wideOpts = {
      resolveHandleLane: mintedInA3,
      resolveHandleRange: (h: string): string | undefined => (h === "h-a-wide" ? "8-17" : undefined),
    };
    const refusedWide = runWithSessionLane("agent-B", () =>
      guardExecutionEdit(root3, { edits: [{ handle: "h-a-wide", content: "// replaced\n" }] }, () => "src/mid.ts", wideOpts));
    expect(refusedWide.allowed, "line 17 was never shipped or elided by the 8-16 window").toBe(false);
  });
});
