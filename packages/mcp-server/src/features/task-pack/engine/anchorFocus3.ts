// anchorFocus — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { AnchorFocusCandidate } from "./anchorFocus.js";
import type { AnchorFocusResult } from "./anchorFocus.js";
import type { AnchorLexicalParts } from "./anchorFocus2.js";
import type { CollectedSymbolKind } from "../../../symbols/collectSymbols.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { MarkdownHeading } from "../../../util/markdownSections.js";
import { ANCHOR_FOCUS_BODY_WEIGHT } from "./anchorFocus.js";
import { ANCHOR_FOCUS_CALLABLE_WEIGHT } from "./seededPackBuilder2.js";
import { ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT } from "./seededPackBuilder2.js";
import { ANCHOR_FOCUS_HEADER_MIN_LINES } from "./anchorFocus2.js";
import { ANCHOR_FOCUS_MAX_RUNNER_UPS } from "./anchorFocus.js";
import { ANCHOR_FOCUS_MAX_SYMBOLS } from "./seededPackBuilder2.js";
import { ANCHOR_FOCUS_NAME_WEIGHT } from "./seededPackBuilder2.js";
import { ANCHOR_FOCUS_QUALIFIED_MATCH_WEIGHT } from "./seededPackBuilder2.js";
import { ANCHOR_FOCUS_SYMBOL_COVERAGE_WEIGHT } from "./seededPackBuilder2.js";
import { DOC_ANCHOR_SECTION_MAX_LINES } from "../docSliver.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_SURFACE_CODE_BYTES } from "./packBasics2.js";
import { anchorChainsOf } from "../anchorFirst.js";
import { anchorMemberLexicalScore } from "./anchorFocus2.js";
import { collectSymbols } from "../../../symbols/collectSymbols.js";
import { countLines } from "../../../util/countLines.js";
import { docQueryTokens } from "../docSliver.js";
import { exactReplacementFromQuery } from "./servedStateAndEdits2.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { extractSymbolsFromFile } from "../../../tools/readCodeModes.js";
import { handleTable } from "../../../util/handles.js";
import { isMarkdownPath } from "../../../util/markdownSections.js";
import { isPascalCaseIdentifier } from "./anchorFocus.js";
import { isProseAcronym } from "../concernRecovery.js";
import { languageForPath } from "../../../util/languages.js";
import { lexicalOverlapFraction } from "./anchorFocus2.js";
import { maskCitationFormatFields } from "../../../util/citationFormat.js";
import { maskEvaluationInputRecords } from "../../../util/evaluationInputs.js";
import { memberReferenceNames } from "../../../util/memberReferences.js";
import { mostSpecificDocHeadingMatch } from "../docSliver.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { parseMarkdownHeadings } from "../../../util/markdownSections.js";
import { queryRequestsTestEvidence } from "../../../tools/queryEvidence.js";
import { rankDocHeadingMatches } from "../docSliver.js";
import { readCached } from "./packBasics2.js";
import { seededGenerousEnabled } from "../../../util/flags.js";
import { selectQueryEvidence } from "../../../tools/queryEvidence.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { tokenizeForEpoch } from "../../../state/session.js";

/**
 * Normalized names `explicitCodeIdentifiers` returns ONLY because of member
 * access or empty-call syntax (`Uploader.Retry`, `post()`): no casing rule,
 * backtick or `(Pascal)` would have made them code. The readiness loop treats
 * such a name as a guess when the workspace defines it nowhere.
 */
export function memberOnlyExplicitIdentifiers(query: string): Set<string> {
  const cleaned = stripPathSpans("", maskCitationFormatFields(maskEvaluationInputRecords(query)));
  const delimited = new Set(delimitedExplicitCodeIdentifiers(query).map(normIdent));
  const out = new Set<string>();
  const members = memberReferenceNames(cleaned);
  for (const identifier of explicitCodeIdentifiers(query)) {
    const key = normIdent(identifier);
    if (!members.has(identifier.toLowerCase()) || delimited.has(key)) continue;
    const casingShaped = identifier.includes("_")
      || identifier.includes("$")
      || /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(identifier)
      || isPascalCaseIdentifier(identifier)
      || (/^[A-Z][A-Z0-9_]{2,}$/.test(identifier) && !isProseAcronym(identifier));
    if (!casingShaped) out.add(key);
  }
  // A dotted chain (`res.redirect`) is never a name by casing: it is a guess
  // when the workspace defines it nowhere (`os.path.join`).
  for (const chain of anchorChainsOf(query)) out.add(normIdent(chain));
  return out;
}

/**
 * E3 (2026-09-05, measured on paid smoke r9 / SF13): the UNQUALIFIED TAIL of a
 * parsed symbol name — its last `::` / `.` / `#` segment, or the name itself
 * when it carries no qualifier.
 *
 * `explicitCodeIdentifiers` tokenizes on the identifier alphabet, so a query
 * that spells `EKF::isHealthy` contributes the two SEPARATE identities `EKF`
 * and `isHealthy` — never the joined form. Every C++ parse (and
 * `extractSymbolsFromLines`' own C/C++ fallback pattern
 * `([a-zA-Z_]\w*::[a-zA-Z_]\w*)`, so both the parsed and the regex path agree)
 * names a member QUALIFIED: `EKF::isHealthy`. A raw
 * `explicitIdentifierSet.has(symbol.name.toLowerCase())` test therefore could
 * never be true for a qualified member, and the explicit-identifier weight was
 * silently unreachable for exactly the queries that name a member most
 * precisely. Live (r9/SF13): the query named `EKF::isHealthy` (ekf.cpp:592) and
 * the pack anchored on `EKF::updateGps` (255-412) on GPS/covariance lexical
 * overlap alone, leaving the named member inside `remaining`.
 *
 * Deliberately a NAME-side normalization only: query tokenization is unchanged
 * everywhere, so an unqualified symbol compares exactly as it always did and
 * the default wire for every query naming no qualified member is untouched.
 */
export function unqualifiedSymbolTail(name: string): string {
  const match = /(?:::|[.#])([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(name);
  return match?.[1] ?? name;
}

/**
 * The immediate owner name of a possibly-qualified symbol (`OrderService` of
 * `OrderService::cancel`) -- the exact counterpart `unqualifiedSymbolTail`
 * already strips off, read the same way, over the same three separators
 * (`::`, `.`, `#`). `undefined` when `name` carries no qualifier at all. A
 * nested qualifier (`NS::OrderService::cancel`) resolves to the LAST hop's
 * own owner (`OrderService`, via a recursive tail read of everything before
 * the final separator), never the whole prefix.
 */
export function qualifiedSymbolOwner(name: string): string | undefined {
  const match = /^(.+)(?:::|[.#])[A-Za-z_$][A-Za-z0-9_$]*$/.exec(name);
  return match === null ? undefined : unqualifiedSymbolTail(match[1]!);
}

/**
 * Does `symbolName` (possibly qualified) name one of the identifiers the query
 * spelled explicitly? Whole name first — an unqualified symbol is unchanged —
 * then its unqualified tail. See `unqualifiedSymbolTail`.
 */
export function symbolNameIsExplicitIdentifier(
  symbolName: string,
  explicitIdentifierSet: ReadonlySet<string>,
): boolean {
  if (explicitIdentifierSet.has(symbolName.toLowerCase())) return true;
  const tail = unqualifiedSymbolTail(symbolName);
  return tail !== symbolName && explicitIdentifierSet.has(tail.toLowerCase());
}

/** True when `identifier` names `symbolName` outright or names its unqualified tail. */
export function identifierNamesSymbol(symbolName: string, identifier: string): boolean {
  const wanted = normIdent(identifier);
  if (wanted.length === 0) return false;
  if (normIdent(symbolName) === wanted) return true;
  const tail = unqualifiedSymbolTail(symbolName);
  return tail !== symbolName && normIdent(tail) === wanted;
}

/**
 * `Qualifier<sep>member` pairs the QUERY itself spells, keyed
 * `qualifier\0member`. Accepts `::`, `.` and `#`, so `EKF::isHealthy`,
 * `Class.method` and `Class#method` all bind.
 *
 * Used only to PREFER the exactly-qualified symbol over a same-tail member of a
 * different class (two classes can both declare `isHealthy`); it never demotes
 * a tail match, so a query that names only the bare member is unaffected.
 */
export function queryQualifiedSymbolKeys(query: string): Set<string> {
  const out = new Set<string>();
  for (const match of query.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)(?:::|[.#])([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    out.add(`${match[1]!.toLowerCase()}\u0000${match[2]!.toLowerCase()}`);
  }
  return out;
}

/** `qualifier\0member` key of a qualified symbol name; undefined when unqualified. */
export function symbolQualifiedKey(symbolName: string): string | undefined {
  const match = /([A-Za-z_$][A-Za-z0-9_$]*)(?:::|[.#])([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(symbolName);
  return match === null ? undefined : `${match[1]!.toLowerCase()}\u0000${match[2]!.toLowerCase()}`;
}

/** Identities whose code intent is explicit rather than inferred from shape. */
export function delimitedExplicitCodeIdentifiers(query: string): string[] {
  const delimited = new Set([
    ...[...query.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)].map((match) => normIdent(match[1]!)),
    ...[...query.matchAll(/\(\s*([A-Z][a-z][A-Za-z0-9]*)\s*\)/g)].map((match) => normIdent(match[1]!)),
  ]);
  return explicitCodeIdentifiers(query).filter((identifier) => delimited.has(normIdent(identifier)));
}

export interface QueryIdentifierContext {
  range: string;
  line: number;
}

/** Prefer the test block that mentions the requested symbol over file helpers. */
export function queryIdentifierContext(content: string, query: string): QueryIdentifierContext | undefined {
  const evidence = selectQueryEvidence(content, query, { preferTestBlocks: true });
  if (evidence?.kind === "test-block") {
    return { range: evidence.range, line: evidence.line };
  }
  const identifiers = explicitCodeIdentifiers(query);
  if (identifiers.length === 0) return undefined;
  const lines = content.split(/\r?\n/);
  const queryTokens = tokenizeForEpoch(query);
  let best: { line: number; score: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const lower = lines[index]!.toLowerCase();
    if (!identifiers.some((identifier) => lower.includes(identifier.toLowerCase()))) continue;
    const start = Math.max(0, index - 12);
    const end = Math.min(lines.length, index + 13);
    const score = lexicalOverlapFraction(queryTokens, tokenizeForEpoch(lines.slice(start, end).join("\n")));
    if (best === undefined || score > best.score) best = { line: index + 1, score };
  }
  if (best === undefined) return undefined;
  const start = Math.max(1, best.line - 12);
  const end = Math.min(lines.length, best.line + 12);
  return { range: `${start}-${end}`, line: best.line };
}

export const QUERY_FOCUS_TEXT_EXTENSIONS = new Set([
  ".json", ".jsonc", ".jsonl", ".yaml", ".yml", ".toml", ".txt", ".log", ".csv", ".tsv",
]);

export function refocusCandidateForQuery(
  candidate: ImpactCandidate,
  workspace: string,
  query: string,
  cache?: FileReadCache,
): ImpactCandidate {
  if (query.trim().length === 0) return candidate;
  const testFocus = candidate.surface === "test" && queryRequestsTestEvidence(query);
  const textFocus = QUERY_FOCUS_TEXT_EXTENSIONS.has(path.extname(candidate.path).toLowerCase());
  if (!testFocus && !textFocus) return candidate;
  const content = readCached(workspace, candidate.path, cache);
  if (content === undefined) return candidate;
  const evidence = selectQueryEvidence(content, query, {
    path: candidate.path,
    preferTestBlocks: testFocus,
  });
  if (evidence === undefined) return candidate;
  return {
    ...candidate,
    line: evidence.line,
    range: evidence.range,
    symbol: undefined,
    handle: undefined,
    why: testFocus ? "query-evidence-test-match" : "query-evidence-data-match",
    confidence: Math.max(candidate.confidence, 0.85),
  };
}

/**
 * One MARKDOWN section as an anchor-focus candidate, or undefined when its
 * bounded window would not fit MAX_SURFACE_CODE_BYTES.
 *
 * The window is `docAnchorRange` — docSliver.ts's own section+context span,
 * capped at DOC_ANCHOR_SECTION_MAX_LINES — so a doc anchored HERE and a doc
 * zoomed to by the sliver affordance land on exactly the same lines.
 */
export function markdownSectionCandidate(
  heading: MarkdownHeading,
  lines: readonly string[],
  totalLines: number,
  score: number,
): AnchorFocusCandidate | undefined {
  const end = Math.min(heading.endLine, totalLines);
  const sectionLines = end - heading.line + 1;
  if (sectionLines <= 0) return undefined;
  // Past docSliver's own section ceiling a heading stops being a servable unit
  // (that is exactly where `docAnchorRange` gives up on the section and returns
  // a ±radius window at its HEAD instead). Serving a long parent chapter's
  // opening lines and CALLING it the matched section would rebuild this
  // branch's own defect — a bounded window chosen by a token hit that is not
  // inside it. Skipping lets the caller fall to the next-ranked section, which
  // in a structured document is the subsection that actually carries the match.
  if (sectionLines > DOC_ANCHOR_SECTION_MAX_LINES) return undefined;
  const body = lines.slice(heading.line - 1, end).join("\n");
  if (Buffer.byteLength(body, "utf8") > MAX_SURFACE_CODE_BYTES) return undefined;
  // The served span IS the section — not `docAnchorRange`'s section+context
  // window. Two reasons, both load-bearing: the `why` this mints claims "the
  // query-matched section", and a span spilling ±20 lines into its NEIGHBOURS
  // is not that; and a doc anchor is competing for the pack's byte budget
  // against required code bodies, where a 4x-wider window is what gets the
  // whole doc surface dropped by the cap ladder (measured on the T05c
  // multi_concern pack). `isDocSliverSurface` + `servedSpanIsSection` already
  // recognize an exact section serve as the coherent unit it is and leave it
  // alone.
  return { name: heading.text, range: `${heading.line}-${end}`, score, kind: "doc-section" };
}

/**
 * Anchor focus for a MARKDOWN file: pick the SECTION the query is about.
 *
 * Markdown has no parser, so before this existed `selectAnchorFocus` scored a
 * doc with `extractSymbolsFromFile`'s code-declaration regex — a scan that
 * cannot describe prose and, on the measured defect, minted a phantom symbol
 * from the document's LAST line. See `selectAnchorFocus`'s Markdown guard for
 * the full chain; the repair is to score the structure the format actually has.
 *
 * Two picks, in priority order:
 *
 *  1. LITERAL-FIRST, the F-V13-8 rule applied to prose. A query naming an
 *     exact, unique quoted/diff-style replacement (`exactReplacementFromQuery`
 *     — the same parser the single-site fast path and the T2 short circuit
 *     already trust) is unambiguous positional evidence, and the section
 *     containing that ONE occurrence is an anchor no lexical score should be
 *     allowed to outvote. Zero or multiple occurrences fall through, exactly as
 *     on the code path: uniqueness is the only signal trusted here.
 *
 *  2. The best-scoring section from `rankDocHeadingMatches` — heading-text hits
 *     at weight 3, word-boundary body hits up to DOC_SLIVER_MAX_BODY_HITS, ties
 *     to the shorter section then document order — over `docQueryTokens`, whose
 *     stopword list already drops the generic doc vocabulary ("contract", "md",
 *     "doc", ...) that made the file's own basename stem look like a target.
 *     A section whose bounded window overflows MAX_SURFACE_CODE_BYTES is
 *     skipped for the next-ranked one rather than served truncated.
 *
 * Returns undefined when the file has no headings or nothing clears
 * DOC_SLIVER_MIN_MATCH_SCORE: not knowing where the answer is means keeping
 * today's whole-file default, never guessing a window.
 *
 * NO RUNNER-UPS. The symbol path spends a minted handle and an `outline` line
 * per runner-up; `outline` is not on the v1 evidence allow-list
 * (`protocol/decisionWire.ts`), so for a doc those bytes buy the caller nothing
 * and only push the pack toward the cap. The doc-sliver heading INDEX is the
 * navigation affordance for this file shape.
 *
 * EXPORTED for `docAnchorMarkdown.spec.ts`. `selectAnchorFocus` itself is
 * reachable only through the locator's candidate pipeline, whose routing
 * depends on the whole workspace shape; pinning the SELECTION rule directly is
 * what keeps the regression checkable without a fixture that also has to
 * reproduce candidate ranking. The end-to-end shape is pinned separately by the
 * replay corpus's `dam` group.
 */
export function markdownAnchorFocus(content: string, query: string): AnchorFocusResult | undefined {
  const headings = parseMarkdownHeadings(content);
  if (headings.length === 0) return undefined;
  const lines = content.split(/\r?\n/);
  const totalLines = countLines(content);

  const literalExact = exactReplacementFromQuery(query);
  const literalText = literalExact === undefined
    ? undefined
    : "identifierOldValue" in literalExact
    ? literalExact.identifierOldValue
    : literalExact.search;
  if (literalText !== undefined && literalText.length > 0) {
    const firstIdx = content.indexOf(literalText);
    if (firstIdx !== -1 && content.indexOf(literalText, firstIdx + 1) === -1) {
      const matchLine = content.slice(0, firstIdx).split(/\r?\n/).length;
      let enclosing: MarkdownHeading | undefined;
      let enclosingSpan = Infinity;
      for (const heading of headings) {
        if (heading.line > matchLine || heading.endLine < matchLine) continue;
        const span = heading.endLine - heading.line;
        if (span < enclosingSpan) {
          enclosing = heading;
          enclosingSpan = span;
        }
      }
      const literalCandidate = enclosing === undefined
        ? undefined
        : markdownSectionCandidate(enclosing, lines, totalLines, ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT);
      if (literalCandidate !== undefined) return { best: literalCandidate, runnerUps: [] };
    }
  }

  // `mostSpecificDocHeadingMatch` first — the same pick docSliver.ts's own
  // `selectTargetHeading` makes, so the section a pack ANCHORS on and the
  // section it would offer to zoom to are literally one choice — then the rest
  // of the ranking as fallbacks for a window that cannot be served whole.
  const ranked = rankDocHeadingMatches(headings, lines, docQueryTokens(query));
  const specific = mostSpecificDocHeadingMatch(ranked);
  const ordered = specific === undefined ? ranked : [specific, ...ranked.filter((m) => m !== specific)];
  for (const match of ordered) {
    const candidate = markdownSectionCandidate(match.heading, lines, totalLines, match.score);
    if (candidate !== undefined) return { best: candidate, runnerUps: [] };
  }
  return undefined;
}

/**
 * Score `filePath`'s top-level symbols (extractSymbolsFromFile — the same
 * symbol-listing helper resolveDigest already uses) by lexical overlap
 * against `query`, and pick the top-scoring symbol whose body fits
 * MAX_SURFACE_CODE_BYTES.
 *
 * Overlap is the fraction of `query`'s tokenizeForEpoch tokens also present
 * in a candidate's own tokenizeForEpoch tokens (the same fraction-of-query
 * shape as the retired prototype's lexicalOverlap, rebuilt on this
 * codebase's existing tokenizer instead of hand-rolling a second one),
 * scored twice per symbol — once against its NAME (ANCHOR_FOCUS_NAME_WEIGHT)
 * and once against its BODY text (ANCHOR_FOCUS_BODY_WEIGHT) — and summed.
 *
 * Returns undefined when no symbol scores above zero overlap, OR when every
 * positively-scored symbol's body overflows MAX_SURFACE_CODE_BYTES (picking
 * one then would still ship no code — never guess); the caller keeps
 * today's whole-file-range default in both cases.
 */
/**
 * EXPORTED for focused SELECTION pins, the same precedent `markdownAnchorFocus`
 * (2026-09-05 doc anchor-focus) set: an end-to-end pack assertion cannot say
 * WHICH symbol the anchor scorer chose, only which bytes survived every later
 * trim/route stage, so the E3 qualified-anchor regression is taken here.
 */
export async function selectAnchorFocus(
  content: string,
  filePath: string,
  query: string,
  cache?: FileReadCache,
): Promise<AnchorFocusResult | undefined> {
  const queryTokens = tokenizeForEpoch(query);
  if (queryTokens.length === 0) return undefined;
  // 2026-09-05 doc anchor-focus (measured on paid smoke r9 / SF05, and first
  // measured 2026-08-08 — see docSliver.ts's header for the same shape).
  // A MARKDOWN file has no parser, so everything below fell through to
  // `extractSymbolsFromFile`'s CODE-DECLARATION regex scan over prose. On
  // `bench/fixtures/aeroctl/CONTRACT.md` that scan minted a phantom symbol
  // `contract` from the file's LAST line — "  to deviate from this contract
  // (e.g., if `requires` is unavailable in the parser)." matches the C/C++
  // `(?:\w+[\s*&]+)+([A-Za-z_]\w*)\s*\(` pattern — and, because
  // `explicitCodeIdentifiers` admits the ALL-CAPS stem `CONTRACT` of the file's
  // own NAME as an explicit code identifier, that phantom collected
  // ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT and beat every real section. The
  // pack then served line 1514/1514 of the one authority document the query
  // named, while the answer sat in "### 7.6 `<control/mixer.hpp>`".
  //
  // Markdown has real structure, so use it: score the document's own SECTIONS
  // with the SAME query-term scoring docSliver.ts already applies when it
  // chooses a zoom target (`docQueryTokens` — whose stopword list already drops
  // "contract"/"md"/"doc" — plus `rankDocHeadingMatches`'s word-boundary body
  // hits, which is what lets 2-char identifiers like FR/BL/FL/BR count). One
  // vocabulary, so the section a pack ANCHORS on and the section it would offer
  // to zoom to can never name different places. No section clearing
  // DOC_SLIVER_MIN_MATCH_SCORE means we do not know where the answer is: return
  // undefined and keep today's whole-file default rather than guess.
  if (isMarkdownPath(filePath)) return markdownAnchorFocus(content, query);
  const explicitIdentifiers = explicitCodeIdentifiers(query);
  const explicitIdentifierSet = new Set(explicitIdentifiers.map((name) => name.toLowerCase()));
  // E3 (see `unqualifiedSymbolTail`): the query's own `Class::member` spellings,
  // used below only to break a tie between two same-tail members.
  const queryQualifiedKeys = queryQualifiedSymbolKeys(query);
  const lang = languageForPath(filePath);
  const parsed = lang
    ? cache
      ? await cache.parsedSymbols(content, lang, filePath)
      : await collectSymbols(content, lang, {}).catch(() => null)
    : null;
  const structuralSymbols: Array<{ name: string; range: string; line: number; kind?: CollectedSymbolKind }> =
    (parsed ?? []).slice(0, ANCHOR_FOCUS_MAX_SYMBOLS).map((symbol) => ({
      name: symbol.name,
      range: `${symbol.startLine}-${symbol.endLine}`,
      line: symbol.startLine,
      // Real parser kind, kept ONLY so the substantive-vs-header/const
      // selection preference below (2026-08-21 answer-focus precision fix)
      // can tell a function/method/class apart from a const/type/interface
      // anchor. Absent on the extractSymbolsFromFile regex fallback, which
      // makes that preference an intentional no-op on unparsed languages.
      kind: symbol.kind,
    }));
  const symbols: Array<{ name: string; range: string; line: number; kind?: CollectedSymbolKind }> =
    structuralSymbols.length > 0
      ? structuralSymbols
      : await extractSymbolsFromFile(content, filePath, ANCHOR_FOCUS_MAX_SYMBOLS, explicitIdentifiers);
  if (symbols.length === 0) return undefined;

  const lines = content.split(/\r?\n/);

  // F-V13-8 (2026-08-30, independent-verification remediation): literal-first
  // anchor. A query that names an exact, unique quoted/diff-style replacement
  // (exactReplacementFromQuery — the same 8192B-capped, multi-quote-form
  // parser attachSingleSiteUniqueMatchFastPath and the pre-pipeline T2 short
  // circuit both already trust) is unambiguous positional evidence a
  // lexical-overlap score can still lose: vocabulary shared with an
  // unrelated symbol elsewhere in the file can outscore the symbol that
  // actually contains the one place the literal occurs (observed: an
  // explicit path + a quoted literal + a line-number hint anchored on the
  // wrong symbol, dozens of lines away from the real target). When the
  // literal (or, for the "set IDENT to NEW" form with no stated old value,
  // the bare identifier text) occurs in `content` EXACTLY ONCE — checked
  // with two indexOf calls, no regex, no normalization — route straight to
  // the symbol enclosing that occurrence (reusing the `symbols` list already
  // built above) and skip scoring entirely. Zero or multiple occurrences
  // fall through unchanged to the lexical scoring below: uniqueness is the
  // only signal trusted here, and choosing among several hits is left to the
  // scoring/precondition machinery downstream — never guessed here.
  const literalExact = exactReplacementFromQuery(query);
  const literalText = literalExact === undefined
    ? undefined
    : "identifierOldValue" in literalExact
    ? literalExact.identifierOldValue
    : literalExact.search;
  if (literalText !== undefined && literalText.length > 0) {
    const firstIdx = content.indexOf(literalText);
    if (firstIdx !== -1 && content.indexOf(literalText, firstIdx + 1) === -1) {
      const matchLine = content.slice(0, firstIdx).split(/\r?\n/).length;
      let enclosing: (typeof symbols)[number] | undefined;
      let enclosingSpan = Infinity;
      for (const sym of symbols) {
        const bounds = sym.range.split("-");
        const start = parseInt(bounds[0] ?? "", 10);
        const end = parseInt(bounds[1] ?? "", 10);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > matchLine || end < matchLine) continue;
        const span = end - start;
        if (span < enclosingSpan) {
          enclosing = sym;
          enclosingSpan = span;
        }
      }
      if (enclosing !== undefined) {
        return {
          best: {
            name: enclosing.name,
            range: enclosing.range,
            score: ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT,
            ...(enclosing.kind ? { kind: enclosing.kind } : {}),
          },
          runnerUps: [],
        };
      }
    }
  }

  const scored: Array<AnchorFocusCandidate & {
    fits: boolean;
    exactIdentifier: boolean;
    ownTypeSpan?: number;
    /** WP-S2 rule 4, words form: set when the query spells this file's own type as separate WORDS that cover the whole symbol name ("order service …" for `OrderService`) rather than as the identifier. Read only by the member re-ranking below; it never earns or loses the explicit-identifier weight. */
    ownTypeWordsSpan?: number;
    /** WP-S2 rule 4: the lexical ingredients, kept so the member re-ranking below can re-score against a narrowed query without a second parse. */
    lexical: AnchorLexicalParts;
  }> = [];
  /** WP-S2 rule 4: symbols the whole-query score dropped, reconsidered ONLY by the member re-ranking below (see its own comment). */
  const deferred: typeof scored = [];
  // The type this file is named after: a constructor carries the same name,
  // so it needs telling apart from the type below (see the ownTypeSpan pass).
  const ownTypeKey = normIdent(path.basename(filePath, path.extname(filePath)));
  const seenSymbolRanges = new Set<string>();
  for (const sym of symbols) {
    const symbolRangeKey = `${sym.name.toLowerCase()}\0${sym.range}`;
    if (seenSymbolRanges.has(symbolRangeKey)) continue;
    seenSymbolRanges.add(symbolRangeKey);
    const bounds = sym.range.split("-");
    const startLine = parseInt(bounds[0] ?? "", 10);
    const endLine = parseInt(bounds[1] ?? "", 10);
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) continue;
    const body = lines.slice(startLine - 1, endLine).join("\n");
    const symbolTokens = tokenizeForEpoch(sym.name);
    const bodyTokens = tokenizeForEpoch(body);
    const nameOverlap = lexicalOverlapFraction(queryTokens, symbolTokens);
    const symbolCoverage = lexicalOverlapFraction(symbolTokens, queryTokens);
    const bodyOverlap = lexicalOverlapFraction(queryTokens, bodyTokens);
    const declaration = body.split(/\r?\n/, 1)[0] ?? "";
    const callable = /\b(function|method|def|fn|fun)\b|=>/.test(declaration) ? 1 : 0;
    const typeOnly = /\b(interface|type|enum)\b/.test(declaration) ? 1 : 0;
    // E3: match the query's explicit identities against the symbol's
    // UNQUALIFIED TAIL as well as its whole name — a parsed C++ member is named
    // `EKF::isHealthy` while the query contributes `EKF` and `isHealthy`
    // separately, so the whole-name test alone made the +100 weight unreachable
    // for every qualified member. See `unqualifiedSymbolTail`.
    const explicitIdentifier = symbolNameIsExplicitIdentifier(sym.name, explicitIdentifierSet);
    const symbolKey = symbolQualifiedKey(sym.name);
    const qualifiedMatch = symbolKey !== undefined && queryQualifiedKeys.has(symbolKey);
    const lexicalScore = nameOverlap * ANCHOR_FOCUS_NAME_WEIGHT
      + symbolCoverage * ANCHOR_FOCUS_SYMBOL_COVERAGE_WEIGHT
      + bodyOverlap * ANCHOR_FOCUS_BODY_WEIGHT;
    const score = explicitIdentifier
      ? ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT
        + (qualifiedMatch ? ANCHOR_FOCUS_QUALIFIED_MATCH_WEIGHT : 0)
        + lexicalScore + callable * ANCHOR_FOCUS_CALLABLE_WEIGHT - typeOnly
      : lexicalScore <= 0
      ? 0
      : lexicalScore + callable * ANCHOR_FOCUS_CALLABLE_WEIGHT - typeOnly;
    if (score <= 0) {
      // WP-S2 rule 4: a member the WHOLE query shares no token with is
      // dropped here, which is right for the ordinary ranking but is exactly
      // where a request that says "cancellation" loses a method called
      // `cancel`. Hold the zero-scorers aside (never in `scored`, so nothing
      // below sees them) so the member re-ranking can reconsider them under
      // the narrowed, inflection-tolerant query — and only there.
      deferred.push({
        name: sym.name,
        range: sym.range,
        score: 0,
        ...(sym.kind ? { kind: sym.kind } : {}),
        fits: Buffer.byteLength(body, "utf8") <= MAX_SURFACE_CODE_BYTES,
        exactIdentifier: false,
        lexical: { symbolTokens, bodyTokens, callable, typeOnly },
      });
      continue;
    }
    scored.push({
      name: sym.name,
      range: sym.range,
      score,
      ...(sym.kind ? { kind: sym.kind } : {}),
      fits: Buffer.byteLength(body, "utf8") <= MAX_SURFACE_CODE_BYTES,
      exactIdentifier: explicitIdentifier,
      lexical: { symbolTokens, bodyTokens, callable, typeOnly },
      ...(explicitIdentifier && normIdent(unqualifiedSymbolTail(sym.name)) === ownTypeKey
        ? { ownTypeSpan: endLine - startLine }
        : {}),
      ...(!explicitIdentifier
        && symbolCoverage >= 1
        && seededGenerousEnabled()
        && normIdent(unqualifiedSymbolTail(sym.name)) === ownTypeKey
        ? { ownTypeWordsSpan: endLine - startLine }
        : {}),
    });
  }
  // A CONSTRUCTOR IS NOT THE TYPE (2026-09-19, live GitHub Copilot sessions).
  // "OrderService cancel method ..." names the type this file is named after;
  // the class and its constructor share that name, both took the
  // explicit-identifier weight, the 400-line class did not fit the window, and
  // the first FITTING candidate was the 15-line constructor — so the pack
  // opened a named file at its constructor and the caller spent three more
  // reads finding the method it had described. Of the symbols named after the
  // file's own type only the WIDEST (the type itself) is the named identifier;
  // the others compete on their lexical score like any other member, so when
  // the type does not fit, the member the request describes wins the window.
  const ownTypeNamed = scored.filter((entry) => entry.ownTypeSpan !== undefined);
  if (ownTypeNamed.length > 1) {
    const widest = Math.max(...ownTypeNamed.map((entry) => entry.ownTypeSpan!));
    let typeKept = false;
    for (const entry of ownTypeNamed) {
      if (!typeKept && entry.ownTypeSpan === widest) {
        typeKept = true;
        continue;
      }
      entry.score -= ANCHOR_FOCUS_EXPLICIT_IDENTIFIER_WEIGHT;
      entry.exactIdentifier = false;
    }
  }
  // WP-S2 rule 4 (TL_SEEDED_GENEROUS) — the SECOND half of the same defect.
  // Stripping the +100 off the constructor is not enough: the type's own name
  // is still in the query, so every member NAMED AFTER THE TYPE (the
  // constructor first of all) keeps a full ANCHOR_FOCUS_SYMBOL_COVERAGE_WEIGHT
  // from it, while the member the caller actually described earns only a
  // fraction. Measured: `OrderService` the constructor scored 5.6 and `cancel`
  // 0.625 on "…order cancellation … OrderService cancellation implementation
  // …", so the pack opened an 18 KB service class at its 15-line constructor.
  //
  // When the type itself is the top-scoring candidate but does NOT fit the
  // window, the window is going to a MEMBER — so rank the members on what is
  // left of the query once the type's own name tokens are removed, which is
  // exactly the part of the request that distinguishes one member from
  // another. The type keeps its own score and stays `scored[0]`; only the
  // members are re-ordered among themselves, and a member that matches
  // nothing in the narrowed query falls to the bottom instead of riding the
  // type's name. The NAME terms additionally tolerate light inflection, so a
  // request that says "cancellation" reaches a method called `cancel`.
  //
  // WORDS FORM (2026-09-20, replayed from a recorded GitHub Copilot call): a
  // purpose such as "Order service cancellation" names the same type in words.
  // No symbol is an explicit identifier then, so neither the constructor pass
  // above nor the exact form of this rule fired, and `OrderService` the
  // constructor (7.7) beat `cancel` (1.0) on the two words that merely located
  // the file. When the query's tokens cover the WHOLE name of the file's own
  // type, those tokens have done their job; the widest such symbol stands for
  // the type and the members compete on the rest, exactly as above.
  if (seededGenerousEnabled()) {
    const topEntry = [...scored].sort((a, b) => b.score - a.score)[0];
    const typeEntry = topEntry !== undefined && topEntry.ownTypeSpan === undefined && topEntry.ownTypeWordsSpan !== undefined
      ? scored
          .filter((entry) => entry.ownTypeWordsSpan !== undefined)
          .sort((a, b) => b.ownTypeWordsSpan! - a.ownTypeWordsSpan!)[0]
      : topEntry;
    if (
      typeEntry !== undefined
      && (
        (typeEntry.ownTypeSpan !== undefined && typeEntry.exactIdentifier)
        || typeEntry.ownTypeWordsSpan !== undefined
      )
      && !typeEntry.fits
    ) {
      const typeNameTokens = new Set(tokenizeForEpoch(typeEntry.name));
      const memberTokens = queryTokens.filter((token) => !typeNameTokens.has(token));
      if (memberTokens.length > 0) {
        for (const entry of scored) {
          if (entry === typeEntry) continue;
          entry.score = anchorMemberScore(entry.lexical, memberTokens);
        }
        for (const entry of deferred) {
          // Same admission rule the scoring loop itself applies: the LEXICAL
          // terms must be positive. The callable bonus alone must never
          // readmit a symbol the query says nothing about.
          if (anchorMemberLexicalScore(entry.lexical, memberTokens) <= 0) continue;
          entry.score = anchorMemberScore(entry.lexical, memberTokens);
          scored.push(entry);
        }
      }
    }
  }
  // D2 (2026-08-07): the file's leading comment block competes as a candidate.
  // Symbols were the only anchor candidates, so on a query whose answer lives
  // in the module header (how a script is invoked, what the file is for, the
  // arguments it takes) a token-matched internal symbol always won the window
  // and the header stayed unserved in remaining_ranges.
  //
  // Scored with the SAME term structure as a symbol, no new weights and no
  // usage-vocabulary keywords anywhere: a header's "name" is the file itself
  // (that is what it documents), so the basename supplies the name/coverage
  // terms and the block text supplies the body term. It carries no callable
  // bonus because it is not callable. A header whose text does not match the
  // query scores 0 and is dropped by the shared `score <= 0` rule, so this is
  // inert on the overwhelming majority of queries; when it does score but
  // loses, it still reaches the caller as a ready-to-run slice in the
  // surface's runner-up `outline`.
  const header = leadingHeaderBlockRange(content);
  if (header !== undefined) {
    const headerName = path.basename(filePath);
    const headerNameTokens = tokenizeForEpoch(headerName);
    const headerScore =
      lexicalOverlapFraction(queryTokens, headerNameTokens) * ANCHOR_FOCUS_NAME_WEIGHT
      + lexicalOverlapFraction(headerNameTokens, queryTokens) * ANCHOR_FOCUS_SYMBOL_COVERAGE_WEIGHT
      + lexicalOverlapFraction(queryTokens, tokenizeForEpoch(header.text)) * ANCHOR_FOCUS_BODY_WEIGHT;
    if (headerScore > 0) {
      scored.push({
        name: headerName,
        range: header.range,
        score: headerScore,
        kind: "module-header",
        fits: Buffer.byteLength(header.text, "utf8") <= MAX_SURFACE_CODE_BYTES,
        exactIdentifier: false,
        // WP-S2: the header is pushed AFTER the member re-ranking above, so
        // these parts are never re-scored — carried only to keep one shape.
        lexical: { symbolTokens: headerNameTokens, bodyTokens: tokenizeForEpoch(header.text), callable: 0, typeOnly: 0 },
      });
    }
  }
  if (scored.length === 0) return undefined;
  // Highest score first; Array.prototype.sort is stable (ES2019+), so
  // symbols tied on score keep extractSymbolsFromFile's source-file order.
  scored.sort((a, b) => b.score - a.score);

  // Prefer a compact callable, but never discard an exact named class/module
  // solely because its body is large. candidateToSurface can serve a bounded
  // head plus member handles for that symbol.
  //
  // 2026-08-21 answer-focus precision fix: ANCHOR_FOCUS_SYMBOL_COVERAGE_WEIGHT
  // rewards the FRACTION of a symbol's own name tokens covered by the query —
  // a 2-3-token constant or the module header clears that fraction far more
  // easily than a longer, more specific function/method name, so a header or
  // a constant could out-score the real function that answers the query on
  // lexical coverage alone. When nothing was EXPLICITLY named (an exact
  // identifier already always sorts first via its dedicated +100 weight and
  // must never be demoted here), prefer the highest-scored SUBSTANTIVE symbol
  // — function/method/class — over a header/const/type/interface/local, and
  // only fall back to a non-substantive one when no substantive candidate
  // scored at all (this keeps D2's header-as-last-resort behavior intact).
  const hasExplicitIdentifierWinner = scored[0]?.exactIdentifier === true;
  // Exemption: a query that substantially NAMES THE FILE ITSELF (at least
  // half of the file's own basename tokens appear in the query — e.g. "what
  // does the coverage packer do" naming coveragePacker.ts) is asking about
  // the MODULE as a whole, and its header genuinely is the answer — the
  // opposite case from a header that merely happens to share vocabulary with
  // an unrelated same-file constant/symbol. Only exempts a header that is
  // ALREADY the top-scored candidate; it never promotes a losing header.
  const topIsFileNamedHeader = !hasExplicitIdentifierWinner
    && scored[0]?.kind === "module-header"
    && (() => {
        const baseTokens = tokenizeForEpoch(scored[0]!.name);
        return baseTokens.length > 0 && lexicalOverlapFraction(baseTokens, queryTokens) >= 0.5;
      })();
  const substantiveFitIdx = hasExplicitIdentifierWinner || topIsFileNamedHeader
    ? -1
    : scored.findIndex((s) => s.fits && (s.kind === "function" || s.kind === "method" || s.kind === "class"));
  const bestIdx = substantiveFitIdx >= 0 ? substantiveFitIdx : scored.findIndex((s) => s.fits);
  const resolvedBestIdx = bestIdx >= 0 ? bestIdx : scored.findIndex((s) => s.exactIdentifier);
  if (resolvedBestIdx === -1) return undefined;

  const best = scored[resolvedBestIdx]!;
  const runnerUps = [...scored.slice(0, resolvedBestIdx), ...scored.slice(resolvedBestIdx + 1)]
    .slice(0, ANCHOR_FOCUS_MAX_RUNNER_UPS)
    .map(({ name, range, score }) => ({ name, range, score }));

  return {
    best: {
      name: best.name,
      range: best.range,
      score: best.score,
      ...(best.kind ? { kind: best.kind } : {}),
    },
    runnerUps,
  };
}

export function leadingHeaderBlockRange(content: string): { range: string; text: string } | undefined {
  const lines = content.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.startsWith("#!")) i = 1;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length) return undefined;

  const BLOCK_OPENERS: Array<{ open: string; close: string }> = [
    { open: "/*", close: "*/" },
    { open: '"""', close: '"""' },
    { open: "'''", close: "'''" },
    { open: "<!--", close: "-->" },
  ];
  const LINE_TOKENS = ["//", "#", "--", ";"];
  // `#` opens a comment in Python/Ruby/shell/YAML/TOML but a PREPROCESSOR
  // DIRECTIVE in C/C++/ObjC. Without this, a translation unit's leading
  // `#include` run reads as a three-line "module header" — and worse, it
  // extends a genuine leading license block over the include list.
  const PREPROCESSOR_RE =
    /^#\s*(?:include|import|define|undef|ifdef|ifndef|if|elif|else|endif|pragma|error|warning|line)\b/;

  const first = i;
  let last = -1;
  let closing: string | undefined;
  for (; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (closing !== undefined) {
      last = i;
      if (trimmed.includes(closing)) closing = undefined;
      continue;
    }
    if (trimmed === "") continue;
    const opener = BLOCK_OPENERS.find(({ open }) => trimmed.startsWith(open));
    if (opener) {
      last = i;
      // A single-line block (`/** x */`) closes on its own line; only treat
      // the delimiter as open when no closer follows the opener text.
      const rest = trimmed.slice(opener.open.length);
      if (!rest.includes(opener.close)) closing = opener.close;
      continue;
    }
    if (PREPROCESSOR_RE.test(trimmed)) break;
    if (LINE_TOKENS.some((token) => trimmed.startsWith(token))) {
      last = i;
      continue;
    }
    break;
  }
  // An unterminated block delimiter means the scanner mis-read the syntax
  // (e.g. a `'''`-quoted value at file head) — never claim that span.
  if (closing !== undefined || last < first) return undefined;
  if (last - first + 1 < ANCHOR_FOCUS_HEADER_MIN_LINES) return undefined;
  // Whole file is header: not an anchor decision this function should make.
  if (lines.slice(last + 1).every((line) => line.trim() === "")) return undefined;
  return {
    range: `${first + 1}-${last + 1}`,
    text: lines.slice(first, last + 1).join("\n"),
  };
}

export function anchorMemberScore(parts: AnchorLexicalParts, memberTokens: string[]): number {
  return anchorMemberLexicalScore(parts, memberTokens)
    + parts.callable * ANCHOR_FOCUS_CALLABLE_WEIGHT
    - parts.typeOnly;
}

/**
 * Ready-to-run `tl_read_file mode=slice handle=<id>` hints for the anchor-focus
 * runner-up symbols — mints one real "symbol"-kind handle per named
 * runner-up (same handleTable.upsert shape candidateToSurface itself uses)
 * so each hint is immediately actionable without a further locate/digest
 * round-trip, and names the symbol so the agent can pick by relevance
 * instead of calling all of them.
 */
export function anchorFocusRunnerUpOutline(
  runnerUps: AnchorFocusCandidate[],
  filePath: string,
  workspace: string,
): string[] {
  return runnerUps.map((r) => {
    const handle = handleTable.upsert({
      kind: "symbol",
      path: filePath,
      range: r.range,
      symbol: r.name,
      workspaceRoot: workspace,
    });
    // WP-S11 (Part B) deliberately does NOT canonicalize this one string.
    // `surface.outline` is not prose: `contentFollowupTarget` regex-parses
    // these lines back (`/:\s+(tl_read_file\s+.+)$/`, then `\bhandle=(h…)\b` and
    // `nextStringToCall`) and feeds the PARSED call into `next_call`, which is
    // what the wire decision actually projects — canonically, via
    // `canonicalContinuationCall`. See the `continuationQuery` doc block's own
    // ruling for the identical case: "Emitting an unparseable [canonical] form
    // would delete the hint from the decision instead of improving it." The
    // caller therefore never sees this spelling; it is an internal dialect
    // whose grammar lives in util/continuation.ts.
    return `${r.name}: tl_read_file mode=slice handle=${handle.id}`;
  });
}

/** First line of a `"<start>-<end>"` range, or undefined for any other shape. */
export function anchorWindowStartLine(range: string | undefined): number | undefined {
  const match = range === undefined ? null : /^(\d+)-(\d+)$/.exec(range);
  return match === null ? undefined : Number(match[1]);
}
