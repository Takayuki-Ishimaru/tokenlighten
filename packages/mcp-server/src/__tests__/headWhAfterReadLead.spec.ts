/**
 * headWhAfterReadLead.spec.ts — FIX-B (plan-0143 TL-02 P0 / TL-04(a)),
 * GENERALISED by r-b2 (2026-09-21, adversarial-review finding B4) — pure-layer
 * coverage for `requestItems.ts`'s `headIsWhAfterReadLead` (H-4) and the
 * bracket/quote guard added to `splitBareAndAtQuestionBoundary`'s bare
 * coordinator split (B3). Pure/fs-free: no server, no workspace, no process
 * spawn — `concernRetentionMatrix.spec.ts` covers the real-server, end-to-end
 * retention + completion-gate behaviour this extraction feeds (both configs).
 *
 * Root cause (see requestItems.ts's own doc comment on
 * `headIsWhAfterReadLead` for the full writeup): `isIndependentQuestionClause`
 * requires the interrogative to be a clause's OWN head, by design (an
 * imperative fragment like "Trace how X builds Y" must never qualify AS AN
 * INDEPENDENT QUESTION CLAUSE ON ITS OWN — see that predicate's own doc
 * comment; UNCHANGED by this fix). fix-b's first cut at `headIsWhAfterReadLead`
 * special-cased a CLOSED read-verb vocabulary (explain/describe/tell me/show
 * me/clarify/summarize) ahead of the embedded question — correct for TL-02's
 * own repro, but the review measured that ANY OTHER non-mutation lead ("Trace",
 * "Walk me through", "I want to understand", "Outline", "Document", "Give me
 * an overview of", …) hit the exact same TL-02 shape: `extractRequestItems`
 * returned ONE item and the whole request-item mechanism silently never
 * engaged for the second point. ORCHESTRATOR RULING (r-b2, finding B4):
 * generalise by RULE — see `headIsWhAfterReadLead`'s own doc comment for the
 * four-part test ((a) wh-word within 6 tokens, (b) no comma/colon/semicolon/
 * bracket/quote before it, (c) the lead is not an edit/mutation lead, (d) the
 * remainder from the wh-word on satisfies the UNCHANGED
 * `isIndependentQuestionClause`) — which is a strict SUPERSET of fix-b's
 * closed list, so every fix-b-era case below is retained unchanged and only
 * ONE assertion (the "Trace" case, previously pinned `false` under the old
 * closed-vocabulary ruling) flips to `true`, exactly as the new ruling
 * requires (see "widens to ANY non-mutation lead" below).
 *
 * Joiners are likewise a COORDINATOR CLASS (`BARE_AND_RE`), not a fixed pair:
 * "and"/"as well as" (fix-b) plus "plus"/"along with"/"together with"/
 * "and also"/"and then" (r-b2) all read the SAME two-sided test.
 *
 * Two layers here, no spawned server:
 *  - MATRIX-A: LEAD x JOINER cross product — 13 leads (7 fix-b read-verb
 *    leads + 6 r-b2 non-mutation-imperative leads) x 8 joiners (6 fix-b +
 *    2 r-b2 coordinator-class additions) = 104 cells — every cell must split
 *    into exactly 2 items, each independently recognized as a question by
 *    `headIsWhAfterReadLead` (the SAME predicate readCodeTaskPack.ts's H-2
 *    filter now uses).
 *  - Controls that must NOT change: B3 (bracket/quote-protected "and" — the
 *    d12a class), B4 (compound subject/object stays fused), a quoted
 *    phrase, an in-question example ("such as …"), a negation, a
 *    type/member-name mention, a single-concern question, and an edit
 *    request containing " and how " (never touched by this predicate at
 *    all — it has no read lead).
 */
import { describe, expect, it } from "vitest";
import {
  extractRequestItems,
  headIsWhAfterReadLead,
  isIndependentQuestionClause,
} from "../features/task-pack/requestItems.js";

// ---------------------------------------------------------------------------
// MATRIX-A: LEAD x JOINER cross product (brief-fix-b.md's own axes)
// ---------------------------------------------------------------------------

const CONCERN_A = "credentials are validated";
const CONCERN_B = "database migrations are executed";

/**
 * Every lead the brief's retention matrix names, as a function wrapping the
 * rest of the clause (so "Can you explain" gets its own natural "?"). First
 * 7 are fix-b's original closed-vocabulary read leads (kept — the new rule is
 * a strict superset); last 6 are r-b2's non-mutation-imperative widening
 * (review finding B4's own named examples), none of which is in
 * `READ_VERB_LEAD_EN_RE` — proving the new rule reaches them BY RULE, not by
 * having quietly grown that closed list instead.
 */
const LEADS: ReadonlyArray<{ name: string; wrap: (rest: string) => string }> = [
  { name: "Explain", wrap: (rest) => `Explain ${rest}.` },
  { name: "Describe", wrap: (rest) => `Describe ${rest}.` },
  { name: "Tell me", wrap: (rest) => `Tell me ${rest}.` },
  { name: "Clarify", wrap: (rest) => `Clarify ${rest}.` },
  { name: "Show me", wrap: (rest) => `Show me ${rest}.` },
  { name: "Please explain", wrap: (rest) => `Please explain ${rest}.` },
  { name: "Can you explain", wrap: (rest) => `Can you explain ${rest}?` },
  { name: "Trace", wrap: (rest) => `Trace ${rest}.` },
  { name: "Walk me through", wrap: (rest) => `Walk me through ${rest}.` },
  { name: "I want to understand", wrap: (rest) => `I want to understand ${rest}.` },
  { name: "Outline", wrap: (rest) => `Outline ${rest}.` },
  { name: "Document", wrap: (rest) => `Document ${rest}.` },
  // 6 tokens exactly to its own "how" (Give(1) me(2) an(3) overview(4) of(5)
  // how(6)) — the boundary case for rule (a)'s "within the first 6 tokens".
  { name: "Give me an overview of", wrap: (rest) => `Give me an overview of ${rest}.` },
];

/**
 * Every joiner the brief's retention matrix names. `body(lead)` builds the
 * WHOLE query given the lead's own `wrap` function — numbered/bullet lists
 * apply `wrap` to EACH line independently (a natural multi-line phrasing
 * where every line restates its own lead, verified directly against
 * `extractRequestItems`'s actual output rather than assumed).
 *
 * `bothIndependent: true` on "; also" — UPDATED by r-b2 (2026-09-21): fix-b's
 * own predicate left item 2 ("also how …") unable to read as its own
 * independent question, because it stripped only the closed
 * `READ_VERB_LEAD_EN_RE` vocabulary and "also" is not in it. r-b2's
 * generalised rule strips through the SAME reviewed `stripLeadPrefixes`
 * chain every other lead test in this file already shares — and "also" is
 * already one of `DISCOURSE_LEAD_RE`'s recognized discourse adverbs (SHOULD-
 * FIX 56's own `itemReadsAsEditLead`/`itemReadsAsReadLead` precedent: "Then
 * explain what it does." is as much a read lead as "Explain what it does.").
 * So "also how database migrations are executed." now strips to "how
 * database migrations are executed." and passes rule (d) cleanly — verified
 * directly for all 13 LEADS above, not assumed. This is a GOOD side effect
 * (a more accurate classification), not a widening of scope: `stripLeadPrefixes`
 * itself is unchanged, reused as-is. `isIndependentQuestionClause`'s OWN
 * `EN_LEADING_COORDINATOR_RE` (only "and"/"then"/a leading comma) is still
 * untouched and still would not strip "also" on its own — this predicate's
 * extra `stripLeadPrefixes` pass is what changed, not that regex. N7's own
 * gap-token-hygiene fix separately treats "also" as a filler word that is
 * never a SEARCH TARGET (`salientWords`) — a different question from whether
 * it is a question CLAUSE HEAD, and the two are not in tension. Confirmed via
 * `concernRetentionMatrix.spec.ts`'s own "; also" cells (unchanged pairing —
 * still passing end to end, both configs).
 *
 * "plus"/"along with" (r-b2, review finding B4) are the coordinator CLASS's
 * remaining named members exercised here at the PURE layer (the class also
 * includes "together with"/"and also"/"and then" — unit-tested individually
 * below rather than in the full matrix, to keep this cross product bounded).
 * "newline (no marker)" proves the reviewer's own "newline" axis value
 * structurally, independent of both numbering and the lead predicate: two
 * bare lines with NO list marker at all must still split on `\n` alone
 * (`splitEnumerated`'s delimiter set already includes it) — this is the
 * brief's own "verify, fix if not" item; verified passing unchanged.
 */
const JOINERS: ReadonlyArray<{ name: string; bothIndependent: boolean; body: (wrap: (rest: string) => string) => string }> = [
  { name: " and how", bothIndependent: true, body: (wrap) => wrap(`how ${CONCERN_A} and how ${CONCERN_B}`) },
  { name: ", and how", bothIndependent: true, body: (wrap) => wrap(`how ${CONCERN_A}, and how ${CONCERN_B}`) },
  { name: "; also", bothIndependent: true, body: (wrap) => wrap(`how ${CONCERN_A}; also how ${CONCERN_B}`) },
  { name: "numbered list", bothIndependent: true, body: (wrap) => `1. ${wrap(`how ${CONCERN_A}`)}\n2. ${wrap(`how ${CONCERN_B}`)}` },
  { name: "bullet list", bothIndependent: true, body: (wrap) => `- ${wrap(`how ${CONCERN_A}`)}\n- ${wrap(`how ${CONCERN_B}`)}` },
  { name: " as well as how", bothIndependent: true, body: (wrap) => wrap(`how ${CONCERN_A} as well as how ${CONCERN_B}`) },
  { name: " plus how", bothIndependent: true, body: (wrap) => wrap(`how ${CONCERN_A} plus how ${CONCERN_B}`) },
  { name: " along with how", bothIndependent: true, body: (wrap) => wrap(`how ${CONCERN_A} along with how ${CONCERN_B}`) },
  { name: "newline (no marker)", bothIndependent: true, body: (wrap) => `${wrap(`how ${CONCERN_A}`)}\n${wrap(`how ${CONCERN_B}`)}` },
];

/**
 * FIXED (fix-c, 2026-09-21, D3/TL-02 class): was a KNOWN, PRE-EXISTING,
 * OUT-OF-SCOPE finding — a "?"-terminated FIRST line of a multi-line
 * numbered/bulleted list was consumed whole by `splitLeadAndBody` (it found
 * the query's FIRST "?"/"!" ANYWHERE and treated everything up to it as
 * throwaway "lead context", per that function's own design for a genuinely
 * different shape — "Why is X slow? Explain how it's optimized." — a single
 * leading question followed by the real request). `extractRequestItems`'s
 * BLOCKER-54 guard kept that discarded lead only when it names a file/
 * identifier of its own, which a plain "Can you explain how …?" never does
 * — so list item 1 vanished ENTIRELY, before any bare-and/independence logic
 * ever ran. `splitLeadAndBody` (requestItems.ts) now checks structurally,
 * FIRST, whether the query itself starts with a list marker ("1.", "1)",
 * "-", "*", "•") and — only then — skips the lead-discard step entirely,
 * keeping the whole query (including item 1) as body for the existing
 * per-line list splitting to handle; an ordinary "Question? Statement."
 * sentence pair never starts with a list marker and is unaffected (see the
 * "; also" / non-list joiners above, unchanged). Empty set kept (rather
 * than deleted) so a future regression that reintroduces a KNOWN_PENDING id
 * fails loudly here instead of silently vanishing from the matrix.
 */
const KNOWN_PENDING = new Set<string>([]);

describe("headIsWhAfterReadLead — MATRIX-A: every lead x every joiner retains both concerns", () => {
  for (const lead of LEADS) {
    for (const joiner of JOINERS) {
      const id = `${lead.name} / ${joiner.name}`;
      const runner = KNOWN_PENDING.has(id) ? it.fails : it;
      runner(id, () => {
        const query = joiner.body(lead.wrap);
        const items = extractRequestItems(query);
        // Both concerns must survive as their OWN item — never fused, never
        // dropped (TL-02's own failure mode: an item count stuck at 1 means
        // the whole request-item mechanism never engages at all).
        expect(items.length, `query=${JSON.stringify(query)} items=${JSON.stringify(items.map((i) => i.text))}`).toBe(2);
        if (joiner.bothIndependent) {
          for (const item of items) {
            expect(
              headIsWhAfterReadLead(item.text),
              `lead=${lead.name} joiner=${joiner.name} item=${JSON.stringify(item.text)} must read as an independent question`,
            ).toBe(true);
          }
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Unit cases for the predicate itself
// ---------------------------------------------------------------------------

describe("headIsWhAfterReadLead — predicate unit cases", () => {
  it("recognizes every reviewed read lead ahead of a wh-question", () => {
    for (const q of [
      "Explain how the cache expires entries",
      "Describe how the cache expires entries",
      "Tell me how the cache expires entries",
      "Tell me about how the cache expires entries",
      "Clarify how the cache expires entries",
      "Show me how the cache expires entries",
      "Show me about how the cache expires entries",
      "Please explain how the cache expires entries",
      "Summarize how the cache expires entries",
      "Summarize how the cache expires entries",
    ]) {
      expect(headIsWhAfterReadLead(q), q).toBe(true);
    }
  });

  it("is a strict superset of isIndependentQuestionClause (never narrower)", () => {
    for (const q of [
      "How is the coupon discount validated?",
      "Where is the shipping cost calculated?",
      "どこで検証されますか",
      "何が原因ですか？",
    ]) {
      expect(isIndependentQuestionClause(q), q).toBe(true);
      expect(headIsWhAfterReadLead(q), q).toBe(true);
    }
  });

  it("rule (c): rejects a mutation/edit lead even with an embedded wh-question nearby — never reclassifies an edit request", () => {
    for (const q of [
      "Change MAX_RETRIES to 5 and how backoff works",
      "Update how the changelog is generated",
      "Fix how the parser handles input",
      "Refactor how database migrations run and how credentials are checked",
    ]) {
      expect(headIsWhAfterReadLead(q), q).toBe(false);
    }
  });

  it("rule (a): rejects a clause with no wh-word anywhere near its head, mutation or not", () => {
    for (const q of ["Identify the implementation path", "Update the changelog", "Trace the pipeline end to end"]) {
      expect(headIsWhAfterReadLead(q), q).toBe(false);
    }
  });

  it("B4 (r-b2): widens to ANY non-mutation lead with an embedded wh-question near its head — by RULE, not a word list", () => {
    // None of these is in the closed `READ_VERB_LEAD_EN_RE` vocabulary
    // fix-b shipped — proving this is the generalised rule firing, not a
    // quietly regrown word list.
    for (const q of [
      "Trace how X builds Y",
      "Walk me through how X builds Y",
      "I want to understand how X builds Y",
      "Outline how X builds Y",
      "Document how X builds Y",
      "Give me an overview of how X builds Y",
      "Can you tell me how X builds Y",
      "Help me understand how X builds Y",
      "I'd like to know how X builds Y",
    ]) {
      expect(headIsWhAfterReadLead(q), q).toBe(true);
    }
  });

  it("rule (b): a comma, colon, semicolon, bracket or quote before the wh-word disqualifies it", () => {
    for (const q of [
      "Trace, how the pipeline works",
      "Give an overview: how the pipeline works",
      "Trace the flow; how does it work",
      "Trace (how the pipeline works)",
      'Trace "how the pipeline works"',
    ]) {
      expect(headIsWhAfterReadLead(q), q).toBe(false);
    }
  });

  it("rule (b) recall control: the SAME lead with no intervening punctuation still qualifies", () => {
    expect(headIsWhAfterReadLead("Trace how the pipeline works")).toBe(true);
    expect(headIsWhAfterReadLead("Give an overview how the pipeline works")).toBe(true);
  });

  it("still refuses a fragment with no question at all, even with a read lead", () => {
    expect(headIsWhAfterReadLead("Explain the changelog.")).toBe(false);
    expect(headIsWhAfterReadLead("Explain.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B4 (r-b2): the coordinator CLASS's remaining members ("together with",
// "and also", "and then") — unit-tested individually here (kept out of the
// full MATRIX-A cross product to bound its size; "plus"/"along with" ARE in
// the matrix, exercising the SAME two-sided test through the full lead set).
// ---------------------------------------------------------------------------

describe("BARE_AND_RE coordinator class — remaining members (together with / and also / and then)", () => {
  for (const [name, query] of [
    ["together with", `Explain how ${CONCERN_A} together with how ${CONCERN_B}.`],
    ["and also", `Explain how ${CONCERN_A} and also how ${CONCERN_B}.`],
    ["and then", `Explain how ${CONCERN_A} and then how ${CONCERN_B}.`],
  ] as const) {
    it(`"${name}" splits into 2 independent-question items`, () => {
      const items = extractRequestItems(query);
      expect(items.length, `query=${JSON.stringify(query)} items=${JSON.stringify(items.map((i) => i.text))}`).toBe(2);
      for (const item of items) {
        expect(headIsWhAfterReadLead(item.text), `${name}: item=${JSON.stringify(item.text)}`).toBe(true);
      }
    });
  }

  it('"and also"/"and then" consume the adverb -- the AFTER side never starts with a stray "also"/"then"', () => {
    const items = extractRequestItems(`Explain how ${CONCERN_A} and also how ${CONCERN_B}.`);
    expect(items[1]!.text.toLowerCase().startsWith("also")).toBe(false);
  });

  it("control: a compound object joined by \"together with\" outside a fresh wh-head stays fused (no spurious split)", () => {
    const items = extractRequestItems("Explain how the parser handles JSON together with YAML.");
    expect(items.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// B3: bracket / quote / backtick guard on the bare "and"/"as well as" split
// ---------------------------------------------------------------------------

describe("splitBareAndAtQuestionBoundary (via extractRequestItems) — B3 bracket/quote guard", () => {
  it("never splits inside parentheses — d12a class (confirmed live-broken pre-fix)", () => {
    // CONFIRMED regression on the tree BEFORE this fix (independent of H-4):
    // this exact query already mis-split into a dangling "(" fragment plus
    // an unrelated tail, because "How does the pipeline handle retries (and
    // how backoff is tuned)" already satisfied the OLD (unwidened)
    // `isIndependentQuestionClause` test on its own bare "How does" head —
    // the bracket, not the lead, was the missing guard.
    const q = "How does the pipeline handle retries (and how backoff is tuned) and how are errors logged?";
    const items = extractRequestItems(q);
    expect(items.map((i) => i.text)).toEqual([
      "How does the pipeline handle retries (and how backoff is tuned)",
      "how are errors logged?",
    ]);
  });

  it("never splits inside parentheses when the read-lead widening is what would otherwise trigger it", () => {
    const q = "Explain how the API handles [and how errors are wrapped] and how retries occur.";
    const items = extractRequestItems(q);
    expect(items.map((i) => i.text)).toEqual([
      "Explain how the API handles [and how errors are wrapped]",
      "how retries occur.",
    ]);
    expect(items.every((i) => !i.text.includes("[") || i.text.trim().endsWith("]") || !i.text.includes("]"))).toBe(true);
    // Neither half contains a lone, unbalanced bracket.
    for (const item of items) {
      const opens = (item.text.match(/\[/gu) ?? []).length;
      const closes = (item.text.match(/\]/gu) ?? []).length;
      expect(opens, item.text).toBe(closes);
    }
  });

  it("a legitimate split outside a bracket still happens, with the bracketed span kept whole", () => {
    const q = "Explain how the retry logic works (covering backoff and jitter) and how the queue drains.";
    const items = extractRequestItems(q);
    expect(items.map((i) => i.text)).toEqual([
      "Explain how the retry logic works (covering backoff and jitter)",
      "how the queue drains.",
    ]);
  });

  it("never splits inside a quoted phrase", () => {
    const q = 'Explain how the "fetch and retry" helper is implemented and how errors are logged.';
    const items = extractRequestItems(q);
    expect(items.map((i) => i.text)).toEqual([
      'Explain how the "fetch and retry" helper is implemented',
      "how errors are logged.",
    ]);
  });

  it("never splits inside square brackets, but does split a legitimate boundary right after them", () => {
    const q = "Explain how the parser handles [tokens and whitespace] and how errors surface.";
    const items = extractRequestItems(q);
    expect(items.map((i) => i.text)).toEqual([
      "Explain how the parser handles [tokens and whitespace]",
      "how errors surface.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Required controls (brief-fix-b.md "2. Controls that must NOT change")
// ---------------------------------------------------------------------------

describe("Required controls — must NOT change under this fix", () => {
  it("B4: a compound subject/object stays ONE concern (no split, no gap for half of it)", () => {
    expect(extractRequestItems("Explain how login and logout work.").length).toBe(1);
    expect(extractRequestItems("Describe how the parser reads and validates input.").length).toBe(1);
  });

  it("a quoted phrase containing 'and' is never treated as two independent requests", () => {
    const items = extractRequestItems('Explain how "start and stop" works.');
    expect(items.length).toBe(1);
  });

  it("an in-question example ('such as …') never becomes a required independent request", () => {
    const items = extractRequestItems(
      "Explain how retries are scheduled, such as backoff and jitter, and how logs are rotated.",
    );
    const exampleItem = items.find((i) => i.text.toLowerCase().startsWith("such as"));
    expect(exampleItem, JSON.stringify(items.map((i) => i.text))).toBeDefined();
    expect(headIsWhAfterReadLead(exampleItem!.text)).toBe(false);
  });

  it("a negation ('but not how …') never becomes an independent request of its own", () => {
    const items = extractRequestItems("Explain how caching works but not how eviction is triggered.");
    // No bare "and"/"as well as"/comma/semicolon boundary exists here at
    // all, so this must stay exactly one item — the negated clause is
    // never carved out as its own point.
    expect(items.length).toBe(1);
  });

  it("a type/member-name mention (dotted identifier) splits cleanly without breaking on its own '.'", () => {
    const items = extractRequestItems(
      "Explain how CacheEntry.expiresAt is computed and how TtlCache.get reads it.",
    );
    expect(items.length).toBe(2);
    expect(items[0]!.text).toContain("CacheEntry.expiresAt");
    expect(items[1]!.text).toContain("TtlCache.get");
  });

  it("a single-concern question stays a single item (no gaps machinery engages at all)", () => {
    expect(extractRequestItems("Explain how credentials are validated.").length).toBe(1);
    expect(extractRequestItems("How is the coupon discount validated?").length).toBe(1);
  });

  it("an edit request containing ' and how ' carries no read lead — never touched by this predicate", () => {
    const q = "Change MAX_RETRIES to 5 and how backoff works.";
    // Structurally unaffected: no read lead exists to strip, so
    // headIsWhAfterReadLead degrades to isIndependentQuestionClause's
    // existing (unchanged) answer, and the query stays fused exactly as
    // before this fix — change-task routing has nothing new to see here.
    expect(extractRequestItems(q).length).toBe(1);
    expect(headIsWhAfterReadLead(q)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Japanese
// ---------------------------------------------------------------------------

describe("Japanese — question-ending fix and the read-lead compound's known limit", () => {
  it("H-4 residual: two genuine JA questions ending in 'か。' (natural sentence-final punctuation) both retain", () => {
    // CONFIRMED broken on the tree before this fix: the trailing full-width
    // "。" after "か" made JA_QUESTION_END_RE miss BOTH clauses outright (not
    // an H-4/read-lead issue — isIndependentQuestionClause itself never saw
    // these as questions at all).
    const q = "認証情報はどこで検証されますか。また、データベースのマイグレーションはどのように実行されますか。";
    const items = extractRequestItems(q);
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(isIndependentQuestionClause(item.text), item.text).toBe(true);
      expect(headIsWhAfterReadLead(item.text), item.text).toBe(true);
    }
  });

  it("a bare 'か' ending (no trailing 。) still matches, unaffected by the widening", () => {
    expect(isIndependentQuestionClause("どこで検証されますか")).toBe(true);
  });

  it("KNOWN LIMIT (open question, not fixed by this change): a JA read-lead compound phrased as two NOUN-PHRASE objects of one trailing 'explain' (no embedded か-question in either half) is not recognized by headIsWhAfterReadLead — arch-map-b.md's own open question (1)", () => {
    const q = "認証情報の検証方法と、データベースマイグレーションの実行方法を説明してください。";
    const items = extractRequestItems(q);
    expect(items.length).toBe(2);
    // Documented limitation, not asserted as a defect: neither half is
    // phrased as an embedded question, so there is no wh-question for this
    // EN-vocabulary-based predicate to find after stripping a (JA) read
    // lead — see this file's own header and the wave report for why a JA
    // widening was not attempted (see arch-map-b.md open question 1).
    for (const item of items) {
      expect(headIsWhAfterReadLead(item.text), item.text).toBe(false);
    }
  });
});
