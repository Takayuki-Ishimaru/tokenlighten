/**
 * explorationBudget.spec.ts — 2026-10-29 first-hop field report.
 *
 * Following `next` verbatim on express's "How does res.redirect work?" paged
 * the 3,928-line History.md for ten hops (129 KB) without ever serving
 * res.redirect. These pin the pieces that bound that, in isolation:
 *   - the per-task exploration spend (`packServeLog.ts`), lane- and epoch-scoped;
 *   - `docZoomAllowed` and the three seats that use it (the required-answer
 *     document zoom, the served-document zoom, the candidate-list re-pack);
 *   - the exit fence re-deriving a decision the stamp invalidated;
 *   - `stampExplorationState`.
 * `anchor_closure` is stamped by another producer; these tests construct
 * results with it set.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCanonicalTaskDecision,
  canonicalTaskDecisionInvariantViolations,
  deriveCanonicalTaskDecision,
  discoveryBundleNext,
  docZoomAllowed,
  enforceCanonicalTaskDecisionAtExit,
  explorationBudgetOf,
  queryNamedPathsOf,
  stampExplorationState,
} from "../features/task-pack/canonicalDecision.js";
import type { TaskPackResult } from "../features/task-pack/model.js";
import {
  TASK_EXPLORATION_MAX_BYTES,
  TASK_EXPLORATION_MAX_HOPS,
  explorationBudgetExhausted,
} from "../util/continuation.js";
import { runWithSessionLane } from "../util/laneKey.js";
import {
  clearServedSurfaces,
  recordServedSurfaces,
  recordTaskExploration,
  resetPackServeLogForTest,
  taskExplorationSpend,
} from "../util/packServeLog.js";

const WS = "/ws/exploration-budget";

beforeEach(resetPackServeLogForTest);
afterEach(resetPackServeLogForTest);

type Surface = Record<string, unknown>;

function codeSurface(overrides: Surface = {}): Surface {
  return {
    role: "domain",
    handle: "h-code",
    path: "lib/response.js",
    range: "1-40",
    required: true,
    code: "res.redirect = function redirect(url) {\n  return url;\n};\n",
    ...overrides,
  };
}

function docSurface(path: string, handle: string, overrides: Surface = {}): Surface {
  return {
    role: "docs",
    handle,
    path,
    range: "1-40",
    required: true,
    code: "# notes\n",
    remaining_ranges: ["41-80"],
    ...overrides,
  };
}

function certifiedContract(): NonNullable<TaskPackResult["execution_contract"]> {
  return {
    version: 1,
    state: "ready",
    readiness: "answer-ready",
    discovery_complete: true,
    next_action: "answer",
    max_additional_discovery_calls: 0,
    reason: "ready",
    readiness_certificate: { id: "ready-answer" },
    typestate: {
      phase: "prepared",
      certificate_id: "ready-answer",
      allowed_actions: ["answer", "challenge"],
      challenge_required_for: ["read", "search"],
    },
    semantic_closure: {
      version: 1,
      state: "closed",
      closure_id: "ready-answer",
      obligations_total: 1,
      obligations_proved: 1,
      unresolved: [],
    },
  } as unknown as NonNullable<TaskPackResult["execution_contract"]>;
}

function openContract(overrides: Record<string, unknown> = {}): NonNullable<TaskPackResult["execution_contract"]> {
  return {
    version: 1,
    state: "needs-followup",
    readiness: "needs-followup",
    discovery_complete: false,
    next_action: "followup",
    max_additional_discovery_calls: 1,
    reason: "missing served evidence",
    typestate: { phase: "discovery", allowed_actions: ["read", "search"], challenge_required_for: [] },
    semantic_closure: {
      version: 1,
      state: "open",
      closure_id: "open-test",
      obligations_total: 1,
      obligations_proved: 0,
      unresolved: ["surface-content"],
    },
    ...overrides,
  } as unknown as NonNullable<TaskPackResult["execution_contract"]>;
}

function pack(overrides: Record<string, unknown>): TaskPackResult {
  return {
    mode: "task_pack",
    coverage: "focused",
    coverage_reason: "single-site",
    surfaces: [],
    missing: [],
    route: { action: "answer_from_handles", reason: "answer from handles", max_additional_tl_calls: 1 },
    ...overrides,
  } as unknown as TaskPackResult;
}

describe("per-task exploration spend (packServeLog)", () => {
  it("starts empty and accumulates read/search responses", () => {
    expect(taskExplorationSpend(WS)).toEqual({ hops: 0, bytes: 0 });
    recordTaskExploration(WS, 1000);
    recordTaskExploration(WS, 2500);
    expect(taskExplorationSpend(WS)).toEqual({ hops: 2, bytes: 3500 });
  });

  it("ignores nonsense and keeps workspaces apart", () => {
    recordTaskExploration(WS, -5);
    recordTaskExploration(WS, Number.NaN);
    recordTaskExploration("", 10);
    expect(taskExplorationSpend(WS)).toEqual({ hops: 0, bytes: 0 });
    recordTaskExploration(WS, 10);
    expect(taskExplorationSpend("/ws/other")).toEqual({ hops: 0, bytes: 0 });
  });

  it("is lane-scoped", () => {
    runWithSessionLane("lane-a", () => recordTaskExploration(WS, 400));
    runWithSessionLane("lane-b", () => recordTaskExploration(WS, 100));
    expect(taskExplorationSpend(WS)).toEqual({ hops: 0, bytes: 0 });
    expect(runWithSessionLane("lane-a", () => taskExplorationSpend(WS))).toEqual({ hops: 1, bytes: 400 });
    expect(taskExplorationSpend(WS, "lane-b")).toEqual({ hops: 1, bytes: 100 });
  });

  it("resets when the task epoch flips, both explicitly and by query-token heuristic", () => {
    recordTaskExploration(WS, 9000);
    clearServedSurfaces(WS);
    expect(taskExplorationSpend(WS)).toEqual({ hops: 0, bytes: 0 });

    recordServedSurfaces(WS, WS, [], ["redirect", "express"]);
    recordTaskExploration(WS, 9000);
    expect(taskExplorationSpend(WS).hops).toBe(1);
    // Same task (shared token): spend survives.
    recordServedSurfaces(WS, WS, [], ["redirect", "status"]);
    expect(taskExplorationSpend(WS).hops).toBe(1);
    // A different task (no shared token): fresh budget.
    recordServedSurfaces(WS, WS, [], ["completely", "different"]);
    expect(taskExplorationSpend(WS)).toEqual({ hops: 0, bytes: 0 });
  });

  it("exhausts on either the hop count or the byte count", () => {
    expect(explorationBudgetExhausted(TASK_EXPLORATION_MAX_HOPS - 1, TASK_EXPLORATION_MAX_BYTES - 1)).toBe(false);
    expect(explorationBudgetExhausted(TASK_EXPLORATION_MAX_HOPS, 0)).toBe(true);
    expect(explorationBudgetExhausted(0, TASK_EXPLORATION_MAX_BYTES)).toBe(true);
    expect(TASK_EXPLORATION_MAX_HOPS).toBe(6);
    expect(TASK_EXPLORATION_MAX_BYTES).toBe(40 * 1024);
  });
});

describe("stampExplorationState", () => {
  it("stamps the spend plus this pack's own size, and the surfaces the request names", () => {
    recordTaskExploration(WS, 5000);
    recordTaskExploration(WS, 6000);
    const result = pack({
      surfaces: [codeSurface(), docSurface("History.md", "h-hist"), docSurface("README.md", "h-readme")],
    });
    const before = JSON.stringify(result);
    stampExplorationState(result, WS, "what changed in History.md for 5.0");
    expect(explorationBudgetOf(result)).toMatchObject({ hops: 2, exhausted: false });
    expect(explorationBudgetOf(result)!.bytes).toBeGreaterThan(11000);
    expect(queryNamedPathsOf(result)).toEqual(["History.md"]);
    // The stamp is internal: it rides a `{...result}` copy, but adds no byte to
    // the serialized pack and no key a byte ceiling or an equality check sees.
    expect(JSON.stringify(result)).toBe(before);
    expect(explorationBudgetOf({ ...result })).toEqual(explorationBudgetOf(result));
    expect(result.exploration_budget).toBeUndefined();
  });

  it("flips exhausted on the 6th follow-up and re-stamping replaces a stale stamp", () => {
    for (let i = 0; i < TASK_EXPLORATION_MAX_HOPS - 1; i += 1) recordTaskExploration(WS, 100);
    const result = pack({ surfaces: [codeSurface()] });
    stampExplorationState(result, WS, "How does res.redirect work?");
    expect(explorationBudgetOf(result)?.exhausted).toBe(false);
    expect(queryNamedPathsOf(result)).toBeUndefined();
    recordTaskExploration(WS, 100);
    stampExplorationState(result, WS, "How does res.redirect work?");
    expect(explorationBudgetOf(result)).toMatchObject({ hops: TASK_EXPLORATION_MAX_HOPS, exhausted: true });
  });

  it("exhausts by bytes alone", () => {
    recordTaskExploration(WS, TASK_EXPLORATION_MAX_BYTES);
    const result = pack({ surfaces: [codeSurface()] });
    stampExplorationState(result, WS, "q");
    expect(explorationBudgetOf(result)).toMatchObject({ hops: 1, exhausted: true });
  });
});

describe("docZoomAllowed", () => {
  it("allows an ordinary document with no stamp at all", () => {
    expect(docZoomAllowed(pack({}), { path: "README.md" })).toBe(true);
  });

  it("(a) refuses an unnamed surface once every named anchor is proved by a definition", () => {
    const closed = pack({ anchor_closure: { satisfied: true, ids: ["identifier:res.redirect"] } });
    expect(docZoomAllowed(closed, { path: "README.md" })).toBe(false);
    expect(docZoomAllowed({ ...closed, query_named_paths: ["README.md"] } as TaskPackResult, { path: "README.md" })).toBe(true);
    const open = pack({ anchor_closure: { satisfied: false, ids: ["identifier:res.redirect"] } });
    expect(docZoomAllowed(open, { path: "README.md" })).toBe(true);
  });

  it("(b) refuses everything once the budget is exhausted, named or not", () => {
    const spent = pack({
      exploration_budget: { hops: 6, bytes: 100, exhausted: true },
      query_named_paths: ["README.md"],
    });
    expect(docZoomAllowed(spent, { path: "README.md" })).toBe(false);
    expect(docZoomAllowed(spent, { path: "lib/response.js" })).toBe(false);
  });

  it("(c) refuses an unnamed changelog or docs page, and allows it when the request names it", () => {
    const result = pack({});
    expect(docZoomAllowed(result, { path: "History.md" })).toBe(false);
    expect(docZoomAllowed(result, { path: "docs/guide.md" })).toBe(false);
    expect(docZoomAllowed({ ...result, query_named_paths: ["History.md"] } as TaskPackResult, { path: "History.md" })).toBe(true);
    expect(docZoomAllowed(result, { path: "History.md", why: "query-named-file" })).toBe(true);
    // A qref re-pack marks every candidate caller-supplied: that is not naming.
    expect(docZoomAllowed(result, { path: "History.md", why: "caller-supplied" })).toBe(false);
  });
});

describe("the required-answer document zoom seat (before the certificate gate)", () => {
  function certifiedPack(extra: Record<string, unknown>, doc = docSurface("README.md", "h-doc")): TaskPackResult {
    return pack({
      surfaces: [codeSurface(), doc],
      execution_contract: certifiedContract(),
      ...extra,
    });
  }

  it("baseline: a partial README still gets its one zoom before the answer", () => {
    expect(deriveCanonicalTaskDecision(certifiedPack({}))).toMatchObject({
      kind: "discover",
      next_call: { tool: "tl_read_file", arguments: { handle: "h-doc", range: "41-80" } },
    });
  });

  it("act-answer, no doc zoom, once the served definitions prove every named anchor", () => {
    const result = certifiedPack({ anchor_closure: { satisfied: true, ids: ["identifier:res.redirect"] } });
    expect(deriveCanonicalTaskDecision(result)).toMatchObject({ kind: "act-answer" });
  });

  it("act-answer, no doc zoom, once the exploration budget is exhausted", () => {
    const result = certifiedPack({ exploration_budget: { hops: 6, bytes: 9000, exhausted: true } });
    expect(deriveCanonicalTaskDecision(result)).toMatchObject({ kind: "act-answer" });
  });

  it("an unnamed CHANGELOG.md with remaining ranges is not zoomed on a behaviour question", () => {
    const result = certifiedPack({}, docSurface("CHANGELOG.md", "h-log"));
    expect(deriveCanonicalTaskDecision(result)).toMatchObject({ kind: "act-answer" });
  });

  it("a request that names History.md still pages it", () => {
    const result = certifiedPack(
      { query_named_paths: ["History.md"] },
      docSurface("History.md", "h-hist", { remaining_ranges: ["101-200"] }),
    );
    expect(deriveCanonicalTaskDecision(result)).toMatchObject({
      kind: "discover",
      next_call: { tool: "tl_read_file", arguments: { handle: "h-hist", range: "101-200" } },
    });
  });

  it("the repair trigger fires on a prepared certificate only while the zoom is still allowed", () => {
    const allowed = certifiedPack({});
    applyCanonicalTaskDecision(allowed);
    expect(allowed.execution_contract?.typestate.phase).toBe("discovery");
    const closed = certifiedPack({ anchor_closure: { satisfied: true, ids: ["identifier:res.redirect"] } });
    applyCanonicalTaskDecision(closed);
    expect(closed.execution_contract?.typestate.phase).toBe("prepared");
    expect(closed.route?.action).toBe("answer_from_handles");
    expect(canonicalTaskDecisionInvariantViolations(closed)).toEqual([]);
  });
});

describe("the served-document zoom seat (route budget 0, no certificate)", () => {
  function uncertified(surfaces: Surface[], extra: Record<string, unknown> = {}): TaskPackResult {
    return pack({
      surfaces,
      route: { action: "answer_from_handles", reason: "stale zero-budget route", max_additional_tl_calls: 0 },
      execution_contract: openContract(),
      ...extra,
    });
  }

  it("baseline: zooms the partial document", () => {
    expect(deriveCanonicalTaskDecision(uncertified([codeSurface(), docSurface("README.md", "h-doc")]))).toMatchObject({
      kind: "discover",
      next_call: { arguments: { handle: "h-doc", range: "41-80" } },
    });
  });

  it("falls through to await-input with no zoom for an unnamed changelog", () => {
    expect(deriveCanonicalTaskDecision(uncertified([codeSurface(), docSurface("History.md", "h-hist")]))).toEqual({
      kind: "await-input",
      reason: "missing served evidence",
    });
  });

  it("falls through to await-input once the budget is exhausted", () => {
    const result = uncertified(
      [codeSurface(), docSurface("README.md", "h-doc")],
      { exploration_budget: { hops: 6, bytes: 1, exhausted: true } },
    );
    expect(deriveCanonicalTaskDecision(result)).toMatchObject({ kind: "await-input" });
  });

  it("ranks a named changelog LAST, behind code and other documents", () => {
    const named = { query_named_paths: ["History.md"] };
    const both = uncertified([
      docSurface("History.md", "h-hist", { remaining_ranges: ["101-200"] }),
      docSurface("README.md", "h-readme"),
    ], named);
    expect(deriveCanonicalTaskDecision(both)).toMatchObject({ next_call: { arguments: { handle: "h-readme" } } });
    const codeAndLog = uncertified([
      docSurface("History.md", "h-hist", { remaining_ranges: ["101-200"] }),
      codeSurface({ handle: "h-code2", remaining_ranges: ["41-80"] }),
    ], named);
    expect(deriveCanonicalTaskDecision(codeAndLog)).toMatchObject({ next_call: { arguments: { handle: "h-code2" } } });
    const onlyLog = uncertified([docSurface("History.md", "h-hist", { remaining_ranges: ["101-200"] })], named);
    expect(deriveCanonicalTaskDecision(onlyLog)).toMatchObject({ next_call: { arguments: { handle: "h-hist", range: "101-200" } } });
  });

  it("does not smuggle a refused zoom back in through the producer's own next_call", () => {
    const refused = { tool: "tl_read_file", arguments: { handle: "h-hist", range: "41-80" } };
    const result = uncertified(
      [codeSurface(), docSurface("History.md", "h-hist")],
      { execution_contract: openContract({ next_call: refused }) },
    );
    expect(deriveCanonicalTaskDecision(result)).toMatchObject({ kind: "await-input" });
    // …while an unrelated producer next survives.
    const other = { tool: "tl_search_files", arguments: { action: "find", queries: ["redirect"] } };
    const kept = uncertified(
      [codeSurface(), docSurface("History.md", "h-hist")],
      { execution_contract: openContract({ next_call: other }) },
    );
    expect(deriveCanonicalTaskDecision(kept)).toMatchObject({ kind: "discover", next_call: other });
  });
});

describe("the candidate-list re-pack arm of discoveryBundleNext", () => {
  function candidates(extra: Record<string, unknown> = {}): TaskPackResult {
    return pack({
      qref: "q-click",
      coverage: "partial",
      coverage_reason: "candidate-list",
      surfaces: [
        { path: "src/click/core.py", handle: "h-core" },
        { path: "src/click/types.py", handle: "h-types" },
        { path: "CHANGES.rst", handle: "h-changes" },
      ],
      ...extra,
    });
  }

  it("baseline: re-packs every candidate except an unnamed changelog", () => {
    expect(discoveryBundleNext(candidates())?.arguments["paths"]).toEqual(["src/click/core.py", "src/click/types.py"]);
  });

  it("names the changelog when the request does", () => {
    expect(discoveryBundleNext(candidates({ query_named_paths: ["CHANGES.rst"] }))?.arguments["paths"])
      .toEqual(["src/click/core.py", "src/click/types.py", "CHANGES.rst"]);
  });

  it("proposes no re-pack once the named anchors are already proved by a served definition", () => {
    expect(discoveryBundleNext(candidates({ anchor_closure: { satisfied: true, ids: ["identifier:get_help_extra"] } })))
      .toBeUndefined();
  });

  it("proposes no re-pack once the exploration budget is exhausted", () => {
    expect(discoveryBundleNext(candidates({ exploration_budget: { hops: 7, bytes: 1, exhausted: true } }))).toBeUndefined();
  });
});

describe("the exit fence re-derives a decision the late stamp invalidated", () => {
  function discovering(path: string, handle: string): { result: TaskPackResult; zoom: { tool: string; arguments: Record<string, unknown> } } {
    const zoom = { tool: "tl_read_file", arguments: { handle, range: "41-80" } };
    const result = pack({
      surfaces: [codeSurface(), docSurface(path, handle)],
      route: { action: "inspect_handles", reason: "zoom", max_additional_tl_calls: 1 },
      next: zoom,
      continuation: { version: 1, stages: [{ execution: "sequential", calls: [zoom] }] },
      execution_contract: openContract({ next_call: zoom }),
    });
    return { result, zoom };
  }

  it("turns a discover whose next is a now-refused zoom into a disclosed stop once the stamp lands", () => {
    const { result, zoom } = discovering("README.md", "h-readme");
    // Before the stamp the in-build decision is coherent as it stands.
    expect(enforceCanonicalTaskDecisionAtExit(result).repaired).toBe(false);
    expect(result.execution_contract?.typestate.phase).toBe("discovery");
    expect(result.execution_contract?.next_call).toEqual(zoom);

    result.exploration_budget = { hops: 6, bytes: 50_000, exhausted: true };
    const fence = enforceCanonicalTaskDecisionAtExit(result);
    expect(fence.residual).toEqual([]);
    expect(result.execution_contract?.typestate.phase).toBe("awaiting-input");
    expect(result.execution_contract?.next_call).toBeUndefined();
    expect(result.next).toBeUndefined();
    expect(result.continuation).toBeUndefined();
    expect(canonicalTaskDecisionInvariantViolations(result)).toEqual([]);
  });

  it("cancels an older producer's History.md zoom even before any stamp exists", () => {
    const { result } = discovering("History.md", "h-hist");
    enforceCanonicalTaskDecisionAtExit(result);
    expect(result.execution_contract?.typestate.phase).toBe("awaiting-input");
    expect(result.next).toBeUndefined();
  });

  it("keeps the History.md zoom when the request names it", () => {
    const { result, zoom } = discovering("History.md", "h-hist");
    result.query_named_paths = ["History.md"];
    enforceCanonicalTaskDecisionAtExit(result);
    expect(result.execution_contract?.typestate.phase).toBe("discovery");
    expect(result.execution_contract?.next_call).toEqual(zoom);
  });

  it("leaves a zoom the stamped state still allows alone", () => {
    const { result, zoom } = discovering("README.md", "h-readme");
    result.exploration_budget = { hops: 1, bytes: 1000, exhausted: false };
    enforceCanonicalTaskDecisionAtExit(result);
    expect(result.execution_contract?.typestate.phase).toBe("discovery");
    expect(result.execution_contract?.next_call).toEqual(zoom);
  });
});
