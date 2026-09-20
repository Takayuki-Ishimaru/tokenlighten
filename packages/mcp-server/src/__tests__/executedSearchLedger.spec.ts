/**
 * executedSearchLedger.spec.ts — the RESULT-CARRYING executed-search ledger
 * (`util/packServeLog.ts`'s `recordExecutedSearchResult` /
 * `consultExecutedSearchResult` / `executedSearchResults` /
 * `executedSearchResultSequence`), landed for TL142-01A/01B
 * (`scratchpad/report-0142.md` §4 TL142-01).
 *
 * The first describe is PURE — no spawned server, no workspace on disk. The store is in-memory and
 * keyed only by strings, so every invariant below is checkable directly, which
 * is the point: the end-to-end behaviour these primitives exist for is pinned
 * by `handsOnReport0142.characterization.spec.ts` (a real stdio server), and
 * this file pins the CONTRACT those fixes rest on so a future change to the
 * keying, the bounds or the two-partition lookup fails here — cheaply, with a
 * message that names the rule — rather than only as a puzzling wire regression.
 *
 * The rules under test, each the fix of a specific observed defect:
 *  - the key is (workspace, lane, task binding) + TERM, with NO action in it:
 *    `consultExecutedLocate`'s hard-wired `"locate"` key is exactly why the
 *    `find`/`symbols` a pack actually proposes could never be answered for;
 *  - lookup is BOUND FIRST, UNBOUND SECOND, mirroring
 *    `hasExecutedNextBoundOrUnbound`;
 *  - lane normalization means the session spelling (`""`) and the contract
 *    spelling (`"default"`) address the same partition;
 *  - bounds and LRU eviction match the sibling executed-call ledger's;
 *  - `sequence` is monotone, which is what makes it usable as the receipt
 *    door's staleness clock.
 *
 * The SECOND describe ("review round: ledger honesty", 2026-09-13) pins the three
 * gates that decide WHAT may enter this store and what it may be promoted to.
 * They live at the dispatch boundary and at the rebuild's seed promotion, not in
 * the store, so those cases use the real in-process `callTool` dispatch and a
 * real `buildTaskPack` over a tiny temp workspace — the same pattern
 * `searchLedgerRecording.spec.ts` uses, and for the same reason (a spec that
 * calls a gate directly can stay green while the caller never wires it in).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  MAX_EXECUTED_SEARCH_RESULT_HITS,
  MAX_EXECUTED_SEARCH_RESULT_TERMS,
  consultExecutedSearchResult,
  executedSearchResultSequence,
  executedSearchResults,
  recordExecutedSearchResult,
  clearExecutedNextForLane,
  clearExecutedNextForWorkspace,
  resetPackServeLogForTest,
} from "../util/packServeLog.js";
import { callTool } from "../server.js";
import { buildTaskPack } from "../tools/readCodeTaskPack.js";
import {
  bindTaskContractHandle,
  hasPendingExecutableNext,
  recordTaskContract,
  registerExecutableNextScope,
  resetTaskContractStoreForTest,
  taskContractLedgerSnapshotForTest,
  type TaskContractScope,
} from "../features/task-pack/taskContractStore.js";
import { resetAll as resetAllSessions } from "../state/session.js";

const WS = "/tmp/tl-executed-search-ledger";
const LANE = "spec-lane";

beforeEach(() => {
  resetPackServeLogForTest();
});

describe("executed-search result ledger", () => {
  it("answers for a term regardless of which term action recorded it", () => {
    // The 01A shape: the pack proposes `find`, the dispatcher normalizes
    // `scope.kind:"symbol"` to `symbols`, and the rebuild asks about the TERM.
    recordExecutedSearchResult(WS, LANE, {
      term: "MAX_RETRIES",
      action: "symbols",
      hits: [{ path: "src/retry.ts", line: 1, symbol: "MAX_RETRIES" }],
    });
    const recorded = consultExecutedSearchResult(WS, LANE, "MAX_RETRIES");
    expect(recorded?.action).toBe("symbols");
    expect(recorded?.hits).toEqual([{ path: "src/retry.ts", line: 1, symbol: "MAX_RETRIES" }]);
    expect(recorded?.absence).toBeUndefined();
  });

  it("is case-sensitive on the term", () => {
    recordExecutedSearchResult(WS, LANE, { term: "MAX_RETRIES", action: "find", hits: [{ path: "src/retry.ts" }] });
    expect(consultExecutedSearchResult(WS, LANE, "max_retries")).toBeUndefined();
  });

  it("records a proven absence with no hits, and keeps the two mutually exclusive in practice", () => {
    recordExecutedSearchResult(WS, LANE, {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [],
      absence: { scannedFiles: 6, omittedCount: 0, scopeComplete: true },
    });
    const recorded = consultExecutedSearchResult(WS, LANE, "quantumTeleportationMode");
    expect(recorded?.hits).toEqual([]);
    // R1-B1: the scope verdict and the exclusion count are CARRIED, not asserted
    // downstream — `promoteExecutedSearchAbsences` projects both onto the wire
    // gap it mints and hard-coded `scope_complete:true, omitted_count:0` before
    // this round.
    expect(recorded?.absence).toEqual({ scannedFiles: 6, omittedCount: 0, scopeComplete: true });
  });

  it("ignores an empty term", () => {
    recordExecutedSearchResult(WS, LANE, { term: "", action: "find", hits: [{ path: "src/a.ts" }] });
    expect(executedSearchResults(WS, LANE)).toEqual([]);
  });

  it("a later execution of the same term supersedes the earlier one", () => {
    recordExecutedSearchResult(WS, LANE, { term: "t", action: "find", hits: [{ path: "src/old.ts" }] });
    recordExecutedSearchResult(WS, LANE, { term: "t", action: "find", hits: [{ path: "src/new.ts" }] });
    expect(consultExecutedSearchResult(WS, LANE, "t")?.hits).toEqual([{ path: "src/new.ts" }]);
    expect(executedSearchResults(WS, LANE)).toHaveLength(1);
  });

  it("prefers the task-bound record over the unbound one for the same term", () => {
    recordExecutedSearchResult(WS, LANE, { term: "t", action: "find", hits: [{ path: "src/unbound.ts" }] });
    recordExecutedSearchResult(WS, LANE, { term: "t", action: "find", hits: [{ path: "src/bound.ts" }] }, "task-1");
    expect(consultExecutedSearchResult(WS, LANE, "t", "task-1")?.hits).toEqual([{ path: "src/bound.ts" }]);
    // ...and still finds the UNBOUND record when the bound partition has none:
    // the executions a dispatcher could not bind are the same task's work.
    expect(consultExecutedSearchResult(WS, LANE, "t", "task-2")?.hits).toEqual([{ path: "src/unbound.ts" }]);
  });

  it("does not leak a bound record to an unbound lookup", () => {
    recordExecutedSearchResult(WS, LANE, { term: "t", action: "find", hits: [{ path: "src/bound.ts" }] }, "task-1");
    expect(consultExecutedSearchResult(WS, LANE, "t")).toBeUndefined();
  });

  it("keeps lanes separate", () => {
    recordExecutedSearchResult(WS, "a", { term: "t", action: "find", hits: [{ path: "src/a.ts" }] });
    expect(consultExecutedSearchResult(WS, "b", "t")).toBeUndefined();
  });

  it("normalizes the two spellings of the default lane onto one partition", () => {
    // A-F1's split: the session sentinel is "", the contract sentinel is
    // "default". A writer using one and a reader the other addressed empty
    // partitions; `executedNextLedgerKey` normalizes both, and this store keys
    // through it.
    recordExecutedSearchResult(WS, "", { term: "t", action: "find", hits: [{ path: "src/a.ts" }] });
    expect(consultExecutedSearchResult(WS, "default", "t")?.hits).toEqual([{ path: "src/a.ts" }]);
    recordExecutedSearchResult(WS, "   ", { term: "u", action: "find", hits: [{ path: "src/b.ts" }] });
    expect(consultExecutedSearchResult(WS, "default", "u")?.hits).toEqual([{ path: "src/b.ts" }]);
  });

  it("merges both partitions in executedSearchResults, bound winning per term", () => {
    recordExecutedSearchResult(WS, LANE, { term: "shared", action: "find", hits: [{ path: "src/unbound.ts" }] });
    recordExecutedSearchResult(WS, LANE, { term: "only-unbound", action: "find", hits: [{ path: "src/u.ts" }] });
    recordExecutedSearchResult(WS, LANE, { term: "shared", action: "find", hits: [{ path: "src/bound.ts" }] }, "task-1");
    const merged = executedSearchResults(WS, LANE, "task-1");
    expect(merged.map((entry) => entry.term).sort()).toEqual(["only-unbound", "shared"]);
    expect(merged.find((entry) => entry.term === "shared")?.hits).toEqual([{ path: "src/bound.ts" }]);
  });

  it("caps retained hits per term", () => {
    const hits = Array.from({ length: MAX_EXECUTED_SEARCH_RESULT_HITS + 5 }, (_unused, i) => ({ path: `src/f${i}.ts` }));
    recordExecutedSearchResult(WS, LANE, { term: "t", action: "find", hits });
    expect(consultExecutedSearchResult(WS, LANE, "t")?.hits).toHaveLength(MAX_EXECUTED_SEARCH_RESULT_HITS);
  });

  it("bounds terms per ledger, evicting oldest first", () => {
    for (let i = 0; i <= MAX_EXECUTED_SEARCH_RESULT_TERMS; i++) {
      recordExecutedSearchResult(WS, LANE, { term: `t${i}`, action: "find", hits: [] });
    }
    expect(executedSearchResults(WS, LANE)).toHaveLength(MAX_EXECUTED_SEARCH_RESULT_TERMS);
    expect(consultExecutedSearchResult(WS, LANE, "t0")).toBeUndefined();
    expect(consultExecutedSearchResult(WS, LANE, `t${MAX_EXECUTED_SEARCH_RESULT_TERMS}`)).toBeDefined();
  });

  it("assigns a strictly increasing sequence, which executedSearchResultSequence reports", () => {
    expect(executedSearchResultSequence(WS, LANE)).toBe(0);
    recordExecutedSearchResult(WS, LANE, { term: "a", action: "find", hits: [] });
    const first = executedSearchResultSequence(WS, LANE);
    expect(first).toBeGreaterThan(0);
    recordExecutedSearchResult(WS, LANE, { term: "b", action: "find", hits: [] });
    expect(executedSearchResultSequence(WS, LANE)).toBeGreaterThan(first);
  });

  it("reports the highest sequence across both partitions", () => {
    recordExecutedSearchResult(WS, LANE, { term: "a", action: "find", hits: [] });
    const unboundOnly = executedSearchResultSequence(WS, LANE);
    recordExecutedSearchResult(WS, LANE, { term: "b", action: "find", hits: [] }, "task-1");
    expect(executedSearchResultSequence(WS, LANE, "task-1")).toBeGreaterThan(unboundOnly);
  });

  it("clearExecutedNextForLane drops this lane's results, bound partitions included", () => {
    recordExecutedSearchResult(WS, LANE, { term: "a", action: "find", hits: [] });
    recordExecutedSearchResult(WS, LANE, { term: "b", action: "find", hits: [] }, "task-1");
    recordExecutedSearchResult(WS, "other", { term: "c", action: "find", hits: [] });
    clearExecutedNextForLane(WS, LANE);
    expect(executedSearchResults(WS, LANE, "task-1")).toEqual([]);
    expect(consultExecutedSearchResult(WS, "other", "c")).toBeDefined();
  });

  it("clearExecutedNextForWorkspace drops every lane's results for that workspace", () => {
    recordExecutedSearchResult(WS, LANE, { term: "a", action: "find", hits: [] });
    recordExecutedSearchResult(WS, "other", { term: "b", action: "find", hits: [] });
    recordExecutedSearchResult(`${WS}-2`, LANE, { term: "c", action: "find", hits: [] });
    clearExecutedNextForWorkspace(WS);
    expect(executedSearchResults(WS, LANE)).toEqual([]);
    expect(executedSearchResults(WS, "other")).toEqual([]);
    expect(consultExecutedSearchResult(`${WS}-2`, LANE, "c")).toBeDefined();
  });

  it("resetPackServeLogForTest clears the store", () => {
    recordExecutedSearchResult(WS, LANE, { term: "a", action: "find", hits: [] });
    resetPackServeLogForTest();
    expect(executedSearchResults(WS, LANE)).toEqual([]);
    expect(executedSearchResultSequence(WS, LANE)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review round (2026-09-13): the three gates that decide what may ENTER this
// store, and what a stored hit may be promoted to.
//
// R1-B1  a term absence may be recorded only from the whole response's own
//        caveat-free certificate (the `queries[]` branch read per-term
//        `scope.completeness`, which findText.ts stamps "complete" for any
//        per-term absence — dropping the caveat that same certificate carried);
// R1-S10a only a search a pack PRESCRIBED may write this certificate-grade
//        state (the sibling concern recorder has always required that);
// R1-B2  a recorded hit is promoted to a surface only when it is code-bearing
//        evidence for the term — a markdown prose mention is not.
// ---------------------------------------------------------------------------

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const honestyDirs: string[] = [];

/** In-process dispatch needs a cwd checkCwdOrRefuse accepts — same constraint as searchLedgerRecording.spec.ts. */
function honestyWorkspace(tag: string, files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(HOME, `.tl-eslh-${tag}-`)));
  honestyDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return root;
}

const AUTH_TS = `export interface TokenPayload { sub: string; exp: number }

/** Validates a token and checks its expiry window. */
export function validateToken(payload: TokenPayload, now: number): boolean {
  if (payload.exp <= now) return false;
  return payload.sub.length > 0;
}
`;

/** Register the exact find a pack would prescribe, so the R1-S10a fence passes. Returns the bound scope so a caller can inspect the concern-token ledger afterwards (C12, chip wave). */
function prescribeFind(root: string, lane: string, taskHandle: string, queries: string[]): TaskContractScope {
  recordTaskContract(root, queries.map((token) => token.toLowerCase()), {
    query: `Explain ${queries.join(" and ")}.`,
    concernTokens: queries,
  }, { lane });
  const scope = bindTaskContractHandle(root, { lane }, taskHandle);
  registerExecutableNextScope(root, scope, { tool: "search_files", arguments: { action: "find", queries } });
  return scope;
}

async function find(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callTool("search_files", { action: "find", ...args });
  expect("isError" in result && result.isError === true, JSON.stringify(result)).toBe(false);
  const text = (result.content[0] as { text?: string } | undefined)?.text ?? "{}";
  const parsed = JSON.parse(text) as { matches?: Record<string, unknown> };
  // `search.matches` nests the find payload under `matches` on the wire.
  return (parsed.matches ?? parsed) as Record<string, unknown>;
}

describe("review round: ledger honesty", () => {
  afterEach(() => {
    resetAllSessions();
    resetTaskContractStoreForTest();
    resetPackServeLogForTest();
    for (const dir of honestyDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("R1-B1: a MIXED multi-term find records no absence, though the response stamps the term scope-complete", async () => {
    // The reviewer's input A: the term IS in the workspace, inside a
    // `.tokenlightenignore`d path, so the per-term verdict is "absent" over a
    // scan that excluded the very file holding it.
    const root = honestyWorkspace("mixed", {
      "package.json": '{"name":"eslh-mixed","version":"0.0.0"}\n',
      ".tokenlightenignore": "vendor/\n",
      "src/auth.ts": AUTH_TS,
      "vendor/legacy.ts": "export const quantumTeleportationMode = \"enabled\";\n",
    });
    prescribeFind(root, "eslh", "task-mixed", ["validateToken", "quantumTeleportationMode"]);
    const body = await find({ queries: ["validateToken", "quantumTeleportationMode"], cwd: root, lane: "eslh" });

    // The wire fact the gate must NOT trust, pinned so a findText.ts change that
    // starts carrying the caveat per-term is visible here:
    const termResults = body["term_results"] as Array<Record<string, unknown>>;
    const missed = termResults.find((entry) => entry["original"] === "quantumTeleportationMode")!;
    expect(missed["status"]).toBe("absent");
    expect((missed["scope"] as Record<string, unknown>)["completeness"]).toBe("complete");
    expect(body["omitted"]).toEqual({ tokenlighten_ignored: 1 });

    // ...and the ledger records NO absence for it (nor a false hit).
    const recorded = consultExecutedSearchResult(root, "eslh", "quantumTeleportationMode");
    expect(recorded?.absence).toBeUndefined();
    expect(recorded?.hits ?? []).toEqual([]);
  });

  it("R1-B1: an all-absent caveat-FREE batch records the proof, carrying its own facts", async () => {
    const root = honestyWorkspace("proof", {
      "package.json": '{"name":"eslh-proof","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
    });
    // A pack with two uncovered identifiers prescribes exactly this batch (see
    // `batchShapePrescribed` in server.ts's queries[] branch).
    prescribeFind(root, "eslh", "task-proof", ["quantumTeleportationMode", "plasmaConduitMode"]);
    const body = await find({ queries: ["quantumTeleportationMode", "plasmaConduitMode"], cwd: root, lane: "eslh" });
    expect((body["absence"] as Record<string, unknown>)["caveat"]).toBeUndefined();

    for (const term of ["quantumTeleportationMode", "plasmaConduitMode"]) {
      const recorded = consultExecutedSearchResult(root, "eslh", term);
      expect(recorded?.absence?.scopeComplete, term).toBe(true);
      expect(recorded?.absence?.omittedCount, term).toBe(0);
      expect(recorded?.absence?.scannedFiles ?? 0, term).toBeGreaterThan(0);
    }
  });

  it("R1-S10a: a term the caller ADDED to a prescribed batch records nothing", async () => {
    // The other half of the whole-call shape rule: the pack asked about one
    // term, the caller assembled a wider batch. The asked-for term is learned
    // from; the extra one is not — a search no pack asked for must not move a
    // decision, however honest its own certificate is.
    const root = honestyWorkspace("widened", {
      "package.json": '{"name":"eslh-widened","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
    });
    prescribeFind(root, "eslh", "task-widened", ["quantumTeleportationMode"]);
    await find({ queries: ["quantumTeleportationMode", "plasmaConduitMode"], cwd: root, lane: "eslh" });
    expect(consultExecutedSearchResult(root, "eslh", "quantumTeleportationMode")?.absence?.scopeComplete).toBe(true);
    expect(consultExecutedSearchResult(root, "eslh", "plasmaConduitMode")).toBeUndefined();
  });

  it("R1-B1: an all-absent CAVEATED batch records nothing", async () => {
    const root = honestyWorkspace("caveat", {
      "package.json": '{"name":"eslh-caveat","version":"0.0.0"}\n',
      ".tokenlightenignore": "vendor/\n",
      "src/auth.ts": AUTH_TS,
      "vendor/legacy.ts": "export const quantumTeleportationMode = \"enabled\";\n",
    });
    prescribeFind(root, "eslh", "task-caveat", ["quantumTeleportationMode", "plasmaConduitMode"]);
    const body = await find({ queries: ["quantumTeleportationMode", "plasmaConduitMode"], cwd: root, lane: "eslh" });
    expect((body["absence"] as Record<string, unknown>)["caveat"]).toBeTypeOf("string");
    expect(consultExecutedSearchResult(root, "eslh", "quantumTeleportationMode")?.absence).toBeUndefined();
  });

  it("C12 (chip wave): an all-absent CAVEATED batch does not certify the concern-token obligation either", async () => {
    // Same fixture as the R1-B1 case immediately above, but proving the
    // SIBLING consumer of the identical `batchBody.absence`: server.ts's
    // `certifiedAbsent` feeds `recordAuthoritativeAbsentConcerns` (the
    // task-contract concern-token ledger), a separate call from the
    // executed-search-result ledger R1-B1 already covers. Before the C12 fix,
    // `certifiedAbsent` was filled from `batchBody.absence !== undefined`
    // alone, with no caveat check — so `quantumTeleportationMode`, which IS
    // present (just inside a `.tokenlightenignore`d file the scan excluded),
    // was certified "authoritative-absent" for this concern token too.
    const root = honestyWorkspace("concern-caveat", {
      "package.json": '{"name":"eslh-concern-caveat","version":"0.0.0"}\n',
      ".tokenlightenignore": "vendor/\n",
      "src/auth.ts": AUTH_TS,
      "vendor/legacy.ts": "export const quantumTeleportationMode = \"enabled\";\n",
    });
    const scope = prescribeFind(root, "eslh", "task-concern-caveat", ["quantumTeleportationMode", "plasmaConduitMode"]);
    const body = await find({ queries: ["quantumTeleportationMode", "plasmaConduitMode"], cwd: root, lane: "eslh" });
    expect((body["absence"] as Record<string, unknown>)["caveat"]).toBeTypeOf("string");

    const obligation = taskContractLedgerSnapshotForTest(root, scope)?.obligations.find(
      (entry) => entry.kind === "concern-token" && entry.target === "quantumTeleportationMode",
    );
    expect(obligation?.proof, JSON.stringify(obligation)).toBeUndefined();
  });

  it("R1-S10a: an UNPRESCRIBED search records nothing at all", async () => {
    const root = honestyWorkspace("fence", {
      "package.json": '{"name":"eslh-fence","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
    });
    // No registerExecutableNextScope: the caller searched on its own initiative.
    await find({ queries: ["validateToken"], cwd: root, lane: "eslh" });
    await find({ query: "validateToken", cwd: root, lane: "eslh" });
    expect(executedSearchResults(root, "eslh")).toEqual([]);

    // Same call, once a pack has prescribed it: now it is recorded.
    prescribeFind(root, "eslh", "task-fence", ["validateToken"]);
    await find({ queries: ["validateToken"], cwd: root, lane: "eslh" });
    expect(consultExecutedSearchResult(root, "eslh", "validateToken")?.hits.map((hit) => hit.path))
      .toEqual(["src/auth.ts"]);
  });

  it("R1-S10a: probing the fence never poisons a next a pack registers later", () => {
    const root = honestyWorkspace("poison", { "package.json": '{"name":"eslh-poison","version":"0.0.0"}\n' });
    const next = { tool: "search_files", arguments: { action: "find", query: "computeTotal" } };
    // The read-only probe the fence makes, BEFORE any registration...
    expect(hasPendingExecutableNext(root, "eslh", next)).toBe(false);
    // ...must not make the later registration unresolvable. `resolveExecutableNextScope`
    // memoizes a miss and `registerExecutableNextScope` reads that memo as a
    // collision, which is exactly why the fence may not use it.
    recordTaskContract(root, ["computetotal"], { query: "Explain computeTotal.", concernTokens: ["computeTotal"] }, { lane: "eslh" });
    const scope = bindTaskContractHandle(root, { lane: "eslh" }, "task-poison");
    registerExecutableNextScope(root, scope, next);
    expect(hasPendingExecutableNext(root, "eslh", next)).toBe(true);
  });

  it("R1-B2: a prose-only hit is not promoted as the identifier's surface; a code hit is", async () => {
    const root = honestyWorkspace("prose", {
      "package.json": '{"name":"eslh-prose","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "docs/notes.md": "# Operations notes\n\nDo not rely on quantumTeleportationMode: it is not implemented\nanywhere in this codebase.\n",
      "src/retry.ts": "export const MAX_RETRIES = 3;\n",
    });
    const query = "Explain validateToken and quantumTeleportationMode. Also MAX_RETRIES.";
    // Both hits are facts the search really returned; only one of them is code.
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [{ path: "docs/notes.md", line: 3 }],
    });
    recordExecutedSearchResult(root, "", {
      term: "MAX_RETRIES",
      action: "find",
      hits: [{ path: "src/retry.ts", line: 1 }],
    });
    const pack = await buildTaskPack({ query }, root);
    const paths = (pack.surfaces ?? []).map((surface) => surface.path);
    expect(paths).toContain("src/retry.ts");
    expect(paths).not.toContain("docs/notes.md");
    // R1-B2: and the promoted path says where it actually came from.
    expect((pack.surfaces ?? []).find((surface) => surface.path === "src/retry.ts")?.why)
      .toBe("executed-search-located");
  });
});

// ---------------------------------------------------------------------------
// Review round 2 (2026-09-13): the two honesty holes round 1 left open.
//
// R2-B13 a `find` hit counts as code-bearing ONLY when the surface CLASS is
//        code AND this server actually knows the file's comment syntax. Round
//        1's gate consulted `util/lineClassify.ts`, whose `default: []` said
//        "this language has no comments" for every language it had not learned
//        — so the round-1 false certificate came back verbatim through an HTML
//        `<!-- ... -->` comment, and was equally reachable through SQL `--`,
//        ini `;` and any unmapped extension.
// R2-B14 a recorded ABSENCE is re-validated before it is projected. Hits were
//        re-statted on every promotion; absences were not re-validated at all,
//        so one response served `src/quantum.ts` (which DECLARES the term) and
//        certified that same term absent, "scope complete".
// ---------------------------------------------------------------------------

describe("review round 2: code-bearing carriers and absence staleness", () => {
  afterEach(() => {
    resetAllSessions();
    resetTaskContractStoreForTest();
    resetPackServeLogForTest();
    for (const dir of honestyDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Record `term` as located in `hitPath` and report whether the rebuild promoted it. */
  async function promotes(root: string, query: string, term: string, hitPath: string): Promise<boolean> {
    recordExecutedSearchResult(root, "", { term, action: "find", hits: [{ path: hitPath, line: 1 }] });
    const pack = await buildTaskPack({ query }, root);
    return (pack.surfaces ?? []).some((surface) => surface.path === hitPath);
  }

  const CARRIER_QUERY = "Explain validateToken and quantumTeleportationMode.";

  it("R2-B13: a hit inside an HTML comment is not code-bearing (the reported carrier)", async () => {
    const root = honestyWorkspace("html", {
      "package.json": '{"name":"eslh-html","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/page.html": `<div class="panel">
  <!-- Do not rely on quantumTeleportationMode: it is not implemented anywhere in this codebase. -->
  <span>status</span>
</div>
`,
    });
    expect(await promotes(root, CARRIER_QUERY, "quantumTeleportationMode", "src/page.html")).toBe(false);
  });

  it("R2-B13: an HTML carrier whose surface class is NOT ui is refused too (the class decides, not the path)", async () => {
    // `classifySurface("src/page.html")` is "ui" — so the case above could pass on
    // the surface-class rule alone. `src/markup.html` matches no class rule
    // ("unknown"), so only the markup-EXTENSION and comment conjuncts remain: the
    // same bytes must not become a declaration by moving to a different filename.
    const root = honestyWorkspace("html2", {
      "package.json": '{"name":"eslh-html2","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/markup.html": `<section>\n  <!-- quantumTeleportationMode is not implemented. -->\n</section>\n`,
    });
    expect(await promotes(root, CARRIER_QUERY, "quantumTeleportationMode", "src/markup.html")).toBe(false);
  });

  it("R2-B13: a SQL `--` comment is not code-bearing (an unmapped extension is not comment-free)", async () => {
    const root = honestyWorkspace("sql", {
      "package.json": '{"name":"eslh-sql","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/schema.sql": "CREATE TABLE sessions (id TEXT PRIMARY KEY);\n-- quantumTeleportationMode was never added.\n",
    });
    expect(await promotes(root, CARRIER_QUERY, "quantumTeleportationMode", "src/schema.sql")).toBe(false);
  });

  it("R2-B13: an ini `;` comment is not code-bearing", async () => {
    const root = honestyWorkspace("ini", {
      "package.json": '{"name":"eslh-ini","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/settings.ini": "[retry]\nattempts = 3\n; quantumTeleportationMode is not supported.\n",
    });
    expect(await promotes(root, CARRIER_QUERY, "quantumTeleportationMode", "src/settings.ini")).toBe(false);
  });

  // UPDATED 2026-09-14 (review round 4, SHOULD-FIX 28). This case pinned
  // "an unknown extension is never PROMOTED". That conflated two facts, and the
  // conflation cost real recall: a located Swift/extensionless declaration was
  // discarded and the chain dead-ended with no `next` one call after the search
  // had found the file. The rule is now split — an unknown language is still
  // never CERTIFIED (the half R2-B13 was protecting), but the file IS served so
  // the caller can read it and judge. Both halves are asserted here, so the
  // certification guarantee this case was written for is strictly still pinned.
  it("SHOULD-FIX 28: an UNKNOWN extension is SERVED under an unverified-declaration why, and still never discharges", async () => {
    const root = honestyWorkspace("zzz", {
      "package.json": '{"name":"eslh-zzz","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/plugin.zzz": "declare const quantumTeleportationMode = true;\n",
    });
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [{ path: "src/plugin.zzz", line: 1 }],
    });
    const pack = await buildTaskPack({ query: CARRIER_QUERY }, root);
    const served = (pack.surfaces ?? []).find((surface) => surface.path === "src/plugin.zzz");
    expect(served, "the located file must be SERVED so the chain can progress").toBeDefined();
    expect(served?.why).toBe("executed-search-located; language not classified, unverified");
    // The certification half: nothing in this pack may claim the identifier is
    // proved by those bytes.
    const identifierObligation = (pack.execution_contract?.readiness_certificate?.obligations ?? [])
      .find((obligation) => obligation.id === "identifier:quantumTeleportationMode");
    expect(
      identifierObligation?.status,
      "an unclassified language must never DISCHARGE the identifier obligation",
    ).not.toBe("proved");
  });

  it("SHOULD-FIX 28: a Swift declaration IS code-bearing now that lineClassify maps `.swift`", async () => {
    const root = honestyWorkspace("swift", {
      "package.json": '{"name":"eslh-swift","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/feature.swift": "let quantumTeleportationMode = true\n\nfunc describe() -> Bool {\n    return quantumTeleportationMode\n}\n",
    });
    // ONE pack build: a second one is a REPEAT pack, and `capGuidanceMetadata`
    // strips `why` from a full-bodied surface there (byte economy) — so a
    // two-build version of this assertion reads `undefined` for reasons that have
    // nothing to do with the stamp.
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [{ path: "src/feature.swift", line: 1 }],
    });
    const pack = await buildTaskPack({ query: CARRIER_QUERY }, root);
    const served = (pack.surfaces ?? []).find((surface) => surface.path === "src/feature.swift");
    expect(served, "a classified-language declaration must be promoted").toBeDefined();
    expect(
      served?.why,
      "a CLASSIFIED language keeps the plain provenance stamp — no unverified caveat",
    ).toBe("executed-search-located");
  });

  it.each([
    ["swift", "src/feature.swift", "// quantumTeleportationMode is not implemented.\nlet other = 1\n"],
    ["scala", "src/Feature.scala", "// quantumTeleportationMode is not implemented.\nval other = 1\n"],
    ["sql", "src/schema.sql", "CREATE TABLE t (id TEXT);\n-- quantumTeleportationMode never added.\n"],
    ["ini", "src/settings.ini", "[retry]\nattempts = 3\n; quantumTeleportationMode unsupported.\n"],
    ["lua", "src/mod.lua", "local other = 1\n-- quantumTeleportationMode unsupported.\n"],
    ["haskell", "src/Mod.hs", "other = 1\n-- quantumTeleportationMode unsupported.\n"],
    ["clojure", "src/mod.clj", "(def other 1)\n; quantumTeleportationMode unsupported.\n"],
    ["elisp", "src/mod.el", "(setq other 1)\n; quantumTeleportationMode unsupported.\n"],
    ["json5", "src/conf.json5", "{\n  // quantumTeleportationMode unsupported.\n  other: 1,\n}\n"],
  ])(
    "SHOULD-FIX 28: %s is now a KNOWN comment language, so a comment-only hit in %s is refused (not merely unclassified)",
    async (label, hitPath, content) => {
      const root = honestyWorkspace(`lang-${label}`, {
        "package.json": `{"name":"eslh-${label}","version":"0.0.0"}\n`,
        "src/auth.ts": AUTH_TS,
        [hitPath]: content,
      });
      expect(await promotes(root, CARRIER_QUERY, "quantumTeleportationMode", hitPath)).toBe(false);
    },
  );

  it("R2-B13 control: a real declaration in a KNOWN language is still promoted, stamped executed-search-located", async () => {
    const root = honestyWorkspace("known", {
      "package.json": '{"name":"eslh-known","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      // Two known languages, one `//` and one `#`, so the fix cannot have closed
      // the hole by refusing everything that is not TypeScript.
      "src/retry.ts": "export const quantumTeleportationMode = true;\n",
      "src/wired.py": 'plasmaConduitMode = "on"\n',
    });
    const query = "Explain quantumTeleportationMode and plasmaConduitMode.";
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [{ path: "src/retry.ts", line: 1 }],
    });
    recordExecutedSearchResult(root, "", {
      term: "plasmaConduitMode",
      action: "find",
      hits: [{ path: "src/wired.py", line: 1 }],
    });
    const pack = await buildTaskPack({ query }, root);
    const paths = (pack.surfaces ?? []).map((surface) => surface.path);
    expect(paths).toContain("src/retry.ts");
    expect(paths).toContain("src/wired.py");
    for (const rel of ["src/retry.ts", "src/wired.py"]) {
      expect((pack.surfaces ?? []).find((surface) => surface.path === rel)?.why).toBe("executed-search-located");
    }
  });

  it("R2-B13: a `#`-comment-only hit in a KNOWN language is refused (the conjunct still discriminates)", async () => {
    const root = honestyWorkspace("pycomment", {
      "package.json": '{"name":"eslh-pyc","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/commented.py": "ATTEMPTS = 3\n# quantumTeleportationMode is not wired up yet.\n",
    });
    expect(await promotes(root, CARRIER_QUERY, "quantumTeleportationMode", "src/commented.py")).toBe(false);
  });

  it("R2-B14: a recorded absence whose term now appears in a SERVED body is not projected", async () => {
    const root = honestyWorkspace("stale-served", {
      "package.json": '{"name":"eslh-stale","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      // Created AFTER the scan in the reported chain; here it simply exists, so
      // the pack serves it while the ledger still holds the absence proof.
      "src/quantum.ts": "export const quantumTeleportationMode = true;\n",
    });
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [],
      // A scan stamped AFTER every file on disk, so the mtime witness cannot fire
      // and this case tests the served-body conjunct alone.
      absence: { scannedFiles: 3, omittedCount: 0, scopeComplete: true, recordedAtMs: Date.now() + 600_000 },
    });
    const pack = await buildTaskPack({ query: CARRIER_QUERY }, root);
    expect(
      (pack.surfaces ?? []).map((surface) => surface.path),
      "fixture precondition: the declaring file must be served for this case to mean anything",
    ).toContain("src/quantum.ts");
    expect((pack.request_item_absences ?? []).map((absence) => absence.term)).not.toContain("quantumTeleportationMode");
  });

  // UPDATED 2026-09-14 (review round 4, SHOULD-FIX 27). This case pinned
  // "the mtime witness ALONE drops the record". That over-dropped on every
  // UNRELATED edit — which is what an `act.edit` + verify task does to a served
  // file as a matter of course — and the same rebuild also suppressed the find
  // that would restore the proof, so a genuinely-true absence became a dead end
  // (`await_input:"no-grounded-call-remains"` with no `next`). The witness now
  // re-reads the changed file and drops only when the term actually occurs in it.
  // The two halves are pinned as two cases, so the honesty guarantee R2-B14 was
  // written for is still covered — by the second one.
  it("SHOULD-FIX 27: a younger served surface that STILL does not contain the term keeps the absence", async () => {
    const root = honestyWorkspace("stale-mtime", {
      "package.json": '{"name":"eslh-mtime","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
    });
    // The term is genuinely absent everywhere here and the scan is older than
    // every file, so this isolates the mtime witness.
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [],
      absence: { scannedFiles: 2, omittedCount: 0, scopeComplete: true, recordedAtMs: Date.now() - 600_000 },
    });
    const pack = await buildTaskPack({ query: CARRIER_QUERY }, root);
    expect(
      (pack.request_item_absences ?? []).map((absence) => absence.term),
      "an unrelated edit to a served file must not withdraw a still-true absence",
    ).toContain("quantumTeleportationMode");
  });

  it("SHOULD-FIX 27: a younger served surface whose CURRENT text contains the term still drops the absence", async () => {
    const root = honestyWorkspace("stale-mtime-real", {
      "package.json": '{"name":"eslh-mtime2","version":"0.0.0"}\n',
      // The served slice is the `validateToken` symbol range, so the appended
      // mention sits OUTSIDE it — test (a) cannot see it and only the re-read can.
      "src/auth.ts": `${AUTH_TS}\n// quantumTeleportationMode arrived after the scan.\n`,
    });
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [],
      absence: { scannedFiles: 2, omittedCount: 0, scopeComplete: true, recordedAtMs: Date.now() - 600_000 },
    });
    const pack = await buildTaskPack({ query: CARRIER_QUERY }, root);
    expect(
      (pack.request_item_absences ?? []).map((absence) => absence.term),
      "a changed file that now contains the term falsifies the scan's conclusion",
    ).not.toContain("quantumTeleportationMode");
  });

  it("R2-B14 control: a still-true absence over an unchanged workspace IS projected", async () => {
    const root = honestyWorkspace("fresh-absence", {
      "package.json": '{"name":"eslh-fresh","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
    });
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [],
      absence: { scannedFiles: 2, omittedCount: 0, scopeComplete: true, recordedAtMs: Date.now() + 600_000 },
    });
    const pack = await buildTaskPack({ query: CARRIER_QUERY }, root);
    expect(
      (pack.request_item_absences ?? []).map((absence) => absence.term),
      "the re-validation must not delete TL142-01B: an absence nothing contradicts still counts",
    ).toContain("quantumTeleportationMode");
  });

  it("R2-B14: a record with NO timestamp witness still gets the served-body check", async () => {
    const root = honestyWorkspace("no-witness", {
      "package.json": '{"name":"eslh-nowitness","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/quantum.ts": "export const quantumTeleportationMode = true;\n",
    });
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [],
      // No `recordedAtMs` — an entry from an older build of this server.
      absence: { scannedFiles: 3, omittedCount: 0, scopeComplete: true },
    });
    const pack = await buildTaskPack({ query: CARRIER_QUERY }, root);
    expect((pack.request_item_absences ?? []).map((absence) => absence.term)).not.toContain("quantumTeleportationMode");
  });
});

// ---------------------------------------------------------------------------
// Review round 4 (2026-09-14): BLOCKER 30 — `pathClassCanCarryCode`'s
// `classifySurface`-class conjunct (shared by BOTH `classifyExecutedSearchHit`,
// tested here via the promotion path, and `exactIdentifierEvidence`, tested
// end-to-end in `handsOnReport0142.characterization.spec.ts`) must refuse on
// the file's CONTENT CLASS, never on a directory-name/extension convention
// `classifySurface`'s `"ui"`/`"style"` rules also happen to use
// (`/component`, `/page`, `/web/`, `/theme`, `.tsx`/`.jsx`).
// ---------------------------------------------------------------------------

describe("review round 4: BLOCKER 30 a /component path or .tsx extension must not refuse a real declaration", () => {
  afterEach(() => {
    resetAllSessions();
    resetTaskContractStoreForTest();
    resetPackServeLogForTest();
    for (const dir of honestyDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a real declaration under a /component directory IS promoted (the class must not veto it)", async () => {
    const root = honestyWorkspace("component-dir", {
      "package.json": '{"name":"eslh-component-dir","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      // `classifySurface("src/components/settings.ts")` is "ui" purely for
      // living under `/component` — the extension is plain `.ts`.
      "src/components/settings.ts": "export const componentSettings = {\n  retryBudgetMs: 250,\n};\n",
    });
    // `retryBudgetMs` is declared outside every comment, so a `find` hit for
    // it must promote — the class must not veto a real declaration purely
    // because the file lives under `/component`.
    recordExecutedSearchResult(root, "", {
      term: "retryBudgetMs",
      action: "find",
      hits: [{ path: "src/components/settings.ts", line: 2 }],
    });
    const pack = await buildTaskPack({ query: "Explain validateToken and retryBudgetMs." }, root);
    const surface = (pack.surfaces ?? []).find((s) => s.path === "src/components/settings.ts");
    expect(surface, "a /component path's own real declaration must be promoted").toBeDefined();
    expect(surface?.why).toBe("executed-search-located");
  });

  it("a real declaration in a .tsx file under /component IS promoted", async () => {
    const root = honestyWorkspace("tsx-component", {
      "package.json": '{"name":"eslh-tsx-component","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/components/Panel.tsx":
        "export function Panel(props: { dataTestId: string }): string { return props.dataTestId; }\n",
    });
    recordExecutedSearchResult(root, "", {
      term: "dataTestId",
      action: "find",
      hits: [{ path: "src/components/Panel.tsx", line: 1 }],
    });
    const pack = await buildTaskPack({ query: "Explain validateToken and dataTestId." }, root);
    const surface = (pack.surfaces ?? []).find((s) => s.path === "src/components/Panel.tsx");
    expect(surface, "a .tsx declaration outside comments must be promoted").toBeDefined();
    expect(surface?.why).toBe("executed-search-located");
  });

  it("control: the byte-identical shape under src/core/ (no /component segment) is promoted too", async () => {
    const root = honestyWorkspace("core-control", {
      "package.json": '{"name":"eslh-core-control","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/core/settings.ts": "export const coreSettings = {\n  idleSweepMs: 500,\n};\n",
    });
    recordExecutedSearchResult(root, "", {
      term: "idleSweepMs",
      action: "find",
      hits: [{ path: "src/core/settings.ts", line: 2 }],
    });
    const pack = await buildTaskPack({ query: "Explain validateToken and idleSweepMs." }, root);
    const surface = (pack.surfaces ?? []).find((s) => s.path === "src/core/settings.ts");
    expect(surface).toBeDefined();
    expect(surface?.why).toBe("executed-search-located");
  });

  it("R2-B13 carriers are UNCHANGED: an HTML comment mention still does not promote", async () => {
    // Regression anchor: BLOCKER 30's fix must not resurrect the round-1/
    // round-2 carriers. `src/page.html` is BOTH a `classifySurface` "ui" path
    // AND a `MARKUP_HIT_EXTENSIONS` extension — the extension list alone must
    // still refuse it now that the class conjunct no longer does.
    const root = honestyWorkspace("html-unchanged", {
      "package.json": '{"name":"eslh-html-unchanged","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "src/page.html": `<div class="panel">
  <!-- Do not rely on quantumTeleportationMode: it is not implemented anywhere in this codebase. -->
</div>
`,
    });
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [{ path: "src/page.html", line: 2 }],
    });
    const pack = await buildTaskPack({ query: "Explain validateToken and quantumTeleportationMode." }, root);
    expect((pack.surfaces ?? []).some((s) => s.path === "src/page.html")).toBe(false);
  });

  it("R1-B2 carrier is UNCHANGED: a markdown mention still does not promote", async () => {
    const root = honestyWorkspace("md-unchanged", {
      "package.json": '{"name":"eslh-md-unchanged","version":"0.0.0"}\n',
      "src/auth.ts": AUTH_TS,
      "docs/notes.md": "Do not rely on quantumTeleportationMode: it is not implemented\nanywhere in this codebase.\n",
    });
    recordExecutedSearchResult(root, "", {
      term: "quantumTeleportationMode",
      action: "find",
      hits: [{ path: "docs/notes.md", line: 1 }],
    });
    const pack = await buildTaskPack({ query: "Explain validateToken and quantumTeleportationMode." }, root);
    expect((pack.surfaces ?? []).some((s) => s.path === "docs/notes.md")).toBe(false);
  });
});
