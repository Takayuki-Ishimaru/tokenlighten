// concernRecovery.spec.ts — unit coverage for the pure TL_CONCERN_RECOVERY
// mechanism (Agent B, Phase 2, 2026-09-19). Every fixture below is hand-built
// generic test data (no bench fixture, task id, or corpus is read) — the
// module under test never touches a filesystem, so none of this needs one.

import { describe, expect, it } from "vitest";

import {
  clauseNamesWindowFile,
  computeConcernWindow,
  countSiblingGroups,
  distinctiveClauseTokens,
  diversifyByConcern,
  groupSiblingItems,
  hygienicClauseWorkList,
  isClauseCoveredByCandidates,
  isClauseCoveredByTokens,
  isProseAcronym,
  mergeConcernAdditions,
  namedDefinitionFiles,
  namedMemberAfterIdentifier,
  pickClauseLocateCandidate,
  pickCoveredClauseLocateCandidate,
  prepareConcernRecoveryItems,
  recoverConcernGroupCandidates,
  runClauseLocateRecovery,
  scoreAndSelectFilesForGroup,
  type ConcernFixedStringScanner,
  type ConcernRecoveryItem,
  type ConcernScanHit,
} from "../features/task-pack/concernRecovery.js";

/** A minimal stand-in for tokenize.ts's own tokenizeQuery: lowercases, splits camelCase/snake_case/kebab-case/path separators on word boundaries, drops empties. Good enough to exercise diversifyByConcern's own logic without depending on the real tokenizer's exact vocabulary. */
function mockTokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

function item(text: string, start: number, codeShaped: boolean): ConcernRecoveryItem {
  return { text, start, codeShaped };
}

function hit(
  path: string,
  line: number,
  overrides: Partial<ConcernScanHit> = {},
): ConcernScanHit {
  return { path, line, definitionShaped: false, isTestPath: false, isDocPath: false, ...overrides };
}

/** Builds a scanner from a plain map of literal -> hits, matching case-sensitively like the real scanLiteral-backed adapter. */
function mockScanner(table: Record<string, ConcernScanHit[]>): ConcernFixedStringScanner {
  return (needle) => table[needle] ?? [];
}

describe("prepareConcernRecoveryItems", () => {
  it("dedupes by lowercased text, keeping the earliest start and OR-ing codeShaped", () => {
    const out = prepareConcernRecoveryItems([
      item("Pending", 40, false),
      item("pending", 10, true),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.start).toBe(10);
    expect(out[0]!.codeShaped).toBe(true);
    expect(out[0]!.text).toBe("Pending"); // first-seen spelling kept until a smaller start wins
  });

  it("drops blank items and sorts by position", () => {
    const out = prepareConcernRecoveryItems([item("b", 20, false), item("", 5, false), item("a", 1, false)]);
    expect(out.map((entry) => entry.text)).toEqual(["a", "b"]);
  });

  it("caps at MAX_RECOVERY_ITEMS (12)", () => {
    const many = Array.from({ length: 20 }, (_unused, index) => item(`t${index}`, index, false));
    expect(prepareConcernRecoveryItems(many)).toHaveLength(12);
  });
});

describe("groupSiblingItems", () => {
  it("groups items separated by a short gap (comma/space) into one sibling run", () => {
    // "pending, shipped, cancelled, refunded" — each item starts right after
    // the previous one's ", " separator.
    const groups = groupSiblingItems([
      item("pending", 0, false),
      item("shipped", 9, false),
      item("cancelled", 18, false),
      item("refunded", 29, false),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((entry) => entry.text)).toEqual(["pending", "shipped", "cancelled", "refunded"]);
  });

  it("splits two lists separated by unrelated clause prose into two groups", () => {
    const groups = groupSiblingItems([
      item("act.answer", 0, false),
      item("act.edit", 12, false),
      // ~80 chars of unrelated prose sit between the two lists.
      item("pack-unchanged", 120, false),
      item("code-unchanged", 136, false),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.items.map((entry) => entry.text)).toEqual(["act.answer", "act.edit"]);
    expect(groups[1]!.items.map((entry) => entry.text)).toEqual(["pack-unchanged", "code-unchanged"]);
  });

  it("drops a run of exactly one item (singletons are not this module's concern)", () => {
    const groups = groupSiblingItems([item("lonely", 0, false)]);
    expect(groups).toHaveLength(0);
  });
});

describe("scoreAndSelectFilesForGroup", () => {
  it("requires >=3 members for an all-plain-word group and rejects a 2-member plain group outright", () => {
    const group = { id: "g", items: [item("input", 0, false), item("output", 8, false)] };
    const scan = mockScanner({ input: [hit("a.ts", 1)], output: [hit("a.ts", 2)] });
    expect(scoreAndSelectFilesForGroup(group, scan)).toEqual([]);
  });

  it("an all-plain-word group with 4 members selects the file containing >=3 distinct members (E3-shape fix)", () => {
    const group = {
      id: "g",
      items: [item("pending", 0, false), item("shipped", 9, false), item("cancelled", 18, false), item("refunded", 29, false)],
    };
    const scan = mockScanner({
      pending: [hit("orderState.ts", 10)],
      shipped: [hit("orderState.ts", 11)],
      cancelled: [hit("orderState.ts", 12), hit("unrelated.ts", 5)],
      refunded: [hit("orderState.ts", 13)],
    });
    const selected = scoreAndSelectFilesForGroup(group, scan);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.path).toBe("orderState.ts");
    expect(selected[0]!.distinctMembers.size).toBe(4);
  });

  it("a lone common word never seeds a NEW file even when it is a group member", () => {
    // "done" is plain and co-occurs with a code-shaped sibling in file A, but
    // ALSO appears alone (no sibling) in file B — B must never be selected.
    const group = { id: "g", items: [item("await_input", 0, true), item("done", 13, false)] };
    const scan = mockScanner({
      await_input: [hit("decisionA.ts", 40, { definitionShaped: false })],
      done: [hit("decisionA.ts", 41), hit("decisionB.ts", 9)],
    });
    const selected = scoreAndSelectFilesForGroup(group, scan);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.path).toBe("decisionA.ts");
  });

  it("requires >=2 distinct members for a group with a code-shaped member; a single seed hit alone does not qualify", () => {
    const group = { id: "g", items: [item("MAX_RETRY_ATTEMPTS", 0, true), item("retryQueue", 20, true)] };
    const scan = mockScanner({
      MAX_RETRY_ATTEMPTS: [hit("queue.ts", 5)],
      retryQueue: [], // no co-occurrence anywhere
    });
    expect(scoreAndSelectFilesForGroup(group, scan)).toEqual([]);
  });

  it("tie-breaks equal distinct-member counts by more definition-shaped hits", () => {
    const group = { id: "g", items: [item("Alpha", 0, true), item("Beta", 6, true)] };
    const scan = mockScanner({
      Alpha: [hit("winner.ts", 1, { definitionShaped: true }), hit("loser.ts", 1, { definitionShaped: false })],
      Beta: [hit("winner.ts", 2, { definitionShaped: false }), hit("loser.ts", 2, { definitionShaped: false })],
    });
    const selected = scoreAndSelectFilesForGroup(group, scan);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.path).toBe("winner.ts");
  });

  it("prefers a non-test path over a tied test path, and does not return both", () => {
    const group = { id: "g", items: [item("Alpha", 0, true), item("Beta", 6, true)] };
    const scan = mockScanner({
      Alpha: [hit("impl.ts", 1), hit("impl.test.ts", 1, { isTestPath: true })],
      Beta: [hit("impl.ts", 2), hit("impl.test.ts", 2, { isTestPath: true })],
    });
    const selected = scoreAndSelectFilesForGroup(group, scan);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.path).toBe("impl.ts");
  });

  it("returns the top TWO files only when fully tied and both are implementation files", () => {
    const group = { id: "g", items: [item("Alpha", 0, true), item("Beta", 6, true)] };
    const scan = mockScanner({
      Alpha: [hit("moduleA.ts", 1), hit("moduleB.ts", 1)],
      Beta: [hit("moduleA.ts", 2), hit("moduleB.ts", 2)],
    });
    const selected = scoreAndSelectFilesForGroup(group, scan);
    expect(selected.map((entry) => entry.path).sort()).toEqual(["moduleA.ts", "moduleB.ts"]);
  });
});

describe("computeConcernWindow", () => {
  it("widens the hull to the smallest enclosing symbol when it is within the cap", async () => {
    const hits = [
      { path: "f.ts", line: 10, member: "a", definitionShaped: false, isTestPath: false, isDocPath: false },
      { path: "f.ts", line: 12, member: "b", definitionShaped: false, isTestPath: false, isDocPath: false },
    ];
    const window = await computeConcernWindow(hits, "f.ts", async () => ({ startLine: 5, endLine: 30, symbol: "OrderStatus" }));
    expect(window).toEqual({ startLine: 5, endLine: 30, symbol: "OrderStatus" });
  });

  it("falls back to hull +/- 12 lines when the enclosing symbol exceeds the 80-line cap", async () => {
    const hits = [
      { path: "f.ts", line: 100, member: "a", definitionShaped: false, isTestPath: false, isDocPath: false },
      { path: "f.ts", line: 102, member: "b", definitionShaped: false, isTestPath: false, isDocPath: false },
    ];
    const window = await computeConcernWindow(hits, "f.ts", async () => ({ startLine: 1, endLine: 500 }));
    expect(window.startLine).toBe(88);
    expect(window.endLine).toBe(114);
  });

  it("falls back to hull +/- 12 lines when there is no enclosing symbol at all", async () => {
    const hits = [{ path: "f.ts", line: 200, member: "a", definitionShaped: false, isTestPath: false, isDocPath: false }];
    const window = await computeConcernWindow(hits, "f.ts", async () => undefined);
    expect(window.startLine).toBe(188);
    expect(window.endLine).toBe(212);
    expect(window.endLine - window.startLine).toBeGreaterThan(0); // never a one-line body
  });

  it("clamps an oversized fallback window to MAX_WINDOW_LINES (80)", async () => {
    const hits = [
      { path: "f.ts", line: 10, member: "a", definitionShaped: false, isTestPath: false, isDocPath: false },
      { path: "f.ts", line: 200, member: "b", definitionShaped: false, isTestPath: false, isDocPath: false },
    ];
    // Same cluster only if within CLUSTER_GAP_LINES; here they are far apart,
    // so densestCluster picks the larger single-hit cluster deterministically
    // and the window is still capped regardless of which one wins.
    const window = await computeConcernWindow(hits, "f.ts", async () => undefined);
    expect(window.endLine - window.startLine + 1).toBeLessThanOrEqual(80);
  });

  it("never returns a one-line window even for a single hit with no enclosing symbol margin", async () => {
    const hits = [{ path: "f.ts", line: 1, member: "a", definitionShaped: false, isTestPath: false, isDocPath: false }];
    const window = await computeConcernWindow(hits, "f.ts", async () => undefined);
    expect(window.endLine).toBeGreaterThan(window.startLine);
  });
});

describe("recoverConcernGroupCandidates (end-to-end over pure inputs)", () => {
  it("returns one candidate per qualifying sibling group and none for a non-qualifying group", async () => {
    const items: ConcernRecoveryItem[] = [
      item("pending", 0, false),
      item("shipped", 9, false),
      item("cancelled", 18, false),
      item("refunded", 29, false),
      // A second, unrelated 2-item plain group far away in the query — must not qualify (needs 3).
      item("input", 500, false),
      item("output", 508, false),
    ];
    const scan = mockScanner({
      pending: [hit("orderState.ts", 10)],
      shipped: [hit("orderState.ts", 11)],
      cancelled: [hit("orderState.ts", 12)],
      refunded: [hit("orderState.ts", 13)],
      input: [hit("io.ts", 1)],
      output: [hit("io.ts", 2)],
    });
    const candidates = await recoverConcernGroupCandidates(items, scan, async () => ({
      startLine: 5,
      endLine: 20,
      symbol: "OrderStatus",
    }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.path).toBe("orderState.ts");
    expect(candidates[0]!.distinctMemberCount).toBe(4);
    expect(candidates[0]!.range).toBe("5-20");
    expect(candidates[0]!.symbol).toBe("OrderStatus");
  });

  it("returns [] when no group qualifies", async () => {
    const items: ConcernRecoveryItem[] = [item("a", 0, false), item("b", 2, false)];
    const candidates = await recoverConcernGroupCandidates(items, mockScanner({}), async () => undefined);
    expect(candidates).toEqual([]);
  });
});

describe("countSiblingGroups", () => {
  it("counts sibling groups without requiring a scanner (query-shape only)", () => {
    const items: ConcernRecoveryItem[] = [
      item("pending", 0, false),
      item("shipped", 9, false),
      item("cancelled", 18, false),
      item("act.answer", 200, false),
      item("act.edit", 213, false),
    ];
    expect(countSiblingGroups(items)).toBe(2);
  });

  it("returns 0 when every item is a singleton", () => {
    expect(countSiblingGroups([item("only", 0, false)])).toBe(0);
  });
});

describe("diversifyByConcern", () => {
  it("reorders so each of 2 clauses' best candidate comes first, in clause order, then the rest unchanged", () => {
    const candidates = [
      { path: "src/couponEngine.ts" },
      { path: "src/notificationQueue.ts" },
      { path: "src/unrelated.ts" },
    ];
    const clauses = ["how is a coupon discount validated", "where are failed notifications retried"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize);
    // clause 1 -> couponEngine.ts (already first; unchanged), clause 2 -> notificationQueue.ts (already second; unchanged)
    expect(out.map((c) => c.path)).toEqual(["src/couponEngine.ts", "src/notificationQueue.ts", "src/unrelated.ts"]);
  });

  it("actually moves a later candidate earlier when the locator's own order buried it", () => {
    const candidates = [
      { path: "src/unrelated.ts" },
      { path: "src/notificationQueue.ts" },
      { path: "src/couponEngine.ts" },
    ];
    const clauses = ["how is a coupon discount validated", "where is a failed notification queue for retries"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize);
    expect(out.map((c) => c.path)).toEqual([
      "src/couponEngine.ts",
      "src/notificationQueue.ts",
      "src/unrelated.ts",
    ]);
  });

  it("matches via symbol name when the path alone does not carry the clause's tokens", () => {
    const candidates = [
      { path: "src/misc.ts", symbol: "retryFailedNotifications" },
      { path: "src/other.ts" },
    ];
    const clauses = ["how is a coupon discount validated", "where are failed notifications retried"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize);
    expect(out[0]!.path).toBe("src/misc.ts");
  });

  it("qualifies on a single long (>=6 char) token match alone", () => {
    const candidates = [{ path: "src/unrelated.ts" }, { path: "src/couponEngine.ts" }];
    const clauses = ["describe the coupon workflow end to end", "explain unrelated things generally"];
    // "coupon" (6 chars) alone matches couponEngine.ts (clause 0, so it leads); "unrelated" alone matches unrelated.ts (clause 1).
    const out = diversifyByConcern(candidates, clauses, mockTokenize);
    expect(out.map((c) => c.path)).toEqual(["src/couponEngine.ts", "src/unrelated.ts"]);
  });

  it("is a no-op with fewer than 2 candidates", () => {
    const candidates = [{ path: "src/only.ts" }];
    const clauses = ["a", "b"];
    expect(diversifyByConcern(candidates, clauses, mockTokenize)).toEqual(candidates);
  });

  it("is a no-op with fewer than 2 clauses", () => {
    const candidates = [{ path: "src/a.ts" }, { path: "src/b.ts" }];
    expect(diversifyByConcern(candidates, ["only one clause"], mockTokenize)).toEqual(candidates);
  });

  it("is a no-op when fewer than 2 clauses have a qualifying candidate (a coin flip is not diversification)", () => {
    const candidates = [{ path: "src/couponEngine.ts" }, { path: "src/other.ts" }];
    const clauses = ["how is a coupon discount validated", "something with zero token overlap at all"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize);
    expect(out.map((c) => c.path)).toEqual(["src/couponEngine.ts", "src/other.ts"]);
  });

  it("never adds or drops a candidate — output is a permutation of the input", () => {
    const candidates = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: "d.ts" }];
    const clauses = ["clause about a", "clause about b", "clause about c"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize);
    expect(out.map((c) => c.path).sort()).toEqual(candidates.map((c) => c.path).sort());
    expect(out.length).toBe(candidates.length);
  });

  it("two clauses pointing at the SAME best candidate still yields a valid permutation with no duplicate", () => {
    const candidates = [{ path: "src/other.ts" }, { path: "src/couponEngine.ts" }];
    const clauses = ["how is a coupon validated", "where is the coupon discount applied"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize);
    expect(out.map((c) => c.path)).toEqual(["src/couponEngine.ts", "src/other.ts"]);
  });

  // FX-CR3 (sfShippedBookings.spec.ts investigation, 2026-09-19): without
  // pinning, a clause whose match is candidate[0] but which is processed
  // AFTER a clause matching candidate[1] gets candidate[1] placed first --
  // reordering the locator's own top-ranked candidate out of slot 0, even
  // though extractRequestItems's clause order does not track query-text
  // order. This is the exact shape that let a TL_SF_DEMOTE-eligible
  // "supporting" row become the new slot-0 primary while the true primary
  // became the demotable one.
  it("without pinning (default), the locator's own top candidate CAN be reordered out of slot 0 by clause processing order", () => {
    const candidates = [{ path: "src/engagement.ts", symbol: "renderEngagement" }, { path: "src/supporting_notes.ts", symbol: "SUPPORTING_NOTE" }];
    // Clause order as extractRequestItems actually produced it in the
    // measured case: the relation/supporting clause BEFORE the subject clause,
    // even though the subject was named first in the query text.
    const clauses = ["how does the continuation relation use the supporting context", "what does renderEngagement mean"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize);
    expect(out.map((c) => c.path)).toEqual(["src/supporting_notes.ts", "src/engagement.ts"]);
  });

  it("pinnedPrefixCount keeps the locator's primary at slot 0 under the exact same inputs that reorder it away without pinning", () => {
    const candidates = [{ path: "src/engagement.ts", symbol: "renderEngagement" }, { path: "src/supporting_notes.ts", symbol: "SUPPORTING_NOTE" }];
    const clauses = ["how does the continuation relation use the supporting context", "what does renderEngagement mean"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize, 1);
    expect(out.map((c) => c.path)).toEqual(["src/engagement.ts", "src/supporting_notes.ts"]);
  });

  it("pinnedPrefixCount still lets a pinned candidate satisfy its OWN clause without wasting a reorder slot", () => {
    const candidates = [
      { path: "src/couponEngine.ts" }, // pinned primary; also the best match for clause 1
      { path: "src/unrelated.ts" },
      { path: "src/notificationQueue.ts" }, // best match for clause 2
    ];
    const clauses = ["how is a coupon discount validated", "where is a failed notification queue for retries"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize, 1);
    // couponEngine stays pinned at 0 (it already satisfied clause 1);
    // notificationQueue still moves up for clause 2, ahead of unrelated.ts.
    expect(out.map((c) => c.path)).toEqual(["src/couponEngine.ts", "src/notificationQueue.ts", "src/unrelated.ts"]);
  });

  it("pinnedPrefixCount larger than the candidate list is clamped safely (whole list pinned, no-op)", () => {
    const candidates = [{ path: "src/engagement.ts" }, { path: "src/supporting_notes.ts" }];
    const clauses = ["how does the continuation relation use the supporting context", "what does renderEngagement mean"];
    const out = diversifyByConcern(candidates, clauses, mockTokenize, 99);
    expect(out.map((c) => c.path)).toEqual(["src/engagement.ts", "src/supporting_notes.ts"]);
  });
});

describe("isClauseCoveredByCandidates", () => {
  it("is false when there are no candidates", () => {
    expect(isClauseCoveredByCandidates("how is a coupon discount validated", [], mockTokenize)).toBe(false);
  });

  it("is true when a candidate's path carries a matching long (>=6 char) token", () => {
    const candidates = [{ path: "src/couponEngine.ts" }];
    expect(isClauseCoveredByCandidates("how is a coupon discount validated", candidates, mockTokenize)).toBe(true);
  });

  it("is true on a single long token match via symbol, even when the path alone does not carry it", () => {
    const candidates = [{ path: "src/misc.ts", symbol: "retryFailedNotifications" }];
    expect(
      isClauseCoveredByCandidates("where are failed notifications retried", candidates, mockTokenize),
    ).toBe(true);
  });

  it("is false when no candidate shares the clause-match threshold", () => {
    const candidates = [{ path: "src/unrelated.ts" }];
    expect(
      isClauseCoveredByCandidates("where are failed notifications retried", candidates, mockTokenize),
    ).toBe(false);
  });

  it("only considers the candidates it is given (the caller's own selection window, not a wider list)", () => {
    const inWindow = [{ path: "src/unrelated.ts" }];
    const widerList = [{ path: "src/unrelated.ts" }, { path: "src/couponEngine.ts" }];
    expect(isClauseCoveredByCandidates("how is a coupon discount validated", inWindow, mockTokenize)).toBe(false);
    expect(isClauseCoveredByCandidates("how is a coupon discount validated", widerList, mockTokenize)).toBe(true);
  });

  it("requires >=2 distinct short-token matches when no single token is >=6 chars (mirrors diversifyByConcern's own threshold)", () => {
    const candidates = [{ path: "src/orderQueue.ts" }];
    expect(isClauseCoveredByCandidates("how is the order queue drained", candidates, mockTokenize)).toBe(true);
    expect(isClauseCoveredByCandidates("how is an order processed", candidates, mockTokenize)).toBe(false);
  });
});

interface TestLocateCandidate {
  path: string;
  confidence: number;
  symbol?: string;
  isDecoy?: boolean;
}

describe("pickClauseLocateCandidate", () => {
  const rankAbstain = (candidates: readonly TestLocateCandidate[]): TestLocateCandidate[] =>
    [...candidates].sort((a, b) => b.confidence - a.confidence);
  const isImplementation = (c: TestLocateCandidate): boolean => !c.isDecoy;
  const hasSymbol = (c: TestLocateCandidate): boolean => c.symbol !== undefined;

  it("returns a hit's primary[0], ignoring candidateDetails entirely", () => {
    const picked = pickClauseLocateCandidate<TestLocateCandidate>(
      { hit: true, primary: [{ path: "a.ts", confidence: 0.9, symbol: "foo" }] },
      rankAbstain,
      isImplementation,
      hasSymbol,
    );
    expect(picked?.path).toBe("a.ts");
  });

  it("returns undefined for a hit with an empty primary array", () => {
    const picked = pickClauseLocateCandidate<TestLocateCandidate>(
      { hit: true, primary: [] },
      rankAbstain,
      isImplementation,
      hasSymbol,
    );
    expect(picked).toBeUndefined();
  });

  it("on abstain, picks the highest-ranked candidate that is an implementation AND has a symbol", () => {
    const picked = pickClauseLocateCandidate<TestLocateCandidate>(
      {
        hit: false,
        candidateDetails: [
          { path: "decoy.ts", confidence: 0.95, isDecoy: true, symbol: "x" },
          { path: "no-symbol.ts", confidence: 0.9 },
          { path: "winner.ts", confidence: 0.8, symbol: "authenticateUser" },
        ],
      },
      rankAbstain,
      isImplementation,
      hasSymbol,
    );
    expect(picked?.path).toBe("winner.ts");
  });

  it("returns undefined when nothing qualifies (all decoys or symbol-less)", () => {
    const picked = pickClauseLocateCandidate<TestLocateCandidate>(
      {
        hit: false,
        candidateDetails: [
          { path: "decoy.ts", confidence: 0.9, isDecoy: true, symbol: "x" },
          { path: "no-symbol.ts", confidence: 0.8 },
        ],
      },
      rankAbstain,
      isImplementation,
      hasSymbol,
    );
    expect(picked).toBeUndefined();
  });

  it("returns undefined for an abstain with no candidateDetails at all", () => {
    const picked = pickClauseLocateCandidate<TestLocateCandidate>(
      { hit: false },
      rankAbstain,
      isImplementation,
      hasSymbol,
    );
    expect(picked).toBeUndefined();
  });
});

describe("mergeConcernAdditions", () => {
  it("is a no-op when there are no additions", () => {
    const candidates = [{ path: "a.ts" }, { path: "b.ts" }];
    const outcome = mergeConcernAdditions(candidates, 2, [], 1, 2, 6);
    expect(outcome.candidates).toEqual(candidates);
    expect(outcome.selectionLimit).toBe(2);
    expect(outcome.displacedUsed).toBe(0);
    expect(outcome.appliedPaths.size).toBe(0);
  });

  it("raises selectionLimit by the number of entries actually added, capped at maxSurfacesDistinct", () => {
    const candidates = [{ path: "a.ts" }];
    const outcome = mergeConcernAdditions(
      candidates,
      1,
      [{ path: "b.ts" }, { path: "c.ts" }, { path: "d.ts" }, { path: "e.ts" }],
      1,
      4,
      3,
    );
    // 4 genuinely new paths were added, but the cap (maxSurfacesDistinct=3) wins.
    expect(outcome.selectionLimit).toBe(3);
  });

  it("places a new-file addition in free room without displacing anything", () => {
    const candidates = [{ path: "a.ts" }, { path: "b.ts" }];
    const outcome = mergeConcernAdditions(candidates, 3, [{ path: "c.ts" }], 1, 2, 6);
    expect(outcome.candidates.map((c) => c.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(outcome.displacedUsed).toBe(0);
    expect(outcome.appliedPaths).toEqual(new Set(["c.ts"]));
  });

  // FX-CR1 regression coverage (2026-09-19): the pre-fix version appended a
  // same-window-path addition as a SECOND object at the tail ("harmlessly",
  // it claimed) -- which is exactly what produced the duplicate
  // OrderOrchestrator/OrderService rows (taskProfileBinding.spec.ts,
  // semanticSignalRegression.spec.ts T03) and let a TL_SF_DEMOTE-withheld
  // row see a "sibling" serving its own content and refuse to withhold
  // (sfShippedBookings.spec.ts).
  it("rule (a): drops an addition whose path is already inside the selection window -- no duplicate row, never raises the limit", () => {
    const originalEntry = { path: "a.ts", tag: "original" };
    const candidates = [originalEntry, { path: "b.ts" }];
    const outcome = mergeConcernAdditions(candidates, 2, [{ path: "a.ts", tag: "concern-addition" }], 1, 2, 6);
    // The WINDOW's own "a.ts" entry stands, verbatim -- never replaced, never duplicated.
    expect(outcome.candidates).toEqual(candidates);
    expect(outcome.candidates.filter((c) => c.path === "a.ts")).toEqual([originalEntry]);
    expect(outcome.selectionLimit).toBe(2); // never raised for a dropped addition
    expect(outcome.displacedUsed).toBe(0);
    expect(outcome.appliedPaths.size).toBe(0);
  });

  it("rule (b): promotes an existing beyond-window entry into the window instead of adding a duplicate", () => {
    const originalEntry = { path: "OrderService.java", tag: "existing-19-98" };
    const candidates = [{ path: "primary.ts" }, originalEntry];
    const addition = { path: "OrderService.java", tag: "concern-recovery-256-308" };
    const outcome = mergeConcernAdditions(candidates, 1, [addition], 1, 2, 6);
    const rows = outcome.candidates.filter((c) => c.path === "OrderService.java");
    // Exactly one row for the path, and it is the ORIGINAL object (its own
    // range/why/tag) -- never the addition's freshly-computed one.
    expect(rows).toEqual([originalEntry]);
    expect(rows).toHaveLength(1);
    expect(outcome.appliedPaths).toEqual(new Set(["OrderService.java"]));
    expect(outcome.selectionLimit).toBe(2); // raised by 1 (one entry promoted)
  });

  it("rule (c): a genuinely new path is added exactly as before", () => {
    const candidates = [{ path: "a.ts" }, { path: "b.ts" }];
    const outcome = mergeConcernAdditions(candidates, 2, [{ path: "c.ts" }], 1, 2, 6);
    expect(outcome.candidates.map((c) => c.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(outcome.appliedPaths).toEqual(new Set(["c.ts"]));
  });

  it("resolves a mixed batch of drop/promote/add additions independently, each by its own rule", () => {
    const inWindowEntry = { path: "in-window.ts" };
    const beyondWindowEntry = { path: "beyond-window.ts", tag: "existing" };
    const candidates = [inWindowEntry, beyondWindowEntry, { path: "filler.ts" }];
    const additions = [
      { path: "in-window.ts", tag: "should-be-dropped" }, // rule a
      { path: "beyond-window.ts", tag: "should-be-ignored" }, // rule b
      { path: "brand-new.ts" }, // rule c
    ];
    const outcome = mergeConcernAdditions(candidates, 1, additions, 1, 3, 6);
    expect(outcome.candidates.filter((c) => c.path === "beyond-window.ts")).toEqual([beyondWindowEntry]);
    expect(outcome.candidates.filter((c) => c.path === "in-window.ts")).toEqual([inWindowEntry]);
    expect(outcome.appliedPaths).toEqual(new Set(["beyond-window.ts", "brand-new.ts"]));
    expect(outcome.selectionLimit).toBe(3); // raised by 2 (promoted + added); the dropped one contributes nothing
  });

  it("resolves a path repeated across several additions in one call only once (first occurrence wins)", () => {
    const beyondWindowEntry = { path: "shared.ts", tag: "existing" };
    const candidates = [{ path: "primary.ts" }, beyondWindowEntry];
    const additions = [
      { path: "shared.ts", tag: "first-addition" },
      { path: "shared.ts", tag: "second-addition" },
    ];
    const outcome = mergeConcernAdditions(candidates, 1, additions, 1, 2, 6);
    expect(outcome.candidates.filter((c) => c.path === "shared.ts")).toEqual([beyondWindowEntry]);
    expect(outcome.selectionLimit).toBe(2); // ONE entry resolved (promoted), not two
  });

  it("displaces from the tail of the window (never a locator primary) when there is no free room", () => {
    const candidates = [{ path: "primary.ts" }, { path: "second.ts" }, { path: "third.ts" }];
    // maxSurfacesDistinct pinned at the current selectionLimit: the pack is
    // already at its distinct-surface cap, so the new file can only enter by
    // displacing, never by the limit rising to open free room.
    const outcome = mergeConcernAdditions(candidates, 3, [{ path: "new.ts" }], 1, 2, 3);
    expect(outcome.candidates[0]!.path).toBe("primary.ts");
    expect(outcome.candidates).toContainEqual({ path: "new.ts" });
    expect(outcome.displacedUsed).toBe(1);
  });

  it("never displaces more than the caller's remaining displacement budget (addition still tacked on past the window, harmlessly)", () => {
    const candidates = [{ path: "primary.ts" }, { path: "second.ts" }, { path: "third.ts" }];
    const outcome = mergeConcernAdditions(candidates, 3, [{ path: "new.ts" }], 1, 0, 3);
    // Zero budget: nothing WITHIN the selection window (first selectionLimit
    // entries) moves. The addition may still be appended past the window,
    // but the downstream selection loop (which takes only the first
    // selectionLimit entries) never reaches it there, so it is never
    // actually served.
    expect(outcome.candidates.slice(0, 3).map((c) => c.path)).toEqual(["primary.ts", "second.ts", "third.ts"]);
    expect(outcome.displacedUsed).toBe(0);
  });

  it("never displaces a locator primary even under full budget pressure", () => {
    const candidates = [{ path: "p1.ts" }, { path: "p2.ts" }, { path: "other.ts" }];
    const outcome = mergeConcernAdditions(candidates, 3, [{ path: "new1.ts" }, { path: "new2.ts" }], 2, 2, 3);
    expect(outcome.candidates[0]!.path).toBe("p1.ts");
    expect(outcome.candidates[1]!.path).toBe("p2.ts");
  });

  it("shares a displacement budget across two sequential calls (never more than the starting budget combined)", () => {
    const candidates = [{ path: "p.ts" }, { path: "b.ts" }, { path: "c.ts" }, { path: "d.ts" }];
    const startingBudget = 2;
    const maxSurfacesDistinct = 4; // pinned at the current window so free room never opens up mid-sequence
    const first = mergeConcernAdditions(candidates, 4, [{ path: "n1.ts" }], 1, startingBudget, maxSurfacesDistinct);
    const remainingBudget = startingBudget - first.displacedUsed;
    const second = mergeConcernAdditions(
      first.candidates,
      first.selectionLimit,
      [{ path: "n2.ts" }],
      1,
      remainingBudget,
      maxSurfacesDistinct,
    );
    expect(first.displacedUsed + second.displacedUsed).toBeLessThanOrEqual(startingBudget);
  });
});

describe("named definitions", () => {
  const FILES = [
    "backend/src/main/java/com/acme/service/OrderService.java",
    "backend/src/main/java/com/acme/service/PaymentService.java",
    "backend/src/main/java/com/acme/model/OrderStatus.java",
    "backend/src/test/java/com/acme/service/PaymentServiceTest.java",
    "frontend/js/orderStatus.js",
    "libs/a/Widget.ts",
    "libs/b/Widget.ts",
  ];
  const options = (served: string[] = [], scopePath?: string) => ({
    ...(scopePath !== undefined ? { scopePath } : {}),
    isTestPath: (filePath: string) => /\/test\//.test(filePath),
    servedPaths: new Set(served),
  });

  it("resolves each named type to the one implementation file whose stem it is, in request order, skipping what is already served", () => {
    const named = namedDefinitionFiles(["OrderService", "PaymentService", "OrderStatus"], FILES, options([FILES[0]!]));
    expect(named).toEqual([
      { identifier: "PaymentService", path: FILES[1] },
      { identifier: "OrderStatus", path: FILES[2] },
    ]);
  });

  it("an exact-case stem beats a case-insensitive one; a test file never qualifies", () => {
    expect(namedDefinitionFiles(["OrderStatus"], FILES, options()).map((n) => n.path)).toEqual([FILES[2]]);
    expect(namedDefinitionFiles(["orderStatus"], FILES, options()).map((n) => n.path)).toEqual(["frontend/js/orderStatus.js"]);
    expect(namedDefinitionFiles(["PaymentServiceTest"], FILES, options())).toEqual([]);
  });

  it("two equally good files resolve nothing, and a scope confines the search", () => {
    expect(namedDefinitionFiles(["Widget"], FILES, options())).toEqual([]);
    expect(namedDefinitionFiles(["Widget"], FILES, options([], "libs/a")).map((n) => n.path)).toEqual(["libs/a/Widget.ts"]);
    expect(namedDefinitionFiles(["OrderStatus"], FILES, options([], "frontend")).map((n) => n.path)).toEqual(["frontend/js/orderStatus.js"]);
  });

  it("adds at most three files per pack", () => {
    const many = ["A1x", "B2x", "C3x", "D4x"];
    const files = many.map((name) => `src/${name}.ts`);
    expect(namedDefinitionFiles(many, files, options())).toHaveLength(3);
  });

  it("reads the member asked about from the words right after the type's name, and stops at the next named type", () => {
    const query = "OrderService の cancel 処理、PaymentService の refund メソッド、OrderStatus enum 定義";
    const all = ["OrderService", "PaymentService", "OrderStatus"];
    const others = (name: string) => all.filter((entry) => entry !== name);
    expect(namedMemberAfterIdentifier(query, "PaymentService", others("PaymentService"), new Set(["paymentservice", "charge", "refund"]))).toBe("refund");
    // `refund` belongs to the NEXT named type's clause, not to OrderService's.
    expect(namedMemberAfterIdentifier(query, "OrderService", others("OrderService"), new Set(["orderservice", "refund"]))).toBeUndefined();
    expect(namedMemberAfterIdentifier(query, "OrderStatus", others("OrderStatus"), new Set(["orderstatus"]))).toBeUndefined();
  });
});

describe("prose acronyms and request-topic words", () => {
  it("API/JSON/URL are vocabulary; an enumerated constant or a versioned name is not", () => {
    for (const word of ["API", "JSON", "URL", "HTTP", "DTO"]) expect(isProseAcronym(word)).toBe(true);
    for (const word of ["PAID", "CANCELLED", "HTTP2", "MAX_RETRIES", "Api", "api"]) expect(isProseAcronym(word)).toBe(false);
  });

  it("a clause that mentions API stays prose, in query order, ahead of literal clauses", () => {
    const items = [
      { id: "ri-1", text: "Which statuses exist: PAID" },
      { id: "ri-2", text: "where is the order cancel API endpoint" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["ri-2", "ri-1"]);
  });

  it("distinctiveClauseTokens drops the words every clause shares and keeps a clause whole when nothing is left", () => {
    const sets = [
      new Set(["order", "cancel", "endpoint"]),
      new Set(["order", "cancel", "inventory"]),
      new Set(["order", "cancel"]),
    ];
    expect([...distinctiveClauseTokens(sets, 0)]).toEqual(["endpoint"]);
    expect([...distinctiveClauseTokens(sets, 1)]).toEqual(["inventory"]);
    expect([...distinctiveClauseTokens(sets, 2)].sort()).toEqual(["cancel", "order"]);
    expect([...distinctiveClauseTokens([sets[0]!], 0)].sort()).toEqual(["cancel", "endpoint", "order"]);
  });

  it("a clause naming a served file by its stem is covered by that file", () => {
    const window = [{ path: "src/service/OrderService.java", symbol: "cancelOrder" }];
    expect(clauseNamesWindowFile("OrderService の cancel 処理", window)).toBe(true);
    expect(clauseNamesWindowFile("the order cancel API endpoint", window)).toBe(false);
    expect(clauseNamesWindowFile("OrderService の cancel 処理", [])).toBe(false);
  });

  it("runClauseLocateRecovery locates for the clause whose only match in the window is the request's shared topic word", async () => {
    const located: string[] = [];
    const outcome = await runClauseLocateRecovery(
      [
        { id: "ri-1", text: "where is the order cancel endpoint exposed" },
        { id: "ri-2", text: "how does OrderService cancel an order" },
      ],
      [{ path: "src/service/OrderService.java", symbol: "cancelOrder" }],
      {
        tokenize: mockTokenize,
        locate: async (queryText: string) => {
          located.push(queryText);
          return {
            hit: false,
            candidateDetails: [{ path: "src/web/OrderEndpoint.java", symbol: "cancel", confidence: 0.9 }],
          };
        },
        rankAbstain: (candidates) => [...candidates],
        isImplementation: () => true,
        hasSymbol: (candidate) => candidate.symbol !== undefined,
        isTestPath: () => false,
        isDocPath: () => false,
        containsJapanese: () => false,
        stemNeighbours: () => [],
        jaExpansionTokens: () => [],
        jaRecoveryQuery: () => undefined,
        now: () => 0,
      },
    );
    expect(located).toEqual(["where is the order cancel endpoint exposed"]);
    expect(outcome.picks.map((pick) => pick.candidate.path)).toEqual(["src/web/OrderEndpoint.java"]);
  });
});

describe("hygienicClauseWorkList", () => {
  it("E4 shape: collapses the 4 individually-fragmented error-code literal items to ONE representative and promotes the literal-free auth clause to the front", () => {
    const items = [
      { id: "ri-1", text: "What do the error codes `invalid_input`" },
      { id: "ri-2", text: "`not_found`" },
      { id: "ri-3", text: "`unauthorized`" },
      { id: "ri-4", text: "`rate_limited` mean" },
      { id: "ri-5", text: "where is user authentication performed?" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["ri-5", "ri-1", "ri-2"]);
  });

  it("bare ALL-CAPS enum words are literals: three of them collapse to one representative behind the request's real clauses", () => {
    const items = [
      { id: "ri-1", text: "Which order statuses exist: PAID" },
      { id: "ri-2", text: "CANCELLED" },
      { id: "ri-3", text: "REFUNDED" },
      { id: "ri-4", text: "how does the order service cancel an order" },
      { id: "ri-5", text: "which payment method issues the refund" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["ri-4", "ri-5", "ri-1", "ri-2"]);
  });

  it("two capitals are not a name: a clause that mentions ID or UI stays prose, in query order", () => {
    const items = [
      { id: "ri-1", text: "where is the order ID generated" },
      { id: "ri-2", text: "how does the UI show a refund" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["ri-1", "ri-2"]);
  });

  it("O1 shape: collapses 4 byte-identical relation-clause copies to one, leaving the literal-free auth clause well inside the budget", () => {
    const priorities =
      "How are task priorities (low, normal, urgent, critical) used to decide which orders skip the validation queue";
    const items = [
      { id: "ri-1", text: priorities },
      { id: "ri-2", text: priorities },
      { id: "ri-3", text: priorities },
      { id: "ri-4", text: priorities },
      { id: "ri-5", text: "how does user authentication work?" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["ri-1", "ri-5"]);
  });

  it("dedupes exact-text duplicates regardless of casing/whitespace, keeping the first occurrence", () => {
    const items = [
      { id: "a", text: "Where is the thing?" },
      { id: "b", text: "  where is the thing?  " },
      { id: "c", text: "Where   is the thing?" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["a"]);
  });

  it("collapses several bare-literal-only items (no leftover words) to a single representative", () => {
    const items = [
      { id: "a", text: "`foo_bar`" },
      { id: "b", text: "`baz_qux`" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["a"]);
  });

  it("keeps a single item with substantial surrounding prose even though it names a literal", () => {
    const items = [{ id: "a", text: "Where is the `MAX_RETRIES` constant used to gate the retry loop" }];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["a"]);
  });

  it("collapses items sharing the same sentence stem and differing only by WHICH literal they name", () => {
    const items = [
      { id: "a", text: "the status is `pending` at creation" },
      { id: "b", text: "the status is `shipped` at creation" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["a"]);
  });

  it("orders literal-free prose clauses before literal-bearing ones, preserving each bucket's own query order", () => {
    const items = [
      { id: "a", text: "how is `couponEngine` validated" },
      { id: "b", text: "where is user authentication performed" },
      { id: "c", text: "how are notifications retried" },
      { id: "d", text: "the `MAX_RETRIES` constant" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("is a no-op (aside from ordering) for two genuinely distinct, literal-free clauses", () => {
    const items = [
      { id: "a", text: "how is a coupon discount validated" },
      { id: "b", text: "where are failed notifications retried" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["a", "b"]);
  });

  // FX-CR2 (mc2 investigation, 2026-09-19): a copy-pasted category tag or a
  // header line introducing a list is prose-shaped (no code-shaped literal)
  // but names nothing to search for -- left in, it would win the
  // prose-goes-first seat ahead of the query's real clauses and burn the
  // per-clause locate budget on a call that cannot help.
  it("drops a whole-text bracket tag entirely, even as the very first item", () => {
    const items = [
      { id: "tag", text: "[internal ops]" },
      { id: "real", text: "why does the retry loop never terminate" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["real"]);
  });

  it("drops a colon-terminated header line introducing a list, even as the very first item", () => {
    const items = [
      { id: "header", text: "reported symptoms:" },
      { id: "real", text: "why does the retry loop never terminate" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["real"]);
  });

  it("drops full-width bracket/colon tag and header variants the same way", () => {
    const items = [
      { id: "tag", text: "【internal ops】" },
      { id: "header", text: "reported symptoms：" },
      { id: "real", text: "why does the retry loop never terminate" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["real"]);
  });

  it("does not drop a clause that merely STARTS with a bracket tag ahead of real content", () => {
    const items = [{ id: "a", text: "[urgent] why does the retry loop never terminate" }];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["a"]);
  });

  it("does not drop a clause ending in a colon when it also asks a question somewhere in it", () => {
    const items = [{ id: "a", text: "which of these apply (see below)? categories:" }];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual(["a"]);
  });

  it("mc2 shape: tag + header + real clauses -- only the real clauses survive, in their own query order, ahead of any literal-bearing one", () => {
    const items = [
      { id: "tag", text: "[internal ops]" },
      { id: "header", text: "reported symptoms:" },
      { id: "symptom-1", text: "the retry loop never terminates after a saturation event" },
      { id: "symptom-2", text: "the `MAX_RETRIES` constant seems to be ignored under load" },
      { id: "symptom-3", text: "a failsafe and a mode switch racing sometimes drop the transition" },
    ];
    expect(hygienicClauseWorkList(items).map((it) => it.id)).toEqual([
      "symptom-1",
      "symptom-3",
      "symptom-2",
    ]);
  });
});

describe("isClauseCoveredByTokens", () => {
  it("matches an externally-built (e.g. neighbour-extended) token set the same way isClauseCoveredByCandidates matches a freshly tokenized clause", () => {
    const tokens = new Set(["authentication", "authenticate", "auth"]);
    const candidates = [{ path: "src/auth/loginService.ts", symbol: "authenticateUser" }];
    expect(isClauseCoveredByTokens(tokens, candidates, mockTokenize)).toBe(true);
  });

  it("is false for an empty candidate list", () => {
    expect(isClauseCoveredByTokens(new Set(["anything"]), [], mockTokenize)).toBe(false);
  });
});

describe("pickCoveredClauseLocateCandidate", () => {
  const rankByConfidence = (candidates: readonly any[]): any[] => [...candidates].sort((a, b) => b.confidence - a.confidence);
  const alwaysImplementation = (): boolean => true;
  const hasSymbol = (c: any): boolean => c.symbol !== undefined;

  it("returns a hit's primary[0] only when it also passes isCovered", () => {
    const hitResult = { hit: true, primary: [{ path: "a.ts", confidence: 0.9 }] };
    expect(
      pickCoveredClauseLocateCandidate(hitResult, rankByConfidence, alwaysImplementation, hasSymbol, () => true)?.path,
    ).toBe("a.ts");
    expect(
      pickCoveredClauseLocateCandidate(hitResult, rankByConfidence, alwaysImplementation, hasSymbol, () => false),
    ).toBeUndefined();
  });

  it("REGRESSION PIN (the exact E4 auth-clause bug): skips a HIGH-confidence, symbol-bearing, but UNCOVERED candidate and keeps searching for a LOWER-confidence one that IS covered", () => {
    const candidates = [
      { path: "src/user/user_profile.py", confidence: 0.625, symbol: "UserProfile" },
      { path: "src/user/loyalty_points.py", confidence: 0.35 },
      { path: "src/auth/loginService.ts", confidence: 0.025, symbol: "authenticateUser" },
    ];
    const isCovered = (c: any): boolean => c.path === "src/auth/loginService.ts";
    const picked = pickCoveredClauseLocateCandidate(
      { hit: false, candidateDetails: candidates },
      rankByConfidence,
      alwaysImplementation,
      hasSymbol,
      isCovered,
    );
    expect(picked?.path).toBe("src/auth/loginService.ts");
  });

  it("on a plain (no relaxed-fallback) call, never accepts a symbol-less candidate even if it would be covered", () => {
    const candidates = [{ path: "a.ts", confidence: 0.9 }];
    const picked = pickCoveredClauseLocateCandidate(
      { hit: false, candidateDetails: candidates },
      rankByConfidence,
      alwaysImplementation,
      hasSymbol,
      () => true,
    );
    expect(picked).toBeUndefined();
  });

  it("with a relaxed fallback, accepts a symbol-less candidate the fallback approves", () => {
    const candidates = [{ path: "a.ts", confidence: 0.9 }];
    const picked = pickCoveredClauseLocateCandidate(
      { hit: false, candidateDetails: candidates },
      rankByConfidence,
      alwaysImplementation,
      hasSymbol,
      () => true,
      (c: any) => c.path === "a.ts",
    );
    expect(picked?.path).toBe("a.ts");
  });

  it("skips a non-implementation candidate even if it would otherwise qualify", () => {
    const candidates = [{ path: "a.test.ts", confidence: 0.9, symbol: "x" }];
    const picked = pickCoveredClauseLocateCandidate(
      { hit: false, candidateDetails: candidates },
      rankByConfidence,
      () => false,
      hasSymbol,
      () => true,
    );
    expect(picked).toBeUndefined();
  });

  it("returns undefined when nothing in the ranked list is both qualifying and covered", () => {
    const candidates = [{ path: "a.ts", confidence: 0.9, symbol: "x" }];
    const picked = pickCoveredClauseLocateCandidate(
      { hit: false, candidateDetails: candidates },
      rankByConfidence,
      alwaysImplementation,
      hasSymbol,
      () => false,
    );
    expect(picked).toBeUndefined();
  });
});

describe("runClauseLocateRecovery", () => {
  function makeDeps(overrides: Record<string, unknown> = {}): any {
    return {
      tokenize: mockTokenize,
      locate: async () => ({ hit: false, candidateDetails: [] }),
      rankAbstain: (cs: readonly any[]) => [...cs].sort((a, b) => b.confidence - a.confidence),
      isImplementation: () => true,
      hasSymbol: (c: any) => c.symbol !== undefined,
      isTestPath: () => false,
      isDocPath: () => false,
      containsJapanese: () => false,
      stemNeighbours: () => [],
      jaExpansionTokens: () => [],
      jaRecoveryQuery: () => undefined,
      now: () => 0,
      ...overrides,
    };
  }

  it("never locates when every clause is already covered by the window", async () => {
    const locateCalls: string[] = [];
    const deps = makeDeps({
      locate: async (q: string) => {
        locateCalls.push(q);
        return { hit: false, candidateDetails: [] };
      },
    });
    const clauses = [
      { id: "a", text: "how is a coupon discount validated" },
      { id: "b", text: "where is a clause two thing" },
    ];
    const window = [{ path: "coupon-discount-validated.ts" }, { path: "clause-two-thing.ts" }];
    const outcome = await runClauseLocateRecovery(clauses, window, deps);
    expect(locateCalls).toEqual([]);
    expect(outcome.picks).toEqual([]);
    expect(outcome.uncoveredCount).toBe(0);
  });

  it("caps at MAX_CLAUSE_LOCATES (3) distinct clauses even when more are uncovered", async () => {
    const locateCalls: string[] = [];
    const deps = makeDeps({
      locate: async (q: string) => {
        locateCalls.push(q);
        return { hit: false, candidateDetails: [] };
      },
    });
    const clauses = Array.from({ length: 5 }, (_unused, i) => ({ id: `c${i}`, text: `totally unrelated clause number ${i}` }));
    await runClauseLocateRecovery(clauses, [], deps);
    expect(locateCalls.length).toBe(3);
  });

  it("never issues more than MAX_TOTAL_CLAUSE_LOCATE_CALLS (5) real locate calls even when every clause wants a retry", async () => {
    const locateCalls: string[] = [];
    const deps = makeDeps({
      locate: async (q: string) => {
        locateCalls.push(q);
        return { hit: false, candidateDetails: [] };
      },
      stemNeighbours: () => ["neighbourword"],
    });
    const clauses = Array.from({ length: 3 }, (_unused, i) => ({ id: `c${i}`, text: `clause number ${i}` }));
    const outcome = await runClauseLocateRecovery(clauses, [], deps);
    expect(outcome.locateCallsUsed).toBeLessThanOrEqual(5);
    expect(locateCalls.length).toBe(5);
  });

  it("retries only when the first attempt yields no usable pick, and never twice", async () => {
    // The hit's own path must itself pass self-coverage against the clause's
    // tokens, or the first attempt is correctly rejected and this test would
    // be asserting the wrong thing (a retry it never intended to exercise).
    let calls = 0;
    const deps = makeDeps({
      locate: async () => {
        calls += 1;
        return { hit: true, primary: [{ path: "src/clause.ts", confidence: 1 }] };
      },
      stemNeighbours: () => ["neighbourword"],
    });
    const outcome = await runClauseLocateRecovery([{ id: "a", text: "a clause" }], [], deps);
    expect(calls).toBe(1);
    expect(outcome.picks[0]?.candidate.path).toBe("src/clause.ts");
  });

  it("skips the retry when the first attempt already took longer than CLAUSE_LOCATE_SLOW_MS", async () => {
    let calls = 0;
    let time = 0;
    const deps = makeDeps({
      locate: async () => {
        calls += 1;
        time += 900;
        return { hit: false, candidateDetails: [] };
      },
      stemNeighbours: () => ["neighbourword"],
      now: () => time,
    });
    await runClauseLocateRecovery([{ id: "a", text: "a clause" }], [], deps);
    expect(calls).toBe(1);
  });

  it("Japanese clause: retries with jaBridgeRecoveryQuery when the first attempt fails, and the pick is accepted once it passes coverage extended with jaBridgeExpansionTokens", async () => {
    const queries: string[] = [];
    const deps = makeDeps({
      containsJapanese: () => true,
      jaExpansionTokens: () => ["bridgedterm"],
      jaRecoveryQuery: (text: string) => `${text} bridgedterm`,
      locate: async (q: string) => {
        queries.push(q);
        if (q.includes("bridgedterm")) {
          return { hit: false, candidateDetails: [{ path: "bridged.ts", confidence: 0.9, symbol: "Bridgedterm" }] };
        }
        return { hit: false, candidateDetails: [] };
      },
    });
    const outcome = await runClauseLocateRecovery([{ id: "a", text: "日本語のクエリ" }], [], deps);
    expect(queries.some((q) => q.includes("bridgedterm"))).toBe(true);
    expect(outcome.picks[0]?.candidate.path).toBe("bridged.ts");
  });

  it("never retries a Japanese clause when jaBridgeRecoveryQuery has nothing to offer (bridge inert/off)", async () => {
    let calls = 0;
    const deps = makeDeps({
      containsJapanese: () => true,
      jaExpansionTokens: () => [],
      jaRecoveryQuery: () => undefined,
      locate: async () => {
        calls += 1;
        return { hit: false, candidateDetails: [] };
      },
    });
    await runClauseLocateRecovery([{ id: "a", text: "日本語のクエリ" }], [], deps);
    expect(calls).toBe(1);
  });

  it("drops a pick on a test path unless the clause itself mentions tests", async () => {
    const deps = makeDeps({
      locate: async () => ({ hit: true, primary: [{ path: "tests/foo.test.ts", confidence: 1 }] }),
      isTestPath: (c: any) => c.path.includes(".test."),
    });
    const outcome = await runClauseLocateRecovery([{ id: "a", text: "a clause with no such mention" }], [], deps);
    expect(outcome.picks).toEqual([]);
  });

  it("keeps a test-path pick when the clause itself mentions tests", async () => {
    const deps = makeDeps({
      locate: async () => ({ hit: true, primary: [{ path: "tests/foo.test.ts", confidence: 1 }] }),
      isTestPath: (c: any) => c.path.includes(".test."),
    });
    const outcome = await runClauseLocateRecovery([{ id: "a", text: "where is the test for foo" }], [], deps);
    expect(outcome.picks[0]?.candidate.path).toBe("tests/foo.test.ts");
  });
});
