/**
 * intentLeadGenerator.ts — pure query generator for `intentLeadMatrix.spec.ts`
 * (MX-A, 2026-09-14, `scratchpad/brief-matrix.md`).
 *
 * Generates the FULL register x pattern grid (every register crossed with
 * every pattern), round-robining the VERB and OBJECT-SHAPE axes across that
 * grid so every mutation verb (EN, read live off `requestItems.ts`'s own
 * `MUTATION_VERBS_EN` so this file cannot drift from the shared vocabulary
 * AC1/others are concurrently editing) and every JA edit verb and every
 * object shape gets exercised many times over, without needing a full N-way
 * cross product (registers x patterns alone is already "hundreds", per the
 * brief's own framing that pure-layer cells are cheap).
 *
 * Deliberately does NOT try to hand-simulate `requestItemLeads`'s own
 * regex/clause engine to predict an exact lead per generated sentence — that
 * would just be a second, parallel (and likely buggier) implementation of
 * the thing under test. Instead every `Cell` below carries the INTENT its
 * own construction encodes (`editPaths`/`readPaths`/`editUnlocatable`/
 * `ambiguousAlternative`/`readOnly`), and the spec checks the brief's own
 * behavioural invariants against that intent — e.g. "no path outside
 * `editPaths` is ever writable" catches a BLOCKER-61-shaped leak wherever
 * this grid reproduces its SHAPE, without this file needing to know which
 * exact file a leak would land on.
 *
 * JA verb conjugation: a clause's own trailing tail (してください/して/しろ/
 * している/…) is computed HERE, per (register, isLastClause) via `jaTailFor`,
 * and baked into the clause text by the clause builders below — registers
 * then just join ALREADY-COMPLETE JA clauses with a plain "、"/"。" boundary.
 * (An earlier draft had the REGISTER inject a literal "し、" separator
 * between clauses whose own tail it did not control, which silently
 * produced invalid strings like "...ください し、..." whenever the
 * preceding clause already ended in a complete てください form — caught by
 * this file's own dry-run probe, `scratchpad/mxa-dryrun.mjs`, before it ever
 * reached the spec.)
 */
import { MUTATION_VERBS_EN } from "../../features/task-pack/requestItems.js";

// ---------------------------------------------------------------------------
// Verb vocabularies. EN is read LIVE off the shared constant; JA is the
// explicit 9-verb vocabulary `EDIT_VERB_JA_ROOT_RE` recognizes (six taking
// OPTIONAL し/して inflection, three — 設定/追加/削除 — REQUIRING it; see that
// regex's own comment in requestItems.ts). JA read stems (説明/確認) mirror
// `READ_VERB_TRAILING_JA_RE`'s own し/して-optional group — sharing that
// conjugation shape with the edit verbs lets one `jaTailFor` serve both.
// ---------------------------------------------------------------------------

export const EN_MUTATION_VERBS: readonly string[] = MUTATION_VERBS_EN.split("|");
export const JA_EDIT_VERBS: readonly string[] = ["変更", "更新", "修正", "置換", "改名", "リネーム", "設定", "追加", "削除"];
export const JA_READ_STEMS: readonly string[] = ["説明", "確認"];
/** The three words the brief's "JA nouns" register specifically probes (設定/更新/変更 as bare NOUNS, never conjugated). */
export const JA_NOUN_WORDS: readonly string[] = ["設定", "更新", "変更"];

export const EN_READ_STARTERS: readonly string[] = ["explain", "describe", "clarify", "tell me about"];

const REMOVAL_VERBS_EN = new Set(["remove", "delete"]);
const CREATION_VERBS_EN = new Set(["add", "insert", "create", "generate", "implement", "expose"]);
type VerbFamily = "removal" | "creation" | "value";
function enVerbFamily(verb: string): VerbFamily {
  if (REMOVAL_VERBS_EN.has(verb)) return "removal";
  if (CREATION_VERBS_EN.has(verb)) return "creation";
  return "value";
}
function jaVerbFamily(verb: string): VerbFamily {
  if (verb === "削除") return "removal";
  if (verb === "追加") return "creation";
  return "value";
}

// ---------------------------------------------------------------------------
// Targets. PRIMARY/SECONDARY mirror `buildEvalWorkspace()`'s own
// `src/retry.ts`/`src/cache.ts` exactly (same identifiers, same starting
// values) so the SAME generator output is valid against that real fixture.
// CHANGELOG_PATH/NOTES_PATH mirror `buildWriteAuthorityLeakWorkspace()`'s own
// decoy files (AC1's BLOCKER-61 regression pin) so a noun-phrase/bare-
// filename cell resolves against a file that really exists in the combined
// workspace `intentLeadDecoyFixture.ts` builds.
// ---------------------------------------------------------------------------

export interface Target {
  path: string;
  identifier: string;
  oldValue: string;
  newValue: string;
}
export const PRIMARY: Target = { path: "src/retry.ts", identifier: "MAX_RETRIES", oldValue: "3", newValue: "5" };
export const SECONDARY: Target = { path: "src/cache.ts", identifier: "DEFAULT_TTL_MS", oldValue: "60000", newValue: "30000" };
export const CHANGELOG_PATH = "CHANGELOG.md";
export const NOTES_PATH = "notes.txt";

// ---------------------------------------------------------------------------
// Object shapes (brief: "explicit path + identifier; identifier only...;
// pronoun + value; quoted numeric/boolean value; quoted filename; bare
// filename; noun phrase; no object"). `pronoun-value`/`none` need an
// ANTECEDENT clause naming the target — the generator only offers them to
// patterns that provide one (`read-edit-same-path`, `edit-unlocatable`'s own
// deliberately-antecedent-free case).
//
// NOTE: shapes beyond `path-identifier`/`identifier-only` are deliberately
// NOT verb-family-specialized (e.g. a `removal`-family verb still gets a
// "to <value>" `quoted-value` clause) — mildly unnatural English/JA for a
// few (verb, shape) pairs, but every regex this matrix probes classifies on
// clause-initial/clause-final VERB and TERM SHAPE, never on semantic
// fluency, so this trades a little naturalness for a much smaller,
// auditable generator.
// ---------------------------------------------------------------------------

export type ObjectShape =
  | "path-identifier"
  | "identifier-only"
  | "pronoun-value"
  | "quoted-value"
  | "quoted-filename"
  | "bare-filename"
  | "noun-phrase"
  | "none";

export const OBJECT_SHAPES_NO_ANTECEDENT: readonly ObjectShape[] = [
  "path-identifier", "identifier-only", "quoted-value", "quoted-filename", "bare-filename", "noun-phrase",
];
export const OBJECT_SHAPES_WITH_ANTECEDENT: readonly ObjectShape[] = ["pronoun-value", "none"];
export const OBJECT_SHAPES_ALL: readonly ObjectShape[] = [
  ...OBJECT_SHAPES_NO_ANTECEDENT, ...OBJECT_SHAPES_WITH_ANTECEDENT,
];

type ReadObjectShape = "path-identifier" | "identifier-only" | "noun-phrase";
const READ_OBJECT_SHAPES: readonly ReadObjectShape[] = ["path-identifier", "identifier-only", "noun-phrase"];

// ---------------------------------------------------------------------------
// Registers — clause boundary + lead shape.
// ---------------------------------------------------------------------------

export type RegisterLang = "en" | "ja" | "mixed";

export interface Register {
  id: string;
  lang: RegisterLang;
  /** EN/mixed only: joins already-punctuated, already-capitalized-per-clause EN clause text. JA registers all use the uniform `、`/`。` join below — see `jaTailFor`. */
  render?(clauses: readonly string[]): string;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
function enJoin(sep: string, clauses: readonly string[]): string {
  return `${cap(clauses.join(sep))}.`;
}

export const REGISTERS: readonly Register[] = [
  // --- EN -------------------------------------------------------------------
  { id: "dot", lang: "en", render: (cs) => cs.map((c) => `${cap(c)}.`).join(" ") },
  {
    id: "qmark", lang: "en",
    render: (cs) => cs.length === 1
      ? `${cap(cs[0]!)}?`
      : `${cap(cs[0]!)}? ${cs.slice(1).map((c) => `${cap(c)}.`).join(" ")}`,
  },
  { id: "semicolon", lang: "en", render: (cs) => enJoin("; ", cs) },
  { id: "comma-and", lang: "en", render: (cs) => enJoin(", and ", cs) },
  { id: "and-then", lang: "en", render: (cs) => enJoin(", and then ", cs) },
  { id: "then", lang: "en", render: (cs) => enJoin(", then ", cs) },
  { id: "also", lang: "en", render: (cs) => enJoin(", and also ", cs) },
  { id: "bullets", lang: "en", render: (cs) => cs.map((c) => `- ${cap(c)}.`).join("\n") },
  { id: "colon-read", lang: "en", render: (cs) => `Update:\n${cs.map((c) => `${cap(c)}.`).join(" ")}` },
  { id: "colon-edit", lang: "en", render: (cs) => `Update:\n${cs.map((c) => `${cap(c)}.`).join(" ")}` },
  { id: "politeness-please", lang: "en", render: (cs) => `Please ${cs.join(", and ")}.` },
  { id: "politeness-could-you", lang: "en", render: (cs) => `Could you ${cs.join(", and ")}?` },
  { id: "politeness-kindly", lang: "en", render: (cs) => `Kindly ${cs.join(", and ")}.` },
  // --- JA (render is unused — see jaTailFor/renderJa) ------------------------
  { id: "ja-continuative", lang: "ja" },
  { id: "ja-te-kudasai", lang: "ja" },
  { id: "ja-te", lang: "ja" },
  { id: "ja-shiro", lang: "ja" },
  { id: "ja-teiru", lang: "ja" },
  { id: "ja-teimasu", lang: "ja" },
  { id: "ja-teinai", lang: "ja" },
  { id: "ja-teru", lang: "ja" },
  { id: "ja-nouns", lang: "ja" },
  // --- Mixed --------------------------------------------------------------
  // Deliberately does NOT `cap()` — a JA clause built via `path-identifier`/
  // `bare-filename`/`quoted-filename` shape starts with the bare PATH
  // itself (JA is head-final: "src/cache.ts の…"), and forced capitalization
  // would turn it into "Src/cache.ts" — a DIFFERENT, non-existent path on a
  // case-sensitive filesystem. Every regex this matrix probes is
  // case-insensitive on its EN side ("iu" flags throughout requestItems.ts),
  // so dropping capitalization costs nothing functionally.
  { id: "mixed-en-ja", lang: "mixed", render: (cs) => cs.map((c) => `${c}.`).join(" ") },
  // --- review-findings-final.md NOTE 6 -------------------------------------
  // Five register dimensions the reviewer measured by hand (rv11-qmark.mjs)
  // that the grid did not enumerate. Deliberately APPENDED after every
  // pre-existing register, never interspersed: `generateCells()`'s verb/
  // object-shape round-robin is keyed off a running counter over
  // `REGISTERS x PATTERNS`, so inserting a new register EARLIER in this
  // array would shift the counter for every register/pattern pair after it,
  // silently reassigning which (verb, object-shape) combination every
  // PRE-EXISTING cell downstream renders (and, with it, the coverage
  // sampler's greedy walk) — an incidental side effect on cells this wave
  // never intended to touch. Appending at the end changes nothing about any
  // register declared above.
  //
  // `bang`/`newline`/`and-next` slot in exactly like their `qmark`/`bullets`/
  // `and-then` siblings above. The two JA fullwidth registers are declared
  // here (render unused, same convention as every other JA register) and
  // handled by `renderClauses`'s own id-keyed branch below, since their
  // shape (a fullwidth ！/？ terminal on the first clause, plain "。" on
  // every clause after it — mirroring `qmark`'s own first-clause asymmetry
  // rather than `renderJa`'s uniform comma-then-period join) does not fit
  // the uniform JA renderer. Confirmed against the product's own regexes
  // (`requestItems.ts`): the tail-anchor `[.!?。！？]?\s*$` and
  // `LEAD_CLAUSE_BOUNDARY_RE`'s `(?<=[。？！])` both already treat fullwidth
  // `！`/`？` as ordinary clause-terminal punctuation, so this is a
  // legitimate boundary shape to probe, not a string the product has no
  // vocabulary for.
  { id: "bang", lang: "en", render: (cs) => (cs.length === 1 ? `${cap(cs[0]!)}!` : `${cap(cs[0]!)}! ${cs.slice(1).map((c) => `${cap(c)}.`).join(" ")}`) },
  { id: "newline", lang: "en", render: (cs) => cs.map((c) => `${cap(c)}.`).join("\n") },
  { id: "and-next", lang: "en", render: (cs) => enJoin(", and next ", cs) },
  { id: "ja-fullwidth-bang", lang: "ja" },
  { id: "ja-fullwidth-qmark", lang: "ja" },
];

/**
 * The conjugation TAIL a JA clause ending in a bare verb root takes, for
 * this register, at this position. `ja-continuative`'s own "〜し、〜" shape
 * is exactly this: every non-last clause takes the bare continuative stem
 * ("し"), and only the LAST clause takes a complete, polite terminal form —
 * every OTHER JA register uses the SAME tail on every clause (a natural,
 * ordinary multi-request JA sentence repeats its own register per clause).
 * "し" alone (never "") is used for EVERY non-final continuative tail so the
 * THREE verbs whose inflection is MANDATORY (設定/追加/削除) still satisfy
 * `EDIT_VERB_JA_ROOT_RE`/`READ_VERB_TRAILING_JA_RE`, not just the six whose
 * inflection is optional.
 */
function jaTailFor(registerId: string, isLast: boolean): string {
  if (registerId === "ja-continuative") return isLast ? "してください" : "し";
  switch (registerId) {
    case "ja-te-kudasai": return "してください";
    case "ja-te": return "して";
    case "ja-shiro": return "しろ";
    case "ja-teiru": return "している";
    case "ja-teimasu": return "しています";
    case "ja-teinai": return "していない";
    case "ja-teru": return "してる";
    default: return "してください";
  }
}

function renderJa(clauses: readonly string[]): string {
  return `${clauses.join("、")}。`;
}

/**
 * `ja-fullwidth-bang`/`ja-fullwidth-qmark` — the FIRST clause is terminated
 * with the fullwidth mark (`！`/`？`) instead of the usual `、` continuative
 * join; every remaining clause is its own complete sentence ending in plain
 * `。`, mirroring the EN `qmark` register's own asymmetry (first clause gets
 * the distinctive mark, the rest are ordinary terminated sentences) rather
 * than `renderJa`'s uniform comma-then-period join. Confirmed against the
 * product's own regexes (`requestItems.ts`): the tail-anchor
 * `[.!?。！？]?\s*$` and `LEAD_CLAUSE_BOUNDARY_RE`'s
 * `(?<=[。？！])` both already treat fullwidth `！`/`？` as ordinary
 * clause-terminal punctuation, so this is a legitimate boundary shape to
 * probe, not a string the product has no vocabulary for.
 */
function renderJaFirstMarked(clauses: readonly string[], mark: string): string {
  if (clauses.length === 1) return `${clauses[0]!}${mark}`;
  return `${clauses[0]!}${mark}${clauses.slice(1).map((c) => `${c}。`).join("")}`;
}

/**
 * Registers whose own conjugation tail does not reach either JA lead
 * regex's required end-of-string shape (see `Cell.looseIntent`'s own doc).
 * Verified by inspection: `EDIT_VERB_JA_ROOT_RE`/`READ_VERB_TRAILING_JA_RE`
 * both end `(?:し|して)?(?:ください|下さい)?[。.]?\s*$` — a further ている/
 * ています/ていない/てる tail after the verb root never satisfies that.
 */
const LOOSE_INTENT_REGISTERS = new Set(["ja-teiru", "ja-teimasu", "ja-teinai", "ja-teru"]);

// ---------------------------------------------------------------------------
// Clause builders. Return the clause TEXT (EN: no leading capital, no
// trailing punctuation — the register adds both; JA: fully conjugated,
// register adds only the join/period) plus which target path(s) this
// clause, on its own construction, names or uniquely implies.
// ---------------------------------------------------------------------------

interface ClauseResult {
  text: string;
  paths: string[];
}

function enEditClause(verb: string, shape: ObjectShape, t: Target): ClauseResult {
  const fam = enVerbFamily(verb);
  switch (shape) {
    case "path-identifier":
      if (fam === "removal") return { text: `${verb} ${t.identifier} from ${t.path}`, paths: [t.path] };
      if (fam === "creation") return { text: `${verb} a MIN_RETRIES constant to ${t.path}`, paths: [t.path] };
      return { text: `${verb} ${t.identifier} in ${t.path} to ${t.newValue}`, paths: [t.path] };
    case "identifier-only":
      if (fam === "removal") return { text: `${verb} ${t.identifier}`, paths: [t.path] };
      if (fam === "creation") return { text: `${verb} a MIN_RETRIES constant near ${t.identifier}`, paths: [t.path] };
      return { text: `${verb} ${t.identifier} to ${t.newValue}`, paths: [t.path] };
    case "pronoun-value":
      return { text: fam === "removal" ? `${verb} it` : `${verb} it to ${t.newValue}`, paths: [] };
    case "quoted-value":
      return { text: `${verb} ${t.identifier} in ${t.path} to "${t.newValue}"`, paths: [t.path] };
    case "quoted-filename":
      return { text: `${verb} "${t.path}"`, paths: [t.path] };
    case "bare-filename":
      return { text: `${verb} ${t.path}`, paths: [t.path] };
    case "noun-phrase":
      return { text: `${verb} the changelog`, paths: [CHANGELOG_PATH] };
    case "none":
      return { text: `${verb} it`, paths: [] };
  }
}

function jaEditClause(verb: string, shape: ObjectShape, t: Target, tail: string): ClauseResult {
  const fam = jaVerbFamily(verb);
  const conjugated = `${verb}${tail}`;
  switch (shape) {
    case "path-identifier":
      if (fam === "removal") return { text: `${t.path} の ${t.identifier} を${conjugated}`, paths: [t.path] };
      return { text: `${t.path} の ${t.identifier} を ${t.newValue} に${conjugated}`, paths: [t.path] };
    case "identifier-only":
      if (fam === "removal") return { text: `${t.identifier} を${conjugated}`, paths: [t.path] };
      return { text: `${t.identifier} を ${t.newValue} に${conjugated}`, paths: [t.path] };
    case "pronoun-value":
      return { text: fam === "removal" ? `それ を${conjugated}` : `それ を ${t.newValue} に${conjugated}`, paths: [] };
    case "quoted-value":
      return { text: `${t.identifier} を "${t.newValue}" に${conjugated}`, paths: [t.path] };
    case "quoted-filename":
      return { text: `"${t.path}" に${conjugated}`, paths: [t.path] };
    case "bare-filename":
      return { text: `${t.path} に${conjugated}`, paths: [t.path] };
    case "noun-phrase":
      return { text: `変更履歴 を${conjugated}`, paths: [CHANGELOG_PATH] };
    case "none":
      return { text: `${t.newValue} に${conjugated}`, paths: [] };
  }
}

function enReadClause(starter: string, shape: ReadObjectShape, t: Target): ClauseResult {
  switch (shape) {
    case "path-identifier":
      return { text: `${starter} how ${t.identifier} works in ${t.path}`, paths: [t.path] };
    case "identifier-only":
      return { text: `${starter} what ${t.identifier} does`, paths: [t.path] };
    case "noun-phrase":
      return { text: `${starter} the retry configuration`, paths: [] };
  }
}

function jaReadClause(stem: string, shape: ReadObjectShape, t: Target, tail: string): ClauseResult {
  const conjugated = `${stem}${tail}`;
  switch (shape) {
    case "path-identifier":
      return { text: `${t.path} の ${t.identifier} の役割を${conjugated}`, paths: [t.path] };
    case "identifier-only":
      return { text: `${t.identifier} の役割を${conjugated}`, paths: [t.path] };
    case "noun-phrase":
      return { text: `リトライ処理の仕組みを${conjugated}`, paths: [] };
  }
}

// ---------------------------------------------------------------------------
// Patterns.
// ---------------------------------------------------------------------------

export type PatternId =
  | "read-only"
  | "edit-only"
  | "read-edit-same-path"
  | "read-edit-diff-edit-second"
  | "read-edit-diff-edit-first"
  | "two-edits-diff-paths"
  | "three-items"
  | "edit-unlocatable"
  | "or-alternative";

export const PATTERNS: readonly PatternId[] = [
  "read-only",
  "edit-only",
  "read-edit-same-path",
  "read-edit-diff-edit-second",
  "read-edit-diff-edit-first",
  "two-edits-diff-paths",
  "three-items",
  "edit-unlocatable",
  "or-alternative",
];

export interface Cell {
  id: string;
  query: string;
  lang: RegisterLang;
  register: string;
  pattern: PatternId;
  verb: string;
  objectShape: ObjectShape | ReadObjectShape | "n/a";
  /** Paths this cell's own construction names/implies as an EDIT target. */
  editPaths: string[];
  /** Paths this cell's own construction names/implies as a READ-ONLY topic (never itself an edit target). */
  readPaths: string[];
  /** True: the edit clause has NO locatable object anywhere in the query (genuinely unlocatable). */
  editUnlocatable: boolean;
  /** True: a genuine "or" alternative between >=2 candidate edit targets. */
  ambiguousAlternative: boolean;
  /** True: no edit clause at all — a pure noun-usage probe counts as this too. */
  readOnly: boolean;
  /** For `ambiguousAlternative` cells: the candidate paths. */
  alternativePaths?: string[];
  /**
   * True: this cell's own clause-final conjugation ("している"/"しています"/
   * "していない"/"してる") does NOT satisfy `EDIT_VERB_JA_ROOT_RE`/
   * `READ_VERB_TRAILING_JA_RE` at all (both require the match to reach the
   * literal string end via an OPTIONAL し/して then an OPTIONAL ください/
   * 下さい — a further ている/ています/ていない/てる tail never reaches that
   * end). Verified by inspection of both regexes, not asserted at runtime.
   * A STATEMENT about an ongoing/negated action ("…していない" = "has NOT…")
   * is also genuinely ambiguous as a "request" on ordinary JA-reading
   * grounds, independent of the regex. The spec therefore checks every
   * SAFETY invariant on these cells (no decoy/unnamed path ever writable, no
   * dead-end `next`, schema-valid `next`) but not the POSITIVE
   * classification ones (`editPaths` writable / profile "answer") — see
   * `matrix-A-inventory.md` for what was actually observed.
   */
  looseIntent: boolean;
}

let cellCounter = 0;
function nextId(register: string, pattern: string, verb: string): string {
  cellCounter += 1;
  const verbSlug = verb.replace(/\s+/gu, "-");
  return `c${String(cellCounter).padStart(3, "0")}-${register}-${pattern}-${verbSlug}`;
}

function editVerbFor(lang: "en" | "ja", idx: number): string {
  return lang === "ja" ? JA_EDIT_VERBS[idx % JA_EDIT_VERBS.length]! : EN_MUTATION_VERBS[idx % EN_MUTATION_VERBS.length]!;
}

/** Builds ONE edit clause in the cell's own language, using this register's own tail/position rules for JA. */
function buildEditClauseAt(lang: RegisterLang, registerId: string, isLast: boolean, verb: string, shape: ObjectShape, t: Target): ClauseResult {
  if (lang === "ja") return jaEditClause(verb, shape, t, jaTailFor(registerId, isLast));
  return enEditClause(verb, shape, t);
}
/** Builds ONE read clause in the cell's own language. `stemIdx` rotates the JA read stem (説明/確認). */
function buildReadClauseAt(lang: RegisterLang, registerId: string, isLast: boolean, starterIdx: number, shape: ReadObjectShape, t: Target): ClauseResult {
  if (lang === "ja") return jaReadClause(JA_READ_STEMS[starterIdx % JA_READ_STEMS.length]!, shape, t, jaTailFor(registerId, isLast));
  return enReadClause(EN_READ_STARTERS[starterIdx % EN_READ_STARTERS.length]!, shape, t);
}
function renderClauses(register: Register, clauses: readonly string[]): string {
  if (register.id === "ja-fullwidth-bang") return renderJaFirstMarked(clauses, "！");
  if (register.id === "ja-fullwidth-qmark") return renderJaFirstMarked(clauses, "？");
  return register.lang === "ja" ? renderJa(clauses) : register.render!(clauses);
}

/**
 * Special-cased: the brief's "JA nouns (設定/更新/変更 as nouns)" register.
 * Always produces a READ-shaped sentence mentioning one of the three words
 * as a bare NOUN (never conjugated as a verb) — the register exists
 * specifically to probe whether a bare noun mention of an edit-flavored
 * word wrongly earns an edit lead (see `src/cache.ts の設定値を説明してください。`,
 * the reviewers' own positive control, `scratchpad/r9-pure.mts`). Every
 * pattern slot still varies WHICH noun and which sentence shape is used, for
 * coverage, but the oracle is always "stays read-only".
 */
function buildJaNounsCell(patternIdx: number): { query: string; readPaths: string[]; noun: string } {
  // 3 nouns x 3 shapes, independently indexed, so the 9 pattern slots this
  // is called from (one per PatternId, see PATTERNS above) produce 9
  // DISTINCT sentences rather than the same 3 repeated three times.
  const noun = JA_NOUN_WORDS[patternIdx % JA_NOUN_WORDS.length]!;
  const shapes = [
    (): string => `${PRIMARY.path} の ${PRIMARY.identifier} の${noun}を説明してください`,
    (): string => `${PRIMARY.identifier} の${noun}値について教えてください`,
    // Deliberately avoids a hardcoded verb here (an earlier draft used
    // "…を変更した場合の…", which collides into "変更を変更した場合の…" —
    // "changing the change" — when `noun` is itself 変更; caught by this
    // file's own dry-run probe).
    (): string => `${noun}の意味について確認してください`,
  ];
  const shapeIdx = Math.floor(patternIdx / JA_NOUN_WORDS.length) % shapes.length;
  const text = shapes[shapeIdx]!();
  return { query: `${text}。`, readPaths: text.includes(PRIMARY.path) || text.includes(PRIMARY.identifier) ? [PRIMARY.path] : [], noun };
}

/**
 * Generate the FULL register x pattern grid (every register x every
 * pattern), round-robining verb/object-shape selection via a running
 * counter so every verb and every object shape is exercised many times
 * across the ~200 cells without a full 4-way cross product.
 */
export function generateCells(): Cell[] {
  const cells: Cell[] = [];
  let counter = 0;

  for (const register of REGISTERS) {
    for (const pattern of PATTERNS) {
      counter += 1;
      const lang = register.lang;
      const jaHalfLang: "en" | "ja" = lang === "en" ? "en" : "ja";
      const verb = editVerbFor(jaHalfLang, counter);
      const enVerbForMixedRead = EN_MUTATION_VERBS[counter % EN_MUTATION_VERBS.length]!;
      const readShape = READ_OBJECT_SHAPES[counter % READ_OBJECT_SHAPES.length]!;

      // --- ja-nouns: fully special-cased, bypasses the generic machinery. ---
      if (register.id === "ja-nouns") {
        const built = buildJaNounsCell(PATTERNS.indexOf(pattern));
        cells.push({
          id: nextId(register.id, pattern, built.noun),
          query: built.query,
          lang: "ja",
          register: register.id,
          pattern,
          verb: built.noun,
          objectShape: "noun-phrase",
          editPaths: [],
          readPaths: built.readPaths,
          editUnlocatable: false,
          ambiguousAlternative: false,
          readOnly: true,
          looseIntent: false,
        });
        continue;
      }

      const looseIntent = LOOSE_INTENT_REGISTERS.has(register.id);

      let clauses: string[] = [];
      let editPaths: string[] = [];
      let readPaths: string[] = [];
      let editUnlocatable = false;
      let ambiguousAlternative = false;
      let readOnly = false;
      let objectShape: ObjectShape | ReadObjectShape | "n/a" = "n/a";
      let alternativePaths: string[] | undefined;

      switch (pattern) {
        case "read-only": {
          readOnly = true;
          const rc = buildReadClauseAt(lang === "mixed" ? "en" : lang, register.id, true, counter, readShape, PRIMARY);
          clauses = [rc.text];
          readPaths = rc.paths;
          objectShape = readShape;
          break;
        }
        case "edit-only": {
          const shape = OBJECT_SHAPES_NO_ANTECEDENT[counter % OBJECT_SHAPES_NO_ANTECEDENT.length]!;
          const ecLang: "en" | "ja" = lang === "mixed" ? "ja" : lang;
          const ec = buildEditClauseAt(ecLang, register.id, true, verb, shape, PRIMARY);
          clauses = [ec.text];
          editPaths = ec.paths;
          objectShape = shape;
          break;
        }
        case "read-edit-same-path": {
          const shapePool = OBJECT_SHAPES_WITH_ANTECEDENT.concat(["path-identifier", "identifier-only"]);
          const shape = shapePool[counter % shapePool.length]!;
          const rc = buildReadClauseAt(lang === "mixed" ? "en" : "ja", register.id, false, counter, "path-identifier", PRIMARY);
          const ecLang: "en" | "ja" = lang === "mixed" ? "ja" : lang;
          const ecVerb = lang === "mixed" ? verb : verb;
          const ec = buildEditClauseAt(ecLang, register.id, true, ecVerb, shape, PRIMARY);
          const rcFinal = lang === "en" ? buildReadClauseAt("en", register.id, false, counter, "path-identifier", PRIMARY) : rc;
          clauses = [rcFinal.text, ec.text];
          readPaths = rcFinal.paths;
          // The antecedent-bearing shapes (pronoun/none) donate the READ
          // clause's own target as the edit target — that IS the BLOCKER-61
          // shape this pattern exists to re-probe.
          editPaths = ec.paths.length > 0 ? ec.paths : [PRIMARY.path];
          objectShape = shape;
          break;
        }
        case "read-edit-diff-edit-second": {
          const shape = OBJECT_SHAPES_NO_ANTECEDENT[counter % OBJECT_SHAPES_NO_ANTECEDENT.length]!;
          const rc = buildReadClauseAt(lang === "mixed" ? "en" : lang, register.id, false, counter, "path-identifier", SECONDARY);
          const ecLang: "en" | "ja" = lang === "mixed" ? "en" : lang;
          const ec = ecLang === "en" ? enEditClause(lang === "mixed" ? enVerbForMixedRead : verb, shape, PRIMARY)
            : buildEditClauseAt("ja", register.id, true, verb, shape, PRIMARY);
          clauses = [rc.text, ec.text];
          readPaths = rc.paths;
          editPaths = ec.paths;
          objectShape = shape;
          break;
        }
        case "read-edit-diff-edit-first": {
          const shape = OBJECT_SHAPES_NO_ANTECEDENT[counter % OBJECT_SHAPES_NO_ANTECEDENT.length]!;
          const ecLang: "en" | "ja" = lang === "mixed" ? "en" : lang;
          const ec = ecLang === "en" ? enEditClause(lang === "mixed" ? enVerbForMixedRead : verb, shape, PRIMARY)
            : buildEditClauseAt("ja", register.id, false, verb, shape, PRIMARY);
          const rc = buildReadClauseAt(lang === "mixed" ? "en" : lang, register.id, true, counter, "path-identifier", SECONDARY);
          clauses = [ec.text, rc.text];
          readPaths = rc.paths;
          editPaths = ec.paths;
          objectShape = shape;
          break;
        }
        case "two-edits-diff-paths": {
          const shape = OBJECT_SHAPES_NO_ANTECEDENT[counter % OBJECT_SHAPES_NO_ANTECEDENT.length]!;
          const verb2 = editVerbFor(lang === "mixed" ? "en" : jaHalfLang, counter + 1);
          const ec1Lang: "en" | "ja" = lang === "mixed" ? "ja" : lang;
          const ec1 = buildEditClauseAt(ec1Lang, register.id, false, verb, "path-identifier", SECONDARY);
          const ec2Lang: "en" | "ja" = lang === "mixed" ? "en" : lang;
          const ec2 = buildEditClauseAt(ec2Lang, register.id, true, verb2, shape, PRIMARY);
          clauses = [ec1.text, ec2.text];
          editPaths = [...ec1.paths, ...ec2.paths];
          objectShape = shape;
          break;
        }
        case "three-items": {
          const shape = OBJECT_SHAPES_NO_ANTECEDENT[counter % OBJECT_SHAPES_NO_ANTECEDENT.length]!;
          const rc = buildReadClauseAt(lang === "mixed" ? "en" : lang, register.id, false, counter, "path-identifier", SECONDARY);
          // The un-verbed middle item: a bare noun-phrase mention with NO
          // lead of its own (BLOCKER 34/61's own "does a lead-less item get
          // swept into either side" question).
          const middle = lang === "ja" ? "変更履歴" : "the changelog";
          const ecLang: "en" | "ja" = lang === "mixed" ? "en" : lang;
          const ec = ecLang === "en" ? enEditClause(lang === "mixed" ? enVerbForMixedRead : verb, shape, PRIMARY)
            : buildEditClauseAt("ja", register.id, true, verb, shape, PRIMARY);
          clauses = [rc.text, middle, ec.text];
          readPaths = rc.paths;
          editPaths = ec.paths;
          objectShape = shape;
          break;
        }
        case "edit-unlocatable": {
          // Deliberately the ONLY mention in the whole query: a bare
          // pronoun+value edit clause with NO identifier/path ANYWHERE —
          // genuinely nothing for a locator to find.
          editUnlocatable = true;
          const ecLang: "en" | "ja" = lang === "mixed" ? "ja" : lang;
          const ec = buildEditClauseAt(ecLang, register.id, true, lang === "mixed" ? verb : verb, "pronoun-value", PRIMARY);
          clauses = [ec.text];
          objectShape = "pronoun-value";
          break;
        }
        case "or-alternative": {
          ambiguousAlternative = true;
          alternativePaths = [PRIMARY.path, SECONDARY.path];
          const text = lang === "ja" || lang === "mixed"
            ? `${PRIMARY.path} または ${SECONDARY.path} の設定を直して${jaTailFor(register.id, true) === "し" ? "" : "ください"}`
            : `update ${PRIMARY.path} or ${SECONDARY.path} to fix the timeout issue`;
          clauses = [text];
          objectShape = "noun-phrase";
          break;
        }
      }

      const query = renderClauses(register, clauses);
      const verbTag = lang === "ja" ? verb : (lang === "mixed" ? `${verb}/${enVerbForMixedRead}` : verb);
      cells.push({
        id: nextId(register.id, pattern, verbTag),
        query,
        lang,
        register: register.id,
        pattern,
        verb: verbTag,
        objectShape,
        editPaths: [...new Set(editPaths)],
        readPaths: [...new Set(readPaths)].filter((p) => !editPaths.includes(p)),
        editUnlocatable,
        ambiguousAlternative,
        readOnly,
        looseIntent,
        ...(alternativePaths ? { alternativePaths } : {}),
      });
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Wire-layer coverage sampler. A full spawned-server run of all 207 pure-
// layer cells is not "cheap" the way a direct function call is (brief:
// wire layer gets "a representative sample ... every register once per
// pattern, every verb at least once, every object shape at least twice").
// Read literally + simultaneously, "every register once per pattern" would
// mean the full 23-register x 9-pattern grid (207 cells) — the SAME size as
// the pure layer, contradicting the brief's own ~60-100 target two clauses
// later. This sampler instead greedily walks the generator's OWN cell order
// (which already round-robins verb/object-shape) and keeps a cell only
// while it still increases coverage of an under-covered dimension —
// register, pattern, EN-or-JA verb, or object shape (floor 2) — which
// converges on "every register at least once, spread across several
// different patterns each" without the full cross product. Deterministic:
// same generator output in, same sample out.
// ---------------------------------------------------------------------------

export interface CoverageSampleOptions {
  minObjectShapeCount?: number;
}

export function selectCoverageSample(cells: readonly Cell[], options: CoverageSampleOptions = {}): Cell[] {
  const minObjectShapeCount = options.minObjectShapeCount ?? 2;
  const registersNeeded = new Set(REGISTERS.map((r) => r.id));
  const patternsNeeded = new Set(PATTERNS);
  const verbsNeeded = new Set([...EN_MUTATION_VERBS, ...JA_EDIT_VERBS]);
  const objectShapeCounts = new Map<string, number>();

  const selected: Cell[] = [];
  for (const cell of cells) {
    let helps = false;
    if (registersNeeded.has(cell.register)) helps = true;
    if (patternsNeeded.has(cell.pattern)) helps = true;
    for (const v of cell.verb.split("/")) if (verbsNeeded.has(v)) helps = true;
    const shapeCount = objectShapeCounts.get(cell.objectShape) ?? 0;
    if (shapeCount < minObjectShapeCount) helps = true;

    if (!helps) continue;

    selected.push(cell);
    registersNeeded.delete(cell.register);
    patternsNeeded.delete(cell.pattern);
    for (const v of cell.verb.split("/")) verbsNeeded.delete(v);
    objectShapeCounts.set(cell.objectShape, shapeCount + 1);
  }
  return selected;
}
