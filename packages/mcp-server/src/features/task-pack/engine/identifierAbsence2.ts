// identifierAbsence — extracted implementation; imports point to the owning modules.
import * as fs from "fs";
import * as path from "path";
import type { EnumeratedQueryItem } from "./changeAndReadinessEvidence2.js";
import type { ExecutedSearchResult } from "../../../util/packServeLog.js";
import type { FindTextUniverse } from "../../search/find/findText.js";
import type { LiteralSeedPlan } from "../literalSeeds.js";
import type { RequestItem } from "../requestItems.js";
import type { ScanContentCache } from "../../search/find/findText.js";
import type { TaskPackResult } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { FileReadCache } from "./packBasics2.js";
import { GENERIC_SOFTWARE_ABSENCE_WORDS } from "./concernProof3.js";
import { IDENTIFIER_DEFINITION_KEYWORD_RE } from "./answerCandidates2.js";
import { anyWalkOmission } from "../../../tools/walkRepo.js";
import { boundedWorkspaceText } from "./seedAdmission.js";
import { cachedRequestItemPass } from "./requestItemAbsence2.js";
import { containsWholeIdentifier } from "../wholeIdentifier.js";
import { createScanContentCache } from "../../search/find/findText.js";
import { createScanCoverage } from "../../search/find/findText.js";
import { createWalkOmissions } from "../../../tools/walkRepo.js";
import { currentTraceCallId } from "../../../util/trace.js";
import { distinctiveLiteralsIn } from "../literalSeeds.js";
import { ensureAbsenceUniverse } from "./requestItemAbsence2.js";
import { enumerateFindTextUniverse } from "../../search/find/findText.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { isAuxiliaryTreePath } from "./queryIntent3.js";
import { isGenericJapaneseAbsenceTerm } from "../requestItems.js";
import { isPascalCaseIdentifier } from "./anchorFocus.js";
import { languageForPath } from "../../../util/languages.js";
import { literalFirstSeedsEnabled } from "../../../util/flags.js";
import { literalSeedPlan } from "../literalSeeds.js";
import { literalSourceRarityLimit } from "./packBasics2.js";
import { nearMissIdentifiersIn } from "../wholeIdentifier.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { queryNamedWorkspaceFilesKeepingSharedBasenames } from "./queryIntent3.js";
import { queryQualifiedSymbolKeys } from "./anchorFocus3.js";
import { readCached } from "./packBasics2.js";
import { requestItemPrewalkStorage } from "./requestItemAbsence2.js";
import { safeResolve } from "../../../util/safePath.js";
import { scanLiteral } from "../../search/find/findText.js";
import { scopeCompletenessAfterScan } from "./sourceAndConcernTerms3.js";
import { servedSurfaceText } from "./changeAndReadinessEvidence2.js";
import { stripPathSpans } from "../../../util/queryShape.js";
import { surfaceEvidencesSalientWord } from "./sourceAndConcernTerms3.js";
import { topicNounPhraseWords } from "../requestItems.js";
import { walkCodeFiles } from "../../../tools/walkRepo.js";
import { wholeIdentifierOffsets } from "../wholeIdentifier.js";
import { widenFindUniverseForAbsence } from "../../search/find/findText.js";

// ---------------------------------------------------------------------------
// WP-N (eval-0929 §8, 2026-09-29) — AN EXPLICIT IDENTIFIER THAT OCCURS ONLY
// INSIDE A LONGER IDENTIFIER IS ABSENT, AND ITS ABSENCE IS DISCLOSED.
//
// Measured (v0.14.4 and the working tree, byte-identical): "checkQuota の有効期限
// 判定を説明してください。MAX_QUOTA_UNITS の値も教えてください。" over a workspace whose
// only related text is `MAX_QUOTA_UNITS_V2` in two prose docs certified
// `act.answer` with `identifier:MAX_QUOTA_UNITS` and `request-item:facet-1:value`
// proved and NO gap. Two false arms: the seeded pack's verified-absence scan
// proved the identifier (true in whole-identifier terms, but nothing put the
// absence on the certificate — only the obligation's internal `reason` said
// so, and the wire never carries it), and the value facet resolved its focal
// through the identifier's own words ("quota" -> `checkQuota`) and certified
// checkQuota's body as the value.
//
// `explicitIdentifierAbsence` is the ONE verdict every absence writer now
// uses: no WHOLE-identifier occurrence (wholeIdentifier.ts) in the code
// universe, nor in the find universe widened for absence (docs, config,
// generic text — the same universe the request-item absence engine and
// `tl_search_files find` scan, so an absence here can never be contradicted by a
// find over the same workspace), and no file NAMED by it (the basename arm
// `exactIdentifierEvidence` trusts). Fails CLOSED: anything it cannot read
// makes the identifier "not proven absent", which keeps the obligation open —
// never a false absence.
// ---------------------------------------------------------------------------

/** Whole-identifier absence facts for one explicit identifier (see the section header above). */
export interface ExplicitIdentifierAbsence {
  /** The widened scan excluded nothing that could hold the name (`scopeCompletenessAfterScan`). */
  readonly scopeComplete: boolean;
  /** Excluded-path count backing an incomplete scope's wording; 0 when `scopeComplete`. */
  readonly omittedCount: number;
  /** Longer identifiers that merely contain the name (`X_V2`, `APP_X`) — advisory text only, never evidence. */
  readonly nearMisses: readonly string[];
}

/**
 * The whole-identifier absence facts of every identifier this pack found
 * absent, keyed by the result exactly like `verifiedAbsentIdentifiersByResult`
 * (same clone-loss behaviour). Deliberately a SEPARATE record: that map decides
 * whether the absence may PROVE `identifier:<X>` (its timing on the pathless
 * answer path is load-bearing — replay v0142a2a: the first pack prescribes the
 * confirming search), while this one only ever DISCLOSES — see
 * `identifierAbsenceDisclosures`.
 */
export const identifierAbsenceByResult = new WeakMap<object, ReadonlyMap<string, ExplicitIdentifierAbsence>>();

export function recordIdentifierAbsences(result: object, absences: ReadonlyMap<string, ExplicitIdentifierAbsence>): void {
  if (absences.size === 0) return;
  const merged = new Map(identifierAbsenceByResult.get(result) ?? []);
  for (const [identifier, absence] of absences) if (!merged.has(identifier)) merged.set(identifier, absence);
  identifierAbsenceByResult.set(result, merged);
}

/** Near-miss names kept per identifier (advisory only). */
export const MAX_NEAR_MISS_NAMES = 4;

/** `trimMatchText`'s clip marker (findText.ts). */
export const MATCH_TEXT_CLIP = "…";

/**
 * The first WHOLE-identifier offset of `identifier` on a `scanLiteral` hit's
 * line, with the text it is an offset into — or `undefined` when the line holds
 * the name only inside longer identifiers (or cannot be re-read). `match.text`
 * is a trimmed window centred on the line's FIRST substring occurrence, so it
 * is trusted when that occurrence is whole and not touching a clip marker (a
 * clip can fake a boundary); otherwise the FULL line decides (the window can
 * also cut a whole occurrence that follows a near-miss). No I/O in the common
 * case.
 */
export function wholeIdentifierOnHitLine(
  workspace: string,
  match: { path: string; line: number; text?: string },
  identifier: string,
  cache?: FileReadCache,
): { text: string; offset: number; firstIsWhole: boolean } | undefined {
  const text = match.text ?? "";
  const at = text.indexOf(identifier);
  if (at >= 0) {
    const touchesClip = (text.startsWith(MATCH_TEXT_CLIP) && at === MATCH_TEXT_CLIP.length)
      || (text.endsWith(MATCH_TEXT_CLIP) && at + identifier.length === text.length - MATCH_TEXT_CLIP.length);
    if (!touchesClip && wholeIdentifierOffsets(text, identifier)[0] === at) return { text, offset: at, firstIsWhole: true };
  }
  const line = readCached(workspace, match.path, cache)?.split(/\r?\n/)[match.line - 1];
  if (line === undefined) return undefined;
  const offset = wholeIdentifierOffsets(line, identifier)[0];
  if (offset === undefined) return undefined;
  return { text: line, offset, firstIsWhole: line.indexOf(identifier) === offset };
}

/**
 * Case-insensitive twin of `wholeIdentifierOnHitLine`, for a scan that matches
 * in any case (the request-item engine's): does the hit's line hold
 * `identifier` as a whole identifier? A whole occurrence inside the trimmed
 * window that does not touch a clip marker is conclusive; otherwise the FULL
 * line decides. An unreadable line is "no" — the hit then never becomes a
 * candidate, which is what a near-miss-only line also gets.
 */
export function hitLineHoldsWholeIdentifier(
  workspace: string,
  match: { path: string; line: number; text?: string },
  identifier: string,
  cache?: FileReadCache,
): boolean {
  const text = match.text ?? "";
  for (const at of wholeIdentifierOffsets(text, identifier, { caseInsensitive: true })) {
    const touchesClip = (text.startsWith(MATCH_TEXT_CLIP) && at === MATCH_TEXT_CLIP.length)
      || (text.endsWith(MATCH_TEXT_CLIP) && at + identifier.length === text.length - MATCH_TEXT_CLIP.length);
    if (!touchesClip) return true;
  }
  const line = readCached(workspace, match.path, cache)?.split(/\r?\n/)[match.line - 1];
  return line !== undefined && containsWholeIdentifier(line, identifier, { caseInsensitive: true });
}

/**
 * Classify `matches` (substring hits of `identifier`) by re-reading each hit's
 * FULL line — `scanLiteral`'s `text` is a trimmed window, which can cut a whole
 * occurrence that follows a near-miss on the same line. "whole" as soon as one
 * whole occurrence is seen; "unknowable" when a hit line cannot be re-read.
 */
export function classifyIdentifierHits(
  workspace: string,
  identifier: string,
  matches: ReadonlyArray<{ path: string; line: number; text?: string }>,
  nearMisses: string[],
  cache?: FileReadCache,
): "whole" | "unknowable" | "near-miss-only" {
  const linesByPath = new Map<string, readonly string[] | undefined>();
  for (const match of matches) {
    if (wholeIdentifierOnHitLine(workspace, match, identifier, cache) !== undefined) return "whole";
    if (!linesByPath.has(match.path)) linesByPath.set(match.path, readCached(workspace, match.path, cache)?.split(/\r?\n/));
    const line = linesByPath.get(match.path)?.[match.line - 1];
    if (line === undefined) return "unknowable";
    if (containsWholeIdentifier(line, identifier)) return "whole";
    for (const name of nearMissIdentifiersIn(line, identifier)) {
      if (nearMisses.length >= MAX_NEAR_MISS_NAMES) break;
      if (!nearMisses.includes(name)) nearMisses.push(name);
    }
  }
  return "near-miss-only";
}

/**
 * `undefined` = the identifier occurs as a whole identifier somewhere (or that
 * could not be ruled out); otherwise its absence facts. The code universe is
 * a fast path for the common case (the name exists in code); the widened
 * `absenceUniverse` — the authority for an absence — is built only when the
 * code holds no whole occurrence.
 */
export function explicitIdentifierAbsence(
  workspace: string,
  identifier: string,
  codeFiles: () => ReturnType<typeof walkCodeFiles>,
  absenceUniverse: () => FindTextUniverse | undefined,
  contentCache: ScanContentCache,
  cache?: FileReadCache,
): ExplicitIdentifierAbsence | undefined {
  const nearMisses: string[] = [];
  try {
    const codeHits = scanLiteral(identifier, workspace, { caseInsensitive: false, files: codeFiles(), contentCache });
    if (classifyIdentifierHits(workspace, identifier, codeHits, nearMisses, cache) !== "near-miss-only") return undefined;
    const universe = absenceUniverse();
    if (universe === undefined) return undefined;
    const named = normIdent(identifier);
    if (universe.files.some((file) => normIdent(path.basename(file.relPath, path.extname(file.relPath))) === named)) return undefined;
    const coverage = createScanCoverage();
    const hits = scanLiteral(identifier, workspace, { caseInsensitive: false, files: universe.files, contentCache, coverage });
    if (classifyIdentifierHits(workspace, identifier, hits, nearMisses, cache) !== "near-miss-only") return undefined;
    const { scopeComplete, omittedCount } = scopeCompletenessAfterScan(universe, coverage);
    return { scopeComplete, omittedCount, nearMisses };
  } catch {
    return undefined;
  }
}

/** `explicitIdentifierAbsence` for several identifiers over ONE lazily-built absence universe and one content cache. */
export function explicitIdentifierAbsences(
  workspace: string,
  identifiers: readonly string[],
  absenceUniverse: () => FindTextUniverse | undefined,
  cache?: FileReadCache,
): Map<string, ExplicitIdentifierAbsence> {
  const out = new Map<string, ExplicitIdentifierAbsence>();
  if (identifiers.length === 0) return out;
  let universe: FindTextUniverse | undefined;
  let built = false;
  const lazyUniverse = (): FindTextUniverse | undefined => {
    if (!built) {
      built = true;
      universe = absenceUniverse();
    }
    return universe;
  };
  let codeFiles: ReturnType<typeof walkCodeFiles> | undefined;
  const lazyCodeFiles = (): ReturnType<typeof walkCodeFiles> => (codeFiles ??= walkCodeFiles(workspace, {}));
  const contentCache = createScanContentCache();
  for (const identifier of identifiers) {
    if (out.has(identifier)) continue;
    const absence = explicitIdentifierAbsence(workspace, identifier, lazyCodeFiles, lazyUniverse, contentCache, cache);
    if (absence !== undefined) out.set(identifier, absence);
  }
  return out;
}

/** The find universe widened for absence, built from scratch (the pathless answer path has no request-item pass yet). */
export function freshAbsenceUniverse(workspace: string): FindTextUniverse | undefined {
  try {
    return widenFindUniverseForAbsence(workspace, enumerateFindTextUniverse(workspace));
  } catch {
    return undefined;
  }
}

/**
 * TL_LITERAL_FIRST_SEEDS (2026-11-03): the literal-first seed plan for a
 * pathless answer-profile `query` (literalSeeds.ts `literalSeedPlan`), over
 * the exact `action:"find"` universe — the composite-request prewalk's own
 * walk when this build made one (`requestItemPrewalkStorage`), else one
 * enumeration here — with this module's product/auxiliary classifier
 * (`isAuxiliaryTreePath`, the one `productPathsFirst` uses) and its rarity
 * limit (`literalSourceRarityLimit`). `undefined` when the request names no
 * distinctive literal, when the literal has no code-position hit, or when it
 * is spread over more files than the caps — every such request keeps today's
 * routing. A query that spells an existing workspace file is a stated target
 * (`queryNamedWorkspaceFilesKeepingSharedBasenames`, the same resolver the
 * answer builder seeds from) and keeps its routing too.
 */
export async function literalSeedPlanFor(query: string, workspace: string): Promise<LiteralSeedPlan | undefined> {
  if (!literalFirstSeedsEnabled()) return undefined;
  // The literal test is a regex over the query; the named-file resolver walks.
  if (distinctiveLiteralsIn(query).length === 0) return undefined;
  if (queryNamedWorkspaceFilesKeepingSharedBasenames(query, workspace).length > 0) return undefined;
  const prewalk = requestItemPrewalkStorage.getStore();
  let universe: FindTextUniverse;
  let contentCache: ScanContentCache | undefined;
  if (prewalk !== undefined) {
    universe = prewalk.universe;
    contentCache = prewalk.contentCache;
  } else {
    try {
      universe = enumerateFindTextUniverse(workspace);
    } catch {
      return undefined;
    }
  }
  return literalSeedPlan(query, workspace, {
    universe,
    ...(contentCache !== undefined ? { contentCache } : {}),
    isAuxiliaryTreePath,
    rarityLimit: literalSourceRarityLimit(universe.files.length),
  });
}

/** The same universe through a pack's own request-item pass (one walk per pack build, shared with the request-item engine). */
export function resultAbsenceUniverse(workspace: string, result: TaskPackResult): FindTextUniverse | undefined {
  const pass = cachedRequestItemPass(workspace, result);
  return pass === undefined ? undefined : ensureAbsenceUniverse(workspace, pass);
}

// ---------------------------------------------------------------------------
// WP-S5 (2026-09-20), TL_IDENTIFIER_GROUNDING — an ungrounded "identifier" must
// not send the caller on a relay loop.
// ---------------------------------------------------------------------------
//
// `explicitCodeIdentifiers` is a SHAPE oracle: it reads how a word is SPELLED,
// never what the workspace contains. That is the right input for RANKING, and
// the wrong one for minting a BLOCKING obligation, because the only recovery a
// blocking `identifier:<name>` has is a `find` for that name — a call this
// server can often predict will close nothing. Measured 2026-09-20 on the
// recommended `query: <verbatim request>` shape: "このリポジトリ(ShopFlow)で…"
// names the PRODUCT, `identifier:ShopFlow` blocked an otherwise complete pack,
// and following the pack's own `next` returned fuzzy neighbours
// (`ShopFlowApiClient`) whose re-pack served an unrelated file. Two model turns
// bought a WORSE task state. A stop-list (`PROSE_ACRONYMS`) closes vocabulary
// words like API/JSON/URL by name; it cannot generalize to product, repository
// or brand names, which is why this gate asks the workspace instead.
//
// GROUNDING is the missing half of the oracle, and it judges ONLY the shape
// that produced the defect: a BARE camelCase/PascalCase word. Every form in
// which the caller made the code intent EXPLICIT keeps its obligation on
// spelling alone — backticks, a qualified `A.b`/`A::b`/`A#b`, a call-shaped
// `name(`, or an `_`/`$` in the token — because there the caller has SAID this
// is code. A bare capitalised word has said only that it is capitalised.
// Parentheses are deliberately NOT such a form (`delimitedExplicitCodeIdentifiers`
// treats them as one for RANKING, which is a different question): "(X)" is
// ordinary prose apposition, and the measured defect wrote its product name in
// exactly that position.
//
// Nothing here is an absence CLAIM. A dropped obligation only stops the pack
// from owing evidence for the word and from prescribing a find for it; no wire
// field asserts it is missing, so the absence-honesty contract (a literal is
// certified absent only by a complete scan) is untouched — and indeed
// `ShopFlow` is NOT absent from that workspace, it simply defines nothing.
// Fail-closed everywhere else: an incomplete walk, an unreadable workspace, or
// any definition-shaped hit at all keeps today's obligation.

/** Languages whose files declare no symbols — a heading or a mapping key in one must never ground a name. */
export const NON_DECLARING_LANGUAGES: ReadonlySet<string> = new Set([
  "markdown", "html", "css", "json", "jsonc", "yaml", "toml",
]);

/** Grounding scans per pack. The explicit-identifier obligation loop already caps itself at six identifiers; this bounds the I/O to the same ceiling even when every one of them is uncovered. */
export const MAX_IDENTIFIER_GROUNDING_SCANS = 6;

/**
 * Test-only observability, same convention as `concernRecoveryEntryCount`
 * above: increments once per workspace scan `workspaceDefinesIdentifier`
 * actually performs. A spec asserts it stays 0 across a whole run with the flag
 * unset, which proves OFF-inertness DIRECTLY rather than only inferring it from
 * unchanged output bytes.
 */
export let identifierGroundingScanCountForTest = 0;

export function identifierGroundingScanCount(): number {
  return identifierGroundingScanCountForTest;
}

export function resetIdentifierGroundingScanCountForTest(): void {
  identifierGroundingScanCountForTest = 0;
}

/**
 * Per-pack grounding memo. `buildReadinessObligations` runs several times for
 * one pack (its own call site says so), so without this the same workspace walk
 * would repeat once per pass. Keyed by the result object exactly like
 * `verifiedAbsentIdentifiersByResult` above: a trim/dedupe clone simply loses
 * the memo and re-scans, and nothing survives into another pack.
 */
export interface IdentifierGroundingMemo {
  readonly verdicts: Map<string, boolean | undefined>;
  scans: number;
}

export const identifierGroundingByResult = new WeakMap<object, IdentifierGroundingMemo>();

/**
 * True when `identifier` is a BARE camelCase/PascalCase word in `query` — the
 * only shape this gate judges. Every explicit code form returns false and keeps
 * its obligation unconditionally; see this section's own doc block above.
 */
/** `queryQualifiedSymbolKeys`'s own `qualifier<NUL>member` joiner, built at runtime so this source file stays free of raw NUL bytes (the repo's `source_no_nul_bytes` doctor check). */
export const QUALIFIED_SYMBOL_KEY_SEPARATOR = String.fromCharCode(0);

export function identifierNeedsGrounding(query: string, identifier: string): boolean {
  if (identifier.includes("_") || identifier.includes("$")) return false;
  const camelOrPascal = isPascalCaseIdentifier(identifier)
    || /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(identifier);
  if (!camelOrPascal) return false;
  const key = normIdent(identifier);
  for (const match of query.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) {
    if (normIdent(match[1]!) === key) return false;
  }
  for (const qualified of queryQualifiedSymbolKeys(query)) {
    const [qualifier, member] = qualified.split(QUALIFIED_SYMBOL_KEY_SEPARATOR);
    if (normIdent(qualifier ?? "") === key || normIdent(member ?? "") === key) return false;
  }
  if (new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(identifier)}\\s*\\(`).test(query)) return false;
  return true;
}

/**
 * Does the workspace DEFINE `identifier`? `true` = at least one whole-word,
 * definition-shaped occurrence in a symbol-declaring source file; `false` = a
 * COMPLETE walk found none; `undefined` = undecidable, which keeps today's
 * behaviour.
 *
 * Reuses `recoverExplicitIdentifierAnswerCandidates`'s own literal scan and its
 * `IDENTIFIER_DEFINITION_KEYWORD_RE` test rather than building a second index.
 * Two deliberate narrowings versus that caller, both required here and not
 * there: the occurrence must be a WHOLE WORD (a substring hit inside
 * `class ShopFlowApiClient` must not ground `ShopFlow`), and it must sit in a
 * file of a symbol-declaring language (`ShopFlow: an order demo` in a README
 * otherwise reads as a binding).
 */
export function workspaceDefinesIdentifier(workspace: string, identifier: string): boolean | undefined {
  identifierGroundingScanCountForTest += 1;
  const omissions = createWalkOmissions();
  let matches: ReturnType<typeof scanLiteral>;
  try {
    matches = scanLiteral(identifier, workspace, { caseInsensitive: false, omissions });
  } catch {
    return undefined;
  }
  // An omitted path could hold the very declaration this asks about, so the
  // scan has not PROVED anything about it — same fail-closed rule the absence
  // provers in this file apply to their own universes.
  if (anyWalkOmission(omissions)) return undefined;
  for (const match of matches) {
    const language = languageForPath(match.path);
    if (language === undefined || NON_DECLARING_LANGUAGES.has(language)) continue;
    const text = match.text ?? "";
    for (let at = text.indexOf(identifier); at >= 0; at = text.indexOf(identifier, at + 1)) {
      const before = text.slice(0, at);
      const after = text.slice(at + identifier.length);
      if (/[A-Za-z0-9_$]$/.test(before) || /^[A-Za-z0-9_$]/.test(after)) continue;
      if (IDENTIFIER_DEFINITION_KEYWORD_RE.test(before) || /^\s*[=:]/.test(after)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WP-S5 (A) (TL_IDENTIFIER_GROUNDING, 2026-09-20): prose is not a literal
// obligation.
// ---------------------------------------------------------------------------
//
// The same defect one level out from the identifier gate above. A blocking
// obligation's only recovery is a call that looks for its wording in the
// workspace, so minting one for a plain natural-language word asks the server
// to go find "restoration", "numbers" or "read-only" in Java source. Measured
// on a live VS Code Copilot session: three such `enumerated-item:` obligations
// plus a `request-item` for "do not edit." held an otherwise complete pack at
// `discover` and produced a `next` that re-read TokenLighten's own guide files.
//
// The line is CODE SHAPE, not a vocabulary list: a phrase earns an obligation
// when the caller wrote it as code (backticked/quoted, an uppercase letter
// after the first character, a digit, `_`, `.`, `/`, `::`, `#`, `(`, or an
// ALL-CAPS token). `PAID, CANCELLED` keeps its obligation; `inventory
// restoration` does not. Everything filtered here remains a ranking token —
// `buildConcernRecoveryItems` and `requiredQueryFacets` are untouched — so the
// pack still PREFERS surfaces that mention it; it simply stops BLOCKING on it.
//
// Second half: a clause that constrains the ANSWER'S FORM or the AGENT'S
// BEHAVIOUR ("need exact file paths and line numbers", "read-only, do not
// edit", "簡潔に", "コードは変更しないで") asks nothing about the repository, so
// it is not an evidence point at all. It is recognized structurally — no
// code-shaped token AND a generic cue — and the two cue lists below are
// deliberately short, English+Japanese, and made of words that cannot name
// workspace code. A clause with ANY code shape is never classified this way, so
// "do not edit `OrderService`" keeps its obligation.

/** Paired quotes only: a lone apostrophe ("don't") is prose, not a quoted literal. */
export const QUOTED_LITERAL_SPAN_RE = /`[^`]+`|"[^"]+"|'[^']+'|「[^」]+」|『[^』]+』/u;

/** Characters that continue ONE code token around a facet — `order.quantity`, `Order::cancel`, `a/b.ts`. Whitespace and ordinary punctuation stop the expansion, so a neighbouring sentence can never glue itself on. */
export const CODE_TOKEN_CHAR_RE = /[A-Za-z0-9_$.#/:]/u;

/** Structural code shape — the one test both WP-S5 (A) gates share. */
export function phraseCarriesCodeShape(phrase: string): boolean {
  if (QUOTED_LITERAL_SPAN_RE.test(phrase)) return true;
  if (/\d/u.test(phrase)) return true;
  if (/[_/(]/u.test(phrase) || phrase.includes("::") || phrase.includes("#")) return true;
  if (/\.[A-Za-z]/u.test(phrase)) return true;
  if (/\b[A-Z][A-Z0-9]+\b/u.test(phrase)) return true;
  return /\b[A-Za-z][A-Za-z0-9]*[A-Z]/u.test(phrase);
}

/** Generic cues that a clause constrains how to ANSWER, EN + JA. None of these words can name workspace code. */
export const ANSWER_FORMAT_CUE_RE =
  /\b(?:concise|concisely|brief|briefly|bullet|bulleted|verbatim|cite|citation|summari[sz]e|summary)\b|\bfile\s*paths?\b|\bline\s*numbers?\b|簡潔|箇条書き|要約|ファイルパス|行番号/iu;

/**
 * Copilot retest r4 (2026-10-02): the citation phrasing agents actually write —
 * "Need source line numbers", "read relevant checkout source files", "give
 * line-numbered evidence", "quoting the exact lines", "show code snippets",
 * "list your sources", "point to exact locations". Multi-word on purpose: a lone
 * "source", "snippet" or "excerpt" can be a domain word (a CMS post excerpt), a
 * "source line" or a "code snippet" cannot. Read only by
 * `citationClauseNamesOnlyServedThings`, which also requires that the clause
 * names nothing unserved.
 */
export const CITATION_CUE_RE =
  /\b(?:with|add|include|give|list|provide)\s+(?:your\s+|the\s+|all\s+)?(?:citations?|sources|references|refs)\b|\bline[-\s]*(?:numbered|ranges?|refs?)\b|\b(?:source|code|file|line)\s+(?:lines?|files?|snippets?|excerpts?|locations?|references?|refs?)\b|\b(?:short|brief|relevant|exact)\s+(?:snippets?|excerpts?)\b|\bquot(?:e|ing)\s+(?:the\s+)?(?:exact\s+|relevant\s+)?lines?\b|\bname\s+(?:your|the|all)\s+(?:sources|files)\b|\bfiles\s+involved\b|\bread\s+(?:the\s+)?relevant\b|\b(?:print|show|give|quote|list|include)\s+(?:the\s+)?relevant\s+(?:source|code|lines?|files?|snippets?)\b|\bpoint\s+(?:to|out)\s+(?:the\s+)?(?:exact\s+|relevant\s+)?(?:locations?|lines?|code|source)\b|\bcitations?\s+(?:is\s+|are\s+)?(?:required|needed)\b|\brefer\s+to\s+(?:the\s+)?(?:code|source|files?|lines?)\b|\b(?:a|short|brief|quick|concise)\s+(?:summary|overview)\b|\bbullet\s+points\b/iu;

/**
 * Copilot retest r5 review (2026-10-03): ANSWER_FORMAT_CUE_RE without its bare
 * "citation" / "summary" — on their own those two can name a feature ("how the
 * summary is generated"), so inside a citation clause they count as a cue only
 * in CITATION_CUE_RE's phrase forms ("a brief summary", "with citations").
 */
export const CITATION_SKIP_ANSWER_FORMAT_CUE_RE =
  /\b(?:concise|concisely|brief|briefly|bullet|bulleted|bullets|verbatim|cite|cites|citing|summari[sz]e|summari[sz]ing)\b|\bfile\s*paths?\b|\bline\s*numbers?\b|簡潔|箇条書き|要約|ファイルパス|行番号/iu;

/**
 * The words a recognized citation/answer-form clause (one of the cues above,
 * no code shape) may spend without naming a point of the workspace: how to
 * cite ("source", "lines", "snippets", "evidence", "references"), the verbs
 * that ask for it ("cite", "quote", "give", "include", "point", "refer") and
 * the answer's form ("brief", "summary", "bullet", "points", "verbatim").
 * Read ONLY by `citationClauseNamesOnlyServedThings` — in any other clause each
 * of these keeps its ordinary meaning, so "how citations are formatted" in a
 * workspace without citations is still disclosed absent.
 */
export const CITATION_CLAUSE_WORDS: ReadonlySet<string> = new Set([
  "source", "sources", "line", "lines", "file", "files", "snippet", "snippets",
  "excerpt", "excerpts", "evidence", "citation", "citations", "number", "numbers",
  "numbered", "range", "ranges", "location", "locations", "reference", "references",
  "ref", "refs", "path", "paths", "name", "names",
  "cite", "cites", "citing", "quote", "quotes", "quoting", "read", "include",
  "includes", "point", "give", "show", "list", "provide", "print", "add",
  "attach", "refer", "mention",
  "brief", "briefly", "concise", "concisely", "verbatim", "summary", "summarize",
  "summarise", "overview", "bullet", "bulleted", "bullets", "points", "involved",
  "relevant", "exact", "short", "quick", "answer", "answers",
]);

/** Generic cues that a clause constrains what the AGENT may DO, EN + JA. */
export const AGENT_BEHAVIOUR_CUE_RE =
  /\bread[-\s]?only\b|\b(?:do|does)\s+not\s+(?:edit|change|modify|write|commit)\b|\bdon'?t\s+(?:edit|change|modify|write)\b|\bno\s+edits?\b|\bwithout\s+(?:editing|changing|modifying)\b|読み取り専用|変更しない|編集しない|書き換えない/iu;

/**
 * True when `text` only tells the agent HOW TO ANSWER or WHAT NOT TO DO. Both
 * conditions are required: a cue alone would misread "do not edit
 * `OrderService`" (which names code and is a real point), and the absence of
 * code shape alone would swallow ordinary prose questions.
 *
 * The brief's third condition — "no workspace-vocabulary noun beyond the
 * request's shared topic words" — is deliberately NOT implemented as a separate
 * vocabulary probe: it would add a workspace read per clause for a test the
 * code-shape half already answers for every case measured, and a wrong
 * vocabulary hit would be the one failure mode that silently drops a real
 * question. If a counterexample appears, add it here, not in the cue lists.
 */
export function isFormatOrBehaviourClause(text: string): boolean {
  if (phraseCarriesCodeShape(text)) return false;
  return ANSWER_FORMAT_CUE_RE.test(text) || AGENT_BEHAVIOUR_CUE_RE.test(text);
}

/**
 * Copilot retest r4 (2026-10-02) — the absence-only (all-topic) pass's test for
 * a clause that tells the agent how to cite or present the answer: an
 * answer-form or citation cue, no code shape, and every subject word it names
 * beyond the generic vocabulary and CITATION_CLAUSE_WORDS (source, lines,
 * snippets, cite, give, brief, ...) already served. Since the r5 review the
 * mixed-kind loop runs it too. "Need source line numbers" and
 * "read relevant checkout source files" (beside the served src/checkout/*) name
 * no point of their own, so they are neither certified absent nor disclosed
 * undetermined; "cite the refund ledger source lines" and "list the sources of
 * jitter" name something unserved and stay points, so a missing subject beside
 * a citation instruction is still disclosed.
 */
export function citationClauseNamesOnlyServedThings(rawText: string, priorEvidence: readonly TaskPackSurface[]): boolean {
  // r5 review: the splitter leaves a path's extension at the head of the next
  // clause ("... from config.ts? Give code snippets." -> ".ts? Give code
  // snippets."), and that `.ts` alone made the clause code-shaped.
  const text = rawText.replace(/^\s*\.[A-Za-z0-9]{1,6}\s*[?!.]*\s+/u, "");
  if (phraseCarriesCodeShape(text)) return false;
  if (!CITATION_SKIP_ANSWER_FORMAT_CUE_RE.test(text) && !CITATION_CUE_RE.test(text) && !AGENT_BEHAVIOUR_CUE_RE.test(text)) return false;
  const subjects = [...topicNounPhraseWords(text)].filter(
    (word) => !GENERIC_SOFTWARE_ABSENCE_WORDS.has(word) && !isGenericJapaneseAbsenceTerm(word) && !CITATION_CLAUSE_WORDS.has(word),
  );
  return subjects.every((word) => priorEvidence.some((surface) => surfaceEvidencesSalientWord(surface, word)));
}

/**
 * Copilot retest r5 review (2026-10-03): a citation/answer-form clause that
 * ALSO names something unserved ("list the sources of jitter") stays a point,
 * but its absence and coverage are judged on what it names — the
 * CITATION_CLAUSE_WORDS come out of the text those tests read, so the
 * disclosed term is `jitter`, not `sources`. Any other item (code shape, or no
 * citation/answer-form cue) is returned unchanged, so "how citations are
 * formatted" keeps `citations` as its subject.
 */
export function withoutCitationWords(item: RequestItem): RequestItem {
  const text = item.text.replace(/^\s*\.[A-Za-z0-9]{1,6}\s*[?!.]*\s+/u, "");
  if (phraseCarriesCodeShape(text)) return item;
  if (!CITATION_SKIP_ANSWER_FORMAT_CUE_RE.test(text) && !CITATION_CUE_RE.test(text)) return item;
  const reduced = text
    .replace(/[A-Za-z]+/gu, (word) => (CITATION_CLAUSE_WORDS.has(word.toLowerCase()) ? " " : word))
    .replace(/\s+/gu, " ")
    .trim();
  return reduced === "" || reduced === item.text ? item : { ...item, text: reduced };
}

/**
 * True when an enumerated item may mint a BLOCKING obligation: its own span in
 * the request carries code shape. Epoch-carried items (`start < 0`, replayed
 * from the stored task contract) have no span, so the item's facet is located
 * in the current request and judged in its original casing — never re-derived
 * from the lower-cased facet, which would read every item as prose.
 */
export function enumeratedItemCarriesCodeShape(query: string, item: EnumeratedQueryItem): boolean {
  const cleaned = stripPathSpans("", query);
  // The FACET's own occurrence, in its original casing — never the whole
  // segment. A LEADING segment is a sentence whose tail supplies the facet
  // ("Explain cancellation in OrderService: state transition"), so judging the
  // segment would let an unrelated identifier elsewhere in that sentence
  // certify a prose item as code.
  // Searched in the ORIGINAL request, not in `cleaned`: `stripPathSpans`
  // removes exactly the dotted/slashed forms (`order.quantity`) whose shape
  // this test is looking for. Any occurrence carrying code shape keeps the
  // obligation — the conservative direction.
  void cleaned;
  const facet = item.facet.toLowerCase();
  const haystack = query.toLowerCase();
  for (let at = haystack.indexOf(facet); at >= 0; at = haystack.indexOf(facet, at + 1)) {
    let from = at;
    while (from > 0 && CODE_TOKEN_CHAR_RE.test(query[from - 1]!)) from -= 1;
    let to = at + facet.length;
    while (to < query.length && CODE_TOKEN_CHAR_RE.test(query[to]!)) to += 1;
    const before = from > 0 ? query[from - 1]! : "";
    const after = query[to] ?? "";
    const quoted = (before === "`" && after === "`")
      || (before === "\"" && after === "\"")
      || (before === "'" && after === "'");
    if (quoted || phraseCarriesCodeShape(query.slice(from, to))) return true;
  }
  return false;
}

/** `workspaceDefinesIdentifier` === false for a member-only name, memoized like `identifierIsUngrounded`. */
export function memberReferenceIsUndefined(result: TaskPackResult, workspace: string | undefined, identifier: string): boolean {
  if (workspace === undefined) return false;
  let memo = identifierGroundingByResult.get(result);
  if (memo === undefined) {
    memo = { verdicts: new Map(), scans: 0 };
    identifierGroundingByResult.set(result, memo);
  }
  const key = identifier.toLowerCase();
  if (!memo.verdicts.has(key)) {
    if (memo.scans >= MAX_IDENTIFIER_GROUNDING_SCANS) return false;
    memo.scans += 1;
    memo.verdicts.set(key, workspaceDefinesIdentifier(workspace, identifier));
  }
  return memo.verdicts.get(key) === false;
}

/**
 * The gate `buildReadinessObligations` consults: true when this identifier must
 * NOT mint a blocking obligation. Every early return is the conservative one
 * (mint it), including the scan budget — a query that names seven unresolved
 * camel-case words keeps today's behaviour for the seventh rather than trading
 * honesty for I/O.
 */
export function identifierIsUngrounded(
  result: TaskPackResult,
  workspace: string | undefined,
  query: string,
  identifier: string,
): boolean {
  if (workspace === undefined) return false;
  if (!identifierNeedsGrounding(query, identifier)) return false;
  let memo = identifierGroundingByResult.get(result);
  if (memo === undefined) {
    memo = { verdicts: new Map(), scans: 0 };
    identifierGroundingByResult.set(result, memo);
  }
  const key = identifier.toLowerCase();
  if (!memo.verdicts.has(key)) {
    if (memo.scans >= MAX_IDENTIFIER_GROUNDING_SCANS) return false;
    memo.scans += 1;
    memo.verdicts.set(key, workspaceDefinesIdentifier(workspace, identifier));
  }
  return memo.verdicts.get(key) === false;
}

/**
 * R2-B14 (2026-09-13 review round 2): IS THIS RECORDED ABSENCE STILL TRUE?
 *
 * The hit half of the executed-search ledger is re-validated on every promotion
 * (`executedSearchHitSeeds` re-stats each hit). The absence half was not
 * re-validated at all — so a `find` that honestly proved a term absent kept
 * minting `explicit-gap:request-item-absent:<term> (… scope complete)` on a
 * CERTIFIED decision for the rest of the lane, including after the term's
 * declaring file appeared. The reported response served `src/quantum.ts 1-1`
 * (`export const quantumTeleportationMode = true;`) and certified that same
 * identifier absent, scope complete.
 *
 * Two independent staleness tests, either of which drops the record. Dropping is
 * always the safe direction: the obligation goes back to uncovered and the pack
 * re-proposes the search, which is what a caller can act on.
 *
 *  (a) THE TERM OCCURS IN A BODY THIS RESPONSE IS SERVING. A word-boundary scan
 *      of `servedSurfaceText` (the same reader P11C uses, so a demoted
 *      "see prior pack" surface is scanned as its real text) plus the surface's
 *      own anchor symbol. No I/O, and it makes "certify absent while serving the
 *      declaration" structurally impossible rather than merely unlikely.
 *      Deliberately NOT narrowed to code-bearing occurrences: the code-bearing
 *      rule exists to decide whether bytes may PROVE something, and here an
 *      occurrence of any kind is enough to withdraw a claim.
 *
 *  (b) A SERVED SURFACE IS YOUNGER THAN THE SCAN, AND ITS CURRENT TEXT CONTAINS
 *      THE TERM. `ExecutedSearchAbsence` carries `recordedAtMs`; a file whose
 *      mtime is strictly newer holds content the scan cannot have read. Skipped
 *      when the record predates that field (an older in-memory entry) — test (a)
 *      still runs, per its own contract.
 *
 *      SHOULD-FIX 27 (2026-09-14, review round 4): the mtime alone used to be
 *      the whole test, and it over-dropped on every UNRELATED edit — which is
 *      what an `act.edit` + verify task does to a served file as a matter of
 *      course. So the changed file is now re-read IN FULL (test (a) only sees the
 *      served slice) and the record survives unless the term actually occurs in
 *      it now. Fail-closed: an unreadable / undecodable / oversize changed file
 *      drops the record exactly as the bare witness did. Bounded by the hit
 *      scan's own ceiling and reached only when a record has `recordedAtMs` and a
 *      served file is younger — never on an ordinary pack.
 *
 * Residual (deliberate, and the reviewer's own structural chip): a file created
 * mid-task that this pack does NOT serve and does not touch is caught by neither
 * test. The general answer is "invalidate every ledger entry on any workspace
 * mutation since `sequence`", which needs a mutation clock this ledger does not
 * yet have.
 *
 * SHOULD-FIX 27: this predicate now has a SECOND reader —
 * `alternativeProgressAxis`' Rule 5 `alreadySearchedTerms` — so the rebuild that
 * withdraws a proof also re-proposes the find that would restore it. A stale
 * record neither certifies nor suppresses. Rule 5 applies it to ABSENCE records
 * only (see there).
 */
export function recordedAbsenceIsStale(
  workspace: string,
  result: TaskPackResult,
  entry: ExecutedSearchResult,
): boolean {
  const surfaces = result.surfaces ?? [];
  if (surfaces.length === 0) return false;
  const matcher = new RegExp(`\\b${entry.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (const surface of surfaces) {
    if (matcher.test(servedSurfaceText(surface))) return true;
    if (surface.symbol !== undefined && matcher.test(surface.symbol)) return true;
  }
  const recordedAtMs = entry.absence?.recordedAtMs;
  if (recordedAtMs === undefined) return false;
  const seen = new Set<string>();
  for (const surface of surfaces) {
    if (seen.has(surface.path)) continue;
    seen.add(surface.path);
    const abs = safeResolve(surface.path, workspace);
    if (abs === undefined) continue;
    let changed: boolean;
    try {
      changed = fs.statSync(abs).mtimeMs > recordedAtMs;
    } catch {
      // A surface whose file no longer stats is the pack's own problem, not this
      // absence's: stay silent and let the other tests decide.
      continue;
    }
    if (!changed) continue;
    // SHOULD-FIX 27 (2026-09-14, review round 4): ASK THE FILE, DON'T ASSUME.
    //
    // The mtime alone used to drop the record. It is a witness that the scan's
    // bytes are out of date, not that its CONCLUSION is — and an `act.edit` +
    // verify task edits a served file mid-flight as a matter of course, so the
    // common case was: append one unrelated comment line to `src/auth.ts`, and a
    // pair of genuinely-absent identifiers lost their honest gaps. Worse, the
    // same rebuild also suppressed the find that would restore them (Rule 5's
    // `alreadySearchedTerms`, now staleness-aware too), so the chain dead-ended
    // at `await_input:"no-grounded-call-remains"` with nothing asking for the
    // re-search.
    //
    // So the changed file is RE-READ IN FULL (not just its served slice, which
    // test (a) above already covers) and asked the only question that matters:
    // does the term occur in it NOW? If not, this file cannot have falsified the
    // absence and the record survives. Word-boundary, and deliberately NOT
    // code-bearing — same reasoning as test (a): an occurrence of ANY kind is
    // enough to WITHDRAW a claim, even though only a code-bearing one may PROVE
    // something (that asymmetry is SHOULD-FIX 29's subject, at the obligation
    // boundary).
    //
    // FAIL-CLOSED, so the precision never costs honesty: an unreadable,
    // undecodable or oversize changed file drops the record exactly as the bare
    // mtime witness did. Bounded by the same ceiling the hit scan uses, and
    // reached only when a record carries `recordedAtMs` AND a served file is
    // younger than it — i.e. never on an ordinary pack.
    const current = boundedWorkspaceText(workspace, surface.path);
    if (current === undefined) return true;
    if (matcher.test(current)) return true;
  }
  return false;
}

/** P2(b): dedupes the proof-completion engagement counter to one increment per pack — see buildTaskExecutionContract's own comment at the increment site. */
export const proofCompletionCountedResults = new WeakSet<object>();

/**
 * I-7 (2026-08-30 forensics attribution wave): dedupes `enumerated_obligation_summary`
 * to one emission per pack, the SAME pattern proofCompletionCountedResults
 * uses just above and for the same reason — buildReadinessObligations runs at
 * least twice per pack (the falsification probe's own preview call, then
 * buildTaskExecutionContract's real one, which itself can re-evaluate one
 * `result` up to four times), and a count of how many enumerated obligations
 * were minted must describe the PACK, not how many times this builder
 * happened to run over it.
 */
export const enumeratedObligationSummaryCountedResults = new WeakSet<object>();

/**
 * I-7: dedupes `receipt_next_repair` to one emission per TOOL CALL, not per
 * invocation of `receiptContractWithoutConsumedSearch`. Unlike the enumerated-
 * obligation summary above there is no stable `result` object to key a
 * WeakSet on here — `canServeCachedTaskPackReceipt`'s read-only preflight
 * (server.ts, `exactPreparedTaskPackReceipt`) calls the SAME
 * `tryServeCachedPack` chain the real serve path later calls again for one
 * logical tl_read_file request, each producing a byte-identical repair. Keyed
 * on `currentTraceCallId()` instead — call_id is monotonic and ALS-scoped
 * per tool call (util/trace.ts), so both invocations of one request share
 * one id and only the first is traced. Bounded FIFO: call_id keeps climbing
 * for the life of the process, so this evicts the oldest entry once the
 * (generously headroomed, concurrent-lane-safe) cap is exceeded rather than
 * growing unboundedly on a long-lived server.
 */
export const MAX_TRACED_RECEIPT_REPAIR_CALL_IDS = 32;

export const receiptRepairTracedCallIds = new Set<number>();

/** Test-only session reset: trace call ids restart with the counter (testing/sessionReset.ts). */
export function resetReceiptRepairTraceOnceForTest(): void {
  receiptRepairTracedCallIds.clear();
}

export function shouldTraceReceiptRepairOnce(): boolean {
  const callId = currentTraceCallId();
  // Outside any runWithTraceCall scope (e.g. a direct unit call in a spec) —
  // there is no shared id to dedupe against, so trace every time rather than
  // silently drop a call a test is directly asserting on.
  if (callId === undefined) return true;
  if (receiptRepairTracedCallIds.has(callId)) return false;
  receiptRepairTracedCallIds.add(callId);
  while (receiptRepairTracedCallIds.size > MAX_TRACED_RECEIPT_REPAIR_CALL_IDS) {
    const oldest = receiptRepairTracedCallIds.values().next().value as number | undefined;
    if (oldest === undefined) break;
    receiptRepairTracedCallIds.delete(oldest);
  }
  return true;
}
