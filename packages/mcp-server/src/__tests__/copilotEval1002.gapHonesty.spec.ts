/**
 * copilotEval1002.gapHonesty.spec.ts — VS Code Copilot standard-setup
 * evaluation (2026-10-02). The large task's pack served all ten checkout files
 * byte-for-byte, yet its act.answer certificate claimed
 *
 *   request-item-undetermined:condition:quote (shipping is read by quote but
 *   its declaration could not be resolved)
 *
 * — false: shipping.ts was in the same response. The return object's KEY
 * `shipping:` (the same name as the imported FUNCTION `shipping`) counted as a
 * value read, and the function's failed CONSTANT resolution was disclosed. Two
 * independent fixes, each pinned on its own below:
 *
 *   1. a TS/JS object-literal key is never a read (`isObjectLiteralKeyPosition`)
 *      — which also clears `return { MAX_RETRIES: 3 }` and an
 *      `export const LIMITS = { MAX_RETRIES: 3 }` initializer;
 *   2. an import proven to be a function/class/type is never a missing VALUE
 *      (readCodeTaskPack.ts `importedBindingIsCallableOrType`) — a callback
 *      `rows.map(normalize)`, directly or through a barrel re-export.
 *
 * The same certificate also certified two question words absent:
 * "points impact on free shipping eligibility" -> `request-item-absent:impact`
 * and "Need discount ordering, ..." -> `request-item-absent:Need`.
 *
 * Recall controls: a ternary middle, a `case` label, a computed key, an object
 * VALUE and a Python dict key stay reads; an unresolvable package value read
 * and a genuinely absent quoted identifier are still disclosed.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  constantLikeReferencesIn,
  declarationCarriesNoConstantValue,
  hasValuePositionOccurrence,
  isObjectLiteralKeyPosition,
} from "../features/task-pack/evidenceClosure.js";
import { isLiteralEligibleTerm, topicNounPhraseWords } from "../features/task-pack/requestItems.js";
import { isFacetDescriptorTerm } from "../features/task-pack/requestFacets.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  collectDisclosureTexts,
  anyEvidenceContains,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import { COPILOT_CHECKOUT_FILES, COPILOT_EVAL_QUERY, COPILOT_EVAL_TARGET_FILES } from "./helpers/copilotCheckoutFixture.js";

const HOME = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
const tmpDirs: string[] = [];
const servers: ServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.kill();
});
afterAll(async () => {
  for (const server of servers.splice(0)) await server.kill();
  for (const dir of tmpDirs.splice(0)) {
    try {
      await rmDirWithRetry(dir);
    } catch {
      /* best-effort cleanup */
    }
  }
});

function workspace(files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-cp1002-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

/** One task_pack call, followed to its end, under the measured host's own env (`vscode` config). */
async function ask(ws: string, args: Record<string, unknown>) {
  const server = startDevServer(ws, "vscode", { toolSurface: "full" });
  servers.push(server);
  await server.initialize();
  const chain = await followNextToEnd(server, { tool: "tl_read_file", arguments: { ...args, cwd: ws } }, { cwd: ws, hopCap: 6 });
  return { chain, disclosures: collectDisclosureTexts(chain) };
}

/** Every disclosure naming `word` as a whole word (case-sensitive). */
function disclosuresNaming(disclosures: readonly string[], word: string): string[] {
  const re = new RegExp(`(?<![\\w$])${word}(?![\\w$])`);
  return disclosures.filter((text) => re.test(text));
}

function indexOfNth(line: string, token: string, nth = 0): number {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = line.indexOf(token, at + 1);
  return at;
}

// ---------------------------------------------------------------------------
// 1. Unit: the positional key test and the two scans that use it.
// ---------------------------------------------------------------------------

describe("isObjectLiteralKeyPosition — a TS/JS object key names a property, never a binding", () => {
  it("the measured return-object keys, and CONST_CASE keys", () => {
    const measured = " return {subtotal,memberOff,couponOff,pointsOff,shipping:delivery,tax:taxAmount,total:discounted-pointsOff+delivery+taxAmount};";
    expect(isObjectLiteralKeyPosition(measured, indexOfNth(measured, "shipping"), "shipping", "")).toBe(true);
    expect(isObjectLiteralKeyPosition(measured, indexOfNth(measured, "tax:"), "tax", "")).toBe(true);
    const keyed = "  return { MAX_RETRIES: 3, BACKOFF_MS: 250 };";
    expect(isObjectLiteralKeyPosition(keyed, indexOfNth(keyed, "MAX_RETRIES"), "MAX_RETRIES", "")).toBe(true);
    expect(isObjectLiteralKeyPosition(keyed, indexOfNth(keyed, "BACKOFF_MS"), "BACKOFF_MS", "")).toBe(true);
  });

  it("a key that opens its own line (after `{` or `,` on the line before), and an optional property", () => {
    expect(isObjectLiteralKeyPosition("  MAX_RETRIES: 3,", 2, "MAX_RETRIES", "{")).toBe(true);
    expect(isObjectLiteralKeyPosition("  BACKOFF_MS: 250", 2, "BACKOFF_MS", ",")).toBe(true);
    const optional = "type Opts = { retries?: number };";
    expect(isObjectLiteralKeyPosition(optional, indexOfNth(optional, "retries"), "retries", "")).toBe(true);
  });

  it("reads stay reads: a ternary middle, a case label, a computed key, an object VALUE, a `::` path", () => {
    const ternary = "const n = cond ? RETRY_LIMIT : 0;";
    expect(isObjectLiteralKeyPosition(ternary, indexOfNth(ternary, "RETRY_LIMIT"), "RETRY_LIMIT", "")).toBe(false);
    expect(isObjectLiteralKeyPosition("  RETRY_LIMIT : 0;", 2, "RETRY_LIMIT", "?")).toBe(false);
    const caseLabel = "  case RETRY_LIMIT: return true;";
    expect(isObjectLiteralKeyPosition(caseLabel, indexOfNth(caseLabel, "RETRY_LIMIT"), "RETRY_LIMIT", "{")).toBe(false);
    const computed = "const m = { [RETRY_LIMIT]: 1 };";
    expect(isObjectLiteralKeyPosition(computed, indexOfNth(computed, "RETRY_LIMIT"), "RETRY_LIMIT", "")).toBe(false);
    const value = "const o = { limit: RETRY_LIMIT };";
    expect(isObjectLiteralKeyPosition(value, indexOfNth(value, "RETRY_LIMIT"), "RETRY_LIMIT", "")).toBe(false);
    const scoped = "{ Config::LIMIT }";
    expect(isObjectLiteralKeyPosition(scoped, indexOfNth(scoped, "Config"), "Config", "")).toBe(false);
  });
});

describe("constantLikeReferencesIn / hasValuePositionOccurrence skip keys in TS/JS only", () => {
  const tsBody = [
    "export function quote(input: Input) {",
    " const delivery = shipping(input);",
    " return {subtotal, shipping: delivery, MAX_RETRIES: 3, limit: RETRY_LIMIT};",
    "}",
  ];

  it("TS: a key is never a candidate; a shorthand property, an object value and a call stay candidates", () => {
    const candidates = constantLikeReferencesIn(tsBody, false, "quote", new Set(), "src/checkout/quote.ts");
    expect(candidates).not.toContain("MAX_RETRIES");
    expect(candidates).toContain("subtotal");
    expect(candidates).toContain("RETRY_LIMIT");
    expect(candidates).toContain("shipping");
  });

  it("TS: the measured name is read only as a callee and a key, so it is no VALUE read; without a path the key still counts (opt-in)", () => {
    expect(hasValuePositionOccurrence(tsBody, false, "shipping", "src/checkout/quote.ts")).toBe(false);
    expect(hasValuePositionOccurrence(tsBody, false, "shipping")).toBe(true);
    expect(hasValuePositionOccurrence(tsBody, false, "subtotal", "src/checkout/quote.ts")).toBe(true);
  });

  it("an initializer scanned with only the key path keeps every key out", () => {
    const initializer = ["export const LIMITS = {", "  MAX_RETRIES: 3,", "  BACKOFF_MS: BASE_MS * 2,", "};"];
    const candidates = constantLikeReferencesIn(initializer, false, "LIMITS", new Set(), undefined, "src/limits.ts");
    expect(candidates).not.toContain("MAX_RETRIES");
    expect(candidates).not.toContain("BACKOFF_MS");
    expect(candidates).toContain("BASE_MS");
  });

  it("Python: a dict key IS a read (`{RETRY_LIMIT: on_retry}` reads RETRY_LIMIT)", () => {
    const pyBody = ["def handlers():", "    return {RETRY_LIMIT: on_retry}"];
    expect(constantLikeReferencesIn(pyBody, true, "handlers", new Set(), "app/handlers.py")).toContain("RETRY_LIMIT");
  });
});

// Review 2026-10-02: the parser files enums, interfaces, structs and traits
// all under "class"; only declarations that cannot hold a value are exempt.
describe("declarationCarriesNoConstantValue — what an imported binding resolves to", () => {
  it("a function, method, type alias, interface, trait, protocol or const-bound arrow holds no constant value", () => {
    expect(declarationCarriesNoConstantValue("function", ["export function shipping(cart: Cart): number {"], false)).toBe(true);
    expect(declarationCarriesNoConstantValue("method", ["  quote(): number {"], false)).toBe(true);
    expect(declarationCarriesNoConstantValue("type", ["export type Cart = { lines: Line[] };"], false)).toBe(true);
    expect(declarationCarriesNoConstantValue("class", ["export interface Shape {", "  area(): number;", "}"], false)).toBe(true);
    expect(declarationCarriesNoConstantValue("class", ["@Deprecated", "public interface Pricing {"], false)).toBe(true);
    expect(declarationCarriesNoConstantValue("class", ["pub trait Priced {"], false)).toBe(true);
    expect(declarationCarriesNoConstantValue("class", ["fun interface Rule {"], false)).toBe(true);
    expect(declarationCarriesNoConstantValue("const", ["export const normalize = (x: number): number => x;"], false)).toBe(true);
    expect(declarationCarriesNoConstantValue("const", ["export const settle = async (x: number) => x;"], false)).toBe(true);
  });

  it("a class, enum, struct, object, record or plain constant may hold the value a question needs", () => {
    expect(declarationCarriesNoConstantValue("class", ["export enum Status {", "  PAID = 'paid',", "}"], false)).toBe(false);
    expect(declarationCarriesNoConstantValue("class", ["enum class Color { RED, GREEN }"], false)).toBe(false);
    expect(declarationCarriesNoConstantValue("class", ["export class Limits {", "  static readonly MAX = 5;", "}"], false)).toBe(false);
    expect(declarationCarriesNoConstantValue("class", ["pub struct Config {"], false)).toBe(false);
    expect(declarationCarriesNoConstantValue("class", ["object Limits {", "  const val MAX = 5", "}"], false)).toBe(false);
    expect(declarationCarriesNoConstantValue("class", ["public record Point(int x, int y) {"], false)).toBe(false);
    expect(declarationCarriesNoConstantValue("const", ["export const LIMITS = { MAX_RETRIES: 3 };"], false)).toBe(false);
    expect(declarationCarriesNoConstantValue("const", ["export const fmt = makeFormatter();"], false)).toBe(false);
  });
});

describe("question words are not request subjects", () => {
  it("'Need …' leads a request like 'List …'; 'impact'/'effect' name the kind of answer", () => {
    expect([...topicNounPhraseWords("Need discount ordering")]).not.toContain("need");
    expect(isFacetDescriptorTerm("impact")).toBe(true);
    expect(isFacetDescriptorTerm("effects")).toBe(true);
    const clause = "points impact on free shipping eligibility";
    const eligible = [...topicNounPhraseWords(clause)].filter((word) => isLiteralEligibleTerm(word, clause));
    expect(eligible).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. End to end (spawned dev server, the measured host's env).
// ---------------------------------------------------------------------------

describe("Copilot evaluation 2026-10-02 — the certificate names no false gap", () => {
  it("the evaluator's verbatim call: act.answer, all ten files, no gap naming shipping, impact or Need", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { chain, disclosures } = await ask(ws, {
      query: COPILOT_EVAL_QUERY,
      targets: COPILOT_EVAL_TARGET_FILES.map((file) => ({ path: file })),
      task: { epoch: "new", profile: "answer" },
    });
    const first = chain.hops[0]?.response as Record<string, any> | undefined;
    expect(first?.["decision"]?.["kind"], JSON.stringify(first?.["decision"])).toBe("act.answer");
    for (const word of ["shipping", "impact", "Need"]) {
      expect(disclosuresNaming(disclosures, word), JSON.stringify(disclosures)).toEqual([]);
    }
    const served = new Set(((first?.["evidence"] ?? []) as Array<{ path?: string }>).map((row) => row.path));
    for (const file of COPILOT_EVAL_TARGET_FILES) expect(served.has(file), `${file} not served`).toBe(true);
  }, 60_000);

  it("an imported FUNCTION read as a value — a callback, directly or through a barrel — is not an unresolved constant", async () => {
    const ws = workspace({
      "src/format.ts": "export function normalize<T>(x: T): T { return x; }\n",
      "src/index.ts": "export { normalize } from './format';\n",
      "src/rates.ts": "export const SURCHARGE = 700;\n",
      "src/report.ts": [
        "import { normalize } from './format';",
        "import { normalize as viaBarrel } from './index';",
        "import { SURCHARGE } from './rates';",
        "export function report(rows: number[]): number[] {",
        "  return rows.map(normalize).map(viaBarrel).map((row) => row + SURCHARGE);",
        "}",
      ].join("\n") + "\n",
    });
    const { chain, disclosures } = await ask(ws, { query: "What value does report() add to each row?", task: { epoch: "new", profile: "answer" } });
    expect(disclosuresNaming(disclosures, "normalize"), JSON.stringify(disclosures)).toEqual([]);
    expect(disclosuresNaming(disclosures, "viaBarrel"), JSON.stringify(disclosures)).toEqual([]);
    expect(anyEvidenceContains(chain, ["SURCHARGE = 700"]), "the real constant was never served").toBe(true);
  }, 60_000);

  // Review 2026-10-02: the most common TS spelling of a function — a const
  // bound to an arrow (the parser files it as a `const`).
  it("an imported const-bound arrow function read as a value is not an unresolved constant either", async () => {
    const ws = workspace({
      "src/format.ts": "export const normalize = (x: number): number => x;\nexport const settle = async (x: number): Promise<number> => x;\n",
      "src/rates.ts": "export const SURCHARGE = 700;\n",
      "src/report.ts": [
        "import { normalize, settle } from './format';",
        "import { SURCHARGE } from './rates';",
        "export function report(rows: number[]): number[] {",
        "  const steps = [normalize, settle];",
        "  return rows.map(normalize).map((row) => row + SURCHARGE + steps.length);",
        "}",
      ].join("\n") + "\n",
    });
    const { chain, disclosures } = await ask(ws, { query: "What value does report() add to each row?", task: { epoch: "new", profile: "answer" } });
    expect(disclosuresNaming(disclosures, "normalize"), JSON.stringify(disclosures)).toEqual([]);
    expect(disclosuresNaming(disclosures, "settle"), JSON.stringify(disclosures)).toEqual([]);
    expect(anyEvidenceContains(chain, ["SURCHARGE = 700"]), "the real constant was never served").toBe(true);
  }, 60_000);

  it("CONST_CASE keys of a returned object, and of a constant's own multi-line initializer, are not reads", async () => {
    const ws = workspace({
      "src/defaults.ts": "export function retryDefaults() {\n  return { MAX_RETRIES: 3, BACKOFF_MS: 250, jitter: true };\n}\n",
      "src/limits.ts": "export const LIMITS = {\n  MAX_RETRIES: 3,\n  BACKOFF_MS: 250,\n};\n",
      "src/retry.ts": "import { LIMITS } from './limits';\nexport function retryBudget(): number {\n  return LIMITS.MAX_RETRIES * LIMITS.BACKOFF_MS;\n}\n",
    });
    const returned = await ask(ws, { query: "What values does retryDefaults() return?", task: { epoch: "new", profile: "answer" } });
    expect(disclosuresNaming(returned.disclosures, "MAX_RETRIES"), JSON.stringify(returned.disclosures)).toEqual([]);
    const initialized = await ask(ws, { query: "What value does retryBudget() return?", task: { epoch: "new", profile: "answer" } });
    expect(disclosuresNaming(initialized.disclosures, "MAX_RETRIES"), JSON.stringify(initialized.disclosures)).toEqual([]);
    expect(disclosuresNaming(initialized.disclosures, "BACKOFF_MS"), JSON.stringify(initialized.disclosures)).toEqual([]);
    expect(anyEvidenceContains(initialized.chain, ["MAX_RETRIES: 3"]), "LIMITS was never served").toBe(true);
  }, 90_000);

  it("recall control: a value imported from a package that cannot be resolved is still disclosed", async () => {
    const ws = workspace({
      "src/client.ts": "import { DEFAULT_TIMEOUT } from '@acme/http-defaults';\nexport function timeoutFor(): number {\n  return DEFAULT_TIMEOUT;\n}\n",
    });
    const { disclosures } = await ask(ws, { query: "What is the default value returned by timeoutFor()?", task: { epoch: "new", profile: "answer" } });
    expect(disclosuresNaming(disclosures, "DEFAULT_TIMEOUT").length, JSON.stringify(disclosures)).toBeGreaterThan(0);
  }, 60_000);

  it("recall control: a quoted, genuinely absent identifier is still certified absent", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(ws, {
      query: "Explain the discount ordering in quote(), and whether the identifier `NO_SUCH_TOKEN_4471` exists.",
      task: { epoch: "new", profile: "answer" },
    });
    const absent = disclosures.find((text) => text.includes("request-item-absent") && text.includes("NO_SUCH_TOKEN_4471"));
    expect(absent, JSON.stringify(disclosures)).toBeDefined();
  }, 60_000);
});
