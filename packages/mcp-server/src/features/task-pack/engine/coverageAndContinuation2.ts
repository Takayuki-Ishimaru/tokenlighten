// coverageAndContinuation — extracted implementation; imports point to the owning modules.
import { MUTATION_VERBS_EN } from "../requestItems.js";

// ---------------------------------------------------------------------------
// Item 3 (answer/explain routing): a query that only asks the agent to
// EXPLAIN/DESCRIBE something must not route as if an edit were expected —
// "edit_from_handles" reads as an instruction to go change code. Shared by
// buildRoute's every "the pack is done, nothing required is missing" branch
// (the route assembly is shared by both buildTaskPack and
// buildSeededTaskPack), so both flows get the same relabeling for free.
// ---------------------------------------------------------------------------

/**
 * Conservative English+Japanese marker lists. English markers are matched at
 * word boundaries (`\b`) so "add" cannot fire inside "address"; Japanese
 * markers are matched as plain substrings ("\b" is meaningless for non-\w
 * CJK text in JS regex — there is no word-boundary concept to anchor on).
 */
export const REFERENCE_ANSWER_EN_RE = /\bfind\s+all\s+references?\b/i;

export const REFERENCE_ANSWER_JA_RE = /全参照/u;

export const ANSWER_INTENT_EN_RE = /\b(explain|describe|assess|trace|determine|investigate|why|how does|what happens|what conditions|when (?:does|do|is|are|must|should|can|will)|walk (?:me )?through|where (?:is|are|does|do|did|was|were)|what (?:is|are|does|do|did)|which (?:file|files|function|functions|class|classes|module|modules|method|methods)|understand(?:ing)?|overview|summar(?:y|ies|ize[sd]?|ise[sd]?|izing|ising)|clarify|tell me|show me (?:how|where|what|which)|how (?:is|are|do|did|can|would|should|were|was)|which \w+ (?:does|do|is|are|gets?|selects?|chooses?|uses?|handles?|calls?|owns?))\b/i;

// Descriptive JA noun phrases (「Xの実装」「Xの役割」) ask ABOUT code; request
// forms use を/へ/に/として and are caught by REQUESTED_MUTATION_JA_NOUN_RE
// first (classifyTaskProfile reaches the answer branch only when no mutation
// intent matched), so 「実装」 here cannot flip an actual implement-request.
export const ANSWER_INTENT_JA_NOUN_RE = /の(?:実装|定義|役割|仕組み|使い方|場所|中身|挙動|意味|目的)/;

export const ANSWER_INTENT_JA: readonly string[] = [
  "説明", "解説", "要約", "なぜ", "どういう", "挙動",
  // 2026-08-01 probe sweep: JA interrogatives were unrepresented, so 「教えて
  // ください」/「〜ですか」-shaped questions fell to the no-marker generic
  // fallback and received edit-imperative certificates. Mutation intent is
  // checked FIRST, so 「修正してもらえますか」 still classifies as a change.
  "教えて", "ですか", "でしょうか", "どこ", "何のため",
  // 2026-08-21 §14 tiered-guardrail wave (issue #1): comprehension-shaped
  // read-only asks (「〜を理解したい」「pipelineがどのcodecを選ぶか」) carried
  // none of the markers above, so classifyTaskProfile never even reached its
  // answer branch. bindTaskProfile (below) now honors every inferred
  // "answer" unless hasDefectSymptomMarker also matches the query.
  "理解", "知りたい", "把握", "どの", "どれ", "どのように", "どうやって", "どんな",
  "流れ", "概要", "全体像", "一覧", "何が", "何を", "どこで",
  // 2026-10-10: 「…を示してください」「…を見せてください」 ask to be SHOWN
  // something; with no marker they fell to generic and certified act.edit.
  "示して", "見せて",
];

export const ANALYSIS_INTENT_EN_RE = /\b(?:analy[sz]e|analysis|review|inspect|check|verify|validate|audit|recommend|recommendation|proposal|propose|measure|measurement|evaluate|evaluation|benchmark(?:ing)?|compare|comparison|metrics?|rate|ratio|percentage)\b/i;

export const ANALYSIS_INTENT_JA: readonly string[] = [
  "分析", "確認", "調査", "診断", "検証", "測定", "計測", "評価", "比較", "割合", "性能", "メトリクス", "ベンチ", "提案", "改善案", "向上案",
];

// 2026-10-02 (Copilot retest r3): the declarations Copilot users actually write
// — "Do not modify files or run terminal commands", "don't change any code",
// "without modifying the code" — matched none of the "no changes" forms, so a
// paraphrased read-only question lost its no-edit signal. Only a whole-work
// object counts (files / code / anything / the codebase, repo, workspace,
// sources), and only when no scope follows it: "don't change the public API"
// and "do not modify files under vendor/" constrain an edit, they do not
// declare a read-only task (hasWiringIntentMarker bails on ANY match here).
// Review (2026-10-02): nor does "don't change anything ELSE" -- that scopes the
// edit the same sentence asks for ("Make quote() round half up; don't change
// anything else") -- nor an object followed by a possessive or a relative clause.
export const EXPLICIT_NO_EDIT_EN_RE = /\b(?:no|without)\s+(?:code\s+)?(?:changes?|edits?|implementation)(?:\s+(?:are\s+)?(?:needed|required))?\b|\b(?:(?:do\s+not|don['’]?t|never)\s+(?:modify|change|edit|touch|alter)|without\s+(?:modifying|changing|editing|touching|altering))\s+(?:any\s+)?(?:files?|code|anything|the\s+(?:code(?:base)?|files?|repo(?:sitory)?|workspace|sources?))\b(?!['’]s\b)(?!\s+(?:else|but|under|in|inside|outside|within|of|from|except|other(?:\s+than)?|apart\s+from|aside\s+from|unrelated|related|besides|beyond|below|above|at|that|which|who|where)\b)/gi;

export const EXPLICIT_NO_EDIT_JA_RE = /(?:コードの?)?(?:変更|修正|追加|実装|編集|改変)(?:は|が)?(?:不要|なし|要らない|いらない|しない)/g;

export const ARTIFACT_BUILD_INTENT_EN_RE = /\b(?:implement|add|build|create|generate|update|change|fix|refactor)\b/i;

export const ARTIFACT_BUILD_INTENT_JA: readonly string[] = ["実装", "追加", "作成", "生成", "変更", "修正"];

export const ARTIFACT_BUILD_REFERENCE_EN_RE = /\b(?:spreadsheet|xlsx|workbook|sheet|table|document|docx|pptx|pdf|artifact)\b/i;

// 「表」 names a table only as a word of its own (料率表, 一覧表, 表に追加, 表計算):
// as a bare substring it also matched 表示/表現/表記/表明/表面 and 代表/発表/
// 公表, so a Japanese fix request that merely mentioned the display (表示)
// classified as artifact_build and inlined an unrelated workbook (2026-10-10,
// a pasted review asking to fix the reported issues).
export const ARTIFACT_BUILD_REFERENCE_JA_RE = /スプレッドシート|資料|シート|(?<![代発公辞])表(?![示現記明面情彰層裏出])/u;

export const WIRING_INTENT_EN_RE = /\b(?:wire|connect|integrate|plumb|route|propagate|feed|forward|expose)\b/i;

export const WIRING_INTENT_JA: readonly string[] = [
  "接続", "連携", "配線", "結線", "組み込", "組み入れ", "流し込", "受け渡", "反映させ",
];

// Auto mode cannot delegate semantic intent classification to a model.  Its
// fallback therefore recognizes a REQUEST-SHAPED predicate, not a bag of
// words: the mutation action must be imperative/modal (English) or carry a
// request/volitional ending (Japanese).  Mentioning "fix", "connect", or
// "実装" as a report label or analysis topic is insufficient.
// SHOULD-FIX 44 (2026-09-14, review round 8): a clause-initial mutation verb
// immediately followed by a colon can be a memo/prose LABEL/HEADING ("Update:
// explain how MAX_RETRIES works in src/retry.ts.") rather than an imperative.
// SHOULD-FIX 46 (2026-09-14, review round 9->10): round 8's guard was a bare
// `(?!\s*:)`, which discarded the whole conventional-commit / ticket register --
// `Update: MAX_RETRIES in src/retry.ts to 5.`, `Fix: src/retry.ts retries
// forever.`, `Rename: shouldRetry -> canRetry in src/retry.ts.`,
// `Create: src/newfile.ts with a default export.` all stopped reading as
// mutation requests (measured: lead `read`, `discover`, empty frontier, while
// each one's colon-less twin reached `act.edit` with a writable frontier). The
// colon is not the signal; what FOLLOWS it is. Discount it only when it
// introduces a READ request, which is the actual difference between a heading
// and an imperative. Shared spelling with requestItems.ts's
// `COLON_INTRODUCES_READ_LEAD` (mirrored, not imported: that module's own regex
// is clause-initial-anchored and separately pinned).
export const COLON_INTRODUCES_READ_REQUEST = "(?!\\s*:\\s*(?:please\\s+)?(?:explain|describe|clarify|summar|tell\\s+me|show\\s+me|why|how|what|which)\\b)";

// SHOULD-FIX 55 (AB1, 2026-09-14, review round 11): IMPORTED, not restated.
// This list and `MIXED_INTENT_MUTATION_EN_RE`'s (below) were two hand-maintained
// alternations in this one file that had to agree and did not: this one omitted
// `set`, `bump`, `remove`, `delete`, `modify`, `increase`, `decrease`, `switch`,
// `toggle`, `enable`, `disable` and `insert`, so `What does MAX_RETRIES do in
// src/retry.ts? Set it to 5.` carried no requested-mutation signal at all and
// reached a certified read-only `act.answer`. One declaration now lives in
// `requestItems.ts` (see `MUTATION_VERBS_EN` there) and both predicates read it.
export const REQUESTED_MUTATION_EN_RE = new RegExp(
  // A "." opens a clause only when whitespace (or the end of the text) follows it: the dot of a
  // member access (`Context.forward`, `res.set`, `cache.update`) is not a sentence end.
  `(?:^|[\\n!?;:]\\s*|\\.(?:\\s+|$)|\\bthen\\s+)(?:[①②③④⑤⑥⑦⑧⑨⑩]|\\(?\\d{1,2}[.)])?\\s*(?:please\\s+)?(?:using\\b[^,\\n]{0,80},\\s*)?(?:${MUTATION_VERBS_EN})\\b${COLON_INTRODUCES_READ_REQUEST}`
  + `|\\b(?:please|must|should|need(?:s)?\\s+to|want(?:s)?\\s+(?:you\\s+)?to|can\\s+you|could\\s+you|would\\s+you)\\b[^.!?\\n]{0,100}\\b(?:${MUTATION_VERBS_EN})\\b${COLON_INTRODUCES_READ_REQUEST}`,
  "i",
);

export const REQUESTED_MUTATION_EN_CONDITIONAL_RE = /\b(?:when|if|after|once|while|where)\b[^.!?\n,]{0,160},\s*(?:please\s+)?(?:fix|add|implement|change|replace|rename|refactor|wire|connect|integrate|plumb|route|propagate|feed|forward|expose|create|generate|update)\b/i;

export const REQUESTED_MUTATION_EN_RELATION_RE = /\b(?:and|then)\s+(?:please\s+)?(?:(?:wire|connect|integrate|plumb|route|propagate|feed|forward|expose)\s+[^,.;\n]{1,100}\s+(?:to|into|with|through)\b|rename\s+[^,.;\n]{1,80}\s+to\s+[^,.;\n]+)/i;

export const REQUESTED_MUTATION_JA_RE = /(?:修正|追加|実装|変更|置換|改名|リファクタ|接続|連携|配線|結線|組み込|組み入れ|流し込|受け渡|反映|作成|生成)(?:を)?(?:してください|して下さい|してほしい|して欲しい|したい|しろ|せよ|をお願いします|を行って(?:ください|下さい)?)|直(?:してください|して下さい|してほしい|して欲しい|したい|せ|す)|(?:修正|追加|実装|変更|接続|連携|作成|生成)(?:して)?(?:もらえますか|いただけますか)/;

export const REQUESTED_MUTATION_JA_LINE_RE = /(?:^|\n)[^\n]{0,180}(?:を|へ|に)[^\n]{0,40}(?:修正|追加|実装|変更|置換|改名|リファクタ|接続|連携|配線|結線|組み込|組み入れ|流し込|受け渡|反映|作成|生成)(?:する)?\s*[:：。.!]?\s*(?=\n|$)/;

// 体言止め request forms (2026-07-25 run-2 forensics): a JA task written in
// noun-final style — 「…として新規作成。」「…を実装。」 — carries the same
// request force as してほしい but matched NO mutation regex, so the pack lost
// artifact_build/prepared and the solver fell back to a native Write. The
// particle prefix (を/へ/に/として) plus sentence-final position keeps report
// labels (「実装状況を確認して報告」) from matching.
export const REQUESTED_MUTATION_JA_NOUN_RE = /(?:を|へ|に|として)[^\n。]{0,40}?(?:新規)?(?:修正|追加|実装|作成|生成|変更|接続|連携|配線|反映)\s*(?:[。.]|$)/;

export const PROPAGATION_INTENT_EN_RE = /\b(?:enum|union|schema|contract|exhaustive|every(?:where)?|all\s+(?:callers|references|consumers|definitions|direct\s+callees)|propagat(?:e|ion))\b/i;

export const PROPAGATION_INTENT_JA: readonly string[] = [
  "列挙", "全参照", "呼び出し元", "対応漏れ", "すべて", "全て", "各層", "波及",
];

/**
 * 2026-10-29: a bare 「どう<動詞>…？」 question (「どう判定する？」「どう扱う？」「どう決まる？」) asks how
 * something behaves; none of the word markers above covered it, so it bound `generic`. A sentence
 * that contains 「どう」 followed by a verb and ends with ？ or ? counts. Planning forms ask what to
 * DO (「どうすれば」「どうしたら」「どうやったら」「どうすべき」, and a bare 「どうする？」) and do not.
 * The defect-symptom guardrail (§14) is a separate check and is untouched.
 */
export const JA_DOU_PLANNING_RE = /どう(?:すれば|したら|やれば|やったら|すべき|しよう|しましょう|したい|しても|すると|でも|ぞ|か(?![らな]))/u;

export const JA_DOU_BARE_ACT_QUESTION_RE = /どう(?:する|しますか|しろ)\s*[？?]\s*$/u;

export const JA_SENTENCE_SPLIT_RE = /(?<=[。！!？?])\s*|\n+/u;

export function hasJaInterrogativeDou(query: string): boolean {
  return query.slice(0, SHAPE_SCAN_MAX_CHARS).split(JA_SENTENCE_SPLIT_RE).some((sentence) => {
    const text = sentence.trim();
    if (!/[？?]$/u.test(text)) return false;
    if (JA_DOU_BARE_ACT_QUESTION_RE.test(text) || JA_DOU_PLANNING_RE.test(text)) return false;
    return /どう[^\s、。，,！!？?）)」』]/u.test(text);
  });
}

// 2026-10-02 (Copilot retest r3): two answer shapes the word markers above
// never saw, each recognized by its SENTENCE structure rather than a word:
//   - a wh-question with words between the wh-word and its verb ("What exact
//     delay sequence does retrySchedule() return?", "which constants and
//     functions determine it?") -- ANSWER_INTENT_EN_RE only knows the adjacent
//     "what does" / "which <one word> does" forms. A dot followed by a
//     non-space (`src/backoff.ts`, `res.json()`) does not end the sentence.
//   - a request to COMPUTE a named callable's result ("calculate exact quote()
//     results for carts A, B, and C", "Compute retrySchedule() for
//     RETRY_LIMIT 3"): the imperative twin of "what does quote() return for
//     ...?". The call syntax is required in the same sentence, so "compute the
//     hash before saving" stays what it may be, a change spec.
// Both feed classifyTaskProfile's answer branch AND bindTaskProfile's §14
// honoring (hasInterrogativeAnswerMarker); a requested mutation is still
// checked first, and a defect-symptom marker still keeps a symptom question
// ("what makes the total come out wrong?") on the §14 fallback.
// A modal anywhere in the question makes it a planning question, the usual
// prelude to a change ("Where should the new tools.audit_probe module live?",
// a create route; "How could we make X faster?"): this structural rule never
// fires on one (the word regexes above keep their own "how should" forms).
// Each rule reads one sentence at a time (a terminator or an answer-introducing
// colon followed by whitespace ends one), over the first SHAPE_SCAN_MAX_CHARS
// characters only: the phrasing of a request is in its opening, and the scan
// stays linear however long a pasted query is (review, 2026-10-02: a 100 KB
// colon-separated run took 0.8 s).
export const SHAPE_SCAN_MAX_CHARS = 4096;

export const SHAPE_SENTENCE_SPLIT_RE = /(?<=[.!?;:])\s+|\n+/;

export const SHAPE_LEAD_IN = "^\\s*(?:(?:and|so|then|also|but|now|ok(?:ay)?)\\s*,?\\s+)?";

export const WH_QUESTION_OPENING_EN_RE = new RegExp(`${SHAPE_LEAD_IN}(?:what|which|where|when|why|how|who|whose)\\b`, "i");

export const MODAL_WORD_EN_RE = /\b(?:should|shall|must|would|could|can|might|may|will)\b/i;

// "What about adding ...?", "How about moving ...?", "What if we cache ...?",
// "What's the cleanest way to split ...?": a suggestion, not a question.
export const WH_SUGGESTION_OPENING_EN_RE = new RegExp(`${SHAPE_LEAD_IN}(?:(?:what|how)\\s+(?:about|if)\\b|what['’]?s\\s+the\\s+(?:\\w+\\s+)?way\\b)`, "i");

export const YES_NO_QUESTION_OPENING_EN_RE = new RegExp(`${SHAPE_LEAD_IN}(?:does|do|did|is|are|was|were|has|have|had)\\b`, "i");

// "Are you able to ...?", "Do you mind ...?", "Is it possible to ...?", "Is
// there a way to ...?", "Does it make sense to ...?": a request worded as a
// question about the assistant or about feasibility.
export const YES_NO_REQUEST_OPENING_EN_RE = new RegExp(
  `${SHAPE_LEAD_IN}(?:(?:do|does|did|are|were|have|had)\\s+you\\b|(?:is|was)\\s+(?:it|there)\\s+(?:possible|feasible|worth|ok(?:ay)?|a\\s+(?:way|chance))\\b|does\\s+it\\s+make\\s+sense\\b)`,
  "i",
);

export const COMPUTATION_REQUEST_LEAD_EN_RE = /(?:^|[,;:]\s*|\b(?:and|then|also|please)\s+)(?:calculate|compute|work\s+out|figure\s+out)\b/i;

// A named call followed, later in the same sentence, by its input: "quote()
// results for carts A, B and C", "shardFor("user-9") in the ring with 128
// nodes". A sentence that says HOW to compute instead ("Calculate shipping
// before tax in quote()", "compute the target size so that the output ratio
// matches ...", "by multiplying input tokens by ...") names no input after
// the call and reads as a behaviour spec. A result noun is no evidence
// either way: it is just as often an adjective ("output tokens"). "item(s)" is
// an English plural, not a call.
export const CALL_THEN_INPUT_EN_RE = /\b[A-Za-z_$][\w$]*\((?!e?s\))[^()\n]{0,120}\)[^\n]*?\b(?:for|with|given)\b/i;

// Review (2026-10-02): the request proposes or orders an edit, so none of the
// shapes above is an answer marker -- a change verb as an infinitive, after
// and/then/or, or as a gerund ("does it make sense to extract", "do you mind
// adding", "... and store the result"), a proposal subject ("what if we cache
// ..."), or a sentence that tells the assistant to go on ("If so, go ahead.",
// "Do it.", "Make the edit.", "If not, make it handle them."). Negated
// instructions ("do not modify or run terminal commands") are cut first.
export const PROPOSAL_CHANGE_VERBS_EN = `${MUTATION_VERBS_EN}|make|move|extract|split|cache|store|save|persist|record|write|convert|migrate|rewrite|introduce|merge|wrap|inline|drop|touch|edit|patch|adjust|tweak`;

export const PROPOSAL_CHANGE_GERUND_EN = PROPOSAL_CHANGE_VERBS_EN
  .split("|")
  .map((verb) => (verb.endsWith("e") && !verb.endsWith("ee") ? verb.slice(0, -1) : verb))
  .join("|");

export const EDIT_PROPOSAL_EN_RE = new RegExp(
  `\\b(?:to|and|then|or)\\s+(?:${PROPOSAL_CHANGE_VERBS_EN})\\b`
    + `|\\b(?:${PROPOSAL_CHANGE_GERUND_EN})\\w?ing\\b`
    + `|\\b(?:we|i)\\s+(?:could\\s+|should\\s+|can\\s+|might\\s+)?(?:${PROPOSAL_CHANGE_VERBS_EN})\\b`,
  "i",
);

export const GO_AHEAD_SENTENCE_EN_RE = new RegExp(
  `^\\s*(?:(?:if\\s+(?:so|not|yes|needed)|then|otherwise|please|also|and|ok(?:ay)?)\\s*,?\\s+)*`
    + `(?:go\\s+ahead|proceed|do\\s+(?:it|that|so)\\b|(?:${PROPOSAL_CHANGE_VERBS_EN})\\b)`,
  "i",
);

export const NEGATED_INSTRUCTION_TAIL_EN_RE = /\b(?:do\s+not|don['’]?t|never|without)\b[^.;!?\n]*/gi;

export function shapeSentences(query: string): string[] {
  return query.slice(0, SHAPE_SCAN_MAX_CHARS).split(SHAPE_SENTENCE_SPLIT_RE).filter((sentence) => sentence.trim().length > 0);
}

export function hasEditProposalMarker(sentences: readonly string[]): boolean {
  return sentences.some((sentence) => {
    const positive = sentence.replace(NEGATED_INSTRUCTION_TAIL_EN_RE, " ");
    if (EDIT_PROPOSAL_EN_RE.test(positive)) return true;
    return !/\?\s*$/u.test(sentence) && GO_AHEAD_SENTENCE_EN_RE.test(positive);
  });
}

export function isStructuralQuestion(sentence: string): boolean {
  if (!/\?\s*$/u.test(sentence)) return false;
  if (WH_QUESTION_OPENING_EN_RE.test(sentence)) {
    return !MODAL_WORD_EN_RE.test(sentence) && !WH_SUGGESTION_OPENING_EN_RE.test(sentence);
  }
  return YES_NO_QUESTION_OPENING_EN_RE.test(sentence) && !YES_NO_REQUEST_OPENING_EN_RE.test(sentence);
}
