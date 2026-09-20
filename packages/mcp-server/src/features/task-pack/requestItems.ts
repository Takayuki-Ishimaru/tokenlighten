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
  const seeds = new Set<string>();
  for (const [pattern, words] of GLOSSARY_SEEDS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) for (const w of words) seeds.add(w);
  }
  return [...seeds];
}

// ---------------------------------------------------------------------------
// Stopwords / salient words (contract §3.3: topic-item literal find over
// salient words, >=4 chars, not stopwords, EN/JA)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "from", "into", "onto", "your",
  "their", "there", "where", "which", "about", "explain", "describe",
  "please", "what", "does", "how", "when", "and", "the", "for", "are", "was",
  "were", "have", "has", "had", "not", "you", "our", "its",
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
    return isGenericJapaneseAbsenceRun(run) ? [] : [run];
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

/** Words >= 4 chars, not stopwords — the candidate pool this scans over. */
const SALIENT_WORD_RE = /[A-Za-z0-9_]{4,}|[぀-ヿ一-鿿]{2,}/gu;

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
   * `search_files{queries:["increase"]}` — sending the caller to grep the
   * workspace for the word they used to ask for the change. Same leak, same
   * predicate, one consumer over.
   *
   * Blanking is length-preserving, so `quotedSpans` above (computed on the
   * ORIGINAL text) keeps its indices, and only the scan below reads the blanked
   * copy. A clause that names any real object — `explain how route handlers work`
   * — is not object-free and is untouched, so ordinary nouns that happen to
   * spell a mutation verb stay searchable.
   */
  const scanned = stripValueOnlyLeadClauses(text);
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

/** True when `word` (a `salientWords`/`isCjkRun` CJK candidate) is on the short generic-Japanese absence-disclosure exclusion list above, or is a bare JA request verb. */
export function isGenericJapaneseAbsenceTerm(word: string): boolean {
  return GENERIC_JA_ABSENCE_WORDS.has(word) || genericJaRequestVerbs().has(word);
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
const DOTTED_KEY_RE = /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/gu;
const LOWER_CAMEL_RE = /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu;
const UPPER_CAMEL_RE = /\b[A-Z][a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu;
const CONST_CASE_RE = /\b[A-Z][A-Z0-9_]{2,}\b/gu;
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
  /** Terms that look like a code identifier (camelCase/PascalCase/CONST_CASE/backticked). */
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

  return { all: [...all], files: [...files], identifiers: [...identifiers] };
}

export function looksLikeFileTerm(term: string): boolean {
  return /\.[A-Za-z0-9]{1,6}$/u.test(term);
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
const READ_VERB_LEAD_EN_RE = /^[\s\-*•]*(?:explain|describe|tell me(?:\s+about)?|clarify)\b/iu;
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

function splitLeadAndBody(query: string): { lead: string; body: string } {
  // Only ?/？/!/！ end a "lead" clause, exactly like the ASCII-only path:
  // a plain 。/． (JA/fullwidth periods) is EXCLUDED for the same reason ASCII
  // "." always was (too often just a statement terminator, not a question/
  // exclamation boundary; JA prose ends ordinary sentences in 。, so treating
  // it as a lead-ender discarded a whole substantive leading sentence as
  // "context" for any multi-sentence JA request -- see requestItemCompletion
  // "JA lead swallows first sentence" case).
  const m = /^(.*?[?？!！])\s*([\s\S]*)$/u.exec(query.trim());
  if (m && m[2] !== undefined && m[2].trim().length > 0) {
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
  const primary = normalized
    .split(/[,、，\n]+/u)
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
const JA_QUESTION_END_RE = /(?:か|[?？])\s*$/u;

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
const BARE_AND_RE = /\s+and\s+/giu;

/** Splits `segment` at every bare " and " boundary that satisfies the two-sided independent-question test above; returns `[segment]` unchanged when none does. Recurses into the tail so "A? and B? and C?" splits at every qualifying boundary, not just the first. */
function splitBareAndAtQuestionBoundary(segment: string): string[] {
  BARE_AND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BARE_AND_RE.exec(segment)) !== null) {
    const before = segment.slice(0, m.index).trim();
    const after = segment.slice(m.index + m[0].length).trim();
    if (before.length === 0 || after.length === 0) continue;
    if (EN_INTERROGATIVE_HEAD_RE.test(after) && isIndependentQuestionClause(before)) {
      return [before, ...splitBareAndAtQuestionBoundary(after)];
    }
  }
  return [segment];
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
  for (const segment of splitEnumerated(masked).flatMap(splitBareAndAtQuestionBoundary)) {
    if (isGenericClosing(segment)) continue;
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
