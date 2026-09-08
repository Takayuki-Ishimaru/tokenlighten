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

/** Words >= 4 chars, not stopwords — the pool a topic item's literal find scans for. */
export function salientWords(text: string): string[] {
  const words = text.match(/[A-Za-z0-9_]{4,}|[぀-ヿ一-鿿]{2,}/gu) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of words) {
    const key = raw.toLowerCase();
    if (/^[a-z0-9_]+$/u.test(key) && STOPWORDS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
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
  "テスト", // "test" (katakana loanword) — generic artifact-kind noun
  "ファイル", // "file" (katakana loanword) — generic artifact-kind noun
  "コード", // "code" (katakana loanword) — generic artifact-kind noun
  "システム", // "system" (katakana loanword) — generic scope noun
  "データ", // "data" (katakana loanword) — generic content noun
]);

/** True when `word` (a `salientWords`/`isCjkRun` CJK candidate) is on the short generic-Japanese absence-disclosure exclusion list above. */
export function isGenericJapaneseAbsenceTerm(word: string): boolean {
  return GENERIC_JA_ABSENCE_WORDS.has(word);
}

// ---------------------------------------------------------------------------
// Term extraction
// ---------------------------------------------------------------------------

const FILE_EXT_RE = /\b[A-Za-z0-9_.-]+\.(?:json|ts|tsx|js|jsx|mjs|cjs|md|mdx|py|java|go|rs|rb|toml|ya?ml|c|h|cpp|hpp|cs|kt|swift)\b/gu;
const DOTTED_KEY_RE = /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/gu;
const LOWER_CAMEL_RE = /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu;
const UPPER_CAMEL_RE = /\b[A-Z][a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/gu;
const CONST_CASE_RE = /\b[A-Z][A-Z0-9_]{2,}\b/gu;
const QUOTED_RE = /[`"']([^`"']{2,})[`"']/gu;

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
  for (const m of segment.matchAll(FILE_EXT_RE)) { files.add(m[0]); all.add(m[0]); }
  for (const m of segment.matchAll(DOTTED_KEY_RE)) {
    // A dotted "key.ext"-shaped match already counted as a FILE (package.json,
    // language.ts, ...) is not also a code identifier — the two patterns
    // overlap by construction, and a relation's `from` must not fill with the
    // file name it is itself supposed to be evidenced by.
    if (files.has(m[0])) continue;
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

function isGenericClosing(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0
    || PUNCTUATION_ONLY_RE.test(trimmed)
    || GENERIC_CLOSING_EN_RE.test(trimmed)
    || GENERIC_CLOSING_JA_RE.test(trimmed);
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
  return normalized
    .split(/[,;、，\n]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  for (const m of body.matchAll(RELATION_CLAUSE_EN_RE)) {
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
  for (const m of body.matchAll(RELATION_CLAUSE_JA_RE)) {
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
  const masked = maskSpans(body, relationSpans);
  for (const segment of splitEnumerated(masked)) {
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
    if (DEFINITION_KEYWORDS_RE.test(segment)) {
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
