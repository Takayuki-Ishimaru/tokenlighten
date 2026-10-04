/**
 * evaluation0929.literalAbsenceEligibility.spec.ts — WP-C2 (eval-0929 §6/§8,
 * rule 1): structural literal-absence eligibility. `request-item-absent:
 * <term>` (a verified "no occurrence in scanned workspace files" claim) may
 * be certified ONLY for a term that is (a) an explicitly quoted string,
 * (b) code-shaped (camelCase/PascalCase/snake_case/SCREAMING_SNAKE/
 * dotted-or-::-qualified/$@-prefixed/file-path-shaped), or (c) the term's
 * own clause is an explicit existence/definition/use check — decided
 * STRUCTURALLY (`isCodeShapedTerm`/`clauseAsksExistence`/
 * `quotedOccurrenceInText`/`isLiteralEligibleTerm`, requestItems.ts), never
 * from a vocabulary list. This supersedes WP-C's own word-list fix
 * (GENERIC_SOFTWARE_ABSENCE_WORDS/GENERIC_JA_ABSENCE_WORDS), which the
 * orchestrator's blind held-out set showed does not generalize: an ordinary
 * verb ("give"), adjective ("missing"/"denied"), content verb ("cause"), a
 * slash-joined phrase of ordinary words, an identifier glued to a plain
 * word, and a whole unsegmented Japanese clause all still leaked as
 * `request-item-absent:<word>` after that fix landed.
 *
 * Two layers, per the brief's rule 6:
 *   1. Unit tests directly on the eligibility predicate (EN/JA, each
 *      admitted category, and the composite-decomposition rule).
 *   2. End-to-end cases against a real dev-server task pack, using the SAME
 *      harness `evaluation0929.descriptiveWords.spec.ts` uses, with INVENTED
 *      words of each leaking shape (never a fixture/eval string verbatim —
 *      common brief rule 5: generalize, never key on the eval's own
 *      identifiers) — confirming no plain-word absence reaches the wire,
 *      while an explicit existence check on a genuinely absent quoted/
 *      code-shaped term still certifies (the recall control).
 */
import { describe, expect, it, afterAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isCodeShapedTerm,
  clauseAsksExistence,
  quotedOccurrenceInText,
  isLiteralEligibleTerm,
} from "../features/task-pack/requestItems.js";

import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  anyEvidenceContains,
  collectDisclosureTexts,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";

// ---------------------------------------------------------------------------
// 1. Unit tests on the eligibility predicate itself.
// ---------------------------------------------------------------------------

describe("isCodeShapedTerm — rule 1(b): camelCase/PascalCase/snake_case/SCREAMING_SNAKE/dotted-::-qualified/$@-prefixed/file-path-shaped", () => {
  const eligible: readonly string[] = [
    "fetchWithBackoff", // lowerCamelCase
    "OrderService", // bare PascalCase (single word, no internal hump) — mirrors distinctiveSalientAbsence's own Tier A capitalized signal
    "HttpClient", // multi-hump PascalCase
    "should_retry", // snake_case, lowercase leading
    "MAX_RETRY_COUNT", // SCREAMING_SNAKE / CONST_CASE
    "std::io", // C++/Rust `::`-qualified
    "OrderService.cancel", // dotted-qualified
    "OrderService#cancel", // hash-qualified
    "$scope", // sigil-prefixed
    "@Injectable", // sigil-prefixed (decorator)
    "config.yaml", // file-path-shaped (extension suffix)
    "src/notes.ts", // file-path-shaped (path + extension)
  ];
  for (const term of eligible) {
    it(`"${term}" is code-shaped`, () => {
      expect(isCodeShapedTerm(term)).toBe(true);
    });
  }

  const ineligible: readonly string[] = [
    "give", "missing", "cause", "denied", "payment", "sequence", "shutdown",
    "inventory", "replenish", "redis", "invalidation", "database", "migrations",
    "during", "constant", "entryway",
  ];
  for (const term of ineligible) {
    it(`"${term}" (ordinary word) is never code-shaped`, () => {
      expect(isCodeShapedTerm(term)).toBe(false);
    });
  }
});

describe("quotedOccurrenceInText — rule 1(a): backtick/double/single/「」/『』", () => {
  const cases: ReadonlyArray<{ quote: string; text: string }> = [
    { quote: "backtick", text: "Explain how `flux` is computed." },
    { quote: "double", text: 'Explain how "flux" is computed.' },
    { quote: "single", text: "Explain how 'flux' is computed." },
    { quote: "kagi (「」)", text: "「フラックス」の計算方法を説明してください。" },
    { quote: "nested-kagi (『』)", text: "『フラックス』の計算方法を説明してください。" },
  ];
  for (const { quote, text } of cases) {
    it(`a ${quote}-quoted term is a quoted occurrence`, () => {
      const term = /「|『/u.test(text) ? "フラックス" : "flux";
      expect(quotedOccurrenceInText(term, text)).toBe(true);
    });
  }

  it("the SAME word unquoted elsewhere in the clause is never a quoted occurrence", () => {
    expect(quotedOccurrenceInText("flux", "Explain how flux capacitors are computed.")).toBe(false);
  });
});

describe("clauseAsksExistence — rule 1(c): the closed EN/JA existence-check construction set", () => {
  const positive: readonly string[] = [
    "Explain the default, and whether the widget registry exists.",
    "Tell me the limit, and whether the exact token FLUX_LEVEL is defined.",
    "Is there a widget registry anywhere in this codebase?",
    "Does the widget registry exist in this project?",
    "Check whether the widget registry is used anywhere.",
    "ウィジェットレジストリが定義されているか確認してください。",
    "ウィジェットレジストリがあるか教えてください。",
    "ウィジェットレジストリが使われているか確認してください。",
    "フラックスという名前の識別子はありますか。",
  ];
  for (const text of positive) {
    it(`recognizes an existence check: ${JSON.stringify(text)}`, () => {
      expect(clauseAsksExistence(text)).toBe(true);
    });
  }

  const negative: readonly string[] = [
    "Explain how the widget registry works.",
    "Under which conditions does the widget registry give up?",
    "ウィジェットレジストリの動作を説明してください。",
  ];
  for (const text of negative) {
    it(`an ordinary (non-existence-check) clause is not one: ${JSON.stringify(text)}`, () => {
      expect(clauseAsksExistence(text)).toBe(false);
    });
  }
});

describe("isLiteralEligibleTerm — the combined predicate, and composite decomposition", () => {
  it("a quoted ordinary word is eligible even though its shape alone would not be", () => {
    expect(isLiteralEligibleTerm("flux", "Explain the default, and whether `flux` is ever used.")).toBe(true);
  });

  it("a code-shaped identifier is eligible regardless of clause construction", () => {
    expect(isLiteralEligibleTerm("fluxCapacitor", "Explain how fluxCapacitor is configured.")).toBe(true);
  });

  it("an ordinary word inside an explicit existence-check clause is eligible", () => {
    expect(isLiteralEligibleTerm("compliance", "Explain the default, and whether compliance is used anywhere.")).toBe(true);
  });

  it("an ordinary word with none of the three signals is never eligible (the leak this fix closes)", () => {
    for (const word of ["give", "missing", "cause", "denied", "sequence"]) {
      expect(isLiteralEligibleTerm(word, `Under which conditions does it ${word}?`)).toBe(false);
    }
  });

  it("composite decomposition: of a slash-joined term's own words, only the eligible ones may survive a join (each word tested independently)", () => {
    // "TTL_SECONDS/expiry" (an identifier glued to a plain word, brief's own
    // example shape): the identifier half is eligible, the plain-word half
    // is not — a caller building the disclosed term from eligible words only
    // (readCodeTaskPack.ts's `proveUnbindableRequestItem`) would keep just
    // the first.
    const clause = "Explain the TTL_SECONDS constant and its expiry.";
    expect(isLiteralEligibleTerm("TTL_SECONDS", clause)).toBe(true);
    expect(isLiteralEligibleTerm("expiry", clause)).toBe(false);
    // "payment/fails" and "user/denied/access" (ordinary-word composites):
    // every part is judged independently, so the whole join is never
    // disclosed. WP-C3 (orchestrator ruling rule 1(d)) — this assertion used
    // to require "payment" ineligible too (WP-C2's "every plain word" rule);
    // "a payment" is the clause's determiner noun phrase, its SUBJECT, so it
    // is eligible now, while the predicate "fail" still never is.
    const clause2 = "Explain which inputs cause a payment to fail.";
    expect(isLiteralEligibleTerm("payment", clause2)).toBe(true);
    expect(isLiteralEligibleTerm("fail", clause2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. End-to-end: a real task pack never certifies an ordinary word literally
//    absent, whichever leaking SHAPE the orchestrator's held-out set found,
//    reproduced here with INVENTED vocabulary (never the eval's own words).
// ---------------------------------------------------------------------------

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

function workspace(files: Record<string, string>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-e0929-litelig-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

async function ask(ws: string, query: string) {
  const s = startDevServer(ws, "default");
  servers.push(s);
  await s.initialize();
  const chain = await followNextToEnd(s, { tool: "tl_read_file", arguments: { query, cwd: ws, task: { epoch: "new", profile: "answer" } } }, { cwd: ws, hopCap: 12 });
  const disclosures = collectDisclosureTexts(chain);
  return { chain, disclosures };
}

/** No `request-item-absent:<term>` disclosure whose term is a bare ordinary word (never quoted, never code-shaped: no `_`, no internal case hump, no leading capital run treated as an identifier, no `.`/`::`/`$`/`@`, no file extension). */
function plainWordAbsence(disclosures: readonly string[]): string | undefined {
  const ABSENT_PLAIN_WORD_RE = /request-item-absent:([a-z][a-z/]*)\b/iu;
  for (const d of disclosures) {
    const m = ABSENT_PLAIN_WORD_RE.exec(d);
    if (m === undefined || m === null) continue;
    const term = m[1]!;
    // every slash-joined part must fail the code-shape test for this to be a leak
    if (term.split("/").every((part) => !/[_.]|::|\$|@/u.test(part) && part === part.toLowerCase())) return d;
  }
  return undefined;
}

function invented(): Record<string, string> {
  return {
    "src/widgetRegistry.ts": [
      "export const WIDGET_LIMIT = 8641;",
      "export const WIDGET_STATUSES = new Set([419, 432, 598]);",
      "export function widgetLimit(): number { return WIDGET_LIMIT; }",
      "export function canRegister(status: number, attempt: number): boolean { return WIDGET_STATUSES.has(status) && attempt < 3; }",
      "export function registerWidget(status: number): boolean { return canRegister(status, 0); }",
      "",
    ].join("\n"),
    "src/widgetCaller.ts": [
      "import { registerWidget } from \"./widgetRegistry.js\";",
      "export function dispatchWidget(): boolean { return registerWidget(503); }",
      "",
    ].join("\n"),
  };
}

describe("end-to-end: invented leak-shaped queries never certify a plain word absent (eval-0929 §6/§8)", () => {
  it("verb/adjective leak shape: 'under which conditions does it give up' — never absent:give", async () => {
    const ws = workspace(invented());
    const { disclosures } = await ask(
      ws,
      "Explain the widget limit returned by widgetLimit, and under which conditions widgetLimit ever gives up or is missing a value.",
    );
    expect(plainWordAbsence(disclosures), `plain-word absence among: ${JSON.stringify(disclosures)}`).toBeUndefined();
  }, 30_000);

  it("bullet + facet-descriptor + named-agent leak shape: statuses checked by a named function are chased, never disclosed as a bare word composite", async () => {
    const ws = workspace(invented());
    const { chain, disclosures } = await ask(
      ws,
      "Explain the widget dispatcher:\n- Limit returned by widgetLimit\n- Statuses checked by canRegister\n- Callers of registerWidget",
    );
    expect(plainWordAbsence(disclosures), `plain-word absence among: ${JSON.stringify(disclosures)}`).toBeUndefined();
    expect(anyEvidenceContains(chain, ["8641"]), "the limit constant was never served").toBe(true);
    expect(anyEvidenceContains(chain, ["419", "432", "598"]), "the status set was never served").toBe(true);
  }, 30_000);

  it("Japanese whole-clause leak shape: an un-segmented noun phrase is never certified absent as one term", async () => {
    const ws = workspace(invented());
    const { disclosures } = await ask(
      ws,
      "widgetLimit の既定値を教えてください。また、各ウィジェットが返すステータスコードの一覧を教えてください。",
    );
    const wholeClauseAbsence = disclosures.find(
      (d) => d.includes("request-item-absent") && /[぀-ヿ一-鿿]{6,}/u.test(d) && !/(?:「|『)/u.test(d),
    );
    expect(wholeClauseAbsence, `a whole-clause JA term was disclosed absent: ${JSON.stringify(disclosures)}`).toBeUndefined();
  }, 30_000);

  // ---------------------------------------------------------------------
  // Recall controls (common brief rule 10): a genuine literal check must
  // still certify absent — this fix narrows WHAT can be disclosed absent,
  // it does not turn the mechanism off.
  // ---------------------------------------------------------------------

  it("control: a quoted, genuinely absent invented identifier is still certified absent", async () => {
    const ws = workspace(invented());
    const { disclosures } = await ask(
      ws,
      "Explain the widget limit returned by widgetLimit, and whether the identifier `WIDGET_NO_SUCH_FLAG_5273` exists.",
    );
    const absentDisclosure = disclosures.find((d) => d.includes("request-item-absent") && d.includes("WIDGET_NO_SUCH_FLAG_5273"));
    expect(absentDisclosure, `no request-item-absent naming WIDGET_NO_SUCH_FLAG_5273 among: ${JSON.stringify(disclosures)}`).toBeDefined();
  }, 30_000);

  it('control: an explicit "is X defined" existence check on a code-shaped, genuinely absent term is still certified absent', async () => {
    const ws = workspace(invented());
    const { disclosures } = await ask(
      ws,
      "Explain the widget limit returned by widgetLimit, and whether the exact identifier WIDGET_NO_SUCH_FLAG_5273 is defined.",
    );
    const absentDisclosure = disclosures.find((d) => d.includes("request-item-absent") && d.includes("WIDGET_NO_SUCH_FLAG_5273"));
    expect(absentDisclosure, `no request-item-absent naming WIDGET_NO_SUCH_FLAG_5273 among: ${JSON.stringify(disclosures)}`).toBeDefined();
  }, 30_000);

  it("control: a genuinely absent bare capitalized (Tier-A-shaped) proper noun is still certified absent", async () => {
    const ws = workspace(invented());
    const { disclosures } = await ask(
      ws,
      "Explain the widget limit returned by widgetLimit, and whether Zorptastic caching is used anywhere.",
    );
    const absentDisclosure = disclosures.find((d) => d.includes("request-item-absent") && /zorptastic/iu.test(d));
    expect(absentDisclosure, `no request-item-absent naming Zorptastic among: ${JSON.stringify(disclosures)}`).toBeDefined();
  }, 30_000);
});
