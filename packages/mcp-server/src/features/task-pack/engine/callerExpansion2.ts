// callerExpansion — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { BlockCommentLineStates } from "../callerExpansion.js";
import type { CallSiteOccurrence } from "../callerExpansion.js";
import type { CallerFocalMember } from "../callerExpansion.js";
import type { CallerSiteCandidate } from "../callerExpansion.js";
import type { ConcernCandidate } from "../concernRecovery.js";
import type { ConcernEnclosingSymbolReader } from "../concernRecovery.js";
import type { ConcernFixedStringScanner } from "../concernRecovery.js";
import type { ConcernRecoveryItem } from "../concernRecovery.js";
import type { FacetMentionLine } from "../facetGate.js";
import type { FocalMemberCandidate } from "../callerExpansion.js";
import type { ImpactCandidate } from "@tokenlighten/types";
import type { NamedDefinitionFile } from "../concernRecovery.js";
import type { ParsedSymbols } from "./packBasics2.js";
import type { TaskPackArgs } from "../model.js";
import { ANCHOR_INFLECTION_MIN_STEM } from "./anchorFocus2.js";
import { CUMULATIVE_LOCATE_BUDGET_MS } from "../concernRecovery.js";
import { FileReadCache } from "./packBasics2.js";
import { IDENTIFIER_DEFINITION_KEYWORD_RE } from "./answerCandidates2.js";
import { MAX_CALLER_EXPANSION_BYTES } from "../callerExpansion.js";
import { MAX_CALLER_SURFACES } from "../callerExpansion.js";
import { MAX_DECLARATION_HEAD_LOOKAHEAD_LINES } from "../callerExpansion.js";
import { MAX_FACET_CALLER_FILES_CLASSIFIED } from "./callerExpansion3.js";
import { MAX_UNCLASSIFIED_MENTION_LINES } from "../facetGate.js";
import { anchorInflectionMatch } from "./anchorFocus2.js";
import { blockCommentLineStates } from "../callerExpansion.js";
import { boundedCallerWindow } from "../callerExpansion.js";
import { callerExpansionWhy } from "../callerExpansion.js";
import { callerWindowEmbedBytes } from "./callerExpansion3.js";
import { classifySurface } from "../../../util/impact.js";
import { countLines } from "../../../util/countLines.js";
import { countSiblingGroups } from "../concernRecovery.js";
import { currentEnumeratedQueryItems } from "./readinessFalsification.js";
import { declarationHeadShape } from "../callerExpansion.js";
import { definitionSegment } from "../callerExpansion.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { explicitCodeIdentifiers } from "./anchorFocus2.js";
import { facetCallerMentionScan } from "./callerExpansion3.js";
import { fileNamesType } from "../callerExpansion.js";
import { findCallOccurrences } from "../callerExpansion.js";
import { goInterfaceMemberDeclarationShape } from "../callerExpansion.js";
import { hasDeclarationHeadWord } from "../callerExpansion.js";
import { hasHashComments } from "../callerExpansion.js";
import { insideGoInterfaceBody } from "./callerExpansion3.js";
import { isAlwaysKeywordLedLanguage } from "../callerExpansion.js";
import { isCallerMentionOnlyFile } from "./callerExpansion3.js";
import { isDeclarationShapedMatchText } from "./callableResolution4.js";
import { isGoLanguage } from "../callerExpansion.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { languageForPath } from "../../../util/languages.js";
import { maskNonCode } from "../callerExpansion.js";
import { namedMemberAfterIdentifier } from "../concernRecovery.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { opensBlockDeclaration } from "../callerExpansion.js";
import { pickFocalMembers } from "../callerExpansion.js";
import { queryMentionsTests } from "../callerExpansion.js";
import { rankCallSites } from "../callerExpansion.js";
import { readCached } from "./packBasics2.js";
import { receiverImportedFromFocalFile } from "./callerExpansion3.js";
import { receiverStrength } from "../callerExpansion.js";
import { recoverConcernGroupCandidates } from "../concernRecovery.js";
import { requiredQueryFacets } from "./changeAndReadinessEvidence2.js";
import { rightHandOpensDeclarationBody } from "../callerExpansion.js";
import { scanLiteral } from "../../search/find/findText.js";
import { sharedPathPrefixSegments } from "../callerExpansion.js";
import { splitIdentifierWords } from "./sourceAndConcernTerms2.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { tokenizeQuery as tokenizeQueryForDiversification } from "../../retrieval/tokenize.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";
import { withoutClosedParenGroups } from "./callerExpansion3.js";

export function buildConcernRecoveryItems(query: string): ConcernRecoveryItem[] {
  const cleaned = stripPathSpans("", query);
  const codeShapedOracle = new Set(explicitCodeIdentifiers(query).map((token) => token.toLowerCase()));
  const byText = new Map<string, ConcernRecoveryItem>();
  const add = (text: string, start: number): void => {
    if (start < 0 || text.trim().length === 0) return;
    const key = text.toLowerCase();
    const codeShaped = codeShapedOracle.has(key);
    const existing = byText.get(key);
    if (!existing || start < existing.start) {
      byText.set(key, { text, start, codeShaped: codeShaped || (existing?.codeShaped ?? false) });
    } else if (codeShaped && !existing.codeShaped) {
      byText.set(key, { ...existing, codeShaped: true });
    }
  };
  for (const item of currentEnumeratedQueryItems(query)) add(item.facet, item.start);
  for (const literal of requiredQueryFacets(query)) add(literal, cleaned.toLowerCase().indexOf(literal.toLowerCase()));
  for (const identifier of explicitCodeIdentifiers(query)) {
    add(identifier, cleaned.toLowerCase().indexOf(identifier.toLowerCase()));
  }
  return [...byText.values()];
}

/**
 * The candidate for one named-definition file (concernRecovery.ts's
 * `namedDefinitionFiles`): the member the request asks about right after the
 * type's name when the file defines one ("PaymentService の refund メソッド" →
 * `refund`), else the type's own definition, else the head of the file. Same
 * `why` and confidence as the literal recovery's candidates — both are
 * evidence the request named, merged by the caller after the answer-mode
 * decision.
 */
export async function namedDefinitionCandidate(
  named: NamedDefinitionFile,
  query: string,
  identifiers: readonly string[],
  workspace: string,
  cache: FileReadCache,
): Promise<ImpactCandidate | undefined> {
  const content = readCached(workspace, named.path, cache);
  if (content === undefined) return undefined;
  const lang = languageForPath(named.path);
  const parsed = (lang ? await cache.parsedSymbols(content, lang, named.path) : null) ?? [];
  const tailOf = (name: string): string => unqualifiedSymbolTail(name).toLowerCase();
  const member = namedMemberAfterIdentifier(
    query,
    named.identifier,
    identifiers.filter((name) => name !== named.identifier),
    new Set(parsed.map((symbol) => tailOf(symbol.name))),
  );
  const wanted = member ?? named.identifier.toLowerCase();
  const symbol = parsed.find((entry) => tailOf(entry.name) === wanted);
  return {
    path: named.path,
    line: symbol?.startLine ?? 1,
    ...(symbol ? { range: `${symbol.startLine}-${symbol.endLine}`, symbol: symbol.name } : {}),
    surface: classifySurface(named.path),
    why: "answer-explicit-identifier-recovery",
    confidence: 0.95,
  };
}

/**
 * Runs the pure recovery pipeline and returns its candidates for the caller
 * to MERGE into `candidates` AFTER the answer-mode decision (Blocker 1,
 * Phase 3, 2026-09-19: this function used to unshift its results into
 * `rankedAnswerCandidates` directly, which made `recoveredExactAnswer`
 * / `exactLocatedAnswer` see them and collapse a multi-concern query down
 * to ONE certified surface — the opposite of the goal. It now never touches
 * `rankedAnswerCandidates` and carries no `exactIdentifier`/`strongEvidence`
 * marking of its own; the caller alone decides how these merge in).
 *
 * `args.path` is threaded into the scan exactly like
 * recoverExplicitIdentifierAnswerCandidates's own scanLiteral call (Blocker
 * 2: a prior version dropped this, letting a path-scoped pack recover
 * evidence from outside the caller's scope).
 */
export async function recoverConcernCandidates(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  cache: FileReadCache,
): Promise<ConcernCandidate[]> {
  const items = buildConcernRecoveryItems(query);
  const groupCount = countSiblingGroups(items);
  if (groupCount === 0) return [];
  const scan: ConcernFixedStringScanner = (needle) =>
    scanLiteral(needle, workspace, {
      caseInsensitive: false,
      ...(args.path ? { path: args.path } : {}),
    }).map((match) => {
      const text = match.text ?? "";
      const at = text.indexOf(needle);
      const before = at >= 0 ? text.slice(0, at) : "";
      const after = at >= 0 ? text.slice(at + needle.length) : "";
      return {
        path: match.path,
        line: match.line,
        definitionShaped: IDENTIFIER_DEFINITION_KEYWORD_RE.test(before) || /^\s*[=:]/.test(after),
        isTestPath: isTestConcernPath(match.path),
        isDocPath: /\.(?:md|markdown|txt|rst|adoc)$/i.test(match.path),
      };
    });
  const enclosingSymbol: ConcernEnclosingSymbolReader = async (filePath, line) => {
    const content = readCached(workspace, filePath, cache);
    if (content === undefined) return undefined;
    const lang = languageForPath(filePath);
    const parsed = lang ? await cache.parsedSymbols(content, lang, filePath) : null;
    const enclosing = (parsed ?? [])
      .filter((sym) => line >= sym.startLine && line <= sym.endLine)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
    return enclosing ? { startLine: enclosing.startLine, endLine: enclosing.endLine, symbol: enclosing.name } : undefined;
  };
  return recoverConcernGroupCandidates(items, scan, enclosingSymbol);
}

// ---------------------------------------------------------------------------
// WP-S9 (TL_CALLER_EXPANSION, 2026-09-20): a caller is found structurally.
// ---------------------------------------------------------------------------
//
// See callerExpansion.ts's module doc for the measured defect. The hook below
// is the ONLY place that module is reached from; it turns a real workspace
// scan and tree-sitter parse into the plain data those pure helpers take, in
// exactly the shape recoverConcernCandidates does for concernRecovery.ts.
//
// Kinds tree-sitter reports for a CALLABLE symbol, versus the type-shaped ones
// whose own members are the interesting focal candidates.
export const CALLER_EXPANSION_CALLABLE_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

export const CALLER_EXPANSION_TYPE_KINDS: ReadonlySet<string> = new Set(["class", "interface", "enum", "type", "trait", "struct"]);

/** Doc/prose surfaces can never hold a call site; skipped before any file is read. */
export const CALLER_EXPANSION_DOC_PATH_RE = /\.(?:md|markdown|txt|rst|adoc)$/i;

/** The file's own declared type: the outermost type-shaped symbol, else the file stem (languages that declare no type at all). */
export function callerExpansionTypeNameFor(parsed: ParsedSymbols, relPath: string): string {
  const declared = parsed
    .filter((symbol) => CALLER_EXPANSION_TYPE_KINDS.has(symbol.kind) && symbol.enclosingSymbol === undefined)
    .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))[0];
  return unqualifiedSymbolTail(declared?.name ?? path.basename(relPath, path.extname(relPath)));
}

/**
 * The focal members one selected surface contributes. Either the surface is
 * FOCUSED on a callable (tier 0 — the pack already decided that member is the
 * answer), or it carries a whole type and the QUERY names one or more of its
 * members (tier 1), matched with the same inflection-tolerant whole-word rule
 * the anchor scorer uses, so "cancellation" reaches `cancel`. A constructor is
 * never a focal member: its callers are object construction, not the
 * behaviour the request asked about.
 */
export async function focalMembersForSurface(
  candidate: ImpactCandidate,
  surfaceIndex: number,
  queryTokens: readonly string[],
  lowerQuery: string,
  workspace: string,
  cache: FileReadCache,
): Promise<FocalMemberCandidate[]> {
  const content = readCached(workspace, candidate.path, cache);
  if (content === undefined) return [];
  const lang = languageForPath(candidate.path);
  const parsed = (lang ? await cache.parsedSymbols(content, lang, candidate.path) : null) ?? [];
  if (parsed.length === 0) return [];
  const typeName = callerExpansionTypeNameFor(parsed, candidate.path);
  const focusedTail = candidate.symbol === undefined ? undefined : unqualifiedSymbolTail(candidate.symbol);
  const focused = focusedTail === undefined
    ? undefined
    : parsed.find((symbol) => unqualifiedSymbolTail(symbol.name) === focusedTail);
  if (focused !== undefined && CALLER_EXPANSION_CALLABLE_KINDS.has(focused.kind)) {
    const member = unqualifiedSymbolTail(focused.name);
    if (normIdent(member) === normIdent(typeName)) return [];
    return [{
      path: candidate.path,
      typeName: unqualifiedSymbolTail(focused.enclosingSymbol?.name ?? typeName),
      member,
      surfaceIndex,
      tier: 0,
      queryPosition: Number.MAX_SAFE_INTEGER,
      redundant: false,
    }];
  }
  // A whole type (or a whole file): the query decides which of its members
  // this pack is really about.
  const out: FocalMemberCandidate[] = [];
  for (const symbol of parsed) {
    if (!CALLER_EXPANSION_CALLABLE_KINDS.has(symbol.kind)) continue;
    const member = unqualifiedSymbolTail(symbol.name);
    if (normIdent(member) === normIdent(typeName)) continue; // constructor
    let position: number | undefined;
    for (const word of splitIdentifierWords(member)) {
      const lowerWord = word.toLowerCase();
      if (lowerWord.length < ANCHOR_INFLECTION_MIN_STEM) continue;
      for (const token of queryTokens) {
        if (!anchorInflectionMatch(token, lowerWord)) continue;
        // Same position trick buildConcernRecoveryItems uses for its own
        // literals: the token's first occurrence in the query text orders
        // "the concern named first" ahead of a later one.
        const at = lowerQuery.indexOf(token);
        if (at >= 0 && (position === undefined || at < position)) position = at;
      }
    }
    if (position === undefined) continue;
    out.push({
      path: candidate.path,
      typeName: unqualifiedSymbolTail(symbol.enclosingSymbol?.name ?? typeName),
      member,
      surfaceIndex,
      tier: 1,
      queryPosition: position,
      redundant: false,
    });
  }
  return out;
}

/**
 * FIX-FAB item 11 (orchestrator report, 2026-09-27 — replayCorpus `sfflag1`
 * flaking under load): a caller-site scan's own completeness must be a fact
 * about WORK DONE, never about wall-clock elapsed. This scan's work is
 * already deterministically bounded before this function is ever called
 * (`paths` is capped at MAX_FACET_CALLER_FILES_CLASSIFIED, and every file it reads is
 * cache-backed), so "did we examine every path we intended to" is a plain
 * count, independent of machine speed or concurrent load on the box — the
 * OLD `planSitesComplete = Date.now() < deadline` (checked by the caller,
 * readCodeTaskPack.ts's `recoverFacetClosureCandidates`, AFTER this
 * function returned) instead re-read the clock a second time and could
 * legitimately read `true` on a fast run of the SAME bounded work and
 * `false` on a loaded one, flipping `act.answer` -> `discover` for reasons
 * that have nothing to do with the evidence. `deadline` remains an EMERGENCY
 * stop only (see `FACET_CLOSURE_EMERGENCY_BUDGET_MS`'s own doc comment):
 * generous enough that it never fires for this bounded amount of work on a
 * normal run, so `complete` is `true` on every normal run regardless of
 * load, and `false` only in the genuinely pathological case the guard
 * exists for.
 */
export interface CallerScanResult {
  readonly sites: CallerSiteCandidate[];
  readonly complete: boolean;
  /**
   * P1-7 (eval-0927 review-r2 #7's "40, 45 real" residual, goMethodManyCallers):
   * true when MORE files mentioned the member than MAX_FACET_CALLER_FILES_CLASSIFIED
   * ever let this scan open — a DIFFERENT fact from `complete`, which is
   * deliberately about work done against the ALREADY-capped candidate list
   * (FIX-FAB item 11's own doc above) and reads `true` even here (every
   * path this scan intended to open, it did). Left `false`/absent, the plan
   * would otherwise certify "covered" the moment every EXAMINED site is
   * served, silently dropping whatever caller files sorted past the cap —
   * never disclosed at all. The gate (facetGate.ts) downgrades to
   * `undetermined` instead when this is `true`, exactly as it already does
   * for a recorder-cap overflow.
   */
  readonly filesCapped?: boolean;
  /** MENTION GUARD (R5-A1): see `unclassifiedMentionLines`'s own doc. */
  readonly unclassifiedMentions?: readonly FacetMentionLine[];
  /** MENTION GUARD: true when more than MAX_UNCLASSIFIED_MENTION_LINES were found. */
  readonly unclassifiedMentionsCapped?: boolean;
  /**
   * P0-2 (R7-A, eval-0927 review-r6 finding 2, defaultExportedDeclCaller):
   * true when the focal's OWN declaration statement is written as its
   * module's default export — see `focalIsSoleDefaultExport`'s own doc.
   * Every importer of this module binds the value under a name of ITS OWN
   * CHOOSING, invisible to this by-NAME scan, so `callerSitesForFocal`
   * (the one place that computes this) sets it regardless of how many sites
   * were actually found — facetGate.ts's `callers` branch reads it only when
   * `total === 0` (a real corroborated call still counts as covered).
   */
  readonly focalDefaultExported?: boolean;
}

/**
 * MENTION GUARD (R5-A1, the round-5 principle). Among `paths` (the SAME
 * examined files a callers/flow scan already opened), every word-bounded
 * mention line of `member` (`linesByPath`, the SAME literal scan that found
 * call sites) that did NOT already become a recorded call site
 * (`recordedKeys`, `${path}#${line}`) and is not wholly a comment, an
 * import/export specifier line, or a declaration of the member.
 *
 * Four review rounds kept finding new declaration/call-shape gaps this
 * classifier itself misses (masked template/f-string interpolations,
 * `yield*`, an explicit generic argument list, an overlooked declaration
 * shape…). Rather than chase each one indefinitely, this is the STRUCTURAL
 * backstop: whatever the classifier above missed, a raw mention of the
 * member that could not be positively explained is recorded here and made
 * a REQUIRED window (see facetGate.ts's `evaluateFacetRequirement`) —
 * served or not, its mere EXISTENCE bars a `request-item-empty:callers:*`
 * verdict, whatever gap produced it.
 *
 * Deliberately independent of `maskNonCode`: that helper blanks an entire
 * quoted span (including a template/f-string interpolation) by design for
 * call-shape column arithmetic, which is exactly backwards for THIS guard —
 * a mention hiding inside `${…}`/an f-string field must still be caught, so
 * this reads the RAW line text directly rather than trusting the same
 * masking the classifier itself relies on. Bounded at
 * MAX_UNCLASSIFIED_MENTION_LINES across every examined path; past it
 * `capped` is true and `lines` stops growing (the facet becomes
 * undetermined outright, never partially served).
 */
/** One line's worth of `BlockCommentLineStates` — what `memberOnlyInCommentText` needs to judge a line without re-scanning the whole file itself. Exported only for `evaluation0927.r7aFalseEmptyGuard.spec.ts`. */
export interface MentionCommentLineState {
  readonly masked: boolean;
  readonly confident: boolean;
  readonly codeFrom: number | undefined;
}

/**
 * A4 (R7-A, eval-0927 review-r6 P1-6/P2-11 class). FIX: the line-start
 * `*`/`/*` shortcuts below USED to be blind (`trimmed.startsWith("*")`
 * unconditionally true, whatever the line actually was) — round-6 P2-8 had
 * already found one shape this breaks (`* run(x) = 3;`, ordinary code
 * outside any block comment, e.g. a pointer-dereference-and-assign or a
 * stray continuation of a multiplication expression) and there is no reason
 * to believe it is the only one. Now consults `state` — the SAME file-level
 * multi-line scan (`blockCommentLineStates`, R7-C's C0) the call-site loops
 * use — so a `*`-led line is comment text only when the file state itself
 * says this line genuinely sits inside a block comment/docstring right now,
 * never merely because of how the line's own text starts.
 *
 * `state.confident === true` decides the whole line outright (comment text,
 * except any code the SAME closer line carries after `state.codeFrom`);
 * `state.masked === true` with `confident === false` still backs the
 * `*`-continuation shortcut (an interior doc-comment PROSE line, whose own
 * opener could not be verified confidently, is still overwhelmingly more
 * likely prose than code); anything else falls through to the ORIGINAL
 * same-line, quote-aware scan, now also tracking an inline `/* … *\/` span
 * opened AND closed on this one line (previously unrecognized — only a
 * trailing `//`/`#` was).
 */
export function memberOnlyInCommentText(text: string, member: string, hashComment: boolean, state: MentionCommentLineState): boolean {
  if (state.confident) {
    if (state.codeFrom === undefined) return true;
    for (let at = text.indexOf(member); at >= 0; at = text.indexOf(member, at + 1)) {
      if (at >= state.codeFrom) return false; // real code after the closer
    }
    return true;
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("*") && state.masked) return true;
  if (trimmed.startsWith("//") || (hashComment && trimmed.startsWith("#"))) return true;
  let quote: string | undefined;
  let inlineBlockOpenAt = -1;
  const inlineSpans: Array<[number, number]> = [];
  let lineCommentAt = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (inlineBlockOpenAt >= 0) {
      if (ch === "*" && text[i + 1] === "/") { inlineSpans.push([inlineBlockOpenAt, i + 2]); inlineBlockOpenAt = -1; i += 1; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "/" && text[i + 1] === "*") { inlineBlockOpenAt = i; continue; }
    if ((ch === "/" && text[i + 1] === "/") || (hashComment && ch === "#")) { lineCommentAt = i; break; }
  }
  if (lineCommentAt < 0 && inlineSpans.length === 0) return false;
  for (let at = text.indexOf(member); at >= 0; at = text.indexOf(member, at + 1)) {
    if (lineCommentAt >= 0 && at >= lineCommentAt) continue;
    if (inlineSpans.some(([start, end]) => at >= start && at < end)) continue;
    return false;
  }
  return true;
}

/**
 * MENTION GUARD (R7-A, eval-0927 review-r6 P0-1). THE ROUND-7 PRINCIPLE: a
 * mention is explained away ONLY by a POSITIVE, exact match against one of a
 * fixed list of import/export/using/include specifier shapes -- never, as
 * every earlier round tried, a generic "this line starts like an import"
 * prefix test plus a denylist of the alias forms found so far. That denylist
 * approach (the OLD `FACET_IMPORT_EXPORT_LINE_RE` + `mentionLineIsAliased-
 * Reference` pair this replaces) kept finding a NEW default-export
 * expression shape the prefix test still waved through unexamined --
 * `export default { fmt: formatBytes };`, `export default debounce(
 * formatBytes, 100);`, `export default [formatBytes];` (review-r6 #1,
 * exportDefaultObjAlias/exportDefaultCallRef/exportDefaultArrayRef) and TS
 * `import fmt = F.formatBytes;` (review-r6 P2 #10, importEqualsAlias): the
 * old regex matched any `export\s*default\b`/`import\b` PREFIX regardless of
 * what followed, and the alias check only special-cased the bare `export
 * default member;` form -- every OTHER expression shape looked "not
 * aliased" and was silently explained away.
 *
 * `mentionExplainedByImportExportLine` tries each recognized shape in turn
 * and returns `true` only when `member` sits in THAT shape's own PLAIN entry
 * position -- exactly `m` (or a TS/JS type-only `type m`), never `m as x` /
 * `x as m` / `m: x` / a Scala `m => x` / a C# `using X = …`. A line that
 * matches none of these shapes at all -- `export default` of ANY expression,
 * `export = …`, TS `import x = …`, `module.exports …`, `exports.x = …`, any
 * aliased entry, any other line -- is left for the caller to record as an
 * unexplained mention, whatever else it might be. Recognizes (member text
 * only; these shapes do not overlap across languages, so no file-extension
 * gate is needed):
 *   - JS/TS `import [type] { …, m, … } from "…"`, `import m[, { … }] from
 *     "…"` (default, optionally with a named list too), `import * as m from
 *     "…"` (namespace); `export [type] { …, m, … } [from "…"]`, `export *
 *     as m from "…"` (namespace re-export).
 *   - CJS `const|let|var { …, m, … } = require("…")`.
 *   - Python `from x import …m…` (single-line; the parenthesized multi-line
 *     form is `mentionInsideMultilineImportList`'s own opener, below),
 *     `import a.b.m` (any dotted segment -- the path names a MODULE, never a
 *     call, so a match anywhere in it is safe regardless of which segment).
 *   - Java/Kotlin/Scala/Dart `import [static] ….m;` (any dotted segment);
 *     Dart `show m` on an import.
 *   - Rust `use …::m;` / `use …::{…, m, …};`.
 *   - PHP `use [function|const] …\m;`.
 *   - C# `using …;` / `using static …;` and C++ `using ns::m;` (one shared
 *     pattern, any `.`/`::`-separated segment -- an alias directive, `using
 *     X = …;`, never matches: the trailing `=` breaks the pattern before it
 *     reaches the line-ending `;`).
 *   - C/C++ `#include …` (a preprocessor line can never contain a call, so
 *     every occurrence on it is explained regardless of where `member`
 *     sits).
 * Deliberately does NOT attempt to resolve a genuine re-export/alias to its
 * real call sites (cross-file specifier resolution is out of this guard's
 * bounded, per-line scope) -- P2 already keeps the facet on `discover` for a
 * concrete unread target elsewhere, and where none exists this guard's own
 * job is only to keep the claim honest: `undetermined`, never `empty`.
 */
export function isPlainListEntry(entry: string, member: string): boolean {
  const trimmed = entry.trim();
  return trimmed === member || trimmed === `type ${member}`;
}

/**
 * Orchestrator (round 7): EVERY entry of `list` that names `member` must be
 * plain, and at least one must exist. A list may name the same member twice
 * — `export { formatBytes, formatBytes as formatSize }` (a deprecation
 * alias), `import { f as g, f }` — and the aliased entry still introduces a
 * second name callers use; one plain sibling must never explain it away.
 */
export function listHasPlainEntry(list: string, member: string): boolean {
  const mentioning = list.split(",").filter((entry) => listEntryNames(entry, member));
  return mentioning.length > 0 && mentioning.every((entry) => isPlainListEntry(entry, member));
}

/** A2 (R8-A, eval-0927 review-r7 P1-2): `member` is named by SOME entry of `list`, plain or aliased -- distinguishes "absent from the list" (safe to fall back to a specifier/path-segment check) from "present but aliased" (never explained, whatever else the line also names -- see `mentionExplainedByImportExportLine`'s own callers below). */
export function listNamesEntry(list: string, member: string): boolean {
  return list.split(",").some((entry) => listEntryNames(entry, member));
}

export function listEntryNames(entry: string, member: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegExp(member)}(?![\\w$])`).test(entry);
}

/** Any `.`/`::`-separated segment of `path` equals `member` exactly -- see this section's own doc for why a path-segment match is always safe (never a call, whichever segment it names). */
export function pathHasSegment(path: string, member: string): boolean {
  return path.split(/::|\./).some((segment) => segment.trim() === member);
}

/** A2 (R8-A, eval-0927 review-r7 P1-2, ktImportAliasCaller): like `pathHasSegment`, but only a NON-LEAF segment counts -- for a dotted path whose LAST segment is itself being aliased away (`import a.b.m as x`, Kotlin/Python/Java-shaped alike), `m` is never safe to explain (an importer reaches it only under `x`, invisible to a by-name scan) while `a`/`b` (mere namespace qualifiers the alias never touches) still are. */
export function pathHasNonLeafSegment(path: string, member: string): boolean {
  const segments = path.split(/::|\./).map((segment) => segment.trim());
  return segments.slice(0, -1).some((segment) => segment === member);
}

/** A4(iii) (R8-A, eval-0927 review-r7 P2-7, pyFromImportTrailingComment): a trailing, quote-aware `//`/`#` line comment stripped before any shape below is tried, so `# noqa`/`// eslint-disable-line` no longer breaks an otherwise-ordinary import/export/use line's own match. Never strips a `#`/`//` inside a quoted specifier, and never a `#` that is (ignoring leading whitespace) the line's OWN first character -- a genuine `#include …`/`#[attr]` directive is untouched; only a comment trailing SOME other content is removed. */
export function stripTrailingLineComment(text: string): string {
  let quote: string | undefined;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; sawContent = true; continue; }
    if (ch === "/" && text[i + 1] === "/") return text.slice(0, i);
    if (ch === "#" && sawContent) return text.slice(0, i);
    if (!/\s/.test(ch)) sawContent = true;
  }
  return text;
}

/** A2 (R8-A, eval-0927 review-r7 P1-2): the per-language shape group `relPath`'s extension belongs to, for gating `mentionExplainedByImportExportLine`'s per-language shapes -- a Python-shaped bare-dotted-import regex must never explain a `.kt` line just because the TEXT happens to parse the same way, and vice versa. `undefined` (an unrecognized extension) tries every shape, same as when `relPath` itself is omitted. */
export function importShapeLangForPath(relPath: string): "js" | "py" | "jvm" | "dart" | "rust" | "cs" | "cpp" | "php" | "go" | undefined {
  const dot = relPath.lastIndexOf(".");
  const ext = dot > 0 ? relPath.slice(dot).toLowerCase() : "";
  switch (ext) {
    case ".ts": case ".tsx": case ".mts": case ".cts":
    case ".js": case ".jsx": case ".mjs": case ".cjs":
      return "js";
    case ".py": case ".pyi": case ".pyw":
      return "py";
    case ".java": case ".kt": case ".kts":
      return "jvm";
    case ".dart":
      return "dart";
    case ".rs":
      return "rust";
    case ".cs":
      return "cs";
    case ".c": case ".h": case ".cc": case ".cpp": case ".cxx": case ".hpp": case ".hh": case ".hxx":
      return "cpp";
    case ".php":
      return "php";
    case ".go":
      return "go";
    default:
      return undefined;
  }
}

/**
 * A2/A4 (R8-A, eval-0927 review-r7 P1-2, P2-7). Two additions layered on the
 * ROUND-7 PRINCIPLE (this function's own long-standing contract: a POSITIVE,
 * exact match against a fixed list of shapes, never a generic prefix test),
 * both still never resolving a real alias/re-export to its call sites:
 *
 *   A2 -- an ALIASED entry is never explained, in ANY language, including a
 *   BARE dotted import whose trailing `as x` clause aliases its own last
 *   segment (Kotlin/Scala/Java-shaped `import a.b.m as x`, Python's own
 *   `import a.m as x` alike -- `pathHasNonLeafSegment` above). Each
 *   language's shape is additionally gated by `relPath`'s extension
 *   (`importShapeLangForPath`) when the caller supplies one; omitted (the
 *   pre-existing pure-unit-test surface) every shape is tried exactly as
 *   before extension gating existed.
 *
 *   A4 -- three narrow, still-positive additions: (i) an occurrence inside
 *   the QUOTED MODULE SPECIFIER of a recognized line (the file path names a
 *   module there, never a call) -- checked only once the line's own named
 *   entries are ruled out (`listNamesEntry` distinguishes "member absent
 *   from the list" -- safe to fall back to the specifier -- from "member
 *   present but aliased" -- per A2, never explained by the specifier
 *   either); a bare `import "spec";`/`export * from "spec";` with no local
 *   name bound at all is always explained. (ii) a non-leaf path segment of a
 *   dotted/`::`-joined module path, extended to `from x.y import z`'s own
 *   `x.y` and Rust `use a::b::c;`'s own `a::b`. (iii) `stripTrailingLine-
 *   Comment` above, applied before any shape is tried.
 */
export function mentionExplainedByImportExportLine(text: string, member: string, relPath?: string): boolean {
  const stripped = stripTrailingLineComment(text);
  const lang = relPath === undefined ? undefined : importShapeLangForPath(relPath);
  const tryLang = (l: "js" | "py" | "jvm" | "dart" | "rust" | "cs" | "cpp" | "php" | "go"): boolean => lang === undefined || lang === l;

  if (tryLang("js") || tryLang("go")) {
    // A4(i)/A3 (Go `import "example.com/app/run"`): a bare quoted specifier
    // with no binding at all -- textually identical for JS side-effect
    // imports and Go's own single-spec form, so one shared shape covers
    // both; any occurrence of `member` on such a line can only ever be
    // inside the specifier, which names a module file, never a call.
    if (/^\s*import\s+(["'][^"']+["'])\s*;?\s*$/.test(stripped)) return true;
  }
  if (tryLang("js")) {
    const jsNamed = /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'][^"']+["'])/.exec(stripped);
    if (jsNamed) {
      if (listHasPlainEntry(jsNamed[1]!, member)) return true;
      if (listNamesEntry(jsNamed[1]!, member)) return false;
      return listEntryNames(jsNamed[2]!, member);
    }
    const jsDefault = /^\s*import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*(?:type\s+)?\{([^}]*)\})?\s*from\s*(["'][^"']+["'])/.exec(stripped);
    if (jsDefault) {
      const named = jsDefault[2];
      // Orchestrator (round 7, r7orchImportDoubleEntry): the default
      // binding's own name matching `member` must NOT short-circuit before
      // checking the named-list part for an ALIASED sibling of the SAME
      // member (`import formatBytes, { formatBytes as fmt } from "./x";`) --
      // that second, hidden `fmt` binding is exactly the shape a by-name
      // scan cannot follow, so its presence must win even when the default
      // name alone would otherwise explain the line.
      if (named !== undefined && listNamesEntry(named, member) && !listHasPlainEntry(named, member)) return false;
      if (jsDefault[1] === member) return true;
      if (named !== undefined && listHasPlainEntry(named, member)) return true;
      return listEntryNames(jsDefault[3]!, member);
    }
    const jsNamespace = /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*(["'][^"']+["'])/.exec(stripped);
    if (jsNamespace) return jsNamespace[1] === member || listEntryNames(jsNamespace[2]!, member);
    // A4(i): `export * from "…";` -- a bare re-export-everything with no
    // local name bound at all; any occurrence of `member` on this line can
    // only ever be inside the specifier.
    if (/^\s*export\s+\*\s+from\s+(["'][^"']+["'])\s*;?\s*$/.test(stripped)) return true;
    const jsExportNamed = /^\s*export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*(["'][^"']+["']))?/.exec(stripped);
    if (jsExportNamed) {
      if (listHasPlainEntry(jsExportNamed[1]!, member)) return true;
      if (listNamesEntry(jsExportNamed[1]!, member)) return false;
      return jsExportNamed[2] !== undefined && listEntryNames(jsExportNamed[2]!, member);
    }
    const jsExportNamespace = /^\s*export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s*from\s*(["'][^"']+["'])/.exec(stripped);
    if (jsExportNamespace) return jsExportNamespace[1] === member || listEntryNames(jsExportNamespace[2]!, member);
    const cjsRequire = /^\s*(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*(["'][^"']+["'])\s*\)/.exec(stripped);
    if (cjsRequire) {
      if (listHasPlainEntry(cjsRequire[1]!, member)) return true;
      if (listNamesEntry(cjsRequire[1]!, member)) return false;
      return listEntryNames(cjsRequire[2]!, member);
    }
  }
  if (tryLang("py")) {
    const pyFrom = /^\s*from\s+([.\w]+)\s+import\s+\(?([^)]*)\)?\s*$/.exec(stripped);
    if (pyFrom) {
      if (listHasPlainEntry(pyFrom[2]!, member)) return true;
      if (listNamesEntry(pyFrom[2]!, member)) return false;
      return pathHasSegment(pyFrom[1]!, member); // A4(ii): `from app.validate import validate_email`'s own `app.validate`
    }
    const pyImport = /^\s*import\s+([.\w]+)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(stripped);
    if (pyImport) return pyImport[2] !== undefined ? pathHasNonLeafSegment(pyImport[1]!, member) : pathHasSegment(pyImport[1]!, member);
  }
  if (tryLang("jvm")) {
    const dottedImport = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;?\s*$/.exec(stripped);
    if (dottedImport) return pathHasSegment(dottedImport[1]!, member);
  }
  if (tryLang("dart")) {
    const dartShow = /^\s*import\s+['"][^'"]+['"][^;]*\bshow\s+([\w\s,]+?)(?:\s+hide\b.*)?;?\s*$/.exec(stripped);
    if (dartShow) return listHasPlainEntry(dartShow[1]!, member);
  }
  if (tryLang("rust")) {
    const rustSingle = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)::([A-Za-z_]\w*)\s*;/.exec(stripped);
    if (rustSingle) return rustSingle[2] === member || pathHasSegment(rustSingle[1]!, member); // A4(ii): `use crate::run::helper;`'s own `crate::run`
    const rustList = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)::\{([^}]*)\}\s*;/.exec(stripped);
    if (rustList) {
      if (listHasPlainEntry(rustList[2]!, member)) return true;
      if (listNamesEntry(rustList[2]!, member)) return false;
      return pathHasSegment(rustList[1]!, member);
    }
  }
  if (tryLang("php")) {
    const php = /^\s*use\s+(?:function\s+|const\s+)?([\w\\]+)\s*;/.exec(stripped);
    if (php) return pathHasSegment(php[1]!.replace(/\\/g, "."), member);
  }
  if (tryLang("cs")) {
    const usingStatic = /^\s*using\s+static\s+([\w.]+)\s*;/.exec(stripped);
    if (usingStatic) return pathHasSegment(usingStatic[1]!, member);
  }
  if (tryLang("cs") || tryLang("cpp")) {
    // C# `using Some.Namespace;` and C++ `using ns::m;` share this one
    // pattern -- an alias directive (`using X = …;`) never matches: the
    // trailing `=` leaves no way for `\s*;` to follow the captured path.
    const usingPlain = /^\s*using\s+([\w:.]+)\s*;/.exec(stripped);
    if (usingPlain) return pathHasSegment(usingPlain[1]!, member);
  }
  if (tryLang("cpp") && /^\s*#include\b/.test(stripped)) return true;
  return false;
}

/** Lines scanned backward for the opening `{`/`(` of a multi-line import/export/use list a bare entry line (`mentionInsideMultilineImportList`) sits inside. */
export const MAX_MENTION_IMPORT_LIST_BACKSCAN_LINES = 64;

/**
 * Whether `text` opens one of the multi-line-capable list shapes
 * (`mentionExplainedByImportExportLine`'s JS/TS `import`/`export { … }`,
 * Python `from x import ( … )`, Rust `use a::{ … }`, and -- A4(iv), R8-A,
 * eval-0927 review-r7 P2-7, cjsMultilineRequireCaller/tsDefaultPlusNamed-
 * Multiline -- a destructuring-assignment target `const|let|var {` and a
 * combined default+named `import x, {`) with its OWN bracket left UNCLOSED
 * on this line -- an opener that also closes on the same line is the
 * single-line case `mentionExplainedByImportExportLine` already tries first,
 * never reached from here. `text` is comment-stripped first (A4(iii)) so a
 * `// {` inside a trailing comment is never mistaken for an opener.
 */
export function multilineListOpenerKind(text: string): "curly" | "paren" | undefined {
  const stripped = stripTrailingLineComment(text);
  if (
    /^\s*(?:import|export)\s+(?:type\s+)?\{/.test(stripped)
    || /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+[\w:]+::\{/.test(stripped)
    || /^\s*import\s+[A-Za-z_$][\w$]*\s*,\s*(?:type\s+)?\{/.test(stripped)
    || /^\s*(?:export\s+)?(?:const|let|var)\s*\{/.test(stripped)
  ) {
    const opens = stripped.match(/\{/g)?.length ?? 0;
    const closes = stripped.match(/\}/g)?.length ?? 0;
    return opens > closes ? "curly" : undefined;
  }
  if (/^\s*from\s+[.\w]+\s+import\s+\(/.test(stripped)) {
    const opens = stripped.match(/\(/g)?.length ?? 0;
    const closes = stripped.match(/\)/g)?.length ?? 0;
    return opens > closes ? "paren" : undefined;
  }
  return undefined;
}

/**
 * R7-A (P0-1's own multi-line-list clause): 1-based `line` in `fileLines` is
 * a bare plain entry (or a comma-list of them, `a, m,`) sitting inside an
 * UNCLOSED bracketed list a bounded (<= MAX_MENTION_IMPORT_LIST_BACKSCAN_LINES)
 * backward scan traces to one of `multilineListOpenerKind`'s recognized
 * openers. Tracks curly/paren depth across the lines walked (each also
 * comment-stripped first, A4(iii): `import {\n  a, // {\n  m,\n} from "…";`
 * must not mistake the `{` inside that trailing comment for a second,
 * unrelated opener) -- a net `}`/`)` above the entry means some OTHER,
 * unrelated list closed there, and the scan stops rather than walk past it
 * (bounded, best-effort: an entry line combined with its list's own closer
 * on one line, `m } from "…";`, is the rarer hybrid this deliberately leaves
 * unrecognized -- still safe, since an unrecognized shape only stays a
 * mention, never becomes a false "empty"). An ordinary multi-line
 * `import {\n  m,\n} from "…";` no longer becomes an unclassified mention
 * merely because ITS OWN line carries no `import`/`export`/`from`/`use`
 * keyword at all.
 */
export function mentionInsideMultilineImportList(fileLines: readonly string[], line: number, member: string): boolean {
  const text = fileLines[line - 1];
  if (text === undefined) return false;
  const entryLine = stripTrailingLineComment(text).trim().replace(/,\s*$/, "");
  if (entryLine.length === 0 || !listHasPlainEntry(entryLine, member)) return false;
  let curly = 0;
  let paren = 0;
  const floor = Math.max(0, line - 1 - MAX_MENTION_IMPORT_LIST_BACKSCAN_LINES);
  for (let i = line - 2; i >= floor; i--) {
    const above = stripTrailingLineComment(fileLines[i] ?? "");
    curly += (above.match(/\}/g)?.length ?? 0) - (above.match(/\{/g)?.length ?? 0);
    paren += (above.match(/\)/g)?.length ?? 0) - (above.match(/\(/g)?.length ?? 0);
    const kind = multilineListOpenerKind(above);
    if (kind === "curly" && curly < 0) return true;
    if (kind === "paren" && paren < 0) return true;
    if (curly < 0 || paren < 0) return false;
  }
  return false;
}

/** Combined MENTION GUARD import/export explanation: the single-line shapes (`mentionExplainedByImportExportLine`) plus a bare entry inside a multi-line list (`mentionInsideMultilineImportList`). Exported only for `evaluation0927.r7aFalseEmptyGuard.spec.ts`. `relPath`, when supplied, gates `mentionExplainedByImportExportLine`'s per-language shapes (A2); omitted, every shape is tried. */
export function mentionExplainedByImportExport(fileLines: readonly string[], line: number, member: string, relPath?: string): boolean {
  const text = fileLines[line - 1];
  if (text !== undefined && mentionExplainedByImportExportLine(text, member, relPath)) return true;
  return mentionInsideMultilineImportList(fileLines, line, member);
}

/**
 * MENTION GUARD SAFETY OVERRIDE (R5-A1). A handful of EXPRESSION keywords
 * (never able to open a declaration of the identifier right after them, in
 * ANY of TS/JS/Python/Go/Java/C#/C/C++) that a shape-based declaration
 * heuristic can still mistake for a TYPE token with a trailing pointer/
 * reference marker when only `*`/`&` sits between them and the member --
 * `yield* walkTree(root);` reads exactly like the C-style pointer
 * declaration `Node* walkTree`, and `isDeclarationShapedMatchText`'s own
 * `declarationHeadShape` path (callerExpansion.ts, R5-A2's classifier) can
 * still say so (its OWN fix for this exact shape, R5-A2's P1-6, is a
 * SEPARATE, in-flight concern). The guard's whole job is to hold whatever
 * the classifier does, so it must not simply trust that same shape guess
 * for a prefix this narrow, reliable list can already rule out on its own
 * -- overriding a "declaration" verdict to `false`, never the reverse (a
 * real method-shorthand declaration with no keyword at all,
 * `render(input) {`, is untouched: this list is only ever consulted when
 * a keyword from it is the literal last thing before the member).
 */
export const MENTION_GUARD_NEVER_DECLARES_NEXT_RE = /\b(?:yield|return|await|throw|typeof|delete|void|new|in|of|instanceof|case|do|else)\s*[*&]?\s*$/;

/**
 * MENTION GUARD SAFETY OVERRIDE (R7-A, eval-0927 review-r6 P0-1,
 * `export default [computeTotal];`-shaped). The shared classifier's own
 * `IDENTIFIER_DEFINITION_KEYWORD_RE` matches the bare word `export`
 * ANYWHERE in its definition segment, with no opinion on what follows
 * `default` -- and unlike the object/call/arrow forms (whose segment is cut
 * short at the `{`/`(` that `definitionSegment` already treats as a
 * statement boundary, dropping the leading `export default` out of the
 * segment entirely), a `[` after `default` is not one of those boundary
 * characters, so `export default [` stays intact as one segment and the
 * bare keyword match fires: `export default [member];` reads as "a
 * declaration" even though it is plainly an array-literal EXPRESSION.
 *
 * Never true for a genuine declaration header either: `export default
 * function member(...)`'s own occurrence of `member` never reaches this
 * override (or `mentionLineLooksLikeDeclaration` at all) in the first
 * place, since the CROSS-FILE mention scan excludes `focal.path` outright
 * and the SAME-FILE scan excludes the focal's own body range (see
 * `unclassifiedMentionLines`'s cross-file caller and
 * `sameFileFacetCallSites`'s own `focal.startLine`/`endLine` skip) -- every
 * line this guard ever examines is, by construction, never the focal's own
 * declaration statement. So any line that opens with `export default` and
 * is not itself one of `mentionExplainedByImportExportLine`'s recognized
 * declaration-shaped forms (`function`/`class`, optionally `async`/
 * `abstract`) can never be a declaration of the member either --
 * overriding a "declaration" verdict to `false`, the same direction
 * `MENTION_GUARD_NEVER_DECLARES_NEXT_RE` above already takes.
 */
export const MENTION_GUARD_EXPORT_DEFAULT_EXPR_RE = /^\s*export\s+default\b(?!\s+(?:async\s+)?(?:abstract\s+)?(?:function|class)\s)/;

/** `isDeclarationShapedMatchText` (R5-A2's shared classifier, called not edited), with the mention guard's own narrow overrides above applied first. */
export function mentionLineLooksLikeDeclaration(text: string, member: string): boolean {
  const at = text.indexOf(member);
  if (at < 0) return false;
  if (MENTION_GUARD_NEVER_DECLARES_NEXT_RE.test(text.slice(0, at))) return false;
  if (MENTION_GUARD_EXPORT_DEFAULT_EXPR_RE.test(text)) return false;
  return isDeclarationShapedMatchText(text, member);
}

export function unclassifiedMentionLines(
  member: string,
  paths: readonly string[],
  linesByPath: ReadonlyMap<string, readonly number[]>,
  recordedKeys: ReadonlySet<string>,
  workspace: string,
  cache: FileReadCache,
): { lines: FacetMentionLine[]; capped: boolean } {
  const lines: FacetMentionLine[] = [];
  let capped = false;
  for (const relPath of paths) {
    if (capped) break;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    const fileLines = content.split(/\r?\n/);
    const hashComment = hasHashComments(relPath);
    // A3 (eval-0927 review-r6 P1-5): an embedded-code file this classifier's
    // own language assumptions were never built for (a template/markup file
    // mixing several languages, or a JSON notebook) -- see
    // `isCallerMentionOnlyFile`'s own doc. Every occurrence stays an
    // unclassified mention unconditionally: the comment/import-export/
    // declaration heuristics below are untested for these shapes and could
    // just as easily misfire either direction, so they are skipped entirely
    // rather than risk explaining a real call away.
    const mentionOnly = isCallerMentionOnlyFile(relPath);
    // A4 (eval-0927 review-r6 P1-6/P2-11 class): the SAME file-level
    // multi-line scan the call-site loops use, so `memberOnlyInCommentText`
    // judges a masked/confident/codeFrom line here exactly as they do.
    const commentState: BlockCommentLineStates | undefined = mentionOnly ? undefined : blockCommentLineStates(fileLines, relPath);
    for (const line of linesByPath.get(relPath) ?? []) {
      if (recordedKeys.has(`${relPath}#${line}`)) continue;
      const text = fileLines[line - 1];
      if (text === undefined) continue;
      if (!mentionOnly && commentState !== undefined) {
        const lineState: MentionCommentLineState = {
          masked: commentState.masked[line - 1] === true,
          confident: commentState.confident[line - 1] === true,
          codeFrom: commentState.codeFrom[line - 1] ?? undefined,
        };
        if (memberOnlyInCommentText(text, member, hashComment, lineState)) continue;
        if (mentionExplainedByImportExport(fileLines, line, member, relPath)) continue;
        if (mentionLineLooksLikeDeclaration(text, member)) continue;
      }
      if (lines.length >= MAX_UNCLASSIFIED_MENTION_LINES) { capped = true; break; }
      lines.push({ path: relPath, line });
    }
  }
  return { lines, capped };
}

/**
 * Up to `MAX_DECLARATION_HEAD_LOOKAHEAD_LINES` further RAW lines after
 * 1-based `line` in `lines`, each already `maskNonCode`-d, IN ORDER — feeds
 * `opensBlockDeclaration`'s multi-line paren-balance scan (R4-A2, eval-0927
 * review-r3 P0-3/shape(2), wrapperAliasMultiline/multilineSigManyCallers: a
 * declaration whose own parameter list spans SEVERAL lines before the body
 * opens, e.g. `async fetchJson(\n  pathname: string,\n  init?: RequestInit,
 * \n): Promise<unknown> {`). Deliberately keeps BLANK lines in place (unlike
 * the old single-line "next NON-blank line" helper this replaces): a blank
 * line inside a parameter list contributes no `(`/`)`/`{` and skipping it
 * would misalign which line is "the one right after the close" for the
 * deferred-body-opener check that runs once the scan actually closes.
 * Bounded so a pathological unclosed occurrence, or a file ending mid-scan,
 * never reads far.
 */
export function subsequentMaskedLines(lines: readonly string[], line: number, hashComment: boolean): string[] {
  const end = Math.min(lines.length, line + MAX_DECLARATION_HEAD_LOOKAHEAD_LINES);
  const out: string[] = [];
  for (let i = line; i < end; i++) {
    const text = lines[i];
    if (text === undefined) break;
    out.push(maskNonCode(text, hashComment));
  }
  return out;
}

/**
 * Extensions whose language gives `void` a SECOND meaning: the unary
 * operator that discards an expression's result (`void someCall()`) —
 * JS/TS only. Every OTHER language with a `void` keyword (C/C++/Java/C#/…)
 * has no such operator and never writes a return type any way other than a
 * prefix before the name (`void mixQuadX(...) {}`, no modifier required) —
 * a bare `void` there is exactly as conclusive proof of a declaration as
 * `function`/`def`/`class`. JS/TS, conversely, NEVER writes a C-style
 * prefix return type at all (a TS return annotation sits AFTER the
 * parameter list: `function f(): void {}`), so `void` immediately before a
 * bare call-shaped name in one of these files is always the operator.
 */
export const VOID_OPERATOR_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

/** True when `relPath`'s language gives `void` an operator meaning (see `VOID_OPERATOR_EXTENSIONS`). */
export function isVoidOperatorLanguage(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot > 0 && VOID_OPERATOR_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

/**
 * The ONE declaration-vs-call rule every call-site collector applies
 * (`callSitesForFocalMember`, `plainFunctionCallerSites`,
 * `sameFileFacetCallSites` — P0-1, eval-0927 review-r2 #1/#2/#12): `false`
 * for anything but a bare/scope-qualified occurrence (a dot/arrow/scope-
 * qualified call with a receiver can never BE the declaration of the name
 * it invokes). A keyword-led declaration — the shared
 * `IDENTIFIER_DEFINITION_KEYWORD_RE`, applied to `definitionSegment` exactly
 * as before — is conclusive on its own EXCEPT a bare `void` hit in a
 * VOID-OPERATOR language (JS/TS): `void` is ALSO the operator that discards
 * a call's result there (`void recordEvent(..., {...})`, review-r2 #1's
 * callersObjectArgTsAwait), so THAT one combination defers to the shape
 * test instead of ending the check by itself. A `void` hit anywhere else —
 * including a MODIFIER-LESS C/C++ free function (`void mixQuadX(...) {}`,
 * FX-R3c D8/D9's `sfnf1`, no `public`/`static` to lean on) — stays
 * conclusive exactly like any other keyword: those languages have no void
 * operator to be ambiguous with, so narrowing this to the shape test's own
 * `declarationHeadShape`-requires-a-modifier rule (FIX-FAB2, aimed
 * specifically at the JS-operator ambiguity) would wrongly read the
 * function's own declaration line as a call site of itself. The shape test
 * itself (`opensBlockDeclaration`) now paren-matches the occurrence's OWN
 * argument list on the right — possibly across SEVERAL further lines
 * (R4-A2, eval-0927 review-r3 P0-3/shape(2): a multi-line parameter list),
 * never an argument's own nested `{` — an object literal, callback or dict
 * argument, review-r2 #1's other three cases — and is skipped entirely for
 * an ALWAYS-keyword-led language (Kotlin/Rust/Swift/Python/Ruby/Scala): a
 * bare occurrence there is always a CALL — most often a trailing
 * lambda/closure argument — never a keyword-less declaration, which those
 * languages have no syntax for at all. Go is the one ALWAYS-keyword-led
 * exception (R4-A2, eval-0927 review-r3 #5, goIfaceMethod): its interface
 * members ARE written with no `func` at all, so a Go file with no keyword
 * hit tries `goInterfaceMemberDeclarationShape` (callerExpansion.ts's own
 * doc has the narrow, unambiguous shape this accepts) before falling
 * through to a call.
 *
 * Exported for `callSiteClassificationMatrix.spec.ts` (R4-A2) — the
 * regression fence for every declaration-vs-call shape this rule and
 * `opensBlockDeclaration`/`rightHandOpensDeclarationBody` together decide.
 *
 * FIX (R5-A2, eval-0927 review-r4 P0-2/P1-11, cpp-out-of-line-member-
 * usertype/cpp-out-of-line-member-std): a SCOPE-qualified occurrence with no
 * keyword hit used to fall straight to `return false` — correct for an
 * ordinary namespaced/static CALL (`app::run(x);`, `Foo::run(x);`), but also
 * wrong for C++'s out-of-line member DEFINITION (`OrderStatus
 * OrderService::cancel(int id) {`), whose return type is exactly as often a
 * custom class/struct name (never a recognized keyword) as a call's
 * receiver expression is. The two are told apart by feeding the shape test
 * only the part of `before` that is NOT the scope qualifier itself — the
 * qualifier names WHICH type this belongs to, not a return-type word, and
 * handing it to the modifier/type-word parser as one would only ever
 * reject the line (as `app::run` / `Foo::run` already correctly do, since
 * their remainder — an assignment, an empty head, or another statement's
 * own leftovers — never parses as a valid head either).
 */
export function callSiteOccurrenceIsDeclaration(
  occurrence: CallSiteOccurrence,
  masked: string,
  relPath: string,
  lines: readonly string[],
  line: number,
  hashComment: boolean,
): boolean {
  if (occurrence.qualifier !== "bare" && occurrence.qualifier !== "scope") return false;
  // A keyword inside a closed paren group is a cast (`(void) f(x);`,
  // `return (int) f(x);`), and `export default f(x)` exports an expression:
  // both are calls, never a declaration of `f` (orchestrator probe, round 4).
  const segment = withoutClosedParenGroups(definitionSegment(occurrence.before));
  if (/\bexport\s+default\s*$/.test(segment)) return false;
  const keywordHit = segment.match(IDENTIFIER_DEFINITION_KEYWORD_RE)?.[0];
  if (keywordHit !== undefined && !(keywordHit === "void" && isVoidOperatorLanguage(relPath))) return true;
  if (occurrence.qualifier === "scope") {
    if (occurrence.receiver === undefined) return false;
    const scopeSuffixLength = occurrence.receiver.length + 2; // the trailing `Receiver::` itself
    if (scopeSuffixLength > occurrence.before.length) return false; // defensive; should not happen
    const returnTypeHead = occurrence.before.slice(0, occurrence.before.length - scopeSuffixLength);
    const laterLines = subsequentMaskedLines(lines, line, hashComment);
    if (!declarationHeadShape(returnTypeHead)) return false;
    return rightHandOpensDeclarationBody(masked, occurrence.before.length, laterLines, hasDeclarationHeadWord(returnTypeHead));
  }
  const laterLines = subsequentMaskedLines(lines, line, hashComment);
  if (isGoLanguage(relPath)) {
    // A name that opens its line inside a Go `interface { … }` body is a
    // method spec, never a call — including a void one (`Close()`), which
    // the forward shape test cannot tell from a call statement.
    if (occurrence.before.trim() === "" && insideGoInterfaceBody(lines, line, hashComment)) return true;
    return goInterfaceMemberDeclarationShape(masked, occurrence.before.length, laterLines);
  }
  return opensBlockDeclaration(masked, occurrence.before, isAlwaysKeywordLedLanguage(relPath), laterLines);
}

/**
 * Compatible call sites of ONE focal member, ranked. Bounded by
 * MAX_FACET_CALLER_FILES_CLASSIFIED; `deadline` is an emergency stop only, see
 * `CallerScanResult`'s own doc comment. Exported only for
 * `facetClosureTimingIndependence.spec.ts` (FIX-FAB item 11), which injects
 * a synthetic slow clock to prove `complete` for a small, deterministically-
 * bounded scan never depends on how fast that clock advances.
 */
export function callSitesForFocalMember(
  focal: CallerFocalMember,
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
  allowTestPaths: boolean,
  deadline: number,
): CallerScanResult {
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = facetCallerMentionScan(focal.member, workspace, args);
  } catch {
    return { sites: [], complete: true };
  }
  const linesByPath = new Map<string, number[]>();
  for (const match of scanned) {
    if (match.path === focal.path) continue; // never its own caller
    if (!allowTestPaths && isTestConcernPath(match.path)) continue;
    if (CALLER_EXPANSION_DOC_PATH_RE.test(match.path)) continue;
    const existing = linesByPath.get(match.path);
    if (existing) existing.push(match.line);
    else linesByPath.set(match.path, [match.line]);
  }
  // Nearest files first, so an emergency-stop or file-count cut keeps the
  // files the ranking would have preferred anyway rather than an
  // alphabetical prefix.
  const filesCapped = linesByPath.size > MAX_FACET_CALLER_FILES_CLASSIFIED; // P1-7: see CallerScanResult.filesCapped's own doc
  const paths = [...linesByPath.keys()].sort((a, b) =>
    sharedPathPrefixSegments(b, focal.path) - sharedPathPrefixSegments(a, focal.path)
    || a.localeCompare(b)
  ).slice(0, MAX_FACET_CALLER_FILES_CLASSIFIED);
  const sites: CallerSiteCandidate[] = [];
  // R6-A (eval-0927 review-r5 P2-6, cppUserTypeMemberFalseCaller): every
  // `${path}#${line}` the occurrence loop below itself judged a DECLARATION
  // (`callSiteOccurrenceIsDeclaration`, incl. its own C++ out-of-line-member
  // scope-qualified case) — merged into `recordedKeys` alongside real call
  // sites so `unclassifiedMentionLines`'s weaker, independent
  // `mentionLineLooksLikeDeclaration` never re-examines and misclassifies
  // the SAME line as an unclassified mention.
  const declarationLineKeys = new Set<string>();
  let examined = 0;
  for (const relPath of paths) {
    if (Date.now() >= deadline) break;
    examined += 1;
    // A3 (eval-0927 review-r6 P1-5): an embedded-code file this classifier's
    // language assumptions do not cover at all (see `isCallerMentionOnlyFile`'s
    // own doc) -- never run the call/declaration classifier or the
    // `/* … */`/docstring block-comment mask against it (an HTML/ERB/JSP
    // comment is neither), and never filter its matched lines here:
    // `unclassifiedMentionLines` below picks up every one of them, straight
    // from the SAME `linesByPath` entry the literal scan already populated.
    if (isCallerMentionOnlyFile(relPath)) continue;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    const hashComment = hasHashComments(relPath);
    // A4 (eval-0927 review-r6 P1-6/P2-11 class, was R6-C P1-5): drop only a
    // CONFIDENTLY masked line here — genuinely comment/docstring text, never
    // a call site nor an unclassified mention. A line merely MASKED (the
    // file-level scan could not confirm its own span's opener was at the
    // START of its line) is kept in `linesByPath` for the MENTION GUARD
    // below, which reads the very same map — but is never itself scanned
    // for a call site (see the `codeFrom`/`masked` check inside the loop).
    const commentState = blockCommentLineStates(lines, relPath);
    const candidateLines = (linesByPath.get(relPath) ?? []).filter((line) => commentState.confident[line - 1] !== true);
    linesByPath.set(relPath, candidateLines);
    const namesType = fileNamesType(lines, focal.typeName, hashComment);
    const inFile: Array<{ line: number; strength: 1 | 2 }> = [];
    for (const line of candidateLines) {
      const codeFrom = commentState.codeFrom[line - 1];
      // A non-confident masked line with no closer-carried code is never
      // itself a call site (still eligible below as an unclassified
      // mention, via the unfiltered `linesByPath` entry above).
      if (commentState.masked[line - 1] === true && codeFrom === undefined) continue;
      const rawText = lines[line - 1];
      if (rawText === undefined) continue;
      // P2-11 (eval-0927 review-r6, a call on a block-comment CLOSER line,
      // `*/ run(2);`): classify from `codeFrom` on — the comment prefix is
      // blanked (space-padded, keeping column positions aligned) rather
      // than handed whole to `maskNonCode`, which has no memory of the
      // PRIOR lines that opened this span and so cannot itself tell that
      // prefix apart from real code (a comment's own PROSE could otherwise
      // spuriously read as a declaration keyword or another occurrence).
      const text = codeFrom !== undefined ? " ".repeat(codeFrom) + rawText.slice(codeFrom) : rawText;
      const masked = maskNonCode(text, hashComment, relPath);
      for (const occurrence of findCallOccurrences(masked, focal.member)) {
        if (callSiteOccurrenceIsDeclaration(occurrence, masked, relPath, lines, line, hashComment)) {
          declarationLineKeys.add(`${relPath}#${line}`);
          continue;
        }
        const nameStrength = receiverStrength(occurrence.receiver, focal.typeName, namesType);
        const strength = nameStrength !== 0
          ? nameStrength
          : (occurrence.receiver !== undefined && receiverImportedFromFocalFile(lines, occurrence.receiver, focal.path, hashComment) ? 1 : 0);
        if (strength === 0) continue;
        inFile.push({ line, strength });
        break; // one site per line is enough; the window is the same either way
      }
    }
    for (const site of inFile) {
      sites.push({
        path: relPath,
        line: site.line,
        strength: site.strength,
        callsInFile: inFile.length,
        proximity: sharedPathPrefixSegments(relPath, focal.path),
      });
    }
  }
  // MENTION GUARD (R5-A1): among the SAME examined `paths`, every mention
  // line this scan did not already record as a call site above — see
  // `unclassifiedMentionLines`'s own doc.
  const recordedKeys = new Set([...sites.map((site) => `${site.path}#${site.line}`), ...declarationLineKeys]);
  const { lines: unclassifiedMentions, capped: unclassifiedMentionsCapped } =
    unclassifiedMentionLines(focal.member, paths, linesByPath, recordedKeys, workspace, cache);
  return {
    sites: rankCallSites(sites),
    complete: examined === paths.length,
    ...(filesCapped ? { filesCapped } : {}),
    ...(unclassifiedMentions.length > 0 ? { unclassifiedMentions } : {}),
    ...(unclassifiedMentionsCapped ? { unclassifiedMentionsCapped: true } : {}),
  };
}

/**
 * The caller-expansion additions for one answer pack, for the caller to MERGE
 * (never to inject into the ranking): at most MAX_CALLER_SURFACES surfaces and
 * MAX_CALLER_EXPANSION_BYTES embedded bytes, one per file, never a file the
 * pack already selected, never the focal file itself. Abstains — returns [] —
 * whenever no focal member or no compatible call site can be established.
 *
 * `args.path` is threaded into the scan exactly like recoverConcernCandidates
 * threads it, so a path-scoped pack never recovers a caller from outside the
 * caller's own scope.
 */
export async function recoverCallerExpansionCandidates(
  args: TaskPackArgs,
  query: string,
  workspace: string,
  cache: FileReadCache,
  selected: readonly ImpactCandidate[],
): Promise<ImpactCandidate[]> {
  if (selected.length === 0) return [];
  const deadline = Date.now() + CUMULATIVE_LOCATE_BUDGET_MS;
  const queryTokens = tokenizeQueryForDiversification(query);
  if (queryTokens.length === 0) return [];
  const lowerQuery = query.toLowerCase();
  const focalCandidates: FocalMemberCandidate[] = [];
  for (const [index, candidate] of selected.entries()) {
    if (Date.now() >= deadline) break;
    focalCandidates.push(
      ...await focalMembersForSurface(candidate, index, queryTokens, lowerQuery, workspace, cache),
    );
  }
  // A member name another surface is already FOCUSED on is the same question
  // asked twice; rank it last rather than dropping it (see pickFocalMembers).
  const focusedNames = new Set(
    focalCandidates.filter((entry) => entry.tier === 0).map((entry) => normIdent(entry.member)),
  );
  const focal = pickFocalMembers(focalCandidates.map((entry) =>
    entry.tier === 1 && focusedNames.has(normIdent(entry.member)) ? { ...entry, redundant: true } : entry
  ));
  if (focal.length === 0) return [];
  const allowTestPaths = queryMentionsTests(query);
  const selectedPaths = new Set(selected.map((candidate) => candidate.path));
  const ranked = focal.map((member) =>
    Date.now() >= deadline ? [] : callSitesForFocalMember(member, args, workspace, cache, allowTestPaths, deadline).sites
  );
  const additions: ImpactCandidate[] = [];
  const takenPaths = new Set<string>();
  let bytesUsed = 0;
  // Round-robin across focal members first, so two focal members contribute
  // one caller each before either contributes a second.
  const depth = Math.max(...ranked.map((sites) => sites.length), 0);
  for (let rank = 0; rank < depth && additions.length < MAX_CALLER_SURFACES; rank++) {
    for (const [index, sites] of ranked.entries()) {
      if (additions.length >= MAX_CALLER_SURFACES) break;
      const site = sites[rank];
      const member = focal[index];
      if (site === undefined || member === undefined) continue;
      if (selectedPaths.has(site.path) || takenPaths.has(site.path)) continue;
      const content = readCached(workspace, site.path, cache);
      if (content === undefined) continue;
      const lang = languageForPath(site.path);
      const parsed = (lang ? await cache.parsedSymbols(content, lang, site.path) : null) ?? [];
      const enclosing = parsed
        .filter((symbol) =>
          CALLER_EXPANSION_CALLABLE_KINDS.has(symbol.kind)
          && site.line >= symbol.startLine
          && site.line <= symbol.endLine
        )
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      const window = enclosing !== undefined
        ? { start: enclosing.startLine, end: enclosing.endLine }
        : boundedCallerWindow(site.line, countLines(content));
      // A THIN calling file is served WHOLE (measured 2026-09-20, live Copilot
      // session on the build carrying this mechanism): the handler window
      // alone answers "which method", but "which API endpoint" lives in the
      // class header the window cuts off — the base route on the type, the
      // injected field that proves the receiver, the imports. The model paid a
      // whole extra turn (~170 mAIU) re-reading the same 2.2 KB file as
      // `{handle, range:"1-80"}`, and one turn prices at roughly 9-14 KB of
      // served source. An entry layer is thin by construction, so whenever the
      // WHOLE file fits what is left of this mechanism's own allowance it is
      // strictly cheaper to ship it than to ship a window plus the follow-up.
      // Anything that does not fit keeps today's enclosing window.
      const wholeFile = { start: 1, end: countLines(content) };
      const wholeBytes = callerWindowEmbedBytes(content, site.path, wholeFile.start, wholeFile.end);
      const serveWhole = bytesUsed + wholeBytes <= MAX_CALLER_EXPANSION_BYTES;
      const served = serveWhole ? wholeFile : window;
      const bytes = serveWhole ? wholeBytes : callerWindowEmbedBytes(content, site.path, window.start, window.end);
      if (bytesUsed + bytes > MAX_CALLER_EXPANSION_BYTES) continue;
      bytesUsed += bytes;
      takenPaths.add(site.path);
      additions.push({
        path: site.path,
        // The CALL SITE, not the window head: `centeredSliceForCap` centers an
        // oversize body on `line`, and the call is the point of interest (same
        // choice recoverExplicitIdentifierAnswerCandidates makes for its own
        // enclosing-symbol candidates).
        line: site.line,
        range: `${served.start}-${served.end}`,
        surface: classifySurface(site.path),
        why: callerExpansionWhy(member),
        confidence: 0.9,
        // A whole-file serve carries NO symbol pin: `candidateToSurface`
        // re-points a symbol-pinned candidate at that symbol's own range,
        // which would silently undo the widening.
        ...(!serveWhole && enclosing !== undefined ? { symbol: enclosing.name } : {}),
      });
    }
  }
  return additions;
}
