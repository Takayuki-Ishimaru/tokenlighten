/**
 * facetGate.spec.ts — FIX-G (eval-0927 P0, 2026-09-27): the pure facet
 * completion gate (features/task-pack/facetGate.ts). The live, spawned-server
 * half (plans recorded by the closure hook, obligations, `next`, certificate
 * disclosures) is `facetCompletionGate.spec.ts`; this file pins the fact
 * table the gate maps onto `decideConcernStatus`:
 *   covered / empty (disclosed) / open (exact unserved windows) / undetermined
 *   (disclosed) — and never "covered" for evidence that is not on the wire.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateFacetRequirement,
  facetClauseLabel,
  facetClauseMatchesItem,
  facetPlanFor,
  noteUndeliveredFacetLines,
  recordFacetPlan,
  resetFacetPlansForTest,
  undeliveredFacetSpans,
  unservedSubSpans,
  MAX_FACET_PLANS_PER_WORKSPACE,
  MAX_REQUIRED_CALL_SITES,
  type FacetEvaluationContext,
  type FacetLineSpan,
  type FacetPlanEntry,
} from "../features/task-pack/facetGate.js";
import type { FacetRequirement } from "../features/task-pack/requestFacets.js";

afterEach(() => resetFacetPlansForTest());

/** An identifier-named requirement (tier 1/2 focal) unless `terms` is given: then a concept-only one (tier 3). */
function requirement(facet: FacetRequirement["facet"], clause: string, terms?: string[]): FacetRequirement {
  return terms === undefined
    ? { facet, clause, subjectIdentifiers: ["subject"], subjectTerms: [], inheritedFromLead: false }
    : { facet, clause, subjectIdentifiers: [], subjectTerms: terms, inheritedFromLead: true };
}

/** A context over in-memory files and a served-span table. */
function ctx(files: Record<string, string[]>, served: Record<string, FacetLineSpan[]>): FacetEvaluationContext {
  return {
    servedSpans: (p) => served[p] ?? [],
    fileLines: (p) => files[p],
  };
}

const lines = (n: number, fill = (i: number) => `line ${i}`): string[] => Array.from({ length: n }, (_, i) => fill(i + 1));

describe("facetClauseLabel / facetClauseMatchesItem", () => {
  it("trims edge punctuation and a dangling coordinator the clause splitter left", () => {
    expect(facetClauseLabel("Show the default values and")).toBe("Show the default values");
    expect(facetClauseLabel("the callers of fetchWithRetry.")).toBe("the callers of fetchWithRetry");
    expect(facetClauseLabel("再試行するHTTPステータスコードを確認してください。")).toBe("再試行するHTTPステータスコードを確認してください");
  });

  it("an item is owned only when its own text is no broader than the facet clause, never an unrelated one", () => {
    expect(facetClauseMatchesItem("既定値", "既定値")).toBe(true);
    expect(facetClauseMatchesItem("which status codes are retried.", "which status codes are retried.")).toBe(true);
    expect(facetClauseMatchesItem("Explain the default HTTP_TIMEOUT_MS value", "the default HTTP_TIMEOUT_MS value")).toBe(true);
    // An item broader than the clause carries other points: never owned.
    expect(facetClauseMatchesItem("Show the default values and", "How does the HTTP client handle timeouts and retries? Show the default values")).toBe(false);
    // The items of an enumerated read-lead list all carry the WHOLE enumeration as their text.
    const enumeration = "how billing invoice amount is computed, how shipping tracking code is generated, and how discount coupon value is applied";
    expect(facetClauseMatchesItem("how discount coupon value is applied.", enumeration)).toBe(false);
    expect(facetClauseMatchesItem("the callers of fetchWithRetry.", "the shouldRetry conditions")).toBe(false);
    expect(facetClauseMatchesItem("", "anything")).toBe(false);
  });
});

describe("unservedSubSpans", () => {
  it("returns exactly the uncovered pieces", () => {
    expect(unservedSubSpans({ start: 1, end: 10 }, [])).toEqual([{ start: 1, end: 10 }]);
    expect(unservedSubSpans({ start: 1, end: 10 }, [{ start: 1, end: 10 }])).toEqual([]);
    expect(unservedSubSpans({ start: 1, end: 10 }, [{ start: 3, end: 4 }, { start: 8, end: 20 }])).toEqual([
      { start: 1, end: 2 },
      { start: 5, end: 7 },
    ]);
  });
});

describe("plan memo", () => {
  it("returns a recorded plan only while every file it names keeps its sha", () => {
    recordFacetPlan("/ws", { query: "q", entries: [], fileShas: { "a.ts": "sha-a" } });
    expect(facetPlanFor("/ws", "q", () => "sha-a")?.query).toBe("q");
    expect(facetPlanFor("/ws", "q", () => "sha-b")).toBeUndefined();
    expect(facetPlanFor("/ws", "q", () => undefined)).toBeUndefined();
    expect(facetPlanFor("/ws", "other", () => "sha-a")).toBeUndefined();
  });

  it("is a bounded FIFO per workspace", () => {
    for (let i = 0; i <= MAX_FACET_PLANS_PER_WORKSPACE; i++) {
      recordFacetPlan("/ws", { query: `q${i}`, entries: [], fileShas: {} });
    }
    expect(facetPlanFor("/ws", "q0", () => undefined)).toBeUndefined();
    expect(facetPlanFor("/ws", `q${MAX_FACET_PLANS_PER_WORKSPACE}`, () => undefined)).toBeDefined();
  });
});

describe("evaluateFacetRequirement — value / condition", () => {
  const files = {
    "src/config.ts": [
      "export const DEFAULT_OPTIONS = {",
      "  timeoutMs: 5000,",
      "};",
      "",
      "// Loads options.",
      "export function loadOptions(env) {",
      "  return { ...DEFAULT_OPTIONS, timeoutMs: Number(env.X ?? DEFAULT_OPTIONS.timeoutMs) };",
      "}",
    ],
  };
  const entry: FacetPlanEntry = {
    facet: "value",
    clause: "the default X value",
    resolution: "resolved",
    // A parser that folds the doc comment into the symbol's range (5-8).
    focal: { path: "src/config.ts", name: "loadOptions", start: 5, end: 8 },
    windows: [{ kind: "constant", path: "src/config.ts", start: 1, end: 3, name: "DEFAULT_OPTIONS" }],
  };
  const req = requirement("value", "the default X value");

  it("is covered only when the constant AND the focal body are served", () => {
    const facts = evaluateFacetRequirement(req, entry, ctx(files, { "src/config.ts": [{ start: 1, end: 8 }] }));
    expect(facts.kind).toBe("covered");
    expect(facts.term).toBe("value:loadOptions");
    expect(facts.disclosure).toBeUndefined();
  });

  it("the doc-comment line of a folded symbol range is not required evidence", () => {
    const facts = evaluateFacetRequirement(req, entry, ctx(files, { "src/config.ts": [{ start: 1, end: 3 }, { start: 6, end: 8 }] }));
    expect(facts.kind).toBe("covered");
  });

  it("is OPEN, naming exactly the unserved sub-span, when the constant window was trimmed", () => {
    const facts = evaluateFacetRequirement(req, entry, ctx(files, { "src/config.ts": [{ start: 2, end: 8 }] }));
    expect(facts.kind).toBe("open");
    expect(facts.openTargets).toEqual([{ path: "src/config.ts", start: 1, end: 1 }]);
    expect(facts.disclosure).toBeUndefined();
  });

  it("is OPEN when nothing is served at all (never covered by the plan alone)", () => {
    const facts = evaluateFacetRequirement(req, entry, ctx(files, {}));
    expect(facts.kind).toBe("open");
    expect(facts.openTargets).toEqual([{ path: "src/config.ts", start: 1, end: 3 }, { path: "src/config.ts", start: 6, end: 8 }]);
  });

  it("is UNDETERMINED (disclosed, names the constant) when a constant the focal reads has no declaration", () => {
    const facts = evaluateFacetRequirement(
      req,
      { ...entry, windows: [], unresolvedConstants: ["MAX_UPLOAD_BYTES"] },
      ctx(files, { "src/config.ts": [{ start: 1, end: 8 }] }),
    );
    expect(facts.kind).toBe("undetermined");
    expect(facts.disclosure?.word).toBe("request-item-undetermined");
    expect(facts.disclosure?.reason).toContain("MAX_UPLOAD_BYTES");
  });

  it("is UNDETERMINED when the constant scan stopped at its time budget", () => {
    const facts = evaluateFacetRequirement(req, { ...entry, constantsComplete: false }, ctx(files, { "src/config.ts": [{ start: 1, end: 8 }] }));
    expect(facts.kind).toBe("undetermined");
  });

  it("verified empty: no constant and no literal in the served focal → covered with an EMPTY disclosure", () => {
    const envOnly = {
      "src/t.ts": ["export function requestTimeout(env) {", "  return Number(env.REQUEST_TIMEOUT_MS);", "}"],
    };
    const facts = evaluateFacetRequirement(
      requirement("value", "the default value of requestTimeout"),
      { facet: "value", clause: "the default value of requestTimeout", resolution: "resolved", focal: { path: "src/t.ts", name: "requestTimeout", start: 1, end: 3 }, windows: [] },
      ctx(envOnly, { "src/t.ts": [{ start: 1, end: 3 }] }),
    );
    expect(facts.kind).toBe("empty");
    expect(facts.disclosure?.word).toBe("request-item-empty");
  });

  it("a literal inside the served focal body needs no disclosure", () => {
    const literal = { "src/t.ts": ["export function port() {", "  return 8080;", "}"] };
    const facts = evaluateFacetRequirement(
      requirement("value", "the default port"),
      { facet: "value", clause: "the default port", resolution: "resolved", focal: { path: "src/t.ts", name: "port", start: 1, end: 3 }, windows: [] },
      ctx(literal, { "src/t.ts": [{ start: 1, end: 3 }] }),
    );
    expect(facts.kind).toBe("covered");
    expect(facts.disclosure).toBeUndefined();
  });

  it("a TYPE focal (interface / enum / class): its served declaration is the value evidence — covered, never 'empty'", () => {
    const typeFiles = { "src/p.ts": ["export interface ParseResult { ok: boolean; value: string; }", "export function f() {}"] };
    const facts = evaluateFacetRequirement(
      requirement("value", "what the ParseResult type looks like"),
      { facet: "value", clause: "what the ParseResult type looks like", resolution: "resolved", focal: { path: "src/p.ts", name: "ParseResult", start: 1, end: 1, callable: false }, windows: [] },
      ctx(typeFiles, { "src/p.ts": [{ start: 1, end: 2 }] }),
    );
    expect(facts.kind).toBe("covered");
    expect(facts.disclosure).toBeUndefined();
    const unserved = evaluateFacetRequirement(
      requirement("value", "what the ParseResult type looks like"),
      { facet: "value", clause: "what the ParseResult type looks like", resolution: "resolved", focal: { path: "src/p.ts", name: "ParseResult", start: 1, end: 1, callable: false }, windows: [] },
      ctx(typeFiles, {}),
    );
    expect(unserved.kind).toBe("open");
  });

  it("a focal body longer than the bound is not itself required (its constants still are)", () => {
    const big = { "src/b.ts": ["export const LIMIT_TABLE = [1];", ...lines(200, (i) => `  step${i}();`)] };
    const facts = evaluateFacetRequirement(
      requirement("value", "the limits of run"),
      { facet: "value", clause: "the limits of run", resolution: "resolved", focal: { path: "src/b.ts", name: "run", start: 2, end: 201 }, windows: [{ kind: "constant", path: "src/b.ts", start: 1, end: 1, name: "LIMIT_TABLE" }] },
      ctx(big, { "src/b.ts": [{ start: 1, end: 1 }] }),
    );
    expect(facts.kind).toBe("covered");
  });
});

describe("evaluateFacetRequirement — callers / flow", () => {
  const callee = { "src/f.ts": ["export function formatAmount(c) {", "  return c;", "}"] };
  const viewFiles: Record<string, string[]> = { ...callee };
  for (let i = 0; i < 30; i++) viewFiles[`src/v${i}.ts`] = lines(60);
  const base: FacetPlanEntry = {
    facet: "callers",
    clause: "Where is formatAmount called?",
    resolution: "resolved",
    focal: { path: "src/f.ts", name: "formatAmount", start: 1, end: 3 },
    windows: [],
  };
  const req = requirement("callers", "Where is formatAmount called?");

  it("0 call sites → EMPTY, disclosed with the scan scope (test files excluded)", () => {
    const facts = evaluateFacetRequirement(req, { ...base, callSites: [], totalCallSites: 0, callSitesComplete: true, callSitesExcludeTests: true }, ctx(viewFiles, {}));
    expect(facts.kind).toBe("empty");
    expect(facts.disclosure).toEqual({ word: "request-item-empty", reason: "0 call sites in the scanned workspace; test files excluded" });
  });

  it("covered when every call-site line is inside served evidence", () => {
    const sites = [{ path: "src/v0.ts", line: 30 }, { path: "src/v1.ts", line: 5 }];
    const facts = evaluateFacetRequirement(
      req,
      { ...base, callSites: sites, totalCallSites: 2, callSitesComplete: true },
      ctx(viewFiles, { "src/v0.ts": [{ start: 20, end: 40 }], "src/v1.ts": [{ start: 1, end: 10 }] }),
    );
    expect(facts.kind).toBe("covered");
    expect(facts.servedWindows.map((w) => w.path)).toEqual(["src/v0.ts", "src/v1.ts"]);
  });

  it("an unserved call site is OPEN with a bounded ±12-line window clipped to the file", () => {
    const sites = [{ path: "src/v0.ts", line: 30 }, { path: "src/v1.ts", line: 5 }];
    const facts = evaluateFacetRequirement(
      req,
      { ...base, callSites: sites, totalCallSites: 2, callSitesComplete: true },
      ctx(viewFiles, { "src/v0.ts": [{ start: 20, end: 40 }] }),
    );
    expect(facts.kind).toBe("open");
    expect(facts.openTargets).toEqual([{ path: "src/v1.ts", start: 1, end: 17 }]);
  });

  // P1-7 (eval-0927 review-r2 #7, manyCallers/goMethodManyCallers): the OLD
  // test below pinned exactly the defect the finding reports -- a fixed
  // `.slice(0, MAX_REQUIRED_CALL_SITES)` RE-TAKEN every hop meant a known,
  // already-enumerated site past the 24th could never become a read target
  // on ANY later hop either, so "24 of 30 served; the rest were not read"
  // never resolved however many hops followed. Replaced by three tests: all
  // RECORDED sites served (and within the recorder's own cap) is `covered`
  // even past the old fixed page size; some unserved past it are a real
  // `open`/`next` target (the "next page" fix); only a count the RECORDER
  // itself never even kept — `totalCallSites` exceeding `callSites.length`
  // — is still `undetermined` (the site ENUMERATION-for-recording was cut).
  it(`more than the old fixed page size (${MAX_REQUIRED_CALL_SITES}) of RECORDED call sites, ALL served: covered, not an artificial "never complete" remainder`, () => {
    const sites = Array.from({ length: 30 }, (_, i) => ({ path: `src/v${i}.ts`, line: 10 }));
    const served: Record<string, FacetLineSpan[]> = {};
    for (let i = 0; i < 30; i++) served[`src/v${i}.ts`] = [{ start: 1, end: 60 }];
    const facts = evaluateFacetRequirement(req, { ...base, callSites: sites, totalCallSites: 30, callSitesComplete: true }, ctx(viewFiles, served));
    expect(facts.kind).toBe("covered");
  });

  it(`more than the old fixed page size (${MAX_REQUIRED_CALL_SITES}) of RECORDED call sites, some past it unserved: an OPEN target (the "next page"), never a dead-end`, () => {
    const sites = Array.from({ length: 30 }, (_, i) => ({ path: `src/v${i}.ts`, line: 10 }));
    const served: Record<string, FacetLineSpan[]> = {};
    for (let i = 0; i < 26; i++) served[`src/v${i}.ts`] = [{ start: 1, end: 60 }]; // v26..v29 unserved -- past the OLD 24-cap
    const facts = evaluateFacetRequirement(req, { ...base, callSites: sites, totalCallSites: 30, callSitesComplete: true }, ctx(viewFiles, served));
    expect(facts.kind).toBe("open");
    expect(facts.openTargets.map((t) => t.path).sort()).toEqual(["src/v26.ts", "src/v27.ts", "src/v28.ts", "src/v29.ts"]);
  });

  it("more call sites exist than the RECORDER itself ever kept (totalCallSites past callSites.length): the excess is UNDETERMINED, never certified complete", () => {
    const sites = Array.from({ length: 30 }, (_, i) => ({ path: `src/v${i}.ts`, line: 10 })); // the recorder kept only 30 of the scan's true 45
    const served: Record<string, FacetLineSpan[]> = {};
    for (let i = 0; i < 30; i++) served[`src/v${i}.ts`] = [{ start: 1, end: 60 }];
    const facts = evaluateFacetRequirement(req, { ...base, callSites: sites, totalCallSites: 45, callSitesComplete: true }, ctx(viewFiles, served));
    expect(facts.kind).toBe("undetermined");
    expect(facts.disclosure?.reason).toContain("30 of 45 call sites");
  });

  it("an interrupted call-site scan is UNDETERMINED even when every recorded site is served", () => {
    const sites = [{ path: "src/v0.ts", line: 30 }];
    const facts = evaluateFacetRequirement(
      req,
      { ...base, callSites: sites, totalCallSites: 1, callSitesComplete: false },
      ctx(viewFiles, { "src/v0.ts": [{ start: 1, end: 60 }] }),
    );
    expect(facts.kind).toBe("undetermined");
  });

  it("flow: no caller and no RESOLVED callee of a focal that does make calls is UNDETERMINED, never a verified-empty flow", () => {
    const facts = evaluateFacetRequirement(
      requirement("flow", "its lifecycle"),
      { ...base, facet: "flow", clause: "its lifecycle", windows: [], callSites: [], totalCallSites: 0, callSitesComplete: true, focalMakesCalls: true },
      ctx(viewFiles, { "src/f.ts": [{ start: 1, end: 3 }] }),
    );
    expect(facts.kind).toBe("undetermined");
    expect(facts.disclosure?.word).toBe("request-item-undetermined");
    const leaf = evaluateFacetRequirement(
      requirement("flow", "its lifecycle"),
      { ...base, facet: "flow", clause: "its lifecycle", windows: [], callSites: [], totalCallSites: 0, callSitesComplete: true, focalMakesCalls: false },
      ctx(viewFiles, { "src/f.ts": [{ start: 1, end: 3 }] }),
    );
    expect(leaf.kind).toBe("empty");
  });

  it("flow requires the callee definitions and the focal body too", () => {
    const flowEntry: FacetPlanEntry = {
      ...base,
      facet: "flow",
      clause: "the request path of formatAmount",
      windows: [{ kind: "callee", path: "src/v2.ts", start: 1, end: 5, name: "helper" }],
      callSites: [{ path: "src/v0.ts", line: 30 }],
      totalCallSites: 1,
      callSitesComplete: true,
    };
    const facts = evaluateFacetRequirement(
      requirement("flow", "the request path of formatAmount"),
      flowEntry,
      ctx(viewFiles, { "src/v0.ts": [{ start: 1, end: 60 }], "src/f.ts": [{ start: 1, end: 3 }] }),
    );
    expect(facts.kind).toBe("open");
    expect(facts.openTargets).toEqual([{ path: "src/v2.ts", start: 1, end: 5 }]);
  });
});

describe("evaluateFacetRequirement — concept-only (no identifier named) focal grounding", () => {
  const files = {
    "src/exporter.js": [
      "/**",
      " * The --destination flag accepts the values s3 or local.",
      " */",
      "function alpha0(input) {",
      "  return input + 1;",
      "}",
    ],
    "src/client.ts": ["export async function fetchWithRetry(url) {", "  return fetch(url);", "}"],
  };
  const entryFor = (focal: NonNullable<FacetPlanEntry["focal"]>): FacetPlanEntry => ({
    facet: "value", clause: "which values the flag accepts", resolution: "resolved", focal, windows: [],
  });

  it("a focal that carries none of the concept terms itself (only its FILE header does) is a guess: UNDETERMINED, never an open demand for its body", () => {
    const facts = evaluateFacetRequirement(
      requirement("value", "which values the flag accepts", ["destination", "flag", "accept"]),
      entryFor({ path: "src/exporter.js", name: "alpha0", start: 4, end: 6 }),
      ctx(files, { "src/exporter.js": [{ start: 1, end: 3 }] }),
    );
    expect(facts.kind).toBe("undetermined");
    expect(facts.focalResolved).toBe(false);
    expect(facts.openTargets).toEqual([]);
  });

  it("a focal whose own name carries a concept term grounds the requirement (JA-bridged terms included)", () => {
    const facts = evaluateFacetRequirement(
      requirement("value", "既定値", ["default", "retry", "timeout"]),
      entryFor({ path: "src/client.ts", name: "fetchWithRetry", start: 1, end: 3 }),
      ctx(files, { "src/client.ts": [{ start: 1, end: 3 }] }),
    );
    expect(facts.focalResolved).toBe(true);
    expect(facts.kind).not.toBe("undetermined");
  });
});

describe("termination — a window requested and returned with no body is never requested again", () => {
  const files = { "src/c.ts": ["export const A_TABLE = {", "  a: 1,", "};", "export const B_TABLE = {", "  b: 2,", "};", "export function read() {", "  return A_TABLE.a + B_TABLE.b;", "}"] };
  const entry: FacetPlanEntry = {
    facet: "value", clause: "the values read", resolution: "resolved",
    focal: { path: "src/c.ts", name: "read", start: 7, end: 9 },
    windows: [
      { kind: "constant", path: "src/c.ts", start: 1, end: 3, name: "A_TABLE" },
      { kind: "constant", path: "src/c.ts", start: 4, end: 6, name: "B_TABLE" },
    ],
  };

  it("undelivered lines are recorded per workspace+query and cleared by a fresh plan", () => {
    noteUndeliveredFacetLines("/ws", "q", "src/c.ts", [{ start: 1, end: 3 }]);
    expect(undeliveredFacetSpans("/ws", "q", "src/c.ts")).toEqual([{ start: 1, end: 3 }]);
    expect(undeliveredFacetSpans("/ws", "other", "src/c.ts")).toEqual([]);
    recordFacetPlan("/ws", { query: "q", entries: [], fileShas: {} });
    expect(undeliveredFacetSpans("/ws", "q", "src/c.ts")).toEqual([]);
  });

  it("only the still-requestable window is requested; when none remains the facet is UNDETERMINED (disclosed), never an endless open", () => {
    const partly = evaluateFacetRequirement(requirement("value", "the values read"), entry, {
      ...ctx(files, { "src/c.ts": [{ start: 7, end: 9 }] }),
      undeliveredSpans: () => [{ start: 1, end: 3 }],
    });
    expect(partly.kind).toBe("open");
    expect(partly.openTargets).toEqual([{ path: "src/c.ts", start: 4, end: 6 }]);
    const none = evaluateFacetRequirement(requirement("value", "the values read"), entry, {
      ...ctx(files, { "src/c.ts": [{ start: 7, end: 9 }] }),
      undeliveredSpans: () => [{ start: 1, end: 6 }],
    });
    expect(none.kind).toBe("undetermined");
    expect(none.disclosure?.reason).toContain("requested in this session but not delivered");
  });
});

describe("evaluateFacetRequirement — no plan / no focal", () => {
  it("no recorded plan → UNDETERMINED (disclosed), never a silent pass", () => {
    const facts = evaluateFacetRequirement(requirement("value", "What is the default port?"), undefined, ctx({}, {}));
    expect(facts.kind).toBe("undetermined");
    expect(facts.term).toBe("value:What is the default port");
    expect(facts.disclosure?.word).toBe("request-item-undetermined");
    expect(facts.focalResolved).toBe(false);
  });

  it("no focal → UNDETERMINED with its own reason; a budget cut is disclosed as such", () => {
    const noFocal = evaluateFacetRequirement(requirement("value", "x"), { facet: "value", clause: "x", resolution: "no-focal", windows: [] }, ctx({}, {}));
    expect(noFocal.kind).toBe("undetermined");
    expect(noFocal.reason).toContain("no callable");
    const budget = evaluateFacetRequirement(requirement("value", "x"), { facet: "value", clause: "x", resolution: "budget-exhausted", windows: [] }, ctx({}, {}));
    expect(budget.reason).toContain("budget");
  });
});
