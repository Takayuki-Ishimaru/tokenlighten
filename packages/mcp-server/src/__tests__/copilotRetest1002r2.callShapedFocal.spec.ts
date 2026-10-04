// copilotRetest1002r2.callShapedFocal.spec.ts — Copilot retest r2 (2026-10-02).
//
// DEFECT UNDER TEST (live, VS Code Copilot Chat 0.67, GPT-6 Luna, BOTH
// TokenLighten runs of the large task): "Inspect src/checkout and calculate
// exact quote() results for these three carts: A notebook x2 and mug x1;
// member true; coupon SAVE500; ..." certified act.answer from quote.ts,
// coupons.ts and points.ts only, and Copilot spent a whole round fetching the
// other six files. The value clause wrote `quote()` in call syntax, but
// `explicitIdentifiersIn` rejects a plain lowercase word, so the clause named
// no identifier of its own, inherited the lead sentence's `SAVE500` (a coupon
// code in the cart data), and resolveFacetFocal's literal tier made the
// function holding that string (`couponDiscount`) the value focal: quote()'s
// callees and the constants they read were never required. The same query
// without the cart values -- and the previous retest's wording -- already
// served all nine files in one call; only the focal was wrong.
//
// Every fixture is generated under HOME by this file (the evaluator's own
// synthetic checkout fixture, helpers/copilotCheckoutFixture.ts); no bench
// fixture or session path is read.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import { COPILOT_CHECKOUT_FILES, COPILOT_RETRY_FILES } from "./helpers/copilotCheckoutFixture.js";
import { callShapedNamesIn, extractFacetRequirements } from "../features/task-pack/requestFacets.js";
import { callTool } from "../server.js";
import { handleTable } from "../util/handles.js";
import { resetAll } from "../util/session.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

beforeEach(() => {
  resetAll();
  handleTable.reset();
});

/** The live calls' own query strings, verbatim. */
const LIVE_QUERY = "Inspect src/checkout and calculate exact quote() results for these three carts: A notebook x2 and mug x1; member true; coupon SAVE500; points 100; standard delivery; mainland. B kettle x1 and giftcard x1; member true; coupon TEN; points 1000; express delivery; island. C mug x3; member false; coupon SAVE500; points 2000; standard delivery; mainland. Report subtotal, memberOff, couponOff, pointsOff, shipping, tax, total; explain discount order, giftcard discount eligibility, points impact on free shipping, and rounding rules. Read only, do not modify or run terminal commands. Need relevant code line numbers.";
const REPEAT_QUERY = "Inspect src/checkout and calculate the exact quote() result for carts A, B, and C: notebook x2 and mug x1 member true SAVE500 100 points standard mainland; kettle x1 and giftcard x1 member true TEN 1000 points express island; mug x3 member false SAVE500 2000 points standard mainland. Need discount order, giftcard discount eligibility, points impact on free shipping eligibility, rounding rules, and relevant file line numbers. Read only; do not modify files.";
/** The live query with its output-field list removed: the cart data alone moved the focal (measured: 3 files, quote.ts not even served). */
const LIVE_QUERY_WITHOUT_FIELDS = "Inspect src/checkout and calculate exact quote() results for these three carts: A notebook x2 and mug x1; member true; coupon SAVE500; points 100; standard delivery; mainland. B kettle x1 and giftcard x1; member true; coupon TEN; points 1000; express delivery; island. C mug x3; member false; coupon SAVE500; points 2000; standard delivery; mainland. Explain discount order, giftcard discount eligibility, points impact on free shipping, and rounding rules. Need relevant code line numbers.";

/** One distinctive line per file quote()'s answer needs: its own body, all six callees, the catalog, and every constant they read. */
const QUOTE_MARKERS = [
  "const couponOff=couponDiscount(input.coupon,eligible-memberOff);",
  "eligible:p.discountable?p.price*item.quantity:0",
  "giftcard: { price:2000, weight:0, discountable:false }",
  "Math.floor(eligible*MEMBER_RATE)",
  "if(code==='SAVE500') return eligibleAfterMember>=3000 ? 500 : 0;",
  "Math.min(requested,Math.floor(merchandiseAfterDiscounts/4))",
  "const island=region==='island' ? 900 : 0;",
  "Math.floor((merchandiseAfterPoints+shippingAmount)*TAX_RATE)",
  "SHIPPING_FREE_AT = 5000",
  "STANDARD_SHIPPING = 450",
  "EXPRESS_SURCHARGE = 700",
  "MEMBER_RATE = 0.10",
  "TAX_RATE = 0.08",
  "POINT_VALUE = 2",
];

function makeWorkspace(tag: string): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-r2cs-${tag}-`));
  tmpDirs.push(ws);
  const files: Record<string, string> = { "package.json": "{\"name\":\"r2cs\",\"private\":true,\"type\":\"module\"}\n", ...COPILOT_CHECKOUT_FILES, ...COPILOT_RETRY_FILES };
  // The live workspace's own noise: eighteen unrelated modules beside src/checkout.
  for (let i = 0; i < 18; i++) files[`src/unrelated${i}.ts`] = `export function unrelated${i}(value: number): number {\n  return value + ${i};\n}\n`;
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return ws;
}

interface Hop {
  readonly body: Record<string, any>;
}

function nextOf(response: Record<string, any>): { tool: string; arguments: Record<string, unknown> } | undefined {
  for (const candidate of [response["decision"]?.next, response["next"], response["limit"]?.next]) {
    if (candidate !== undefined && typeof candidate?.tool === "string") return candidate;
  }
  return undefined;
}

async function walk(ws: string, first: Record<string, unknown>, hopCap = 8): Promise<{ hops: Hop[]; capped: boolean }> {
  const hops: Hop[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } | undefined = { tool: "tl_read_file", arguments: first };
  while (call !== undefined) {
    if (hops.length >= hopCap) return { hops, capped: true };
    const response = await callTool(call.tool, { ...call.arguments, cwd: ws });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
    const hop = { body: JSON.parse(text) as Record<string, any> };
    hops.push(hop);
    call = nextOf(hop.body);
  }
  return { hops, capped: false };
}

function servedText(body: Record<string, any>): string {
  const out: string[] = [];
  for (const key of ["evidence", "entries"]) {
    const list = body[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry?.body === "string") out.push(entry.body);
      if (typeof entry?.content === "string") out.push(entry.content);
    }
  }
  return out.join("\n");
}

function describeHops(hops: readonly Hop[]): string {
  return JSON.stringify(hops.map((hop) => ({
    kind: hop.body["kind"],
    decision: hop.body["decision"]?.kind,
    gaps: hop.body["decision"]?.certificate?.gaps ?? hop.body["decision"]?.gaps,
    evidence: (Array.isArray(hop.body["evidence"]) ? hop.body["evidence"] : []).map((entry: any) =>
      `${entry.path}:${entry.range}${typeof entry.body === "string" ? "" : "(nobody)"} [${entry.why ?? ""}]`),
    next: nextOf(hop.body)?.arguments,
  })));
}

/** The first hop is act.answer and already carries every marker -- the round the live session spent on the rest is gone. */
function expectOneHopAnswer(label: string, walked: { hops: Hop[]; capped: boolean }, markers: readonly string[]): void {
  expect(walked.capped, `[${label}] ${describeHops(walked.hops)}`).toBe(false);
  const first = walked.hops[0]!.body;
  expect(first["decision"]?.kind, `[${label}] ${describeHops(walked.hops)}`).toBe("act.answer");
  const served = servedText(first);
  for (const marker of markers) expect(served, `[${label}] "${marker}" missing from the first hop: ${describeHops(walked.hops)}`).toContain(marker);
}

describe("callShapedNamesIn", () => {
  it("extracts names written in call syntax", () => {
    expect(callShapedNamesIn("calculate exact quote() results for these three carts")).toEqual(["quote"]);
    expect(callShapedNamesIn("what does estimate(cart) return")).toEqual(["estimate"]);
    expect(callShapedNamesIn("`quote()` の計算結果を教えて")).toEqual(["quote"]);
  });

  // Review P0: `res.json()` gave `json`, and a workspace's own `json()` became the focal.
  it("never takes a method called on an object", () => {
    expect(callShapedNamesIn("the result of client.fetchJson(url)")).toEqual([]);
    expect(callShapedNamesIn("does Math.floor() or Math.floor(x) round it")).toEqual([]);
    expect(callShapedNamesIn("what does res.json() return inside fetchUser()")).toEqual(["fetchUser"]);
  });

  it("never reads prose parentheses or an English plural as a call", () => {
    expect(callShapedNamesIn("which file(s) define the value(es) and the item(S)")).toEqual([]);
    expect(callShapedNamesIn("the results (see below) for carts (A, B)")).toEqual([]);
    expect(callShapedNamesIn("a(1) is too short to be a subject")).toEqual([]);
  });
});

describe("extractFacetRequirements carries the clause's call-shaped subject", () => {
  it("the live query: the value clause's own quote(), and the condition clause inherits the lead sentence's", () => {
    const requirements = extractFacetRequirements(LIVE_QUERY);
    const value = requirements.find((r) => r.facet === "value");
    const condition = requirements.find((r) => r.facet === "condition");
    expect(value?.subjectCallables).toEqual(["quote"]);
    // The identifier tiers are untouched: the inherited data identifier is still there, just tried after quote.
    expect(value?.subjectIdentifiers).toEqual(["SAVE500"]);
    expect(value?.inheritedFromLead).toBe(true);
    expect(condition?.inheritedFromLead).toBe(true);
    expect(condition?.subjectCallables).toEqual(["quote"]);
  });

  it("a clause with its own identifiers keeps its own call-shaped names and never inherits the lead's", () => {
    const requirements = extractFacetRequirements("Explain how quote() works. What does tax() return when TAX_RATE is 0.08?");
    const value = requirements.find((r) => r.facet === "value" && r.clause.includes("tax()"));
    expect(value?.subjectCallables).toEqual(["tax"]);
    expect(value?.inheritedFromLead).toBe(false);
  });

  it("a query with no call syntax carries no subjectCallables field at all", () => {
    for (const query of [
      "What is the default timeout FetchWithRetry uses per attempt?",
      "Under what conditions does shouldRetry return true?",
      "Calculate the checkout total for coupon SAVE500 and three mugs.",
    ]) {
      for (const requirement of extractFacetRequirements(query)) {
        expect("subjectCallables" in requirement, `${query} -> ${JSON.stringify(requirement)}`).toBe(false);
      }
    }
  });
});

describe("a value question with input data keeps the callable it names as its focal", () => {
  it("the live first call, verbatim (directory target, content full): one hop, every file quote() needs", async () => {
    const ws = makeWorkspace("live");
    const walked = await walk(ws, {
      query: LIVE_QUERY,
      task: { epoch: "new", profile: "answer" },
      targets: [{ path: "src/checkout", purpose: "quote calculations, catalog pricing, discount eligibility/order, shipping/free-shipping, tax and rounding rules" }],
      content: "full",
    });
    expectOneHopAnswer("live", walked, QUOTE_MARKERS);
  }, 120_000);

  it("the repeat run's first call, verbatim: one hop, every file quote() needs", async () => {
    const ws = makeWorkspace("repeat");
    const walked = await walk(ws, { query: REPEAT_QUERY, task: { epoch: "new", profile: "answer" } });
    expectOneHopAnswer("repeat", walked, QUOTE_MARKERS);
  }, 120_000);

  it("the cart data without the output-field list (the variant that did not even serve quote.ts)", async () => {
    const ws = makeWorkspace("nofields");
    const walked = await walk(ws, { query: LIVE_QUERY_WITHOUT_FIELDS, task: { epoch: "new", profile: "answer" } });
    expectOneHopAnswer("nofields", walked, QUOTE_MARKERS);
  }, 120_000);

  // A guard, not a regression test: the pre-change build answers this query
  // with await_input too (coupons.ts as the focal through `TEN`, quote.ts as a
  // counterexample) -- measured against the r2 VSIX.
  it("a method call on a built-in (Math.floor()) never becomes the focal", async () => {
    const ws = makeWorkspace("builtin");
    const walked = await walk(ws, {
      query: "What exact discount does coupon TEN give on 4200 eligible yen, and does Math.floor() round it down?",
      task: { epoch: "new", profile: "answer" },
    });
    const first = walked.hops[0]!.body;
    expect(servedText(first), describeHops(walked.hops)).toContain("if(code==='TEN') return Math.min(600,Math.floor(eligibleAfterMember*0.10));");
    const whys = (Array.isArray(first["evidence"]) ? first["evidence"] : []).map((entry: any) => String(entry.why ?? ""));
    expect(whys.filter((why: string) => /\bfloor\b/.test(why)), describeHops(walked.hops)).toEqual([]);
  }, 120_000);
});

/** Every evidence row's `why`, for the review regressions below. */
function whysOf(body: Record<string, any>): string[] {
  return (Array.isArray(body["evidence"]) ? body["evidence"] : []).map((entry: any) => `${entry.path} [${entry.why ?? ""}]`);
}

describe("review regressions (2026-10-02)", () => {
  // P0: a workspace function named like a method the question calls on an
  // object (`res.json()` beside `http/json.ts`'s `json`) became the value
  // focal, and fetchUser's own constants were dropped.
  it("a method called on an object never displaces the function the question names", async () => {
    const ws = makeWorkspace("p0-json");
    const files: Record<string, string> = {
      "src/http/json.ts": "export function json(body: unknown, status = 200) {\n  return new Response(JSON.stringify(body), { status });\n}\n",
      "src/util/map.ts": "export function map<T, U>(items: T[], fn: (item: T) => U): U[] {\n  return items.map(fn);\n}\n",
      "src/api/config.ts": "export const BASE_URL = \"https://api.example.test\";\nexport const USER_FIELDS = [\"id\", \"name\"];\n",
      "src/api/users.ts": "import { BASE_URL, USER_FIELDS } from \"./config\";\nexport async function fetchUser(id: string) {\n  const res = await fetch(`${BASE_URL}/users/${id}`);\n  const body = await res.json();\n  return Object.fromEntries(USER_FIELDS.map((field) => [field, body[field]]));\n}\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), content, "utf8");
    }
    for (const query of ["What does res.json() return inside fetchUser()?", "What does USER_FIELDS.map() produce inside fetchUser()?"]) {
      resetAll();
      handleTable.reset();
      const walked = await walk(ws, { query, task: { epoch: "new", profile: "answer" } });
      const first = walked.hops[0]!.body;
      const whys = whysOf(first);
      expect(whys.filter((why) => /closure:value (json|map)\b/.test(why)), `${query}: ${describeHops(walked.hops)}`).toEqual([]);
      expect(servedText(first), `${query}: ${describeHops(walked.hops)}`).toContain("BASE_URL = \"https://api.example.test\"");
    }
  }, 120_000);

  // P1: a co-located test stub of the same name made the focal "declared in
  // 2 files", so its closure was never computed.
  it("a same-named stub in a test file never blocks the closure of the function the question names", async () => {
    const ws = makeWorkspace("p1-stub");
    fs.writeFileSync(path.join(ws, "src/checkout/quote.spec.ts"), "import { vi } from \"vitest\";\nconst quote = vi.fn(() => ({ total: 0 }));\nexport { quote };\n", "utf8");
    fs.mkdirSync(path.join(ws, "src/checkout/__tests__"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src/checkout/__tests__/quote.test.ts"), "export function quote() {\n  return { total: 1 };\n}\n", "utf8");
    for (const query of ["What does quote() return for an empty cart in src/checkout?", LIVE_QUERY]) {
      resetAll();
      handleTable.reset();
      const walked = await walk(ws, { query, task: { epoch: "new", profile: "answer" } });
      expectOneHopAnswer(query.slice(0, 40), walked, QUOTE_MARKERS);
      expect(whysOf(walked.hops[0]!.body).filter((why) => /quote\.(spec|test)\.ts/.test(why)), describeHops(walked.hops)).toEqual([]);
    }
  }, 120_000);
});
