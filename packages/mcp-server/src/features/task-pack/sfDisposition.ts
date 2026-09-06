// Verb vocabulary for structural concern DISPOSITION (plan §3.6.1 rule 5).
//
// THIS TABLE CREATES NO CONCERNS. It decides only what the caller wants DONE
// with a concern that some structural rule (explicit target, qualified anchor,
// symbol index, path anchor) already grounded. If nothing grounds, a verb on
// its own produces nothing at all — that is decision D3, and it is the whole
// reason engagement stopped depending on how a request is phrased.
//
// Adding a language is a data edit here and nowhere else.

/**
 * What to do with a concern. `answer` is the read-only sibling of `edit`: the
 * caller asked to be told, not to have the workspace changed. The IR domain
 * type (`ObligationNode.disposition`) carries the four planned values, so
 * `answer` maps to `review` on its way into the obligation graph — see
 * `obligationDisposition`.
 */
export type SfDisposition = "edit" | "review" | "verify" | "measure" | "answer";

/** Dispositions as `ObligationNode.disposition` spells them (plan §3.2.1). */
export type SfObligationDisposition = "edit" | "review" | "verify" | "measure";

interface VerbEntry {
  readonly term: string;
  readonly disposition: SfDisposition;
  /**
   * The `wire`/`配線` family (edit-shaped) and the `call`/`invoke`/`usage`/
   * `reference`/`呼ぶ`/`参照` family (review-shaped, FX-V4): both also open a
   * relation concern (plan §3.6.1).
   */
  readonly relational?: boolean;
  /** ASCII terms match on word boundaries; CJK terms match as substrings. */
  readonly ascii: boolean;
  /**
   * §6 regression fix (round-23, "zero false edit" pin). An ASCII entry
   * flagged `nounGuard` is one of the small set of EN words that is equally
   * common as a bare noun ("the update log", "an API call", "a reference
   * implementation", "the test plan") as it is as an imperative verb
   * ("update the file", "check the config"). The distinguishing signal used
   * here — cheap, no POS tagger — is whether a determiner (a/an/the/this/
   * that/these/those/some/any) sits within the two tokens immediately
   * BEFORE the match: verb (imperative) usage is not preceded by an article
   * this closely ("update the file" has nothing before "update"; "an API
   * call happens" has "an" two tokens back from "call"), while every noun
   * usage above does. See `precedingHasDeterminer`.
   */
  readonly nounGuard?: boolean;
  /**
   * §6 regression fix. A CJK entry flagged `cjkNounGuard` is a verb STEM
   * that is also a common compound-noun head/modifier when immediately
   * followed by another kanji character: 追加情報 ("additional
   * information"), 接続文字列 ("connection string") are nouns, not requests,
   * while 追加して/追加する and 接続して/接続する — the stem followed by
   * hiragana okurigana — are the genuine verb conjugations. Matching is
   * substring-based for CJK (no tokenizer), so this is the cheap in-band
   * signal: reject only when the very next character is itself a kanji
   * ideograph (compound-noun formation); accept otherwise (hiragana,
   * katakana, ASCII, punctuation, or end of string all indicate the stem is
   * NOT swallowed into a longer noun). See `followedByKanji`.
   */
  readonly cjkNounGuard?: boolean;
}

const ascii = (
  term: string,
  disposition: SfDisposition,
  relational = false,
  nounGuard = false,
): VerbEntry => ({ term, disposition, relational, ascii: true, nounGuard });
const cjk = (
  term: string,
  disposition: SfDisposition,
  relational = false,
  cjkNounGuard = false,
): VerbEntry => ({ term, disposition, relational, ascii: false, cjkNounGuard });

/**
 * Ordered vocabulary. Order inside a disposition is the tie-break when two
 * terms of the same disposition start at the same offset; it never decides
 * BETWEEN dispositions (`DISPOSITION_RANK` does).
 */
const VERBS: readonly VerbEntry[] = Object.freeze([
  // edit
  ascii("fix", "edit"), ascii("fixes", "edit"), ascii("fixing", "edit"),
  ascii("repair", "edit"), ascii("change", "edit"), ascii("modify", "edit"),
  ascii("add", "edit"), ascii("remove", "edit"), ascii("delete", "edit"),
  ascii("rename", "edit"), ascii("implement", "edit"), ascii("migrate", "edit"),
  ascii("refactor", "edit"), ascii("patch", "edit"),
  // "update" is nounGuard: "the update log needs review" is a noun phrase,
  // not a request (§6 regression).
  ascii("update", "edit", false, true),
  ascii("updates", "edit"),
  ascii("wire", "edit", true), ascii("wiring", "edit", true),
  ascii("connect", "edit", true), ascii("hook up", "edit", true),
  cjk("修正", "edit"), cjk("直す", "edit"), cjk("直し", "edit"),
  cjk("修理", "edit"), cjk("変更", "edit"),
  // "追加" is cjkNounGuard: "追加情報" ("additional information") is a
  // compound noun, not a request; "追加して"/"追加する" still match (§6).
  cjk("追加", "edit", false, true),
  cjk("削除", "edit"), cjk("リネーム", "edit"), cjk("改名", "edit"),
  cjk("実装", "edit"), cjk("移行", "edit"), cjk("更新", "edit"),
  cjk("リファクタ", "edit"),
  cjk("配線", "edit", true),
  // "接続" is cjkNounGuard: "接続文字列" ("connection string") is a compound
  // noun, not a request; "接続して"/"接続する" still match (§6).
  cjk("接続", "edit", true, true),
  cjk("繋ぐ", "edit", true),
  // verify
  ascii("verify", "verify"), ascii("validate", "verify"),
  // "test" and "check" are nounGuard: "the test plan is ready" / "a quick
  // check of the docs" are noun phrases, not requests (§6 regression).
  ascii("test", "verify", false, true),
  ascii("check", "verify", false, true),
  ascii("prove", "verify"), ascii("reproduce", "verify"),
  cjk("検証", "verify"), cjk("テスト", "verify"), cjk("確認", "verify"),
  cjk("再現", "verify"), cjk("検査", "verify"),
  // measure
  ascii("measure", "measure"), ascii("benchmark", "measure"), ascii("bench", "measure"),
  ascii("profile", "measure"), ascii("count", "measure"),
  cjk("計測", "measure"), cjk("測定", "measure"), cjk("ベンチ", "measure"),
  // Stem, not dictionary form: JA verbs inflect (数える / 数えて / 数えた) and a
  // substring match on the stem covers the conjugations without a morphology
  // table. Every CJK entry below follows the same rule.
  cjk("数え", "measure"),
  // answer
  ascii("explain", "answer"), ascii("explanation", "answer"),
  cjk("説明", "answer"), cjk("教えて", "answer"),
  // review
  ascii("why", "review"), ascii("how", "review"), ascii("describe", "review"),
  ascii("compare", "review"), ascii("audit", "review"), ascii("investigate", "review"),
  cjk("なぜ", "review"), cjk("どう", "review"), cjk("比較", "review"),
  cjk("監査", "review"), cjk("調査", "review"),
  // FX-V4 (round-19 finding, plan §0.2 D3/§0.3): the relation-lookup family —
  // "who calls X" / "callers of X" / "X を呼ぶ箇所" — is a request to be TOLD
  // about a relation, not to change or explain the workspace, so it is
  // review-shaped like why/how/describe above; `relational:true` is what
  // actually opens the rule-5 relation concern (plan §3.6.1). Longer/more
  // specific forms are listed before their shorter stems only for reading
  // order — `detectDisposition` picks the earliest offset among same-rank
  // matches, and ASCII word-boundary matching already keeps "call" from
  // matching inside "called"/"caller"/"callers"/"calls", so no entry here
  // shadows another.
  ascii("callers", "review", true), ascii("caller", "review", true),
  ascii("calls", "review", true), ascii("called", "review", true),
  // bare "call" is nounGuard: "an API call happens here" is a noun phrase,
  // not a relation lookup (§6 regression) — "who calls X"/"call X" (no
  // preceding determiner) still match.
  ascii("call", "review", true, true),
  ascii("invocation", "review", true), ascii("invokes", "review", true),
  ascii("invoked", "review", true), ascii("invoke", "review", true),
  ascii("usages", "review", true), ascii("usage", "review", true),
  ascii("used by", "review", true), ascii("uses", "review", true),
  ascii("references", "review", true), ascii("referenced", "review", true),
  // bare "reference" is nounGuard: "a reference implementation exists" is a
  // noun phrase, not a relation lookup (§6 regression).
  ascii("reference", "review", true, true),
  // JA stems: substring match already covers conjugated/compound forms, e.g.
  // 呼び出し covers 呼び出し元/呼び出しの箇所, so no separate entry is needed
  // for those.
  cjk("呼び出す", "review", true), cjk("呼び出し", "review", true),
  cjk("呼ばれる", "review", true), cjk("呼ぶ", "review", true),
  cjk("利用箇所", "review", true), cjk("使用箇所", "review", true),
  cjk("参照", "review", true),
]);

/**
 * Which disposition wins when a request carries several. An actionable request
 * dominates a descriptive one: "explain how to fix X" is a fix request whose
 * author would also like it explained, and `profile:"answer"` — not this table
 * — is what forbids the edit when the caller declared a read-only task.
 */
const DISPOSITION_RANK: Readonly<Record<SfDisposition, number>> = Object.freeze({
  edit: 0,
  verify: 1,
  measure: 2,
  answer: 3,
  review: 4,
});

export interface SfVerbMatch {
  readonly disposition: SfDisposition;
  /** The matched vocabulary term, verbatim from the table (never caller text). */
  readonly term: string;
  /** First offset in the query at which the term matched. */
  readonly index: number;
  /**
   * FX-W2 (round-21B finding 2, root cause part B). True when ANY vocabulary
   * term matched anywhere in the query is relational — an OR over every
   * match, not just the winning `disposition`/`term`. Before this fix, a
   * relational term (`callers`, `呼び出し`, ...) that lost the disposition
   * tie-break to a higher-ranked or earlier non-relational verb (`explain`,
   * `why`, `describe`, ...) was discarded entirely: "explain the callers of
   * X" and "why is X called" matched a relational term but reported
   * `relational: false`, so rule (5) below never opened a relation concern —
   * the exact phrasing-dependence decision D3 exists to eliminate, for the
   * relation-lookup family specifically. The winning `disposition`/`term`/
   * `index` are UNCHANGED by this: "fix the callers of X" still disposes as
   * `edit`/"fix" (an actionable request still dominates), it just also
   * reports `relational: true` because "callers" matched somewhere in the
   * query.
   */
  readonly relational: boolean;
}

/** §6 regression fix: determiners that mark the following ASCII term as a noun. */
const DETERMINERS: ReadonlySet<string> = new Set([
  "a", "an", "the", "this", "that", "these", "those", "some", "any",
]);

/**
 * True when a determiner (a/an/the/...) appears among the two ASCII word
 * tokens immediately before `matchStart` in `text` — the signal `nounGuard`
 * entries use to reject a bare-noun use ("an API call", "the update log").
 * Imperative/verb usage is not preceded by an article this closely: "update
 * the file" has nothing before "update"; "what does call do" has "what
 * does", neither a determiner.
 */
function precedingHasDeterminer(text: string, matchStart: number): boolean {
  const before = text.slice(0, matchStart);
  const tokens = before.split(/[^A-Za-z']+/).filter((t) => t.length > 0);
  const lastTwo = tokens.slice(-2);
  return lastTwo.some((t) => DETERMINERS.has(t.toLowerCase()));
}

/**
 * True when the very next word after `matchEnd` in `text` is "to" — the
 * idiom "a call to X" / "a reference to X" pairs a determiner with the noun
 * form of `call`/`reference` while still meaning a genuine relation lookup
 * ("make a call to isHealthy", "find a reference to isHealthy"), unlike the
 * bare-noun uses `nounGuard` exists to reject ("an API call happens", "a
 * reference implementation exists" — neither followed by "to"). Checked only
 * as an EXCEPTION to `precedingHasDeterminer`, never on its own.
 */
function followedByTo(text: string, matchEnd: number): boolean {
  const after = text.slice(matchEnd);
  return /^\s+to(?![A-Za-z0-9_])/i.test(after);
}

/**
 * True when the character right after `index` in `text` is itself a CJK
 * ideograph — the signal `cjkNounGuard` entries use to reject a verb STEM
 * swallowed into a longer compound noun (追加情報, 接続文字列). A genuine
 * conjugation (追加して, 接続する) is followed by hiragana, not another
 * kanji, so it is unaffected.
 */
function followedByKanji(text: string, index: number): boolean {
  const ch = text[index];
  return ch !== undefined && ch >= "\u4E00" && ch <= "\u9FFF";
}

function matchIndex(query: string, entry: VerbEntry): number {
  if (!entry.ascii) {
    if (!entry.cjkNounGuard) return query.indexOf(entry.term);
    let from = 0;
    for (;;) {
      const index = query.indexOf(entry.term, from);
      if (index < 0) return -1;
      if (!followedByKanji(query, index + entry.term.length)) return index;
      from = index + entry.term.length;
    }
  }
  const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])(${escaped})(?![A-Za-z0-9_])`, "giu");
  for (;;) {
    const found = re.exec(query);
    if (found === null) return -1;
    const index = found.index + found[0]!.length - found[1]!.length;
    const isBareNoun = entry.nounGuard
      && precedingHasDeterminer(query, index)
      && !followedByTo(query, index + entry.term.length);
    if (!isBareNoun) return index;
    if (re.lastIndex === found.index) re.lastIndex += 1;
  }
}

/**
 * FX-W2 (round-21B finding 3, LOW). Blanks the CONTENTS of every
 * single-quoted, double-quoted, or backtick-delimited span in `query` —
 * preserving length and every character outside a span, so an offset found
 * on the masked text still addresses the original query — so a word inside
 * quotes (a literal identifier the caller is asking about BY NAME, e.g.
 * `find the symbol named "call" near isHealthy`) cannot itself masquerade as
 * a relational verb match. Same-line only, backslash-escape aware; an
 * unterminated quote is left alone rather than swallowing the rest of the
 * query, matching `sfCodeMask.ts`'s own convention for the identical hazard
 * in source text.
 *
 * NOT a reuse of `sfCodeMask.ts`'s `maskCommentsAndStrings`: that masker also
 * blanks `//`/`#`/`--`-style line comments, block comments, docstrings, and
 * regex literals — source-code conventions that misfire on ordinary prose. A
 * query containing a URL (`.../callers`, whose scheme carries a bare `//`) or
 * using `--` as em-dash-style punctuation would lose everything after it,
 * which would delete the very relational term this fix exists to preserve.
 * This masker is deliberately narrower: quoted spans only.
 */
/**
 * Round-22B finding 4 (LOW, 2026-09-04): delimiter -> closer map. ASCII
 * quotes are symmetric (the closer IS the opener); JA full-width brackets and
 * Western "curly"/smart quotes are asymmetric PAIRS — a common JA convention
 * for quoting a literal term (`「call」`) that the ASCII-only version of this
 * function did not recognize at all, leaving the quoted term free to open a
 * spurious (harmless, non-blocking, since `relational` never sets `required`)
 * relation concern for JA users using their own language's idiomatic quoting.
 */
const QUOTE_CLOSERS: Readonly<Record<string, string>> = Object.freeze({
  "\"": "\"",
  "'": "'",
  "`": "`",
  "「": "」",
  "『": "』",
  "“": "”", // “ ”
  "‘": "’", // ‘ ’
});

function maskQuotedSpans(query: string): string {
  if (query === "") return query;
  const chars = query.split("");
  let index = 0;
  while (index < query.length) {
    const ch = query[index]!;
    const closer = QUOTE_CLOSERS[ch];
    if (closer !== undefined) {
      let end = index + 1;
      let closed = false;
      while (end < query.length) {
        const c = query[end]!;
        if (c === "\n") break;
        if (c === "\\") {
          end += 2;
          continue;
        }
        if (c === closer) {
          closed = true;
          break;
        }
        end += 1;
      }
      if (closed) {
        for (let i = index; i <= end; i += 1) chars[i] = " ";
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return chars.join("");
}

/**
 * The disposition `query` asks for, or `undefined` when no vocabulary term
 * appears. Deterministic: strongest disposition first, then earliest offset,
 * then table order. `relational` is an OR over every matched term in the
 * query (FX-W2) — see `SfVerbMatch.relational`'s own doc comment. Quoted
 * spans are masked before matching (FX-W2 finding 3) so a quoted identifier
 * can never itself supply a match.
 */
export function detectDisposition(query: string): SfVerbMatch | undefined {
  const masked = maskQuotedSpans(query);
  let bestDisposition: SfDisposition | undefined;
  let bestTerm = "";
  let bestIndex = -1;
  let anyRelational = false;
  for (const entry of VERBS) {
    const index = matchIndex(masked, entry);
    if (index < 0) continue;
    if (entry.relational === true) anyRelational = true;
    if (bestDisposition === undefined) {
      bestDisposition = entry.disposition;
      bestTerm = entry.term;
      bestIndex = index;
      continue;
    }
    const rank = DISPOSITION_RANK[entry.disposition] - DISPOSITION_RANK[bestDisposition];
    if (rank < 0 || (rank === 0 && index < bestIndex)) {
      bestDisposition = entry.disposition;
      bestTerm = entry.term;
      bestIndex = index;
    }
  }
  if (bestDisposition === undefined) return undefined;
  return { disposition: bestDisposition, term: bestTerm, index: bestIndex, relational: anyRelational };
}

/** How a disposition is spelled in `ObligationNode.disposition` (plan §3.2.1). */
export function obligationDisposition(disposition: SfDisposition): SfObligationDisposition {
  return disposition === "answer" ? "review" : disposition;
}
