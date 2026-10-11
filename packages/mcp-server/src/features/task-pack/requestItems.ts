/**
 * requestItems.ts — DESIGN-v0.15-exploration-continuation-reliability.md R1
 * ("論点ごとの証拠による完了判定"). Deterministic EN/JA extraction of the
 * explicit points a composite request names, kept as verbatim spans so a
 * downstream obligation can be minted per point instead of collapsing a
 * multi-point request into one coarse "surface-content" check.
 *
 * Pure and fs-free by design (contract §3.1): `extractRequestItems` never
 * touches the filesystem — `RequestItemIndexView` is the only extension
 * point for workspace-derived aliases, and `createWorkspaceIndexView` (also
 * exported here) is the one real implementation of it, built from the same
 * `enumerateFindTextUniverse` walk `findText.ts` already uses. Aliases are
 * never proofs — they only widen what a later literal search may look for
 * (design §4.1: index-derived candidates are not evidence).
 *
 * Kept deliberately conservative: a query that does not look like a
 * multi-point request extracts to 0-1 items, and callers are expected to
 * gate any new obligation on `items.length >= 2` so a single-target query's
 * existing behaviour never changes (wave1-contract.md §3.4).
 */

import {
  isNegatedInstructionClause,
  isFacetDescriptorTerm,
  callShapedNamesIn,
  maskCallArgumentPunctuation,
  maskExplanationAspectPhrases,
  maskJapaneseRequestPredicates,
} from "./requestFacets.js";
import { isProseAcronym } from "./concernRecovery.js";
import { JA_GLOSSARY } from "../retrieval/jaGlossary.js";
import { KATAKANA_RUN_RE } from "../../util/cjkSpans.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RequestItemKind = "definition" | "decision" | "relation" | "topic";

export interface RequestItemRelation {
  /** Producer terms/identifiers the consumer is expected to read from. */
  from: string[];
  /** Consumer terms/identifiers (files/symbols) expected to reflect `from`. */
  to: string[];
}

export interface RequestItem {
  /** Stable within one extraction of one query: "ri-1", "ri-2", ... */
  id: string;
  /** Verbatim original span this item was extracted from. */
  text: string;
  kind: RequestItemKind;
  /** Literal identifiers/keys/file names/quoted strings, verbatim from the query. */
  terms: string[];
  /** Index-derived candidates (file/symbol names). NEVER treated as proof by themselves. */
  aliases: string[];
  /** Present only for `kind:"relation"` items. */
  relation?: RequestItemRelation;
  /** Has at least one term or alias that can be searched literally. */
  bindable: boolean;
  /**
   * R2-T2 (2026-09-30, review-0929 P0-5): set on every item one clause's
   * coordinated noun-phrase split produced ("Explain X and the health probe"
   * → "Explain X" + "the health probe") — each is its own point, which a
   * caller must locate or disclose, never leave silently open
   * (readCodeTaskPack.ts `buildRequestItemReadiness`).
   */
  coordinated?: true;
  /**
   * R2-T2 follow-up (2026-09-30, orchestrator ruling on the round-2 combined
   * run): the identifiers a facet clause claiming this point INHERITS from
   * the query's lead, when the point names no subject of its own — "Who
   * calls sendInvoice?\n- callers passing a weight above 5", "For the
   * grace_table …:\n- when is a customer refused a refund", "Does chargeCard
   * …, and what is the default duration?". Such a point is about that
   * identifier (brief-wp-c3 rule 2(c)/(d), "a facet-owned clause → never"):
   * none of its plain words may be certified absent. Set by
   * readCodeTaskPack.ts `buildRequestItemReadiness`, never by extraction.
   */
  facetSubject?: readonly string[];
}

/**
 * A tiny interface over the workspace symbol/file index: `lookup(noun)`
 * returns file basenames/paths and symbol names that plausibly correspond to
 * `noun`, matched case-insensitively after space/camel normalization. Must
 * never fabricate a path — only real, currently-existing workspace entries.
 */
export interface RequestItemIndexView {
  lookup(noun: string): string[];
}

// ---------------------------------------------------------------------------
// Shared fuzzy-matching primitives (exported for reuse by proof logic)
// ---------------------------------------------------------------------------

/** Lowercase, alnum-only projection used for cross-script/cross-case comparisons. */
export function coreToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/**
 * True when `a` and `b` share a long-enough contiguous alnum run once both
 * are reduced to `coreToken`. Cheap, general substitute for stemming: it is
 * what lets "getDisplayLanguage" relate to "tokenlighten.displayLanguage"
 * (shared "displaylanguage") or "status bar" relate to "statusBar.ts"
 * (containment) without hand-coding either identifier.
 */
export function sharesSignificantSubstring(a: string, b: string, min = 8): boolean {
  const x = coreToken(a);
  const y = coreToken(b);
  if (x.length === 0 || y.length === 0) return false;
  // Finding 2 fix (2026-09-07): this short-circuit used to ignore `min`
  // entirely (a hardcoded `>= 4`), so any caller-chosen floor (5/8/10 at this
  // file's own call sites) was inert whenever one string fully contained the
  // other — the exact shape a long identifier mention inside a large served
  // body hits. `min` now gates this branch identically to the general
  // sliding-window search below it.
  if (x.includes(y) || y.includes(x)) return Math.min(x.length, y.length) >= min;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  const upper = Math.min(shorter.length, 24);
  for (let len = upper; len >= min; len--) {
    for (let start = 0; start + len <= shorter.length; start++) {
      if (longer.includes(shorter.slice(start, start + len))) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small EN/JA(+katakana) glossary — best-effort cross-language bridging for
// TokenLighten's own domain (VS Code extension UI concepts: settings,
// language/display, status bar, update notifications). This is a WORD-LEVEL
// glossary, never a file-name special case (design §2 差分4 / §4.1's own
// instruction not to special-case fixture file names in the product).
// ---------------------------------------------------------------------------

// Finding 6 fix (2026-09-07): every right-hand side below is a literal,
// general JA(+katakana)->EN lexeme translation — a bare dictionary entry that
// would read the same way in any workspace, never a word chosen because it
// happens to spell part of THIS fixture's file names. Two prior entries were
// exactly that: `/通知/ -> ["notification","update","checker"]` translated
// "notification" into "update"/"checker" only because updateChecker.ts's
// basename needed those tokens to be found, and `/ステータスバー/ ->
// ["statusbar","status","bar"]` added the concatenated compound "statusbar"
// for the same reason (statusBar.ts). Both are removed; "status" and "bar"
// remain as their OWN plain single-word translations of the katakana
// loanwords "ステータス"/"バー" (already fired independently by the patterns
// below whenever "ステータスバー" appears, since it contains both as
// substrings — no compound entry is needed to reach the same basename via
// `sharesSignificantSubstring`'s containment check). Any further bridging
// (e.g. resolving "更新通知" as a whole to a file named `updateChecker.ts`)
// must come from a token the workspace index itself derives from real
// basenames, never from naming that file's parts here.
const GLOSSARY_SEEDS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/バー/gu, ["bar"]],
  [/ステータス/gu, ["status"]],
  [/通知/gu, ["notification"]],
  [/更新/gu, ["update"]],
  [/確認/gu, ["check"]],
  [/チェック/gu, ["check"]],
  [/設定項目|設定/gu, ["setting"]],
  [/定義/gu, ["definition"]],
  [/表示/gu, ["display"]],
  [/言語/gu, ["language"]],
  [/決定|判定/gu, ["decision", "decide"]],
  [/ロジック/gu, ["logic"]],
  // FIXALL-A group E (2026-09-14): 変更履歴 / 更新履歴 = "change history", which
  // standard Japanese technical prose renders "changelog" — the same plain
  // lexeme translation every other row here carries, and the reason this row
  // passes finding 6's own test ("a bare dictionary entry that would read the
  // same way in any workspace"): it is what the WORDS mean, not a word picked
  // because it spells a basename. Measured gap it closes: the EN register
  // `Replace the changelog?` resolves and reaches act.edit, while the
  // byte-equivalent 「変更履歴を修正してください」 surfaced NOTHING at all — an
  // EN/JA asymmetry with no design behind it. "history" rides along as the
  // literal rendering of 履歴 on its own.
  [/変更履歴|更新履歴/gu, ["changelog", "history"]],
];

function glossarySeeds(text: string): string[] {
  // 2026-10-10: a request predicate is no subject — 「…を確認してください」 must
  // not seed "check" (requestFacets.ts `maskJapaneseRequestPredicates`).
  const subject = maskJapaneseRequestPredicates(text);
  const seeds = new Set<string>();
  for (const [pattern, words] of GLOSSARY_SEEDS) {
    pattern.lastIndex = 0;
    if (pattern.test(subject)) for (const w of words) seeds.add(w);
  }
  return [...seeds];
}

// ---------------------------------------------------------------------------
// Stopwords / salient words (contract §3.3: topic-item literal find over
// salient words, >=4 chars, not stopwords, EN/JA)
// ---------------------------------------------------------------------------

// N7(a) (r-b2, 2026-09-21, review finding N7) — "also"/"plus"/"then" added: a
// coordinator/discourse-filler word carries no lexical content of its own,
// exactly like "and"/"which"/"about" already on this list (the same
// generalized test STOPWORDS already applies: "would this word's absence
// ever tell a reader something distinguishing about a workspace?"). Root
// cause: `; also how database migrations are executed.` never reads as its
// own independent question under any pre-r-b2 predicate revision (`also` is
// not stripped by `isIndependentQuestionClause`'s narrower coordinator
// strip), so it fell through to the generic Tier-based absence scan, whose
// candidate pool is exactly this file's `salientWords()` — and without this
// entry, "also" (>=4 chars) was a live candidate, observed reported verbatim
// as part of a gap's wording ("also/database/migrations/executed"). "plus"
// and "then" are the SAME class (two more members of this file's own
// `BARE_AND_RE` coordinator alternation) and were never real search targets
// either, so they are excluded for the identical reason regardless of which
// joiner surfaced them.
const STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "from", "into", "onto", "your",
  "their", "there", "where", "which", "about", "explain", "describe",
  "please", "what", "does", "how", "when", "and", "the", "for", "are", "was",
  "were", "have", "has", "had", "not", "you", "our", "its",
  "also", "plus", "then",
]);

/**
 * TL142-04 (2026-09-13, v0.14.2 hands-on report §4 TL142-04) — a bare
 * Japanese grammatical PARTICLE carries no lexical content of its own
 * (mirrors util/queryShape.ts's own extractCjkQueryTokens reasoning for its
 * separate free-text-query CJK tokenizer: "Hiragana runs in ordinary prose
 * are overwhelmingly particle strings and verb/adjective inflection... with
 * no standalone lexical meaning") and a run ending in a request/verb
 * inflection ("...してください") is an INSTRUCTION about what to do, never a
 * target to search for. Neither may ever become an absence-test candidate —
 * see readCodeTaskPack.ts's `distinctiveSalientAbsence`, the sole consumer
 * that turns this function's output into a disclosed/verified absence.
 */
const JA_BARE_PARTICLES_LONGEST_FIRST = ["から", "まで", "より", "の", "が", "を", "に", "へ", "と", "で", "は", "も", "か", "や", "ね", "よ"];
/**
 * Review round SHOULD-FIX 7 (2026-09-13): alternatives are ordered
 * LONGEST-first (から/まで/より before their single-char prefixes か/よ).
 * JS regex alternation is first-match-wins, not longest-match, so the old
 * inline order (…|か|から|まで|より|や…) truncated a leading "から"/"より" run
 * to just "か"/"よ", stranding a stray "ら"/"り" at the front of the
 * stripped candidate. Nothing existing exercised a leading から/まで/より
 * run, so reordering only widens what strips cleanly — the `+` below is
 * the same widening for a RUN of consecutive particles (a leading "からの"
 * is two particles, not one).
 */
const JA_BARE_PARTICLE_RE = new RegExp(`^(?:${JA_BARE_PARTICLES_LONGEST_FIRST.join("|")})+`, "u");
/** Same alternatives, unanchored and global — every occurrence, not only a
 *  leading one, so `lastBareParticleOccurrence` can find the RIGHTMOST one. */
const JA_BARE_PARTICLE_ANYWHERE_RE = new RegExp(`(?:${JA_BARE_PARTICLES_LONGEST_FIRST.join("|")})`, "gu");
/**
 * N7(b) (r-b2, 2026-09-21, review finding N7) — same alternatives as
 * `JA_BARE_PARTICLE_RE`, anchored at the END instead of the start. A run's
 * own TRAILING particle (most commonly the list conjunction "と"/"や" a
 * clause splitter had no structural boundary to cut at — `splitEnumerated`'s
 * own comment records why a bare "と" is deliberately never split there)
 * carries no lexical content of its own and must never survive verbatim into
 * a returned salient word: `stripTrailingInstructionClauses` below already
 * peels the mirror-image LEADING case one call up (`salientWords`'
 * `JA_BARE_PARTICLE_RE` strip, before this function ever runs), and
 * `isGenericJapaneseAbsenceRun`'s own genericity TEST already strips a
 * trailing hiragana edge to decide "is this a generic word" — but never
 * exposed that trimmed form as the CANDIDATE ITSELF, so a run whose trimmed
 * core is not a short generic word (a long, real, specific phrase) survived
 * WITH its particle still attached. See `stripTrailingInstructionClauses`'s
 * own doc comment for the full repro
 * ("キャッシュが期限切れの場合の処理と" reported verbatim, と included).
 */
const JA_TRAILING_BARE_PARTICLE_RE = new RegExp(`(?:${JA_BARE_PARTICLES_LONGEST_FIRST.join("|")})+$`, "u");

/** Strips a trailing run of bare particles (`JA_TRAILING_BARE_PARTICLE_RE`) — a no-op when `run` has none. */
function stripTrailingBareParticle(run: string): string {
  return run.replace(JA_TRAILING_BARE_PARTICLE_RE, "");
}
/** Suffix form (matches at the END) — used both to test "does this run end
 *  in an instruction" and (via `.replace`) to peel that suffix off once a
 *  peel has isolated a run with no particle left to split on. */
const JA_REQUEST_INFLECTION_RE = /(?:してください|して下さい|してほしい|しなさい|すること|します|する|ください|下さい|せよ|して)$/u;
/** Exact-match form (matches the WHOLE string) — used by isGenericClosing below to merge a bare instructional fragment back into its preceding item, never a longer clause that merely ENDS in one of these. */
const JA_REQUEST_INFLECTION_ONLY_RE = /^(?:してください|して下さい|してほしい|しなさい|すること|します|する|ください|下さい|せよ|して)$/u;

/** Index/end of the LAST (rightmost) bare-particle occurrence in `run`, or
 *  undefined if none — see `stripTrailingInstructionClauses`. */
function lastBareParticleOccurrence(run: string): { start: number; end: number } | undefined {
  let last: { start: number; end: number } | undefined;
  for (const m of run.matchAll(JA_BARE_PARTICLE_ANYWHERE_RE)) {
    last = { start: m.index ?? 0, end: (m.index ?? 0) + m[0].length };
  }
  return last;
}

/**
 * SHOULD-FIX 7 (2026-09-13, review round). `salientWords`' CJK match is one
 * UNSEGMENTED run (`[぀-ヿ一-鿿]{2,}`), so a compound clause with no
 * ASCII/whitespace boundary — "初期化する処理を説明してください" — was ONE
 * candidate, and the old rule ("ends in a request inflection -> drop the
 * WHOLE candidate") threw the entire clause away, losing the leading
 * lexical stem (初期化) the report's own acceptance requires kept. A run
 * that does NOT itself end in an inflection is returned completely
 * UNCHANGED (still just the one generic-word check) — the pre-existing
 * "embedded particle survives whole" behaviour (e.g. "キャッシュの有効期限",
 * unaffected by this fix, and an existing spec pins exactly that) — this
 * only peels a run that actually hits the bug.
 *
 * Peeling (find the RIGHTMOST bare particle, split, recurse on both
 * halves) rather than an unconditional particle split: it is the minimal
 * change that fixes the reported regression without shredding a legitimate
 * multi-particle noun phrase the pre-existing behaviour (and a pre-existing
 * spec) already relies on staying fused — the head is usually a real noun
 * phrase and, once it no longer itself ends in an inflection, recursion
 * stops and it is kept whole, particles and all. A run with NO particle at
 * all that still ends in an inflection (トークン検証する, 非同期化する — a
 * bare verb suffix directly on a noun/katakana stem, nothing to split on)
 * falls back to stripping just the inflection suffix once.
 */
/**
 * FIXALL-A group D (2026-09-14) — THE BARE CONTINUATIVE IS AN INSTRUCTION TOO.
 *
 * `JA_REQUEST_INFLECTION_RE` above lists the terminal request forms
 * (してください/しなさい/して/する/…) but not the bare continuative 〜し, which is
 * how an ordinary multi-clause Japanese request joins its clauses
 * (「…の役割を確認し、…を改名してください。」). `salientWords` matches one
 * UNSEGMENTED CJK run, so the whole clause 「役割を確認し」 survived as a single
 * search target and the pack shipped a verified-absence gap for it — a literal
 * find for a phrase that says what to DO, exactly the class TL142-04's doctrine
 * ("a run ending in a request/verb inflection is an INSTRUCTION, never a target
 * to search for") exists to exclude.
 *
 * A bare し cannot simply be added to `JA_REQUEST_INFLECTION_RE`: し ends plenty
 * of ordinary NOUNS (繰り返し, 取り消し, 書き出し), and peeling it there would
 * corrupt them into 繰り返/取り消/書き出. So this suffix is anchored to the ONE
 * JA request-verb vocabulary instead: only 「<a recognized request verb>し」 at the
 * very end counts, and the peel removes the verb with it (a request verb is
 * never itself a subject — the same rule `isGenericJapaneseAbsenceTerm` applies
 * to the bare root).
 */
let jaRequestVerbContinuativeRe: RegExp | undefined;
function jaRequestVerbContinuative(): RegExp {
  jaRequestVerbContinuativeRe ??= new RegExp(
    `(?:${[...EDIT_VERB_JA_ROOTS, ...READ_VERB_JA_SURU_ROOTS].join("|")})し$`,
    "u",
  );
  return jaRequestVerbContinuativeRe;
}

/** The trailing-instruction pattern `run` ends in, or undefined when it ends in none. */
function trailingInstructionPattern(run: string): RegExp | undefined {
  if (JA_REQUEST_INFLECTION_RE.test(run)) return JA_REQUEST_INFLECTION_RE;
  if (jaRequestVerbContinuative().test(run)) return jaRequestVerbContinuative();
  return undefined;
}

function stripTrailingInstructionClauses(run: string): string[] {
  const inflection = trailingInstructionPattern(run);
  if (inflection === undefined) {
    // N7(b): a run that is not itself an instruction may still carry a
    // trailing BARE PARTICLE with no lexical content of its own — peeled
    // the SAME way the leading edge already is (`JA_TRAILING_BARE_PARTICLE_RE`,
    // mirroring `salientWords`' own `JA_BARE_PARTICLE_RE`), so
    // "…の処理と" is reported (and searched for) as "…の処理", never with
    // its trailing "と" attached. A run left with nothing lexical after the
    // peel (<= 1 char, i.e. the run WAS only a particle) falls back to the
    // untrimmed original rather than emitting an empty/near-empty candidate.
    const trimmed = stripTrailingBareParticle(run);
    const candidate = trimmed.length > 1 ? trimmed : run;
    return isGenericJapaneseAbsenceRun(candidate) ? [] : [candidate];
  }
  const particle = lastBareParticleOccurrence(run);
  if (particle === undefined) {
    const stem = run.replace(inflection, "");
    if (stem.length <= 1) return [];
    return isGenericJapaneseAbsenceRun(stem) ? [] : [stem];
  }
  const head = run.slice(0, particle.start);
  const tail = run.slice(particle.end);
  const survivors: string[] = [];
  if (head.length > 1) survivors.push(...stripTrailingInstructionClauses(head));
  if (tail.length > 1) survivors.push(...stripTrailingInstructionClauses(tail));
  return survivors;
}

/**
 * Words >= 4 chars, not stopwords — the candidate pool this scans over.
 *
 * P1-9 (eval-0927 review-r2 #9, perfEdge): a word outside BOTH ASCII and the
 * Hiragana/Katakana/Han block above — Latin-with-diacritics (`größe`),
 * Cyrillic, Greek, ... — matched neither alternative, so a request item
 * naming one produced NO salient word for it at all (`bindable:false`, the
 * same shape as the JA kanji-only gap this file's own P0-2 fix already
 * closed for concept TERMS, here for the topic-item literal-find pool
 * instead). The added `\p{L}{4,}` alternative is tried LAST, so it only
 * ever activates where NEITHER existing alternative already matched —
 * zero behavior change for ASCII or CJK input, coverage added only for
 * scripts neither covers. `isCjkRun` below still classifies whatever text
 * any alternative captures by its own content, so this never double-routes
 * a CJK run through the wrong branch.
 */
const SALIENT_WORD_RE = /[A-Za-z0-9_]{4,}|[぀-ヿ一-鿿]{2,}|\p{L}{4,}/gu;

/**
 * C32 fix (chip wave, 2026-09-14, review-findings-2.md) — global span-only
 * variant of `QUOTED_LITERAL_ANYWHERE_RE` (backtick/double/single ASCII
 * quotes plus JA bracket quotes 「」/『』), used ONLY to compute quoted-span
 * character ranges so `salientWords` can test whether a candidate word's own
 * match index falls inside one. Kept as a SEPARATE constant from
 * `QUOTED_LITERAL_ANYWHERE_RE` (below, `.test()`-only) so the two unrelated
 * call sites never share mutable `lastIndex` state.
 */
const QUOTED_SPANS_RE = /[`"']([^`"']{2,})[`"']|「([^」]{2,})」|『([^』]{2,})』/gu;

/** Character ranges `text` explicitly quotes — end-exclusive `[start,end)`
 *  pairs covering the WHOLE quoted span, quote marks included, so a
 *  candidate word fully inside one is trivially contained. */
function quotedSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(QUOTED_SPANS_RE)) {
    const start = m.index ?? 0;
    spans.push({ start, end: start + m[0].length });
  }
  return spans;
}

/**
 * P1-8 (eval-0927 review r2 finding 8, classFlowLifecycle/classFlowHandle):
 * a small, closed set of ENGLISH SEQUENCING IDIOMS a flow/order question
 * commonly wraps its real subject in — "step by step", "end-to-end", "in
 * its lifecycle", "in what order", and the question's own "how ... handle(s)"
 * verb construction. None of these names workspace content of its own: they
 * are the QUESTION'S OWN GRAMMAR, never something a served file could
 * mention verbatim, so shipping one as a `salientWords` candidate produces a
 * false `request-item-absent:step`/`:lifecycle` disclosure — measured on
 * "How does OrderFlow handle payment and shipping, step by step?" against a
 * class that (correctly) never spells "step" or "lifecycle" anywhere. A bare
 * per-word stoplist cannot fix this without ALSO suppressing the same words
 * used as real domain terms elsewhere ("the payment queue's processing
 * order", "the request handler") — brief's own constraint — so this masks
 * the fixed multi-word SHAPES only, length-preserving (space-fill) exactly
 * like `maskReadLeadSpan`/`stripValueOnlyLeadClauses` below, so `quotedSpans`
 * (computed on the ORIGINAL text) keeps valid offsets. The "how ... handle(s)"
 * case blanks ONLY the verb itself, keeping "how" and whatever sits between
 * them (the real subject, e.g. "OrderFlow") untouched — masking the whole
 * span would risk eating a genuine identifier the clause needs elsewhere;
 * bounded to the same clause (`[^.?!]*?`, non-greedy, never crosses a
 * sentence end) so an unrelated later "handle" in a different question is
 * never touched.
 */
const STEP_BY_STEP_IDIOM_RE = /\bsteps?[\s-]+by[\s-]+step\b/giu;
const END_TO_END_IDIOM_RE = /\bend[\s-]+to[\s-]+end\b/giu;
const IN_ITS_LIFECYCLE_IDIOM_RE = /\bin\s+(?:its|their|his|her|the)\s+lifecycle\b/giu;
const IN_WHAT_ORDER_IDIOM_RE = /\bin\s+what\s+order\b/giu;
const HOW_X_HANDLES_IDIOM_RE = /\b(how)\b([^.?!]*?)\b(handles?)\b/giu;

function maskPhrasingIdiomSpans(text: string): string {
  // 2026-10-06 independent review (P2-1): "edge cases" and its kin name the
  // kind of answer, never a searchable word (requestFacets.ts). 2026-10-10: a
  // Japanese request / politeness predicate closing a clause (「…を教えて
  // ください」「…を知りたいです」「…について教えて」) is never one either — the
  // te-form 教えて survived ください's peel as a second topic word of its
  // point (requestFacets.ts `maskJapaneseRequestPredicates`).
  let out = maskJapaneseRequestPredicates(maskExplanationAspectPhrases(text));
  for (const re of [STEP_BY_STEP_IDIOM_RE, END_TO_END_IDIOM_RE, IN_ITS_LIFECYCLE_IDIOM_RE, IN_WHAT_ORDER_IDIOM_RE]) {
    out = out.replace(re, (m) => " ".repeat(m.length));
  }
  out = out.replace(HOW_X_HANDLES_IDIOM_RE, (_m, howWord: string, mid: string, verb: string) => `${howWord}${mid}${" ".repeat(verb.length)}`);
  return out;
}

/** Words >= 4 chars, not stopwords — the pool a topic item's literal find scans for. */
export function salientWords(text: string): string[] {
  const quoted = quotedSpans(text);
  const isQuoted = (start: number, end: number): boolean =>
    quoted.some((span) => start >= span.start && end <= span.end);
  /**
   * FIXALL-A group D (2026-09-14) — THE SECOND CONSUMER OF BLOCKER 61's OWN FIX.
   *
   * `stripValueOnlyLeadClauses` blanks the span of a clause that carries a
   * read/edit lead AND is object-free by BLOCKER 34's whitelist — by
   * construction a verb, an optional pronoun and an optional bare value, naming
   * NOTHING a search could look for. Round 12 applied it to the locator's
   * identifier tokenizer and stopped there, so this function still handed the
   * bare VERB to the topic-item literal find: `Increase it to 5.` produced
   * `salientWords` `["Increase"]` and the pack answered `discover` with
   * `tl_search_files{queries:["increase"]}` — sending the caller to grep the
   * workspace for the word they used to ask for the change. Same leak, same
   * predicate, one consumer over.
   *
   * Blanking is length-preserving, so `quotedSpans` above (computed on the
   * ORIGINAL text) keeps its indices, and only the scan below reads the blanked
   * copy. A clause that names any real object — `explain how route handlers work`
   * — is not object-free and is untouched, so ordinary nouns that happen to
   * spell a mutation verb stay searchable.
   */
  // R-B3 (ruling 6): the lead span of a generalised read lead is masked (same
  // length, so `isQuoted`'s offsets stay valid) — see `maskReadLeadSpan`.
  // P1-8: phrasing-idiom spans are masked FIRST (same length-preserving
  // contract), before the read-lead/value-only masks run over what remains.
  const scanned = stripValueOnlyLeadClauses(maskReadLeadSpan(maskPhrasingIdiomSpans(text)));
  const out: string[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: string): void => {
    const dedupeKey = candidate.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push(candidate);
  };
  for (const m of scanned.matchAll(SALIENT_WORD_RE)) {
    const raw = m[0];
    const key = raw.toLowerCase();
    if (/^[a-z0-9_]+$/u.test(key) && STOPWORDS.has(key)) continue;
    if (!isCjkRun(raw)) {
      pushCandidate(raw);
      continue;
    }
    // C32 fix (chip wave, 2026-09-14): TL142-04's own "an explicitly quoted
    // span is verbatim" doctrine (see `queryHasQuotedLiteral`'s doc comment:
    // a quoted literal "must stay a search target — or a disclosed
    // absence — even when it reads exactly like a banned particle/verb-
    // ending") extends to THIS step — a leading bare-particle run ("からの",
    // "までの", ...) that is itself an EXPLICITLY QUOTED span is real content
    // the caller singled out, not incidental grammar wrapping a bigger
    // clause, and must never be stripped to nothing by (a) below. Only step
    // (a) is short-circuited here — a quoted span that separately ends in a
    // genuine trailing instruction clause is still peeled by (b)/(c) exactly
    // as before (see the pinned "としてください" case in the SHOULD-FIX 7
    // table below: unaffected by this fix, since it is dropped by (b)/(c)'s
    // own inflection-ending test, never by (a)).
    const start = m.index ?? 0;
    const quotedWhole = isQuoted(start, start + raw.length);
    // (a) strip a leading bare-particle RUN (one-or-more consecutive
    // particles, e.g. leading "からの"); nothing lexical left (or a single
    // dangling character) means this run was ONLY grammar.
    const stripped = quotedWhole ? raw : raw.replace(JA_BARE_PARTICLE_RE, "");
    if (!quotedWhole && stripped.length <= 1) continue;
    if (quotedWhole) {
      // FIXALL-A group G (2026-09-14) — TL142-04's acceptance, completed. The
      // C32 fix above short-circuited only step (a), and its own comment is
      // candid that a quoted span which separately ENDS in a trailing
      // instruction clause is still peeled by (b)/(c). For a span that is
      // WHOLLY such an ending — the report's own `"してください"` /
      // `"としてください"` cases — (b)/(c) reduce it to a 0-length stem and
      // drop it entirely, which contradicts the acceptance line verbatim ("an
      // explicitly QUOTED identical string still stays a search target"). The
      // exemption therefore covers the whole pipeline, not just its first step:
      // once the caller has put quote marks around a string, it is content they
      // singled out, and no grammar heuristic gets to decide otherwise. An
      // UNQUOTED occurrence of the same string is unaffected and still peeled.
      pushCandidate(stripped);
      continue;
    }
    // (b)+(c) peel any trailing instruction clause(s) — per sub-run, not
    // the whole remainder — and apply the generic-word test to each
    // surviving stem; see `stripTrailingInstructionClauses`'s own comment.
    for (const candidate of stripTrailingInstructionClauses(stripped)) {
      pushCandidate(candidate);
    }
  }
  return out;
}

/**
 * True when `word` is entirely CJK (Han/Hiragana/Katakana) characters — the
 * SAME character range as `salientWords`' own second extraction branch
 * (`[぀-ヿ一-鿿]{2,}`). `salientWords` itself does not tag which of its two
 * branches produced a given output entry, so a caller that needs to tell
 * them apart (verified-absence tiering, readCodeTaskPack.ts's
 * `distinctiveSalientAbsence`: EN salient words and CJK runs are handled by
 * different tiers) tests membership here instead. A single-purpose
 * classification test, not a re-derivation of the extraction itself — if
 * `salientWords`' own range ever changes, update this one too.
 */
export function isCjkRun(word: string): boolean {
  return /^[぀-ヿ一-鿿]{2,}$/u.test(word);
}

// ---------------------------------------------------------------------------
// Tier B generic-Japanese vocabulary (DESIGN-v0.15 R1 §4.2 generalization,
// 2026-09-08) — words so common/structural in Japanese technical prose that
// their absence, by itself, would never tell a reader something
// distinguishing about a workspace (the same test STOPWORDS/
// GENERIC_SOFTWARE_ABSENCE_WORDS — readCodeTaskPack.ts's Tier C list — apply
// to English: "would an absence of this word ever tell the reader something
// about the workspace?"). Kept short and hand-reviewed, one line each, same
// spirit as STOPWORDS above; unrelated to GLOSSARY_SEEDS above (that list
// bridges a JA word to workspace-index lookup SEEDS for alias resolution —
// this one excludes a JA word from verified-ABSENCE disclosure candidacy;
// a word can legitimately sit on both, doing two unrelated jobs).
// ---------------------------------------------------------------------------
const GENERIC_JA_ABSENCE_WORDS = new Set([
  "実装", // "implementation" — how code is organized, not a subject of its own
  "説明", // "explanation" — a request verb/genre word ("please explain"), not a subject
  "処理", // "processing"/"handling" — generic verb-noun for "does something"
  "機能", // "feature"/"function" — generic capability noun
  "対応", // "handling"/"support" — generic verb-noun
  "追加", // "addition" — generic change-kind word
  "修正", // "fix" — generic change-kind word
  "変更", // "change" — generic change-kind word
  "確認", // "confirmation"/"check" — generic verb-noun
  "方法", // "method"/"way" — generic manner noun
  "場合", // "case"/"situation" — generic conditional noun
  "方式", // "method"/"scheme" — generic manner noun
  "仕様", // "specification" — generic document-kind noun
  "概要", // "overview" — generic document-kind noun
  "全体", // "whole"/"overall" — generic scope noun
  "関連", // "related"/"relevant" — generic relevance noun
  "参照", // "reference" — generic pointer noun
  "定義", // "definition" — generic document-kind noun
  "部分", // "part"/"portion" — generic scope noun
  "設定", // "setting"/"configuration" — generic config noun
  "内容", // "content"/"substance" — generic content noun
  "一覧", // "list" — generic document-kind noun
  "理由", // "reason" — generic justification noun
  "影響", // "impact"/"effect" — generic consequence noun
  "現在", // "current"/"present" — generic temporal noun
  // FIXALL-A group D (2026-09-14): "role" — the head noun of the commonest JA
  // read request (「…の役割を説明してください」 = "explain the role of …"), the
  // same generic-scope class as 部分/内容/概要 already on this list. Its absence
  // from a workspace tells a reader nothing, and shipping it as a
  // verified-absence gap blocked closure on requests that named every file
  // they needed.
  "役割",
  "テスト", // "test" (katakana loanword) — generic artifact-kind noun
  "ファイル", // "file" (katakana loanword) — generic artifact-kind noun
  "コード", // "code" (katakana loanword) — generic artifact-kind noun
  "システム", // "system" (katakana loanword) — generic scope noun
  "データ", // "data" (katakana loanword) — generic content noun
  // WP-C (2026-09-29) listed the JA facet-DESCRIPTOR nouns here by hand
  // (条件/呼び出し元/既定値/ステータスコード). WP-C3 (orchestrator ruling rule
  // 2(a): ONE shared source, no second hand-maintained list) moved them out:
  // `isGenericJapaneseAbsenceTerm` below now asks requestFacets.ts's exported
  // `isFacetDescriptorTerm` — the facet detectors' own nouns — instead.
]);

/**
 * FIXALL-A group D (2026-09-14) — A REQUEST VERB IS NEVER AN ABSENCE CANDIDATE.
 *
 * The hand-written Tier-B list above already carries 追加/修正/変更/確認/設定/説明/
 * 実装 with exactly this reasoning ("a request verb/genre word ('please
 * explain'), not a subject") — and it stopped there, so 置換/改名/リネーム/更新/
 * 削除, added later to the JA lead vocabulary, were never added here. Measured
 * consequence: 「src/cache.ts の DEFAULT_TTL_MS の役割を確認し、src/retry.ts の
 * MAX_RETRIES を 5 に改名してください。」 — a request that names BOTH files
 * explicitly — shipped `gaps:[{code:"request-item-absent",refs:["ri-2","改名"]}]`
 * and could not close: the pack had gone looking for the literal string 改名 in
 * the workspace and correctly not found it, because 改名 is what the caller
 * asked to DO, not a thing to find. Same mechanism BLOCKER 61 named for the EN
 * verb-as-symbol leak, one list over.
 *
 * The union is taken at call time from the ONE JA verb vocabulary
 * (`EDIT_VERB_JA_ROOTS` / `READ_VERB_JA_*_ROOTS`), so a verb added there is
 * excluded here automatically and this list can never go stale again.
 */
// Built on first use, not at module load: the vocabularies it unions are
// declared further down this file (beside the regexes they build), and a
// top-level `new Set([...EDIT_VERB_JA_ROOTS])` here would read them in the
// temporal dead zone.
let genericJaAbsenceRequestVerbs: ReadonlySet<string> | undefined;
function genericJaRequestVerbs(): ReadonlySet<string> {
  genericJaAbsenceRequestVerbs ??= new Set([
    ...EDIT_VERB_JA_ROOTS,
    ...READ_VERB_JA_SURU_ROOTS,
    ...READ_VERB_JA_STEM_ROOTS,
  ]);
  return genericJaAbsenceRequestVerbs;
}

/**
 * True when `word` (a `salientWords`/`isCjkRun` CJK candidate) is on the short generic-Japanese absence-disclosure exclusion list above, or is a bare JA request verb.
 *
 * WP-C3 (2026-09-29, eval-0929 §6, rule 2(a)): or is, as a whole, a facet
 * DESCRIPTOR noun (条件, 呼び出し元, 既定値, ステータスコード, 一覧, 処理経路, …)
 * — read from requestFacets.ts's `isFacetDescriptorTerm`, the one shared
 * vocabulary, so the kind of answer a JA request names is never its own
 * absence candidate (WP-C's intent for its four hand-listed words, now for
 * the whole vocabulary those four were drawn from). CJK words only: an ASCII
 * word never reaches this list's callers as a JA term.
 */
export function isGenericJapaneseAbsenceTerm(word: string): boolean {
  return GENERIC_JA_ABSENCE_WORDS.has(word)
    || genericJaRequestVerbs().has(word)
    || (/[぀-ヿ一-鿿]/u.test(word) && isFacetDescriptorTerm(word));
}

/**
 * True when `run` — or its kanji/katakana CORE once plain-hiragana padding
 * is stripped from EITHER edge — is exactly one Tier-B generic word above.
 * Supersedes the old prefix-only `startsWithGenericJapaneseAbsenceNoun`
 * (review round SHOULD-FIX 7, 2026-09-13): once a per-sub-run peel (see
 * `stripTrailingInstructionClauses`) can isolate a generic noun with a
 * LEADING hiragana quantifier/determiner too (それぞれ + 説明, not just
 * 説明 + a trailing conjugation like します), genericity has to be judged
 * symmetrically — both are the same shape, a generic core wrapped in
 * ordinary prose glue on one side or the other.
 */
function isGenericJapaneseAbsenceRun(run: string): boolean {
  if (isGenericJapaneseAbsenceTerm(run)) return true;
  const core = run.replace(/^[ぁ-ん]+/u, "").replace(/[ぁ-ん]+$/u, "");
  return core.length > 0 && core !== run && isGenericJapaneseAbsenceTerm(core);
}

// ---------------------------------------------------------------------------
// Term extraction
// ---------------------------------------------------------------------------

/**
 * FIXALL-A group A (2026-09-14) — the curated file-extension whitelist, declared
 * ONCE. `FILE_EXT_RE` (basename-shaped, term extraction), `FULL_PATH_TERM_RE`
 * (path-shaped, lead attribution) and `CLAUSE_FILE_OBJECT_ONLY_EN_RE` (a clause
 * whose only object IS a file) all spell the same list; three hand-copied
 * spellings of one whitelist is the same drift class group C closed on the JA
 * verb side, so there is only one spelling now.
 */
const FILE_EXTENSIONS_ALT = "json|ts|tsx|js|jsx|mjs|cjs|md|mdx|py|java|go|rs|rb|toml|ya?ml|c|h|cpp|hpp|cs|kt|swift";
const FILE_EXT_RE = new RegExp(`\\b[A-Za-z0-9_.-]+\\.(?:${FILE_EXTENSIONS_ALT})\\b`, "gu");
// WP-C (2026-09-29, eval-0929 §6): `::` (Rust module paths / C++ scope
// resolution, "std::io", "OrderService::cancel") joins a QUALIFIED name the
// same way `.` already does — added as an alternative separator rather than
// a second regex, so "A.b" and "A::b" both extract as ONE dotted/qualified
// term (mirrors requestFacets.ts's own `QUALIFIED_MEMBER_RE`, which already
// treats `.`/`#`/`::` as the same kind of separator for a class/method pair).
const DOTTED_KEY_RE = /\b[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)+\b/gu;
const LOWER_CAMEL_RE = /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu;
const UPPER_CAMEL_RE = /\b[A-Z][a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu;
const CONST_CASE_RE = /\b[A-Z][A-Z0-9_]{2,}\b/gu;
/**
 * WP-C (2026-09-29, eval-0929 §6) — snake_case/SCREAMING_SNAKE identifiers
 * with a LOWERCASE (or mixed-case) leading letter: `get_timeout`,
 * `should_retry`, `send_request`. `CONST_CASE_RE` above already recognizes
 * the ALL-CAPS spelling (`MAX_RETRY_COUNT`); this is its lowercase/mixed
 * sibling — the one common identifier shape (Python/Rust/Ruby/C naming
 * convention) this file's identifier regexes had NO alternative for at all.
 * Measured root cause: such a term matched none of the regexes above (no
 * dot, no camelCase hump, not all-caps), so it fell out of `item.terms`
 * ENTIRELY rather than being merely misclassified — which starved
 * `distinctiveSalientAbsence`'s Tier A (readCodeTaskPack.ts) and forced a
 * fallback to a lowercase DESCRIPTIVE word instead (a Python fixture whose
 * `should_retry`/`send_request` are real, present functions was certified
 * `request-item-absent:conditions`/`:callers` — the descriptive words, never
 * the identifiers actually named). Any run of ASCII letters/digits
 * containing at least one `_` and starting with a letter, mirroring
 * requestFacets.ts's own `explicitIdentifiersIn`'s `token.includes("_")`
 * rule so the two modules recognize the same identifiers from the same
 * query text (that function's own module-boundary contract keeps it
 * fs-free/import-free from this file, so the RULE is shared, not the code).
 */
const SNAKE_CASE_RE = /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\b/gu;
const QUOTED_RE = /[`"']([^`"']{2,})[`"']/gu;
/** Any quoted-literal span this file's own extraction recognizes — used
 *  ONLY as a presence check (never captures/extracts), so ONE alternation
 *  covering every quote style Decision 6 (TL142-04) names is enough:
 *  backtick/double/single (QUOTED_RE's own class) plus JA bracket quotes
 *  「…」/『…』, which QUOTED_RE itself does not match. */
const QUOTED_LITERAL_ANYWHERE_RE = /[`"']([^`"']{2,})[`"']|「([^」]{2,})」|『([^』]{2,})』/u;

/**
 * TL142-04 (2026-09-13) — true when `query` names at least one quoted
 * literal string. An explicitly quoted identical string is EXEMPT from
 * every request/particle/generic-closing exclusion above (Decision 6): it
 * must stay a search target — or a disclosed absence — even when it reads
 * exactly like a banned particle/verb-ending ("としてください"). Callers use
 * this to admit an otherwise single-item query into the request-item
 * machinery (readCodeTaskPack.ts's `buildRequestItemReadiness` pre-gates),
 * since a query this short can still name an explicit literal worth proving
 * present/absent.
 */
export function queryHasQuotedLiteral(query: string): boolean {
  return QUOTED_LITERAL_ANYWHERE_RE.test(query);
}

interface ExtractedTerms {
  /** All terms, deduped, in discovery order. */
  all: string[];
  /** Terms that look like a file name (has a recognized extension). */
  files: string[];
  /** Terms that look like a code identifier (camelCase/PascalCase/CONST_CASE/snake_case/dotted-or-`::`-qualified/backticked). */
  identifiers: string[];
}

function extractTerms(segment: string): ExtractedTerms {
  const files = new Set<string>();
  const identifiers = new Set<string>();
  const all = new Set<string>();

  for (const m of segment.matchAll(QUOTED_RE)) all.add(m[1]!.trim());
  const fileSpans: Array<{ start: number; end: number }> = [];
  for (const m of segment.matchAll(FILE_EXT_RE)) {
    files.add(m[0]);
    all.add(m[0]);
    const start = m.index ?? 0;
    fileSpans.push({ start, end: start + m[0].length });
  }
  for (const m of segment.matchAll(DOTTED_KEY_RE)) {
    // A dotted "key.ext"-shaped match already counted as a FILE (package.json,
    // language.ts, ...) is not also a code identifier — the two patterns
    // overlap by construction, and a relation's `from` must not fill with the
    // file name it is itself supposed to be evidenced by.
    //
    // C2 fix (chip wave, 2026-09-14): on a HYPHENATED filename
    // ("src/new-config.ts"), the hyphen is a non-word character, so
    // DOTTED_KEY_RE's own \b-anchored start can land MID-FILENAME (right
    // after the "-") and re-match only the file term's SUFFIX
    // ("config.ts") as a byte-distinct string from the FILE_EXT_RE hit
    // ("new-config.ts") — the exact-string check above (`files.has(m[0])`)
    // never catches that, since the two matches are different strings at
    // different offsets. A file term already recognized must be consumed
    // WHOLE: any DOTTED_KEY_RE match whose span overlaps an already-
    // recognized file span is a fragment of that SAME mention, not a
    // separate identifier.
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (files.has(m[0]) || fileSpans.some((span) => start < span.end && end > span.start)) continue;
    identifiers.add(m[0]);
    all.add(m[0]);
  }
  for (const m of segment.matchAll(LOWER_CAMEL_RE)) { identifiers.add(m[0]); all.add(m[0]); }
  for (const m of segment.matchAll(UPPER_CAMEL_RE)) { identifiers.add(m[0]); all.add(m[0]); }
  for (const m of segment.matchAll(CONST_CASE_RE)) { identifiers.add(m[0]); all.add(m[0]); }
  // WP-C (eval-0929 §6): same "don't re-split an already-recognized file
  // term" guard as DOTTED_KEY_RE above — a snake_case FILE STEM
  // ("get_timeout" inside "get_timeout.py") is consumed whole by FILE_EXT_RE
  // already; only a span that does not overlap a recognized file is a
  // separate identifier.
  for (const m of segment.matchAll(SNAKE_CASE_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (files.has(m[0]) || fileSpans.some((span) => start < span.end && end > span.start)) continue;
    identifiers.add(m[0]);
    all.add(m[0]);
  }

  return { all: [...all], files: [...files], identifiers: [...identifiers] };
}

export function looksLikeFileTerm(term: string): boolean {
  return /\.[A-Za-z0-9]{1,6}$/u.test(term);
}

// ---------------------------------------------------------------------------
// WP-C2 (2026-09-29, eval-0929 §6/§8) — structural literal-absence
// eligibility. WP-C's own fix (GENERIC_SOFTWARE_ABSENCE_WORDS/
// GENERIC_JA_ABSENCE_WORDS above and in readCodeTaskPack.ts) suppressed the
// SPECIFIC descriptive words the first evaluation named by adding them to a
// hand-reviewed list; the orchestrator's blind held-out set then found the
// same failure mode on words the list never named — a verb ("give"), an
// adjective ("missing"), a whole unsegmented JA clause, and a multi-word
// disclosed term joining several ordinary words. A list can only ever catch
// what someone already thought to add to it; this predicate instead decides
// STRUCTURALLY, from the candidate's own shape and its clause's grammatical
// construction, so it holds for a word nobody has seen yet.
//
// A term may be certified `request-item-absent:<term>` (a verified "no
// occurrence in scanned workspace files" claim) only when it is:
//   (a) an explicitly QUOTED string in the item's own text — backtick,
//       double or single quote, or JA 「…」/『…』 (`quotedOccurrenceInText`);
//   (b) CODE-SHAPED — camelCase, PascalCase, snake_case, SCREAMING_SNAKE,
//       dotted/`::`/`#`-qualified, `$`/`@`-prefixed, or a file-path-shaped
//       token (`isCodeShapedTerm`), the same shapes `extractTerms`'s own
//       identifier regexes above already recognize;
//   (c) the term's own clause is an EXPLICIT existence/definition/use check
//       — "whether X is defined", "is there a X", "does X exist", "X is
//       used anywhere", 「Xが定義されているか/あるか/使われているか」、「Xという
//       名前」(`clauseAsksExistence`) — a CLOSED set of grammatical
//       constructions (the same status as `PREDICATE_AUXILIARY_RE`/
//       `LIGHT_VERB_WORDS` in readCodeTaskPack.ts), never a topic-vocabulary
//       list: this only widens what an explicit existence-check clause's
//       OWN residual wording may disclose, never any other clause's.
// Every other shape — an ordinary verb, adjective or common noun, or a whole
// unsegmented CJK run with no quote/existence marker — is never eligible,
// however "distinctive" the tiering heuristics upstream judge it to be:
// those heuristics decide WHICH word is the candidate; this decides whether
// a candidate may ever be the DISCLOSED term. A caller that also wants the
// hand-reviewed generic-vocabulary lists as an ADDITIONAL, narrower filter
// on the (b)/(c) branches (never on an explicit quote — Decision 6, TL142-
// 04: quoting is the strongest possible signal of caller intent and already
// overrides "merely descriptive" everywhere else in this pipeline) composes
// `isCodeShapedTerm`/`clauseAsksExistence`/`quotedOccurrenceInText`
// directly rather than calling `isLiteralEligibleTerm`, which never
// consults those lists at all (readCodeTaskPack.ts's
// `distinctiveSalientAbsence`/`proveUnbindableRequestItem`/
// `reconcileRequestItemsWithFacets` are exactly such callers).
//
// WP-C3 (2026-09-29, eval-0929 §6, orchestrator RULING — "subject absence is
// kept, descriptor absence is never certified"): the three categories above
// made literal absence impossible for EVERY non-code-shaped word, which also
// retired the deliberate 2026-09-08 "Tier C" behaviour (DESIGN-v0.15 R1 §4.2):
// a compound question whose one part asks about a concept the workspace does
// not contain must say so ("…, and how does the flux capacitor work?" → the
// flux capacitor is absent). The ruling keeps (a)-(c) and adds (d): in a
// clause that names NO code-shaped identifier and NO quoted string, the
// words of the clause's topic noun phrase(s) — its SUBJECT — are eligible
// too; its DESCRIPTORS never are: (1) the facet vocabulary (requestFacets.ts
// `isFacetDescriptorTerm`, the one shared source), (2) predicates — verbs,
// auxiliaries, participles, adjectives — decided by POSITION, never by a verb
// list (`topicNounPhraseWords`), and (3) every plain word of a clause that
// names a code-shaped identifier or a quoted string (that identifier/quote IS
// the clause's subject). A bare capitalized word ("Redis") is therefore no
// longer CODE-shaped (it is the ruling's "capitalised proper noun", eligible
// through (d)): counting it as an identifier would make every sentence-cased
// clause ("Default timeout value", "Walk me through…") identifier-bearing and
// so strip (d) from it. The JA-parity "Redis" disclosure that motivated the
// wider draft below is kept — through (d), from the SAME union fallback.
// ---------------------------------------------------------------------------
const CODE_SHAPE_LOWER_CAMEL_RE = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/u;
// WP-C2 first accepted a bare capitalized ASCII word ("Redis") here to keep
// requestItemCompletion.spec.ts's JA-parity "Redis" disclosure alive through
// `proveUnbindableRequestItem`'s union fallback. WP-C3: that disclosure now
// rides rule (d) (a capitalised proper noun in an identifier-free clause), so
// this is the real PascalCase shape again — at least one internal hump
// ("HttpClient", "OrderService"), the same shape `extractTerms`'s own
// UPPER_CAMEL_RE recognizes.
const CODE_SHAPE_UPPER_CAMEL_RE = /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/u;
const CODE_SHAPE_CONST_CASE_RE = /^[A-Z][A-Z0-9_]{2,}$/u;
const CODE_SHAPE_SNAKE_CASE_RE = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*$/u;
// WP-C3: the first segment needs two characters, so the prose abbreviations
// "e.g"/"i.e" (a DOTTED_KEY_RE hit inside "e.g.") never make a clause
// identifier-bearing.
const CODE_SHAPE_QUALIFIED_RE = /^[A-Za-z_][A-Za-z0-9_]+(?:(?:\.|::|#)[A-Za-z_][A-Za-z0-9_]*)+$/u;
const CODE_SHAPE_SIGIL_RE = /^[$@][A-Za-z_][\w.$-]*$/u;

/**
 * True when `term` — a single already-extracted token, never a whole clause
 * — has one of rule 1(b)'s code shapes. Anchored (`^…$`): `term` is a
 * candidate already isolated by its own extraction/tokenization, so this
 * asks whether the WHOLE token is code-shaped, never whether some
 * code-shaped substring merely sits inside a longer prose word.
 *
 * WP-C3: an ALL-CAPS word that is ordinary prose vocabulary ("HTTP", "API",
 * "JSON" — concernRecovery.ts's reviewed `isProseAcronym`) is not a name, the
 * same exclusion requestFacets.ts's `isCodeShapedWord` already applies.
 */
export function isCodeShapedTerm(term: string): boolean {
  return (
    CODE_SHAPE_LOWER_CAMEL_RE.test(term)
    || CODE_SHAPE_UPPER_CAMEL_RE.test(term)
    || (CODE_SHAPE_CONST_CASE_RE.test(term) && !isProseAcronym(term))
    || CODE_SHAPE_SNAKE_CASE_RE.test(term)
    || CODE_SHAPE_QUALIFIED_RE.test(term)
    || CODE_SHAPE_SIGIL_RE.test(term)
    || looksLikeFileTerm(term)
  );
}

/**
 * True when `term` occurs, case-insensitively, inside one of `text`'s own
 * explicitly quoted spans (`quotedSpans`'s five styles: backtick, double,
 * single, 「…」, 『…』). A quoted span `term` merely overlaps (rather than
 * exactly spans) still counts — the caller singled out that exact run of
 * text, and `term` is one of `salientWords`' own tokenizations of it.
 *
 * WP-C3: an ASCII quote pair counts only when it opens and closes at word
 * EDGES — two possessive apostrophes ("the validator's role and the parser's
 * output") are not a quotation of the words between them.
 */
export function quotedOccurrenceInText(term: string, text: string): boolean {
  const spans = quotedSpans(text).filter((span) => {
    const open = text[span.start];
    if (open === "「" || open === "『") return true;
    const before = span.start > 0 ? text[span.start - 1]! : " ";
    const after = span.end < text.length ? text[span.end]! : " ";
    return /[\s([{぀-ヿ一-鿿、。]/u.test(before) && /[\s)\]},.;:!?぀-ヿ一-鿿、。]/u.test(after);
  });
  if (spans.length === 0 || term.length === 0) return false;
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lowerText.indexOf(lowerTerm, from);
    if (at === -1) return false;
    const end = at + lowerTerm.length;
    if (spans.some((span) => at >= span.start && end <= span.end)) return true;
    from = at + 1;
  }
}

// WP-C2 (rule 1(c)) — the closed set of EN existence/definition/use
// CONSTRUCTIONS the brief names verbatim: "whether X is defined", "is there
// a X", "does X exist", "X is used anywhere". Matched against the WHOLE
// clause, never any one candidate word, so it says nothing about which word
// is distinctive — only whether the clause's OWN construction is an
// explicit existence check at all.
const EXISTENCE_CHECK_EN_RE =
  /\b(?:whether|if)\b[^.?!]{0,80}?\b(?:exists?|is\s+defined|are\s+defined|is\s+used|are\s+used)\b|\bdoes\b[^.?!]{0,80}?\bexist(?:s)?\b|\bis\s+there\s+(?:a|an|any)\b|\bexists?\s+anywhere\b|\bused\s+anywhere\b/iu;
// JA mirror: 「Xが定義されているか/あるか/使われているか」「Xという名前」.
const EXISTENCE_CHECK_JA_RE =
  /定義され(?:て)?(?:いる|います)?か|が(?:ある|あります)か|使われ(?:て)?(?:いる|います)?か|という名前/u;

/** True when `text` — one request item's own clause — is phrased as an explicit existence/definition/use check (rule 1(c)'s closed construction set, EN and JA). */
export function clauseAsksExistence(text: string): boolean {
  return EXISTENCE_CHECK_EN_RE.test(text) || EXISTENCE_CHECK_JA_RE.test(text);
}

// ---------------------------------------------------------------------------
// WP-C3 (2026-09-29, eval-0929 §6, orchestrator RULING rules 1(d)/2(b)/2(c))
// — the clause's SUBJECT, decided by grammatical POSITION.
//
// Closed grammatical classes only (the same status as STOPWORDS above or
// readCodeTaskPack.ts's PREDICATE_AUXILIARY_RE): determiners, wh-words,
// subordinators, auxiliaries, prepositions, conjunctions, pronouns and a
// handful of adverbs. No topic vocabulary and no verb list: a word is a
// PREDICATE because of where it sits (after an auxiliary or a subject
// pronoun, after a wh-noun, as the -s/-ed/bare word that follows the subject
// of a wh/subordinate clause, as a clause-initial request verb, or as an
// -ed/-ing modifier in front of the head noun), and a SUBJECT noun because of
// where IT sits (after a determiner or a possessive, before an auxiliary,
// between an inverted question auxiliary and the verb, as the object of a
// request verb or of "of/about/regarding/concerning", as a verbless list
// fragment, as a multi-word noun compound, or as a capitalised proper noun).
// A word the analysis cannot place in a noun phrase is simply NOT eligible —
// the undetermined disclosure the callers fall back to is the honest outcome
// for it, never a certified absence.
// ---------------------------------------------------------------------------
type NpTokenClass = "content" | "det" | "demo" | "wh-det" | "wh" | "sub" | "aux" | "prep" | "conj" | "pron" | "adv" | "num";

interface NpToken {
  readonly lower: string;
  cls: NpTokenClass;
  readonly possessive: boolean;
  readonly capitalized: boolean;
  /** The token as written (possessive/contraction stripped) — R2-T2 reads its code shape. */
  readonly raw: string;
}

const NP_DETERMINERS: ReadonlySet<string> = new Set([
  "the", "a", "an", "its", "their", "his", "her", "our", "your", "my",
  "each", "every", "any", "some", "all", "no", "both", "either", "neither", "another", "other",
  "such", "same", "many", "much", "few", "several", "multiple", "various", "certain",
]);
/**
 * Orchestrator addition (2026-09-29, eval-0929 §8, WP-C3 ruling rule 2(a)/
 * (b) extension) — a small, closed set of SCOPE/COMPLETENESS adjectives that
 * carry no domain content of their own when they pre-modify a facet
 * descriptor head noun ("direct callers", "indirect callers", "the possible
 * values", "the main condition") — the same closed-function-word status
 * "all"/"other" already have in NP_DETERMINERS above (a determiner is never
 * a content word regardless of what follows it), but gated POSITIONALLY
 * here instead: `addNounPhrase` below only excludes one of these words when
 * the SAME run's own head is a facet descriptor
 * (`requestFacets.ts` `isFacetDescriptorTerm`), never as a blanket
 * reclassification. A run whose head is an ordinary domain noun ("the
 * direct database connection") is entirely unaffected — "direct" stays a
 * normal, eligible content word there, exactly as WP-C3's own "the redis
 * cache invalidation IMPLEMENTATION" case requires "redis"/"invalidation" to
 * stay eligible despite sitting right before the descriptor head
 * "implementation". Blind-set leak this closes: a bullet "- direct callers"
 * (under "…enqueue_message. Who calls it?") certified
 * `request-item-absent:direct` — "direct" is a pre-modifier of the
 * descriptor "callers", never a subject of its own.
 */
const NP_DESCRIPTOR_SCOPE_ADJECTIVES_EN: ReadonlySet<string> = new Set([
  "direct", "indirect", "possible", "main", "primary", "secondary",
]);
const NP_DEMONSTRATIVES: ReadonlySet<string> = new Set(["this", "that", "these", "those"]);
const NP_WH_DETERMINERS: ReadonlySet<string> = new Set(["which", "what", "whose"]);
const NP_WH_ADVERBS: ReadonlySet<string> = new Set(["how", "when", "where", "why", "who", "whom"]);
const NP_SUBORDINATORS: ReadonlySet<string> = new Set([
  "whether", "if", "because", "unless", "until", "while", "once", "whenever", "wherever", "although", "though", "whereas",
]);
const NP_AUXILIARIES: ReadonlySet<string> = new Set([
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "has", "have", "had",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must", "cannot",
  "get", "gets", "got",
]);
/** Auxiliaries whose inverted question takes a BARE main verb after the subject ("how does X work"). */
const NP_DO_OR_MODAL: ReadonlySet<string> = new Set([
  "do", "does", "did", "will", "would", "can", "could", "should", "shall", "may", "might", "must", "cannot",
]);
const NP_PREPOSITIONS: ReadonlySet<string> = new Set([
  "of", "in", "on", "at", "by", "for", "from", "to", "with", "without", "into", "onto", "about",
  "over", "under", "through", "during", "between", "across", "per", "via", "within", "upon",
  "against", "among", "around", "behind", "beyond", "inside", "outside", "toward", "towards",
  "throughout", "than", "as", "like", "after", "before", "since", "regarding", "concerning",
  "including", "except", "beside", "besides", "near", "along", "unlike", "despite",
]);
/** A preposition whose object IS the topic ("the callers OF X", "tell me ABOUT X"). */
const NP_TOPIC_PREPOSITIONS: ReadonlySet<string> = new Set(["of", "about", "regarding", "concerning"]);
/**
 * R2-T2 follow-up: the preposition of a phrasal request verb — "walk me
 * THROUGH …", "look INTO …", "look AT …" — whose object is the request's own
 * topic (the verb's complement), unlike a locative/temporal adjunct.
 */
const NP_COMPLEMENT_PREPOSITIONS: ReadonlySet<string> = new Set(["through", "into", "over", "at", "on", "for", "with"]);
/** R2-T2 follow-up: request verbs that take their topic only through such a preposition ("go over …", "dig into …"). */
const NP_PHRASAL_REQUEST_VERBS: ReadonlySet<string> = new Set([
  "go", "dig", "dive", "drill", "step", "run", "read", "talk", "focus", "elaborate", "expand", "report", "zoom",
]);
/** R2-T2 follow-up: a relative pronoun right after a noun opens a relative clause ("the handler which retries"). */
const NP_RELATIVE_PRONOUNS: ReadonlySet<string> = new Set(["which", "who", "whom", "whose"]);
/** R2-T2 follow-up: determiners that point back at something already named ("that period", "the same window"). */
const NP_ANAPHORIC_DETERMINERS: ReadonlySet<string> = new Set(["this", "that", "these", "those", "same", "such"]);
const NP_CONJUNCTIONS: ReadonlySet<string> = new Set(["and", "or", "but", "nor", "plus", "then", "also", "so", "yet", "vs", "versus", "please"]);
const NP_PRONOUNS: ReadonlySet<string> = new Set([
  "it", "they", "them", "he", "she", "we", "you", "i", "me", "us", "him",
  "itself", "themselves", "yourself", "ourselves", "one", "ones",
  "something", "anything", "everything", "nothing", "someone", "anyone", "everyone",
]);
const NP_ADVERBS: ReadonlySet<string> = new Set([
  "not", "never", "ever", "always", "only", "just", "still", "already", "even", "often",
  "too", "very", "again", "anywhere", "somewhere", "everywhere", "nowhere", "instead",
  "otherwise", "now", "later", "else", "further", "more", "most", "less", "least", "well",
  "back", "away", "together", "first", "next", "up", "down", "out", "off", "there", "here",
  "e.g", "i.e", "etc",
]);
const NP_NUMBER_WORDS: ReadonlySet<string> = new Set([
  "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twice", "half",
]);
/** Common -ly words that are nouns/verbs, not adverbs. */
const NP_LY_NON_ADVERBS: ReadonlySet<string> = new Set(["supply", "assembly", "apply", "reply", "comply", "imply", "multiply", "rely", "ally", "family", "anomaly", "monopoly"]);
/** Irregular past participles (the regular ones are recognized by their -ed ending). */
const NP_IRREGULAR_PARTICIPLES: ReadonlySet<string> = new Set([
  "broken", "taken", "given", "written", "chosen", "hidden", "driven", "shown", "known", "done", "made",
  "sent", "built", "kept", "held", "found", "thrown", "drawn", "seen", "gone", "spent", "lost", "left",
  "paid", "bound", "sold", "told", "brought", "bought", "caught", "thought", "fed", "led", "met",
  "stuck", "won", "worn", "frozen", "stolen", "spoken", "fallen", "shaken", "proven", "begun",
  // R2-T2 follow-up: more irregular participles a predicate takes ("which
  // are rethrown", "when is it overridden") — see `isParticipleShaped`.
  "ridden", "grown", "blown", "flown", "torn", "sworn", "hung", "swung", "dug", "bent", "lent", "dealt",
  "meant", "heard", "laid", "struck", "forgotten", "gotten", "risen", "arisen", "withdrawn", "shrunk",
  "sunk", "spun", "woken", "beaten", "bitten", "eaten", "sought", "taught", "fought",
]);
/** R2-T2 follow-up: verb prefixes an irregular participle keeps ("RE-thrown", "OVER-ridden", "UN-done"). */
const NP_PARTICIPLE_PREFIX_RE = /^(?:re|un|over|under|mis|out|pre|up|with)(?=[a-z]{4,}$)/u;

// ---------------------------------------------------------------------------
// R2-T2 (2026-09-30, review-0929 P1-2 → P0, orchestrator RULING extending
// brief-wp-c3.md rule 2(b)) — ADJECTIVES are descriptors, never the subject.
//
// Measured leak: in an identifier-free topic clause every pre-head word of a
// noun phrase except an -ed/-ing participle was a subject word, so an
// ordinary adjective was certified `request-item-absent` — "…, and why
// intermittent failures are retried." → `absent:intermittent`, "I'm
// debugging slow requests. …" → `absent:slow`. The ruling: in such a clause
// only the noun phrase's NOUNS (its head, and the nouns of a noun compound —
// "the audit trail", "the rate limiter", "the circuit breaker") are
// absence-eligible; adjectives, adverbs, participles and determiners are
// descriptors, the same status WP-C4's scope adjectives before a descriptor
// head already had (`NP_DESCRIPTOR_SCOPE_ADJECTIVES_EN`, now one member of
// the general rule below instead of a head-gated special case).
//
// Attributive position cannot tell an adjective from a noun modifier by
// itself ("rate limiter" vs "slow requests"), so the word's own shape
// decides, from two CLOSED resources of general English (no domain or
// codebase vocabulary — the same status as `NP_IRREGULAR_PARTICIPLES`/
// `NP_ADVERBS` above):
//   (1) the adjective-forming derivational suffixes (-ous, -ful, -less, -ive,
//       -able/-ible, -ical, -ional, -ernal, -ual, -ent, -ic), each with a
//       minimum stem so the short nouns that merely end the same way stay
//       nouns ("drive", "table", "client", "agent", "event", "logic",
//       "topic", "metric"), and the noun-only endings excluded (-ment,
//       "traffic"'s -ffic, "graphic"'s -phic). -ant is NOT one of them: it
//       names as many code nouns as adjectives ("constant", "variant",
//       "invariant", "tenant"), so its common adjectives are listed instead;
//   (2) the small class of BASIC adjectives with no such suffix (size, speed,
//       age, frequency, quality, validity, locality, colour, and their
//       comparative/superlative forms) plus un-/in-/im-/non- negations of an
//       adjective.
// Only a PRE-HEAD word is ever judged: the head noun of a noun phrase is
// eligible by position whatever its shape ("the cache constant value" →
// "constant", head once the descriptor "value" is removed). A noun the
// suffix rule misreads as an adjective ("the component tree") only loses its
// OWN absence eligibility as a modifier — the safe direction: the point is
// then disclosed undetermined or through its head, never certified absent
// through a word that may be a descriptor.
// ---------------------------------------------------------------------------
const NP_BASIC_ADJECTIVES_EN: ReadonlySet<string> = new Set([
  // size / extent / quantity
  "big", "small", "large", "huge", "tiny", "little", "long", "short", "tall", "wide", "narrow", "deep", "shallow",
  "high", "low", "full", "empty", "heavy", "light", "thick", "thin", "vast", "extra", "whole", "entire", "partial",
  "overall", "dense", "sparse", "compact", "flat", "nested", "bulky", "lengthy",
  // speed / time / frequency / order
  "slow", "fast", "quick", "rapid", "early", "late", "old", "new", "recent", "young", "stale", "fresh", "next", "last",
  "prior", "past", "future", "final", "initial", "rare", "occasional", "regular", "irregular", "steady", "urgent",
  "temporary", "immediate", "eventual", "latent", "sequential", "concurrent", "parallel", "async", "sync",
  // quality / state / validity
  "good", "bad", "poor", "great", "fine", "nice", "ugly", "clean", "dirty", "valid", "wrong", "right", "correct",
  "proper", "true", "false", "real", "fake", "raw", "live", "dead", "idle", "busy", "free", "open", "safe", "secure",
  "strict", "loose", "tight", "hard", "soft", "easy", "simple", "complex", "weird", "odd", "strange", "random",
  "common", "normal", "usual", "special", "general", "particular", "similar", "unique", "duplicate", "spare",
  "noisy", "quiet", "silent", "loud", "flaky", "stable", "shaky", "robust", "fragile", "brittle", "healthy", "sick",
  "hot", "cold", "warm", "cool", "dark", "bright", "sluggish", "laggy", "leaky", "sticky", "lazy", "eager", "greedy",
  "ready", "alive", "awake", "aware", "able", "equal", "dual", "bursty", "spiky", "chatty", "sloppy", "messy",
  "tricky", "risky", "buggy", "hacky", "janky", "wonky", "glitchy", "fuzzy", "verbose", "terse", "concise", "naive",
  "smart", "dumb", "silly", "crazy", "wild", "blank", "bare", "plain", "corrupt", "complete", "incomplete",
  "obsolete", "absent", "missing", "severe", "extreme", "fatal", "minor", "major", "cheap", "costly", "own",
  "separate", "single", "double", "triple", "total", "absolute", "exact", "precise", "average", "readonly",
  // locality / visibility / role
  "local", "remote", "global", "public", "private", "basic", "custom", "legacy", "foreign", "native", "mandatory",
  "static", "atomic", "cyclic", "toxic", "exotic", "redundant", "relevant", "irrelevant", "important",
  "significant", "compliant", "dominant", "instant", "distant", "elegant", "abundant", "vacant", "stagnant",
  "main", "primary", "secondary", "direct", "indirect", "possible", "inner", "outer", "upper", "lower", "top",
  "bottom", "left", "front", "back", "middle",
  // comparative / superlative forms of the above
  "better", "worse", "best", "worst", "latest", "earliest", "newest", "oldest", "higher", "larger", "smaller",
  "faster", "slower", "longer", "shorter", "bigger", "greater", "lesser",
  // colours
  "black", "white", "red", "green", "blue", "yellow", "gray", "grey",
]);
// Minimum stems keep the short nouns that share an ending out: drive/olive
// (-ive needs 3), table/cable (-able needs 2), client/agent/event/parent/
// extent/intent (-ent needs 4), logic/topic/music/metric/fabric (-ic needs 5;
// the short adjectives static/atomic/basic/public are listed), usual/equal/
// dual (-ual needs 3; the list carries them).
const NP_ADJECTIVE_SUFFIX_RE = /^(?:[a-z]{3,}(?:ous|ful|less)|[a-z]{3,}ive|[a-z]{2,}(?:able|ible|ical|ional)|[a-z]*ernal|[a-z]{3,}ual|[a-z]{4,}ent|[a-z]{5,}ic)$/u;
/** Noun-only endings the suffix classes above would otherwise capture. */
const NP_NOUN_ONLY_ENDING_RE = /(?:ment|ffic|phic)$/u;
const NP_NEGATING_PREFIX_RE = /^(?:un|in|im|non-?)(?=[a-z]{3,}$)/u;

/**
 * R2-T2 — true when `lower` (one lowercased token) has the shape of an
 * ADJECTIVE: an adjective-forming suffix, a basic adjective, a negated
 * adjective, a participle, or a hyphenated compound modifier any of whose
 * parts is one ("long-running", "thread-safe", "read-only", "real-time").
 * Asked only about a word in front of a noun phrase's head (see the section
 * comment above).
 */
function isAdjectiveShaped(lower: string): boolean {
  if (lower.includes("-")) {
    return lower.split("-").some((part) => part.length > 0
      && (isAdjectiveShaped(part) || NP_ADVERBS.has(part) || isParticipleShaped(part)));
  }
  if (!/^[a-z]+$/u.test(lower)) return false;
  if (NP_BASIC_ADJECTIVES_EN.has(lower)) return true;
  if (NP_ADJECTIVE_SUFFIX_RE.test(lower) && !NP_NOUN_ONLY_ENDING_RE.test(lower)) return true;
  const negated = lower.replace(NP_NEGATING_PREFIX_RE, "");
  return negated !== lower && (NP_BASIC_ADJECTIVES_EN.has(negated) || isParticipleShaped(negated)
    || (NP_ADJECTIVE_SUFFIX_RE.test(negated) && !NP_NOUN_ONLY_ENDING_RE.test(negated)));
}

let topicLeadVerbsEn: ReadonlySet<string> | undefined;
/**
 * The request verbs a clause LEADS with ("Explain …", "update the changelog",
 * "Walk me through …") — the read-lead vocabulary this file already reviews
 * (`READ_VERB_LEAD_EN_RE`, `COLON_INTRODUCES_READ_LEAD`) plus the shared
 * `MUTATION_VERBS_EN`. Built on first use: `MUTATION_VERBS_EN` is declared
 * further down this file (same temporal-dead-zone reason as
 * `genericJaRequestVerbs` above).
 */
function topicLeadVerbs(): ReadonlySet<string> {
  topicLeadVerbsEn ??= new Set([
    "explain", "describe", "tell", "show", "clarify", "summarize", "summarise", "walk", "trace",
    "outline", "document", "give", "list", "find", "check", "compare", "identify", "determine",
    "locate", "review", "analyze", "analyse", "verify", "confirm", "cover", "account", "discuss",
    "enumerate", "look", "investigate", "inspect", "examine", "provide", "detail", "mention", "name",
    // Copilot standard-setup evaluation (2026-10-02): the elliptical request
    // "Need discount ordering, gift card behavior, ..." ("[I] need ...")
    // leads with "need" exactly like "List ..."; read as a noun it was
    // certified `request-item-absent:Need`.
    "need",
    // Copilot retest r4 (2026-10-02): the verbs of a citation clause ("cite
    // file names", "quote the source lines", "read the relevant files",
    // "include line numbers", "point to exact locations") lead the clause
    // like "show"/"list"; read as a noun, "cite" was certified
    // `request-item-absent:cite`.
    "cite", "quote", "read", "include", "point",
    ...MUTATION_VERBS_EN.split("|"),
  ]);
  return topicLeadVerbsEn;
}

function npTokenClass(lower: string): NpTokenClass {
  if (/^\d/u.test(lower) || NP_NUMBER_WORDS.has(lower)) return "num";
  if (NP_DETERMINERS.has(lower)) return "det";
  if (NP_DEMONSTRATIVES.has(lower)) return "demo";
  if (NP_WH_DETERMINERS.has(lower)) return "wh-det";
  if (NP_WH_ADVERBS.has(lower)) return "wh";
  if (NP_SUBORDINATORS.has(lower)) return "sub";
  if (NP_AUXILIARIES.has(lower) || /n['’]t$/u.test(lower)) return "aux";
  if (NP_PREPOSITIONS.has(lower)) return "prep";
  if (NP_CONJUNCTIONS.has(lower)) return "conj";
  if (NP_PRONOUNS.has(lower)) return "pron";
  if (NP_ADVERBS.has(lower)) return "adv";
  if (lower.length >= 5 && /[^aeiou]ly$/u.test(lower) && !NP_LY_NON_ADVERBS.has(lower)) return "adv";
  return "content";
}

const NP_TOKEN_RE = /[A-Za-z0-9_$@][A-Za-z0-9_$@.:#/'’-]*/gu;

function npTokens(segment: string): NpToken[] {
  const out: NpToken[] = [];
  for (const m of segment.matchAll(NP_TOKEN_RE)) {
    // Trailing . : # / - stripped by a backward scan: the equivalent regex
    // (/[.:#/-]+$/) is quadratic on a token with a long inner run of dots, and
    // the question readers below tokenize whole sentences (review, 2026-10-02).
    let end = m[0].length;
    while (end > 0 && ".:#/-".includes(m[0][end - 1]!)) end -= 1;
    let raw = m[0].slice(0, end);
    let possessive = false;
    if (/['’]s$/iu.test(raw)) {
      raw = raw.slice(0, -2);
      possessive = true;
    } else if (/s['’]$/u.test(raw)) {
      raw = raw.slice(0, -1);
      possessive = true;
    } else if (/^[A-Za-z]+['’](?:m|re|ve|ll|d)$/iu.test(raw)) {
      // R2-T2: a contracted pronoun + auxiliary ("I'm", "we're", "they've")
      // is its pronoun — a subject, never a content word of a noun phrase.
      raw = raw.replace(/['’](?:m|re|ve|ll|d)$/iu, "");
    }
    if (raw.length === 0) continue;
    const lower = raw.toLowerCase();
    out.push({ lower, cls: npTokenClass(lower), possessive, capitalized: /^[A-Z]/u.test(raw), raw });
  }
  // A demonstrative is a determiner in front of a noun ("this module") and a
  // pronoun otherwise ("how this works"); "that" after a noun opens a
  // relative clause ("the handler that retries").
  out.forEach((token, i) => {
    if (token.cls !== "demo") return;
    const prev = out[i - 1];
    const next = out[i + 1];
    if (token.lower === "that" && prev?.cls === "content") token.cls = "sub";
    else token.cls = next?.cls === "content" ? "det" : "pron";
  });
  return out;
}

function isParticipleShaped(lower: string): boolean {
  return (lower.length >= 5 && /[^e]ed$/u.test(lower))
    || (lower.length >= 6 && /ing$/u.test(lower))
    || NP_IRREGULAR_PARTICIPLES.has(lower)
    || NP_IRREGULAR_PARTICIPLES.has(lower.replace(NP_PARTICIPLE_PREFIX_RE, ""));
}

/** A 3rd-person -s / past -ed form — the shape a finite verb takes after its subject. */
function isFiniteVerbShaped(lower: string): boolean {
  return /(?:[^su]s|es|ed)$/u.test(lower);
}

const NP_SEGMENT_SPLIT_RE = /[,;:.?!()[\]{}\n、。，！？；：]+|\s[-–—]+\s/u;

/**
 * Copilot retest r3 (2026-10-02, rule (c)) — the collector `topicHeadModifiers`
 * fills while `enSegmentTopicWords` walks a clause. `heads` maps a topic word to
 * the modifier words (lowercase) of every noun phrase in which it is the phrase's
 * LAST word and has at least one noun modifier in front of it; `other` holds every
 * topic word that also sits anywhere ELSE (a bare noun, a modifier, a capitalised
 * noun) — such a word is a subject in its own right and is never a suppressible head.
 */
interface HeadCollector {
  readonly heads: Map<string, Set<string>>;
  readonly other: Set<string>;
}

/** An -ed or irregular past participle (`isParticipleShaped` minus the -ing form, which is as often a gerund noun: "shipping", "pricing"). */
function isPastParticipleShaped(lower: string): boolean {
  return (lower.length >= 5 && /[^e]ed$/u.test(lower))
    || NP_IRREGULAR_PARTICIPLES.has(lower)
    || NP_IRREGULAR_PARTICIPLES.has(lower.replace(NP_PARTICIPLE_PREFIX_RE, ""));
}

/**
 * The words of `modifiers` (a noun phrase's tokens in front of its head) that
 * name a THING: nouns and gerunds, with a slash/hyphen compound ("points/free-
 * shipping") split into its parts. An adjective ("free", "relevant"), an -ed
 * participle ("expired") or a function word names no thing the head could be
 * ABOUT, so it is never one.
 */
function headModifierWords(modifiers: readonly NpToken[]): string[] {
  const out = new Set<string>();
  for (const token of modifiers) {
    for (const part of token.lower.split(/[/-]+/u)) {
      if (!/^[a-z]{3,}$/u.test(part) || npTokenClass(part) !== "content") continue;
      if (isAdjectiveShaped(part) || isPastParticipleShaped(part)) continue;
      out.add(part);
    }
  }
  return [...out];
}

function noteTopicWord(collector: HeadCollector, run: readonly NpToken[], headAt: number, index: number): void {
  const word = run[index]!.lower;
  // The phrase's HEAD is its LAST word. A phrase that ENDS in a facet descriptor
  // ("the cache entryway PATH") has the descriptor as its head, so the noun in
  // front of it is the subject of that descriptor, not a head of its own.
  if (index === headAt && headAt === run.length - 1 && headAt > 0) {
    const modifiers = headModifierWords(run.slice(0, headAt));
    if (modifiers.length > 0) {
      const known = collector.heads.get(word) ?? new Set<string>();
      for (const modifier of modifiers) known.add(modifier);
      collector.heads.set(word, known);
      return;
    }
  }
  collector.other.add(word);
}

/** Every word of `segment` (one clause piece) that sits in a topic noun phrase, lowercased — EN positional rules. */
function enSegmentTopicWords(segment: string, out: Set<string>, heads?: HeadCollector): void {
  const tokens = npTokens(segment);
  if (tokens.length === 0) return;
  let start = 0;
  while (start < tokens.length && (tokens[start]!.cls === "conj" || tokens[start]!.cls === "adv")) start += 1;
  // A clause-initial request verb, unless it heads an "X of Y" noun ("List of …").
  const leadVerbAt = start < tokens.length
    && tokens[start]!.cls === "content"
    && topicLeadVerbs().has(tokens[start]!.lower)
    && tokens[start + 1]?.lower !== "of"
    ? start
    : -1;
  const hasClauseSignal = tokens.some((token) => token.cls === "aux" || token.cls === "wh" || token.cls === "wh-det" || token.cls === "sub");
  const prevIndex = (from: number, skip: ReadonlySet<NpTokenClass>): number => {
    let p = from;
    while (p >= 0 && skip.has(tokens[p]!.cls)) p -= 1;
    return p;
  };
  const SKIP_ADV: ReadonlySet<NpTokenClass> = new Set(["adv"]);
  const SKIP_ADV_DET: ReadonlySet<NpTokenClass> = new Set(["adv", "det", "num"]);
  /** The last wh/wh-det/subordinator strictly before `index`, or -1. */
  const clauseOpenerBefore = (index: number): number => {
    for (let p = index - 1; p >= start; p -= 1) {
      const cls = tokens[p]!.cls;
      if (cls === "wh" || cls === "wh-det" || cls === "sub") return p;
    }
    return -1;
  };
  const addNounPhrase = (run: readonly NpToken[]): void => {
    // Orchestrator addition (eval-0929 §8): the run's own HEAD (last token)
    // decides whether a pre-modifying scope adjective is part of the
    // descriptor — see NP_DESCRIPTOR_SCOPE_ADJECTIVES_EN's own doc comment.
    const headIsDescriptor = run.length > 1 && isFacetDescriptorTerm(run[run.length - 1]!.lower);
    // R2-T2 (review-0929 P1-2): the HEAD noun is the last word that is not a
    // trailing facet descriptor (rule 1(d) "after removing descriptors": in
    // "the cache constant value" the head is "constant"); every word in front
    // of it is a modifier, kept only when it is a NOUN of a noun compound —
    // an adjective is a descriptor (see `isAdjectiveShaped`'s section).
    let headAt = run.length - 1;
    while (headAt > 0 && isFacetDescriptorTerm(run[headAt]!.lower)) headAt -= 1;
    // An adjective or participle right in front of the trailing descriptor
    // modifies THAT descriptor ("direct callers", "transient errors", "the
    // allowed values"): the phrase names only a kind of information, and has
    // no subject head of its own.
    if (headAt < run.length - 1 && (isAdjectiveShaped(run[headAt]!.lower) || isParticipleShaped(run[headAt]!.lower))) {
      headAt = run.length;
    }
    run.forEach((token, i) => {
      const isHead = i >= headAt;
      // An -ed/-ing word in front of the head noun is an adjective
      // ("the missing token", "expired entries") — a predicate, never the subject.
      if (!isHead && isParticipleShaped(token.lower)) return;
      if (!isHead && headIsDescriptor && NP_DESCRIPTOR_SCOPE_ADJECTIVES_EN.has(token.lower)) return;
      if (!isHead && isAdjectiveShaped(token.lower)) return;
      out.add(token.lower);
      if (heads !== undefined) noteTopicWord(heads, run, headAt, i);
    });
  };
  const addIfCompound = (run: readonly NpToken[]): void => {
    // R2-T2: an adjective + noun object ("handles flaky upstreams") is not a
    // multi-word NOUN compound — only nouns count toward the two.
    const nouns = run.filter((token) => !isParticipleShaped(token.lower) && !isAdjectiveShaped(token.lower));
    if (nouns.length >= 2) addNounPhrase(nouns);
  };
  const addCapitalized = (run: readonly NpToken[], firstIndex: number, predicateIndexes: ReadonlySet<number>): void => {
    run.forEach((token, i) => {
      if (token.capitalized && firstIndex + i !== start && !predicateIndexes.has(i)) {
        out.add(token.lower);
        heads?.other.add(token.lower);
      }
    });
  };

  // R2-T2 follow-up (2026-09-30, orchestrator ruling on the round-2 combined
  // run): subject eligibility — the head noun and the nouns of a compound —
  // applies ONLY to the topic noun phrase of an identifier-free clause that
  // no facet owns (brief-wp-c3.md rule 1(d)); never to a word inside a
  // modifier phrase, an anaphoric reference, a facet-framed clause's other
  // participants, or a predicate. Decided structurally, per segment:
  //   - a RELATIVE clause ("callers THAT go through a retry scheduler", "the
  //     handler WHICH retries …") modifies the noun before it — to the next
  //     coordinator, nothing inside it is the clause's topic;
  //   - an ANAPHORIC noun phrase ("that period", "this module", "the same
  //     window") refers back to something already named — never a new subject;
  //   - a FACET-FRAMED clause OPENS with a noun phrase made only of facet
  //     descriptors and modifiers ("which conditions …", "callers passing …",
  //     "what error codes …", "List the callers …") and asks for that kind of
  //     information about a subject the facet owns; its other noun phrases are
  //     participants ("is a customer refused a refund"), and only the object
  //     of a topic preposition ("the conditions OF the vault"), the
  //     descriptor's own "for" complement ("the default values FOR the rate
  //     limiter") or a possessive owner ("the retry constant's configured
  //     value") names that subject. A descriptor noun phrase anywhere later —
  //     an adjunct or an object ("why does the circuit breaker open after
  //     repeated errors") — frames nothing.
  // The preposition right after the clause's request verb (and its "me"/"us")
  // is the verb's COMPLEMENT: "walk me through the rate limiter", "look into
  // the circuit breaker" name the request's topic, not a modifier phrase. An
  // imperative outside the lead-verb list shows itself by that "me"/"us"
  // ("take me through the audit trail") or is a phrasal request verb ("go
  // over the retry policy"). Such a complement keeps what every prepositional
  // object had before this follow-up: the nouns of a multi-word compound.
  const isMeOrUs = (token: NpToken | undefined): boolean => token?.lower === "me" || token?.lower === "us";
  const imperativeAt = leadVerbAt >= 0
    ? leadVerbAt
    : tokens[start]?.cls === "content" && (isMeOrUs(tokens[start + 1]) || NP_PHRASAL_REQUEST_VERBS.has(tokens[start]!.lower))
      ? start
      : -1;
  const complementPrepAt = ((): number => {
    // "What happens TO the audit trail", "who writes TO the audit log": a
    // wh-subject's own verb takes the question's topic through its preposition.
    if (imperativeAt < 0 && (tokens[start]?.lower === "what" || tokens[start]?.lower === "who")
      && tokens[start + 1]?.cls === "content" && isFiniteVerbShaped(tokens[start + 1]!.lower)
      && tokens[start + 2]?.cls === "prep" && !NP_TOPIC_PREPOSITIONS.has(tokens[start + 2]!.lower)) {
      return start + 2;
    }
    if (imperativeAt < 0) return -1;
    let p = imperativeAt + 1;
    if (isMeOrUs(tokens[p])) p += 1;
    while (p < tokens.length && tokens[p]!.cls === "adv") p += 1;
    return p < tokens.length && tokens[p]!.cls === "prep" && NP_COMPLEMENT_PREPOSITIONS.has(tokens[p]!.lower) ? p : -1;
  })();
  const facetOnly = (run: readonly NpToken[]): boolean => run.some((token) => isFacetDescriptorTerm(token.lower))
    && run.every((token) => isFacetDescriptorTerm(token.lower) || isAdjectiveShaped(token.lower) || isParticipleShaped(token.lower));
  const facetFramed = ((): boolean => {
    let i = start;
    while (i < tokens.length && (tokens[i]!.cls !== "content" || i === imperativeAt)) i += 1;
    if (i >= tokens.length) return false;
    let j = i;
    while (j + 1 < tokens.length && tokens[j + 1]!.cls === "content" && !tokens[j]!.possessive && j + 1 !== leadVerbAt) j += 1;
    let kind = tokens.slice(i, j + 1);
    // "which conditions trigger …": after a wh-determiner the run's last word
    // is the clause's verb (the same reading as the wh-det branch below).
    const opener = prevIndex(i - 1, SKIP_ADV);
    let next = j + 1;
    while (next < tokens.length && tokens[next]!.cls === "adv") next += 1;
    if (opener >= 0 && tokens[opener]!.cls === "wh-det" && kind.length >= 2 && next < tokens.length && tokens[next]!.cls !== "aux") {
      kind = kind.slice(0, -1);
    }
    return facetOnly(kind);
  })();
  const relativeAt = tokens.findIndex((token, i) => i > start && i - 1 !== leadVerbAt && tokens[i - 1]!.cls === "content"
    && ((token.cls === "sub" && token.lower === "that") || NP_RELATIVE_PRONOUNS.has(token.lower)));
  const relativeEnd = relativeAt < 0 ? -1 : (() => {
    for (let i = relativeAt + 1; i < tokens.length; i += 1) if (tokens[i]!.cls === "conj") return i;
    return tokens.length;
  })();

  let k = start;
  while (k < tokens.length) {
    if (tokens[k]!.cls !== "content" || k === leadVerbAt) {
      k += 1;
      continue;
    }
    const s = k;
    let e = k;
    while (e + 1 < tokens.length && tokens[e + 1]!.cls === "content" && !tokens[e]!.possessive && e + 1 !== leadVerbAt) e += 1;
    k = e + 1;
    const run = tokens.slice(s, e + 1);
    const before = prevIndex(s - 1, SKIP_ADV);
    const beforeCore = prevIndex(s - 1, SKIP_ADV_DET);
    const detLed = before >= 0 && (tokens[before]!.cls === "det" || tokens[before]!.cls === "num"
      || (tokens[before]!.cls === "content" && tokens[before]!.possessive));
    const after = (() => {
      let n = e + 1;
      while (n < tokens.length && tokens[n]!.cls === "adv") n += 1;
      return n < tokens.length ? tokens[n]! : undefined;
    })();
    const core = beforeCore >= 0 ? tokens[beforeCore]! : undefined;
    // "including" introduces a requested point ("…, including the queue depth
    // value"), not a locative adjunct: like a complement, its object keeps the
    // prepositional object's pre-existing (compound) eligibility.
    const atComplement = beforeCore >= 0 && (beforeCore === complementPrepAt || tokens[beforeCore]!.lower === "including");
    const predicates = new Set<number>();

    // R2-T2 follow-up guards (see the comment above the loop).
    if (relativeAt >= 0 && s > relativeAt && s < relativeEnd) continue;
    // A lone adjective right after "how" is the question's degree word ("how
    // LONG is that window", "how BIG is the buffer") — a predicate.
    if (run.length === 1 && before >= 0 && before === s - 1 && tokens[before]!.lower === "how" && isAdjectiveShaped(run[0]!.lower)) continue;
    if (before >= 0 && tokens[before]!.cls === "det" && NP_ANAPHORIC_DETERMINERS.has(tokens[before]!.lower)) continue;
    // …and a noun phrase whose own of-complement is anaphoric ("the default
    // length OF THAT period") names an attribute of that referent, not a new
    // subject either.
    if (tokens[e + 1]?.lower === "of" && tokens[e + 2]?.cls === "det" && NP_ANAPHORIC_DETERMINERS.has(tokens[e + 2]!.lower)) continue;
    // A possessive owner ("the retry constant's configured value") is the
    // facet's subject, exactly like an of-complement — and so is the definite
    // object of "for" right after a descriptor ("the default values FOR the
    // rate limiter").
    const descriptorComplement = core?.lower === "for" && beforeCore > 0
      && isFacetDescriptorTerm(tokens[beforeCore - 1]!.lower)
      && before >= 0 && tokens[before]!.lower === "the";
    if (facetFramed && !facetOnly(run) && !(core?.cls === "prep" && NP_TOPIC_PREPOSITIONS.has(core.lower))
      && !atComplement && !descriptorComplement && !run[run.length - 1]!.possessive) continue;

    if (core?.cls === "aux") {
      const opener = clauseOpenerBefore(beforeCore);
      const contentBetween = tokens.slice(opener + 1 < start ? start : opener + 1, beforeCore).filter((token) => token.cls === "content");
      // R2-T2 follow-up: a wh-determiner noun phrase in front of a be/have/get
      // auxiliary IS the subject ("which error codes ARE recorded", "which
      // files HAVE changed") — what follows the auxiliary is its predicate or
      // complement, never an inverted subject. Only do-support/modal questions
      // put the subject after the auxiliary ("which file DOES the parser read").
      // A wh-phrase that is a preposition's object ("IN what cases is an
      // invoice voided", "UNDER which conditions …") is no subject: the
      // subject follows the auxiliary there.
      const whSubjectBeforeBe = opener >= 0 && tokens[opener]!.cls === "wh-det" && contentBetween.length > 0
        && !NP_DO_OR_MODAL.has(core.lower) && !(opener > start && tokens[opener - 1]!.cls === "prep");
      const inverted = !whSubjectBeforeBe && (contentBetween.length === 0
        || (opener >= 0 && tokens[opener]!.cls === "wh-det" && contentBetween.length === tokens.slice(opener + 1, beforeCore).length));
      if (inverted) {
        // Question word order: subject, then (for do/modal, or a participle
        // after be/have) the main verb.
        if (run.length === 1 && after?.cls !== "aux" && !NP_DO_OR_MODAL.has(core.lower) && isParticipleShaped(run[0]!.lower)) {
          // R2-T2 follow-up: "what is recorded", "is it retried": a lone
          // participle after be/get is the predicate, never the subject.
          predicates.add(0);
        } else if (after?.cls === "aux" || run.length === 1) {
          addNounPhrase(run);
        } else if (NP_DO_OR_MODAL.has(core.lower)) {
          // The bare main verb: the last token, or — when a plural object
          // follows it ("assign jobs") — the last bare token before that.
          let verbAt = run.length - 1;
          if (/s$/u.test(run[verbAt]!.lower)) {
            for (let v = run.length - 2; v >= 1; v -= 1) {
              if (!/s$/u.test(run[v]!.lower)) { verbAt = v; break; }
            }
          }
          predicates.add(verbAt);
          addNounPhrase(run.slice(0, verbAt));
          addIfCompound(run.slice(verbAt + 1));
        } else if (isParticipleShaped(run[run.length - 1]!.lower)) {
          predicates.add(run.length - 1);
          addNounPhrase(run.slice(0, -1));
        } else {
          addNounPhrase(run);
        }
      } else if (detLed) {
        // "… is the default" — a complement noun phrase.
        addNounPhrase(run);
      } else {
        // "inventory is replenished", "a user is denied access": the
        // predicate follows its subject's auxiliary.
        predicates.add(0);
        addIfCompound(run.slice(1));
      }
    } else if (!detLed && before >= 0 && tokens[before]!.cls === "wh-det") {
      // "which inputs cause …", "what errors are thrown": the wh-noun is the
      // KIND asked about; a verb that follows it is a predicate.
      if (after !== undefined && after.cls !== "aux" && run.length >= 2) predicates.add(run.length - 1);
    } else if (!detLed && before >= 0 && tokens[before]!.cls === "pron"
      && !(["me", "us"].includes(tokens[before]!.lower) && prevIndex(before - 1, SKIP_ADV) === leadVerbAt && leadVerbAt >= 0)) {
      // "does it give up", "how it works": the verb follows its pronoun subject.
      predicates.add(0);
      addIfCompound(run.slice(1));
    } else if (after?.cls === "aux") {
      // Subject position: "how inventory is …", "database migrations are …".
      addNounPhrase(run);
    } else if (clauseOpenerBefore(s) >= 0 && (core === undefined || core.cls === "wh" || core.cls === "sub" || core.cls === "wh-det")
      && run.length >= 2) {
      // The first noun run of a wh/subordinate clause with no auxiliary:
      // subject, then its finite verb ("when the payment fails", "how the
      // scheduler assigns jobs", "how retries work"). The FIRST -s/-ed word
      // after the subject's first word is taken as the verb; only a run with
      // none ends in its bare verb. Where a plural noun and a 3rd-person verb
      // look alike ("how session tokens expire") this errs toward reading the
      // noun as the verb — a subject word left ineligible, never a verb
      // made eligible.
      const last = run.length - 1;
      let verbAt = -1;
      for (let v = 1; v <= last; v += 1) {
        if (isFiniteVerbShaped(run[v]!.lower)) { verbAt = v; break; }
      }
      if (verbAt < 1) verbAt = last;
      predicates.add(verbAt);
      addNounPhrase(run.slice(0, verbAt));
      addIfCompound(run.slice(verbAt + 1));
    } else if (core?.cls === "prep" && !NP_TOPIC_PREPOSITIONS.has(core.lower) && !descriptorComplement) {
      // The object of a locative/temporal preposition ("in this codebase",
      // "during the shutdown sequence", "through a retry scheduler") is an
      // adjunct, not the clause's topic. R2-T2 follow-up (orchestrator ruling):
      // not even a noun compound there — a modifier phrase never names the
      // subject (WP-C3 used to admit "a compound names a topic of its own").
      // The complement of a phrasal request verb ("walk me through the rate
      // limiter") is no modifier: it keeps what every prepositional object had
      // before — the nouns of a multi-word noun compound.
      if (atComplement) addIfCompound(run);
    } else if (detLed) {
      addNounPhrase(run);
    } else if (before >= 0 && (before === leadVerbAt
      || (["me", "us"].includes(tokens[before]!.lower) && prevIndex(before - 1, SKIP_ADV) === leadVerbAt && leadVerbAt >= 0))) {
      // The direct object of the request verb: "update changelog", "explain caching behaviour".
      addNounPhrase(run);
    } else if (core?.cls === "prep" && NP_TOPIC_PREPOSITIONS.has(core.lower)) {
      addNounPhrase(run);
    } else if (s === start && !hasClauseSignal && leadVerbAt < 0) {
      if (after === undefined || after.cls === "prep" || after.cls === "conj" || after.cls === "num") {
        // A verbless list fragment ("Redis cache invalidation", "Callers of X").
        addNounPhrase(run);
      } else {
        // A clause-initial word followed by its own object ("Compute the
        // refund total"): an imperative verb, never the subject.
        run.forEach((_, i) => predicates.add(i));
      }
    } else {
      // A bare object or prepositional object: only a multi-word noun
      // compound names a topic of its own ("handles session renewal").
      addIfCompound(run);
    }
    addCapitalized(run, s, predicates);
  }
}

/**
 * WP-C3 — every word of `clause` that sits in one of its topic noun phrases,
 * lowercased (rule 1(d)); a predicate or wh-noun position never contributes.
 * An ASCII word inside Japanese text is a noun there (Japanese carries its
 * own predicates), so a JA-bearing segment contributes its ASCII words
 * whole. Descriptors are NOT removed here — `isLiteralEligibleTerm` does.
 */
export function topicNounPhraseWords(clause: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const segment of clause.split(NP_SEGMENT_SPLIT_RE)) {
    if (/[぀-ヿ一-鿿]/u.test(segment)) {
      for (const token of npTokens(segment)) if (token.cls === "content") out.add(token.lower);
      continue;
    }
    enSegmentTopicWords(segment, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Copilot retest r3 (2026-10-02, rule (c) refinement) — a QUESTION asks about
// its subject. "How does the shipping webhook retry failed deliveries?" and "Does
// the payment gateway retry on 503?" are where people really ask about something
// the workspace may not have, so a head noun there IS that subject, never an
// aspect of a present thing: rule (c) does not apply to a noun phrase of a
// question ("subject absence is kept, descriptor absence is never certified").
// A sentence is a question when it ends in "?" or opens — after a coordinator —
// with a wh-word (what/which/where/when/why/how/who/whose) or an auxiliary/modal
// (does/do/did/is/are/was/were/has/have/had/can/could/should/would/will).
// Imperatives, verbless list fragments and the objects of a lead verb ("explain
// discount order", "Trace the shipping webhook") are not questions and keep (c).
// Three openers that are imperatives by position, not questions: "Can/Could/Would/Will
// you explain ...?" is addressed to the reader, "Do not ..." prohibits, and "Have a
// look at ..." is a request ("Have the retries failed ..." is a question).
// ---------------------------------------------------------------------------
const QUESTION_OPENING_AUXILIARIES: ReadonlySet<string> = new Set([
  "does", "do", "did", "is", "are", "was", "were", "has", "have", "had", "can", "could", "should", "would", "will",
]);
/** The modals that, followed by "you", make a polite request ("Can you explain ...?") rather than a question about the workspace. */
const REQUEST_MODALS: ReadonlySet<string> = new Set(["can", "could", "would", "will"]);

/**
 * The clauses of `text` a question can open or end: split after a terminator (. ? !
 * ; or the colon that introduces an answer: "Read the files and answer: What does
 * retrySchedule() return") that is followed by whitespace or the end, and at line
 * breaks — never at a period glued into a token ("src/backoff.ts", "res.json()") or
 * ending an abbreviation ("e.g.").
 */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  // Only from the START of a terminator run: retrying inside a long run of dots made this quadratic (review, 2026-10-02).
  for (const m of text.matchAll(/(?<![.?!;:。！？])[.?!;:。！？]+(?=\s|$)|\n+/gu)) {
    const end = (m.index ?? 0) + m[0].length;
    if (m[0].startsWith(".") && ABBREVIATION_PERIOD_RE.test(text.slice(0, end))) continue;
    out.push(text.slice(from, end));
    from = end;
  }
  out.push(text.slice(from));
  return out.filter((sentence) => sentence.trim().length > 0);
}

/** True when `sentence` is a question (see the section comment above). */
function isInterrogativeSentence(sentence: string): boolean {
  const tokens = npTokens(sentence);
  let i = 0;
  while (i < tokens.length && (tokens[i]!.cls === "conj" || tokens[i]!.cls === "adv")) i += 1;
  const first = tokens[i];
  if (first === undefined) return false;
  const next = tokens[i + 1]?.lower;
  if (REQUEST_MODALS.has(first.lower) && next === "you") return false;
  if ((first.lower === "do" || first.lower === "does" || first.lower === "did") && next === "not") return false;
  if (/[?？]["'’”)\]\s]*$/u.test(sentence)) return true;
  if (first.cls === "wh" || first.cls === "wh-det") return true;
  if (first.lower === "have" && (next === "a" || next === "an")) return false;
  return QUESTION_OPENING_AUXILIARIES.has(first.lower);
}

/** Verbs of telling and knowing that take an embedded question ("explain HOW ...", "check WHETHER ...", "I want to know IF ..."). */
const EMBEDDED_QUESTION_LEAD_WORDS: ReadonlySet<string> = new Set([
  "explain", "describe", "tell", "show", "know", "check", "see", "wonder", "ask", "understand",
  "clarify", "determine", "trace", "confirm", "verify", "learn", "find", "figure", "work",
]);
/** What opens an embedded question after such a verb. */
const EMBEDDED_QUESTION_OPENERS: ReadonlySet<string> = new Set([
  "how", "whether", "if", "what", "which", "where", "when", "why", "who", "whose",
]);
/** An existence check ("check whether the shipping webhook exists", "the existence of ..."): every word of it is asked about. */
const EXISTENCE_WORD_RE = /\bexist(?:s|ed|ing|ence)?\b/iu;
/** A subject longer than this many content words is no subject this reader can trust. */
const MAX_QUESTION_SUBJECT_WORDS = 4;

/**
 * Review of the Copilot retest r3 wave (2026-10-02) — the SUBJECT words of every
 * question clause of `sentence`, which rule (c) never suppresses ("subject absence is
 * kept"): the main clause when the sentence is a question (`isInterrogativeSentence`),
 * and every embedded question a verb of telling or knowing opens ("Explain how the
 * shipping webhook retries", "Tell me whether the payment gateway retries on 503",
 * "I want to know if ..."). A subject runs from after its opener (the wh-word, the
 * opening auxiliary, "whether"/"if"; one auxiliary and "there" right after it are
 * skipped, determiners too) to the first word that is not a content word or is shaped
 * like a finite verb ("retries", "exists") with no other verb-shaped word right after
 * it (that makes it a plural noun: "webhooks retried"), at most
 * MAX_QUESTION_SUBJECT_WORDS words.
 * An existence check makes every content word of its sentence a subject. Objects keep
 * rule (c): "whether points affect free shipping eligibility" asks about points, not
 * about the eligibility it names.
 */
function questionSubjectWords(sentence: string): Set<string> {
  const out = new Set<string>();
  const tokens = npTokens(sentence);
  if (EXISTENCE_WORD_RE.test(sentence)) {
    for (const token of tokens) if (token.cls === "content") out.add(token.lower);
    return out;
  }
  const starts: number[] = [];
  if (isInterrogativeSentence(sentence)) {
    let opener = 0;
    while (opener < tokens.length && (tokens[opener]!.cls === "conj" || tokens[opener]!.cls === "adv")) opener += 1;
    starts.push(opener + 1);
  }
  tokens.forEach((token, i) => {
    if (!EMBEDDED_QUESTION_OPENERS.has(token.lower)) return;
    if (tokens.slice(0, i).some((previous) => EMBEDDED_QUESTION_LEAD_WORDS.has(previous.lower))) starts.push(i + 1);
  });
  for (const start of starts) {
    let i = start;
    if (tokens[i]?.cls === "aux") i += 1;
    if (tokens[i]?.lower === "there") i += 1;
    let taken = 0;
    for (; i < tokens.length && taken < MAX_QUESTION_SUBJECT_WORDS; i += 1) {
      const token = tokens[i]!;
      if (token.cls === "det" || token.cls === "num") continue;
      if (token.cls !== "content") break;
      // A verb-shaped word ends the subject unless another verb-shaped word follows
      // it: then it is a plural noun ("the shipping WEBHOOKS retried").
      const next = tokens[i + 1];
      if (isFiniteVerbShaped(token.lower) && !(next?.cls === "content" && isFiniteVerbShaped(next.lower))) break;
      out.add(token.lower);
      taken += 1;
    }
  }
  return out;
}

/**
 * Copilot retest r3 (2026-10-02, rule (c)) — for every topic word of `clause` that
 * is the HEAD of a noun phrase carrying noun modifiers ("discount ORDER",
 * "giftcard discount ELIGIBILITY", "quote CALCULATION", "points/free-shipping
 * INTERACTION"), the modifier words (lowercase) in front of it. A head like that
 * names an ASPECT of the things its modifiers name (the order of discounts, the
 * eligibility of gift cards), so when one of those things is present in the
 * workspace the head relates present things and its own absence says nothing
 * about the workspace: the caller (readCodeTaskPack.ts `headRelatesPresentThings`)
 * decides that against the workspace, because only it can look. It is only ever
 * asked for a word `topicNounPhraseWords` already admits — this never ADMITS a
 * word, it only reports what a word sits behind.
 *
 * What is NOT a suppressible head, by construction: a phrase that ENDS in a facet
 * descriptor ("the cache entryway PATH": the descriptor is the head, "entryway"
 * is its subject); a bare single-word phrase ("product"); a word that sits
 * anywhere else in the clause as a bare noun, a modifier or a capitalised noun; a
 * modifier-less head ("refund" in "refund flow"); a word whose modifiers are
 * adjectives, -ed participles or function words only; and ANY noun phrase of a
 * QUESTION sentence (`isInterrogativeSentence`): there the head is the subject asked
 * about, so its words go to the "other" side exactly like a bare noun. EN only: a
 * Japanese segment contributes its words to the "other" side.
 */
export function topicHeadModifiers(clause: string): ReadonlyMap<string, readonly string[]> {
  const collector: HeadCollector = { heads: new Map(), other: new Set() };
  const scratch = new Set<string>();
  for (const sentence of sentencesOf(clause)) {
    // The SUBJECT of every question clause is what that question asks about: its
    // words go to `other`, so no head among them is suppressed. The rest of the
    // sentence (a question's object included) is read like any other clause.
    for (const word of questionSubjectWords(sentence)) collector.other.add(word);
    for (const segment of sentence.split(NP_SEGMENT_SPLIT_RE)) {
      if (/[぀-ヿ一-鿿]/u.test(segment)) {
        for (const token of npTokens(segment)) if (token.cls === "content") collector.other.add(token.lower);
        continue;
      }
      enSegmentTopicWords(segment, scratch, collector);
    }
  }
  const result = new Map<string, readonly string[]>();
  for (const [word, modifiers] of collector.heads) {
    if (!collector.other.has(word)) result.set(word, [...modifiers]);
  }
  return result;
}

// Japanese: a noun phrase is a run with no clause-internal particle and no
// predicate ending; its の-segments that are descriptors are trimmed from
// either edge (rule 1(d) "after removing descriptors").
const JA_TOPIC_SUFFIX_RE = /(?:について|に関して|に関する|とは|という名前|という)$/u;
const JA_LEADING_DEMONSTRATIVE_RE = /^(?:その|この|あの|どの|各|全)/u;
const JA_NOUN_CHAR = "ァ-ヶー一-鿿々";
/** A particle other than の between two noun characters: the run is a clause, not a noun phrase. */
const JA_CLAUSE_PARTICLE_INSIDE_RE = new RegExp(`[${JA_NOUN_CHAR}](?:が|を|は|に|で|へ|と|や|も|から|まで|より)(?=.)`, "u");
/** A verb/adjective ending directly in front of a noun: a relative clause or an adjective. */
const JA_ATTRIBUTIVE_PREDICATE_RE = new RegExp(`(?:する|される|させる|している|されている|した|された|できる|れる|られる|せる|ている|ていた|てる|ない|なかった|る|う|く|ぐ|す|つ|ぬ|ぶ|む|た|だ|い|な)(?=[${JA_NOUN_CHAR}])`, "u");
/** A run that ENDS in a verb/adjective/copula form. */
const JA_TRAILING_PREDICATE_RE = /(?:する|される|させる|している|されている|した|された|して|できる|れる|られる|せる|ている|ていた|てる|ない|なかった|たい|ます|ました|です|でした|る|う|く|ぐ|す|つ|ぬ|ぶ|む|た|だ|い|て)$/u;

/**
 * WP-C3 — the topic noun phrase of a Japanese `run` (one `salientWords` CJK
 * candidate), with its descriptor の-segments removed from either edge
 * (「マイグレーションの仕組み」→「マイグレーション」, 「バックオフ戦略の種類」→
 * 「バックオフ戦略」); `run` itself when nothing needs removing
 * (「キャッシュの有効期限」); undefined when the run is a clause (a particle
 * other than の inside it, or a verb/adjective ending — 「各ロールが返す
 * ステータスコードの一覧」, 「無効化する処理」) or nothing but descriptors.
 */
export function jaTopicNounPhrase(run: string): string | undefined {
  let core = run.replace(JA_TOPIC_SUFFIX_RE, "");
  core = core.replace(JA_LEADING_DEMONSTRATIVE_RE, "");
  if (core.length < 2 || !new RegExp(`[${JA_NOUN_CHAR}]`, "u").test(core)) return undefined;
  if (JA_CLAUSE_PARTICLE_INSIDE_RE.test(core) || JA_ATTRIBUTIVE_PREDICATE_RE.test(core) || JA_TRAILING_PREDICATE_RE.test(core)) {
    return undefined;
  }
  const segments = core.split("の");
  if (segments.some((segment) => segment.length === 0 || !new RegExp(`[${JA_NOUN_CHAR}]`, "u").test(segment))) return undefined;
  let from = 0;
  let to = segments.length;
  while (from < to && isFacetDescriptorTerm(segments[from]!)) from += 1;
  while (to > from && isFacetDescriptorTerm(segments[to - 1]!)) to -= 1;
  if (from >= to) return undefined;
  const kept = segments.slice(from, to);
  if (kept.some((segment) => isFacetDescriptorTerm(segment))) return undefined;
  const form = kept.join("の");
  return from === 0 && to === segments.length && core === run ? run : form;
}

// ---------------------------------------------------------------------------
// R2-T2 (2026-09-30, orchestrator RULING on the katakana false absence) — a
// katakana LOANWORD names a concept the workspace would spell in English, so
// a literal miss of the katakana proves nothing unless some English spelling
// of it was checked too. The JA bridge (retrieval/jaQueryBridge.ts) maps a
// katakana run to English only through words the workspace already uses —
// so a concept the workspace lacks is never "mapped" there, and a concept it
// spells only in prose the vocabulary does not index (a README's "health
// probe") is not either. The bridge's own glossary (retrieval/jaGlossary.ts,
// general IT/business vocabulary) is the one workspace-INDEPENDENT source of
// an English spelling: a run it covers completely has a KNOWN spelling that
// an absence scan can check, whether or not the workspace uses it.
// ---------------------------------------------------------------------------
const JA_GLOSSARY_KATAKANA: ReadonlyMap<string, readonly string[]> = new Map(
  JA_GLOSSARY.filter(([term]) => /^[゠-ヿｦ-ﾟ]+$/u.test(term)),
);
const JA_GLOSSARY_KATAKANA_MAX_CHARS = Math.max(0, ...[...JA_GLOSSARY_KATAKANA.keys()].map((term) => term.length));

/** The katakana runs (two characters or more) of `text` — the same runs the JA bridge maps. */
export function katakanaRunsOf(text: string): string[] {
  return [...text.matchAll(new RegExp(KATAKANA_RUN_RE.source, "gu"))].map((m) => m[0]).filter((run) => run.length >= 2);
}

/**
 * R2-T2 — the English spellings the JA glossary knows for the katakana run
 * `run`: the stems of a complete cover of `run` by the glossary's katakana
 * entries (segments of two characters or more, fewest segments), or
 * undefined when no complete cover exists ("レディスキャッシュ": レディス has
 * no entry). Workspace-independent by design — see the section comment.
 */
export function katakanaGlossarySpellings(run: string): string[] | undefined {
  const n = run.length;
  if (n < 2) return undefined;
  const best: Array<number> = new Array(n + 1).fill(Number.POSITIVE_INFINITY);
  const back: Array<number> = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let end = 2; end <= n; end += 1) {
    for (let start = Math.max(0, end - JA_GLOSSARY_KATAKANA_MAX_CHARS); start <= end - 2; start += 1) {
      if (best[start] === Number.POSITIVE_INFINITY || !JA_GLOSSARY_KATAKANA.has(run.slice(start, end))) continue;
      if (best[start]! + 1 < best[end]!) {
        best[end] = best[start]! + 1;
        back[end] = start;
      }
    }
  }
  if (best[n] === Number.POSITIVE_INFINITY) return undefined;
  const spellings: string[] = [];
  for (let end = n; end > 0; end = back[end]!) {
    for (const stem of JA_GLOSSARY_KATAKANA.get(run.slice(back[end]!, end)) ?? []) {
      if (!spellings.includes(stem)) spellings.unshift(stem);
    }
  }
  return spellings;
}

/** Quote marks that open/close at word edges (an apostrophe inside "user's" never opens a span). */
const EDGE_QUOTED_SPAN_RE = /(?:^|[\s(\[{぀-ヿ一-鿿、。])([`"'])[^`"'\n]{2,}?\1(?=$|[\s)\]},.;:!?぀-ヿ一-鿿、。])|「[^」]{2,}」|『[^』]{2,}』/u;

/**
 * R2-T2 follow-up — true when a facet descriptor of `text` takes a subject of
 * its OWN: the object of a topic preposition after it ("the default values OF
 * the flux capacitor", "the callers FOR the rate limiter") or a possessive
 * owner in front of it ("the retry constant's configured value"). Such a
 * clause is about that subject even when its facet inherits the lead's
 * identifiers (readCodeTaskPack.ts `RequestItem.facetSubject`). EN only — a
 * Japanese clause answers false (the point then stays with the lead's
 * identifier: never certified absent, the safe direction).
 */
export function clauseNamesOwnFacetSubject(text: string): boolean {
  if (/[぀-ヿ一-鿿]/u.test(text)) return false;
  const tokens = npTokens(text);
  return tokens.some((token, i) => {
    if (token.cls === "content" && token.possessive && tokens.slice(i + 1).some((next) => next.cls === "content" && isFacetDescriptorTerm(next.lower))) {
      return true;
    }
    if (token.cls !== "content" || !isFacetDescriptorTerm(token.lower)) return false;
    const prep = tokens[i + 1];
    if (prep === undefined || !(NP_TOPIC_PREPOSITIONS.has(prep.lower) || prep.lower === "for")) return false;
    let j = i + 2;
    while (j < tokens.length && (tokens[j]!.cls === "det" || tokens[j]!.cls === "adv")) j += 1;
    const object = tokens[j];
    return object !== undefined && object.cls === "content" && !isFacetDescriptorTerm(object.lower)
      && !NP_ANAPHORIC_DETERMINERS.has(tokens[j - 1]?.lower ?? "");
  });
}

/**
 * WP-C3 (rule 2(c)) — true when `text` names a code-shaped identifier (the
 * shapes `extractTerms` recognizes, minus prose acronyms and prose
 * abbreviations like "e.g."), a file path, a `$`/`@` sigil name, or an
 * explicitly quoted string. Such a clause's subject IS that identifier or
 * quote; none of its plain words may be certified absent.
 */
export function clauseNamesCodeShapedOrQuotedTerm(text: string): boolean {
  if (EDGE_QUOTED_SPAN_RE.test(text)) return true;
  const terms = extractTerms(text);
  if (terms.files.length > 0) return true;
  if (terms.identifiers.some((id) => !/^[A-Za-z](?:\.[A-Za-z])+$/u.test(id) && isCodeShapedTerm(id))) return true;
  // Copilot retest r3 (2026-10-02, rule (b)): a name written in CALL syntax —
  // `quote()`, `estimate(cart)` — is code even though a bare lowercase word is
  // never code-SHAPED (the same syntactic signal requestFacets.ts's
  // `callShapedNamesIn` already accepts as a facet subject). Without this
  // "Inspect src/checkout and calculate exact quote() results" named no
  // identifier of its own, so its plain words ("calculate") were subject nouns
  // and `request-item-absent:calculate` was certified.
  if (callShapedNamesIn(text).length > 0) return true;
  return /(?:^|[\s(])[$@][A-Za-z_][\w$]*/u.test(text);
}

/** True when `word` is one of the names `text` writes in call syntax (`quote()` -> "quote"), case-insensitively. */
function isCallShapedNameIn(word: string, text: string): boolean {
  const lower = word.toLowerCase();
  return callShapedNamesIn(text).some((name) => name.toLowerCase() === lower);
}

// ---------------------------------------------------------------------------
// Copilot retest r3 (2026-10-02, rule (a)) — a capitalised word that OPENS a
// sentence or clause is capitalised by its position, so its capital is no
// evidence of a proper noun: "Read only", "Report subtotal", "Cite file names"
// begin with an imperative verb (a predicate, by position). The same capital in
// the MIDDLE of a clause ("... uses Redis ...") still is evidence.
//
// Measured leak: a request item is a comma-delimited piece of the request, so it
// routinely holds the tail of one sentence and the head of the next ("... mainland.
// Report subtotal", "... rounding rules. Read only", "... determine it? Cite file
// names"). The absence engine's Tier A takes a capitalised word as a proper-noun
// candidate unless it is the item's own FIRST word, which left the next
// sentence's imperative to certify `request-item-absent:Report` / `:Read` /
// `:Cite`. Decided by POSITION alone (a sentence/line boundary in front of the
// word), never by a verb list.
// ---------------------------------------------------------------------------
type ClauseOpening = "start" | "boundary" | "mid";

/** "e.g.", "i.e.", "U.S." and the usual dotted abbreviations: their period ends no sentence. */
const ABBREVIATION_PERIOD_RE = /(?:^|[\s(])(?:[A-Za-z]\.){1,3}$|(?:^|[\s(])(?:etc|vs|cf|approx|incl|resp|fig|eg|ie)\.$/iu;

/** Where `text[at]` sits: the text's own first word, the first word of a sentence or line that begins INSIDE the text, or anywhere else. */
function clauseOpeningAt(text: string, at: number): ClauseOpening {
  const before = text.slice(0, at).replace(/[("'`[{“‘]+$/u, "");
  if (before.trim().length === 0 || /^[ \t]*(?:[-*•]|\d+[.)])[ \t]*$/u.test(before)) return "start";
  if (/\n[ \t]*(?:[-*•]|\d+[.)])?[ \t]*$/u.test(before)) return "boundary";
  // Glued to the previous token ("Cache.Get", "subtotal.Report"): no sentence starts there.
  if (!/\s$/u.test(before)) return "mid";
  const lead = before.trimEnd();
  const last = lead.slice(-1);
  if (last === "?" || last === "!" || last === ";") return "boundary";
  if (last === "." && !ABBREVIATION_PERIOD_RE.test(lead)) return "boundary";
  return "mid";
}

/**
 * A word followed by a finite-verb-shaped word and then that verb's object ("Redis
 * HANDLES IT", "Stripe SENDS THE event"): a subject and its verb, so a sentence it
 * opens is a statement, never an imperative ("Read files and ...", "Report errors in
 * ..." have no such object right after the second word). Review, 2026-10-02.
 */
const SUBJECT_VERB_OBJECT_AFTER_RE = /^\s+([A-Za-z]+)\s+(?:the|a|an|it|its|them|their|this|that|these|those|our|all|every|each|his|her|my|your)\b/iu;

/** Every whole-word, case-sensitive occurrence of `word` in `text`, classified by where it sits. */
function occurrenceOpenings(word: string, text: string): ClauseOpening[] {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(word)) return [];
  const out: ClauseOpening[] = [];
  for (const m of text.matchAll(new RegExp(`(?<![\\w$])${word}(?![\\w$])`, "gu"))) {
    const at = m.index ?? 0;
    const opening = clauseOpeningAt(text, at);
    const after = SUBJECT_VERB_OBJECT_AFTER_RE.exec(text.slice(at + word.length));
    out.push(opening === "boundary" && after !== null && isFiniteVerbShaped(after[1]!.toLowerCase()) ? "mid" : opening);
  }
  return out;
}

/**
 * Rule (a), Tier A's test — may the CAPITAL of `word` (as written in `text`) be
 * taken as evidence that it names a proper noun? Yes for a code-shaped or quoted
 * word, and for a capital that sits in the middle of a clause; no when every
 * occurrence opens a sentence, a line or the item itself. A word with no
 * occurrence found (a normalised spelling) keeps its capital as evidence — the
 * pre-existing behaviour.
 */
export function capitalizationNamesSubject(word: string, text: string): boolean {
  if (!/^[A-Z]/u.test(word)) return false;
  if (isCodeShapedTerm(word) || quotedOccurrenceInText(word, text)) return true;
  const openings = occurrenceOpenings(word, text);
  return openings.length === 0 || openings.some((opening) => opening === "mid");
}

/**
 * Rule (a), the disclosure gate's test — true when `word` is a plain capitalised
 * word EVERY occurrence of which opens a sentence or line that begins INSIDE
 * `text` (the tail of one sentence glued to the head of the next, "mainland.
 * Report subtotal"): an imperative lead, never a subject. The text's own FIRST word
 * is deliberately not covered (an item such as "Quorblex retry failed batches" is a
 * verbless list fragment whose first word may be a proper noun — the pinned
 * `isLiteralEligibleTerm` reading); a code-shaped or quoted word never is one.
 */
export function isInnerSentenceLead(word: string, text: string): boolean {
  if (!/^[A-Z]/u.test(word) || isCodeShapedTerm(word) || quotedOccurrenceInText(word, text)) return false;
  const openings = occurrenceOpenings(word, text);
  return openings.length > 0 && openings.every((opening) => opening === "boundary");
}

/**
 * WP-C3 (eval-0929 §6, orchestrator RULING) — THE structural literal-absence
 * eligibility predicate: may `word` (one candidate, already isolated by
 * `salientWords`/`item.terms`) be certified `request-item-absent` for the
 * request item whose own clause text is `itemText`?
 *   1(a)/(b) a code-shaped identifier, a name written in call syntax
 *            (`quote()`, rule (b) of the Copilot retest r3), or an explicitly
 *            quoted string — yes;
 *   2(c)     any other word of a clause that names such an identifier or a
 *            quoted string — no (the identifier/quote is the subject);
 *   2(a)     a facet descriptor (requestFacets.ts `isFacetDescriptorTerm`) — no;
 *   1(c)/(d) otherwise, a word of the clause's topic noun phrase — its
 *            subject, the checked term of an existence question
 *            (`topicNounPhraseWords`, EN) or a Japanese noun phrase with no
 *            descriptor left in it (`jaTopicNounPhrase`) — yes; a predicate,
 *            a wh-noun or anything else the analysis cannot place — no (2(b)).
 * Never consults the generic-vocabulary lists — readCodeTaskPack.ts's
 * `disclosableAbsenceTerm` adds those as a second, narrower filter.
 */
export function isLiteralEligibleTerm(word: string, itemText: string): boolean {
  if (quotedOccurrenceInText(word, itemText)) return true;
  if (isCodeShapedTerm(word)) return !isFacetDescriptorTerm(word);
  // Rule (b): the callable of a `name()` clause IS that clause's identifier.
  if (isCallShapedNameIn(word, itemText)) return !isFacetDescriptorTerm(word);
  if (clauseNamesCodeShapedOrQuotedTerm(itemText)) return false;
  if (isFacetDescriptorTerm(word)) return false;
  if (isCjkRun(word)) return jaTopicNounPhrase(word) === word;
  return topicNounPhraseWords(itemText).has(word.toLowerCase());
}

/**
 * TL142-02 (2026-09-13, v0.14.2 hands-on report §4 TL142-02) — true "N
 * independent named edits" recognizer: a request item (already
 * language-neutral across EN "and"/comma/two-sentences/bullets and JA
 * "、"/"に、", via extractRequestItems) qualifies when it names an explicit
 * file term AND at least one other, non-file term (identifier/quoted
 * literal — old/new values are optional prose and never required). Returns
 * the distinct qualifying file paths when >=2 are named; undefined
 * otherwise. Deliberately counts EXPLICIT TARGETS rather than matching a
 * single-relation verb regex (which can only ever describe ONE rename) —
 * see readCodeTaskPack.ts's own `literalFirstRelation` for that narrower,
 * still-needed single-relation grammar. Never fires for:
 *   - a single directed relation ("rename X to Y in path.ts") — one item,
 *     or one item naming no separate identifier alongside its file;
 *   - a rename BETWEEN two bare file paths with no other named identifier
 *     ("rename src/old.ts to src/new.ts") — that item's only non-file terms
 *     ARE files too, so it never satisfies "file term AND an identifier";
 *   - a genuinely ambiguous alternative list ("change X to Y or Z") — no
 *     item names an explicit file at all;
 *   - a single-file query naming an identifier for that ONE file only —
 *     only one distinct file is ever collected, never >=2.
 */
// item.terms's own FILE_EXT_RE match is basename-only (its char class has no
// "/"), so "src/cache.ts" reduces to "cache.ts" there — correct for THAT
// regex's own job (a file MENTION, not necessarily a resolvable path
// source), wrong for seeding buildSeededTaskPack with a workspace-relative
// path. This sibling regex is the same file-extension match, widened to
// also consume a leading directory run, read straight off the item's own
// verbatim TEXT (never item.terms).
// FIXALL-A group A (2026-09-14): the extension whitelist comes from the one
// FILE_EXTENSIONS_ALT declaration above; the PATTERN (a leading directory run)
// is what is still this regex's own.
const FULL_PATH_TERM_SOURCE = `\\b[A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:${FILE_EXTENSIONS_ALT})\\b`;
const FULL_PATH_TERM_RE = new RegExp(FULL_PATH_TERM_SOURCE, "gu");

/** A lead EN edit verb (imperative, clause-initial after stripping any
 *  bullet/numbering marker) or a JA editing-imperative ending — the signal
 *  that distinguishes "change/rename X ... Y ..." (this recognizer's own
 *  shape) from an EXPLAIN/read request that merely happens to name >=2
 *  files each with their own identifier (observed false positive: "Explain
 *  how MCP server definitions are refreshed when the schema stamp
 *  changes.\nFocus on `mcpProvider.ts` and `schemaStamp.ts`." — TL142-05's
 *  own shape, a read request, never an edit; "changes" there is a plain
 *  descriptive verb, not an editing imperative). */
// SHOULD-FIX 44 (2026-09-14, review round 8): a mutation verb immediately
// followed by a colon is a memo/prose LABEL/HEADING ("Update: explain how
// MAX_RETRIES works in src/retry.ts." -- the sentence asks for an
// explanation; "Update:" merely labels the whole note), not an imperative --
// exclude it here with a trailing negative lookahead. "Update MAX_RETRIES in
// src/retry.ts to 5." (no colon; the verb is followed by its object) still
// matches.
/**
 * SHOULD-FIX 46 (2026-09-14, review round 9->10): round 8's `(?!\s*:)` treated
 * ANY colon after a clause-initial mutation verb as proof the verb was a LABEL,
 * so the conventional-commit / ticket register lost its edit lead wholesale:
 * `Update: MAX_RETRIES in src/retry.ts to 5.`, `Fix: src/retry.ts retries
 * forever.`, `Rename: shouldRetry -> canRetry ...`, `Create: src/newfile.ts ...`
 * all became read requests. The actual difference between a heading and an
 * imperative is not the colon -- it is WHAT FOLLOWS it: `Update: explain how
 * MAX_RETRIES works` asks for an explanation (SHOULD-FIX 44's repro), while
 * `Update: MAX_RETRIES ... to 5` asks for an edit. Discount the colon only when
 * it introduces a READ request.
 */
const COLON_INTRODUCES_READ_LEAD = "(?!\\s*:\\s*(?:please\\s+)?(?:explain|describe|clarify|summar|tell\\s+me|show\\s+me|why|how|what|which)\\b)";
/**
 * SHOULD-FIX 55 (AB1, 2026-09-14, review round 11) — ONE VOCABULARY, NOT A
 * MIRROR.
 *
 * Round 10 measured `What does MAX_RETRIES do in src/retry.ts? Set it to 5.` and
 * `… Bump it to 5.` reaching a CERTIFIED `act.answer` with an empty frontier:
 * `readCodeTaskPack.ts::MUTATION_VERBS_EN` (the list behind
 * `REQUESTED_MUTATION_EN_RE`, which decides `profile`) omitted `set`, `bump`,
 * `remove`, `delete`, `modify`, `increase`, `decrease`, `switch`, `toggle`,
 * `enable`, `disable` and `insert` — every one of which the SIBLING predicate
 * in the same file (`MIXED_INTENT_MUTATION_EN_RE`) already carried. Two lists
 * that must agree, in one file, disagreeing: the shape rounds 8 and 9 each
 * closed once by hand and round 10 found again.
 *
 * These two alternations are now declared HERE, once, and imported by
 * `readCodeTaskPack.ts` (no mirror to re-sync):
 *
 *   - `EDIT_LEAD_VERBS_EN` — the verbs that can LEAD a clause and make it an
 *     edit request. Narrow on purpose: these are the ones whose clause-initial
 *     appearance is unambiguous. `EDIT_VERB_LEAD_RE` and
 *     `CONTINUATION_OBJECT_FREE_EN_RE` (BLOCKER 34's whitelist, which must stay
 *     a TRUE mirror of the lead set) are both built from it.
 *   - `MUTATION_VERBS_EN` — the full request-a-mutation vocabulary, the union of
 *     what the two `readCodeTaskPack.ts` predicates carried between them. It is
 *     a superset of `EDIT_LEAD_VERBS_EN` by construction (asserted in
 *     `requestItems.spec.ts`), so "a clause that leads with an edit verb" can
 *     never be a mutation the profile classifier fails to see.
 */
export const EDIT_LEAD_VERBS_EN = "change|rename|replace|update|modify|set|bump" as const;
export const MUTATION_VERBS_EN =
  "fix|add|implement|change|remove|update|set|bump|increase|decrease|modify|replace|rename"
  + "|switch|toggle|enable|disable|insert|delete|refactor|wire|connect|integrate|plumb|route"
  + "|propagate|feed|forward|expose|create|generate";

const EDIT_VERB_LEAD_RE = new RegExp(
  // NOTE 67 (review round 9): `(?!-)` keeps a hyphenated NOUN whose first
  // segment happens to be one of these verbs ("the Set-Cookie header") from
  // reading as an edit lead. `\b` alone does not: `-` is a word boundary.
  `^[\\s\\-*•]*(?:${EDIT_LEAD_VERBS_EN})\\b(?!-)${COLON_INTRODUCES_READ_LEAD}`,
  "iu",
);
/**
 * SHOULD-FIX 64 (AC1, 2026-09-14, review round 12) — ONE VOCABULARY, TWO TIERS
 * OF EVIDENCE. Same guards as `EDIT_VERB_LEAD_RE`, over the WHOLE shared
 * `MUTATION_VERBS_EN` instead of the narrow tier-1 lead set.
 *
 * Round 11 measured the cost of the two lists having two jobs: `Set`/`Change`/
 * `Update`/`Replace`/`Modify`/`Bump` reached `act.edit` with a writable
 * frontier, while `Remove MAX_RETRIES from src/retry.ts.`, `Delete …`,
 * `Increase …`, `Add …`, `Fix …`, `Create …` — 12 verbs, one identical sentence
 * frame, nothing ambiguous about any of them — answered `await_input` with an
 * EMPTY frontier, no `next` and no candidates. The JA side had no such gap:
 * 変更/設定/削除/追加/更新/修正 all reached `act.edit` (measured 6/6), so the
 * asymmetry was EN-only and purely an artefact of which list
 * `itemReadsAsEditLead` was built from.
 *
 * WHY A TIER AND NOT A FLAT WIDENING. `EDIT_LEAD_VERBS_EN`'s own doc records
 * why it is narrow: a clause-initial appearance of those seven is unambiguous.
 * That is NOT true of the rest of the vocabulary — `Switch statements in
 * src/parser.ts — explain how they compile.`, `Route handlers in src/api.ts —
 * explain the ordering.`, `Insert performance in src/db.ts — explain.` all lead
 * with a mutation verb used as a NOUN. So tier 2 additionally requires the
 * clause to carry the OBJECT an imperative has and a noun phrase does not:
 * either a value identifier of its own (`MAX_RETRIES`, `cacheKey` — never a
 * file term, never a bare English noun, since `extractTerms().identifiers` only
 * recognizes dotted/camel/Pascal/CONST_CASE tokens), or nothing at all beyond a
 * pronoun/value (`… and then remove it.`), which is BLOCKER 34's own
 * already-pinned whitelist. Every one of the noun-phrase registers above names
 * no identifier and is not object-free, so none of them becomes an edit lead.
 */
const MUTATION_VERB_LEAD_RE = new RegExp(
  `^[\\s\\-*•]*(?:${MUTATION_VERBS_EN})\\b(?!-)${COLON_INTRODUCES_READ_LEAD}`,
  "iu",
);
/**
 * Review round SHOULD-FIX 6 (2026-09-13): widened to also recognize a
 * continuative "変更し"/"置換し"/... (no ください needed — the clause goes
 * on to a second one, "...に変更し、...にしてください") and the generic
 * causative "にして(ください)?" ending on its own (no 変更/置換/... root at
 * all — "...を5にしてください" = "set it to 5, please"): the exact shape the
 * report's own JA phrasing 「…を 30000 に変更し、…を 5 にしてください。」 uses
 * for its SECOND clause. Also recognizes 更新 (update) alongside 変更 —
 * requestItems.ts's EN edit-verb list already includes "update" and JA had
 * no equivalent root.
 *
 * SHOULD-FIX 16 (review round 3, 2026-09-13): the bare "にして" alternative
 * above misfired on a pure EXPLAIN request ending "...を明確にしてください"
 * ("please make the difference clear") — 明確/参考/大事 are common
 * adjectival nouns, not edit targets, and needed no 変更/置換/... root at
 * all to satisfy the old alternation. Split into two independently-anchored
 * patterns: the verb-ROOT branch (unchanged, already safe — 明確/参考/大事
 * are never 変更/置換/改名/リネーム/修正/更新) and a NEW "にして" branch that
 * additionally requires a concrete value/identifier immediately (mod
 * whitespace) before its "に" — a number, a quoted/bracketed literal, or an
 * ASCII identifier — the shape a real "set <field> to <value>" clause has
 * ("MAX_RETRIES を 5 にしてください"). A bare descriptive adjective has no
 * such token before it and can never satisfy this branch.
 */
// Round-8 residual fix (adopted chip; classifyTaskProfile edit-verb
// alignment): 設定/追加/削除 added to mirror this round's explicit JA lead
// list end-to-end (readCodeTaskPack.ts's MIXED_INTENT_MUTATION_JA now
// recognizes the SAME three verbs -- see that module's own comment). Stays
// tail-anchored exactly like the pre-existing verbs, so this only ever
// fires on a genuine trailing imperative ("...5に設定してください。"), never a
// mid-sentence noun use ("設定ファイルを確認してください" ends in 確認してください,
// not 設定してください). EDIT_VERB_LEAD_RE (EN) and EDIT_VERB_JA_NISHITE_RE stay
// untouched -- see fix-notes-y1.md for the scope call on those two.
// SHOULD-FIX 42 (2026-09-14, review round 8): the pre-existing group's
// inflection (し/して) is OPTIONAL, so a bare noun tail ("src/cache.ts の
// TTL 設定" -- "the TTL setting in src/cache.ts", a read question) matched
// too: 設定 is overwhelmingly a plain noun ("configuration/setting") in
// query text, unlike 追加/削除, whose bare verbal-noun reading is usually
// still an edit request. Split into two groups: the pre-existing six verbs
// keep their optional inflection UNCHANGED (this is the same amplification
// class BLOCKER 34 named, but pre-existing and out of this finding's
// scope); 設定/追加/削除 -- this round's own widening -- require the
// inflection, so only a genuine trailing imperative ("...5に設定して
// ください。") matches, never a bare noun mention.
/**
 * FIXALL-A group C (2026-09-14) — ONE JA MUTATION VOCABULARY, NOT A MIRROR.
 *
 * These two lists are the single declaration of the JA edit-verb roots this
 * package recognizes. `EDIT_VERB_JA_ROOT_RE` (just below) is BUILT from them,
 * and `readCodeTaskPack.ts::MIXED_INTENT_MUTATION_JA` now IMPORTS them instead
 * of hand-mirroring a second spelling. Round 8 closed this exact gap once, by
 * hand-copying 設定/追加/削除 into that sibling list (its own comment records
 * the copy, and the "fix only at that door" scoping that justified it); when
 * 置換/改名/リネーム were later added HERE the copy was never re-applied, so
 * 置換して/改名して/リネームして bound `profile:"answer"` and blocked `act.edit`
 * for the entire pipeline. A hand-maintained mirror cannot be kept in sync by
 * review, so there is no longer a mirror to keep — the SAME reasoning
 * `MUTATION_VERBS_EN` already applies to the EN side.
 *
 * The split is SHOULD-FIX 42 (round 8)'s inflection rule, unchanged: the six
 * roots below take an OPTIONAL し/して, while 設定/追加/削除 REQUIRE it (設定 is
 * overwhelmingly a plain noun — "the TTL setting" — in query text, unlike the
 * other two, whose bare verbal-noun reading still reads as an edit request).
 */
export const EDIT_VERB_JA_ROOTS_OPTIONAL_INFLECTION: readonly string[] = [
  "変更", "置換", "改名", "リネーム", "修正", "更新",
];
export const EDIT_VERB_JA_ROOTS_REQUIRED_INFLECTION: readonly string[] = ["設定", "追加", "削除"];
/** Every JA edit-verb root this package recognizes, in declaration order. */
export const EDIT_VERB_JA_ROOTS: readonly string[] = [
  ...EDIT_VERB_JA_ROOTS_OPTIONAL_INFLECTION,
  ...EDIT_VERB_JA_ROOTS_REQUIRED_INFLECTION,
];
/**
 * FIXALL-A group A (2026-09-14) — THE PLAIN IMPERATIVE REGISTER (〜しろ / 〜せよ).
 *
 * `変更しろ` / `追加せよ` is an ordinary (blunt) Japanese imperative and is already
 * a sanctioned REQUEST ending one door up in `readCodeTaskPack.ts`
 * (`REQUESTED_MUTATION_JA_RE`'s own `しろ|せよ` alternatives, and
 * `MIXED_INTENT_MUTATION_JA_NON_TE_RE`'s), but this regex — the lead test the
 * frontier's write-authority veto actually consults — admitted only the
 * し/して/ください forms, so an entire register of the matrix
 * (`src/retry.ts に改名しろ。`) carried NO lead at all and every path in it fell
 * back to `read`. Alternation order matters: しろ must precede the bare し, since
 * JS alternation is first-match-wins and a leading `し` would strand the `ろ`
 * against the `(?:ください|下さい)?[。.]?$` tail (the same ordering rule
 * `JA_BARE_PARTICLES_LONGEST_FIRST` records above).
 */
const EDIT_VERB_JA_INFLECTIONS = "しろ|せよ|して|し";
const EDIT_VERB_JA_ROOT_RE = new RegExp(
  `(?:(?:${EDIT_VERB_JA_ROOTS_OPTIONAL_INFLECTION.join("|")})(?:${EDIT_VERB_JA_INFLECTIONS})?`
  + `|(?:${EDIT_VERB_JA_ROOTS_REQUIRED_INFLECTION.join("|")})(?:${EDIT_VERB_JA_INFLECTIONS}))`
  + "(?:ください|下さい)?[。.]?\\s*$",
  "u",
);
const EDIT_VERB_JA_NISHITE_RE =
  /(?:[0-9]+|["'][^"']+["']|「[^」]+」|[A-Za-z_][A-Za-z0-9_]*)\s*に\s*して(?:ください|下さい)?[。.]?\s*$/u;

/** True when `text` ends in a JA editing imperative — either a
 *  変更/置換/改名/リネーム/修正/更新 verb root, or a bare "にして" causative whose
 *  own concrete-value guard (`EDIT_VERB_JA_NISHITE_RE`) is satisfied. */
function endsWithJaEditImperative(text: string): boolean {
  return EDIT_VERB_JA_ROOT_RE.test(text) || EDIT_VERB_JA_NISHITE_RE.test(text);
}

/**
 * Review round SHOULD-FIX 6 (2026-09-13): a LEADING politeness/lead phrase
 * — "Please change...", "Could you change...", "I'd like you to change..."
 * — used to restore `queryReadsAsEditRequest`'s dead end: `EDIT_VERB_LEAD_RE`
 * is anchored at the very start, so one such word ahead of the verb was
 * enough to defeat it (report regression: "Please change DEFAULT_TTL_MS in
 * src/cache.ts..." fell straight back to `await_input`/`choose-candidate`).
 * Stripped only for the edit-lead TEST, never from the text a path/term is
 * actually read from.
 */
const POLITENESS_LEAD_RE =
  /^[\s\-*•]*(?:please|kindly|could\s+you(?:\s+please)?|can\s+you(?:\s+please)?|would\s+you(?:\s+please)?|i(?:'d|\s+would)\s+like\s+(?:you\s+to|to)|i\s+want\s+you\s+to)\b[,:]?\s*/iu;
const POLITENESS_LEAD_JA_RE = /^[\s]*(?:すみませんが|恐れ入りますが|お手数ですが|恐縮ですが)[、,]?\s*/u;

function stripPolitenessLead(text: string): string {
  return text.replace(POLITENESS_LEAD_RE, "").replace(POLITENESS_LEAD_JA_RE, "");
}

/**
 * SHOULD-FIX 15 (review round 3, 2026-09-13): `extractRequestItems` can split
 * a lead-in file clause onto its OWN item ("in src/retry.ts change
 * MAX_RETRIES to 5." keeps both the location and the verb in one item, but a
 * comma-split sibling shape ends up with the edit verb after a leading
 * "in <path>,"/"at <path>," locative that is not the item's very first
 * token). Stripped only for the edit-lead TEST, mirroring
 * `stripPolitenessLead`, so `EDIT_VERB_LEAD_RE`'s clause-initial anchor still
 * finds the verb.
 */
const LOCATIVE_LEAD_RE = /^[\s\-*•]*(?:in|at|inside|within|for)\s+\S+\s*[,:]?\s*/iu;

/**
 * SHOULD-FIX 56 (AB1, 2026-09-14, review round 11): a DISCOURSE ADVERB before
 * the verb, stripped for the lead TEST only — exactly the shape SHOULD-FIX 15
 * used for a locative and SHOULD-FIX 6 for politeness.
 *
 * Measured (round 10, five registers, one control): `Explain how MAX_RETRIES
 * works in src/retry.ts, and set it to 5.` reaches `act.edit` with
 * `["src/retry.ts"]` writable, and EVERY one of `, and then` / `; then` /
 * `. Then` / `, and also` / `, then` loses it and answers `discover` with an
 * empty frontier — because the splitter hands the second clause over as
 * `"then set it to 5."` and `EDIT_VERB_LEAD_RE` admits only whitespace and
 * bullets ahead of the verb. `Explain src/retry.ts; then set MAX_RETRIES to 5 in
 * src/cache.ts.` was worse: the edit clause names its own file AND its own
 * identifier, and still inherited `read` from the preceding clause.
 *
 * `and` is deliberately NOT here: the item splitter already consumes `, and `,
 * and a bare `and` ahead of a verb is load-bearing for round 9's
 * `"...and once you fix the Compute logic, list the affected types"` positive.
 */
const DISCOURSE_LEAD_RE =
  /^[\s\-*•]*(?:then|also|next|now|finally|after\s+that|afterwards|subsequently)\b[,:]?\s*/iu;
const DISCOURSE_LEAD_JA_RE = /^[\s]*(?:そして|次に|また|その後|最後に)[、,]?\s*/u;

/**
 * The ONE lead-prefix strip chain, shared by the edit-lead and read-lead tests
 * so the three prefix registers (politeness, locative, discourse) can never be
 * applied to one test and forgotten on the other.
 */
function stripLeadPrefixes(text: string): string {
  return stripPolitenessLead(text)
    .replace(DISCOURSE_LEAD_RE, "")
    .replace(DISCOURSE_LEAD_JA_RE, "")
    .replace(LOCATIVE_LEAD_RE, "")
    // A discourse adverb can also sit AFTER the locative ("In src/retry.ts,
    // then set it to 5."), so the discourse strip runs on both sides of it.
    .replace(DISCOURSE_LEAD_RE, "");
}

/** True when `text` — a whole query OR one `extractRequestItems` item's own
 *  text — itself reads as an edit-lead, once a leading politeness phrase and
 *  (SHOULD-FIX 15) a leading locative clause are stripped. */
function itemReadsAsEditLead(text: string): boolean {
  const stripped = stripLeadPrefixes(text);
  // Tier 1: the seven verbs whose clause-initial appearance is unambiguous.
  if (EDIT_VERB_LEAD_RE.test(stripped)) return true;
  if (endsWithJaEditImperative(text.trim())) return true;
  // SHOULD-FIX 64 (AC1, round 12) — tier 2: the rest of the ONE shared
  // `MUTATION_VERBS_EN`, admitted only with the object an imperative carries
  // (see `MUTATION_VERB_LEAD_RE`'s doc for the noun-phrase registers this
  // second condition is what excludes).
  if (!MUTATION_VERB_LEAD_RE.test(stripped)) return false;
  return clauseNamesOwnValueIdentifier(text)
    || clauseNamesOnlyAFileObject(stripped)
    || continuationDonatesNoObjectOfItsOwn(text);
}

/**
 * FIXALL-A group A (2026-09-14) — A FILE IS AN OBJECT TOO.
 *
 * Tier 2 (SHOULD-FIX 64) admits a mutation verb only when the clause carries
 * "the object an imperative has", and it counted exactly two shapes: a non-file
 * VALUE identifier, or nothing at all beyond a pronoun/value. A clause whose
 * whole object is a FILE — `Disable src/retry.ts.`, `Increase "src/retry.ts".`,
 * `switch 'src/retry.ts'?` — is neither, so it carried no edit lead: the file
 * the caller explicitly asked to change either inherited a neighbouring
 * clause's `read` (a fused item) or was dropped altogether (its own item, via
 * `collectEditPathSignal`'s `hasIdentifier` gate). The JA side never had this
 * gap, because `EDIT_VERB_JA_ROOT_RE` is tail-anchored and does not look at the
 * object at all — the asymmetry is EN-only, exactly like the one SHOULD-FIX 64
 * itself closed.
 *
 * WHY THIS IS NARROWER THAN "the clause names a file". `MUTATION_VERB_LEAD_RE`'s
 * own doc records the registers tier 2 exists to exclude — `Switch statements in
 * src/parser.ts — explain how they compile.`, `Insert performance in src/db.ts
 * — explain.` — and EVERY one of them names a file. What distinguishes them is
 * not the presence of a file but its GRAMMATICAL ROLE: there the file sits in a
 * locative phrase modifying a noun (`statements IN src/parser.ts`), while here
 * it is the verb's own direct object and the clause ends right after it. So the
 * test is anchored over the WHOLE clause — the recognized verb, an optional
 * article, an optionally quoted file term, terminal punctuation, end — the same
 * whitelist-a-known-safe-shape discipline `CONTINUATION_OBJECT_FREE_EN_RE` uses
 * rather than a blacklist of unsafe words. A clause with anything else in it
 * (another noun, a trailing read verb, a second object) never matches.
 *
 * Runs on the PREFIX-STRIPPED text so `then disable src/retry.ts.` and
 * `Please disable src/retry.ts.` are the same clause to it, exactly as
 * `MUTATION_VERB_LEAD_RE` already sees them.
 */
const CLAUSE_FILE_OBJECT_ONLY_EN_RE = new RegExp(
  `^[\\s\\-*•]*(?:${MUTATION_VERBS_EN})\\b(?!-)\\s+(?:the|a|an)?\\s*`
  + `["'\x60「]?${FULL_PATH_TERM_SOURCE}["'\x60」]?`
  + "\\s*[.!?。！？]?\\s*$",
  "iu",
);
function clauseNamesOnlyAFileObject(strippedText: string): boolean {
  return CLAUSE_FILE_OBJECT_ONLY_EN_RE.test(strippedText);
}

/**
 * SHOULD-FIX 64 (AC1, 2026-09-14, review round 12): does this clause name a
 * VALUE IDENTIFIER of its own — the object a mutation imperative has?
 *
 * The same question `clauseLeadRows`'s `namesIdentifier` asks, factored out so
 * the tier-2 lead test above and the donation gate below cannot drift: a
 * file-shaped term is not a value (`looksLikeFileTerm`), and `extractTerms`
 * recognizes only dotted/camelCase/PascalCase/CONST_CASE tokens as identifiers,
 * so a bare English noun ("statements", "handlers", "performance", "a note",
 * "the changelog") is never one.
 */
function clauseNamesOwnValueIdentifier(text: string): boolean {
  return extractTerms(text).identifiers.some((term) => !looksLikeFileTerm(term));
}

/**
 * SHOULD-FIX 15 (review round 3, 2026-09-13): the edit-lead test's
 * counterpart — true when `text` itself explicitly reads as an
 * explain/describe (READ-only) lead. An item carrying this signal marks
 * itself (and, by inheritance in `explicitMultiEditRequestPaths`, any
 * immediately-following item with no verb of its own) as NOT an edit target,
 * even when the overall query also contains a genuine edit clause elsewhere
 * ("Explain X in a.ts, and change Y in b.ts." — a.ts must stay read-only).
 * The EN branch anchors on the same lead-verb set `GENERIC_CLOSING_EN_RE`
 * vets elsewhere in this file (EN leads with the verb); the JA branch is
 * anchored to the clause's END (JA's SOV order puts the verb there) — a
 * mid-clause read verb never retroactively reclassifies anything, only an
 * explicit LEAD/ENDING does.
 *
 * SHOULD-FIX 26 (review round 4, 2026-09-14): the JA branch used to share ONE
 * suffix, `(?:して)?`, across all three verb roots — correct only for
 * 説明+する (a suru-noun compound, 連用形/continuative "説明し", te-form
 * "説明して"). It was wrong for the other two, which are ichidan STEMS
 * (教える/述べる) whose 連用形 already IS the bare stem and whose te-form adds
 * a bare "て" (never "し"/"して" — that is a different verb's own
 * conjugation). Net effect: the bare continuative "…を説明し、…" (no
 * ください) — the report's own repro, "src/cache.ts の DEFAULT_TTL_MS を説明
 * し、src/retry.ts の MAX_RETRIES を 5 に変更してください。" — had no `ownLead`
 * of its own, so `explicitMultiEditRequestPaths` let it inherit "edit" from
 * the following clause and handed the explain-only src/cache.ts write
 * authority; separately, the ordinary polite "教えてください"/"述べてください"
 * never matched at all (only the ungrammatical "教えください"/"述べください"
 * did). Split into a per-conjugation-class suffix, same shape as the edit
 * side's own `EDIT_VERB_JA_ROOT_RE`/`EDIT_VERB_JA_NISHITE_RE` split, and
 * widened the vocabulary with two more read-only verbs the review round
 * named (確認 "confirm" — a suru-noun compound like 説明; 調べ "investigate"
 * — an ichidan stem like 教え/述べ) plus 読む "read" (a godan verb whose
 * 連用形 "読み" is already bare-usable, but whose te-form undergoes its own
 * u→ん sound change to "読んで", never "読みて" — carried as a second whole
 * alternative rather than a suffix on "読み").
 */
/**
 * B1 (fix-b, 2026-09-21): widened to also recognize "show me" and
 * "summarize"/"summarise" — both were ALREADY reviewed as read-only leads by
 * `COLON_INTRODUCES_READ_LEAD` above (explain/describe/clarify/summar/tell
 * me/show me), just never added to this sibling list. Orchestrator ruling:
 * widening is sanctioned only to leads already reviewed elsewhere in this
 * file — never to an arbitrary imperative. Verified against the five call
 * sites of `itemReadsAsReadLead` (below): four gate on a MUTATION-verb-only
 * regex downstream (`LEAD_VERB_TOKEN_RE`) that this widening cannot affect
 * (neither "show" nor "summarize" is in `MUTATION_VERBS_EN`), and the fifth
 * (`stripValueOnlyLeadClauses`) only blanks a clause that ALSO independently
 * satisfies BLOCKER 34's object-free whitelist — the same treatment
 * "explain"/"describe" already receive.
 */
const READ_VERB_LEAD_EN_RE = /^[\s\-*•]*(?:explain|describe|tell me(?:\s+about)?|show me(?:\s+about)?|clarify|summari[sz]e)\b/iu;
/**
 * FIXALL-A group C (2026-09-14) — the READ half of the ONE JA vocabulary,
 * declared once for the same reason `EDIT_VERB_JA_ROOTS` is (above):
 * `readCodeTaskPack.ts::MIXED_INTENT_ENUMERATION_JA_RE` used to hand-mirror a
 * STRICT SUBSET of this list (列挙/一覧/教えて/説明して/説明し) and therefore did
 * not recognize 確認 — declared here, right beside 説明, since SHOULD-FIX 26 —
 * so a request pairing an edit clause with a 「…を確認してください」 reporting
 * clause still certified a read-only `answer`. The split is SHOULD-FIX 26's own
 * conjugation-class rule, unchanged: 説明/確認 are suru-noun compounds (し/して),
 * 教え/述べ/調べ are ichidan stems (bare, or +て), and 読む is a godan verb whose
 * te-form takes its own sound change (読んで, never 読みて).
 */
export const READ_VERB_JA_SURU_ROOTS: readonly string[] = ["説明", "確認"];
export const READ_VERB_JA_STEM_ROOTS: readonly string[] = ["教え", "述べ", "調べ"];
// FIXALL-A group A (2026-09-14): the plain imperative register, mirroring the
// edit side's EDIT_VERB_JA_INFLECTIONS exactly — 説明しろ / 確認せよ (suru-noun
// compounds, しろ/せよ) and 教えろ / 調べろ (ichidan stems, bare ろ). Without it a
// 「…を説明しろ、…を改名しろ。」 request had NO lead on either side, so the
// read-only clause could not even hold its own path down to read.
const READ_VERB_TRAILING_JA_RE = new RegExp(
  `(?:(?:${READ_VERB_JA_SURU_ROOTS.join("|")})(?:${EDIT_VERB_JA_INFLECTIONS})?`
  + `|(?:${READ_VERB_JA_STEM_ROOTS.join("|")})(?:て|ろ)?|読み|読んで)`
  + "(?:ください|下さい)?[。.]?\\s*$",
  "u",
);

/**
 * BLOCKER 54 (AB1, 2026-09-14, review round 11): a clause that ENDS IN A QUESTION
 * MARK is a read request, by form.
 *
 * The verb-led recognizer above covers `Explain …` / `Describe …` / `Tell me …`,
 * which is what round 10's registers used — but the whole point of the `?`
 * register is that a caller need not use any of those words: measured, `How is
 * MAX_RETRIES used in src/retry.ts? Add a note to the changelog.` produced NO
 * lead row for `src/retry.ts` at all, and a path with no row is a path BLOCKER
 * 34's write-authority gate never judges.
 *
 * Purely structural, and it cannot outrank a genuine edit: every caller asks
 * `itemReadsAsEditLead` FIRST, so `Could you change MAX_RETRIES in src/retry.ts
 * to 5?` stays an edit lead (politeness stripped, verb found) and only a clause
 * with no edit lead of its own is read as the question it is punctuated as.
 */
const QUESTION_CLAUSE_RE = /[?？]\s*$/u;

function itemReadsAsReadLead(text: string): boolean {
  // SHOULD-FIX 56: the SAME strip chain as the edit-lead test. `Then explain
  // what it does.` is as much a read lead as `Explain what it does.`, and a
  // register recognized on one side but not the other is how a clause ends up
  // with no lead at all.
  return READ_VERB_LEAD_EN_RE.test(stripLeadPrefixes(text))
    || READ_VERB_TRAILING_JA_RE.test(text.trim())
    || QUESTION_CLAUSE_RE.test(text.trim());
}

/**
 * Review round SHOULD-FIX 6 (2026-09-13): the ORIGINAL gate tested only the
 * WHOLE query, once, at its very start, so a single politeness word ahead
 * of the verb restored the original `choose-candidate` dead end this
 * recognizer exists to close (report §TL142-02). The whole-query check
 * stays (cheap, and a strict subset of the per-item one below) as a fast
 * path; the per-item fallback is what fixes the regression — each
 * `extractRequestItems` item is independently tested against its OWN
 * (politeness-stripped) text, so "Please change X..., and Y..." qualifies
 * via its SECOND item ("...and MAX_RETRIES in src/retry.ts...") even though
 * the politeness word only ever prefixed the first.
 */
function queryReadsAsEditRequest(query: string, items: readonly RequestItem[]): boolean {
  if (EDIT_VERB_LEAD_RE.test(stripPolitenessLead(query)) || endsWithJaEditImperative(query.trim())) {
    return true;
  }
  if (items.some((item) => itemReadsAsEditLead(item.text))) return true;
  /**
   * FIXALL-A group A (2026-09-14) — CLAUSE-LOCAL, like every other intent test.
   *
   * `requestItemLeads` has been clause-local since AA1 (round 10); this gate,
   * which decides whether its result is even consulted, was still asked only of
   * the WHOLE query and of each ITEM. `extractRequestItems` splits on commas,
   * semicolons, newlines and the JA touten — not on a sentence-final period — so
   * a two-sentence request with no comma anywhere
   * (「src/cache.ts の DEFAULT_TTL_MS を 30000 に設定してください. refactor
   * MAX_RETRIES in src/retry.ts to 5.」) is ONE item whose text neither begins
   * with an EN edit verb nor ENDS in a JA edit imperative, and the gate returned
   * false while `requestItemLeads` had already correctly attributed `edit` to
   * BOTH paths. `explicitMultiEditRequestPaths` then dropped a fully-specified
   * two-edit request on the floor.
   *
   * `splitIntoLeadClauses` is the ONE clause splitter (the same call
   * `hasMixedIntentMutationMarkerEn` in readCodeTaskPack.ts already makes for
   * its own half of this question), and this is an OR over clauses, so it can
   * only ever ADD a match that the whole-query and per-item tests missed. It
   * cannot authorize anything on its own: every caller still intersects it with
   * `requestItemLeads`'s own per-path classification.
   */
  return splitIntoLeadClauses(query, { splitCoordinators: true })
    .some((clause) => itemReadsAsEditLead(clause));
}

/** One `extractRequestItems` item's contribution toward multi-edit
 *  qualification: the full paths it names verbatim, and whether it ALSO
 *  names its own non-file identifier (old/new values are optional prose
 *  and never required — see `explicitMultiEditRequestPaths`'s own doc). */
/**
 * BLOCKER 54 (AB1, round 11): the full paths a span of query text names, by the
 * SAME curated recognizer `collectEditPathSignal` uses — never a second,
 * differently-spelled path matcher (the blast radius `FULL_PATH_TERM_RE`'s own
 * doc warns about).
 */
function fullPathTermsIn(text: string): string[] {
  return [...new Set([...text.matchAll(FULL_PATH_TERM_RE)].map((match) => match[0]))];
}

/**
 * FIXALL-A group F (2026-09-14) — AN ALTERNATIVE IS NOT AN AUTHORIZATION.
 *
 * `Update src/retry.ts or src/cache.ts to fix the timeout issue.` names two
 * files and asks for ONE of them to change; which one is a question only the
 * caller can answer, and until they do, neither file is an authorized write
 * target. Every one of the other lead rules here is about WHICH request a path
 * belongs to, and none of them can see a disjunction, so a clause like this used
 * to hand its edit lead to BOTH paths (the pack then certified an
 * `action:"edit"` obligation over `src/retry.ts` while its own decision was
 * still `await_input`/`choose-candidate` — a caller reading the contract would
 * see a live write grant for a target nothing had chosen yet).
 *
 * Purely STRUCTURAL, like `splitIntoLeadClauses`: two path mentions are
 * alternatives when the text BETWEEN them is nothing but an alternative
 * coordinator (optionally after a comma). No verb, no language heuristic, and
 * no effect on a path that is not coordinated with another path — a
 * conjunction (`and`, 「と」, 「、」 alone) is untouched, so TL142-02's "two
 * independent, fully-specified edits" registers keep both paths writable.
 *
 * The demotion is to `read`, never to "no row at all": a path with no lead row
 * is a path the write-authority veto never judges (BLOCKER 54's own finding),
 * and `read` is the lowest rank, so it holds the path down to read-only through
 * `record`'s rank merge while still being served as evidence.
 */
const ALTERNATIVE_COORDINATOR_RE = /^[\s、,]*(?:or|または|もしくは|あるいは|か)[\s、,]*$/iu;
export function alternativeCoordinatedPaths(text: string): Set<string> {
  const out = new Set<string>();
  const matches = [...text.matchAll(FULL_PATH_TERM_RE)];
  for (let i = 1; i < matches.length; i++) {
    const previous = matches[i - 1]!;
    const current = matches[i]!;
    const between = text.slice((previous.index ?? 0) + previous[0].length, current.index ?? 0);
    if (!ALTERNATIVE_COORDINATOR_RE.test(between)) continue;
    out.add(previous[0]);
    out.add(current[0]);
  }
  return out;
}

function collectEditPathSignal(item: RequestItem): { fullPaths: string[]; hasIdentifier: boolean } {
  const fullPaths = fullPathTermsIn(item.text);
  const hasIdentifier = item.terms.some((term) => !looksLikeFileTerm(term));
  return { fullPaths, hasIdentifier };
}

/** A named path's own governing lead: `"edit"`/`"read"` when ITS OWN item
 *  carries that verb explicitly; `"inherited-edit"` when its own item has
 *  neither signal but inherits "edit" from a neighbour (see
 *  `requestItemLeads`'s doc for the EN/JA inheritance-direction split).
 *  There is no `"inherited-read"`: an item with no explicit signal of its
 *  own and no inherited "edit" is conservatively `"read"` — a path is never
 *  promoted to a write target on the ABSENCE of proof. */
export type RequestItemLeadKind = "edit" | "read" | "inherited-edit";

export interface RequestItemLead {
  /** Verbatim full path, exactly as `FULL_PATH_TERM_RE` matched it in the
   *  query text (e.g. "src/cache.ts") — compare directly against a served
   *  surface's own `path`, never re-normalized. */
  path: string;
  lead: RequestItemLeadKind;
}

const REQUEST_ITEM_LEAD_RANK: Record<RequestItemLeadKind, number> = {
  read: 0,
  "inherited-edit": 1,
  edit: 2,
};

/**
 * Review round 4, r4-should-fix-26-propagation-route residual (2026-09-14):
 * `explicitMultiEditRequestPaths` used to be the ONLY place that knew a
 * named path's own per-item read/edit lead — so a query whose overall
 * ROUTING fell through to a different builder (readCodeTaskPack.ts's
 * `literalFirstRelation` / `buildPropagationTaskPack` / `buildSeededTaskPack`
 * chain, and from there `buildTaskChangeContract`'s writable-frontier /
 * change_contract minting) never consulted this file at all, and could
 * still hand an explain-only file write authority merely because its
 * basename or symbol also happened to appear in the query text.
 *
 * This is the single shared source of per-path lead truth: every builder
 * that mints a writable frontier or an `action:"edit"` obligation for a
 * query-NAMED path classifies that path through here — never by
 * re-deriving its own edit/read verb regex (`itemReadsAsEditLead`/
 * `itemReadsAsReadLead` stay the only two regexes that decide this).
 * `explicitMultiEditRequestPaths` itself is now a thin filter over this
 * function's own result (see below), so the two are provably consistent by
 * construction rather than two parallel implementations of one rule.
 *
 * Mirrors `explicitMultiEditRequestPaths`'s pre-existing per-item
 * resolution (own lead, then nearest-preceding, then nearest-following —
 * see that function's own doc for why EN and JA inherit in opposite
 * directions) exactly, but returns a classification for EVERY named path,
 * not only the ones that would qualify for edit: a path whose own item (and
 * whatever it inherits from) never carries an "edit" lead is reported
 * `"read"`, not omitted, so a caller can still serve it as evidence while
 * refusing it write authority — never silently dropping it instead.
 *
 * A path mentioned by more than one item (rare, but not impossible in a
 * longer query) keeps the HIGHEST-ranked classification seen across all of
 * its occurrences (edit > inherited-edit > read) — an explicit edit
 * elsewhere for the same path always wins over an incidental read mention,
 * mirroring `explicitMultiEditRequestPaths`'s own pre-existing
 * any-occurrence-qualifies semantics exactly (this refactor does not change
 * that function's return value for any previously-pinned case — verified
 * by inspection: "own edit" / "own read" / "inherited edit via preceding or
 * following" are the same three cases the old inline loop's `qualifies`
 * boolean recognized, just now named instead of collapsed to true/false).
 */
/**
 * Round 4 (2026-09-14, T4) — `splitEnumerated` (this file's own item-
 * boundary splitter) deliberately does NOT split on a bare sentence-ending
 * period/JA full stop (see its own doc: only commas/semicolons/newlines/JA
 * touten are item boundaries), so a two-sentence request with no comma
 * anywhere ("Explain X in a.ts. Change Y in b.ts.") fuses into ONE
 * `extractRequestItems` item covering BOTH files. Below, `requestItemLeads`
 * needs each file's OWN clause when an item like that names more than one —
 * otherwise one shared, item-wide lead gets applied to every file in it,
 * silently promoting/demoting whichever one didn't set that lead. This is a
 * purely STRUCTURAL re-split (no verb/language heuristic, no new lead-
 * detection regex, nothing that changes any item's own reported text or
 * boundaries) so `itemReadsAsEditLead`/`itemReadsAsReadLead`'s existing,
 * already-vetted regexes can be tested against the specific clause a given
 * path belongs to. ASCII "." only splits when followed by whitespace (so it
 * never fires inside a filename like "cache.ts" or a decimal); JA "。" splits
 * unconditionally (JA prose runs sentences together with no space).
 */
/**
 * AA1 (2026-09-14, review round 10): ONE clause splitter, now also recognizing a
 * semicolon and an explicit enumerating conjunction as boundaries, plus an
 * opt-in COORDINATOR split.
 *
 * WHY (findings 45/46/47/48, and 41/43/44 before them). Every round since 5 has
 * fixed an intent misclassification by widening or narrowing a lookaround inside
 * one regex, and every round the next reviewer found the next sentence that
 * lookaround reaches across. Finding 45 is the purest example: SHOULD-FIX 43's
 * WH-word lookbehind (`(?<!\b(?:which|what|...)\b[^.!?\n]{0,24})`) was measured
 * reaching 17 characters past the WH word -- straight across `, and `/`; then `
 * -- so `In src/retry.ts, explain what it does and set it to 5.` lost its
 * mutation signal entirely and answered read-only. The regex was asked a
 * question it cannot answer: "is this verb inside the same CLAUSE as that
 * WH-word?" No span limit can decide that, because clause length is unbounded.
 *
 * The fix is to stop asking. Callers split first and evaluate each clause on its
 * own, so a lookaround can only ever see text from the clause it is judging --
 * clause-locality by construction instead of by a calibrated distance.
 *
 * - `;` and `, and`/`, then`/`, also` are ENUMERATING boundaries: they separate
 *   independent requests in exactly the shapes these findings are about.
 * - `splitCoordinators` additionally splits a bare ` and `/` then `/` also `,
 *   for the INTENT predicates, where `Explain how it works and set it to 5.`
 *   carries two requests with no punctuation between them. It is opt-in because
 *   the LEAD-attribution caller (`requestItemLeads`) matches a path against a
 *   clause's text, and a coordinator split can separate a path from the verb
 *   that governs it inside one noun phrase.
 *
 * Still purely STRUCTURAL: no verb or language heuristic, no new lead-detection
 * regex, nothing that changes any item's own reported text or boundaries. ASCII
 * "." only splits when followed by whitespace (so it never fires inside a
 * filename like "cache.ts" or a decimal); JA "。" splits unconditionally (JA
 * prose runs sentences together with no space).
 */
/**
 * BLOCKER 54 (AB1, 2026-09-14, review round 11): `?` and `!` are clause
 * boundaries, in both widths.
 *
 * Round 10 measured `What does MAX_RETRIES do in src/retry.ts? Update the
 * changelog.` granting WRITE authority over `src/retry.ts` — the file the
 * read-only question merely asked about — while its `.` and `;` twins correctly
 * answered `[]`. `REQUESTED_MUTATION_EN_RE`'s own clause anchor already treats
 * `?` as a clause start, so the profile was right; nothing could VETO the
 * frontier, because this splitter saw ONE clause and derived no lead at all.
 *
 * ASCII `?`/`!` split only before whitespace, exactly like `.` (so `foo?.bar`
 * and `a!==b` are untouched); the fullwidth `？`/`！` split unconditionally,
 * exactly like `。`, because JA prose runs sentences together with no space.
 */
const LEAD_CLAUSE_BOUNDARY_RE = /(?<=[。？！])|(?<=[.?!])(?=\s)|(?<=;)|,\s+(?:and|then|also)\s+/u;
const LEAD_CLAUSE_COORDINATOR_RE = /\s+(?:and|then|also)\s+/u;

export function splitIntoLeadClauses(
  text: string,
  options?: { splitCoordinators?: boolean },
): string[] {
  const first = text.split(LEAD_CLAUSE_BOUNDARY_RE);
  const parts = options?.splitCoordinators === true
    ? first.flatMap((part) => part.split(LEAD_CLAUSE_COORDINATOR_RE))
    : first;
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * BLOCKER 34 (2026-09-14, review round 5; narrowed round 6) — the WHITELIST
 * `isLeadOnlyContinuation` (below) additionally requires before letting a
 * continuation item donate its own read/edit lead to a neighbouring item's
 * path. Anchored over the WHOLE (trimmed) item text, each pattern accepts:
 * an optional leading conjunction/politeness filler, the recognized
 * edit-or-read verb itself, and — as the clause's only possible "object" —
 * nothing but a bare NUMERIC literal and/or a bare pronoun ("it"/"them"/
 * "this"/"that", JA それ/これ/あれ). This is deliberately a whitelist of
 * known-safe shapes rather than a blacklist of known-unsafe words: a real
 * noun naming a different target ("the changelog", "docs", "ドキュメント")
 * is not on either list, fails both patterns, and is correctly judged to be
 * its own item.
 *
 * BLOCKER 34 (2026-09-14, review round 6) — round 5's own whitelist ALSO
 * accepted a quoted/backtick/JA `「...」` string as the clause's object, on
 * the reasoning that a quoted literal is "just a value", same as a bare
 * number. It is not: unlike a number, a quoted span can spell a FILENAME
 * (`… and update "notes.txt".` / `` … and update `docs/notes.txt`. `` /
 * `「notes.txt」に更新してください。`), and a filename like that falls
 * through BOTH of `isLeadOnlyContinuation`'s upstream gates —
 * `FULL_PATH_TERM_RE`'s curated extension whitelist has no `.txt` entry (so
 * `fullPaths` stays empty), and `hasIdentifier` explicitly excludes
 * anything `looksLikeFileTerm` recognizes (so a file-shaped term never
 * counts as "its own identifier" either — see the second, independent gate
 * added to `isLeadOnlyContinuation` itself, below). With neither upstream
 * gate objecting, the quoted-literal alternative here then wrongly
 * certified the continuation as object-free, donating `edit` onto the
 * preceding, explain-only path. A genuinely quoted VALUE
 * (`… and change it to "green".` / `` … and set it to `true`. ``) never
 * needed this alternative in the first place — `hasIdentifier` already
 * rejects those upstream, since the quoted literal becomes an `item.terms`
 * entry that is NOT file-shaped — so the quoted/backtick/「」 alternatives
 * are removed below with no loss for any real value continuation, pinned or
 * unpinned. Only the bare numeric literal and the bare pronoun remain.
 *
 * Reuses no new verb vocabulary — the verb alternations mirror
 * `EDIT_VERB_LEAD_RE`/`READ_VERB_LEAD_EN_RE`/`EDIT_VERB_JA_ROOT_RE`/
 * `READ_VERB_TRAILING_JA_RE` exactly (this function only ever runs on text
 * `ownLead[i]` already proved matches one of those), so it can never
 * broaden which verbs are recognized as edit/read leads — only whether a
 * TEXT that already carries one of those leads also carries an object.
 */
/*
 * SHOULD-FIX 64 (AC1, 2026-09-14, review round 12): the verb alternation is the
 * SHARED `MUTATION_VERBS_EN`, not the tier-1 lead set.
 *
 * This regex's own doc (above) states the invariant it must keep: it is a TRUE
 * MIRROR of the lead set, because it only ever runs on text that already proved
 * it carries a lead. Once `itemReadsAsEditLead` admits a tier-2 verb
 * (`… and then remove it.`), a mirror built from the tier-1 list would report
 * that clause as carrying an object of its own — so the clause would have an
 * `edit` lead it could never donate, and `Explain how MAX_RETRIES works in
 * src/retry.ts, and then remove it.` would leave the file the user asked to
 * change out of the frontier entirely (round 11 measured exactly that: the ONLY
 * writable entry was an unrelated `src/gc.ts`). Widening the alternation can
 * only ever affect a clause that is a verb plus a bare pronoun/value literal —
 * BLOCKER 34's attacks (`… and then update the changelog.`,
 * `… and also update "notes.txt".`) name a real object and still fail this test
 * on the object, not on the verb.
 */
const CONTINUATION_OBJECT_FREE_EN_RE = new RegExp(
  `^[\\s\\-*•]*(?:and|also|then|next|now|finally|,)?\\s*(?:please\\s+)?(?:${MUTATION_VERBS_EN}|explain|describe|tell\\s+me(?:\\s+about)?|clarify)\\b\\s*(?:it|them|this|that)?\\s*(?:to|with|into|about)?\\s*(?:[0-9]+(?:\\.[0-9]+)?|(?:to|with|into)\\s*["'\\x60](?:[0-9]+(?:\\.[0-9]+)?|true|false)["'\\x60])?\\s*(?:too|as\\s+well)?[.!?？！]?\\s*$`,
  "iu",
);
// SHOULD-FIX 41 (2026-09-14, review round 8): 設定/追加/削除 added to the
// EDIT-side group so this alternation is a TRUE mirror of
// `EDIT_VERB_JA_ROOT_RE` (line ~569) again -- round 8's own widening of that
// regex was not mirrored here, so a continuation ending "...5 に設定して
// ください。" had `ownLead[i] === "edit"` (from the now-widened ROOT_RE) but
// this gate still said the continuation named an object of its own, so it
// could never donate. The READ-side group (説明/確認/教え/述べ/調べ/読み/
// 読んで, mirroring `READ_VERB_TRAILING_JA_RE`) is unchanged.
/**
 * FIXALL-A group A (2026-09-14) — DERIVED, and it can now spell a PRONOUN AND a
 * VALUE in the same clause.
 *
 * Two changes, both required by this regex's own stated invariant (a TRUE
 * MIRROR of the JA lead set):
 *
 *  - The verb alternation and the しろ/せよ imperative now come from the ONE
 *    vocabulary (`EDIT_VERB_JA_ROOTS` / `READ_VERB_JA_*_ROOTS` /
 *    `EDIT_VERB_JA_INFLECTIONS`) rather than a fourth hand-copied spelling of
 *    it. Round 8 already had to repair this same mirror by hand once (see the
 *    SHOULD-FIX 41 note above); it is derived now so it cannot drift again.
 *  - The object slot accepts a pronoun followed by を/は and THEN a value —
 *    「それを 5 に置換してください。」, the byte-for-byte JA twin of the EN
 *    `change it to 5.` this whitelist was built around. The old alternation
 *    could spell the pronoun OR the value but never both in sequence, so the
 *    commonest JA continuation register named "an object of its own" and could
 *    not donate: 「src/retry.ts の MAX_RETRIES の役割を説明し、それを 5 に置換して
 *    ください。」 left the file the caller asked to change read-only.
 *
 * Still a whitelist of known-safe shapes, and still refuses a real noun: BLOCKER
 * 34's own JA attack 「変更履歴を更新してください。」 fails it (変更履歴 is neither a
 * pronoun nor a numeric literal, and the 変更 prefix cannot reach the required
 * clause end through the 履歴 that follows it).
 */
const CONTINUATION_OBJECT_FREE_JA_VERBS = [
  ...EDIT_VERB_JA_ROOTS,
  ...READ_VERB_JA_SURU_ROOTS,
  ...READ_VERB_JA_STEM_ROOTS,
  "読み", "読んで",
].join("|");
const CONTINUATION_OBJECT_FREE_JA_RE = new RegExp(
  "^[\\s、,]*"
  // optional pronoun, optionally followed by a topic/object particle
  + "(?:(?:それ|これ|あれ)\\s*(?:を|は)?\\s*)?"
  // optional numeric literal. A BARE numeral may stand alone (「5 に変更」 and the
  // particle-less 「5変更」 both read as values); a QUOTED/BRACKETED one must be
  // followed by に/へ/と, which is SHOULD-FIX 39's own round-7 regression guard
  // — without it 「「5」更新してください。」 (a quoted digit standing in for a
  // FILENAME, no particle anywhere) reads as object-free and donates. Pinned in
  // requestItems.spec.ts as "the JA analogue ... must still stay read".
  + "(?:[0-9]+(?:\\.[0-9]+)?|[「\"'\x60][0-9]+(?:\\.[0-9]+)?[」\"'\x60]\\s*(?:に|へ|と))?"
  + "\\s*(?:に|へ|と)?\\s*"
  + `(?:${CONTINUATION_OBJECT_FREE_JA_VERBS})(?:${EDIT_VERB_JA_INFLECTIONS})?`
  + "(?:ください|下さい)?[。.]?\\s*$",
  "u",
);

function continuationDonatesNoObjectOfItsOwn(text: string): boolean {
  // BLOCKER 61 (AC1, 2026-09-14, review round 12): the leading-filler
  // alternation above (`and|also|then|next|now|finally|,`) was a THIRD,
  // hand-maintained spelling of the discourse-adverb vocabulary
  // `DISCOURSE_LEAD_RE` already owns, and it was missing `subsequently` /
  // `after that` / `afterwards`. Measured consequence: `Explain how MAX_RETRIES
  // works in src/retry.ts, and subsequently set it to 5.` had an `edit` lead
  // (the lead test DOES strip discourse adverbs) that could never be donated,
  // so the file the user asked to change stayed read-only while an unrelated
  // `src/http.ts` was the only writable frontier entry. Strip the SAME two
  // prefix registers the lead tests strip — politeness and discourse — before
  // asking; the locative is deliberately NOT stripped here, because a clause
  // naming its own file is exactly what this gate must refuse.
  const trimmed = stripPolitenessLead(text.trim())
    .replace(DISCOURSE_LEAD_RE, "")
    .replace(DISCOURSE_LEAD_JA_RE, "")
    .trim();
  return CONTINUATION_OBJECT_FREE_EN_RE.test(trimmed) || CONTINUATION_OBJECT_FREE_JA_RE.test(trimmed);
}

/**
 * BLOCKER 61 (AC1, 2026-09-14, review round 12) — A VALUE-ONLY CLAUSE MINTS NO
 * LOCATOR TOKEN.
 *
 * Round 11 measured an `act.edit` certificate marking WRITABLE a file the query
 * never names, and the write landing on disk: for `Explain how MAX_RETRIES works
 * in src/retry.ts, and then set it to 5.` the locator extracted `set` as a query
 * IDENTIFIER, its symbol search matched `SET_COOKIE` in an unrelated
 * `src/http.ts`, and that surface was admitted (`why:"symbol hit for unknown"`)
 * and then marked writable. The same mechanism produced `src/audit.ts`
 * (`update` → `UPDATE_MODE`), `src/ttl.ts` (`change` → `CHANGE_WINDOW_MS`) and —
 * as the ONLY writable entry, with the file the user asked to change absent —
 * `src/gc.ts` (`remove` → `REMOVE_AFTER_MS`).
 *
 * The edit VERB is not a symbol. A clause that carries a read/edit lead of its
 * own AND is object-free by BLOCKER 34's already-pinned whitelist consists of
 * exactly that verb, an optional pronoun, and an optional bare value literal —
 * by construction it names NOTHING a locator could look for, so its span
 * contributes no identifier tokens. Returns `query` with those spans blanked
 * (same length, so nothing else in the string moves), for the locator's
 * identifier/symbol-token minting ONLY: every clause a caller can actually
 * address survives verbatim, and the request's own target keeps coming from the
 * PRECEDING clause's explicit path/identifier exactly as before.
 *
 * Deliberately reuses `itemReadsAsEditLead`/`itemReadsAsReadLead`/
 * `continuationDonatesNoObjectOfItsOwn` rather than minting a fourth verb
 * vocabulary — this function can never recognize a verb the lead tests do not.
 */
export function stripValueOnlyLeadClauses(query: string): string {
  let out = query;
  for (const clause of splitIntoLeadClauses(query, { splitCoordinators: true })) {
    const trimmed = clause.trim();
    if (trimmed.length === 0) continue;
    if (!itemReadsAsEditLead(trimmed) && !itemReadsAsReadLead(trimmed)) continue;
    if (!continuationDonatesNoObjectOfItsOwn(trimmed)) continue;
    const at = out.indexOf(trimmed);
    if (at < 0) continue;
    out = out.slice(0, at) + " ".repeat(trimmed.length) + out.slice(at + trimmed.length);
  }
  return out;
}

/**
 * FIXALL-A group E (2026-09-14) — THE IMPERATIVE VERB IS NOT A SYMBOL, EVEN WHEN
 * ITS CLAUSE NAMES AN OBJECT.
 *
 * `stripValueOnlyLeadClauses` above blanks a clause that names NOTHING BUT a
 * verb, which was BLOCKER 61's measured shape. The verb is no more a symbol when
 * the clause DOES name an object, and leaving it tokenizable is still a live
 * leak — measured on this matrix's own noun-phrase register:
 *
 *     `Replace the changelog?`  -> act.edit, frontier [CHANGELOG.md]
 *     `Create the changelog.`   -> act.edit, frontier [CHANGELOG.md]
 *     `Update the changelog.`   -> await_input, the only candidate src/audit.ts
 *
 * Three identical sentences; the third one loses its target because `update`
 * matched `UPDATE_MODE` in an unrelated file and that collision outranked the
 * basename match for the noun the caller actually wrote. The object was right
 * there in the clause the whole time.
 *
 * This blanks ONLY the leading verb token itself — the clause's object, its
 * file mentions and its quoted spans all survive verbatim — and only for a
 * clause whose lead the shared tests already recognize, so it can never blank a
 * word the lead vocabulary does not contain. A mid-clause occurrence is
 * untouched (`Explain how update() is called` keeps `update`), and so is a
 * quoted one, because the strip is anchored at the clause's own start after the
 * same politeness/discourse/locative prefixes the lead tests strip.
 *
 * Same length out, like its sibling above, so a caller holding character
 * offsets into the query (`salientWords`' quoted spans) stays aligned.
 */
// MUTATION verbs only, deliberately. The READ leads (explain/describe/clarify)
// were in this alternation for one draft and are not: they carry no symbol-
// collision risk of their own (`salientWords`' own STOPWORDS already drops
// them), and blanking them measurably NARROWED an ordinary
// `Explain how X uses Y in <file>.` pack from two ranked surfaces to one
// (`handsOnReport0142.characterization`'s SHOULD-FIX 37(b) repro, whose
// candidate-list precondition that recall is). Recall on a read request is not
// this fix's problem to solve; the `update`/`UPDATE_MODE` collision is.
const LEAD_VERB_TOKEN_RE = new RegExp(
  `^([\\s\\-*•]*)((?:${MUTATION_VERBS_EN})\\b(?!-))`,
  "iu",
);
export function stripLeadVerbTokens(query: string): string {
  let out = query;
  for (const clause of splitIntoLeadClauses(query, { splitCoordinators: true })) {
    const trimmed = clause.trim();
    if (trimmed.length === 0) continue;
    if (!itemReadsAsEditLead(trimmed) && !itemReadsAsReadLead(trimmed)) continue;
    // ...and only when the clause names NO code-shaped identifier of its own.
    //
    // That is the whole defect: a clause whose object is a plain NOUN PHRASE
    // (`Update the changelog.`) gives a symbol search nothing but the verb to
    // latch onto, so it latches onto the wrong file. A clause that DOES name an
    // identifier (`Change DEFAULT_TIMEOUT_MS from 3000 to 5000`) has a real
    // anchor, the verb is noise the ranking already handles — and removing it
    // measurably COSTS recall: that exact query's admission degrades from a
    // seeded `caller-supplied` surface to a bare `symbol hit`, and the pack
    // stops reaching act.edit (`explorationContinuation.characterization` R5).
    if (clauseNamesOwnValueIdentifier(trimmed)) continue;
    // The lead tests strip politeness/discourse/locative prefixes before
    // matching; find the verb in the SAME stripped view, then map back to the
    // clause's own offsets by measuring how much the strip removed.
    const stripped = stripLeadPrefixes(trimmed);
    const prefixLength = trimmed.length - stripped.length;
    if (prefixLength < 0) continue;
    const match = LEAD_VERB_TOKEN_RE.exec(stripped);
    if (match === null) continue;
    const at = out.indexOf(trimmed);
    if (at < 0) continue;
    const verbStart = at + prefixLength + match[1]!.length;
    const verbEnd = verbStart + match[2]!.length;
    out = out.slice(0, verbStart) + " ".repeat(verbEnd - verbStart) + out.slice(verbEnd);
  }
  return out;
}

export function requestItemLeads(query: string, index?: RequestItemIndexView): RequestItemLead[] {
  const items = extractRequestItems(query, index);
  const ownLead: Array<"edit" | "read" | undefined> = items.map((item) => (
    itemReadsAsEditLead(item.text) ? "edit" : itemReadsAsReadLead(item.text) ? "read" : undefined
  ));
  const precedingExplicit: Array<"edit" | "read" | undefined> = [];
  {
    let running: "edit" | "read" | undefined;
    for (const lead of ownLead) {
      precedingExplicit.push(running);
      if (lead !== undefined) running = lead;
    }
  }
  const followingExplicit: Array<"edit" | "read" | undefined> = new Array(ownLead.length);
  {
    let running: "edit" | "read" | undefined;
    for (let i = ownLead.length - 1; i >= 0; i--) {
      followingExplicit[i] = running;
      if (ownLead[i] !== undefined) running = ownLead[i];
    }
  }
  const byPath = new Map<string, RequestItemLeadKind>();
  // FIXALL-A group F (2026-09-14): paths the query offers as ALTERNATIVES to one
  // another. Computed once over the whole query text, since a disjunction is a
  // property of the mention, not of whichever item/clause pass happens to reach
  // it first. See `alternativeCoordinatedPaths`.
  const alternatives = alternativeCoordinatedPaths(query);
  const record = (
    candidatePath: string,
    own: "edit" | "read" | undefined,
    effective: "edit" | "read" | undefined,
  ): void => {
    const kind: RequestItemLeadKind = alternatives.has(candidatePath)
      ? "read"
      : own === "edit"
        ? "edit"
        : own === "read"
          ? "read"
          : effective === "edit"
            ? "inherited-edit"
            : "read";
    const existing = byPath.get(candidatePath);
    if (existing === undefined || REQUEST_ITEM_LEAD_RANK[kind] > REQUEST_ITEM_LEAD_RANK[existing]) {
      byPath.set(candidatePath, kind);
    }
  };
  /**
   * SHOULD-FIX 31 (2026-09-14, review round 5): does item `i` name NEITHER a
   * full path NOR an identifier of its own, while still carrying an explicit
   * own read/edit lead? JA's elliptical continuative
   * ("…の役割を説明し、5に変更してください。") never repeats the file path or
   * the identifier in its second clause — `extractRequestItems` still splits
   * it into its OWN item (the JA touten is an item boundary there, unlike
   * `splitIntoLeadClauses` below, which only splits within one item's text
   * on a sentence-final `.`/`。`) — so this item can never be a match inside
   * `clauses` below. A pure filler item ("Thanks.") has no own lead at all
   * (`ownLead[i] === undefined`) and is correctly excluded; an item that DOES
   * name its own path or identifier is handled by the ordinary branches
   * below and excluded here so it is never double-attributed.
   *
   * BLOCKER 34 (2026-09-14, review round 5): "no full path, no identifier"
   * proves the continuation names no CODE-shaped object — it does NOT prove
   * the continuation names no object at all. `collectEditPathSignal`'s two
   * tests (`FULL_PATH_TERM_RE`, `item.terms`) only ever recognize
   * code-shaped tokens (file paths, dotted keys, camelCase, CONST_CASE), so
   * a plain noun phrase — "update the changelog.", "ドキュメントを更新して
   * ください。" — is neither, and was wrongly treated as if it named
   * nothing, donating its OWN edit lead onto the PRECEDING item's path
   * ("Explain how MAX_RETRIES works in src/retry.ts, and update the
   * changelog." must never make src/retry.ts writable — the changelog, not
   * retry.ts, is that clause's own target). `continuationDonatesNoObjectOfItsOwn`
   * below is the additional gate: a continuation may only donate when what
   * is LEFT, once every recognized function word and the recognized verb
   * itself are accounted for, is nothing but a bare value literal or a bare
   * pronoun — exactly "change it to 5."/"5 に変更してください。" (the Rule's
   * own two examples). A real noun survives that whitelist test and the
   * continuation is judged to be its own item, donating nothing.
   */
  /**
   * SHOULD-FIX 39 (2026-09-14, review round 7/8): a term this gate must
   * treat as a bare VALUE, never as "an identifier of its own" — a NUMERIC
   * literal (`5`, `12`, `1.5`) or the closed boolean vocabulary (`true`,
   * `false`). This matters only once the term is QUOTED and 2+ characters:
   * `QUOTED_RE`'s own `{2,}` minimum means a 1-char quoted value (`"5"`)
   * never becomes an `item.terms` entry at all (no term extracted, nothing
   * for `hasIdentifier` to react to), but a 2+-char one (`"12"`, `` `true` ``)
   * is captured into `pushTopic`'s `terms.all` like any other quoted span,
   * and `looksLikeFileTerm` correctly does not recognize it as a file
   * either — so the SHARED `hasIdentifier` signal below blocked a genuinely
   * bare value indistinguishably from a real noun ("the changelog"). Kept
   * local to this one gate (never widening `collectEditPathSignal` itself,
   * whose `hasIdentifier` is also read by TL142-02's "N independent named
   * edits" recognizer just below, which deliberately counts a quoted
   * literal as evidence of a second named target — a different question
   * this finding must not disturb).
   */
  const BARE_VALUE_TERM_RE = /^(?:[0-9]+(?:\.[0-9]+)?|true|false)$/iu;
  const isLeadOnlyContinuation = (i: number): boolean => {
    if (i < 0 || i >= items.length || ownLead[i] === undefined) return false;
    const signal = collectEditPathSignal(items[i]!);
    if (signal.fullPaths.length !== 0) return false;
    // SHOULD-FIX 39: do not let `hasIdentifier` veto SOLELY because the
    // continuation's only non-file term is a bare numeric/boolean value
    // literal (see BARE_VALUE_TERM_RE above) -- any OTHER non-file term
    // still vetoes here exactly as `hasIdentifier` alone used to.
    if (
      signal.hasIdentifier
      && items[i]!.terms.some((term) => !looksLikeFileTerm(term) && !BARE_VALUE_TERM_RE.test(term))
    ) return false;
    // BLOCKER 34 (2026-09-14, review round 6) — `hasIdentifier` above
    // deliberately treats anything `looksLikeFileTerm` recognizes as NOT a
    // value identifier (a file is not a value), and `fullPaths` only
    // recognizes `FULL_PATH_TERM_RE`'s own curated extension whitelist — so
    // a term like "notes.txt" (quoted, backticked, or JA-bracketed in the
    // query text) satisfied NEITHER test and was wrongly treated as if the
    // continuation named no object at all. `looksLikeFileTerm` and
    // `FULL_PATH_TERM_RE` must agree that such a term IS an object of this
    // continuation's own — checked directly here (never by widening
    // `FULL_PATH_TERM_RE` itself, which also feeds
    // `explicitMultiEditRequestPaths` and every other path-shaped
    // recognizer in this file — a far larger blast radius for the same
    // fix).
    if (items[i]!.terms.some((term) => looksLikeFileTerm(term))) return false;
    return continuationDonatesNoObjectOfItsOwn(items[i]!.text);
  };
  /**
   * SHOULD-FIX 64 (AC1, 2026-09-14, review round 12) — RESTATING THE OBJECT IS
   * NOT NAMING A NEW ONE.
   *
   * `isLeadOnlyContinuation` admits only an OBJECT-FREE continuation (`set it to
   * 5.`), so round 11 measured the pronoun form reaching `act.edit` with
   * `src/retry.ts` writable while the byte-for-byte equivalent that SPELLS the
   * symbol — `Explain how MAX_RETRIES works in src/retry.ts, and then set
   * MAX_RETRIES to 5.` — answered `await_input` with an empty frontier. Being
   * MORE explicit made the request less actionable, which is backwards.
   *
   * `clauseLeadRows`'s own `mayDonateEdit` already treats "names a value
   * identifier of its own" as donatable for a clause INSIDE one item; this is the
   * ITEM-adjacent case, and it is deliberately NARROWER than that rule: every
   * non-file, non-value term of the continuation must be a term the neighbouring
   * item ALREADY names. So `set MAX_RETRIES to 5.` beside a clause about
   * `MAX_RETRIES` in `src/retry.ts` donates; `update DEFAULT_TTL_MS.` (a
   * different object, no file) does not, and neither does anything BLOCKER 34
   * blocks — `update the changelog.` has no identifier at all, and
   * `update "notes.txt".` names a file term, which is refused outright here for
   * the same round-6 reason `isLeadOnlyContinuation` refuses it.
   */
  const continuationRestatesThisItemsObject = (selfIndex: number, otherIndex: number): boolean => {
    if (otherIndex < 0 || otherIndex >= items.length) return false;
    if (ownLead[otherIndex] === undefined) return false;
    const other = items[otherIndex]!;
    // A continuation naming its own path (or any file-shaped term) has its own
    // target and donates nothing — the round-6 attack, refused identically.
    if (collectEditPathSignal(other).fullPaths.length !== 0) return false;
    if (other.terms.some((term) => looksLikeFileTerm(term))) return false;
    const objects = other.terms
      .filter((term) => !looksLikeFileTerm(term) && !BARE_VALUE_TERM_RE.test(term));
    // No object at all is `isLeadOnlyContinuation`'s own case, decided there.
    if (objects.length === 0) return false;
    const mine = new Set(items[selfIndex]!.terms.map((term) => term.toLowerCase()));
    return objects.every((term) => mine.has(term.toLowerCase()));
  };
  /**
   * AA1 (2026-09-14, review round 10): ONE clause-local lead reader, shared by
   * both attribution branches below.
   *
   * `lead` is the clause's OWN explicit read/edit lead (the same two recognizers
   * the item-wide `ownLead` uses, applied to the clause instead of the item).
   * `objectFree` is BLOCKER 34's own whitelist, applied to the clause: once every
   * recognized function word and the recognized verb are accounted for, is
   * nothing left but a bare value literal or a bare pronoun? That is the gate
   * that lets `set it to 5.` donate an edit lead to a file named in a NEIGHBOURING
   * clause while `update the changelog.` — whose own target is the changelog —
   * cannot. Without it, making leads clause-local would re-open BLOCKER 34 in a
   * new shape (`In src/retry.ts, explain what it does and update the changelog.`
   * would hand src/retry.ts write authority).
   */
  const clauseLeadRows = (text: string): Array<{
    clause: string;
    lead: "edit" | "read" | undefined;
    /** May this clause's EDIT lead be attributed to a file some OTHER clause named? */
    mayDonateEdit: boolean;
    /**
     * FIXALL-A group A(b) (2026-09-14): the two INDEPENDENT reasons
     * `mayDonateEdit` can be true, kept apart so a donation can be judged
     * against the file it is actually being donated TO (see `mayDonateEditTo`).
     */
    objectFree: boolean;
    /** Non-file VALUE identifiers this clause names of its own. */
    ownIdentifiers: string[];
  }> => splitIntoLeadClauses(text, { splitCoordinators: true }).map((clause) => {
    const terms = extractTerms(clause);
    // BLOCKER 34's two facts, asked of the CLAUSE: is there nothing left but a
    // bare value/pronoun (`set it to 5.`), or does the clause name a VALUE
    // IDENTIFIER of its own that the carried file would hold (`set MAX_RETRIES
    // to 5.`)? A plain noun phrase ("the changelog", "the docs",
    // 「ドキュメント」) is NEITHER -- and a FILE-shaped term (`"notes.txt"`,
    // `styles.css`) is the round-6 attack, so any clause naming one donates
    // nothing, whatever else it contains.
    const namesOwnFile = [...terms.all].some((term) => looksLikeFileTerm(term));
    const ownIdentifiers = [...terms.identifiers].filter((term) => !looksLikeFileTerm(term));
    const objectFree = continuationDonatesNoObjectOfItsOwn(clause);
    return {
      clause,
      lead: itemReadsAsEditLead(clause) ? "edit" as const : itemReadsAsReadLead(clause) ? "read" as const : undefined,
      mayDonateEdit: !namesOwnFile && (objectFree || ownIdentifiers.length > 0),
      objectFree: !namesOwnFile && objectFree,
      ownIdentifiers: namesOwnFile ? [] : ownIdentifiers,
    };
  });
  /**
   * FIXALL-A group A(b) (2026-09-14) — RESTATING AN OBJECT IS NOT NAMING A NEW
   * ONE, asked of a CLAUSE.
   *
   * `mayDonateEdit`'s `namesIdentifier` half donated a clause's edit lead to
   * ANY other path in the host text merely because that clause named SOME
   * identifier — it never checked whose file the identifier belonged to. So
   * `Tell me about how DEFAULT_TTL_MS works in src/cache.ts. The changelog.
   * Bump MAX_RETRIES to 5.` handed WRITE authority over the explain-only
   * `src/cache.ts` to a clause about `MAX_RETRIES`: the same over-broad
   * attribution class BLOCKER 61 named for the VERB-as-symbol mechanism, one
   * layer up (a real identifier donating to the wrong file, rather than a bare
   * verb minting a fake one).
   *
   * The ITEM-adjacent case already had the right rule
   * (`continuationRestatesThisItemsObject`, SHOULD-FIX 64): every non-file,
   * non-value term of the donor must be a term the RECEIVING text already
   * names. This is that same rule, asked of the clause — so
   * `Explain how MAX_RETRIES works in src/retry.ts and then set MAX_RETRIES to
   * 5.` still donates (the receiving clause names MAX_RETRIES), while the
   * cross-object shapes above no longer can.
   *
   * The OBJECT-FREE half is unchanged and still unconditional: a clause that is
   * nothing but a verb and a pronoun/value (`set it to 5.`) has no object of
   * its own to compare, and the only file it can be about is the one a
   * neighbouring clause named — that is BLOCKER 34's own already-pinned
   * whitelist and AA1's donation rule, both untouched.
   */
  const mayDonateEditTo = (
    row: { objectFree: boolean; ownIdentifiers: string[] },
    path: string,
    hostText: string,
  ): boolean => {
    if (row.objectFree) return true;
    if (row.ownIdentifiers.length === 0) return false;
    const receiving = new Set<string>();
    for (const clause of splitIntoLeadClauses(hostText, { splitCoordinators: true })) {
      if (!clause.includes(path)) continue;
      for (const term of extractTerms(clause).all) receiving.add(term.toLowerCase());
    }
    if (receiving.size === 0) return false;
    return row.ownIdentifiers.every((term) => receiving.has(term.toLowerCase()));
  };
  // Mirrors `explicitMultiEditRequestPaths`'s own SHOULD-FIX 6 carry-forward
  // (a lead-in clause naming ONLY the file pairs with the very next
  // identifier-only item) — see that function's own doc.
  let carryFiles: string[] | undefined;
  /** The text `carryFiles` was carried FROM — the receiving side a donation is judged against (`mayDonateEditTo`). */
  let carryText = "";
  items.forEach((item, i) => {
    const { fullPaths, hasIdentifier } = collectEditPathSignal(item);
    const effectiveLead = ownLead[i] ?? precedingExplicit[i] ?? followingExplicit[i];
    /**
     * FIXALL-A group A(a) (2026-09-14) — `hasIdentifier` GATES DONATION, NOT
     * SELF-CLAIM.
     *
     * `collectEditPathSignal`'s `hasIdentifier` asks whether the item names a
     * separate, non-file identifier. That is the right question for the
     * carry-forward donor role this branch's `else` treats an item as ("in
     * src/retry.ts," — a location with no request of its own, whose lead has to
     * come from a neighbour). It is the WRONG question for an item that is
     * already a complete request about the file it names: `change src/retry.ts.`,
     * `"src/retry.ts" に追加してください。`, `src/retry.ts に改名しろ。` all have an
     * explicit own lead and no identifier, so every one of them was routed to
     * carry-forward and never recorded a lead for its own path at all — dropped
     * outright when nothing followed to consume the carry.
     *
     * So the gate is now "names a path AND (names an identifier OR carries an
     * explicit lead of its own)". An item with a lead but no identifier still
     * ALSO donates its file forward (`carryFiles` below is not cleared for it),
     * so `Explain src/retry.ts, and change it to 5.` keeps working exactly as
     * before: the item records its own `read`, and the following object-free
     * continuation still upgrades the same path to `edit` through `record`'s
     * rank merge.
     *
     * The self-claim requires the item to name exactly ONE path, which is the
     * DIRECTED-RELATION carve-out `explicitMultiEditRequestPaths`'s own doc
     * already names: `Rename src/old.ts to src/new.ts` is one relation with a
     * source and a destination, not two independent edit targets, and it has no
     * identifier to tell them apart — so it stays on the carry-forward path it
     * has always taken. Every item this fix is about (`change src/retry.ts.`,
     * `"src/retry.ts" に追加してください。`) names exactly one.
     */
    const claimsItsOwnPath = hasIdentifier || (fullPaths.length === 1 && ownLead[i] !== undefined);
    if (fullPaths.length > 0 && claimsItsOwnPath) {
      // SHOULD-FIX 31 (2026-09-14, review round 5): split whenever the
      // item's own text yields >=2 clauses — NOT only when it names >1
      // DISTINCT path (round 4/T4's own gate). The old `fullPaths.length > 1`
      // gate missed the exact shape this finding is about: ONE path named by
      // BOTH a read clause and an edit clause of the SAME item ("Explain how
      // MAX_RETRIES works in src/retry.ts. Change MAX_RETRIES in
      // src/retry.ts to 5.") — `collectEditPathSignal`'s own `Set` collapses
      // the twice-repeated path to ONE `fullPaths` entry, so the old `>1`
      // test never even ran and the item's lead-in verb ("Explain") silently
      // decided the whole item, vetoing the very edit it also names. Every
      // other case (a single path, or a split that doesn't separate distinct
      // clauses) is unaffected: `clauses.length` is 1 and the code below
      // falls back to the pre-existing `ownLead[i]`/`effectiveLead` exactly
      // as before this round.
      const clauses = splitIntoLeadClauses(item.text);
      // A directly-adjacent lead-only continuation (JA's elliptical
      // "…5に変更してください。", which names no path of its own — see
      // `isLeadOnlyContinuation` above) can never appear in `clauses`, so its
      // lead is pulled in from the neighbouring ITEM instead, same rank-merge.
      const neighborLeads: Array<"edit" | "read"> = [];
      if (isLeadOnlyContinuation(i - 1) || continuationRestatesThisItemsObject(i, i - 1)) {
        neighborLeads.push(ownLead[i - 1]!);
      }
      if (isLeadOnlyContinuation(i + 1) || continuationRestatesThisItemsObject(i, i + 1)) {
        neighborLeads.push(ownLead[i + 1]!);
      }
      for (const path of fullPaths) {
        const matchingClauses = clauses.length > 1
          ? clauses.filter((candidate) => candidate.includes(path))
          : [];
        // BLOCKER 54 (AB1, round 11): an item-wide lead is the lead of SOME
        // clause, and inheriting it for a clause that has none of its own is how
        // a tail-anchored JA edit imperative reached the file a QUESTION clause
        // named: 「src/retry.ts の MAX_RETRIES は何をしますか？changelog を更新して
        // ください。」 -> `EDIT_VERB_JA_ROOT_RE` matches the item's TAIL, the
        // question clause has no lead of its own, and src/retry.ts became
        // writable. An inherited EDIT now needs the same BLOCKER 34 gate a
        // donated one does; an inherited READ is unaffected (read is the lowest
        // rank and can only ever veto).
        const itemClauseRows = clauseLeadRows(item.text);
        // FIXALL-A group A(b): judged against THIS path, not "some identifier
        // somewhere in the item" — see `mayDonateEditTo`.
        const donatableEdit = itemClauseRows.some(
          (row) => row.lead === "edit" && mayDonateEditTo(row, path, item.text),
        );
        const inheritedOwn = ownLead[i] === "edit" && !donatableEdit ? undefined : ownLead[i];
        const inheritedEffective = effectiveLead === "edit" && !donatableEdit ? undefined : effectiveLead;
        if (matchingClauses.length > 0) {
          // Rank-merge across EVERY clause naming this path (edit >
          // inherited-edit > read), not only the first: `record`'s own
          // byPath comparison already keeps the highest-ranked kind seen,
          // so calling it once per matching clause lets a later, stronger
          // clause upgrade an earlier, weaker one (order does not matter).
          for (const clause of matchingClauses) {
            const clauseOwnLead = itemReadsAsEditLead(clause)
              ? "edit"
              : itemReadsAsReadLead(clause) ? "read" : undefined;
            record(path, clauseOwnLead ?? inheritedOwn, clauseOwnLead ?? inheritedEffective);
          }
        } else {
          record(path, ownLead[i], effectiveLead);
        }
        // AA1 (2026-09-14, round 10): an object-free lead clause of this SAME
        // item donates too, exactly like an adjacent lead-only ITEM does
        // (`neighborLeads` below). `extractRequestItems` splits on a comma, so
        // "Explain how MAX_RETRIES works in src/retry.ts, and set it to 5."
        // already arrived as two items and worked; the byte-identical sentence
        // WITHOUT the comma arrived as ONE item whose item-wide lead is "read"
        // ("Explain..."), so the edit half was silently vetoed. Clause-local,
        // and gated by BLOCKER 34's own object-free whitelist, so
        // "...and update the changelog." still donates nothing.
        for (const row of clauseLeadRows(item.text)) {
          if (row.lead !== "edit") continue;
          if (row.clause.includes(path)) continue;
          // FIXALL-A group A(b): donate to THIS path only when the clause is
          // object-free, or when the clause(s) naming this path already restate
          // every identifier the donor names — see `mayDonateEditTo`.
          if (!mayDonateEditTo(row, path, item.text)) continue;
          record(path, row.lead, row.lead);
        }
        for (const lead of neighborLeads) record(path, lead, lead);
      }
      // FIXALL-A group A(a): an item that claimed its own paths WITHOUT naming
      // an identifier is still the same kind of donor the `else` branch below
      // treats it as — it just also has a lead of its own now. Keep carrying it,
      // so an object-free continuation (`, and change it to 5.`) can still
      // upgrade the same path through `record`'s rank merge.
      carryFiles = hasIdentifier ? undefined : fullPaths;
      carryText = item.text;
      return;
    }
    if (fullPaths.length > 0) {
      carryFiles = fullPaths;
      carryText = item.text;
      return;
    }
    if (carryFiles !== undefined) {
      // AA1 (2026-09-14, review round 10): CLAUSE-LOCAL carry-forward. Round 9's
      // finding 45 expected `In src/retry.ts, explain what it does and set it to
      // 5.` to offer the edit route; it reached `discover` with an EMPTY frontier
      // because this branch applied the item's ONE item-wide lead — "read", from
      // the leading "explain" — to the carried file, and because `hasIdentifier`
      // vetoed the whole attribution for a sentence whose only "value" is the
      // bare numeral 5 (`QUOTED_RE`'s 2-character minimum means a bare 5 never
      // becomes a term). Both are the same mistake: a lead read across a clause
      // boundary.
      //
      // Now each clause is read on its own, and a clause may claim the carried
      // file when EITHER the item names an identifier (the pre-existing gate,
      // unchanged in strength) OR the clause is object-free by BLOCKER 34's own
      // whitelist — a clause whose entire content is a recognized verb plus a
      // bare value/pronoun has no target of its own, so the only file it can be
      // about is the one the preceding clause named. `record`'s rank merge then
      // lets the edit clause outrank the read clause for that path.
      // A READ clause may always be attributed (read is the LOWEST rank, so it
      // can never promote a path to a write target); an EDIT clause needs
      // `mayDonateEdit` -- BLOCKER 34's gate, asked of the clause.
      // FIXALL-A group A(b): the EDIT half is judged per carried path against
      // the text the path was carried FROM (`carryText`), so a clause naming an
      // identifier the donor file's own clause never mentions donates nothing.
      const clauseRows = clauseLeadRows(item.text);
      const readRows = clauseRows.filter((row) => row.lead === "read");
      let recorded = false;
      for (const path of carryFiles) {
        const rows = clauseRows.filter((row) => (
          row.lead === "read"
          || (row.lead === "edit" && mayDonateEditTo(row, path, carryText))
        ));
        if (rows.length === 0) continue;
        recorded = true;
        for (const row of rows) record(path, row.lead, row.lead);
      }
      if (!recorded && readRows.length === 0 && hasIdentifier) {
        for (const path of carryFiles) record(path, ownLead[i], effectiveLead);
      }
    }
    carryFiles = undefined;
    carryText = "";
  });
  /**
   * BLOCKER 54 (AB1, 2026-09-14, review round 11) — A PATH THE QUERY NAMES
   * ALWAYS GETS A LEAD ROW.
   *
   * The frontier's writability veto lives in this function's output, so a path
   * with NO row here is a path BLOCKER 34's gate never judged — and the generic
   * query-named-file construction then decides it, which is exactly how
   * `What does MAX_RETRIES do in src/retry.ts? Update the changelog.` handed
   * `src/retry.ts` write authority. Item extraction can lose a path for reasons
   * that have nothing to do with intent: measured, `How is MAX_RETRIES used in
   * src/retry.ts? Add a note to the changelog.` splits MID-PATH
   * (`["How is MAX_RETRIES used in src/retry", ".ts? Add a note ..."]`) because
   * the relation-clause pass masks its own span, leaving neither item holding a
   * full path; and `Explain src/retry.ts; then set MAX_RETRIES to 5 in
   * src/cache.ts.` gave `src/retry.ts` no row at all.
   *
   * So the WHOLE QUERY is also read clause by clause — and this pass records
   * ONLY `read`, for the paths the READ clause itself names.
   *
   * The one-direction restriction is the whole safety argument, and it was found
   * by this wave's own adversarial pass: an EDIT row from here re-opened BLOCKER
   * 34 immediately, because `LEAD_CLAUSE_BOUNDARY_RE` does not split on the JA
   * touten, so 「src/cache.ts の DEFAULT_TTL_MS を説明し、src/retry.ts の
   * MAX_RETRIES を 5 に変更してください。」 is ONE clause whose tail-anchored
   * imperative would have credited BOTH paths with `edit`. `read` cannot do that:
   * it is the LOWEST rank, so `record`'s merge lets it hold a path down to
   * read-only and never promote one, and every legitimate edit attribution keeps
   * coming from the item pass above (which is clause-local AND gated).
   */
  for (const row of clauseLeadRows(query)) {
    if (row.lead !== "read") continue;
    for (const path of fullPathTermsIn(row.clause)) {
      record(path, "read", "read");
    }
  }
  /**
   * FIXALL-A group F (2026-09-14) — AN UNRESOLVED ALTERNATIVE ALWAYS GETS ITS
   * ROW, AND IT IS `read`.
   *
   * `Update src/retry.ts or src/cache.ts to fix the timeout issue.` used to
   * produce NO rows at all: the item names two paths and no identifier, so it
   * fell through to carry-forward and nothing consumed the carry. BLOCKER 54's
   * own finding is what makes that dangerous — a path with no lead row is a path
   * the frontier's write-authority veto never judges — and it is exactly what
   * happened: `change_contract` listed BOTH candidates as `action:"edit"` while
   * the decision itself was still `await_input`, so a caller reading the
   * contract saw a live write grant for a target nothing had chosen yet.
   *
   * `record` forces every alternative-coordinated path to `read` (see its own
   * note), so this pass cannot promote anything; it only guarantees the row
   * exists, which is what turns the candidates into `action:"review"`
   * obligations until the caller actually chooses one.
   */
  for (const path of alternatives) record(path, "read", "read");
  return [...byPath.entries()].map(([path, lead]) => ({ path, lead }));
}

export function explicitMultiEditRequestPaths(query: string, index?: RequestItemIndexView): string[] | undefined {
  const items = extractRequestItems(query, index);
  if (!queryReadsAsEditRequest(query, items)) return undefined;
  // Thin filter over `requestItemLeads`'s own per-path classification (see
  // its doc for the full own/preceding/following inheritance rule this used
  // to duplicate inline) — "edit" and "inherited-edit" both qualify; a path
  // whose own governing lead is "read" never does.
  const distinct = [...new Set(
    requestItemLeads(query, index)
      .filter((entry) => entry.lead === "edit" || entry.lead === "inherited-edit")
      .map((entry) => entry.path),
  )];
  return distinct.length >= 2 ? distinct : undefined;
}

/**
 * Round 4 (2026-09-14, T4 — review-findings-3.md SHOULD-FIX 15's own wire-
 * routing residual; fix-notes-t3.md's EN-sibling caveat). `explicitMulti-
 * EditRequestPaths` above deliberately DROPS any path whose own governing
 * lead is "read" — correct for THAT function's job (the writable set for a
 * pure multi-edit request), but it means a genuinely MIXED request ("Explain
 * X in a.ts, and change Y in b.ts.") is left with only ONE qualifying path,
 * fails the ">=2" multi-edit gate, and — for a clause shape that also
 * defeats `literalFirstRelation` (see readCodeTaskPack.ts's own routing
 * comment) — falls all the way through to the ambiguous role-locator and
 * dead-ends in `choose-candidate`, even though nothing about the request is
 * actually ambiguous.
 *
 * This is a SECOND, ADDITIVE view over the exact same `requestItemLeads`
 * classification the function above uses — no new regex, no new per-item
 * heuristic, no reclassification of any path. It returns every path
 * `requestItemLeads` names (edit-ish AND read-only) whenever the query names
 * at least one edit-lead path AND at least one read-lead path — a genuine
 * mix. A pure multi-edit request (`explicitMultiEditRequestPaths` already
 * fires) and a pure multi-read/explain request (no edit-ish path at all)
 * both return `undefined` here by construction, and so does a file-less
 * alternative list ("change X to Y or Z" — only one path, ever), since a mix
 * needs two DISTINCT paths carrying two DIFFERENT classifications.
 *
 * The caller must seed every returned path into the SAME builder
 * `explicitMultiEditRequestPaths` already routes into. This function never
 * decides writability itself — readCodeTaskPack.ts's `buildTaskChangeContract`
 * (its own `readOnlyLeadPaths` veto, keyed off this exact same
 * `requestItemLeads` call) is what turns the read-lead path's presence into
 * `action:"review"` and the edit-lead path's into `action:"edit"` once both
 * are actually surfaces in the pack.
 */
export function explicitMixedEditReadRequestPaths(query: string, index?: RequestItemIndexView): string[] | undefined {
  const leads = requestItemLeads(query, index);
  const hasEditLead = leads.some((entry) => entry.lead === "edit" || entry.lead === "inherited-edit");
  const hasReadLead = leads.some((entry) => entry.lead === "read");
  if (!hasEditLead || !hasReadLead) return undefined;
  return [...new Set(leads.map((entry) => entry.path))];
}

// ---------------------------------------------------------------------------
// Classification keywords
// ---------------------------------------------------------------------------

const DEFINITION_KEYWORDS_RE = /\b(?:settings?|configuration|config(?:\s+key)?|definition|propert(?:y|ies))\b|設定項目|設定|定義|プロパティ|キー/iu;
const DECISION_KEYWORDS_RE = /\b(?:decides?|decided|determines?|determined|logic)\b|決定|決め|ロジック|判定/iu;
const RELATION_VERBS_EN = "reflect(?:s|ed)?|use[sd]?|appl(?:y|ies|ied)|pass(?:es|ed)?|consume[sd]?|affect(?:s|ed)?|decide[sd]?";
// Consumes the verb's own trailing object clause too, stopping only at a
// sentence boundary OR at a ", and "/", or " that introduces ANOTHER
// "how|where ..." clause. An object naming an enumerated set of outcomes
// ("decides allow, deny, or needs-review") is still ONE clause about ONE
// decision — its internal commas must NOT stop consumption (that left the
// object's tail as spurious standalone Pass-2 fragments, an observed
// regression against replayCorpus.spec.ts's resolveAccessPolicy case) —
// while ", and how the status bar ... reflect ..." genuinely starts the
// NEXT point and must stop consumption right before it, or design §4.1's
// own worked example would collapse into one over-wide match.
const RELATION_CLAUSE_STOP_AHEAD =
  "(?:,\\s*(?:(?:and|or)\\s+)?(?:how|where|whether|what|why|when)\\b"
  + "|,\\s*(?:(?:and|or)\\s+)?the\\s+(?:settings?|config(?:uration)?|definition|propert\\w*)\\b"
  + "|[.!?;])";
const RELATION_CLAUSE_EN_RE = new RegExp(
  `\\b(?:how|where)\\s+(.+?)\\s+(?:${RELATION_VERBS_EN})\\b(?:(?!${RELATION_CLAUSE_STOP_AHEAD}).)*`,
  "giu",
);
const RELATION_CLAUSE_JA_RE = /([^、。,\n]+?)(?:への反映|に反映|を反映|が反映|への影響|を使わ|に渡さ|を消費|に影響)[^。\n]*/gu;

/**
 * A pure "please explain/describe (this)" residual carries no request of its
 * own — whether it is Pass 2 leftover AFTER a masked clause (the trailing
 * "please explain" case) or BEFORE one (a lead-in verb with no sentence-break
 * lead clause to absorb it, e.g. "Explain exactly how X decides Y." has no
 * leading "?"/"。" for `splitLeadAndBody` to carve off, so "Explain exactly"
 * survives Pass 1 masking as its own Pass-2 segment).
 */
const GENERIC_CLOSING_EN_RE =
  /^(?:please\s+)?(?:explain|describe|tell me(?:\s+about)?|clarify)\s*(?:exactly|briefly|precisely|in\s+detail)?\s*(?:this|that|it)?\.?$/iu;
const GENERIC_CLOSING_JA_RE = /^(?:を|は)?(?:説明|教え|述べ)(?:して)?(?:ください|下さい)?[。.]?$/u;

/** Pure leftover punctuation from clause-masking (e.g. a stray trailing "."). */
const PUNCTUATION_ONLY_RE = /^[\s.,;:!?、。！？…]*$/u;

/**
 * TL142-04/05 (2026-09-13) — a fragment that, after trimming trailing
 * punctuation and ONE leading bare particle, is ENTIRELY a request/verb
 * inflection (salientWords' own (b) list) is bare instructional boilerplate
 * with no content of its own ("としてください。", "してください") — as
 * opposed to a real clause that merely ENDS in one of those suffixes
 * ("...をそれぞれ説明してください" carries real content before the suffix
 * and must never be treated as a bare closing). Anchored on BOTH ends
 * (unlike JA_REQUEST_INFLECTION_RE's suffix-only match) so only a fragment
 * that is NOTHING BUT the inflection itself qualifies.
 */
function isGenericRequestClosingFragment(text: string): boolean {
  const trimmed = text.trim().replace(/[。.！!?、，,]+$/u, "");
  if (trimmed.length === 0) return true;
  const stripped = trimmed.replace(JA_BARE_PARTICLE_RE, "");
  return JA_REQUEST_INFLECTION_ONLY_RE.test(stripped);
}

function isGenericClosing(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0
    || PUNCTUATION_ONLY_RE.test(trimmed)
    || GENERIC_CLOSING_EN_RE.test(trimmed)
    || GENERIC_CLOSING_JA_RE.test(trimmed)
    || isGenericRequestClosingFragment(trimmed);
}

const AUX_ONLY_RE = /^(?:is|are|was|were|does?|did|it|this|that)$/iu;
const LEADING_ARTICLE_RE = /^(?:the|a|an|its|their|this|that|these|those)\s+/iu;

function cleanNounPhrase(text: string): string {
  return text.trim().replace(LEADING_ARTICLE_RE, "").trim();
}

function isUsableNoun(text: string): boolean {
  const cleaned = cleanNounPhrase(text);
  return cleaned.length >= 2 && !AUX_ONLY_RE.test(cleaned);
}

function splitNounList(text: string): string[] {
  // A raw NUL sentinel (never `" "`) marks a conjunction this pass just
  // collapsed — collapsing straight to a plain space would be indistinguishable
  // from a legitimate space INSIDE a multi-word noun ("status bar", "update
  // checker") and the split below would wrongly break those apart too.
  const marked = text
    .replace(/\s+and\s+/giu, "\0")
    .replace(/および|また|そして/gu, "\0")
    .replace(/と/gu, "\0");
  return marked
    .split(/[、,，\0]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Sentence lead/body split — the lead clause (up to the first sentence-ending
// punctuation) establishes the query SUBJECT but is never itself an item
// (design §4.1's worked example: "How is the display language decided?" is
// context, not one of the four enumerated points).
// ---------------------------------------------------------------------------

/**
 * D3 (fix-c, 2026-09-21, TL-02 class) — a numbered ("1.", "1)") or bulleted
 * ("-", "*", "•") list item's own leading marker, anchored at the very start
 * of the (trimmed) query. Requires whitespace right after the marker
 * character so an ordinary decimal ("3.5") or a leading minus sign on a
 * number ("-1 apples...") never false-positives — see `splitLeadAndBody`'s
 * own doc comment for why this matters.
 */
const LIST_ITEM_MARKER_RE = /^\s*(?:\d+[.)]|[-*•])\s+/u;

/**
 * r-b2 (2026-09-21) — found via the expanded MATRIX-A joiner set's own
 * "newline (no marker)" cell: D3's list-marker gate below covers a MARKED
 * list's own item 1, but an UNMARKED multi-line query of two (or more)
 * PARALLEL "?"/"!"-ending lines hits the IDENTICAL loss — "Can you explain
 * how credentials are validated?\nCan you explain how database migrations
 * are executed?" (no marker at all) lost line 1 entirely, for exactly the
 * reason D3's own comment describes for the marked-list case: the regex
 * below finds the FIRST "?" anywhere (line 1's own) and discards everything
 * up to it. The genuine target shape this function exists for ("Why is X
 * slow?\nExplain the TTL logic.", also single-line: "Why is X slow? Explain
 * the TTL logic.") is structurally DIFFERENT: its second line is an
 * IMPERATIVE STATEMENT, never itself question-shaped. So the general,
 * structural signal — mirroring D3's own "recognized structurally, so this
 * only ever protects an ACTUAL list" — is not "is the query multi-line"
 * (the genuine lead+body shape is often ALSO written across two lines) but
 * "does the line immediately after the candidate lead ALSO end in
 * ?/!/？/！": two parallel question-shaped lines are peers, never one
 * disposable rhetorical lead followed by the real request. Only ever WIDENS
 * what counts as "keep the whole query as body" — a query whose second line
 * is not itself question-shaped (the classic "Why is X slow?\nExplain …"
 * case) is completely unaffected, verified directly below and in
 * requestItems.spec.ts/requestItemCompletion.spec.ts's existing coverage of
 * that exact shape.
 */
const LINE_ENDS_IN_QUESTION_OR_BANG_RE = /[?？!！]\s*$/u;

function firstLineEndsAsQuestion(text: string): boolean {
  const firstNewline = text.indexOf("\n");
  const firstLine = firstNewline < 0 ? text : text.slice(0, firstNewline);
  return LINE_ENDS_IN_QUESTION_OR_BANG_RE.test(firstLine.trim());
}

function splitLeadAndBody(query: string): { lead: string; body: string } {
  const trimmed = query.trim();
  // D3 (fix-c, 2026-09-21): a numbered/bulleted list's OWN first item must
  // never be swallowed as throwaway "lead" context merely because it
  // happens to end in "?"/"!" before the list's second item does — unlike
  // this function's genuine target shape ("Why is X slow? Explain how it's
  // optimized." — one disposable leading question, then the real request),
  // a list's item 1 carries exactly as much of the request as item 2, 3,
  // ... ("1. Can you explain how credentials are validated?\n2. ..." used
  // to lose item 1 entirely: the FIRST "?" anywhere is inside line 1, so
  // the regex below treated the whole first line as a discardable lead and
  // only line 2 ever reached `extractRequestItems`). Recognized
  // structurally — the query ITSELF starts with a list marker — so this
  // only ever protects an ACTUAL list; an ordinary "Question? Statement."
  // sentence pair never starts with "1."/"-"/"*" and is unaffected.
  if (LIST_ITEM_MARKER_RE.test(trimmed)) {
    return { lead: "", body: query };
  }
  // Only ?/？/!/！ end a "lead" clause, exactly like the ASCII-only path:
  // a plain 。/． (JA/fullwidth periods) is EXCLUDED for the same reason ASCII
  // "." always was (too often just a statement terminator, not a question/
  // exclamation boundary; JA prose ends ordinary sentences in 。, so treating
  // it as a lead-ender discarded a whole substantive leading sentence as
  // "context" for any multi-sentence JA request -- see requestItemCompletion
  // "JA lead swallows first sentence" case).
  const m = /^(.*?[?？!！])\s*([\s\S]*)$/u.exec(trimmed);
  if (m && m[2] !== undefined && m[2].trim().length > 0) {
    // r-b2: an UNMARKED multi-line query of parallel question-shaped lines
    // — see `firstLineEndsAsQuestion`'s own doc comment just above.
    if (trimmed.includes("\n") && firstLineEndsAsQuestion(m[2])) {
      return { lead: "", body: query };
    }
    return { lead: m[1]!, body: m[2]! };
  }
  return { lead: "", body: query };
}

// ---------------------------------------------------------------------------
// Enumerator splitting (Pass 2 — everything not already claimed by a
// relation clause)
// ---------------------------------------------------------------------------

function maskSpans(text: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start) + " ";
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * TL142-04 (2026-09-13) — a `;` immediately preceded (within the same
 * candidate segment, no earlier delimiter between) by an assignment,
 * `export`, or `return` is that STATEMENT's own terminator, never a
 * request-item enumerator boundary — whether or not it sits inside a short
 * (<=40 char) backtick span `stripFencedBlocks` intentionally preserves
 * verbatim (fenced/backticked spans otherwise keep their existing handling:
 * unchanged, since this guard only ever SUPPRESSES a split, never adds one
 * inside a span already masked out).
 */
const CODE_STATEMENT_TAIL_RE = /(?:^|[\s,、，\n])(?:export\s+|return\b|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*=(?!=))[^;]*$/u;

/**
 * Splits `segment` on `;` ONLY where it is a genuine enumerator boundary:
 * never when the trailing fragment is a bare generic closing (merges it
 * back into the preceding item — a create request's own content
 * specification must not be torn from its closing "please make it so", e.g.
 * "...ENABLED = true; としてください。" stays ONE item) and never when the
 * `;` is a code statement's own terminator (CODE_STATEMENT_TAIL_RE above).
 */
function splitOnSemicolons(segment: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  let searchFrom = 0;
  for (;;) {
    const idx = segment.indexOf(";", searchFrom);
    if (idx < 0) break;
    const before = segment.slice(cursor, idx);
    const after = segment.slice(idx + 1);
    const nextDelimiter = after.search(/[,;、，\n]/u);
    const trailingFragment = nextDelimiter >= 0 ? after.slice(0, nextDelimiter) : after;
    if (CODE_STATEMENT_TAIL_RE.test(before) || isGenericClosing(trailingFragment)) {
      searchFrom = idx + 1;
      continue;
    }
    parts.push(segment.slice(cursor, idx));
    cursor = idx + 1;
    searchFrom = cursor;
  }
  parts.push(segment.slice(cursor));
  return parts;
}

function splitEnumerated(text: string): string[] {
  const normalized = text
    // Only an OXFORD-COMMA "and"/"or" (", and "/", or ") is a genuine
    // top-level list boundary. A bare "X and Y" with no preceding comma is
    // usually a single clause naming two objects of ONE verb/preposition
    // ("through TransferBuffer and GraphClient", "allow, deny, or
    // needs-review" once the comma before it is already part of an inner
    // enumeration) — splitting on every bare "and" turned one wiring/flow
    // question into spurious extra points (observed regression against
    // replayCorpus.spec.ts's DriveMounter case).
    .replace(/,\s+(?:and|or)\s+/giu, ", ")
    // JA conjunctions that already delimit `splitNounList`'s relation-actor
    // lists (design consistency, not a new heuristic). Adversarial review 2
    // finding 2 (2026-09-08): bare "と" was tried here and REVERTED — unlike
    // the multi-character alternatives, a single "と" is not a reliable
    // conjunction boundary. It is also the final syllable of extremely common
    // grammatical forms (こと/とき/として/ところ/もと/あと) and the quotative
    // particle (…と等しい/…とする/…と言う), all indistinguishable from the
    // list-conjunction "と" by any neighbour-character heuristic tried; the
    // false-positive splits fabricated request items out of ordinary prose
    // and truncated the surviving ones (e.g. "…確認することを説明してください"
    // losing "とを説明してください" entirely once "こと" was cut). A genuine
    // "X と Y" enumeration (e.g. "キャッシュとログの読み込みを説明して") now
    // stays fused into one item instead of splitting into two — a smaller,
    // acceptable cost next to fabricating nonsense items/search queries.
    .replace(/および|及び|並びに|また|そして/gu, "、")
    .replace(/(?:^|\n)[ \t]*(?:[-*•]|\(?\d{1,2}[.)]|[①-⑳])[ \t]+/gu, "\n");
  // 2026-10-06 independent review (P2-1): a comma between a call's arguments
  // (`calculateTotal(4800, 0)`) is never a list boundary — see
  // requestFacets.ts `maskCallArgumentPunctuation`. Cut points are found in
  // the guarded copy and the ORIGINAL text is sliced.
  const guarded = maskCallArgumentPunctuation(normalized, ",、，");
  const pieces: string[] = [];
  let cursor = 0;
  for (const match of guarded.matchAll(/[,、，\n]+/gu)) {
    pieces.push(normalized.slice(cursor, match.index));
    cursor = (match.index ?? cursor) + match[0].length;
  }
  pieces.push(normalized.slice(cursor));
  const primary = pieces
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: string[] = [];
  for (const segment of primary) {
    for (const part of splitOnSemicolons(segment)) {
      const trimmed = part.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// H-2/H-3 (2026-09-19, additive): independent-question detection, and the
// question-aware "and" split it enables. See readCodeTaskPack.ts's
// ALL-TOPIC branch of `buildRequestItemReadiness` for H-2's call site and
// completionHonesty.spec.ts for the end-to-end contract. Pure, additive —
// nothing above this point changes.
//
// JAPANESE SEGMENTATION IS DELIBERATELY LEFT ALONE (brief-sanctioned): a
// bare "と" list-boundary split was tried and REVERTED in `splitEnumerated`
// above (see its own "adversarial review 2 finding 2" comment) because
// "と" is also the final syllable of こと/とき/として/ところ/もと/あと and
// the quotative と, indistinguishable by any neighbour-character heuristic.
// A two-sided question test does not remove that ambiguity — the false
// split happens at the SAME character before either side can be examined —
// so resurrecting bare-と splitting here would reintroduce exactly the
// regression that comment documents. `isIndependentQuestionClause`'s own
// JA branch (whole-clause か/？ ending) is unaffected by this and stays in
// scope.
// ---------------------------------------------------------------------------

const EN_INTERROGATIVE_HEAD_WORD = "where|how|what|which|why|when|who|whose";
const EN_AUX_WORD = "is|are|was|were|do|does|did|can|could|will|would|should|has|have|had";
// A leading interrogative head, optionally followed by ONE auxiliary verb —
// "How is", "Where are", "What does" — the auxiliary is never required
// ("Why bother", "How so" are still question heads on their own).
const EN_INTERROGATIVE_HEAD_RE = new RegExp(`^(?:${EN_INTERROGATIVE_HEAD_WORD})\\b(?:\\s+(?:${EN_AUX_WORD})\\b)?`, "iu");
// Auxiliary-inversion question with NO wh-word ("Is the coupon validated
// before checkout?", "Does the retry loop cap attempts?") — the clause must
// actually END in "?"; without the mark this is ambiguous prose, not
// asserted as a question here.
const EN_AUX_INVERSION_LEAD_RE = new RegExp(`^(?:${EN_AUX_WORD})\\b`, "iu");
const EN_LEADING_COORDINATOR_RE = /^\s*(?:and|then)\s+|^\s*,\s*/iu;
const EN_TRAILING_QUESTION_MARK_RE = /[?？]\s*$/u;
const EN_TRAILING_COLON_NO_QUESTION_RE = /:\s*$/u;
const BRACKET_TAG_ONLY_RE = /^[[(【].*[\])】]$/u;

const JA_INTERROGATIVE_RE = /どこ|どの|どのよう|どう|何|なに|なぜ|いつ|誰|どれ|いくつ|どちら/u;
// H-4 residual fix (fix-b, 2026-09-21): natural JA prose closes a question
// with a trailing 。 after か ("...されますか。", not the bare "...されますか"
// this regex originally required) — confirmed on the current tree: a genuine
// two-question JA compound
// ("認証情報はどこで検証されますか。また、データベースのマイグレーションはどのよ
// うに実行されますか。") failed BOTH of its own clauses here purely because of
// the trailing 。, which is standard JA sentence-final punctuation, not
// content. One optional trailing "。"/"." after the か/?/？ (before the
// existing optional whitespace) — never widens WHICH clauses can qualify
// (still gated on `JA_INTERROGATIVE_RE` finding an actual interrogative word
// first), only lets the ordinary written form of the same clause qualify.
const JA_QUESTION_END_RE = /(?:か|[?？])[。.]?\s*$/u;

/**
 * True when `text` reads as ONE self-contained question, not a fragment of
 * a larger sentence (an imperative clause, a parenthetical list item inside
 * one question, a bracket tag, a header line ending in ":"). Pure, no
 * workspace access.
 *
 * Deliberately narrow — see the reviewed constraint documented on
 * readCodeTaskPack.ts's ALL-TOPIC branch: ordinary multi-clause prose split
 * on "and"/";" (a parenthetical list inside one question — d12a; an
 * imperative fragment — "identify the implementation path") must NEVER be
 * mistaken for a genuine multi-point request. Requiring the interrogative
 * to be the CLAUSE'S OWN HEAD (not merely present somewhere in it) is what
 * keeps "Trace how X builds Y" (imperative lead — the wh-word is not at the
 * start) from qualifying, while "how is a coupon discount validated" does.
 */
export function isIndependentQuestionClause(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (BRACKET_TAG_ONLY_RE.test(trimmed)) return false;
  if (EN_TRAILING_COLON_NO_QUESTION_RE.test(trimmed) && !EN_TRAILING_QUESTION_MARK_RE.test(trimmed)) return false;

  if (JA_INTERROGATIVE_RE.test(trimmed) && JA_QUESTION_END_RE.test(trimmed)) return true;

  const stripped = trimmed.replace(EN_LEADING_COORDINATOR_RE, "").trim();
  if (stripped.length === 0) return false;
  if (EN_INTERROGATIVE_HEAD_RE.test(stripped)) return true;
  if (EN_AUX_INVERSION_LEAD_RE.test(stripped) && EN_TRAILING_QUESTION_MARK_RE.test(trimmed)) return true;
  return false;
}

/**
 * H-4 (fix-b, 2026-09-21, TL-02/TL-04(a); GENERALISED by r-b2, 2026-09-21,
 * adversarial-review finding B4 — supersedes fix-b's own closed-vocabulary
 * ruling, which is now a strict subset of the rule below) — "non-mutation
 * lead + embedded wh-question".
 *
 * `isIndependentQuestionClause` deliberately requires the interrogative to be
 * the clause's OWN head (its own doc comment explains why: an imperative
 * fragment like "Trace how X builds Y" must never qualify AS AN INDEPENDENT
 * QUESTION CLAUSE ON ITS OWN — that predicate's contract is UNCHANGED by this
 * fix). That is exactly right for `isIndependentQuestionClause` itself, but
 * fix-b's first cut at THIS predicate only special-cased a closed read-verb
 * vocabulary (`explain|describe|tell me|show me|clarify|summarize`) ahead of
 * the embedded question — so `Trace how credentials are validated and how
 * database migrations are executed.` (and `Walk me through …`, `I want to
 * understand …`, `Outline …`, `Document …`, `Give me an overview of …`) never
 * split at its bare "and": the "before" side's head was still an imperative
 * verb outside that closed list, `extractRequestItems` returned ONE item, and
 * the whole request-item mechanism silently never engaged for the second
 * point — a disclosure loss, not a crash, so nothing failed loudly.
 *
 * ORCHESTRATOR RULING (r-b2, review finding B4): generalise by RULE, not by
 * growing the word list again. A clause qualifies when, after the SAME
 * reviewed `stripLeadPrefixes` chain every other lead test in this file
 * shares:
 *   (a) a wh-word (`EN_INTERROGATIVE_HEAD_WORD`) occurs within the first 6
 *       tokens (`findEmbeddedWhHeadIndex` below) — long enough to admit
 *       "Give me an overview of how X" (5 lead words before its "how"),
 *       short enough that a wh-word buried inside an unrelated later clause
 *       of a long imperative sentence never qualifies;
 *   (b) nothing between the clause's own start and that wh-word crosses a
 *       comma, colon, semicolon, bracket or quote mark — a wh-word sitting
 *       inside a parenthetical, past a colon-introduced list, or inside a
 *       quoted phrase is not THIS clause's own embedded question (the same
 *       spirit as B3's bracket/quote guard on the split boundary itself,
 *       applied here to the LEAD side, ahead of the wh-word rather than
 *       around the join point);
 *   (c) the lead itself does not read as an edit/mutation lead — reuses the
 *       existing, already-reviewed `MUTATION_VERB_LEAD_RE`
 *       (built from `MUTATION_VERBS_EN`, a strict superset of
 *       `EDIT_LEAD_VERBS_EN` by construction, asserted in
 *       requestItems.spec.ts) rather than a new vocabulary, so
 *       `Refactor how X … and how Y …` / `Fix how the parser handles input`
 *       stay ONE edit request: change-task routing and
 *       `matrix/intentLeadMatrix.spec.ts` cannot move, because a
 *       mutation-led clause is rejected before the wh-search is even
 *       consulted;
 *   (d) `isIndependentQuestionClause` — UNCHANGED, never widened, never
 *       called with a looser sibling test — accepts the remainder starting
 *       AT that wh-word.
 *
 * Still never widens to a clause with NO wh-word anywhere in its first 6
 * tokens ("Identify the implementation path" fails (a) exactly as before) or
 * to any mutation-led clause (fails (c) regardless of how close its own
 * wh-word sits) — replay `d12a`/`p12d`, the observed-directory case, and
 * `matrix/intentLeadMatrix.spec.ts` all stay green because neither call site
 * below changed, only what this ONE predicate itself decides.
 *
 * Used at EXACTLY two call sites (unchanged from fix-b's own B2 ruling): the
 * BEFORE side of `splitBareAndAtQuestionBoundary` below, and the H-2 filter in
 * readCodeTaskPack.ts's ALL-TOPIC branch of `buildRequestItemReadiness`. Name
 * kept (not renamed) so neither call site's import needs to change — r-b2's
 * own region is this file plus N7 wording only in readCodeTaskPack.ts, and
 * the H-2 filter is neither.
 */
const EMBEDDED_WH_MAX_LEAD_TOKENS = 6;
/** `EN_INTERROGATIVE_HEAD_WORD`, matched alone (no optional trailing aux — that belongs to `EN_INTERROGATIVE_HEAD_RE`'s AFTER-side test, not this BEFORE-side token scan). */
const EN_INTERROGATIVE_HEAD_WORD_ONLY_RE = new RegExp(`^(?:${EN_INTERROGATIVE_HEAD_WORD})\\b`, "iu");
/** Rule (b)'s boundary set: comma, colon, semicolon, any bracket (ASCII or JA fullwidth), or any quote mark. */
const LEAD_WH_BOUNDARY_PUNCTUATION_RE = /[,:;()[\]{}「」『』【】"'`“”‘’]/u;

/**
 * Index in `text` where a qualifying embedded wh-word begins (rules (a)+(b)
 * of `headIsWhAfterReadLead` above), or `undefined` when none exists.
 * Token-scans (whitespace-delimited) rather than reusing `stripLeadPrefixes`
 * a second time: the lead here is not one of that chain's three reviewed
 * prefix registers (politeness/discourse/locative) — it is ANY non-mutation
 * run of words, of unknown shape, so the only general boundary available is
 * "how many words" (a) and "no structural punctuation crossed yet" (b). A
 * token's own LEADING non-letter characters (an opening quote/bracket
 * touching the word, e.g. `"how`) count toward the boundary check — the
 * quote/bracket sits strictly before the wh-word's first letter — so a
 * wh-word immediately inside an opening quote/bracket is correctly rejected,
 * not accidentally admitted by trimming the quote away first.
 */
function findEmbeddedWhHeadIndex(text: string): number | undefined {
  const tokenRe = /\S+/gu;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;
  while ((match = tokenRe.exec(text)) !== null) {
    tokenIndex += 1;
    if (tokenIndex > EMBEDDED_WH_MAX_LEAD_TOKENS) return undefined;
    const token = match[0];
    const leadingNonLetter = token.match(/^[^\p{L}]*/u)?.[0] ?? "";
    const core = token.slice(leadingNonLetter.length);
    if (EN_INTERROGATIVE_HEAD_WORD_ONLY_RE.test(core)) {
      const whStart = (match.index ?? 0) + leadingNonLetter.length;
      if (LEAD_WH_BOUNDARY_PUNCTUATION_RE.test(text.slice(0, whStart))) return undefined;
      return whStart;
    }
  }
  return undefined;
}

export function headIsWhAfterReadLead(text: string): boolean {
  const trimmed = text.trim();
  if (isIndependentQuestionClause(trimmed)) return true;
  const stripped = stripLeadPrefixes(trimmed);
  if (stripped.length === 0) return false;
  // Rule (c): a mutation/edit lead never qualifies, however close its own
  // wh-word sits — checked BEFORE the wh-search so an edit request can never
  // be reclassified by this predicate.
  if (MUTATION_VERB_LEAD_RE.test(stripped)) return false;
  const whStart = findEmbeddedWhHeadIndex(stripped);
  if (whStart === undefined) return false;
  return isIndependentQuestionClause(stripped.slice(whStart));
}

/**
 * R-B3 (2026-09-21, orchestrator ruling 6) — the LEAD SPAN of a generalised
 * read lead is not part of what the clause asks about. "Walk me through how
 * refunds are processed" asks about refunds; "Walk"/"through" (like "Trace",
 * "I want to understand", "Give me an overview of") only say HOW to answer.
 * Left in, they became salient words — a topic term that is never evidenced,
 * a Tier C absence candidate, and (confirmed live, R-B1's matrix) the whole
 * query of a `tl_search_files find "walk"` when the first pack served nothing.
 *
 * The span is identified by `headIsWhAfterReadLead`'s OWN rule (a)-(c), never
 * a word list: the words between the stripped lead prefixes and the embedded
 * wh-head that makes the rest an independent question. Returned MASKED — the
 * same length, the span blanked — so every character offset a caller computes
 * against the original text (quoted spans, positions) stays valid. A clause
 * that already opens with its own wh/aux head, a mutation lead, or a clause
 * with no qualifying embedded wh-head is returned unchanged; the stripped
 * politeness/discourse/locative prefixes themselves are never masked (a
 * locative carries the file it names).
 */
export function maskReadLeadSpan(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || isIndependentQuestionClause(trimmed)) return text;
  const stripped = stripLeadPrefixes(trimmed);
  if (stripped.length === 0 || MUTATION_VERB_LEAD_RE.test(stripped)) return text;
  const whStart = findEmbeddedWhHeadIndex(stripped);
  if (whStart === undefined || whStart === 0) return text;
  if (!isIndependentQuestionClause(stripped.slice(whStart))) return text;
  // `stripLeadPrefixes` only ever removes a PREFIX, so `stripped` is a suffix
  // of `trimmed`, which starts after `text`'s own leading whitespace.
  const start = (text.length - text.trimStart().length) + (trimmed.length - stripped.length);
  return `${text.slice(0, start)}${" ".repeat(whStart)}${text.slice(start + whStart)}`;
}

// H-3: a bare " and " with NO preceding comma is ordinarily kept fused (a
// single verb/preposition's two objects — see the DriveMounter regression
// note on `splitEnumerated`'s own comma-normalization rule below). But when
// the text strictly BEFORE it is itself an independent question clause and
// the text strictly AFTER it opens with a fresh interrogative head, the two
// sides are two separate questions joined by "and", not one clause with a
// compound object ("Where is the shipping cost calculated and how are
// invoices built?" — D3). Scoped narrowly to this two-sided shape so it
// never fires on an ordinary compound object or a d12a-style parenthetical
// list.
//
// TL-02 residual fix (fix-b, 2026-09-21): "as well as" is the SAME bare
// coordinator in this position — "Explain how X as well as how Y." reaches
// this mechanism exactly like "Explain how X and how Y." does, and for the
// identical reason must NOT split a compound object ("Explain how the
// parser handles JSON as well as YAML." stays one clause: "YAML." carries
// no fresh wh-head of its own, so the two-sided test below still refuses
// it). Confirmed missing on the current tree: neither this splitter nor
// `splitEnumerated`'s comma/semicolon rules recognize "as well as" at all,
// so a query using only this joiner never reached 2 items in the first
// place — the whole request-item mechanism silently never engaged, the
// exact TL-02 shape this file exists to close.
//
// GENERALISED (r-b2, 2026-09-21, review finding B4): "and"/"as well as" are
// two members of a COORDINATOR CLASS, not the whole class — the review
// measured "plus" and "along with" silently certifying only half a compound
// question the identical way "and" itself used to, and "together with" /
// "and also" / "and then" are the same shape. All seven read the SAME
// two-sided test below unchanged (the AFTER side must open with a fresh
// wh-head; B3's bracket/quote guard applies at every occurrence identically,
// regardless of which coordinator matched) — this is a bigger alternation,
// never a new mechanism. `and(?:\s+(?:also|then))?` deliberately matches the
// LONGER "and also"/"and then" form whenever it is present (`?` is greedy,
// so the compound reading wins over the bare "and" prefix), so the AFTER
// side never has to start with a stray "also"/"then" of its own. A bare
// "; also" (semicolon, not "and") is intentionally NOT part of this
// alternation — `splitOnSemicolons` already splits it structurally
// (unconditional), and "also" alone is not a coordinator (see N7's own
// gap-token fix: "also"/"plus"/"then" are filler words, never a search
// target, but "; also" already produces 2 items via the semicolon, not via
// this regex).
const BARE_AND_RE = /\s+(?:and(?:\s+(?:also|then))?|as well as|plus|along with|together with)\s+/giu;

/**
 * B3 (fix-b, 2026-09-21) — bracket/quote guard for the bare-"and" split.
 *
 * A parenthetical list inside ONE question (the d12a class: "...(exact
 * command, workflow args like reps/tasks, and the post-run
 * record/archive/aggregate steps)?") must never be torn in half by a split
 * that lands strictly between an opening and closing bracket/quote —
 * confirmed live on the CURRENT tree even before H-4 above: `How does the
 * pipeline handle retries (and how backoff is tuned) and how are errors
 * logged?` already mis-split into `"How does the pipeline handle retries
 * (and how backoff is tuned)"` (dangling open paren) + `"how are errors
 * logged?"`, because the "before" side of THAT bare "and" already read as an
 * independent question (a bare "How does" head) with no bracket awareness at
 * all. Depth-tracked per bracket TYPE (not a shared cross-type stack) so
 * nested/mixed brackets resolve correctly; quotes reuse `quotedSpans` (the
 * SAME span computation `salientWords` already trusts) rather than a second
 * quote scanner. A bare "and" whose position is protected is simply SKIPPED
 * (the loop below tries the next occurrence) — it is never counted as a
 * split boundary, so `before` on a later, unprotected match still spans the
 * WHOLE bracketed run unmodified, exactly as it already does today for the
 * bracket-external case.
 */
const AND_GUARD_BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["（", "）"],
  ["【", "】"],
];

function isInsideUnclosedBracket(text: string, index: number): boolean {
  for (const [open, close] of AND_GUARD_BRACKET_PAIRS) {
    let depth = 0;
    for (let i = 0; i < index; i += 1) {
      const ch = text[i];
      if (ch === open) depth += 1;
      else if (ch === close && depth > 0) depth -= 1;
    }
    if (depth > 0) return true;
  }
  return false;
}

function bareAndSitsInsideProtectedSpan(text: string, index: number): boolean {
  if (quotedSpans(text).some((span) => index >= span.start && index < span.end)) return true;
  return isInsideUnclosedBracket(text, index);
}

/** Splits `segment` at every bare " and "/" as well as " boundary (`BARE_AND_RE`) that satisfies the two-sided independent-question test above; returns `[segment]` unchanged when none does. Recurses into the tail so "A? and B? as well as C?" splits at every qualifying boundary, not just the first. */
function splitBareAndAtQuestionBoundary(segment: string): string[] {
  BARE_AND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_AND_RE.exec(segment)) !== null) {
    if (bareAndSitsInsideProtectedSpan(segment, m.index)) continue;
    const before = segment.slice(0, m.index).trim();
    const after = segment.slice(m.index + m[0].length).trim();
    if (before.length === 0 || after.length === 0) continue;
    if (EN_INTERROGATIVE_HEAD_RE.test(after) && headIsWhAfterReadLead(before)) {
      return [before, ...splitBareAndAtQuestionBoundary(after)];
    }
  }
  return [segment];
}

// ---------------------------------------------------------------------------
// R2-T2 (2026-09-30, review-0929 P0-5, orchestrator RULING extending
// brief-wp-c3.md) — a COORDINATED NOUN-PHRASE CONJUNCT is its own point.
//
// "Explain shouldRetry and the health probe." (and its JA mirror 「shouldRetry
// とヘルスプローブについて説明してください。」) extracted to ONE item: there is
// no comma before its "and" (`splitEnumerated` splits only an Oxford-comma
// coordinator), no fresh wh-head after it (H-3's two-sided question test
// above), and a bare 「と」 is deliberately never a boundary (`splitEnumerated`'s
// own reverted-split note). The whole sentence stayed one point, the
// identifier's own evidence then covered it, and the second subject was never
// served, never disclosed, never named on the wire.
//
// The ruling: a conjunct that is its OWN determiner-led noun phrase — "X and
// the NP", "X, the NP and the NP2", "the NP and the NP2", JA 「X と NP について/
// を」, 「X と NP の…」 — is its own topic point (then located or disclosed per
// the absence ruling); a head noun SHARED across the conjunction keeps ONE
// point ("the retry and backoff logic", 「リトライとバックオフの処理」).
//
// EN, decided structurally at a bare coordinator (`BARE_AND_RE`'s own class):
//   (A) the text after it opens with an article or a first/second-person
//       possessive (the/a/an/our/your/my) and a noun phrase that names a
//       subject noun of its own — a word that is not a facet descriptor, an
//       adjective or a participle. "…and the callers", "…and the settings in
//       src/x.ts" name only a KIND of information (facet-owned, rule 2(d)),
//       and "…and backoff logic" (no determiner) is the shared-head shape;
//   (B) or the text BEFORE it ends in such a determiner-led noun phrase and
//       the text after it opens with a code-shaped identifier ("Explain the
//       health probe and shouldRetry.").
// Never split: a conjunct holding an anaphoric pronoun ("…and the reason it
// fails", "…and the endpoint that reaches it" are about the other
// conjunct), a conjunct that is a CLAUSE — its noun run followed by an
// auxiliary ("…and the id is stale"), or a run ending in a -s/-ed word that
// could be its verb ("…and the client gives up", "…and the edit lands")
// unless the text before the coordinator is a plain request-verb imperative
// or a verbless noun phrase whose list these continue ("Explain X and the
// health checks", "X, the health probe and the retry codes") — a
// coordinator inside quotes/brackets (B3's guard), and a clause that reads as
// an edit/mutation lead (change-task routing and its write authority stay
// exactly as before — the same rule (c) `headIsWhAfterReadLead` applies),
// and the two arguments of "between X and Y" ("the drift between the
// architecture deck and the roadmap deck"): one relational head shared by
// both, the shared-head shape again.
//
// JA: a chain 「N と N (と N)*」 of noun runs (katakana/kanji, or a code-shaped
// ASCII identifier) followed directly by について/に関して/に関する/を — the
// particle marks every member of the chain, no noun follows to be shared — or
// by の + a facet descriptor when the chain's first member is a code-shaped
// identifier (「shouldRetry とヘルスプローブの実装」: an identifier is never a
// co-modifier of a shared compound head). 「リトライとバックオフの処理」 (plain
// nouns, の + a content noun) stays one point. A と inside こと/とき/として/
// という/とは… never qualifies: both of its neighbours must be noun runs.
// ---------------------------------------------------------------------------
const NP_CONJUNCT_DETERMINERS: ReadonlySet<string> = new Set(["the", "a", "an", "our", "your", "my"]);
const NP_ANAPHORIC_PRONOUNS: ReadonlySet<string> = new Set(["it", "its", "itself", "they", "them", "their", "theirs", "themselves"]);
const NP_CONJUNCT_COORDINATOR_RE = new RegExp(BARE_AND_RE.source, "giu");

/** True when `run` (one noun phrase's content words) names a subject noun of its own. */
function nounRunNamesSubject(run: readonly NpToken[]): boolean {
  return run.some((token) => !isFacetDescriptorTerm(token.lower) && !isAdjectiveShaped(token.lower) && !isParticipleShaped(token.lower));
}

/** The tokens of one conjunct: up to the next coordinator (a relative clause stays in it). */
function conjunctTokens(tokens: readonly NpToken[]): NpToken[] {
  const out: NpToken[] = [];
  for (const token of tokens) {
    if (out.length > 0 && token.cls === "conj") break;
    out.push(token);
  }
  return out;
}

/**
 * True when `beforeTokens` can only be followed by a NOUN-PHRASE conjunct: a
 * plain request-verb imperative ("Explain X") or a verbless noun phrase (a
 * list member such as "the health probe" in "X, the health probe and the
 * retry codes") — no wh/subordinate/auxiliary/pronoun clause, and no
 * -s/-ed word before its last word.
 */
function beforeTakesNounPhraseConjunct(beforeTokens: readonly NpToken[]): boolean {
  if (beforeTokens.some((token) => token.cls === "wh" || token.cls === "wh-det" || token.cls === "sub" || token.cls === "aux" || token.cls === "pron")) {
    return false;
  }
  const first = beforeTokens.find((token) => token.cls !== "adv" && token.cls !== "conj");
  if (first === undefined) return false;
  if (first.cls === "content" && topicLeadVerbs().has(first.lower)) return true;
  const content = beforeTokens.filter((token) => token.cls === "content");
  return content.length > 0 && content.slice(0, -1).every((token) => !isFiniteVerbShaped(token.lower));
}

/** Rule (A): `after` opens with a determiner-led noun phrase naming its own subject. */
function opensWithNounPhraseConjunct(after: string, beforeTokens: readonly NpToken[]): boolean {
  const tokens = conjunctTokens(npTokens(after));
  if (tokens.length < 2 || !NP_CONJUNCT_DETERMINERS.has(tokens[0]!.lower)) return false;
  if (tokens.some((token) => NP_ANAPHORIC_PRONOUNS.has(token.lower))) return false;
  let end = 1;
  while (end < tokens.length && tokens[end]!.cls === "content") end += 1;
  const run = tokens.slice(1, end);
  if (run.length === 0 || !nounRunNamesSubject(run)) return false;
  // A clause, not a noun phrase: its subject's auxiliary follows it.
  if (tokens[end]?.cls === "aux") return false;
  // A final -s/-ed word may be the clause's verb; only an imperative's object
  // list or a list of noun phrases reads it as a plural noun.
  if (run.length >= 2 && isFiniteVerbShaped(run[run.length - 1]!.lower)) return beforeTakesNounPhraseConjunct(beforeTokens);
  return true;
}

/**
 * Rule (B): `beforeTokens` end in a determiner-led noun phrase naming its own
 * subject — a short run of plain words: an identifier inside it makes the
 * identifier the conjunct ("…exposes createWidget and disposeWidget"), and a
 * -s/-ed word before its last word is a verb ("the module exposes X").
 */
function endsWithNounPhraseConjunct(beforeTokens: readonly NpToken[]): boolean {
  let i = beforeTokens.length - 1;
  const run: NpToken[] = [];
  while (i >= 0 && beforeTokens[i]!.cls === "content") {
    run.unshift(beforeTokens[i]!);
    i -= 1;
  }
  if (run.length === 0 || run.length > 4 || i < 0 || !NP_CONJUNCT_DETERMINERS.has(beforeTokens[i]!.lower)) return false;
  if (run.some((token) => isCodeShapedTerm(token.raw))) return false;
  if (run.slice(0, -1).some((token) => isFiniteVerbShaped(token.lower))) return false;
  return nounRunNamesSubject(run);
}

/** True when `text` opens with a code-shaped identifier (possibly quoted/bracketed, possibly possessive). */
function opensWithCodeShapedIdentifier(text: string): boolean {
  const m = /^[\s"'`(]*([A-Za-z_$@][\w$@]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*)/u.exec(text);
  return m !== null && isCodeShapedTerm(m[1]!);
}

/** "between X and Y": the coordinator joins the two arguments of one relation (a shared relational head). */
function coordinatesBetweenArguments(beforeTokens: readonly NpToken[]): boolean {
  for (let i = beforeTokens.length - 1; i >= 0; i -= 1) {
    const token = beforeTokens[i]!;
    if (token.cls === "prep") return token.lower === "between";
    if (token.cls !== "content" && token.cls !== "det" && token.cls !== "num" && token.cls !== "adv") return false;
  }
  return false;
}

function readsAsMutationLead(segment: string): boolean {
  const trimmed = segment.trim();
  return MUTATION_VERB_LEAD_RE.test(stripLeadPrefixes(trimmed)) || endsWithJaEditImperative(trimmed);
}

const JA_CONJUNCT_NOUN_CHARS = "ァ-ヶー一-鿿々";
const JA_CONJUNCT_NOUN_SRC = `(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*|[${JA_CONJUNCT_NOUN_CHARS}]{2,})`;
/** A chain of noun runs joined by と, followed by the particle that marks every member of it. */
const JA_NP_COORDINATION_RE = new RegExp(
  `${JA_CONJUNCT_NOUN_SRC}(?:\\s*と\\s*${JA_CONJUNCT_NOUN_SRC})+(?=\\s*(について|に関して|に関する|を|の))`,
  "gu",
);

/** True when `rest` (the text right after an の) opens with a facet descriptor noun (実装/仕組み/条件/呼び出し元/…). */
function jaOpensWithFacetDescriptor(rest: string): boolean {
  for (let length = Math.min(6, rest.length); length >= 1; length -= 1) {
    if (isFacetDescriptorTerm(rest.slice(0, length))) return true;
  }
  return false;
}

function splitJaCoordinatedNounPhrases(segment: string): string[] {
  const quoted = quotedSpans(segment);
  JA_NP_COORDINATION_RE.lastIndex = 0;
  for (const m of segment.matchAll(JA_NP_COORDINATION_RE)) {
    const start = m.index ?? 0;
    const chain = m[0];
    const end = start + chain.length;
    if (quoted.some((span) => start < span.end && end > span.start)) continue;
    const members = chain.split(/\s*と\s*/u);
    // An ASCII member counts only as a code-shaped identifier: a plain
    // English word inside Japanese prose ("wiring と imports をたどり") is a
    // loan noun whose own coordination this rule does not judge.
    if (members.some((member) => /^[A-Za-z_$]/u.test(member) && !isCodeShapedTerm(member))) continue;
    if (m[1] === "の") {
      const afterNo = segment.slice(end).replace(/^\s*の/u, "");
      if (!isCodeShapedTerm(members[0]!) || !jaOpensWithFacetDescriptor(afterNo)) continue;
    }
    // Cut at every と of the chain: each member but the last becomes its own
    // point; the last keeps the particle and everything after it.
    const pieces: string[] = [];
    let cursor = 0;
    let offset = start;
    for (const member of members.slice(0, -1)) {
      const memberAt = segment.indexOf(member, offset);
      const toAt = segment.indexOf("と", memberAt + member.length);
      pieces.push(segment.slice(cursor, toAt).trim());
      cursor = toAt + 1;
      offset = cursor;
    }
    const tail = segment.slice(cursor).trim();
    return [...pieces.filter((piece) => piece.length > 0), ...splitJaCoordinatedNounPhrases(tail)];
  }
  return [segment];
}

/**
 * R2-T2 — splits `segment` at every coordinator whose conjunct is its own
 * determiner-led noun phrase (see this section's header); returns `[segment]`
 * unchanged when none qualifies.
 */
/**
 * R2-T2 — the index of the first coordinator at or after `minIndex` in the EN
 * `text` whose conjunct is its own determiner-led noun phrase (rules (A)/(B)
 * of this section's header), with the coordinator's own length; undefined
 * when none qualifies.
 */
function firstNounPhraseConjunctCut(text: string, minIndex: number): { index: number; length: number } | undefined {
  for (const m of text.matchAll(NP_CONJUNCT_COORDINATOR_RE)) {
    const index = m.index ?? 0;
    if (index < minIndex || bareAndSitsInsideProtectedSpan(text, index)) continue;
    const before = text.slice(0, index).trim();
    const after = text.slice(index + m[0].length).trim();
    if (before.length === 0 || after.length === 0) continue;
    const beforeTokens = npTokens(before);
    if (coordinatesBetweenArguments(beforeTokens)) continue;
    if (opensWithNounPhraseConjunct(after, beforeTokens)
      || (endsWithNounPhraseConjunct(beforeTokens) && opensWithCodeShapedIdentifier(after))) {
      return { index, length: m[0].length };
    }
  }
  return undefined;
}

/**
 * R2-T2 — where a Pass-1 relation clause ("how X decides …", "how X uses Y
 * …") must END so a coordinated noun-phrase conjunct in its OBJECT ("…
 * decides and the health probe") is left to Pass 2 as its own point:
 * `clause.length` when nothing is cut. Only the object — the text after the
 * relation verb — is searched: a coordination inside the ACTOR ("how the
 * status bar and the update checker reflect …") is the relation's own actor
 * list, which Pass 1 already splits into one relation item per noun.
 */
function relationClauseEnd(clause: string, actor: string, sentence: string): number {
  if (readsAsMutationLead(sentence) || /[぀-ヿ一-鿿]/u.test(clause)) return clause.length;
  const actorAt = clause.indexOf(actor);
  if (actorAt < 0) return clause.length;
  const verb = new RegExp(`^\\s+(?:${RELATION_VERBS_EN})\\b`, "iu").exec(clause.slice(actorAt + actor.length));
  if (verb === null) return clause.length;
  const cut = firstNounPhraseConjunctCut(clause, actorAt + actor.length + verb[0].length);
  return cut === undefined ? clause.length : cut.index;
}

function splitCoordinatedNounPhrases(segment: string): string[] {
  if (readsAsMutationLead(segment)) return [segment];
  if (/[぀-ヿ一-鿿]/u.test(segment)) return splitJaCoordinatedNounPhrases(segment);
  const cut = firstNounPhraseConjunctCut(segment, 0);
  if (cut === undefined) return [segment];
  const before = segment.slice(0, cut.index).trim();
  const after = segment.slice(cut.index + cut.length).trim();
  return [before, ...splitCoordinatedNounPhrases(after)];
}

// ---------------------------------------------------------------------------
// extractRequestItems
// ---------------------------------------------------------------------------

function aliasesFor(seeds: readonly string[], index: RequestItemIndexView | undefined): string[] {
  if (index === undefined) return [];
  const out = new Set<string>();
  for (const seed of seeds) {
    if (seed.trim().length === 0) continue;
    for (const hit of index.lookup(seed)) out.add(hit);
  }
  return [...out];
}

/**
 * A fenced code/text block (a create/edit request's own literal file
 * content, e.g. "create X with the following content: ```...```") is never
 * natural-language request prose — splitting its lines as if they were
 * enumerated asks (observed regression: a `psm1` create-with-content query's
 * fence turned into four spurious topic items and blocked an otherwise
 * empty-frontier act.edit). Stripped before any other processing; this is a
 * blunter instrument than parsing the fence's own language, but a create
 * request's content obligation is already carried by `create_target`/
 * `provedCreate`, never by request-item extraction.
 */
function stripFencedBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, " ").replace(/`[^`\n]*`/gu, (m) => (m.length <= 40 ? m : " "));
}

export function extractRequestItems(rawQuery: string, index?: RequestItemIndexView): RequestItem[] {
  const query = stripFencedBlocks(rawQuery);
  const { lead, body } = splitLeadAndBody(query);
  /**
   * BLOCKER 54 (AB1, 2026-09-14, review round 11): KEEP the question clause.
   *
   * `splitLeadAndBody` exists to treat a leading question as CONTEXT for what
   * follows ("Why is the cache slow? Explain the TTL logic."), and for a vague
   * question that is right. But round 10 measured the cost when the question is
   * itself the substantive request: `extractRequestItems("What does MAX_RETRIES
   * do in src/retry.ts? Update the changelog.")` returned `["Update the
   * changelog."]` — the file and the identifier the caller actually asked about
   * were gone, `requestItemLeads` returned `[]`, BLOCKER 34's donation gate
   * never ran, and the generic query-named-file construction handed
   * `src/retry.ts` WRITE authority.
   *
   * Narrow by construction: the lead is kept only when it NAMES something of
   * its own — a file term or a code identifier. "Why is the cache slow?" names
   * neither ("cache" is not an identifier) and stays context, so every pinned
   * lead-as-context shape is unaffected; `LEAD_CLAUSE_BOUNDARY_RE` above then
   * gives the question and the imperative their own clause-local leads.
   */
  const leadTerms = lead.trim().length > 0 ? extractTerms(lead) : undefined;
  const leadCarriesOwnRequest = leadTerms !== undefined
    && (leadTerms.files.length > 0 || leadTerms.identifiers.length > 0);
  const itemSource = leadCarriesOwnRequest ? query : body;
  const globalTerms = extractTerms(query);
  const subjectSeeds = [...glossarySeeds(lead || query), ...extractTerms(lead).identifiers];

  const items: RequestItem[] = [];
  let counter = 0;
  const nextId = (): string => `ri-${++counter}`;

  const relationSpans: Array<{ start: number; end: number }> = [];

  const pushDefinition = (text: string, terms: ExtractedTerms): void => {
    const fileTerms = terms.files;
    const seedTerms = fileTerms.length > 0 ? fileTerms : [];
    const aliasSeeds = [...seedTerms, ...subjectSeeds, ...glossarySeeds(text), ...terms.identifiers];
    const aliases = aliasesFor(aliasSeeds, index);
    items.push({
      id: nextId(),
      text: text.trim(),
      kind: "definition",
      terms: [...new Set([...fileTerms, ...terms.identifiers])],
      aliases,
      bindable: fileTerms.length > 0 || aliases.length > 0,
    });
  };

  const pushDecision = (text: string, identifiers: readonly string[]): void => {
    const terms = [...new Set(identifiers)];
    const aliases = aliasesFor(terms, index);
    items.push({
      id: nextId(),
      text: text.trim(),
      kind: "decision",
      terms,
      aliases,
      bindable: terms.length > 0 || aliases.length > 0,
    });
  };

  const pushRelation = (text: string, consumerNoun: string): void => {
    const consumerTerms = extractTerms(consumerNoun);
    const localAliasSeeds = [consumerNoun, cleanNounPhrase(consumerNoun), ...glossarySeeds(consumerNoun), ...consumerTerms.all];
    const to = consumerTerms.all.length > 0 ? consumerTerms.all : [cleanNounPhrase(consumerNoun)];
    const from = globalTerms.identifiers.length > 0 ? [...new Set(globalTerms.identifiers)] : subjectSeeds;
    const aliases = aliasesFor(localAliasSeeds, index);
    items.push({
      id: nextId(),
      text: text.trim(),
      kind: "relation",
      terms: [...new Set([...to, ...from])],
      aliases,
      relation: { from, to },
      bindable: aliases.length > 0 || to.some(looksLikeFileTerm),
    });
  };

  const pushTopic = (text: string, terms: ExtractedTerms): void => {
    const aliases = aliasesFor([...terms.all, ...glossarySeeds(text)], index);
    items.push({
      id: nextId(),
      text: text.trim(),
      kind: "topic",
      terms: terms.all,
      aliases,
      bindable: terms.all.length > 0 || aliases.length > 0,
    });
  };

  // Pass 1 — relation-shaped clauses ("how|where ... reflect/use/apply/
  // pass/consume/affect/decide", JA "...への反映" family). An actor naming an
  // explicit code identifier is a DECISION about that identifier, not a
  // relation to a plain-English consumer; a noun-list actor with no
  // identifier splits into one relation item per noun (design §4.1's status
  // bar / update checker rows).
  for (const m of itemSource.matchAll(RELATION_CLAUSE_EN_RE)) {
    const start = m.index ?? 0;
    const actorText = m[1] ?? "";
    // R2-T2 (review-0929 P0-5): a coordinated noun-phrase conjunct in the
    // clause's OBJECT ("how X decides and the health probe") is not part of
    // this relation — the span stops before it, so Pass 2 sees the conjunct
    // and makes it its own point (`relationClauseEnd`).
    const sentenceStart = Math.max(...[".", "!", "?", ";", "\n", "。", "？", "！"].map((mark) => itemSource.lastIndexOf(mark, start - 1))) + 1;
    const clause = m[0].slice(0, relationClauseEnd(m[0], actorText, itemSource.slice(sentenceStart, start + m[0].length))).trimEnd();
    const end = start + clause.length;
    relationSpans.push({ start, end });
    const actorIdentifiers = extractTerms(actorText).identifiers;
    if (actorIdentifiers.length > 0) {
      pushDecision(clause, actorIdentifiers);
      continue;
    }
    for (const noun of splitNounList(actorText)) {
      if (isUsableNoun(noun)) pushRelation(clause, noun);
    }
  }
  for (const m of itemSource.matchAll(RELATION_CLAUSE_JA_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    relationSpans.push({ start, end });
    const actorText = m[1] ?? "";
    const actorIdentifiers = extractTerms(actorText).identifiers;
    if (actorIdentifiers.length > 0) {
      pushDecision(m[0], actorIdentifiers);
      continue;
    }
    for (const noun of splitNounList(actorText)) {
      if (isUsableNoun(noun)) pushRelation(m[0], noun);
    }
  }

  // Pass 2 — remaining enumerated segments (relation spans masked out).
  const masked = maskSpans(itemSource, relationSpans);
  // H-3 (2026-09-19, additive): a bare " and " joining two independent
  // question clauses ("Where is the shipping cost calculated and how are
  // invoices built?" — D3) is not caught by splitEnumerated's own
  // OXFORD-comma-only rule above (no preceding comma). See
  // `splitBareAndAtQuestionBoundary`'s own doc comment for the two-sided
  // test that keeps this from over-splitting an ordinary compound object.
  // R2-T2 (review-0929 P0-5): a coordinated noun-phrase conjunct is its own
  // point — see `splitCoordinatedNounPhrases`'s section comment. The pieces
  // of one split carry `coordinated` (set on whatever item each one pushes).
  const coordinatedSegments = new Set<string>();
  const pass2Segments = splitEnumerated(masked).flatMap(splitBareAndAtQuestionBoundary).flatMap((clause) => {
    const conjuncts = splitCoordinatedNounPhrases(clause);
    if (conjuncts.length > 1) for (const conjunct of conjuncts) coordinatedSegments.add(conjunct);
    return conjuncts;
  });
  const pass2Start = items.length;
  for (const segment of pass2Segments) {
    if (isGenericClosing(segment)) continue;
    // A negated instruction ("please do not modify anything", 「変更しないで
    // ください」) constrains a future edit; it asks for nothing, so it is no
    // item — its verb used to become a topic searched for and certified
    // absent (`request-item-absent:modify`, eval-0927 review-r4 P1-10).
    if (isNegatedInstructionClause(segment)) continue;
    const terms = extractTerms(segment);
    // NOTE (2026-09-07): a definition keyword WITHOUT any term ("the setting
    // definition", no file/key named) deliberately stays a `definition` item —
    // `proveRequestItem` resolves it through the workspace manifest, which is
    // what lets a query that names no file still fetch package.json before
    // closing (requestItemCompletion "no file names at all"). Prose that
    // merely contains a definition keyword but belongs to a checklist the
    // enumerated-item obligation (F-V14) already tracks is deferred to that
    // mechanism inside `proveRequestItem` (`ownedFacets`), not re-classified.
    // SHOULD-FIX 47 (2026-09-14, review round 9->10): an EDIT LEAD in this very
    // clause OUTRANKS the definition-keyword classification. `DEFINITION_KEYWORDS_RE`
    // lists the bare noun 設定 ("setting/configuration"), which is the right
    // reading for 「設定項目を説明して」 and the WRONG one for 「5 に設定して
    // ください」 -- and the two are the same substring. Round 9 measured the cost
    // precisely: of the six JA edit verbs in the byte-identical sentence
    // 「src/retry.ts の MAX_RETRIES の役割を説明し、5 に<verb>してください。」,
    // 変更/更新/修正/追加/削除 all reached `act.edit` with a writable frontier and
    // 設定 alone reached `discover` with an empty one -- because this clause was
    // classified `kind:"definition"` instead of `kind:"topic"`, the only
    // structural difference between the six inputs (finding 47).
    //
    // Asked CLAUSE-LOCALLY, and through the existing lead recognizer rather than
    // a new exception in the keyword regex: a clause that ends in an editing
    // imperative is a request to perform one, whatever nouns it also contains.
    // `itemReadsAsEditLead` is exactly the predicate the lead layer already
    // trusts for this (`EDIT_VERB_LEAD_RE` clause-initial for EN,
    // `EDIT_VERB_JA_ROOT_RE`/`EDIT_VERB_JA_NISHITE_RE` clause-final for JA, both
    // of which already require 設定/追加/削除 to carry an imperative or
    // continuative inflection -- SHOULD-FIX 42 -- so a BARE noun mention still
    // classifies as a definition exactly as before).
    if (DEFINITION_KEYWORDS_RE.test(segment) && !itemReadsAsEditLead(segment)) {
      pushDefinition(segment, terms);
      continue;
    }
    if (terms.identifiers.length > 0 && DECISION_KEYWORDS_RE.test(segment)) {
      pushDecision(segment, terms.identifiers);
      continue;
    }
    pushTopic(segment, terms);
  }
  for (const item of items.slice(pass2Start)) {
    if (coordinatedSegments.has(item.text)) item.coordinated = true;
  }

  return items;
}

// ---------------------------------------------------------------------------
// Real RequestItemIndexView backed by the actual workspace file listing
// (never fabricates a path — only files `enumerateFindTextUniverse` finds).
// ---------------------------------------------------------------------------

export interface WorkspaceIndexFiles {
  /** Workspace-relative POSIX paths, e.g. from `enumerateFindTextUniverse(workspace).files`. */
  relPaths: readonly string[];
}

/**
 * Builds a `RequestItemIndexView` over an already-enumerated file list, so
 * callers that already walked the workspace (readCodeTaskPack.ts almost
 * always has) do not pay for a second walk. `noun` and glossary-derived
 * seeds are matched against each file's basename via
 * `sharesSignificantSubstring`; a short `min` keeps common short seeds
 * (e.g. "bar", "check") usable without over-matching unrelated files
 * (still requires prefix/suffix containment or a >=5-char shared run).
 */
export function createRequestItemIndexView(files: WorkspaceIndexFiles): RequestItemIndexView {
  return {
    lookup(noun: string): string[] {
      const seeds = [noun, cleanNounPhrase(noun), ...glossarySeeds(noun)].filter((s) => s.trim().length > 0);
      if (seeds.length === 0) return [];
      const hits = new Set<string>();
      for (const relPath of files.relPaths) {
        const slash = relPath.lastIndexOf("/");
        const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;
        const stem = base.replace(/\.[A-Za-z0-9]+$/u, "");
        for (const seed of seeds) {
          if (sharesSignificantSubstring(seed, base, 5) || sharesSignificantSubstring(seed, stem, 5)) {
            hits.add(relPath);
            break;
          }
        }
      }
      return [...hits].sort();
    },
  };
}
