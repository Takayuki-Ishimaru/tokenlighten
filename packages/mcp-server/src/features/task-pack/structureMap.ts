// structureMap.ts — v0.16 decision window 6t-7, T03 (2026-10-20): the
// STRUCTURE MAP projection of a large type for a short, map-shaped answer.
// Pure and fs-free: every input is plain data, like facetGate.ts and
// requestFacets.ts.
//
// THE CASE. "Explain what the big OrderOrchestrator class does, around its
// transition table and the order it calls payment / inventory / shipping in —
// briefly, as a map of its structure" names a type, asks for its flow around
// named concerns, and asks for a short answer. The answer pack judged the
// question's flow facets against every matched member's WHOLE body
// (readCodeTaskPack.ts `flowStepWindowsForNonCallableFocal`), and the clause
// "the whole order lifecycle" matched every member, so a 1,552-line class was
// required whole: the first reply chained through line 823 (37 KB) and the
// second carried the rest (28 KB). A native agent read the same file in two
// Reads, so the arms cost the same.
//
// THE PROJECTION. A map of a type is its own doc comment, its header (the
// declaration, fields, constants and tables, and the constructors that wire
// its collaborators), the signature of every member, and — for the concerns
// the question names — the ROWS of every member body that invokes one of them
// or calls one of the type's own helpers that does: those statements, the
// `return` / `throw` statements, the statements that pick a value, the effects
// (state writes, saves, audits and every call whose value is thrown away, in any
// language), the failure handling of every `try`, and the control lines enclosing
// them, in source order (memberRows.ts). That is what the question asks to see — the order of the
// calls, what decides whether they run, what they leave the order in and what
// happens when one fails; the member bodies stay owed (`remaining`), so a caller
// who wants one zooms into it. The facet plan requires exactly these windows of
// every member it matched, so the certificate is issued over served evidence only.
//
// THREE LAYOUTS (2026-10-23, codex-copilot-proxy r18 T03). The REPLY a map is
// served in is filled with whole member bodies, an exact prefix of the first
// one that does not fit (`planStructureMap` with bodies "whole"): a body read
// in full certifies more than its calls do, and the first reply is where the
// bytes are free. What the map REQUIRES of the members that reply does not
// hold is their rows (bodies "rows") only when the rows, coalesced, are ONE
// continuation page under the client's cap (readCodeTaskPack.ts
// `owedRowsFitOnePage`); owing those members whole took two more replies of
// 15 KB each for a 1,552-line class and re-sent every earlier reply with every
// later request, and rows that need two pages cost more than that. When they
// do not fit, the members are owed whole, as every map owed them before rows.
//
// ANSWER-FIRST (2026-10-23, TL_EFF_MAP_ANSWER_FIRST, default OFF, compact host
// ceilings only; design: bench/workflows/experiments/2026-10-21-codex-copilot-proxy/
// drafts/fable-analysis-r16/answer-first-design.md). Even the rows of every
// member that names a concern are more than a short answer needs and more than
// one page under a compact ceiling holds, so the map is `discover` with owed
// pages. The experiment REQUIRES less: the header, every member's signature,
// the state enums, and the WHOLE bodies of the members that cover the named
// concerns (`coverMembers`: the entry point first, then whatever accounts for
// the concerns it leaves). The page is that core and nothing else
// (`StructureMapPlanOptions.cover`), the other bodies stay owed, and the facts
// their absence would invite wrong ride the reply's advisory. Those facts say who
// CALLS a concern, so what counts as a call there is narrower than the map's own
// `invokesConcern` (2026-10-24, generality audit): ONE rule per type
// (`answerFirstCover`). A call on one of the type's collaborator fields
// (`concernCallMatches` with `collaborators`, `collaboratorConcernMembers`; the fields
// are those a constructor receives, builds or conventionally holds,
// `collaboratorFields`) — which names no record accessor on a parameter that has the
// concern's name (`req.paymentMethod()`) — and, where that yields no cover at all, the
// NAMED rule (`namedConcernRule`): a call whose receiver chain or callee names a
// concern, except a no-argument data accessor on a parameter or a local of the member.
// A member the request names that calls a concern is in the cover too
// (`coverMembers` `required`, `membersNamed`), and the words that only describe the
// answer's form are no concern (`ANSWER_FORM_WORDS`).
//
// WHEN. Only when the request reads as a request for a short or map-shaped
// answer (`asksForStructureMap`) and names a flow, for a type whose rendered
// body does not fit one surface, and only while the map's reply fits the
// pack's own byte cap (readCodeTaskPack.ts `structureMapForAnswer` decides
// the last three, TL_EFF_STRUCTURE_MAP gates it). Any other question about a
// type keeps the whole-member requirement.
//
// THE ENTRY RULE (2026-10-24, generality audit §3.3.3). Both entry conditions are
// closed vocabularies written for PARAPHRASES, not for one request. The short
// answer: `asksForStructureMap` below — brevity words about the size of the
// answer (TL;DR, "short summary", "keep it short", "at a glance", ざっと,
// 簡単に説明して, …を中心にまとめて。), none of their other senses (short-circuit,
// quick fix, 簡単に直せますか, まとめて削除) and none of them negated ("Don't
// summarize"). The flow: requestFacets.ts `isCallOrderClause` and FLOW_JA_RE —
// the ORDER OF CALLS anchored to a call or execution verb or noun ("the order it
// calls payment in", "what order does it call …", "in which order do build, test
// and publish get invoked", "which of A / B / C runs first", "when A / B / C get
// called", "the sequence of … calls", 「呼ぶ順番」「呼び出し順」「最初に実行される」),
// never to the bare word "order" / 順番 (a purchase order, a sort order, 注文の
// 順番, 順番待ち). A request that fails either keeps the whole-member
// requirement, unchanged.

import { memberBodyRows, parameterNames, typeFieldNames } from "./memberRows.js";
import { maskCommentsAndStrings } from "./sfCodeMask.js";
import { OUT_OF_LINE_LANGUAGES, allmanSignatureEnd, isTypeReference, outOfLineMembersOf, pickStructureMapType } from "./structureMapMembers.js";

/** The fields of a parsed symbol this module reads (structural subset of `CollectedSymbol`). */
export interface StructureMapSymbol {
  readonly name: string;
  readonly kind: string;
  readonly enclosingSymbol?: { readonly name: string; readonly startLine: number; readonly endLine: number; readonly signatureStartLine?: number };
  readonly startLine: number;
  readonly endLine: number;
  readonly signatureStartLine: number;
  readonly signatureEndLine: number;
  /** Parser offset, when available, for lexical namespace ownership in C++. */
  readonly signatureStartIndex?: number;
}

/** One direct member of the mapped type. */
export interface StructureMapMember {
  readonly name: string;
  /** First line, including the member's own leading doc comment. */
  readonly start: number;
  readonly end: number;
  /** The declaration lines (annotations included) up to the line that opens the body. */
  readonly signatureStart: number;
  readonly signatureEnd: number;
  /** A nested type (class, record, enum, interface): its signature is mapped, never its members. */
  readonly nestedType: boolean;
  /** A constructor: part of the header when it precedes the first other member. */
  readonly constructor: boolean;
  /**
   * OUT-OF-LINE (structureMapMembers.ts): the member is declared outside the
   * type's own range — a Go method, a Rust `impl` fn, a C function taking the
   * struct, a C++ `T::m` definition. Absent for every Java, TypeScript, Python,
   * C# and Kotlin member and for a C++ method defined in its class body.
   */
  readonly outOfLine?: true;
  /**
   * The file the member is in when it is not `StructureMapType.path` (a C++
   * `.cpp` beside its `.hpp`). RESERVED for the multi-path map (Stage 2 of the
   * design); nothing sets it yet and every consumer reads the type's own file.
   */
  readonly path?: string;
  /** Go: the receiver variable (`t` of `func (t *Transport) dial()`), which a call to a helper of the type goes through the way `this` / `self` does. */
  readonly receiver?: string;
}

export interface StructureMapType {
  readonly path: string;
  readonly name: string;
  /**
   * First line of the MAP'S RANGE (its extent): the type's leading doc comment,
   * or the first line of a member declared above it. For a type whose members
   * are all inside it this is the declaration's own range, as it always was.
   */
  readonly start: number;
  /** The last line of the extent: the declaration's end, or the last line of the last out-of-line member. */
  readonly end: number;
  readonly signatureStart: number;
  readonly signatureEnd: number;
  /**
   * The last line of the DECLARATION itself (the closing brace of a Go struct):
   * the header ends here, however far the extent runs. Absent means `end`
   * (Java, TypeScript, Python, C#, Kotlin: members inside the type, extent and
   * declaration the same) — read it through `structureMapDeclarationEnd`.
   */
  readonly declarationEnd?: number;
  /**
   * The first line of the declaration's own doc comment when it is not `start`
   * (a member above the declaration pulls `start` up; a Go `//` run is the doc).
   * Absent means `start`.
   */
  readonly docStart?: number;
  /**
   * The lines that open the blocks the out-of-line members are in (a Rust
   * `impl Trait for T {`, header through `{`; structureMapMembers.ts
   * `OutOfLineAttribution.containerHeaders`). The map serves them and requires
   * them: they say whose each member is. Absent for every other type.
   */
  readonly containerHeaders?: ReadonlyArray<StructureMapSpan>;
  /** Direct members, in source order. */
  readonly members: readonly StructureMapMember[];
  /**
   * The files, other than `path`, that hold members of the type, with the
   * extent each occupies. RESERVED for the multi-path map (Stage 2); nothing
   * sets it yet.
   */
  readonly memberFiles?: ReadonlyArray<{ readonly path: string; readonly start: number; readonly end: number }>;
}

/** The last line of `type`'s declaration: `declarationEnd`, which is `end` for a type whose members are inside it. */
export function structureMapDeclarationEnd(type: StructureMapType): number {
  return type.declarationEnd ?? type.end;
}

export interface StructureMapSpan {
  readonly start: number;
  readonly end: number;
}

export type StructureMapWindowKind = "doc" | "header" | "signature" | "call";

export interface StructureMapWindow extends StructureMapSpan {
  readonly kind: StructureMapWindowKind;
  /** The member a signature or call window belongs to (the type's own name for doc/header). */
  readonly member: string;
}

/** The type's own leading doc comment is mapped when it is at most this long… */
export const STRUCTURE_MAP_DOC_MAX_LINES = 60;
/** …and at most this many bytes. */
export const STRUCTURE_MAP_DOC_MAX_BYTES = 4096;
/** The header is mapped up to this many bytes; the rest of it stays owed. */
export const STRUCTURE_MAP_HEADER_MAX_BYTES = 6144;
/** All mapped windows together (doc, header, signatures, call statements), in source bytes. */
export const STRUCTURE_MAP_MAX_BYTES = 16384;
/** A call statement spanning more lines than this is mapped by its first lines only. */
export const STRUCTURE_MAP_STATEMENT_MAX_LINES = 6;
/** At most this many concern terms are mapped (the request's named concerns are a handful). */
export const STRUCTURE_MAP_MAX_TERMS = 8;
/** A type with fewer direct members than this has no structure worth mapping. */
export const STRUCTURE_MAP_MIN_MEMBERS = 3;

// ---------------------------------------------------------------------------
// ENTRY WORDING — which requests ask for a SHORT or MAP-SHAPED answer.
// ---------------------------------------------------------------------------
//
// Wording that asks for a SHORT or MAP-SHAPED answer — brevity, an overview, a
// summary, a line budget, a map of the structure. Deliberately not "explain"
// or "how": those ask for the behavior itself.
//
// A false positive here costs more than a miss. A request judged map-shaped is
// answered from the map's rows instead of the type's whole members — LESS
// evidence than a question that wanted the behavior needed — so every brevity
// word below is a word about the SIZE OF THE ANSWER, and the same spelling in
// another sense is kept out. 2026-10-24 (generality audit §3.3.3 of
// bench/workflows/experiments/2026-10-21-codex-copilot-proxy/drafts/
// fable-analysis-r16: of 16 natural paraphrases of the T03 question 1 EN and no
// JA one passed both entry detectors). Scored on two held-out sets, both with a
// precision floor of 1.0 on the entry: entryHeldout1.ts (development, 172 items,
// structureMapEntry.heldout1.spec.ts) and entryHeldout2.ts (blind, 107 items +
// 29, structureMapEntry.heldout2.spec.ts); pinned end to end by
// structureMapEntryPhrasing.spec.ts.
//   - A size adjective (short / quick / brief / rough / concise / succinct / terse /
//     one-line) counts on an ANSWER NOUN only — "short summary / version / answer
//     / explanation", "quick rundown / look / walkthrough / take", "brief
//     overview", "one-line summary", "the 30-second version", and "compact" on the
//     nouns that are never a data format — or as an instruction about the answer:
//     "keep it short", "keep the answer brief", "make it concise", the imperative
//     "Be brief.", "as short as possible", "short and sweet". "short-circuit",
//     "shortcut", "short-lived", "short int", "in short supply", "the shortest
//     path", "ShortUrl", "short read" (a partial I/O read), "a short description
//     field", "quick fix", "quickSort", "how quickly does it retry", "shorten the
//     timeout", "the design brief", "the brief flag" match none of them.
//   - Brevity words by themselves: "TL;DR", "in a nutshell", "at a glance", "the
//     gist of", "rundown", "cheat sheet", "cliff notes", "one-pager",
//     "succinctly", "in short" (not "in short supply / bursts"), "in a few lines /
//     two sentences / one line / a sentence" (not "… lines of code"), "without
//     going into detail", "skip the details", "don't go too deep", "not too
//     detailed", "just the highlights".
//   - "quickly" counts next to the explaining verb ("quickly summarize", "explain
//     quickly", "walk me through X quickly"), never as a speed ("walk me through
//     how the cache quickly refreshes").
//   - JA: ざっと / さらっと / サクッと / 手早く / 短め / 大まかに / 概略 / 概観 / 概説 /
//     要点 / 端的に / 一言で / N行で / アウトライン / ダイジェスト …; 簡単に (and かんたんに,
//     軽く) only before an explaining verb or a sentence end (「簡単に説明して」
//     「簡単に教えて」「Xについて簡単に。」, never 「簡単に直せますか」「簡単にできる」
//     「簡単にはいかない」「簡単に説明されている」); まとめて only as a request to
//     summarize (「…を中心にまとめて。」「まとめてください」, never 「まとめて削除」
//     「まとめて実行」「両方まとめて教えて」, which are "all at once"). 短く, the
//     original word, keeps its meaning except where it is "shorten" (「短くしたい」
//     「短くする」「短くなる」「短くできる」).
// And a brevity word that is NOT a request to be brief is kept out:
//   - a NAME: text in backticks, a dotted or scoped chain (`summary.total`,
//     `Report::summary`), a call (`summarize(x)`), "the summary field / row /
//     column", "the overview page / tab / component / prop", 「Overview 画面」,
//     「概要欄」, 「要約テーブル」, 「要点をまとめたドキュメント」, the CSS
//     `outline: none`, 「地図タイル」「地図アプリ」, 「ざっと見た感じ」 (roughly) are blanked
//     before the wording is tested (`requestProse`);
//   - a NEGATED one (`matchesUnnegated`): "Don't summarize - go through X line by
//     line", "not just a summary", "rather than a high-level outline", "without an
//     overview", 「要約せずに」「概要ではなく」「簡潔にせず」「要約は不要」 ask for the
//     opposite. "why not a short summary" is a suggestion, not a negation.
const STRUCTURE_MAP_EN_RE = /\b(?:overview|outline|big[- ]picture|high[- ]level|bird'?s[- ]eye|briefly|in\s+brief|concise(?:ly)?|summar(?:y|ise|ize|ised|ized)|(?:structure|structural)\s+map|map\s+of\s+(?:the\s+|its\s+)?(?:class|type|module|structure))\b|\b(?:in|within|under|at\s+most)\s+\d+\s+lines\b/iu;
const STRUCTURE_MAP_JA_RE = /概要|全体像|俯瞰|地図|見取り図|ざっくり|手短|簡潔|短く(?!する|したい|しよう|しろ|した|なる|なっ|なり|できる|できま)|要約|かいつまん|\d+\s*行(?:以内|程度|くらい|ぐらい|まで)/u;

const BREVITY_SIZE_EN = "(?:short(?:er)?|quick|brief|rough|concise|succinct|terse|one[- ](?:line|sentence|paragraph)|two[- ]sentence|three[- ]line)";
const BREVITY_ANSWER_NOUN_EN =
  "(?:summary|summaries|explanation|explainer|answer|answers|version|description|overview|rundown|run-?down|run-?through|walk-?through|walk\\s+through|write-?up|take|intro(?:duction)?|recap|reply|response|paragraph|note|outline|map|account|primer|sketch|tour|breakdown|synopsis|gist|look|cheat\\s*sheet)";
/** "keep it short", "keep the answer brief", "make it concise", "be brief", "stay high-level" — the object is the answer, never a code thing ("keep the timeout short"). */
const BREVITY_ADJECTIVE_EN = "(?:short|brief|concise|compact|tight|terse|succinct|high[- ]level)\\b(?![-\\w])";
const BREVITY_ANSWER_OBJECT_EN =
  "(?:it|this|that|them|things|the\\s+(?:answer|reply|response|explanation|summary|description)|your\\s+(?:answer|reply|response|explanation))";
const BREVITY_VERB_EN = "(?:explain|describe|summari[sz]e|outline|sketch|recap)";
const STRUCTURE_MAP_BREVITY_EN_RE = new RegExp([
  // A size adjective on an answer noun: "short summary", "quick rundown", "brief walkthrough", "one-line summary", "short and sweet explanation".
  `\\b${BREVITY_SIZE_EN}\\s+(?:and\\s+(?:sweet|simple|dirty)\\s+)?${BREVITY_ANSWER_NOUN_EN}\\b`,
  // "compact" is also a data format ("compact reply", "compact encoding"): only on the answer nouns that are never one.
  "\\bcompact\\s+(?:overview|summary|description|explanation|outline|rundown|map|walk-?through|write-?up|recap)\\b",
  // An instruction about the answer.
  `\\b(?:keep|make)\\s+${BREVITY_ANSWER_OBJECT_EN}\\s+(?:(?:very|fairly|pretty|really|reasonably|nice\\s+and)\\s+)?${BREVITY_ADJECTIVE_EN}`,
  // "Be brief." / "and stay high-level": imperative only, so "the key must be short" is none.
  `(?:(?<=^|[.!?;:,\\n])\\s*|\\b(?:please|pls|just|and|but|do|then)\\s+)(?:be|stay)\\s+(?:(?:very|fairly|pretty|really|reasonably)\\s+)?${BREVITY_ADJECTIVE_EN}`,
  "\\bas\\s+(?:short|brief|concise|succinct|compact|terse)\\s+as\\s+(?:possible|you\\s+can|reasonable)\\b|\\bshort\\s+and\\s+(?:sweet|simple|to\\s+the\\s+point)\\b",
  // Brevity words by themselves.
  "(?<![\\w./-])tl;?dr(?![\\w-]|\\.\\w)(?!\\s+(?:command|cli|tool|pages?|package|module|flag|option|script|binary|client)\\b)",
  "\\bin\\s+a\\s+nutshell\\b|\\bat\\s+a\\s+glance\\b|\\bgist\\s+of\\b|\\b(?:get|give\\s+me|just)\\s+the\\s+gist\\b|\\bcliff\\s*notes\\b|\\bone[- ]pager\\b",
  // "explain X in short" / "in short, what does X do?" — never "in short supply", "in short bursts", "in short order".
  "\\bin\\s+short\\b(?=\\s*(?:[,.:;!?]|$)|\\s+[\u2013\u2014-]+\\s|\\s+(?:please|pls|thanks|and|then|what|how|which|who|why|when|where|tell|explain)\\b)",
  // "the 30-second version", "a two-minute rundown"
  "\\b(?:\\d+|one|two|three|five|ten)[- ](?:second|minute)s?\\s+(?:version|summary|overview|rundown|tour|explanation|walk-?through|intro(?:duction)?|primer)\\b",
  "\\brun-?down\\b|\\bcheat\\s*sheet\\b|\\bsuccinctly\\b|\\btersely\\b",
  "\\bin\\s+(?:just\\s+)?(?:a\\s+(?:few|couple\\s+of)|one|two|three|four|five|six|\\d+)\\s+(?:sentences?|lines?|bullets?|bullet\\s+points?|paragraphs?|words?)\\b(?!\\s+of\\s+(?:code|text|output|source))|\\bin\\s+(?:just\\s+)?a\\s+(?:sentence|paragraph|word)\\b(?![-\\w])",
  "\\bwithout\\s+going\\s+(?:in)?to\\s+(?:too\\s+much\\s+)?(?:details?|specifics|the\\s+weeds)\\b|\\b(?:skip|spare\\s+me)\\s+the\\s+(?:details?|specifics|weeds)\\b|\\bno\\s+need\\s+for\\s+(?:the\\s+)?(?:details?|specifics)\\b",
  "\\bdon['’]?t\\s+go\\s+(?:too\\s+)?(?:deep|far|into\\s+(?:the\\s+)?(?:details?|weeds|specifics))\\b|\\bnot\\s+too\\s+detailed\\b",
  "\\bjust\\s+the\\s+(?:highlights?|essentials?|big\\s+picture|outline|bones|skeleton)\\b",
  // "quickly" next to the explaining verb, never as a speed.
  // "Explain X quickly" — X one word or one (blanked) name; "explain how the cache quickly refreshes" is a speed.
  `\\bquickly\\s+(?:${BREVITY_VERB_EN}|walk|run\\s+through|go\\s+through)\\b|\\b${BREVITY_VERB_EN}(?:\\s+(?:(?:the|this|that)\\s+)?(?:\\u25A1+|[\\w$.]+)(?:\\s+(?:class|function|method|module|file|type|service|component))?)?\\s+quickly\\b`,
  "\\b(?:walk|run|take)\\s+(?:me\\s+)?through\\b(?:(?!\\b(?:how|why|what|when|whether|if|that|which)\\b)[^.?!,;:]){0,40}?\\bquickly\\b",
].join("|"), "iu");

/** The verbs 簡単に / まとめて / コンパクトに must lead into to be a request about the answer. */
const BREVITY_EXPLAIN_JA = "(?:説明|教え|解説|まとめ|述べ|概説|紹介|整理|示|言|いう|いえ|いっ|要約|お願い|ご説明|ご紹介|ご解説|ご案内|お教え|知り|聞|見せ|伝え|書い|書く|書き|答え|話し)";
const STRUCTURE_MAP_BREVITY_JA_RE = new RegExp([
  "ざっと|さらっと|さくっと|サクッと|ざくっと|手早く|短め(?:に|で)|アウトライン|ダイジェスト",
  "大まかに|おおまかに|大雑把に|大づかみ|大掴み|大枠|大筋|骨子|概略|概観|概説|要点|要旨|端的に",
  // 「3行でまとめて」「一言で言うと」「30行で。」 — not 「113行である」 / 「一行で書かれている」.
  `(?:一言|ひとこと|一行|数行|数文|[0-9０-９]+\\s*(?:行|文|項目))で(?=\\s*(?:${BREVITY_EXPLAIN_JA}|簡潔|[。！？!?、,]|$))|[0-9０-９]+\\s*(?:行|文|項目)(?:ほど|前後)`,
  `コンパクト(?:に|で)(?=\\s*(?:${BREVITY_EXPLAIN_JA}|[。！？!?、,]|$))`,
  `(?:簡単に|かんたんに|軽く)(?!\\s*(?:説明|解説|紹介|整理|記述|示|書|述べ|まとめ)(?:され|られ|かれ))(?=\\s*(?:${BREVITY_EXPLAIN_JA}|[。！？!?、,]|$))|について簡単に|簡単な(?:説明|解説|概要|紹介|まとめ|要約|流れ)|簡単で(?:いい|良い|構わ|大丈夫)`,
  // まとめて is "summarize" only where the sentence ends on it or on a request ending; "まとめて教えて / 説明して / 削除 / 実行 / お願いします" is "all at once"
  // (「改善を3件まとめてお願いします」 asks for three changes together: a real bench prompt).
  "まとめて(?=\\s*(?:ください|下さい|ほしい|欲しい|もらえ|くれ|ちょうだい|いただ|頂|[。！？!?]|$))",
  "ポイントだけ|ポイントのみ|ポイントを(?:絞|簡潔|端的|かいつまん)",
].join("|"), "u");

// Names that carry a brevity word: blanked before the wording is tested.
const BREVITY_NAME_GUARDS: readonly RegExp[] = [
  /`[^`\n]*`/gu,
  // `summary.total`, `Report::summary`, `report->overview`: a dotted or scoped chain of identifiers.
  /[A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)+/gu,
  // "the summary field", "a summary row", "the overview page", "the short description column": a data or UI thing, not a request.
  /\b(?:summar(?:y|ies)|overview)\s+(?:fields?|columns?|rows?|tables?|records?|objects?|keys?|propert(?:y|ies)|attributes?|props?|lines?|pages?|screens?|views?|panels?|cards?|tabs?|sections?|widgets?|components?|dashboards?|endpoints?|routes?)\b/giu,
  new RegExp(`\\b${BREVITY_SIZE_EN}\\s+${BREVITY_ANSWER_NOUN_EN}\\s+(?:fields?|columns?|attributes?|text|strings?|propert(?:y|ies)|labels?|tags?|keys?|questions?|types?|inputs?|boxe?s?|formats?|numbers?|ids?|names?|hash(?:es)?|codes?|urls?|links?|forms?|modes?|flags?|values?|prompts?)\\b`, "giu"),
  // 「概要欄」「概要画面」, 「Overview 画面」「Summary タブ」
  /(?:概要|要約)(?:欄|フィールド|カラム|項目|テキスト|画面|ページ|タブ|パネル|セクション|ビュー|テーブル|表|データ|ファイル|ジョブ|バッチ)|(?:overview|summary)\s*(?:画面|ページ|タブ|パネル|コンポーネント|カード|ビュー|セクション|欄)/giu,
  // 「要点をまとめたドキュメント」: the key points as an adjective of a thing, not a request to summarize.
  /(?:要点|概要|要約|ポイント)を(?:まとめ|整理)(?:た|てい|てあ)/gu,
  // ざっと as "roughly": 「ざっと見た感じ」「ざっと見たところ」「ざっと数えて」「ざっと100行」, not 「ざっと説明して」「ざっと見て説明して」.
  /ざっと(?:見た|見る|見え|見積|数|計算|[0-9０-９]|[百千万])/gu,
  // A call expression is a name, not a request: `summarize(x)`, `outline()` (a backtick-less call).
  /\b[A-Za-z_$][\w$]*\([^()\n]{0,40}\)/gu,
  // The CSS / IDE "outline" (`outline: none`, "the outline view"), the real-world 地図 (地図アプリ, 地図タイル, 地図データ …): not a "map of the structure".
  /\boutline\s*(?::|-(?:color|style|width|offset)\b|\s+(?:view|panel|pane|tree|color|style|width|border|none|offset|font|stroke|property|rule|ring|glow)\b)/giu,
  /地図(?:アプリ|タイル|データ|画面|表示|情報|検索|サービス|エンジン|レイヤ|上|API)/gu,
];

/**
 * `query` with every name that carries a brevity word blanked (equal-length
 * filler, so nothing else moves). The filler is "□", not a space — as in
 * requestFacets.ts `stripGuardedSpans` — so a blanked name stays a word between
 * its neighbours: "in `SessionStore` short-lived" must not read "in short".
 */
function requestProse(query: string): string {
  let out = query;
  for (const guard of BREVITY_NAME_GUARDS) out = out.replace(guard, (m) => "\u25A1".repeat(m.length));
  return out;
}

// A NEGATED brevity word asks for the opposite: "Don't summarize - go through X line by
// line", "not just a summary", "instead of a quick overview", "without an outline",
// 「要約せずに」「概要ではなく」「要約は不要」. A request judged map-shaped is answered
// from rows, so a request that says NO summary must never be one — and the
// order-of-calls vocabulary made it reachable: "Don't summarize … and tell me the
// order in which it invokes each handler" has a flow now. A match counts only
// where no negation reaches it: none leads it (EN: don't / do not / not / no /
// never / without / skip / avoid / rather than / instead of, at most three words
// before the match — "Don't give me a summary", "not just a summary" — so that
// "Do not modify files and give me a short overview" is not negated; "why not"
// and "how about" are suggestions) and none follows it (JA: せず / しないで /
// ではなく / は不要 / なしで …).
const NEGATION_LEAD_EN_RE = /(?<!\b(?:why|how\s+about|what\s+about)\s)\b(?:don['’]?t|do\s+not|doesn['’]?t|did\s+not|never|not|no|without|skip|avoid|rather\s+than|instead\s+of|nor|neither)(?:\s+(?![-–—]+(?:\s|$))[^\s.!?;:,—–]+){0,3}\s*$/iu;
const NEGATION_TAIL_JA_RE = /^(?:に|で)?(?:は)?(?:せず|しないで|しなくて|ではなく|じゃなく|でなく|ではない|なしで|抜きで|は不要|はいらない|は要らない|はいりません|はほしくない|は欲しくない)/u;

/** True when `re` matches `text` somewhere that no negation reaches. */
function matchesUnnegated(re: RegExp, text: string, visit?: (start: number, end: number) => void): boolean {
  let found = false;
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const match of text.matchAll(global)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const from = Math.max(0, start - 60);
    // The window may open inside a word ("casi|no"): drop that fragment.
    const lead = from === 0 ? text.slice(0, start) : text.slice(from, start).replace(/^\S+/u, "");
    if (NEGATION_LEAD_EN_RE.test(lead) || NEGATION_TAIL_JA_RE.test(text.slice(end, end + 12))) continue;
    if (visit === undefined) return true;
    visit(start, end);
    found = true;
  }
  return found;
}

/** Blank only recognized, unnegated answer-form spans; preserve code names. */
export function maskStructureMapAnswerWording(query: string): string {
  // A concern used as the object of a call is a code name, even if it is
  // spelled summary/outline. Mask it only in the wording detector's copy.
  const text = requestProse(query).replace(
    /\b(?:calls?|invokes?|runs?|executes?)\s+(?!(?:first|next|last|in|the|a|an)\b)[A-Za-z_$][\w$]*(?:\s*\/\s*[A-Za-z_$][\w$]*)*/giu,
    (m) => "\u25A1".repeat(m.length),
  );
  let out = query;
  for (const re of [STRUCTURE_MAP_EN_RE, STRUCTURE_MAP_JA_RE, STRUCTURE_MAP_BREVITY_EN_RE, STRUCTURE_MAP_BREVITY_JA_RE]) {
    matchesUnnegated(re, text, (start, end) => {
      out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
    });
  }
  return out;
}

/** True when `query` asks for a short or map-shaped answer (see the module doc and the entry wording above). */
export function asksForStructureMap(query: string): boolean {
  const text = requestProse(query);
  return [STRUCTURE_MAP_EN_RE, STRUCTURE_MAP_JA_RE, STRUCTURE_MAP_BREVITY_EN_RE, STRUCTURE_MAP_BREVITY_JA_RE]
    .some((re) => matchesUnnegated(re, text));
}

/**
 * LANGUAGE-META vocabulary, not codebase vocabulary: the words a request uses to
 * describe the FORM of the answer it wants ("briefly, as a map of its structure,
 * under 40 lines") or the frame of its question ("walk me through the order it
 * calls X in", 「どの順番で呼んでいるか」, "the big class around …"). The flow
 * facet takes them for concern words — `Gdn#a-en`'s terms were `sycl, device,
 * steady, briefly, big, around, call, map` — and a map that serves every call
 * "naming" one of them lists calls no reader asked for. TL_EFF_MAP_ANSWER_FIRST
 * leaves them out of its OWN concern terms (its cover, its facts, its call
 * index: `answerFormFree`); the ordinary map's terms (`structureMapCallTerms`)
 * are not touched. Lowercase; plural and stem spellings are listed as the facet
 * extractor reports them (`lines` is `line`, `calls` is `call`). A word a request
 * lists BY NAME among its concerns (`payment / inventory / order`, a quoted
 * identifier) is not filtered: the filter is for words the extractor picked out
 * of the sentence, which `requiredQueryFacets` never are. The Japanese entries are
 * what a bridged or raw JA request word looks like before any glossary maps it.
 */
export const ANSWER_FORM_WORDS: ReadonlySet<string> = new Set([
  // brevity, overview, summary, map: the answer's size and shape
  "brief", "briefly", "short", "shortly", "quick", "quickly", "concise", "concisely", "terse",
  "summary", "summaries", "summarize", "summarise", "summarized", "summarised", "overview", "outline", "outlines", "recap",
  "map", "maps", "mapped", "structure", "structures", "structural", "diagram", "picture", "glance",
  "big", "large", "huge", "giant", "high", "level", "simple", "simply", "rough", "roughly", "mainly", "generally",
  // the size budget
  "line", "lines", "word", "words", "sentence", "sentences", "paragraph", "paragraphs", "bullet", "bullets",
  // the request's own verbs and frames
  "explain", "explains", "explained", "explaining", "explanation", "describe", "describes", "described", "description", "tell", "show", "shows", "walk",
  "through", "give", "gives", "please", "understand", "around", "about", "mostly", "especially", "particularly",
  "focus", "focusing", "focused", "detail", "details", "detailed", "step", "steps", "stage", "stages",
  "sequence", "sequences", "order", "orders", "ordering", "flow", "flows", "lifecycle", "call", "calls", "called", "calling", "invoke", "invokes", "invoked", "invoking",
  // what is being asked about, by kind
  "code", "change", "changes", "class", "classes", "method", "methods", "function", "functions", "type", "types",
  // Japanese: the size and shape of the answer, the frame of the question
  "概要", "全体像", "俯瞰", "地図", "見取り図", "ざっくり", "手短", "簡潔", "短く", "要約", "かいつまん", "構造", "説明", "解説", "まとめ", "簡単",
  "順番", "順序", "順", "流れ", "手順", "呼び出し", "呼ぶ", "呼んで", "叩い", "中心", "行以内", "クラス", "メソッド", "関数", "コード", "変更",
]);

/** `terms` without the words that describe the answer's form (`ANSWER_FORM_WORDS`); the order and the other words are kept. */
export function answerFormFree(terms: readonly string[]): string[] {
  return terms.filter((term) => !ANSWER_FORM_WORDS.has(term.toLowerCase()));
}

const TYPE_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum", "type"]);
const CALLABLE_KINDS: ReadonlySet<string> = new Set(["method", "function"]);
const CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(["constructor", "__init__", "init", "new"]);

function unqualified(name: string): string {
  const parts = name.split(/::|\.|#/u);
  return parts[parts.length - 1] ?? name;
}

/**
 * The type `name` declared in `symbols` over a span that overlaps
 * `[rangeStart, rangeEnd]`, with its direct members, or `undefined` when
 * `name` is no type there or it has fewer than STRUCTURE_MAP_MIN_MEMBERS
 * direct members.
 *
 * With the file's `lines` and `lang` (go, rust, c or cpp) the members a type
 * has OUTSIDE its range count too — Go methods, Rust `impl` fns, the C
 * functions taking the struct, C++ `T::m` definitions in the same file
 * (structureMapMembers.ts) — and the type is the largest same-name definition
 * there (a C `struct X *next;` is a one-line symbol of the same name). The
 * result is then the type's EXTENT: `start` / `end` span the declaration and
 * every member, `declarationEnd` is where the declaration itself ends, and the
 * code of other types between the members is inside the extent and no part of
 * the type. Called without them, or for any other language, the answer is what
 * it has always been (declaration = extent, no `declarationEnd`).
 */
export function structureMapTypeOf(
  symbols: readonly StructureMapSymbol[],
  path: string,
  name: string,
  rangeStart: number,
  rangeEnd: number,
  lines?: readonly string[],
  lang?: string,
  minMembers: number = STRUCTURE_MAP_MIN_MEMBERS,
): StructureMapType | undefined {
  const wanted = unqualified(name);
  const outOfLine = lines !== undefined && lang !== undefined && OUT_OF_LINE_LANGUAGES.has(lang) ? { lines, lang } : undefined;
  const overlaps = (symbol: StructureMapSymbol): boolean =>
    TYPE_KINDS.has(symbol.kind)
    && unqualified(symbol.name) === wanted
    && symbol.startLine <= rangeEnd
    && symbol.endLine >= rangeStart;
  const type = outOfLine !== undefined
    ? pickStructureMapType(outOfLine.lang, symbols.filter(overlaps), outOfLine.lines)
    : symbols.find(overlaps);
  if (type === undefined) return undefined;
  const members: StructureMapMember[] = [];
  for (const symbol of symbols) {
    if (symbol === type) continue;
    if (symbol.startLine < type.startLine || symbol.endLine > type.endLine) continue;
    const enclosing = symbol.enclosingSymbol;
    if (enclosing === undefined || unqualified(enclosing.name) !== wanted) continue;
    if (enclosing.startLine !== type.startLine || enclosing.endLine !== type.endLine) continue;
    const nestedType = TYPE_KINDS.has(symbol.kind);
    if (!nestedType && !CALLABLE_KINDS.has(symbol.kind)) continue;
    // A one-line `struct other *p;` field is a type-kind symbol too, and no nested type.
    if (nestedType && outOfLine !== undefined && isTypeReference(outOfLine.lang, symbol, outOfLine.lines)) continue;
    const memberName = unqualified(symbol.name);
    const signatureEnd = Math.min(symbol.endLine, Math.max(symbol.signatureStartLine, symbol.signatureEndLine));
    members.push({
      name: memberName,
      start: symbol.startLine,
      end: symbol.endLine,
      signatureStart: Math.max(symbol.startLine, symbol.signatureStartLine),
      // A C / C++ body whose `{` stands alone on the next line is read from the brace on (allmanSignatureEnd).
      signatureEnd: !nestedType && outOfLine !== undefined && (outOfLine.lang === "c" || outOfLine.lang === "cpp")
        ? allmanSignatureEnd(outOfLine.lines, signatureEnd, symbol.endLine)
        : signatureEnd,
      nestedType,
      constructor: !nestedType && (memberName === wanted || CONSTRUCTOR_NAMES.has(memberName)),
    });
  }
  const attribution = outOfLine !== undefined ? outOfLineMembersOf(outOfLine.lang, symbols, outOfLine.lines, type) : undefined;
  const outside = attribution?.members ?? [];
  members.push(...outside);
  members.sort((left, right) => left.start - right.start);
  if (members.length < minMembers) return undefined;
  const signatureStart = Math.max(type.startLine, type.signatureStartLine);
  const signatureEnd = Math.max(type.signatureStartLine, type.signatureEndLine);
  if (attribution === undefined || outside.length === 0) {
    return { path, name: wanted, start: type.startLine, end: type.endLine, signatureStart, signatureEnd, members };
  }
  const extentStart = Math.min(attribution.docStart, members[0]!.start, ...(attribution.containerHeaders ?? []).map((span) => span.start));
  return {
    path,
    name: wanted,
    start: extentStart,
    end: Math.max(type.endLine, ...members.map((member) => member.end)),
    signatureStart,
    signatureEnd,
    declarationEnd: attribution.declarationEnd,
    ...(attribution.docStart !== extentStart ? { docStart: attribution.docStart } : {}),
    ...(attribution.containerHeaders !== undefined ? { containerHeaders: attribution.containerHeaders } : {}),
    members,
  };
}

/**
 * The words whose call statements a map serves: `terms` lowercased, keeping
 * identifier-shaped words of at least three letters that name a point of the
 * question rather than its subject — never a word segment of the type's own
 * name ("order" in a question about OrderOrchestrator names the class, and
 * every `order.*` call would match it) unless `keepTypeWords` (a concern the
 * request lists by name, requestFacets-style `payment / inventory`, stays one
 * even when the type is a PaymentProcessor), and never a word `nonPoint`
 * lists (requestFacets.ts `nonPointTermsIn`: a path segment, a flow
 * descriptor).
 */
export function structureMapCallTerms(
  terms: readonly string[],
  typeName: string,
  nonPoint: readonly string[] = [],
  keepTypeWords = false,
): string[] {
  const skip = new Set(nonPoint.map((term) => term.toLowerCase()));
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.toLowerCase();
    if (term.length < 3 || !/^[a-z][a-z0-9_]*$/u.test(term)) continue;
    if ((!keepTypeWords && identifierHasSegment(typeName, term)) || skip.has(term) || out.includes(term)) continue;
    out.push(term);
    if (out.length >= STRUCTURE_MAP_MAX_TERMS) break;
  }
  return out;
}

const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*|#|--)/u;

const isUpper = (ch: string | undefined): boolean => ch !== undefined && /[A-Z]/u.test(ch);
const isLower = (ch: string | undefined): boolean => ch !== undefined && /[a-z]/u.test(ch);

/** True when a word segment of `identifier` starts at `index`: its first character, after `_`/`$`/a digit, a lower-to-upper step (`orderService`), or an acronym's end (`HTTPServer`). */
function segmentBoundary(identifier: string, index: number): boolean {
  if (index <= 0 || index >= identifier.length) return true;
  const before = identifier[index - 1];
  const at = identifier[index];
  if (before !== undefined && /[_$0-9]/u.test(before)) return true;
  if (at !== undefined && /[_$0-9]/u.test(at)) return true;
  if (isLower(before) && isUpper(at)) return true;
  return isUpper(before) && isUpper(at) && isLower(identifier[index + 1]);
}

/** True when `term` is a whole word segment of `identifier` (`paymentService`, `payment_gateway`, `PAYMENT_ID`, `ShippingClient` all hold one; `prepayment` does not). */
export function identifierHasSegment(identifier: string, term: string): boolean {
  const lower = identifier.toLowerCase();
  const want = term.toLowerCase();
  if (want.length === 0) return false;
  for (let index = lower.indexOf(want); index >= 0; index = lower.indexOf(want, index + 1)) {
    if (segmentBoundary(identifier, index) && segmentBoundary(identifier, index + want.length)) return true;
  }
  return false;
}

/** `line` with every string and character literal emptied, so a call spelled inside a message is no call. */
function withoutStringLiterals(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gu, "\"\"");
}

/** `receiver.member(`: group 1 is the receiver identifier. */
const RECEIVER_CALL_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:\.|->|::)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/gu;
/** `.member(` on any receiver, a call result included (`req.method().paymentKind(`): group 1 is the member. */
const MEMBER_CALL_RE = /(?:\.|->|::)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu;
const ACCESSOR_RE = /^(?:get|set|is|has)[A-Z_0-9]/u;

/**
 * True when `line` invokes a collaborator named for `term`: a call whose
 * RECEIVER names it (`paymentService.charge(`, `Shipping::quote(`,
 * `inventory_client->reserve(`), or whose called member names it and is not an
 * accessor (`carrier.shippingQuote(`, `pricing.shipping(`). Stricter than the
 * B1d call-site test (readCodeTaskPack.ts `isFacetCallSiteLine`) on purpose:
 * `order.getPaymentId()` and `order.setShippingFee(fee)` read or write the
 * subject's own data — a map that served every such line would be the class.
 */
export function invokesConcern(line: string, term: string): boolean {
  const code = withoutStringLiterals(line);
  for (const match of code.matchAll(RECEIVER_CALL_RE)) {
    if (identifierHasSegment(match[1]!, term)) return true;
  }
  for (const match of code.matchAll(MEMBER_CALL_RE)) {
    const member = match[1]!;
    if (identifierHasSegment(member, term) && !ACCESSOR_RE.test(member)) return true;
  }
  return false;
}

/**
 * The calls on `line` (comment- and string-masked by the caller) that
 * `invokesConcern` counts for one of `terms`, as the text a reader recognizes
 * them by, in source order, without repeats: `paymentService.refund` for
 * `paymentService.refund(order.getPaymentId())`, `pricingService.shipping`
 * for a member named for the concern, `.paymentKind` for a call on a call's
 * result. The same two rules as `invokesConcern` decide which calls count.
 */
export function concernCallsOnLine(line: string, terms: readonly string[]): string[] {
  return concernCallMatches(withoutStringLiterals(line), terms).map((entry) => entry.call);
}

/**
 * The names of the chain of member accesses and calls that ends just before
 * `end` in `code`, leftmost first — `["this", "paymentService", "gateway"]` for the
 * text before the `.` of `this.paymentService.gateway().charge(…)`; undefined when
 * the chain does not start at a plain name (a literal, a parenthesised expression,
 * a cast). `code` is comment- and string-masked. `called` collects the names of the
 * elements that are calls or index accesses (`gateway` in `….gateway().charge(`).
 */
function chainBefore(code: string, end: number, called?: Set<string>): string[] | undefined {
  const names: string[] = [];
  let i = end;
  for (;;) {
    while (i > 0 && /\s/u.test(code[i - 1]!)) i -= 1;
    // An element may be a call or an index: step over its brackets.
    let stepped = false;
    while (i > 0 && (code[i - 1] === ")" || code[i - 1] === "]")) {
      stepped = true;
      let depth = 0;
      let k = i - 1;
      for (; k >= 0; k -= 1) {
        const ch = code[k]!;
        if (ch === ")" || ch === "]") depth += 1;
        else if (ch === "(" || ch === "[") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (k < 0) return undefined;
      i = k;
      while (i > 0 && /\s/u.test(code[i - 1]!)) i -= 1;
    }
    let start = i;
    while (start > 0 && /[A-Za-z0-9_$]/u.test(code[start - 1]!)) start -= 1;
    if (start === i) return undefined;
    names.unshift(code.slice(start, i));
    if (stepped) called?.add(code.slice(start, i));
    i = start;
    while (i > 0 && /\s/u.test(code[i - 1]!)) i -= 1;
    // An access operator before the name continues the chain.
    if (code[i - 1] === ".") {
      i -= 1;
      if (code[i - 1] === "?") i -= 1;
      continue;
    }
    const pair = i >= 2 ? code.slice(i - 2, i) : "";
    if (pair === "->" || pair === "::") {
      i -= 2;
      continue;
    }
    return names;
  }
}

/** True when the chain of accesses that ends before `operatorAt` is rooted at a field in `collaborators` — `this.` and `self.` looked through, a parameter or a local (`req.method().paymentKind()`) not. */
function rootedAtCollaborator(code: string, operatorAt: number, collaborators: ReadonlySet<string>): boolean {
  const names = chainBefore(code, operatorAt);
  if (names === undefined) return false;
  const root = names[0] === "this" || names[0] === "self" || names[0] === "super" ? names[1] : names[0];
  return root !== undefined && collaborators.has(root);
}

/**
 * `concernCallsOnLine` with where each call starts in `code`: the line with its
 * string literals already blanked in place (sfCodeMask.ts keeps every offset;
 * `withoutStringLiterals` shortens the line, so `concernCallsOnLine` cannot say
 * where a call is). A call spelled twice on one line is reported once, at its
 * first place.
 *
 * With `collaborators` (the type's collaborator fields, `collaboratorFields`) a
 * call counts only when it hangs from one of them: `paymentService.refund(…)`,
 * `this.paymentService.refund(…)`, `paymentService.gateway().charge(…)`. A record
 * accessor on a parameter (`req.paymentMethod()`), a call on a local or on another
 * object's field, and a static call are not calls on the type's collaborators, and
 * a fact that says "calls payment" must not name them (TL_EFF_MAP_ANSWER_FIRST).
 */
export function concernCallMatches(code: string, terms: readonly string[], collaborators?: ReadonlySet<string>): Array<{ call: string; index: number }> {
  const out: Array<{ call: string; index: number }> = [];
  for (const match of code.matchAll(/(?:([A-Za-z_$][A-Za-z0-9_$]*)\s*)?(?:\.|->|::)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu)) {
    const receiver = match[1];
    const member = match[2]!;
    const named = (receiver !== undefined && terms.some((term) => identifierHasSegment(receiver, term)))
      || (!ACCESSOR_RE.test(member) && terms.some((term) => identifierHasSegment(member, term)));
    if (!named) continue;
    if (collaborators !== undefined && !rootedAtCollaborator(code, (match.index ?? 0) + match[0].search(/\.|->|::/u), collaborators)) continue;
    const text = receiver !== undefined ? `${receiver}.${member}` : `.${member}`;
    if (!out.some((entry) => entry.call === text)) out.push({ call: text, index: match.index ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a CONCERN CALL is, for the facts an answer-first map states (TL_EFF_MAP_ANSWER_FIRST):
// the cover, the members said to "call payment", the call index. Three rules, in the order
// answer-first tries them:
//
//   collaborators  a call on one of the type's collaborator fields (`collaboratorFields`):
//                  the call hangs from `paymentService.`, `this.paymentService.`,
//                  `paymentService.gateway().`. The rule T03 is read by; narrower than the map's
//                  own, so that a record accessor on a parameter with the concern's name
//                  (`req.paymentMethod()`, review F4) is no payment call.
//   named          used when the rule above finds no member at all (a type whose concern calls do
//                  not hang from a field it receives: a static `Metrics.record(…)`, a local
//                  built in place, a field the constructor does not assign from a name): a call
//                  whose receiver chain or callee names a concern word, except a data accessor
//                  on a parameter or a local of the member (a no-argument call whose receiver
//                  chain starts at one: `req.paymentMethod()`) and a call of one of the type's
//                  own members through `this` / `self` (a helper: the facts follow it one level).
//   (none)         the map's own looser rule (`invokesConcern`), which is the ordinary map's.
// ---------------------------------------------------------------------------

/** The "named" rule (see above), with what it needs to tell a member's own data from a collaborator. */
export interface NamedConcernRule {
  readonly kind: "named";
  /** The type's collaborator fields: never taken for a parameter or a local, whatever the member declares. */
  readonly collaborators: ReadonlySet<string>;
  /** The names `member` declares as parameters and locals. */
  readonly dataNamesOf: (member: StructureMapMember) => ReadonlySet<string>;
}

/** A rule for what a concern call is: a set of collaborator fields is the "collaborators" rule, a `NamedConcernRule` the "named" one. */
export type ConcernCallRule = ReadonlySet<string> | NamedConcernRule;

function isNamedRule(rule: ConcernCallRule): rule is NamedConcernRule {
  return !(rule instanceof Set) && (rule as NamedConcernRule).kind === "named";
}

const KEYWORDS_BEFORE_A_NAME: ReadonlySet<string> = new Set([
  "return", "throw", "new", "else", "case", "goto", "yield", "await", "delete", "typeof", "import", "package", "using", "namespace", "break",
  "continue", "do", "in", "of", "is", "as", "not", "and", "or", "from", "raise", "print", "assert", "del", "pass", "lambda", "def", "class",
  "async", "public", "private", "protected", "static", "if", "while", "for", "switch", "try", "catch", "finally", "with", "elif", "except",
]);

/** The top-level pieces of `text` split at `separator`, brackets of every kind nested. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}" || (ch === ">" && text[i - 1] !== "-" && text[i - 1] !== "=")) depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  out.push(text.slice(from));
  return out;
}

/** The parameter names of a (comment- and string-masked) signature: `req` of `OrderRequest req`, `req: Request`, `self, req=None`, `final Map<K, V> m`. */
function parameterNamesOf(signature: string): string[] {
  const open = signature.indexOf("(");
  if (open < 0) return [];
  let depth = 0;
  let close = signature.length;
  for (let i = open; i < signature.length; i += 1) {
    if (signature[i] === "(") depth += 1;
    else if (signature[i] === ")" && (depth -= 1) === 0) { close = i; break; }
  }
  const names: string[] = [];
  for (const raw of splitTopLevel(signature.slice(open + 1, close), ",")) {
    let part = raw.trim();
    if (part === "") continue;
    const assignment = splitTopLevel(part, "=");
    if (assignment.length > 1) part = (assignment[0] ?? "").trim();
    part = part.replace(/@[A-Za-z_$][\w$.]*(?:\([^)]*\))?\s*/gu, "");
    const typed = /^(?:(?:public|private|protected|readonly|val|var|final|const|vararg|ref|out|in)\s+)*(?:\*{1,2}|\.{3})?([A-Za-z_$][\w$]*)\s*\??\s*:(?!:)/u.exec(part);
    const name = typed?.[1]
      ?? /([A-Za-z_$][\w$]*)\s*(?:\[\s*\]\s*)*$/u.exec(part.replace(/<[^<>]*>/gu, "").replace(/<[^<>]*>/gu, ""))?.[1];
    if (name !== undefined && name !== "self" && name !== "cls" && name !== "this") names.push(name);
  }
  return names;
}

/** Statements that declare a local: `Order o = …`, `const x = …`, `val x`, `for (x of …)`, `for x in …`, `catch (E e)`, `except E as e`, `x -> …`, `name = …`. */
const LOCAL_DECLARATION_RES: readonly RegExp[] = [
  /^\s*(?:(?:final|const|let|var|val|auto|readonly)\s+)+([A-Za-z_$][\w$]*)\b/u,
  /^\s*([A-Za-z_$][\w$.<>,?[\]*&:]*)\s+([A-Za-z_$][\w$]*)\s*(?:=(?!=)|;|,\s*[A-Za-z_$])/u,
  /^\s*([A-Za-z_][\w]*)\s*(?:[-+*/%]?=)(?!=)/u,
  /\bfor\s*\(?\s*(?:(?:const|let|var|final|val)\s+)?(?:[A-Za-z_$][\w$.<>,?[\]]*\s+)?([A-Za-z_$][\w$]*)\s+(?:of|in|:)\s/u,
  /\bcatch\s*\(\s*(?:final\s+)?(?:[\w$.|]+\s+)?([A-Za-z_$][\w$]*)\s*\)/u,
  /\bas\s+([A-Za-z_]\w*)\s*[:,)]/u,
  /(?:\(\s*)?([A-Za-z_$][\w$]*)\s*\)?\s*(?:=>|->)/u,
];

/** The names `member` declares as parameters and locals (comment- and string-masked source), minus `collaborators`. */
function memberDataNames(member: StructureMapMember, lines: readonly string[], collaborators: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const signature = maskCommentsAndStrings(lines.slice(member.signatureStart - 1, member.signatureEnd).join("\n"));
  for (const name of parameterNamesOf(signature)) out.add(name);
  const body = maskCommentsAndStrings(lines.slice(member.signatureEnd, member.end).join("\n")).split("\n");
  for (const line of body) {
    for (const [index, pattern] of LOCAL_DECLARATION_RES.entries()) {
      const match = pattern.exec(line);
      if (match === null) continue;
      if (index === 1 && KEYWORDS_BEFORE_A_NAME.has(match[1]!.replace(/[<>,?[\]*&:.].*$/u, ""))) continue;
      const name = index === 1 ? match[2]! : match[1]!;
      if (!KEYWORDS_BEFORE_A_NAME.has(name)) out.add(name);
    }
  }
  for (const name of collaborators) out.delete(name);
  return out;
}

/** The "named" rule for a type whose source is `lines`: what a member's own data is is read from its parameters and its declarations (`memberDataNames`), once per member. */
export function namedConcernRule(lines: readonly string[], collaborators: ReadonlySet<string> = new Set()): NamedConcernRule {
  const cache = new Map<StructureMapMember, ReadonlySet<string>>();
  return {
    kind: "named",
    collaborators,
    dataNamesOf: (member) => {
      let names = cache.get(member);
      if (names === undefined) {
        names = memberDataNames(member, lines, collaborators);
        cache.set(member, names);
      }
      return names;
    },
  };
}

/**
 * `concernCallMatches` under the "named" rule: a call counts when its immediate receiver
 * or — not an accessor (`get` / `set` / `is` / `has`) — its callee names a word of
 * `terms`, or when it hangs from a plain chain of field accesses (no call in it) one of which
 * does (`this.paymentGateway.client.send(…)`); it does not count when it is a data accessor
 * (a no-argument call whose chain starts at a name in `dataNames`: a parameter or a local),
 * nor a call of one of the type's own members through `this` / `self` / `super` alone.
 */
export function namedConcernCallMatches(code: string, terms: readonly string[], dataNames: ReadonlySet<string>): Array<{ call: string; index: number }> {
  const out: Array<{ call: string; index: number }> = [];
  for (const match of code.matchAll(/(?:([A-Za-z_$][A-Za-z0-9_$]*)\s*)?(?:\.|->|::)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu)) {
    const receiver = match[1];
    const member = match[2]!;
    const operatorAt = (match.index ?? 0) + match[0].search(/\.|->|::/u);
    const called = new Set<string>();
    const names = chainBefore(code, operatorAt, called);
    const chain = names === undefined ? undefined : names[0] === "this" || names[0] === "self" || names[0] === "super" ? names.slice(1) : names;
    // A call of an own member through `this.` / `self.`: a helper, followed one level by the facts (not a call on a collaborator).
    if (chain !== undefined && chain.length === 0) continue;
    const named = (receiver !== undefined && terms.some((term) => identifierHasSegment(receiver, term)))
      || (!ACCESSOR_RE.test(member) && terms.some((term) => identifierHasSegment(member, term)))
      || (chain !== undefined && called.size === 0 && chain.some((name) => terms.some((term) => identifierHasSegment(name, term))));
    if (!named) continue;
    // A data accessor: `req.paymentMethod()`, `order.billingKind()` — no argument, on a parameter or a local of the member.
    const noArguments = /^\s*\)/u.test(code.slice((match.index ?? 0) + match[0].length));
    if (noArguments && chain !== undefined && chain[0] !== undefined && dataNames.has(chain[0])) continue;
    const text = receiver !== undefined ? `${receiver}.${member}` : `.${member}`;
    if (!out.some((entry) => entry.call === text)) out.push({ call: text, index: match.index ?? 0 });
  }
  return out;
}

/** The calls on a masked line of `member`'s body that count under `rule` (`undefined`: the map's own looser rule). */
export function concernCallMatchesIn(rule: ConcernCallRule | undefined, member: StructureMapMember, code: string, terms: readonly string[]): Array<{ call: string; index: number }> {
  if (rule === undefined) return concernCallMatches(code, terms);
  if (isNamedRule(rule)) return namedConcernCallMatches(code, terms, rule.dataNamesOf(member));
  return concernCallMatches(code, terms, rule);
}

/**
 * The direct members of `type` a map owes under `terms` once the page serves
 * none of their bodies: those whose body, in the whole-member layout, holds a
 * statement that invokes a concern or calls a helper of the type that does
 * (`memberMapWindows` beyond the signature). Source order; never a
 * constructor or a nested type.
 */
export function concernMembers(
  type: StructureMapType,
  lines: readonly string[],
  terms: readonly string[],
): StructureMapMember[] {
  const helpers = concernHelperNames(type, lines, terms);
  return type.members.filter((member) =>
    !member.nestedType && !member.constructor
    && memberMapWindows(member, lines, terms, helpers, "whole").some((span) => span.end > member.signatureEnd));
}

/**
 * What a member that invokes a requested concern contributes to a map:
 *
 *   "whole"  the complete parser-bounded member. Calls alone omit the
 *            assignments, state transitions and exception handling around
 *            them, so the PAGE a reply carries is filled with whole bodies (an
 *            exact prefix when one does not fit), which is also what a member
 *            read in full certifies.
 *   "rows"   its signature, the statements that invoke a concern (or a helper
 *            that does, a call split over lines included), its `return` /
 *            `throw` statements and the `continue` / `break` that skip part of
 *            a loop, the statements that decide between two values, its
 *            effects (state writes, saves, audits and the calls that run for
 *            what they do, in any language), every `try` with the calls its
 *            block makes and its handlers, and the control lines enclosing
 *            those (memberRows.ts). This is what a member the first page does not
 *            hold is OWED as when those rows are one continuation page
 *            (readCodeTaskPack.ts `owedRowsFitOnePage`): the order of the
 *            calls, what decides whether they run, what they leave the order
 *            in and what happens when one fails, without the lines between.
 *
 * Unrelated members and nested types contribute only their signatures in both.
 */
export type StructureMapBodies = "whole" | "rows";

export function memberMapWindows(
  member: StructureMapMember,
  lines: readonly string[],
  terms: readonly string[],
  helpers: ReadonlySet<string> = new Set(),
  bodies: StructureMapBodies = "whole",
  /** Spans inside the body a caller needs whole (a review note's lines); read in "rows" only. */
  anchors: readonly StructureMapSpan[] = [],
  /** The type's collaborator fields (`collaboratorFields`): a call on one inside a `try` block is a row; "rows" only. */
  collaborators: ReadonlySet<string> = new Set(),
  /** The type's field names (`typeFieldNames`): a bare assignment to one is a state write; "rows" only. */
  fields: ReadonlySet<string> = new Set(),
): StructureMapSpan[] {
  const signature = { start: member.signatureStart, end: member.signatureEnd };
  if (member.nestedType || terms.length === 0) return [signature];
  const floor = member.signatureEnd + 1;
  const concernLine = (line: string): boolean => mapCallOffsets(line, terms, helpers, member.name, member.receiver).length > 0;
  if (bodies === "rows") {
    // A parameter named like a field is the parameter (the fields are read only when the caller knows them).
    const parameters = fields.size > 0 ? parameterNames({ lines, start: member.signatureStart, end: member.signatureEnd, name: member.name }) : undefined;
    const rows = memberBodyRows({ lines, bodyStart: floor, bodyEnd: member.end, isConcernLine: concernLine, isConcernText: concernLine, anchors, collaborators, fields, parameters });
    // A body that cannot be read lexically stays whole, as it was before rows.
    if (rows === undefined) return [{ start: member.signatureStart, end: member.end }];
    return rows.length === 0 ? [signature] : mergeSpans([signature, ...rows]);
  }
  const masked = maskCommentsAndStrings(lines.slice(floor - 1, member.end).join("\n")).split("\n");
  return masked.some(concernLine)
    ? [{ start: member.signatureStart, end: member.end }]
    : [signature];
}

/** A field declaration in a type's header: `private final OrderRepository orderRepository;` (Java, C#), `private val x: X` / `private readonly x: X;` (Kotlin, TypeScript). Group 1: the type text (Java) — group 2: the name. */
const FIELD_DECLARATION_RES: ReadonlyArray<{ pattern: RegExp; type: number; name: number }> = [
  { pattern: /^(?:@\S+\s+)*(?:(?:public|private|protected|internal|final|readonly|volatile|transient|val|var|lateinit)\s+)+((?:[\w$.<>,?[\]]+\s+)+)([A-Za-z_$][\w$]*)\s*;?$/u, type: 1, name: 2 },
  { pattern: /^(?:@\S+\s+)*(?:(?:public|private|protected|internal|readonly|override|val|var|lateinit)\s+)+([A-Za-z_$][\w$]*)\s*[?!]?:\s*([\w$.<>,?[\]|\s]+?)\s*;?$/u, type: 2, name: 1 },
];
/** The types of fields that hold a value, not a collaborator. */
const VALUE_TYPE_RE = /^(?:boolean|bool|byte|char|short|int|long|float|double|number|string|str|any|object|var|val)$/iu;
/**
 * A field declared with or without modifiers (`PaymentService paymentService;`, `private readonly IFoo _foo;`,
 * `Foo foo_;`): the fields a constructor can fill WITHOUT `this.` (`_foo = foo;`, `: foo_(foo)`). Group 1: the type
 * text — group 2: the name. Only consulted for a name the constructor assigns.
 */
const DECLARED_FIELD_RE = /^(?:@\S+\s+)*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|final|readonly|volatile|transient|mutable|val|var|lateinit)\s+)*((?:[\w$.:<>,?[\]]+\s+)*[\w$.:<>,?[\]]+)\s+([A-Za-z_$][\w$]*)\s*;?$/u;
/** A C# get-only property (`public IFoo Foo { get; }`, `{ get; init; }`, `{ get; private set; }`): conventionally filled by the constructor. Group 1: the type — group 2: the name. A `{ get; set; }` property is data. */
const GET_ONLY_PROPERTY_RE = /^(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|virtual|override|sealed|new|required|readonly)\s+)*((?:[\w$.<>,?[\]]+\s+)*[\w$.<>,?[\]]+)\s+([A-Za-z_$][\w$]*)\s*\{\s*get\s*;\s*(?:(?:private|protected|internal)\s+set\s*;|init\s*;)?\s*\}\s*$/u;
/** A C++ member that points to or refers to a class: `X* x_;`, `const X& x_;`. Group 1: the type — group 2: the name. */
const CPP_POINTER_MEMBER_RE = /^(?:mutable\s+)?(?:const\s+)?((?:[\w$]+::)*[\w$]+(?:\s*<[^;()]*>)?)\s*[*&]+\s*(?:const\s+)?([A-Za-z_$][\w$]*)\s*;$/u;
/** …and one held by a smart pointer: `std::unique_ptr<X> x_;`, `std::shared_ptr<X> x_;`. */
const CPP_SMART_POINTER_MEMBER_RE = /^(?:mutable\s+)?(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|weak_ptr)\s*<\s*(?:const\s+)?((?:[\w$]+::)*[\w$]+)[^>]*>\s+([A-Za-z_$][\w$]*)\s*;$/u;
/** A collaborator a constructor BUILDS: `this.x = new X(…)`, `this->x = new ns::X<T>(…)`. Group 1: the field — group 2: the (qualified) class. */
const CONSTRUCTED_FIELD_RE = /^\s*(?:this|self)\s*(?:\.|->)\s*([A-Za-z_$][\w$]*)\s*=\s*new\s+((?:[A-Za-z_$][\w$]*\s*(?:\.|::)\s*)*[A-Za-z_$][\w$]*)\s*[<(]/u;
/** …in Python: `self._s = requests.Session()`, `self.x = X(…)` — a capitalized callee. Group 1: the field — group 2: the class. */
const PYTHON_CONSTRUCTED_FIELD_RE = /^\s*self\s*\.\s*([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_]\w*\s*\.\s*)*([A-Z][A-Za-z0-9_]*)\s*\(/u;
/** A constructor assignment to a bare name (`_x = x;`, no `this.`): the name — the value. */
const BARE_FIELD_ASSIGNMENT_RE = /^\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/u;

/**
 * The names of the fields a type receives its collaborators in: those its
 * constructors assign from a plain identifier (`this.paymentService = paymentService;`,
 * `self.client = client`, `_x = x;` to a field the header declares), the ones they
 * BUILD (`this.x = new X(…)`, `self._s = requests.Session()`, `self.x = X(…)`), the
 * parameter properties of a TypeScript or Kotlin constructor, the members a C++
 * initializer list fills (`: x_(x)`), and the instance fields the type declares
 * without an initializer (`private final OrderRepository orderRepository;`, which a
 * generated constructor fills; C# `private readonly IFoo _foo;` and the get-only
 * property `public IFoo Foo { get; }`; the C++ members `X* x_;`, `X& x_;`,
 * `std::unique_ptr<X> x_;` and `std::shared_ptr<X> x_;`, wherever the class declares
 * them). Static fields, constants, fields built in place (`= new ReentrantLock()`,
 * a logger) and fields of a value type (a number, a string, a flag) are not injected
 * and are not here. Lexical, over the masked source, like the rest of the map; empty
 * when the type shows none. A `try` that calls one of these has a failure the member
 * deals with (memberRows.ts).
 */
export function collaboratorFields(type: StructureMapType, lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  const masked = (start: number, end: number): string[] =>
    maskCommentsAndStrings(lines.slice(start - 1, end).join("\n")).split("\n");
  const add = (name: string, typeText: string | undefined): void => {
    if (typeText !== undefined && VALUE_TYPE_RE.test(typeText.trim().replace(/^.*(?:\.|::)/u, ""))) return;
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) out.add(name);
  };
  const headerEnd = headerEndOf(type);
  const constructorLines = new Set<number>();
  for (const member of type.members) {
    if (!member.constructor) continue;
    for (let line = member.signatureStart; line <= member.end; line += 1) constructorLines.add(line);
  }
  const memberLines = new Set<number>();
  for (const member of type.members) for (let line = member.start; line <= member.end; line += 1) memberLines.add(line);
  // What the type declares: header lines (the original patterns, and the names a constructor can fill without `this.`), and
  // — wherever the class puts its data members, a C++ class often last — the members only a declaration like these can be.
  const declared = new Map<string, string>();
  masked(type.signatureEnd + 1, Math.max(type.signatureEnd, type.end - 1)).forEach((raw, offset) => {
    const line = type.signatureEnd + 1 + offset;
    const text = raw.replace(/\s+/gu, " ").trim();
    if (constructorLines.has(line) || (memberLines.has(line) && line > headerEnd) || text === "") return;
    const inHeader = line <= headerEnd;
    const property = GET_ONLY_PROPERTY_RE.exec(text);
    if (property) { add(property[2]!, property[1]); return; }
    if (/[(){}=]|\bstatic\b/u.test(text)) return;
    for (const pattern of [CPP_POINTER_MEMBER_RE, CPP_SMART_POINTER_MEMBER_RE]) {
      const cpp = pattern.exec(text);
      if (cpp) { add(cpp[2]!, cpp[1]); declared.set(cpp[2]!, cpp[1]!); return; }
    }
    if (inHeader) {
      for (const { pattern, type: typeGroup, name } of FIELD_DECLARATION_RES) {
        const match = pattern.exec(text);
        if (match?.[name] !== undefined) { add(match[name]!, match[typeGroup]); break; }
      }
    }
    // What the constructor can fill by a bare name or an initializer list is declared anywhere in the class.
    const broad = DECLARED_FIELD_RE.exec(text);
    if (broad) declared.set(broad[2]!, broad[1]!.trim());
  });
  for (const member of type.members) {
    if (!member.constructor) continue;
    // From the signature on: Python's signature runs through the first statement of the body.
    for (const line of masked(member.signatureStart, member.end)) {
      const assigned = /^\s*(?:this|self)\s*(?:\.|->)\s*([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*;?\s*$/u.exec(line);
      if (assigned) { add(assigned[1]!, undefined); continue; }
      const constructed = CONSTRUCTED_FIELD_RE.exec(line) ?? PYTHON_CONSTRUCTED_FIELD_RE.exec(line);
      if (constructed) { add(constructed[1]!, constructed[2]!.replace(/\s+/gu, "")); continue; }
      const bare = BARE_FIELD_ASSIGNMENT_RE.exec(line);
      if (bare && declared.has(bare[1]!) && bare[1] !== bare[2]) add(bare[1]!, declared.get(bare[1]!));
    }
    const signature = masked(member.signatureStart, member.signatureEnd).join(" ");
    for (const property of signature.matchAll(/\b(?:private|protected|public|readonly)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*:\s*([\w$.<>?[\]]+)/gu)) add(property[1]!, property[2]);
    // C++: the initializer list after the parameters, `Foo(Bar& bar) : bar_(bar), baz_(std::move(baz)) {`.
    const afterParameters = initializerListOf(signature);
    if (afterParameters !== undefined) {
      for (const initializer of afterParameters.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*\(\s*(?:std\s*::\s*move\s*\(\s*)?([A-Za-z_$][\w$]*)\s*\)\s*\)?/gu)) {
        const name = initializer[1]!;
        if (declared.has(name) && /^[A-Za-z_$]/u.test(initializer[2]!)) add(name, declared.get(name));
      }
    }
  }
  for (const property of masked(type.signatureStart, type.signatureEnd).join(" ").matchAll(/\b(?:val|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([\w$.<>?[\]]+)/gu)) add(property[1]!, property[2]);
  return out;
}

/** The text of a constructor signature after its parameter list's `:` (a C++ member initializer list), or undefined when it has none. */
function initializerListOf(signature: string): string | undefined {
  const open = signature.indexOf("(");
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < signature.length; i += 1) {
    const ch = signature[i];
    if (ch === "(") depth += 1;
    else if (ch === ")" && (depth -= 1) === 0) {
      const rest = signature.slice(i + 1);
      const colon = /^\s*(?:noexcept\s*(?:\([^)]*\))?\s*)?:(?!:)\s*/u.exec(rest);
      if (colon === null) return undefined;
      const list = rest.slice(colon[0].length);
      const brace = list.indexOf("{");
      return brace >= 0 ? list.slice(0, brace) : list;
    }
  }
  return undefined;
}

/**
 * The type's own callable members, other than its constructors, whose body
 * invokes a collaborator named for one of `terms` — the helpers a map follows
 * one level: a call to one of them is a concern call too.
 */
export function concernHelperNames(type: StructureMapType, lines: readonly string[], terms: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (terms.length === 0) return out;
  for (const member of type.members) {
    if (member.nestedType || member.constructor) continue;
    for (let line = member.signatureEnd + 1; line <= member.end; line += 1) {
      const text = lines[line - 1] ?? "";
      if (COMMENT_LINE_RE.test(text) || !terms.some((term) => invokesConcern(text, term))) continue;
      out.add(member.name);
      break;
    }
  }
  return out;
}

/** True when `line` calls one of `helpers` other than `self` itself, bare or through `this`/`self` (`releaseAll(…)`, `this.cancel(…)`) — or through the member's `receiver` variable (a Go method's `t.getConn(…)`). */
function mapCallOffsets(line: string, terms: readonly string[], helpers: ReadonlySet<string>, self: string, receiver?: string): number[] {
  const offsets: number[] = [];
  for (const match of line.matchAll(RECEIVER_CALL_RE)) {
    if (terms.some(term => identifierHasSegment(match[1]!, term))) offsets.push(match.index);
  }
  for (const match of line.matchAll(MEMBER_CALL_RE)) {
    if (!ACCESSOR_RE.test(match[1]!) && terms.some(term => identifierHasSegment(match[1]!, term))) offsets.push(match.index);
  }
  offsets.push(...helperCallOffsets(line, helpers, self, receiver));
  return offsets;
}

/**
 * The offsets of the calls on `line` to one of `helpers` other than `self`, bare
 * or through `this`/`self` — and, for a Go method, through its `receiver`
 * variable, which is `this` there (`t.getConn(` in `func (t *Transport) roundTrip`).
 */
function helperCallOffsets(line: string, helpers: ReadonlySet<string>, self: string, receiver?: string): number[] {
  const offsets: number[] = [];
  const call = receiver === undefined
    ? /(^|[^.\w$>:])(?:(?:this|self)\s*(?:\.|->)\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu
    : new RegExp(`(^|[^.\\w$>:])(?:(?:this|self|${receiver.replace(/[$]/gu, "\\$&")})\\s*(?:\\.|->)\\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(`, "gu");
  for (const match of line.matchAll(call)) {
    if (match[2] !== self && helpers.has(match[2]!)) offsets.push(match.index + match[1]!.length);
  }
  return offsets;
}

/** Sorted, with overlapping or touching spans merged. */
export function mergeSpans(spans: readonly StructureMapSpan[]): StructureMapSpan[] {
  const sorted = [...spans].filter((span) => span.end >= span.start).sort((left, right) => left.start - right.start || left.end - right.end);
  const out: StructureMapSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start <= last.end + 1) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/**
 * The last line of the header: the line before the first member that is not a
 * constructor (the constructors wiring the collaborators stay in it), and never
 * past the end of the DECLARATION — a Go struct's header ends at its closing
 * brace though its first method is a thousand lines below, and a member
 * declared above the declaration (a Rust `impl` before its `struct`) ends
 * nothing. For a type whose members are inside it, the declaration is the
 * extent and this is what it always was. Exported for readCodeTaskPack.ts
 * `structureMapForAnswer`, which requires the header's lines.
 */
export function headerEndOf(type: StructureMapType): number {
  const declarationEnd = structureMapDeclarationEnd(type);
  const first = type.members.find((member) => !member.constructor && (member.outOfLine !== true || member.start > type.signatureEnd));
  return first === undefined ? declarationEnd : Math.max(type.signatureEnd, Math.min(first.start - 1, declarationEnd));
}

/** A cover is at most this many members (the flow requirement's callee bound, MAX_CALLEES_PER_REQUIREMENT): a request that needs more is not answered from an entry point. */
export const STRUCTURE_MAP_COVER_MAX_MEMBERS = 3;

/**
 * The words of `terms` each DIRECT member of `type` invokes, in source order,
 * by the same notion of "invokes" a map uses (`invokesConcern`) over the
 * member's comment- and string-masked body lines. A member that only calls a
 * helper of the type that invokes a concern is not direct (the helper is), and
 * neither is a constructor or a nested type. A word no member invokes appears
 * in no set. The keys are the members of `type`, so a caller can hold on to
 * them (overloads share a name and not an identity). With `collaborators` — the
 * type's collaborator fields, or the "named" rule (`ConcernCallRule`) — a word
 * counts only for a call that rule counts (`concernCallMatchesIn`).
 */
export function directConcernMembers(
  type: StructureMapType,
  lines: readonly string[],
  terms: readonly string[],
  collaborators?: ConcernCallRule,
): Map<StructureMapMember, Set<string>> {
  const out = new Map<StructureMapMember, Set<string>>();
  const wanted = [...new Set(terms.map((term) => term.toLowerCase()))];
  if (wanted.length === 0) return out;
  for (const member of type.members) {
    if (member.nestedType || member.constructor || member.end <= member.signatureEnd) continue;
    const masked = maskCommentsAndStrings(lines.slice(member.signatureEnd, member.end).join("\n")).split("\n");
    const found = new Set<string>();
    for (const line of masked) {
      for (const term of wanted) {
        if (found.has(term)) continue;
        const invokes = collaborators === undefined
          ? invokesConcern(line, term)
          : concernCallMatchesIn(collaborators, member, line, [term]).length > 0;
        if (invokes) found.add(term);
      }
    }
    if (found.size > 0) out.set(member, found);
  }
  return out;
}

/**
 * The members that CALL a concern, split by how: `direct` — the body holds a call
 * `rule` counts (`concernCallMatchesIn`) on a word of `terms` — and `viaHelper` — it
 * holds none and calls one of the direct members (bare or through `this`/`self`),
 * one level, as the map follows its helpers; `all` is both, in source order. Never a
 * constructor or a nested type.
 */
export function concernMembersByReach(
  type: StructureMapType,
  lines: readonly string[],
  terms: readonly string[],
  rule: ConcernCallRule,
): { direct: StructureMapMember[]; viaHelper: StructureMapMember[]; all: StructureMapMember[] } {
  const wanted = [...new Set(terms.map((term) => term.toLowerCase()))];
  if (wanted.length === 0) return { direct: [], viaHelper: [], all: [] };
  const bodies = new Map<StructureMapMember, string[]>();
  const direct = new Set<StructureMapMember>();
  for (const member of type.members) {
    if (member.nestedType || member.constructor || member.end <= member.signatureEnd) continue;
    const masked = maskCommentsAndStrings(lines.slice(member.signatureEnd, member.end).join("\n")).split("\n");
    bodies.set(member, masked);
    if (masked.some((line) => concernCallMatchesIn(rule, member, line, wanted).length > 0)) direct.add(member);
  }
  const helpers = new Set([...direct].map((member) => member.name));
  const members = [...bodies.keys()];
  const viaHelper = members.filter((member) =>
    !direct.has(member) && bodies.get(member)!.some((line) => helperCallOffsets(line, helpers, member.name, member.receiver).length > 0));
  return {
    direct: members.filter((member) => direct.has(member)),
    viaHelper,
    all: members.filter((member) => direct.has(member) || viaHelper.includes(member)),
  };
}

/**
 * `concernMembers` for a fact that says who CALLS a concern (TL_EFF_MAP_ANSWER_FIRST):
 * the direct members are those whose body holds a call on one of the type's
 * `collaborators` named for a term (`concernCallMatches`; or the "named" rule), and
 * the others are the members that call one of those (bare or through `this`/`self`) —
 * one level, as the map follows its helpers. A record accessor on a parameter makes
 * no member a payment member. Source order; never a constructor or a nested type.
 */
export function collaboratorConcernMembers(
  type: StructureMapType,
  lines: readonly string[],
  terms: readonly string[],
  collaborators: ConcernCallRule,
): StructureMapMember[] {
  return concernMembersByReach(type, lines, terms, collaborators).all;
}

/** The direct callable members of `type` (never a constructor or a nested type) whose name is one of `names`: the members a request names. */
export function membersNamed(type: StructureMapType, names: readonly string[]): StructureMapMember[] {
  const wanted = new Set(names);
  return type.members.filter((member) => !member.nestedType && !member.constructor && wanted.has(member.name));
}

/**
 * The members whose whole bodies answer a question about how `type` calls the
 * concerns `terms` (a greedy set cover, in source order): the ENTRY POINT
 * first — the member that invokes the most of the named concerns, the earliest
 * in the source on a tie — then, while some concern a direct member invokes is
 * still unaccounted for, the member that invokes the most of what is left (the
 * smaller body on a tie, then the earlier one). A concern no member invokes is
 * left out of the question rather than forcing the cover (the facet gate
 * discloses it as it always has). `[]` when no direct member invokes any
 * concern, or when the cover would need more than `max` members: a request
 * that spreads over that many members is not answered from an entry point.
 * `collaborators` (the type's collaborator fields, or the "named" rule) narrows
 * "invokes" to a call that rule counts (`directConcernMembers`): an accessor on a
 * parameter is no entry point.
 *
 * `required` are the members the request NAMES (`membersNamed`): the ones of them
 * that invoke a concern are in the cover as well — added to the cover the entry point
 * and the greedy rest make, which is the cover the request would have had without
 * naming them (the entry point stays the entry point). One that does not invoke a
 * concern needs no place in a cover, and a cover that the named members would take
 * past `max` is no cover: `[]`.
 */
export function coverMembers(
  type: StructureMapType,
  lines: readonly string[],
  terms: readonly string[],
  max: number = STRUCTURE_MAP_COVER_MAX_MEMBERS,
  collaborators?: ConcernCallRule,
  required: readonly StructureMapMember[] = [],
): StructureMapMember[] {
  const direct = directConcernMembers(type, lines, terms, collaborators);
  if (direct.size === 0) return [];
  let entry: StructureMapMember | undefined;
  for (const [member, found] of direct) {
    if (entry === undefined || found.size > direct.get(entry)!.size) entry = member;
  }
  const cover: StructureMapMember[] = [entry!];
  const uncovered = new Set<string>();
  for (const found of direct.values()) for (const term of found) uncovered.add(term);
  for (const term of direct.get(entry!)!) uncovered.delete(term);
  const bodyBytes = (member: StructureMapMember): number => {
    let total = 0;
    for (let line = member.signatureStart; line <= member.end; line += 1) total += Buffer.byteLength(lines[line - 1] ?? "", "utf8") + 1;
    return total;
  };
  while (uncovered.size > 0) {
    let best: StructureMapMember | undefined;
    let bestGain = 0;
    for (const [member, found] of direct) {
      if (cover.includes(member)) continue;
      let gain = 0;
      for (const term of found) if (uncovered.has(term)) gain += 1;
      if (gain > bestGain || (gain === bestGain && gain > 0 && best !== undefined && bodyBytes(member) < bodyBytes(best))) {
        best = member;
        bestGain = gain;
      }
    }
    if (best === undefined) break;
    cover.push(best);
    for (const term of direct.get(best)!) uncovered.delete(term);
  }
  if (cover.length > max) return [];
  for (const member of required) if (direct.has(member) && !cover.includes(member)) cover.push(member);
  if (cover.length > max) return [];
  return cover.sort((left, right) => left.start - right.start);
}

/**
 * TL_EFF_MAP_ANSWER_FIRST: the ONE rule for what a concern call is in this type, and the
 * cover under it. T03's rule first — a call that hangs from a collaborator field
 * (`collaboratorFields`, widened to the fields a constructor builds or conventionally
 * receives) — and only when it yields no cover at all, the "named" rule (`namedConcernRule`:
 * a call whose receiver chain or callee names a concern, except a data accessor on a
 * parameter or a local and a call of the type's own member through `this`). With no
 * collaborator the named rule decides from the start: the map's own looser rule counts a
 * record accessor on a parameter (`req.paymentMethod()`) as a call on a payment collaborator
 * and answer-first never states that. `namedMembers` are the names the request writes for
 * callables and identifiers: the members of the type among them that call a concern are in
 * the cover too (`coverMembers` `required`), and when the cover cannot hold them there is no
 * cover (the caller then serves the ordinary map). `undefined` when no member calls a
 * concern under either rule, or the named members do not fit.
 */
export function answerFirstCover(
  type: StructureMapType,
  lines: readonly string[],
  terms: readonly string[],
  namedMembers: readonly string[] = [],
): { readonly rule: ConcernCallRule; readonly cover: StructureMapMember[]; readonly collaborators: ReadonlySet<string> } | undefined {
  const collaborators = collaboratorFields(type, lines);
  let rule: ConcernCallRule = collaborators.size > 0 ? collaborators : namedConcernRule(lines, collaborators);
  let cover = coverMembers(type, lines, terms, undefined, rule);
  if (cover.length === 0 && collaborators.size > 0) {
    rule = namedConcernRule(lines, collaborators);
    cover = coverMembers(type, lines, terms, undefined, rule);
  }
  if (cover.length === 0) return undefined;
  // The members the request names are part of its question: a named member that calls a concern is in the cover, or the core is no answer.
  cover = coverMembers(type, lines, terms, undefined, rule, membersNamed(type, namedMembers));
  return cover.length === 0 ? undefined : { rule, cover, collaborators };
}

export interface StructureMapPlanOptions {
  /** What a member that invokes a requested concern contributes; "whole" when absent (see StructureMapBodies). */
  readonly bodies?: StructureMapBodies;
  /** Spans a caller needs whole inside a member's body (see memberMapWindows); read when `bodies` is "rows". */
  readonly anchors?: readonly StructureMapSpan[];
  /**
   * ANSWER-FIRST (TL_EFF_MAP_ANSWER_FIRST): the plan is the CORE evidence —
   * the header, every member's signature and the whole bodies of these members
   * (`coverMembers`), each body taken whole or not at all, never as a prefix —
   * and no other member contributes a body. Absent, today's plan, unchanged.
   */
  readonly cover?: readonly StructureMapMember[];
  /**
   * With `cover`: the type's leading constructors leave the header (the page's
   * last priority). Each is served as its signature stub like any member, and
   * its body stays owed.
   */
  readonly constructorsLast?: boolean;
}

export interface StructureMapPlan {
  /** Every window the map serves, in source order, never overlapping. */
  readonly windows: readonly StructureMapWindow[];
  /** The lines of `[type.start, type.end]` the map does not serve, split at each member's first line. */
  readonly remaining: readonly StructureMapSpan[];
  /** Source bytes of the served windows (each line plus its newline). */
  readonly bytes: number;
}

/**
 * The map of `type` for `terms`: doc comment (when short), header (up to
 * STRUCTURE_MAP_HEADER_MAX_BYTES), every member's signature, and the
 * statements that call `terms` or the type's concern helpers — in that
 * priority under STRUCTURE_MAP_MAX_BYTES, then laid out in source order.
 * Whatever does not fit stays in `remaining`, so a plan entry that requires it
 * stays open (an honest `next`), never silently covered.
 */
export function planStructureMap(
  type: StructureMapType,
  lines: readonly string[],
  terms: readonly string[],
  maxBytes: number = STRUCTURE_MAP_MAX_BYTES,
  includeDoc = true,
  options: StructureMapPlanOptions = {},
): StructureMapPlan {
  const lineBytes = (line: number): number => Buffer.byteLength(lines[line - 1] ?? "", "utf8") + 1;
  const spanBytes = (span: StructureMapSpan): number => {
    let total = 0;
    for (let line = span.start; line <= span.end; line += 1) total += lineBytes(line);
    return total;
  };
  const taken: StructureMapWindow[] = [];
  let bytes = 0;
  const take = (window: StructureMapWindow): boolean => {
    const cost = spanBytes(window);
    if (bytes + cost > maxBytes) return false;
    bytes += cost;
    taken.push(window);
    return true;
  };

  // The doc comment is the declaration's own: the extent begins above it when a member is declared first.
  const docStart = type.docStart ?? type.start;
  const docEnd = type.signatureStart - 1;
  if (includeDoc && docEnd >= docStart) {
    const doc: StructureMapWindow = { kind: "doc", member: type.name, start: docStart, end: docEnd };
    if (docEnd - docStart + 1 <= STRUCTURE_MAP_DOC_MAX_LINES && spanBytes(doc) <= STRUCTURE_MAP_DOC_MAX_BYTES) take(doc);
  }
  let headerEnd = headerEndOf(type);
  if (options.cover !== undefined && options.constructorsLast === true) {
    const firstConstructor = type.members.find((member) => member.constructor && member.outOfLine !== true && member.start <= headerEnd);
    if (firstConstructor !== undefined) headerEnd = Math.max(type.signatureEnd, firstConstructor.start - 1);
  }
  let headerBytes = 0;
  for (let line = type.signatureStart; line <= headerEnd; line += 1) {
    headerBytes += lineBytes(line);
    if (headerBytes > STRUCTURE_MAP_HEADER_MAX_BYTES) { headerEnd = line - 1; break; }
  }
  if (headerEnd >= type.signatureStart) take({ kind: "header", member: type.name, start: type.signatureStart, end: headerEnd });
  // The constructors a type has OUTSIDE its declaration (a Go `NewDesk`) are the
  // header's too — they wire the collaborators the struct declares — whole, in
  // source order, while the header's own byte budget lasts; one that does not fit
  // is mapped like any member (its signature, its concern rows) and its body stays
  // owed. The answer-first core gives constructors up (`constructorsLast`), these
  // included.
  const constructorHeaders: StructureMapSpan[] = [];
  if (!(options.cover !== undefined && options.constructorsLast === true)) {
    let spent = headerEnd >= type.signatureStart ? spanBytes({ start: type.signatureStart, end: headerEnd }) : 0;
    for (const member of type.members) {
      if (!member.constructor || member.outOfLine !== true) continue;
      const cost = spanBytes(member);
      if (spent + cost > STRUCTURE_MAP_HEADER_MAX_BYTES || !take({ kind: "header", member: member.name, start: member.start, end: member.end })) continue;
      spent += cost;
      constructorHeaders.push({ start: member.start, end: member.end });
    }
  }
  const coveredByHeader = (span: StructureMapSpan): boolean =>
    (span.start >= type.signatureStart && span.end <= headerEnd)
    || constructorHeaders.some((window) => span.start >= window.start && span.end <= window.end);

  const helpers = concernHelperNames(type, lines, terms);
  const collaborators = options.bodies === "rows" ? collaboratorFields(type, lines) : undefined;
  const fields = options.bodies === "rows" && options.cover === undefined ? typeFieldNames({ lines, path: type.path, start: type.signatureEnd + 1, end: type.end, signature: { start: type.signatureStart, end: type.signatureEnd }, members: type.members }) : undefined;
  const mapped = type.members.map((member) => ({
    member,
    // The core (answer-first) takes no concern body but its cover's own.
    spans: options.cover !== undefined ? [] : memberMapWindows(member, lines, member.nestedType ? [] : terms, helpers, options.bodies, options.anchors, collaborators, fields)
      .filter((span) => !coveredByHeader(span)),
  }));
  // Preserve the outline before spending the page budget on complete member
  // bodies. An oversized body stays owed instead of becoming a false proof.
  // The lines that open the blocks the members are in (a Rust `impl Trait for T {`)
  // are part of it: they say whose each signature is.
  for (const span of type.containerHeaders ?? []) take({ kind: "signature", member: type.name, ...span });
  for (const { member } of mapped) {
    const signature = { start: member.signatureStart, end: member.signatureEnd };
    if (!coveredByHeader(signature)) take({ kind: "signature", member: member.name, ...signature });
  }
  // The cover's bodies, right after the outline and before anything else: whole or not at all.
  for (const member of options.cover ?? []) {
    const body = { start: member.signatureEnd + 1, end: member.end };
    if (body.start <= body.end) take({ kind: "call", member: member.name, ...body });
  }
  for (const { member, spans } of mapped) {
    for (const span of spans) {
      const body = { start: Math.max(span.start, member.signatureEnd + 1), end: span.end };
      if (body.start > body.end || take({ kind: "call", member: member.name, ...body })) continue;
      // Fill spare page capacity with an exact prefix. The rest remains owed;
      // the required body windows are independent of this first-page layout.
      let end = body.start - 1, cost = 0;
      while (end < body.end && bytes + cost + lineBytes(end + 1) <= maxBytes) cost += lineBytes(++end);
      if (end >= body.start) take({kind: "call", member: member.name, start: body.start, end});
    }
  }

  const windows = taken.sort((left, right) => left.start - right.start);
  // Each member's first line (its doc comment's) splits the remainder, so an
  // owed window holds the lines of one member — its doc comment, or the rest
  // of its body — and is a ready zoom target.
  const cuts = new Set<number>(type.members.map((member) => member.start));
  const remaining: StructureMapSpan[] = [];
  let cursor = type.start;
  const pushGap = (start: number, end: number): void => {
    let pieceStart = start;
    for (let line = start + 1; line <= end; line += 1) {
      if (cuts.has(line)) {
        remaining.push({ start: pieceStart, end: line - 1 });
        pieceStart = line;
      }
    }
    remaining.push({ start: pieceStart, end });
  };
  for (const window of windows) {
    if (window.start > cursor) pushGap(cursor, window.start - 1);
    cursor = Math.max(cursor, window.end + 1);
  }
  if (cursor <= type.end) pushGap(cursor, type.end);
  return { windows, remaining, bytes };
}

/**
 * Capitalized identifiers the header's code lines name (comments skipped), in
 * first-appearance order, most-named first — the candidates for the state
 * types (enums) a map serves beside the type.
 */
export function headerTypeNames(lines: readonly string[], header: StructureMapSpan, ownName: string): string[] {
  const counts = new Map<string, number>();
  for (let line = header.start; line <= header.end; line += 1) {
    const text = lines[line - 1] ?? "";
    if (COMMENT_LINE_RE.test(text)) continue;
    for (const match of text.replace(/"(?:[^"\\]|\\.)*"/gu, "\"\"").matchAll(/\b[A-Z][A-Za-z0-9_]*\b/gu)) {
      const name = match[0];
      if (name === ownName || /^[A-Z0-9_]+$/u.test(name)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([name]) => name);
}
