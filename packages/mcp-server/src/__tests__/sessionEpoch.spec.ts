/**
 * sessionEpoch.spec.ts — unit tests for the task_pack CHECK-EPOCH model in
 * util/session.ts.
 *
 * The epoch model is the closure-wipe fix: a same-task follow-up pack (decided
 * by camelCase-aware token overlap) MERGES its checks into the active epoch —
 * union by id, KEEPING existing records even when the new pack omits them —
 * instead of replacing them wholesale (which wiped a still-open style check and
 * caused the live false_solved forensic). A genuinely-new task (zero overlap on a
 * non-empty query) REPLACES; a queryless/seeded pack NEVER replaces.
 *
 * Pure unit tests: they drive recordPackChecks/getPackChecks/tokenizeForEpoch
 * directly against the module-level session singleton (reset per test).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPackChecks,
  getPackChecks,
  recordClosureReport,
  tokenizeForEpoch,
  deriveCheckId,
  isVerifiableCheck,
  resetWorkspace,
  type PackCheckRecord,
} from "../util/session.js";

const WS = "/virtual/ws-epoch";

function rec(id: string, extra: Partial<PackCheckRecord> = {}): PackCheckRecord {
  return { id, desc: `desc-${id}`, ...extra };
}

describe("tokenizeForEpoch", () => {
  it("splits camelCase / PascalCase into constituent tokens", () => {
    expect(tokenizeForEpoch("TicketPriority perPriority")).toEqual(
      expect.arrayContaining(["ticket", "priority"]),
    );
    // "perPriority" -> "by" (dropped, <3? no, len 2 -> dropped) + "priority".
    expect(tokenizeForEpoch("perPriority")).toContain("priority");
  });

  it("splits snake_case and kebab-case", () => {
    expect(tokenizeForEpoch("issue_priority")).toEqual(expect.arrayContaining(["issue", "priority"]));
    expect(tokenizeForEpoch("priority-badge")).toEqual(expect.arrayContaining(["priority", "badge"]));
  });

  it("drops tokens shorter than 3 chars and the stopword set, de-dupes", () => {
    const toks = tokenizeForEpoch("add the new UI for CSS");
    expect(toks).not.toContain("add");
    expect(toks).not.toContain("the");
    expect(toks).not.toContain("new");
    expect(toks).not.toContain("for");
    expect(toks).not.toContain("ui"); // len 2
    expect(toks).toContain("css");
  });

  it("extracts deterministic CJK script spans and drops request language", () => {
    const tokens = tokenizeForEpoch("認証フローを確認してください");
    expect(tokens).toEqual(expect.arrayContaining(["認証", "フロー", "確認"]));
    expect(tokens).not.toContain("してください");
  });

  it("makes the two forensic queries overlap (the whole point of the merge)", () => {
    const a = tokenizeForEpoch("TicketPriority perPriority badge CSS style");
    const b = tokenizeForEpoch("Ticket priority enum PARAMOUNT PriorityChip validation statistics");
    const setA = new Set(a);
    const overlap = b.filter((t) => setA.has(t));
    expect(overlap.length).toBeGreaterThanOrEqual(1);
    // Concretely, they share "issue", "priority", "badge".
    expect(overlap).toEqual(expect.arrayContaining(["priority"]));
  });
});

describe("recordPackChecks — epoch merge semantics", () => {
  beforeEach(() => resetWorkspace(WS));

  it("starts an epoch on the first pack", () => {
    recordPackChecks(WS, "Ticket priority enum PARAMOUNT", [rec("chk-0"), rec("chk-1")]);
    const state = getPackChecks(WS);
    expect(state).toBeDefined();
    expect(state!.checks.map((c) => c.id)).toEqual(["chk-0", "chk-1"]);
    expect(state!.epochQuery).toBe("Ticket priority enum PARAMOUNT");
    expect(state!.lastOpenIds).toEqual([]);
  });

  it("MERGES on token overlap: a camelCase follow-up pack keeps a check the new pack OMITTED (the closure-wipe fix)", () => {
    // Pack A: the style check is present and OPEN.
    recordPackChecks(WS, "Ticket priority enum PARAMOUNT PriorityChip validation statistics", [
      rec("chk-style", { token: "--priority-paramount", glob: "*.css", role: "style" }),
      rec("chk-contract", { role: "contract" }),
    ]);
    // Mark the style check open (simulating an edit_code closure report).
    recordClosureReport(WS, ["chk-style"]);

    // Pack B: a same-task follow-up with a camelCase query that does NOT
    // re-emit the style check. Under the OLD replace-wholesale semantics this
    // WIPED chk-style; under the epoch model it MERGES and keeps it.
    recordPackChecks(WS, "TicketPriority perPriority badge CSS style", [
      rec("chk-contract", { role: "contract" }),
      rec("chk-api", { role: "api" }),
    ]);

    const state = getPackChecks(WS);
    expect(state).toBeDefined();
    const ids = new Set(state!.checks.map((c) => c.id));
    // The omitted-but-open style check SURVIVES.
    expect(ids.has("chk-style")).toBe(true);
    // The new pack's records were appended.
    expect(ids.has("chk-api")).toBe(true);
    // The still-open id is preserved across the merge.
    expect(state!.lastOpenIds).toContain("chk-style");
    // The surviving style check retains its token/glob (machine-verifiable).
    const style = state!.checks.find((c) => c.id === "chk-style");
    expect(style!.token).toBe("--priority-paramount");
    expect(style!.glob).toBe("*.css");
  });

  it("REPLACES on a disjoint non-empty query (a genuinely new task in the same session)", () => {
    recordPackChecks(WS, "add STALLED status to the issue lifecycle", [rec("chk-0", { role: "contract" })]);
    recordClosureReport(WS, ["chk-0"]);

    // A completely unrelated task — zero token overlap.
    recordPackChecks(WS, "fix the websocket reconnect backoff timer", [rec("chk-9", { role: "api" })]);

    const state = getPackChecks(WS);
    expect(state!.checks.map((c) => c.id)).toEqual(["chk-9"]);
    // Stale checks are gone and lastOpenIds is reset for the new task.
    expect(state!.lastOpenIds).toEqual([]);
    expect(state!.epochQuery).toBe("fix the websocket reconnect backoff timer");
  });

  it("a QUERYLESS pack never replaces — it merges into the current epoch", () => {
    recordPackChecks(WS, "Ticket priority enum PARAMOUNT", [rec("chk-0", { role: "contract" })]);
    recordClosureReport(WS, ["chk-0"]);

    // A seeded/queryless pack (empty query -> zero significant tokens).
    recordPackChecks(WS, "", [rec("chk-1", { role: "api" })]);

    const state = getPackChecks(WS);
    const ids = new Set(state!.checks.map((c) => c.id));
    expect(ids.has("chk-0")).toBe(true); // original epoch preserved
    expect(ids.has("chk-1")).toBe(true); // queryless pack's record merged in
    expect(state!.lastOpenIds).toContain("chk-0"); // not reset
    // The epoch keeps the query that OPENED it.
    expect(state!.epochQuery).toBe("Ticket priority enum PARAMOUNT");
  });

  it("a queryless pack STARTS an epoch with epochQuery:'' when none exists", () => {
    recordPackChecks(WS, "", [rec("chk-0")]);
    const state = getPackChecks(WS);
    expect(state).toBeDefined();
    expect(state!.epochQuery).toBe("");
    expect(state!.checks.map((c) => c.id)).toEqual(["chk-0"]);
  });

  it("merge unions by id: a re-emitted id keeps the NEWEST record and does not duplicate", () => {
    recordPackChecks(WS, "ticket priority enum", [rec("chk-0", { desc: "old desc" })]);
    recordPackChecks(WS, "priority badge style", [rec("chk-0", { desc: "new desc", token: "--x" })]);
    const state = getPackChecks(WS);
    const matching = state!.checks.filter((c) => c.id === "chk-0");
    expect(matching).toHaveLength(1); // no duplicate
    expect(matching[0]!.desc).toBe("new desc"); // incoming wins
    expect(matching[0]!.token).toBe("--x");
  });

  it("eviction order: over the 24-record bound, OPEN checks are kept and non-open ones are evicted first", () => {
    // Open the epoch with a machine-verifiable open check.
    recordPackChecks(WS, "ticket priority enum paramount", [rec("open-1", { token: "--t", glob: "*.css" })]);
    recordClosureReport(WS, ["open-1"]);

    // Flood the SAME epoch (overlapping query each time) with 40 advisory
    // records, all with distinct ids, forcing the union over its 24 bound.
    for (let batch = 0; batch < 8; batch++) {
      const recs: PackCheckRecord[] = [];
      for (let i = 0; i < 5; i++) recs.push(rec(`fill-${batch}-${i}`));
      recordPackChecks(WS, "priority enum", recs);
    }

    const state = getPackChecks(WS);
    // The open check must NEVER be evicted, even under the bound.
    expect(state!.checks.some((c) => c.id === "open-1")).toBe(true);
    // The union is bounded (open checks may push slightly past when forced, but
    // here there is exactly one open check so the total stays at the cap).
    expect(state!.checks.length).toBeLessThanOrEqual(24);
  });

  it("F6: epochTokens is capped at 64, keeping the FIRST-SEEN tokens across many same-epoch merges", () => {
    // Open the epoch — "priority" is the founding token that keeps every
    // follow-up attached via overlap.
    recordPackChecks(WS, "priority", [rec("seed")]);
    // Flood the SAME epoch with 500 overlapping-but-distinct-token queries; each
    // MERGEs (shares "priority") and adds one fresh unique token. Without the
    // cap, epochTokens grew O(merge count) (500+); with it, it stays bounded.
    for (let i = 0; i < 500; i++) {
      recordPackChecks(WS, `priority uniquetoken${i}`, [rec(`r${i}`)]);
    }
    const state = getPackChecks(WS)!;
    expect(state.epochTokens.length).toBeLessThanOrEqual(64);
    // First-seen retention: the founding token that opened the epoch survives,
    // so the overlap signal that keeps follow-up packs attached is preserved.
    expect(state.epochTokens[0]).toBe("priority");
    expect(state.epochTokens).toContain("uniquetoken0");
    // A late-arriving token beyond the cap is dropped (first-seen, not last).
    expect(state.epochTokens).not.toContain("uniquetoken499");
  });
});

describe("deriveCheckId — content-derived ids (positional-collision regression)", () => {
  beforeEach(() => resetWorkspace(WS));

  it("same logical check -> same id across packs, regardless of desc wording or proximity", () => {
    const a = deriveCheckId({ desc: "style: token --priority-paramount present", token: "--priority-paramount", glob: "*.css", role: "style" });
    const b = deriveCheckId({ desc: "reworded later", token: "--priority-paramount", glob: "*.css", role: "style" });
    expect(a).toBe(b);
    // A co-occurrence pair is symmetric; proximity is mutable detail.
    const w1 = deriveCheckId({ desc: "wiring", tokens: ["publishTelemetry", "isHealthy"], proximity: 5, role: "wiring" });
    const w2 = deriveCheckId({ desc: "wiring again", tokens: ["isHealthy", "publishTelemetry"], proximity: 9, role: "wiring" });
    expect(w1).toBe(w2);
  });

  it("different checks -> different ids (token, glob, role, advisory desc, and strength all distinguish)", () => {
    const style = deriveCheckId({ desc: "d", token: "--priority-paramount", glob: "*.css", role: "style" });
    const api = deriveCheckId({ desc: "d", token: "validateTransition", glob: "src/api", role: "api" });
    expect(style).not.toBe(api);
    // Same token in two different per-site files = two different checks.
    const siteA = deriveCheckId({ desc: "d", token: "PARAMOUNT", glob: "src/a.ts", role: "api" });
    const siteB = deriveCheckId({ desc: "d", token: "PARAMOUNT", glob: "src/b.ts", role: "api" });
    expect(siteA).not.toBe(siteB);
    // Advisory records are distinguished by desc.
    const adv1 = deriveCheckId({ desc: "contract: add PARAMOUNT", role: "contract" });
    const adv2 = deriveCheckId({ desc: "api: handle PARAMOUNT", role: "api" });
    expect(adv1).not.toBe(adv2);
    // A verifiable check and its advisory twin are different records.
    const verifiable = deriveCheckId({ desc: "wiring", tokens: ["a", "b"], role: "wiring" });
    const advisory = deriveCheckId({ desc: "wiring", role: "wiring" });
    expect(verifiable).not.toBe(advisory);
  });

  it("gap 1 regression: a same-task follow-up pack with a different check cannot corrupt the OPEN one", () => {
    // Pack A: an OPEN machine-verifiable style check. Under positional ids
    // this was "chk-0".
    const styleBody = { desc: "style token", token: "--priority-paramount", glob: "*.css", role: "style" };
    const styleRec: PackCheckRecord = { id: deriveCheckId(styleBody), ...styleBody };
    recordPackChecks(WS, "Ticket priority enum PARAMOUNT badge style", [styleRec]);
    recordClosureReport(WS, [styleRec.id]);

    // Pack B (same task, overlapping query): an UNRELATED api check that the
    // positional scheme would ALSO have minted as "chk-0", overwriting A's.
    const apiBody = { desc: "api token", token: "validateTransition", glob: "src", role: "api" };
    const apiRec: PackCheckRecord = { id: deriveCheckId(apiBody), ...apiBody };
    recordPackChecks(WS, "priority transition validation", [apiRec]);

    expect(apiRec.id).not.toBe(styleRec.id); // content ids cannot collide
    const state = getPackChecks(WS)!;
    // The still-open id resolves to the ORIGINAL style check — closure keeps
    // verifying the RIGHT token, and the style check is not GONE.
    expect(state.lastOpenIds).toEqual([styleRec.id]);
    const open = state.checks.find((c) => c.id === styleRec.id);
    expect(open?.token).toBe("--priority-paramount");
    // The api check coexists instead of replacing it.
    expect(state.checks.some((c) => c.id === apiRec.id)).toBe(true);
  });
});

describe("_mergeCheckRecords downgrade guard (via recordPackChecks)", () => {
  beforeEach(() => resetWorkspace(WS));

  it("gap 2 regression: an advisory re-emission with the SAME id cannot strip a verifiable check's tokens", () => {
    recordPackChecks(WS, "wire telemetry health panel", [
      rec("chk-wire", { tokens: ["publishTelemetry", "isHealthy"], proximity: 5, glob: "*.cpp", role: "wiring" }),
    ]);
    recordClosureReport(WS, ["chk-wire"]);

    // Same-task follow-up re-emits the same id WITHOUT a token set (advisory).
    recordPackChecks(WS, "telemetry health wiring", [rec("chk-wire", { role: "wiring" })]);

    const state = getPackChecks(WS)!;
    const wire = state.checks.find((c) => c.id === "chk-wire")!;
    // Still verifiable — closure keeps reporting it open until the wiring lands.
    expect(isVerifiableCheck(wire)).toBe(true);
    expect(wire.tokens).toEqual(["publishTelemetry", "isHealthy"]);
    expect(wire.proximity).toBe(5);
    expect(state.lastOpenIds).toContain("chk-wire");
  });

  it("a VERIFIABLE re-emission still wins (refresh keeps the freshest desc/proximity)", () => {
    recordPackChecks(WS, "wire telemetry health panel", [
      rec("chk-wire", { tokens: ["a", "b"], proximity: 5, role: "wiring" }),
    ]);
    recordPackChecks(WS, "telemetry health wiring", [
      rec("chk-wire", { desc: "fresher", tokens: ["a", "b"], proximity: 9, role: "wiring" }),
    ]);
    const wire = getPackChecks(WS)!.checks.find((c) => c.id === "chk-wire")!;
    expect(wire.desc).toBe("fresher");
    expect(wire.proximity).toBe(9);
  });
});
