// anchorFocus — extracted implementation; imports point to the owning modules.
import { ANCHOR_FOCUS_BODY_WEIGHT } from "./anchorFocus.js";
import { ANCHOR_FOCUS_NAME_WEIGHT } from "./seededPackBuilder2.js";
import { ANCHOR_FOCUS_SYMBOL_COVERAGE_WEIGHT } from "./seededPackBuilder2.js";
import { PROTOCOL_IDENTIFIERS } from "./seededPackBuilder2.js";
import { anchorChainsOf } from "../anchorFirst.js";
import { declarationFramedNames } from "../declarationFraming.js";
import { inflectionVariants } from "../salientWordMatch.js";
import { isPascalCaseIdentifier } from "./anchorFocus.js";
import { isProseAcronym } from "../concernRecovery.js";
import { maskCitationFormatFields } from "../../../util/citationFormat.js";
import { maskEvaluationInputRecords } from "../../../util/evaluationInputs.js";
import { memberReferenceNames } from "../../../util/memberReferences.js";
import { stripPathSpans } from "../../../util/queryShape.js";

/**
 * Preserve code-shaped identifiers exactly as the caller wrote them. These
 * names are both late-symbol scan targets and a readiness honesty check.
 * Ordinary prose words are deliberately excluded.
 *
 * W9 (2026-08-22): `query` is scrubbed of generic path spans FIRST — a path
 * SEGMENT ("takayuki", "packages") is not an explicit code identifier just
 * because it happens to sit inside a `/`-joined mention in prose, and a
 * multi-segment path can otherwise contain a PascalCase-shaped trailing
 * directory/file name (e.g. ".../TokenLighten/...") that would falsely read
 * as one. This obligation source directly feeds `explicit-identifier`
 * obligations AND `uncoveredIdentifierFindCall`'s batched `find` `next` — an
 * uncovered path segment could otherwise make a pack that could never
 * certify (identifier provably absent from every served surface), or waste
 * a `find` call on a token that is not a real identifier. A bare file stem
 * with no directory prefix (`policy.ts`) is unaffected — see stripPathSpans.
 */
export function explicitCodeIdentifiers(query: string): string[] {
  return explicitCodeIdentifierEntries(query).map((entry) => entry.token);
}

/**
 * `explicitCodeIdentifiers` with how each name became one: `framedOnly` is a plain
 * word that is an identifier ONLY because the request frames it as a declaration
 * ("the big Transport struct": `Transport` has no casing rule, backtick or access
 * syntax of its own). A framed name is the name of a type or struct; the method
 * `transport()` of another file is not it, though the lowercase spellings are equal
 * (`rankAnswerEvidenceCandidates`).
 */
export function explicitCodeIdentifierEntries(query: string): Array<{ readonly token: string; readonly framedOnly: boolean }> {
  const unstripped = maskCitationFormatFields(maskEvaluationInputRecords(query));
  const cleaned = stripPathSpans("", unstripped);
  const tokenMatches = [...cleaned.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)];
  // 2026-10-29 (first-hop field report): a dotted member chain the request names
  // (`res.redirect`, `Foo.prototype.bar`, requestAnchors.ts) is ONE explicit
  // identifier, not the two prose words `res` and `redirect` the casing rules
  // below see. It joins at its place in the request. A chain the workspace
  // defines nowhere (`os.path.join`) stays a guess: `memberOnlyExplicitIdentifiers`.
  const pendingChains = anchorChainsOf(query)
    .map((raw) => ({ raw, at: cleaned.indexOf(raw) }))
    .filter((chain) => chain.at >= 0)
    .sort((a, b) => a.at - b.at);
  const backticked = new Set(
    [...cleaned.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)]
      .map((match) => match[1]!.toLowerCase()),
  );
  const parenthesizedPascal = new Set(
    [...cleaned.matchAll(/\(\s*([A-Z][a-z][A-Za-z0-9]*)\s*\)/g)]
      .map((match) => match[1]!.toLowerCase()),
  );
  // `Service.Post` / `Post()`: access or call syntax marks a one-word member
  // as code even though its casing reads like prose (util/memberReferences.ts).
  const memberNames = memberReferenceNames(cleaned);
  // A plain word the request frames as a declaration — "the big Transport struct",
  // "type Transport", "impl Decimal", "Transport 構造体" (declarationFraming.ts): a Go,
  // Rust or C type is very often one such word, and no casing rule admits it. Read from
  // the text with its path spans intact (a file reference is part of one frame).
  // A framed name keeps the spelling of its FRAME: "command.go の Command 構造体" has `command` in
  // front of `Command` (the file's stem), and the first occurrence must not decide the spelling.
  const framedSpelling = new Map(declarationFramedNames(unstripped).map((name) => [name.toLowerCase(), name] as const));
  const seen = new Set<string>();
  const out: Array<{ readonly token: string; readonly framedOnly: boolean }> = [];
  const admitChainsUpTo = (position: number): void => {
    while (pendingChains.length > 0 && pendingChains[0]!.at <= position) {
      const chain = pendingChains.shift()!.raw;
      const chainKey = chain.toLowerCase();
      if (PROTOCOL_IDENTIFIERS.has(chainKey) || seen.has(chainKey)) continue;
      seen.add(chainKey);
      out.push({ token: chain, framedOnly: false });
    }
  };
  for (const tokenMatch of tokenMatches) {
    const token = tokenMatch[0];
    admitChainsUpTo(tokenMatch.index ?? 0);
    const key = token.toLowerCase();
    const codeShaped = token.includes("_")
      || token.includes("$")
      || /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(token)
      || isPascalCaseIdentifier(token)
      // "the cancel API endpoint" asks about an endpoint; "API" is vocabulary,
      // not a symbol to find (concernRecovery.ts's PROSE_ACRONYMS). Backticks
      // below still make it one.
      || (/^[A-Z][A-Z0-9_]{2,}$/.test(token) && !isProseAcronym(token))
      || backticked.has(key)
      || parenthesizedPascal.has(key)
      || memberNames.has(key);
    const framedOnly = !codeShaped && framedSpelling.has(key);
    if (!codeShaped && !framedOnly) continue;
    if (PROTOCOL_IDENTIFIERS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ token: framedOnly ? framedSpelling.get(key)! : token, framedOnly });
  }
  admitChainsUpTo(Number.POSITIVE_INFINITY);
  return out;
}

/**
 * D2 (2026-08-07): line span of the file's LEADING comment block — the module
 * header that conventionally documents what the file is and how it is used.
 *
 * selectAnchorFocus scored only PARSED SYMBOLS, so a header could never be an
 * anchor candidate: on a usage/how-to query the answer sat in the header while
 * a token-matched internal symbol won the window and the header stayed inside
 * remaining_ranges (observed 2026-08-07 on an operator-runbook query). This is
 * a general indexing gap, not a usage-query special case — the block competes
 * on the ordinary lexical score and wins only when its own text matches.
 *
 * Recognizes the leading run of comment lines after an optional shebang and
 * leading blanks, for the comment syntaxes that cover the languages this
 * server serves (C-family block/line, hash, triple-quoted docstring, SQL/Lua
 * `--`, SGML `<!-- -->`, lisp `;`). Returns undefined when the file opens with
 * code, when the block is shorter than ANCHOR_FOCUS_HEADER_MIN_LINES (a bare
 * one-line banner is noise, not documentation), or when the whole file is
 * comments (a prose/doc file — its own pack paths already serve it).
 */
export const ANCHOR_FOCUS_HEADER_MIN_LINES = 3;

/**
 * Fraction (0..1) of `queryTokens` also present in `candidateTokens`. Both
 * are expected to already be tokenizeForEpoch output (deduplicated), so this
 * is a plain Set-membership tally — mirrors the retired prototype's
 * lexicalOverlap (proto/src/mcp/core.ts's buildAnchorFocus, via
 * proto/src/core/lexical.ts's `hits / taskWords.size`) without hand-rolling
 * a second tokenizer.
 */
export function lexicalOverlapFraction(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  let hits = 0;
  for (const t of queryTokens) if (candidateSet.has(t)) hits++;
  return hits / queryTokens.length;
}

// ---------------------------------------------------------------------------
// WP-S2 rule 4 (TL_SEEDED_GENEROUS): member re-ranking for a file whose own
// enclosing type is the top anchor candidate but does not fit the window.
// ---------------------------------------------------------------------------

/** The scoring ingredients `selectAnchorFocus` already computes per symbol, kept so the member re-ranking can re-score against a narrowed query without re-parsing. */
export interface AnchorLexicalParts {
  symbolTokens: string[];
  bodyTokens: string[];
  callable: number;
  typeOnly: number;
}

/** Minimum stem length for the prefix rule below — shorter stems ("can", "pay") are prefixes of far too many unrelated words. */
export const ANCHOR_INFLECTION_MIN_STEM = 4;

/**
 * Suffixes a name stem may pick up and still be the same concept. Kept short
 * and derivational on purpose: "ant" is absent so `const` never evidences
 * `constant`, which is the exact false positive salientWordMatch.ts's own
 * module header exists to warn about.
 */
export const ANCHOR_INFLECTION_SUFFIXES: ReadonlySet<string> = new Set([
  "s", "es", "ed", "ing", "er", "ers", "or", "ors",
  "ion", "ions", "ation", "ations", "ment", "ments",
]);

/** Per-process memo for `inflectionVariants`, whose input alphabet here is a handful of query/symbol tokens. */
export const anchorInflectionVariants = new Map<string, ReadonlySet<string>>();

export function anchorVariantsOf(token: string): ReadonlySet<string> {
  let variants = anchorInflectionVariants.get(token);
  if (variants === undefined) {
    variants = new Set(inflectionVariants(token));
    anchorInflectionVariants.set(token, variants);
  }
  return variants;
}

/**
 * True when two whole words are the same concept under light inflection.
 *
 * First asks `salientWordMatch.ts`'s `inflectionVariants` — the repository's
 * existing whole-word, bidirectional variant family (validate/validated/
 * validation, cancel/cancelled/cancelling), reused rather than re-derived.
 * That family does not reach across the doubled-consonant nominalisation
 * "cancel" -> "cancellation", which is precisely the shape a request uses when
 * it names a concept and the code names an action, so one conservative prefix
 * rule is added on top: the shorter word must be at least
 * ANCHOR_INFLECTION_MIN_STEM long, must be a literal prefix of the longer one
 * (optionally absorbing one doubled consonant), and what remains must be a
 * member of ANCHOR_INFLECTION_SUFFIXES. Never a bare substring test.
 */
export function anchorInflectionMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (anchorVariantsOf(a).has(b) || anchorVariantsOf(b).has(a)) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < ANCHOR_INFLECTION_MIN_STEM) return false;
  if (!long.startsWith(short)) return false;
  let rest = long.slice(short.length);
  const lastLetter = short[short.length - 1]!;
  if (rest[0] === lastLetter && !"aeiou".includes(lastLetter)) rest = rest.slice(1);
  return ANCHOR_INFLECTION_SUFFIXES.has(rest);
}

/** `lexicalOverlapFraction` with `anchorInflectionMatch` instead of exact set membership. Used ONLY on the short NAME term lists (never on a symbol body). */
export function inflectedOverlapFraction(queryTokens: string[], candidateTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const candidateSet = new Set(candidateTokens);
  let hits = 0;
  for (const t of queryTokens) {
    if (candidateSet.has(t) || candidateTokens.some((candidate) => anchorInflectionMatch(t, candidate))) hits++;
  }
  return hits / queryTokens.length;
}

/**
 * The same weighted sum `selectAnchorFocus`'s scoring loop builds, re-evaluated
 * against the query MINUS the enclosing type's own name tokens, with the two
 * NAME terms matched inflection-tolerantly. The BODY term stays exact: a body
 * is long and noisy, and loosening it would let any file-wide vocabulary win.
 */
export function anchorMemberLexicalScore(parts: AnchorLexicalParts, memberTokens: string[]): number {
  return inflectedOverlapFraction(memberTokens, parts.symbolTokens) * ANCHOR_FOCUS_NAME_WEIGHT
    + inflectedOverlapFraction(parts.symbolTokens, memberTokens) * ANCHOR_FOCUS_SYMBOL_COVERAGE_WEIGHT
    + lexicalOverlapFraction(memberTokens, parts.bodyTokens) * ANCHOR_FOCUS_BODY_WEIGHT;
}
