/**
 * copilotRetest1002r3.falseGaps.spec.ts — Copilot retest r3 (2026-10-02). The
 * task_pack certificate of a fully served, correct answer (all nine checkout files,
 * decision act.answer) still carried
 *
 *   request-item-absent:calculate / :order / :eligibility / :Read / :Report /
 *   :Cite / :calculation / :ordering / :interaction
 *   "(no occurrence in scanned workspace files; scope complete)"
 *
 * for words the workspace never needed to contain: it spells the concepts
 * `eligible`, `discount`, `price`, `quote()`. Every one was minted by the absence
 * engine's `distinctiveSalientAbsence` (Tier A for a capitalised word, Tier C for a
 * lowercase one) because requestItems.ts's literal-absence gate read the word as a
 * SUBJECT. Three structural rules close it (no word list):
 *
 *   (a) a capital that only OPENS a sentence is no proper-noun evidence —
 *       "mainland. Report subtotal", "rounding rules. Read only", "determine it? Cite
 *       file names" are imperatives by position (Tier A and the disclosure gate);
 *   (b) a name written in call syntax (`quote()`) makes its clause identifier-bearing:
 *       "calculate exact quote() results" names an identifier, so "calculate" is prose
 *       beside it (rule 2(c)) and the callable itself stays a subject;
 *   (c) the HEAD of a noun phrase whose modifier is PRESENT in the workspace names an
 *       aspect of present things — "discount ORDER", "giftcard ELIGIBILITY", "quote
 *       CALCULATION", "points/free-shipping INTERACTION" — so its own absence is no claim
 *       (a descriptor by position, rule 2(a)).
 *
 * Negative controls: a genuinely absent subject is still disclosed — the flux
 * capacitor, an absent modifier of a present head ("refund flow"), a quoted absent
 * identifier, a code-shaped absent identifier, and an absent head whose modifier is
 * ALSO absent ("gearbox ordering"). `product` (a bare one-word list item) is not
 * asserted either way.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  capitalizationNamesSubject,
  clauseNamesCodeShapedOrQuotedTerm,
  isInnerSentenceLead,
  isLiteralEligibleTerm,
  topicHeadModifiers,
} from "../features/task-pack/requestItems.js";
import { shortTmpDir } from "./helpers/shortTmpDir.js";
import { rmDirWithRetry } from "./helpers/rmDirWithRetry.js";
import {
  startDevServer,
  followNextToEnd,
  collectDisclosureTexts,
  type ServerHandle,
} from "./helpers/qualityFirstScenarios.js";
import { COPILOT_CHECKOUT_FILES, COPILOT_RETRY_FILES } from "./helpers/copilotCheckoutFixture.js";

// ---------------------------------------------------------------------------
// 1. Unit: rule (b) — call syntax names an identifier.
// ---------------------------------------------------------------------------

describe("rule (b) — a name written in call syntax makes its clause identifier-bearing", () => {
  const clause = "Inspect src/checkout and calculate exact quote() results for carts A";

  it("the plain words of the clause are prose beside the callable; the callable itself is a subject", () => {
    expect(clauseNamesCodeShapedOrQuotedTerm(clause)).toBe(true);
    for (const word of ["calculate", "exact", "results", "carts"]) {
      expect(isLiteralEligibleTerm(word, clause), `${word} must not be a subject`).toBe(false);
    }
    expect(isLiteralEligibleTerm("quote", clause)).toBe(true);
  });

  it("a callable that is absent from the workspace is still disclosable (`refund()`); its prose is not", () => {
    const ask = "What does refund() return for member carts?";
    expect(isLiteralEligibleTerm("refund", ask)).toBe(true);
    expect(isLiteralEligibleTerm("return", ask)).toBe(false);
    expect(isLiteralEligibleTerm("carts", ask)).toBe(false);
  });

  it("controls: an English plural `item(s)` is no call, and a clause without parentheses keeps its subject nouns", () => {
    expect(clauseNamesCodeShapedOrQuotedTerm("Explain the item(s) flux capacitor")).toBe(false);
    expect(isLiteralEligibleTerm("flux", "Explain the item(s) flux capacitor")).toBe(true);
    expect(isLiteralEligibleTerm("capacitor", "how does the flux capacitor work?")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Unit: rule (a) — a sentence-initial capital is no proper-noun evidence.
// ---------------------------------------------------------------------------

describe("rule (a) — a capital that only opens a sentence is no evidence of a proper noun", () => {
  const imperatives: ReadonlyArray<readonly [string, string]> = [
    ["Report", "mainland. Report subtotal"],
    ["Read", "rounding rules. Read only"],
    ["Cite", "which constants and functions determine it? Cite file names and relevant line numbers."],
    ["Read", "rounding\n- Read quote and all relevant pricing"],
    ["Report", "point one; Report subtotal"],
  ];
  for (const [word, text] of imperatives) {
    it(`${JSON.stringify(word)} in ${JSON.stringify(text)} is an imperative by position`, () => {
      expect(capitalizationNamesSubject(word, text)).toBe(false);
      expect(isInnerSentenceLead(word, text)).toBe(true);
    });
  }

  const properNouns: ReadonlyArray<readonly [string, string]> = [
    ["Redis", "Explain the Redis cache invalidation"],
    ["Redis", "It uses Redis. Redis is great"], // one occurrence in the middle of a clause is enough
    ["Redis", "Explain it, e.g. Redis"], // "e.g." ends no sentence
    ["Read", "Cache.Read"], // glued to the previous token: a qualified name
    ["SAVE500", "Apply coupons. SAVE500 is the code"], // a code-shaped word is an identifier whatever its position
  ];
  for (const [word, text] of properNouns) {
    it(`${JSON.stringify(word)} in ${JSON.stringify(text)} keeps its capital as evidence`, () => {
      expect(capitalizationNamesSubject(word, text)).toBe(true);
      expect(isInnerSentenceLead(word, text)).toBe(false);
    });
  }

  it("the item's own first word is not an inner sentence lead (the pinned verbless-fragment reading is kept)", () => {
    expect(isInnerSentenceLead("Quorblex", "Quorblex retry failed batches")).toBe(false);
    expect(isLiteralEligibleTerm("Quorblex", "Quorblex retry failed batches")).toBe(true);
    expect(isInnerSentenceLead("Report", "Report subtotal")).toBe(false);
  });

  it("a quoted word is never an imperative", () => {
    expect(isInnerSentenceLead("Report", 'mainland. "Report" is the module name')).toBe(false);
    expect(capitalizationNamesSubject("Report", 'mainland. "Report" is the module name')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Unit: rule (c) — which head nouns sit behind which modifiers.
// ---------------------------------------------------------------------------

describe("rule (c) — topicHeadModifiers names the modifiers behind a phrase's head", () => {
  const heads: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["determine discount order", "order", ["discount"]],
    ["giftcard discount eligibility", "eligibility", ["giftcard", "discount"]],
    ["inspect quote calculation", "calculation", ["quote"]],
    ["identify discount ordering", "ordering", ["discount"]],
    ["points/free-shipping interaction", "interaction", ["points", "shipping"]], // the adjective "free" is no thing
    ["shipping eligibility and region/method pricing", "eligibility", ["shipping"]],
    ["flux capacitor", "capacitor", ["flux"]],
  ];
  for (const [clause, head, modifiers] of heads) {
    it(`${JSON.stringify(clause)} → ${head} behind ${JSON.stringify(modifiers)}`, () => {
      expect([...(topicHeadModifiers(clause).get(head) ?? [])].sort()).toEqual([...modifiers].sort());
    });
  }

  const notHeads: ReadonlyArray<readonly [string, string]> = [
    ["the cache entryway path", "entryway"], // the phrase ENDS in a facet descriptor: "entryway" is its subject
    ["the cache invalidation logic", "invalidation"],
    ["refund flow", "refund"], // a modifier-less head
    ["product", "product"], // a bare word
    ["the missing quorblex", "quorblex"], // only an adjective in front of it
    ["Explain the order and the discount order", "order"], // the same word is a subject on its own elsewhere
  ];
  for (const [clause, word] of notHeads) {
    it(`${JSON.stringify(clause)} → ${word} is no suppressible head`, () => {
      expect(topicHeadModifiers(clause).has(word)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 3b. Unit: rule (c) refinement — a question asks about its subject.
// ---------------------------------------------------------------------------

describe("rule (c) refinement — a question's head noun is the subject asked about, never suppressed", () => {
  // [question clause, the head that would sit behind a present modifier if it were not a question]
  const questions: ReadonlyArray<readonly [string, string]> = [
    ["How does the shipping webhook retry?", "webhook"],
    ["how does the shipping webhook retry", "webhook"], // a comma-split item has lost its mark
    ["and how does the shipping webhook retry on 503?", "webhook"],
    ["How does the shipping webhook work?", "webhook"],
    // The evaluator's wording: the noun-phrase parse reads "retry" as the head here, so this form never made
    // `webhook` a suppressible head; it must (and does) disclose it either way.
    ["How does the shipping webhook retry failed deliveries?", "webhook"],
    ["Does the shipping webhook retry?", "webhook"],
    ["Does the payment gateway retry on 503?", "gateway"],
    ["does the payment gateway retry on 503", "gateway"], // an auxiliary opener without the mark
    ["Is there a shipping webhook?", "webhook"],
    ["What does the shipping webhook return?", "webhook"],
    ["Where is the shipping webhook configured?", "webhook"],
    ["When does the shipping webhook fire?", "webhook"],
    ["Which shipping webhook handles refunds?", "webhook"],
    ["Why does the discount order matter?", "order"], // an abstract head is the subject of a question too (the accepted cost)
    ["Can the shipping gateway retry?", "gateway"],
    ["Have the shipping webhooks retried", "webhooks"], // an auxiliary opener that is no "Have a look"
    ["and the shipping webhook?", "webhook"], // a fragment that ends in "?"
    ["Read the shipping files and answer: does the payment gateway retry on 503", "gateway"], // a colon-introduced question clause
    // Review of this wave (2026-10-02): an embedded question after a verb of telling or knowing, and an
    // existence check, ask about their subject too (they used to keep rule (c)).
    ["Explain how the shipping webhook retries failed deliveries", "webhook"],
    ["Check whether the shipping webhook exists", "webhook"],
    ["Tell me whether the payment gateway retries on 503", "gateway"],
    ["I want to know if the shipping webhook retries", "webhook"],
    ["Can you explain how the payment gateway retries?", "gateway"],
    ["Confirm the existence of the shipping webhook", "webhook"],
    ["Verify that a shipping webhook exists for refunds", "webhook"],
  ];
  for (const [clause, head] of questions) {
    it(`${JSON.stringify(clause)} → ${head} is no suppressible head`, () => {
      expect(topicHeadModifiers(clause).has(head)).toBe(false);
    });
  }

  // Imperatives, verbless list fragments and the objects of a lead verb keep rule (c).
  const keeps: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["Trace the shipping webhook", "webhook", ["shipping"]], // the imperative twin: the accepted residual
    ["Trace the payment gateway", "gateway", ["payment"]],
    ["explain discount order", "order", ["discount"]],
    ["Need discount order", "order", ["discount"]],
    ["Trace quote(), shipping eligibility", "eligibility", ["shipping"]],
    ["Read the shipping files and answer: trace the shipping webhook", "webhook", ["shipping"]],
    // A request in question form is addressed to the reader, and "Do not ..." prohibits.
    ["Can you explain the discount order?", "order", ["discount"]],
    ["Could you trace the shipping webhook?", "webhook", ["shipping"]],
    ["Do not modify the discount order", "order", ["discount"]],
    ["Don't change the discount order", "order", ["discount"]],
    ["Have a look at src/checkout and explain the discount order", "order", ["discount"]],
    // A period glued into a token, or ending an abbreviation, is no sentence end.
    ["Explain src/backoff.ts and the discount order", "order", ["discount"]],
    ["Explain it, e.g. the discount order", "order", ["discount"]],
  ];
  for (const [clause, head, modifiers] of keeps) {
    it(`${JSON.stringify(clause)} → ${head} stays behind ${JSON.stringify(modifiers)}`, () => {
      expect([...(topicHeadModifiers(clause).get(head) ?? [])].sort()).toEqual([...modifiers].sort());
    });
  }

  it("decided per sentence: the imperative sentence keeps (c), the question beside it does not", () => {
    for (const clause of ["determine discount order. How does the shipping webhook retry?", "How does the shipping webhook retry? Explain discount order."]) {
      const heads = topicHeadModifiers(clause);
      expect(heads.get("order"), clause).toEqual(["discount"]);
      expect(heads.has("webhook"), clause).toBe(false);
    }
    // a word a question asks about is a subject in its own right wherever else it appears
    expect(topicHeadModifiers("determine discount order. How does the discount order apply?").has("order")).toBe(false);
  });

  // Review of this wave (2026-10-02): only a question's SUBJECT is exempt; what it names after its verb is
  // read like any other phrase.
  it.each([
    ["Explain how the engine computes the discount order", "order", ["discount"]],
    ["Tell me whether the engine checks giftcard eligibility", "eligibility", ["giftcard"]],
    ["Explain how points affect the giftcard discount eligibility", "eligibility", ["giftcard", "discount"]],
  ] as const)("an embedded question's object keeps rule (c): %s", (clause, head, modifiers) => {
    expect([...(topicHeadModifiers(clause).get(head) ?? [])].sort()).toEqual([...modifiers].sort());
  });

  it("reads a long run of terminators glued to the next word in linear time (was about 2 s)", () => {
    const started = Date.now();
    topicHeadModifiers(`Explain discount order${".".repeat(50_000)}and the giftcard eligibility`);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("rule (a) refinement — a capital that opens an inner sentence as its subject is still a proper noun", () => {
  it("Redis handles it: subject, finite verb, object", () => {
    expect(isInnerSentenceLead("Redis", "Explain the session store. Redis handles it, I think.")).toBe(false);
    expect(isInnerSentenceLead("Stripe", "Explain quote(). Stripe sends the event to /hooks.")).toBe(false);
  });

  it("an imperative lead stays one, a plural object after it included", () => {
    expect(isInnerSentenceLead("Report", "... mainland. Report subtotal, memberOff and couponOff")).toBe(true);
    expect(isInnerSentenceLead("Read", "rounding rules. Read files and cite lines")).toBe(true);
    expect(isInnerSentenceLead("Cite", "determine it? Cite file names and lines")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. End to end (spawned dev server, the measured host's env).
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

function workspace(files: Readonly<Record<string, string>>): string {
  const ws = fs.realpathSync(shortTmpDir(HOME, ".tl-cp1002r3-"));
  tmpDirs.push(ws);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), content, "utf8");
  }
  return ws;
}

/** One answer-profile task_pack call, followed to its end, under the measured host's own env (`vscode` config). */
async function ask(ws: string, query: string) {
  const server = startDevServer(ws, "vscode", { toolSurface: "full" });
  servers.push(server);
  await server.initialize();
  const chain = await followNextToEnd(
    server,
    { tool: "tl_read_file", arguments: { query, task: { epoch: "new", profile: "answer" }, cwd: ws } },
    { cwd: ws, hopCap: 6 },
  );
  return { chain, disclosures: collectDisclosureTexts(chain) };
}

/** Every disclosure naming `word` as a whole word (case-sensitive). */
function disclosuresNaming(disclosures: readonly string[], word: string): string[] {
  const re = new RegExp(`(?<![\\w$])${word}(?![\\w$])`);
  return disclosures.filter((text) => re.test(text));
}

const CHECKOUT_NEEDED: readonly string[] = ["quote", "lines", "catalog", "membership", "coupons", "points", "shipping", "tax", "constants"].map(
  (name) => `src/checkout/${name}.ts`,
);

function expectNoFalseGap(disclosures: readonly string[], words: readonly string[]): void {
  for (const word of words) expect(disclosuresNaming(disclosures, word), `${word} must not be certified: ${JSON.stringify(disclosures)}`).toEqual([]);
}

describe("Copilot retest r3 — a fully served checkout answer names no false gap", () => {
  it("the evaluator's served call: act.answer, the nine files, and no gap naming calculate / order / eligibility / Read", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { chain, disclosures } = await ask(
      ws,
      "Inspect src/checkout and calculate exact quote() results for carts A, B, C: subtotal, memberOff, couponOff, pointsOff, shipping, tax, total; determine discount order, giftcard eligibility, points and free shipping, rounding. Read quote and all relevant pricing, product, coupon, shipping, tax, points, membership, types, and constants code with line numbers.",
    );
    const first = chain.hops[0]?.response as Record<string, any> | undefined;
    expect(first?.["decision"]?.["kind"], JSON.stringify(first?.["decision"])).toBe("act.answer");
    const served = new Set(((first?.["evidence"] ?? []) as Array<{ path?: string }>).map((row) => row.path));
    for (const file of CHECKOUT_NEEDED) expect(served.has(file), `${file} not served`).toBe(true);
    expectNoFalseGap(disclosures, ["calculate", "order", "eligibility", "Read"]);
  }, 90_000);

  it("the field-by-field cart wording: no gap naming calculate / Report / order / eligibility / Read", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(
      ws,
      "Inspect src/checkout and calculate exact quote() results for these three carts: A notebook x2 and mug x1; member true; coupon SAVE500; points 100; standard delivery; mainland. B kettle x1 and giftcard x1; member true; coupon TEN; points 1000; express delivery; island. C mug x3; member false; coupon SAVE500; points 2000; standard delivery; mainland. Report subtotal, memberOff, couponOff, pointsOff, shipping, tax, total; explain discount order, giftcard discount eligibility, points impact on free shipping, and rounding rules. Read only, do not modify or run terminal commands. Need relevant code line numbers.",
    );
    expectNoFalseGap(disclosures, ["calculate", "Report", "order", "eligibility", "Read"]);
  }, 90_000);

  it("the first retest wording: no gap naming calculation / eligibility", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(
      ws,
      "Calculate exact quote() outputs for carts in src/checkout; inspect quote calculation, discounts, giftcards, points/free shipping eligibility, shipping/tax, and rounding rules. Need source line numbers for explanation.",
    );
    expectNoFalseGap(disclosures, ["calculation", "eligibility"]);
  }, 90_000);

  it("the second retest wording: no gap naming ordering / eligibility / interaction", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(
      ws,
      "Inspect src/checkout and calculate the exact quote() result for the three specified carts; identify discount ordering, giftcard discount eligibility, points/free-shipping interaction, rounding rules, and source lines.",
    );
    expectNoFalseGap(disclosures, ["ordering", "eligibility", "interaction"]);
  }, 90_000);

  it("the small retry prompt: no gap naming Cite", async () => {
    const ws = workspace(COPILOT_RETRY_FILES);
    const { disclosures } = await ask(
      ws,
      "Read the source files in src and answer: What exact delay sequence does retrySchedule() return, and which constants and functions determine it? Cite file names and relevant line numbers.",
    );
    expectNoFalseGap(disclosures, ["Cite"]);
  }, 90_000);
});

describe("Copilot retest r3 — recall controls: a genuinely absent subject is still disclosed", () => {
  it("an absent subject noun phrase (the flux capacitor) is certified absent", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(ws, "Inspect src/checkout and explain quote() for carts A, B and C, and how does the flux capacitor work?");
    expect(disclosuresNaming(disclosures, "flux").length, JSON.stringify(disclosures)).toBeGreaterThan(0);
  }, 90_000);

  it("an absent modifier of a present head (a refund flow with no refund code) discloses the modifier", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(ws, "Explain shipping and tax in quote(), and the refund flow.");
    expect(disclosuresNaming(disclosures, "refund").length, JSON.stringify(disclosures)).toBeGreaterThan(0);
  }, 90_000);

  it("a quoted absent identifier is still certified absent", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(ws, "Explain the discount order in quote(), and whether the identifier `NO_SUCH_TOKEN_4471` exists.");
    expect(disclosuresNaming(disclosures, "NO_SUCH_TOKEN_4471").length, JSON.stringify(disclosures)).toBeGreaterThan(0);
    expectNoFalseGap(disclosures, ["order"]);
  }, 90_000);

  it("a code-shaped absent identifier is still certified absent, and the present discount order is not", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(ws, "Explain the discount order in quote(), and what quantumTeleportationMode does.");
    expect(disclosuresNaming(disclosures, "quantumTeleportationMode").length, JSON.stringify(disclosures)).toBeGreaterThan(0);
    expectNoFalseGap(disclosures, ["order"]);
  }, 90_000);

  it("rule (c) both ways: `gearbox ordering` (modifier also absent) is disclosed, `discount ordering` (modifier present) is not", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const absent = await ask(ws, "Explain quote(), and gearbox ordering.");
    expect(disclosuresNaming(absent.disclosures, "ordering").length, JSON.stringify(absent.disclosures)).toBeGreaterThan(0);
    const present = await ask(ws, "Explain quote(), and discount ordering.");
    expectNoFalseGap(present.disclosures, ["ordering"]);
  }, 120_000);

  it("a call-shaped callable that is absent from the workspace (`refund()`) is still certified absent", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(ws, "Explain shipping in quote(), and what refund() returns.");
    expect(disclosuresNaming(disclosures, "refund").length, JSON.stringify(disclosures)).toBeGreaterThan(0);
    expectNoFalseGap(disclosures, ["returns"]);
  }, 90_000);

  it("a wholly absent item discloses its subject words, never the imperative that opens its second sentence", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    const { disclosures } = await ask(ws, "Explain quote(), and flux. Report capacitor.");
    expect(disclosuresNaming(disclosures, "flux").length, JSON.stringify(disclosures)).toBeGreaterThan(0);
    expect(disclosuresNaming(disclosures, "capacitor").length, JSON.stringify(disclosures)).toBeGreaterThan(0);
    expectNoFalseGap(disclosures, ["Report"]);
  }, 90_000);
});

describe("Copilot retest r3 — a question asks about its subject: the head behind a present modifier is disclosed", () => {
  it("a wh-question discloses `webhook` (shipping present); its imperative twin and a polite request do not", async () => {
    const ws = workspace(COPILOT_CHECKOUT_FILES);
    for (const question of [
      "Explain quote(), and how does the shipping webhook retry failed deliveries?",
      "Explain quote(), and how does the shipping webhook work?",
    ]) {
      const asked = await ask(ws, question);
      expect(disclosuresNaming(asked.disclosures, "webhook").length, `${question}: ${JSON.stringify(asked.disclosures)}`).toBeGreaterThan(0);
    }
    const imperative = await ask(ws, "Explain quote(), and trace the shipping webhook.");
    expectNoFalseGap(imperative.disclosures, ["webhook"]);
    const polite = await ask(ws, "Explain quote(), and can you explain the shipping webhook?");
    expectNoFalseGap(polite.disclosures, ["webhook"]);
  }, 180_000);

  it("a yes/no question discloses `gateway` (payment present); its imperative twin does not", async () => {
    const ws = workspace({ ...COPILOT_CHECKOUT_FILES, "src/checkout/payment.ts": "export function payment(amount: number) { return amount; }\n" });
    const asked = await ask(ws, "Explain quote(), and does the payment gateway retry on 503?");
    expect(disclosuresNaming(asked.disclosures, "gateway").length, JSON.stringify(asked.disclosures)).toBeGreaterThan(0);
    const imperative = await ask(ws, "Explain quote(), and trace the payment gateway.");
    expectNoFalseGap(imperative.disclosures, ["gateway"]);
  }, 120_000);
});
