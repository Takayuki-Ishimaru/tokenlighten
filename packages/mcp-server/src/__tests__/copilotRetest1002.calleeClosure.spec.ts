/**
 * copilotRetest1002.calleeClosure.spec.ts — Copilot standard-setup retest
 * (2026-10-02): an answer pack about what a callable RETURNS or COMPUTES
 * carries that callable's callees and the constants they read before it
 * certifies `act.answer`.
 *
 * Measured on the evaluator's fixture: "What exact delay sequence does
 * retrySchedule return and why?" certified act.answer from worker.ts +
 * config.ts without backoff.ts (the formula), and a quote() value question
 * certified act.answer from two of its six callees (the callee list was cut
 * at MAX_CALLEES_PER_REQUIREMENT names and the 6-surface cap dropped the
 * rest). Fresh fixtures here, names used nowhere else — the rule is general:
 *   1. a computed-value question mints the value facet, and its closure
 *      requires every direct in-workspace callee body plus every constant
 *      those callees read;
 *   2. a hub with six small callees closes in ONE hop (the windows fit the
 *      closure byte budget; the distinct-surface cap no longer drops them);
 *   3. more callees than the ceiling => the facet is disclosed, never
 *      covered by the callees that fit;
 *   4. callee bodies past the byte budget => no act.answer before a
 *      followed `next` delivered them.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
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

function makeWorkspace(tag: string, files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, `.tl-cr1002-${tag}-`));
  tmpDirs.push(ws);
  const unrelated: Record<string, string> = {};
  for (let i = 0; i < 6; i++) {
    unrelated[`src/misc/helper${i}.ts`] = `export function formatLabel${i}(name: string): string {\n  return name.trim().toUpperCase() + "-${i}";\n}\n`;
  }
  for (const [rel, content] of Object.entries({ "package.json": "{\"name\":\"cr1002\",\"private\":true,\"type\":\"module\"}\n", ...unrelated, ...files })) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
  return ws;
}

interface Hop {
  readonly body: Record<string, any>;
  readonly bytes: number;
}

function nextOf(response: Record<string, any>): { tool: string; arguments: Record<string, unknown> } | undefined {
  for (const candidate of [response["decision"]?.next, response["next"], response["limit"]?.next]) {
    if (candidate !== undefined && typeof candidate?.tool === "string") return candidate;
  }
  return undefined;
}

async function inProcess(ws: string, tool: string, args: Record<string, unknown>): Promise<Hop> {
  const response = await callTool(tool, { ...args, cwd: ws });
  const text = response.content[0]?.type === "text" ? response.content[0].text : "{}";
  return { body: JSON.parse(text) as Record<string, any>, bytes: Buffer.byteLength(text, "utf8") };
}

async function walk(ws: string, first: Record<string, unknown>, hopCap = 8): Promise<{ hops: Hop[]; capped: boolean }> {
  const hops: Hop[] = [];
  let call: { tool: string; arguments: Record<string, unknown> } | undefined = { tool: "tl_read_file", arguments: first };
  while (call !== undefined) {
    if (hops.length >= hopCap) return { hops, capped: true };
    const hop = await inProcess(ws, call.tool, call.arguments);
    hops.push(hop);
    call = nextOf(hop.body);
  }
  return { hops, capped: false };
}

/** Every body this hop put on the wire (evidence bodies and batch contents). */
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
      `${entry.path}:${entry.range}${typeof entry.body === "string" ? "" : "(nobody)"}`),
    next: nextOf(hop.body)?.arguments,
  })));
}

/** No hop certifies act.answer before every marker reached the client in THIS chain; the chain ends on its own and delivers them all. */
function expectHonestChain(label: string, walked: { hops: Hop[]; capped: boolean }, markers: readonly string[]): void {
  expect(walked.capped, `[${label}] the chain must end on its own: ${describeHops(walked.hops)}`).toBe(false);
  let delivered = "";
  for (const [index, hop] of walked.hops.entries()) {
    delivered += `\n${servedText(hop.body)}`;
    if (hop.body["decision"]?.kind !== "act.answer") continue;
    for (const marker of markers) {
      expect(delivered.includes(marker), `[${label}] hop ${index} is act.answer before "${marker}" reached the client: ${describeHops(walked.hops)}`).toBe(true);
    }
  }
  for (const marker of markers) {
    expect(delivered, `[${label}] "${marker}" must reach the client: ${describeHops(walked.hops)}`).toContain(marker);
  }
}

// ---------------------------------------------------------------------------
// 1. A value question about a callable that delegates its arithmetic.
// ---------------------------------------------------------------------------

const PULSE_FILES: Readonly<Record<string, string>> = {
  "src/settings.ts": "export const PULSE_COUNT = 3;\nexport const PULSE_BASE_MS = 125;\nexport const PULSE_CAP_MS = 1000;\n",
  // A deliberately unusual formula: an answer that guesses exponential backoff from the names is wrong.
  "src/gap.ts": "import { PULSE_BASE_MS, PULSE_CAP_MS } from \"./settings\";\nexport function gapFor(step: number): number {\n  return Math.min(PULSE_CAP_MS, PULSE_BASE_MS + 7 * (step + 1));\n}\n",
  "src/pulse.ts": "import { PULSE_COUNT } from \"./settings\";\nimport { gapFor } from \"./gap\";\nexport function pulsePlan(): number[] {\n  return Array.from({ length: PULSE_COUNT }, (_, i) => gapFor(i));\n}\n",
};
const PULSE_MARKERS = ["PULSE_BASE_MS + 7 * (step + 1)", "PULSE_COUNT = 3", "PULSE_BASE_MS = 125", "PULSE_CAP_MS = 1000", "gapFor(i)"];

describe("a computed-value question carries the callee that computes it", () => {
  it("'what exact delay sequence does pulsePlan return' serves gapFor's body and every constant it reads, in the first hop", async () => {
    const ws = makeWorkspace("pulse", PULSE_FILES);
    const walked = await walk(ws, {
      query: "What exact delay sequence does pulsePlan return and why? Cite the constants and functions that determine it.",
      task: { epoch: "new", profile: "answer" },
    });
    expectHonestChain("pulse", walked, PULSE_MARKERS);
    const first = walked.hops[0]!.body;
    expect(first["decision"]?.kind, describeHops(walked.hops)).toBe("act.answer");
    for (const marker of PULSE_MARKERS) expect(servedText(first), describeHops(walked.hops)).toContain(marker);
  }, 120_000);

  // The evaluator's own wording. Its "configuration" clause is a definition
  // request item that this fixture (constants in settings.ts, no config-named
  // file) answers only after extra hops -- a request-item matter outside this
  // file's rule, so only the honesty of the chain is pinned here.
  it("the evaluator's wording, without a declared profile, never certifies before the callee and constants arrive", async () => {
    const ws = makeWorkspace("pulse-auto", PULSE_FILES);
    const walked = await walk(ws, {
      query: "What exact delay sequence does pulsePlan return and why? Cite the configuration and functions that determine it.",
      task: { epoch: "new" },
    });
    expectHonestChain("pulse-auto", walked, PULSE_MARKERS);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. A hub that delegates to six small callees.
// ---------------------------------------------------------------------------

const INVOICE_FILES: Readonly<Record<string, string>> = {
  "src/billing/constants.ts": "export const FREE_DELIVERY_AT = 5000;\nexport const DELIVERY_FEE = 450;\nexport const RUSH_FEE = 700;\nexport const LOYALTY_RATE = 0.10;\nexport const SALES_TAX = 0.08;\nexport const CREDIT_UNIT = 2;\n",
  "src/billing/catalogue.ts": "export const catalogue: Record<string, { price: number; taxable: boolean }> = {\n  pen: { price: 1200, taxable: true },\n  gift: { price: 2000, taxable: false },\n};\n",
  "src/billing/items.ts": "import { catalogue } from './catalogue';\nexport function itemRows(skus: string[]) {\n  return skus.map((sku) => ({ amount: catalogue[sku]!.price, taxable: catalogue[sku]!.taxable }));\n}\n",
  "src/billing/loyalty.ts": "import { LOYALTY_RATE } from './constants';\nexport function loyaltyOff(amount: number, member: boolean) {\n  return member ? Math.floor(amount * LOYALTY_RATE) : 0;\n}\n",
  "src/billing/promo.ts": "export function promoOff(code: string | undefined, amount: number) {\n  if (code === 'SPRING') return amount >= 3000 ? 400 : 0;\n  return 0;\n}\n",
  "src/billing/credits.ts": "import { CREDIT_UNIT } from './constants';\nexport function creditOff(credits: number, amount: number) {\n  return Math.min(credits * CREDIT_UNIT, Math.floor(amount / 4));\n}\n",
  "src/billing/delivery.ts": "import { FREE_DELIVERY_AT, DELIVERY_FEE, RUSH_FEE } from './constants';\nexport function deliveryCost(amount: number, rush: boolean) {\n  return (amount >= FREE_DELIVERY_AT ? 0 : DELIVERY_FEE) + (rush ? RUSH_FEE : 0);\n}\n",
  "src/billing/tax.ts": "import { SALES_TAX } from './constants';\nexport function salesTax(amount: number, delivery: number) {\n  return Math.floor((amount + delivery) * SALES_TAX);\n}\n",
  "src/billing/invoice.ts": [
    "import { itemRows } from './items';",
    "import { loyaltyOff } from './loyalty';",
    "import { promoOff } from './promo';",
    "import { creditOff } from './credits';",
    "import { deliveryCost } from './delivery';",
    "import { salesTax } from './tax';",
    "export function invoiceTotal(skus: string[], member: boolean, code: string | undefined, credits: number, rush: boolean) {",
    "  const rows = itemRows(skus);",
    "  const subtotal = rows.reduce((s, r) => s + r.amount, 0);",
    "  const loyalty = loyaltyOff(subtotal, member);",
    "  const promo = promoOff(code, subtotal - loyalty);",
    "  const discounted = subtotal - loyalty - promo;",
    "  const credit = creditOff(credits, discounted);",
    "  const delivery = deliveryCost(discounted, rush);",
    "  const tax = salesTax(discounted - credit, delivery);",
    "  return { subtotal, loyalty, promo, credit, delivery, tax, total: discounted - credit + delivery + tax };",
    "}",
    "",
  ].join("\n"),
};
const INVOICE_CALLEE_MARKERS = [
  "catalogue[sku]!.price",
  "Math.floor(amount * LOYALTY_RATE)",
  "code === 'SPRING'",
  "credits * CREDIT_UNIT",
  "amount >= FREE_DELIVERY_AT ? 0 : DELIVERY_FEE",
  "(amount + delivery) * SALES_TAX",
];
const INVOICE_CONSTANT_MARKERS = [
  "FREE_DELIVERY_AT = 5000",
  "DELIVERY_FEE = 450",
  "RUSH_FEE = 700",
  "LOYALTY_RATE = 0.10",
  "SALES_TAX = 0.08",
  "CREDIT_UNIT = 2",
];

describe("a hub's whole callee set, not its first three", () => {
  it("'calculate the exact invoiceTotal() result' serves all six callees and every constant they read, in one hop", async () => {
    const ws = makeWorkspace("invoice", INVOICE_FILES);
    const walked = await walk(ws, {
      query: "Calculate the exact invoiceTotal() result for skus [pen, gift], member true, code SPRING, credits 100, rush false. Cite the files and lines that determine it.",
      task: { epoch: "new", profile: "answer" },
    });
    expectHonestChain("invoice-value", walked, [...INVOICE_CALLEE_MARKERS, ...INVOICE_CONSTANT_MARKERS]);
    const first = walked.hops[0]!.body;
    expect(first["decision"]?.kind, describeHops(walked.hops)).toBe("act.answer");
    for (const marker of [...INVOICE_CALLEE_MARKERS, ...INVOICE_CONSTANT_MARKERS]) {
      expect(servedText(first), describeHops(walked.hops)).toContain(marker);
    }
  }, 120_000);

  it("a flow question over the same hub requires every callee, not the first three", async () => {
    const ws = makeWorkspace("invoice-flow", INVOICE_FILES);
    const walked = await walk(ws, {
      query: "In what order does invoiceTotal() apply loyalty, promo codes, credits, delivery and tax? Walk me through each step.",
      task: { epoch: "new", profile: "answer" },
    });
    expectHonestChain("invoice-flow", walked, INVOICE_CALLEE_MARKERS);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. More callees than the ceiling.
// ---------------------------------------------------------------------------

describe("a callee list past the ceiling is disclosed, never covered", () => {
  it("a value question over a callable with 18 in-workspace callees does not certify a clean act.answer", async () => {
    const files: Record<string, string> = {};
    const imports: string[] = [];
    const calls: string[] = [];
    for (let i = 0; i < 18; i++) {
      files[`src/steps/step${i}.ts`] = `export function stage${i}(x: number): number {\n  return x + ${101 + i};\n}\n`;
      imports.push(`import { stage${i} } from './steps/step${i}';`);
      calls.push(`stage${i}(x)`);
    }
    files["src/pipeline.ts"] = `${imports.join("\n")}\nexport function runStages(x: number): number {\n  return ${calls.join(" + ")};\n}\n`;
    const ws = makeWorkspace("ceiling", files);
    const walked = await walk(ws, { query: "What does runStages(1) return?", task: { epoch: "new", profile: "answer" } });
    // The cut is disclosed in the FIRST hop (never only after the callees that
    // fit were fetched over further hops), and no hop certifies it away.
    const firstGaps = JSON.stringify(walked.hops[0]!.body["decision"]?.certificate?.gaps ?? walked.hops[0]!.body["decision"]?.gaps ?? []);
    expect(firstGaps, describeHops(walked.hops)).toMatch(/undetermined/);
    expect(firstGaps, describeHops(walked.hops)).toMatch(/facet-1|runStages/);
    for (const hop of walked.hops) {
      const gaps = JSON.stringify(hop.body["decision"]?.certificate?.gaps ?? hop.body["decision"]?.gaps ?? []);
      if (hop.body["decision"]?.kind === "act.answer") expect(gaps, describeHops(walked.hops)).toMatch(/undetermined/);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. Callee bodies past the closure byte budget.
// ---------------------------------------------------------------------------

describe("callee bodies past the byte budget are delivered before act.answer", () => {
  it("five ~2.2 KB callees: no hop certifies before every callee tail reached the client", async () => {
    const files: Record<string, string> = {};
    const imports: string[] = [];
    const calls: string[] = [];
    const tails: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const body = [`export function part${i}(x: number): number {`];
      for (let k = 0; k < 40; k++) body.push(`  x = x + ${i}; // pad ${i}-${k} ${"q".repeat(36)}`);
      body.push(`  return x * ${i}; // tail-of-part${i}`, "}", "");
      files[`src/parts/part${i}.ts`] = body.join("\n");
      imports.push(`import { part${i} } from './parts/part${i}';`);
      calls.push(`part${i}(x)`);
      tails.push(`tail-of-part${i}`);
    }
    files["src/assemble.ts"] = `${imports.join("\n")}\nexport function assemble(x: number): number {\n  return ${calls.join(" + ")};\n}\n`;
    const ws = makeWorkspace("budget", files);
    const walked = await walk(ws, { query: "What does assemble(2) return? Cite every function involved.", task: { epoch: "new", profile: "answer" } });
    expectHonestChain("budget", walked, tails);
    // The same callees under a FLOW question: every callee is required there
    // too, so no hop may certify before the tails that did not fit arrived.
    const flowWs = makeWorkspace("budget-flow", files);
    const flowWalked = await walk(flowWs, { query: "In what order does assemble() call its parts? Walk me through each step.", task: { epoch: "new", profile: "answer" } });
    expectHonestChain("budget-flow", flowWalked, tails);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 5. The independent review's reproductions (2026-10-02).
// ---------------------------------------------------------------------------

describe("review regressions: constants past the cap, second-layer constants, arrow functions", () => {
  it("P0: a hub whose callees read more constants than one pass carries never certifies from the ones that fit", async () => {
    const files: Record<string, string> = {};
    const constLines: string[] = [];
    const imports: string[] = [];
    const calls: string[] = [];
    const markers: string[] = [];
    // 14 callees x 2 constants = 28 > MAX_PLANNED_CONSTANT_WINDOWS (24).
    for (let i = 1; i <= 14; i++) {
      constLines.push(`export const ALPHA_${i} = ${100 + i};`, `export const BETA_${i} = ${200 + i};`);
      files[`src/hub/part${i}.ts`] = `import { ALPHA_${i}, BETA_${i} } from './consts';\nexport function part${i}(x: number): number {\n  return x * ALPHA_${i} + BETA_${i};\n}\n`;
      imports.push(`import { part${i} } from './part${i}';`);
      calls.push(`part${i}(x)`);
      markers.push(`ALPHA_${i} = ${100 + i}`, `BETA_${i} = ${200 + i}`);
    }
    files["src/hub/consts.ts"] = `${constLines.join("\n")}\n`;
    files["src/hub/total.ts"] = `${imports.join("\n")}\nexport function hubTotal(x: number): number {\n  return ${calls.join(" + ")};\n}\n`;
    const ws = makeWorkspace("p0-consts", files);
    const walked = await walk(ws, { query: "What does hubTotal(2) return? Cite every constant that determines it.", task: { epoch: "new", profile: "answer" } });
    expect(walked.capped, describeHops(walked.hops)).toBe(false);
    let delivered = "";
    for (const hop of walked.hops) {
      delivered += `\n${servedText(hop.body)}`;
      if (hop.body["decision"]?.kind !== "act.answer") continue;
      const gaps = JSON.stringify(hop.body["decision"]?.certificate?.gaps ?? []);
      // Either every constant reached the client, or the certificate says the scan was cut.
      const allDelivered = markers.every((marker) => delivered.includes(marker));
      expect(allDelivered || /undetermined/.test(gaps), `act.answer with constants missing and no disclosure: ${describeHops(walked.hops)}`).toBe(true);
    }
  }, 120_000);

  it("P1: a required second-layer callee arrives with the constants it reads", async () => {
    const ws = makeWorkspace("p1-deep", {
      "src/deep/rates.ts": "export const DEEP_RATE = 37;\n",
      "src/deep/scale.ts": "import { DEEP_RATE } from './rates';\nexport function deepScale(x: number): number {\n  return x * DEEP_RATE;\n}\n",
      "src/deep/step.ts": "import { deepScale } from './scale';\nexport function stepValue(x: number): number {\n  return deepScale(x) + 1;\n}\n",
      "src/deep/hub.ts": "import { stepValue } from './step';\nexport function hubValue(x: number): number {\n  return stepValue(x) * 2;\n}\n",
    });
    const walked = await walk(ws, { query: "What does hubValue(3) return? Cite the constants that determine it.", task: { epoch: "new", profile: "answer" } });
    expectHonestChain("p1-deep", walked, ["deepScale(x) + 1", "x * DEEP_RATE", "DEEP_RATE = 37"]);
  }, 120_000);

  it("P1: an arrow-function hub and arrow-function callees are followed like functions", async () => {
    const ws = makeWorkspace("p1-arrow", {
      "src/arrow/consts.ts": "export const ARROW_A = 13;\nexport const ARROW_B = 17;\n",
      "src/arrow/parts.ts": "import { ARROW_A, ARROW_B } from './consts';\nexport const partA = (x: number): number => x * ARROW_A;\nexport function partB(x: number): number {\n  return x + ARROW_B;\n}\n",
      "src/arrow/hub.ts": "import { partA, partB } from './parts';\nexport const hubArrow = (x: number): number => partA(x) + partB(x);\n",
    });
    const walked = await walk(ws, { query: "What does hubArrow(2) return? Cite the functions and constants involved.", task: { epoch: "new", profile: "answer" } });
    expectHonestChain("p1-arrow", walked, ["x * ARROW_A", "x + ARROW_B", "ARROW_A = 13", "ARROW_B = 17"]);
  }, 120_000);
});
