// focalFlow — extracted implementation; imports point to the owning modules.
import * as path from "path";
import type { CallerFocalMember } from "../callerExpansion.js";
import type { CallerScanResult } from "./callerExpansion2.js";
import type { CallerSiteCandidate } from "../callerExpansion.js";
import type { NamedWindow } from "./callableResolution2.js";
import type { ResolvedFacetFocal } from "./callableResolution2.js";
import type { TaskPackArgs } from "../model.js";
import type { TaskPackSurface } from "../model.js";
import { CALLER_EXPANSION_CALLABLE_KINDS } from "./callerExpansion2.js";
import { CALLER_EXPANSION_DOC_PATH_RE } from "./callerExpansion2.js";
import { FileReadCache } from "./packBasics2.js";
import { MAX_CALLEES_PER_REQUIREMENT } from "../evidenceClosure.js";
import { MAX_FACET_CALLER_FILES_CLASSIFIED } from "./callerExpansion3.js";
import { analyzeJavaLoopGuards } from "../../../javaLoopGuardReview.js";
import { bindEnumStyleReviewOrigin } from "../../../enumStyleReview.js";
import { bindGoReviewOrigin } from "../../../goReturnedLocalReview.js";
import { bindJavaLoopGuardOrigin } from "../../../javaLoopGuardReview.js";
import { blockCommentLineStates } from "../callerExpansion.js";
import { cachedFileLines } from "./constantResolution2.js";
import { callSiteOccurrenceIsDeclaration } from "./callerExpansion2.js";
import { callSitesForFocalMember } from "./callerExpansion2.js";
import { declarationIsCallable } from "../evidenceClosure.js";
import { enumStyleReview } from "../../../enumStyleReview.js";
import { escapeRegExp } from "../../search/find/findText.js";
import { existingSiblingMembers } from "./contractReconciliation2.js";
import { extractEnumValueTokens } from "./createAndWiringEndpoints2.js";
import { facetCallerMentionScan } from "./callerExpansion3.js";
import { findCallOccurrences } from "../callerExpansion.js";
import { findModuleConstantWindow } from "../evidenceClosure.js";
import { goReturnedLocalReview } from "../../../goReturnedLocalReview.js";
import { hasHashComments } from "../callerExpansion.js";
import { isCallerMentionOnlyFile } from "./callerExpansion3.js";
import { isExactContiguousBody } from "../../../protocol/answerBodyPolicy.js";
import { isTestConcernPath } from "./literalAndConcernSeeds.js";
import { javaLoopGuardReview } from "../../../javaLoopGuardReview.js";
import { maskNonCode } from "../callerExpansion.js";
import { normIdent } from "./createAndWiringEndpoints2.js";
import { parseSurfaceSpan } from "./packState2.js";
import { rankCallSites } from "../callerExpansion.js";
import { readCached } from "./packBasics2.js";
import { resolveGoImports } from "../importResolveGo.js";
import { scanGoPackageSiblings } from "./constantResolution3.js";
import { scanLiteral } from "../../search/find/findText.js";
import { sharedPathPrefixSegments } from "../callerExpansion.js";
import { unclassifiedMentionLines } from "./callerExpansion2.js";
import { unqualifiedSymbolTail } from "./anchorFocus3.js";

/**
 * Caller sites of a plain top-level FUNCTION (no real enclosing type) --
 * see this section's own header comment for why `callSitesForFocalMember`'s
 * receiver-strength gate cannot see a bare call's only textual link (an
 * import specifier string, masked). Mirrors `callSitesForFocalMember`
 * except every call-shaped, non-declaration occurrence counts (a plain
 * top-level name has no cross-TYPE ambiguity a receiver could resolve).
 *
 * P2-15 (eval-0927 review-r4 #15, sameNameTwoDeclsBothCalled): strength is
 * NOT fixed at 2 for every occurrence. A plain function's own canonical
 * call form is BARE (no receiver) -- `orderService.cancel(id)` calls some
 * OBJECT's `cancel` member, never the free-standing `cancel` function of
 * the same name, even though this scan (by construction, scanning for the
 * bare name only) still finds the line. Grading a qualified occurrence at
 * strength 1 (matching `receiverStrength`'s own "weak" tier) rather than 2
 * keeps it as a real, RECORDED site (recall is not sacrificed — a genuine
 * namespace-qualified re-export call, `utils.fetchWithRetry(url)`, still
 * counts) while letting the plan-entry assembly (readCodeTaskPack.ts,
 * `recoverFacetClosureCandidates`) tell a clean, unambiguous fan-in (every
 * site strength 2) apart from one MIXED with sites that could just as
 * easily belong to a different, same-named declaration elsewhere, and word
 * its disclosure accordingly rather than presenting both as one clean count.
 *
 * Exported only for `facetClosureTimingIndependence.spec.ts` (FIX-FAB item
 * 11) — see `callSitesForFocalMember`'s own export note.
 */
export function plainFunctionCallerSites(
  member: string,
  focalPath: string,
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
  allowTestPaths: boolean,
  deadline: number,
): CallerScanResult {
  let scanned: ReturnType<typeof scanLiteral>;
  try {
    scanned = facetCallerMentionScan(member, workspace, args);
  } catch {
    return { sites: [], complete: true };
  }
  const linesByPath = new Map<string, number[]>();
  for (const match of scanned) {
    if (match.path === focalPath) continue;
    if (!allowTestPaths && isTestConcernPath(match.path)) continue;
    if (CALLER_EXPANSION_DOC_PATH_RE.test(match.path)) continue;
    const existing = linesByPath.get(match.path);
    if (existing) existing.push(match.line);
    else linesByPath.set(match.path, [match.line]);
  }
  const filesCapped = linesByPath.size > MAX_FACET_CALLER_FILES_CLASSIFIED; // P1-7: see CallerScanResult.filesCapped's own doc
  const paths = [...linesByPath.keys()].sort((a, b) =>
    sharedPathPrefixSegments(b, focalPath) - sharedPathPrefixSegments(a, focalPath) || a.localeCompare(b)
  ).slice(0, MAX_FACET_CALLER_FILES_CLASSIFIED);
  const sites: CallerSiteCandidate[] = [];
  // R6-A (eval-0927 review-r5 P2-6): see `callSitesForFocalMember`'s own
  // `declarationLineKeys` doc — the identical merge, for the plain-function
  // scan.
  const declarationLineKeys = new Set<string>();
  let examined = 0;
  for (const relPath of paths) {
    if (Date.now() >= deadline) break;
    examined += 1;
    // A3 (eval-0927 review-r6 P1-5): see `callSitesForFocalMember`'s own
    // `isCallerMentionOnlyFile` hookup — the identical skip, for the
    // plain-function scan.
    if (isCallerMentionOnlyFile(relPath)) continue;
    const content = readCached(workspace, relPath, cache);
    if (content === undefined) continue;
    const hashComment = hasHashComments(relPath);
    const lines = content.split(/\r?\n/);
    // A4 (eval-0927 review-r6 P1-6/P2-11 class): see `callSitesForFocalMember`'s
    // own `commentState` doc — the identical confident/masked/codeFrom
    // split, for the plain-function scan.
    const commentState = blockCommentLineStates(lines, relPath);
    const candidateLines = (linesByPath.get(relPath) ?? []).filter((line) => commentState.confident[line - 1] !== true);
    linesByPath.set(relPath, candidateLines);
    const inFile: Array<{ line: number; strength: 1 | 2 }> = [];
    for (const line of candidateLines) {
      const codeFrom = commentState.codeFrom[line - 1];
      if (commentState.masked[line - 1] === true && codeFrom === undefined) continue;
      const rawText = lines[line - 1];
      if (rawText === undefined) continue;
      const text = codeFrom !== undefined ? " ".repeat(codeFrom) + rawText.slice(codeFrom) : rawText;
      const masked = maskNonCode(text, hashComment, relPath);
      for (const occurrence of findCallOccurrences(masked, member)) {
        if (callSiteOccurrenceIsDeclaration(occurrence, masked, relPath, lines, line, hashComment)) {
          declarationLineKeys.add(`${relPath}#${line}`);
          continue;
        }
        inFile.push({ line, strength: occurrence.qualifier === "bare" ? 2 : 1 });
        break;
      }
    }
    for (const site of inFile) {
      sites.push({ path: relPath, line: site.line, strength: site.strength, callsInFile: inFile.length, proximity: sharedPathPrefixSegments(relPath, focalPath) });
    }
  }
  // MENTION GUARD (R5-A1): see `callSitesForFocalMember`'s own hookup.
  const recordedKeys = new Set([...sites.map((site) => `${site.path}#${site.line}`), ...declarationLineKeys]);
  const { lines: unclassifiedMentions, capped: unclassifiedMentionsCapped } =
    unclassifiedMentionLines(member, paths, linesByPath, recordedKeys, workspace, cache);
  return {
    sites: rankCallSites(sites),
    complete: examined === paths.length,
    ...(filesCapped ? { filesCapped } : {}),
    ...(unclassifiedMentions.length > 0 ? { unclassifiedMentions } : {}),
    ...(unclassifiedMentionsCapped ? { unclassifiedMentionsCapped: true } : {}),
  };
}

/**
 * P0-2 (R7-A, eval-0927 review-r6 finding 2, defaultExportedDeclCaller):
 * `member`'s own declaration STATEMENT is written as its module's default
 * export — `export default [async] function member`, `export default
 * [abstract] class member`, CJS `module.exports = [async] function member` /
 * `= class member`. Every importer of this module then binds the value under
 * a name of ITS OWN CHOOSING (`import fmt from "./format"`, `const foo =
 * require("./format")`) — invisible to a by-NAME call-site scan, which can
 * only ever find `member(`. Checked only against the declaration's own
 * header (`startLine`, and the line right before it, for the rarer split
 * `export default\nfunction member() {}`) — deliberately never a general
 * file-wide scan for a SEPARATE `module.exports = member;` line naming an
 * already-declared function elsewhere: that shape is not this focal's own
 * declaration, and stays an ordinary unclassified mention instead (the
 * existing MENTION GUARD already keeps that case out of `empty` with no help
 * from this check, since none of `mentionExplainedByImportExportLine`'s
 * shapes match a bare `module.exports = member;`/`export default member;`
 * reference either).
 *
 * A1 (eval-0927 review-r8/r9 round 9, defaultExportedGeneratorCaller): the
 * `function` alternative also accepts an optional `*` (any spacing —
 * `function* g`, `function *g`, `function * g`) for a generator's own
 * default export (`export default function* rootSaga() {}`, a common
 * redux-saga/async-generator shape) — `class` never takes one, so that
 * branch stays bare.
 */
export const DEFAULT_EXPORT_DECL_RE = /^\s*export\s+default\s+(?:@[\w$.]+(?:\([^)]*\))?\s+)*(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)\b/;

export const CJS_DEFAULT_EXPORT_DECL_RE = /^\s*module\.exports\s*=\s*(?:async\s+)?(?:function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)\b/;

/** The bare declaration head with no `export default`/`module.exports =` prefix — the SECOND line of a split `export default\nfunction member() {}` statement. */
export const BARE_DECL_HEAD_RE = /^\s*(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)\b/;

/** A line that is, trimmed, nothing but `export default` — the FIRST line of that same split statement. */
export const DEFAULT_EXPORT_BARE_PREFIX_RE = /^\s*export\s+default\s*$/;

/**
 * A1 (R8-A, eval-0927 review-r7 P0-1, defaultExportedDeclCallerJsdoc/
 * defaultExportedClassDecoratorCaller). The resolved focal's own `startLine`
 * is the SYMBOL's range start, which a leading doc comment or decorator/
 * attribute pushes ahead of the declaration's own header line (the parser
 * attaches leading trivia to the symbol it documents) -- the two-line check
 * below (`header - 1`/`header`) only ever finds the real header when nothing
 * precedes it on the focal's own range. `declarationHeaderLine` walks forward
 * from `startLine`, skipping blank lines, `/** … *\/`/`/* … *\/` block
 * comments (single- or multi-line), `///`/`//` line comments, `#` line
 * comments (never a leading `#[` attribute), `@decorator(...)` (possibly
 * spanning several lines via unbalanced `(`/`[`), and `[Attribute]`
 * annotations, to the first real code line -- bounded ONLY at `endLine` (a
 * doc comment must never walk into an unrelated declaration below the
 * focal's own range) and the file's own last line. `endLine` is an optional
 * trailing parameter (default `lines.length`) so the pre-existing 3-arg
 * pure-unit-test surface (`classprobe7.mts`'s own `focalIsSoleDefaultExport`
 * rows, `evaluation0927.r7aFalseEmptyGuard.spec.ts`) keeps working unchanged;
 * the real caller (`callerSitesForFocal`, below) passes the focal's own
 * `endLine`.
 *
 * A1 (eval-0927 review-r8/r9 round 9, defaultExportedLongJsdocCaller): this
 * walk USED to also cap itself at a flat 40 lines past `startLine`
 * (`DECLARATION_HEADER_SEARCH_BOUND`, now removed) regardless of how much
 * further `endLine` allowed -- a JSDoc block longer than that (a `@example`
 * per reviewer, per parameter, ...) hit the cap before ever reaching its own
 * `*\/` closer, so `declarationHeaderLine` returned `undefined` and the
 * caller had no header text to test at all. A doc comment of ANY length is
 * now skippable, bounded only by the focal's own recorded `endLine` (never
 * past it, so a giant doc comment still cannot walk into an unrelated
 * declaration below the focal's own range) -- see `focalIsSoleDefaultExport`
 * for what happens when the walk still finds nothing within that bound.
 */

/** Bounded forward walk past a (possibly multi-line) `@decorator(...)`/`[Attribute]` -- returns the 1-based line right after it, capped at `limit`. String-aware (A1, eval-0927 review-r8/r9 round 9, pure row decorator-paren-in-string): a `(`/`[`/`)`/`]` INSIDE a quoted string argument (`@Foo(")")`) is not a real paren/bracket and must never be balanced against the decorator's own argument list -- only quote-aware scanning (with `\`-escape skipped, mirroring every other string scan in this codebase) tells the two apart. */
export function skipAnnotationLines(lines: readonly string[], from: number, limit: number): number {
  let depth = 0;
  let line = from;
  let quote: string | undefined;
  do {
    const text = lines[line - 1] ?? "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (quote !== undefined) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
    line++;
  } while (depth > 0 && line <= limit);
  return line;
}

/** See `focalIsSoleDefaultExport`'s own A1 doc above. Returns `undefined` when no code line was found within bound (the caller then treats this as UNPROVEN, never as proof of a non-default export -- see `focalIsSoleDefaultExport`). */
export function declarationHeaderLine(lines: readonly string[], startLine: number, endLine: number): number | undefined {
  const limit = Math.min(endLine, lines.length);
  let i = startLine;
  while (i <= limit) {
    const text = lines[i - 1];
    if (text === undefined) return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) { i++; continue; }
    if (trimmed.startsWith("/*")) {
      // Scan forward (possibly from THIS same line) for the closer `*/`;
      // code trailing the closer on its own line becomes the header itself
      // rather than being skipped past. Further comments on the closer's
      // line (`/* a */ /* b */`, `*/ // note`) are trivia too: a line with no
      // code left is never the header (round-9 review P1-3).
      let j = i;
      let rest = trimmed;
      let from = 2;
      for (;;) {
        let closeAt = rest.indexOf("*/", from);
        while (closeAt < 0 && j < limit) {
          j++;
          rest = lines[j - 1] ?? "";
          closeAt = rest.indexOf("*/");
        }
        if (closeAt < 0) return undefined;
        rest = rest.slice(closeAt + 2).trim();
        if (!rest.startsWith("/*")) break;
        from = 2;
      }
      if (rest.length > 0 && !rest.startsWith("//")) return j;
      i = j + 1;
      continue;
    }
    if (trimmed.startsWith("///") || trimmed.startsWith("//")) { i++; continue; }
    if (trimmed.startsWith("#[")) { i = skipAnnotationLines(lines, i, limit); continue; }
    if (trimmed.startsWith("#")) { i++; continue; }
    if (trimmed.startsWith("@")) { i = skipAnnotationLines(lines, i, limit); continue; }
    if (/^\[[A-Za-z_]/.test(trimmed)) { i = skipAnnotationLines(lines, i, limit); continue; }
    return i;
  }
  return undefined;
}

/**
 * A1 (eval-0927 review-r8/r9 round 9; round-9 review P1-3): the header line's
 * own code after any leading comment text — a doc comment's closer with or
 * without text before it (`*\/ export default …`, ` * end *\/ export default
 * …`) and complete block comments on the same line (`/* istanbul ignore
 * next *\/ export default function f() {}`). Callers test BOTH this and the raw
 * line, so a `*\/` inside a string on an ordinary header can never hide a match;
 * a spurious match only ever makes the focal "possibly default-exported"
 * (undetermined), never proves it is not.
 */
export function afterLeadingBlockCommentCloser(text: string): string {
  let rest = text.trimStart();
  const closer = rest.indexOf("*/");
  const opener = rest.indexOf("/*");
  if (closer >= 0 && (opener < 0 || opener > closer)) rest = rest.slice(closer + 2).trimStart();
  while (rest.startsWith("/*")) {
    const end = rest.indexOf("*/", 2);
    if (end < 0) break;
    rest = rest.slice(end + 2).trimStart();
  }
  return rest;
}

/** Exported only for `evaluation0927.r7aFalseEmptyGuard.spec.ts`. */
export function focalIsSoleDefaultExport(lines: readonly string[], startLine: number, member: string, endLine: number = lines.length): boolean {
  const header = declarationHeaderLine(lines, startLine, endLine);
  // A1 (eval-0927 review-r8/r9 round 9): the walk could not resolve a real
  // code line within the focal's own range at all (an exotic leading-trivia
  // shape, or content past what this bounded scan can parse) -- that is NOT
  // proof the declaration is some other shape. The old `?? startLine`
  // fallback tested the TRIVIA line itself (almost never a match), so an
  // unresolved header silently read as "not a default export" and could
  // certify a false `request-item-empty:callers`. Fail toward the safe
  // direction instead: never resolved, never proven NON-default.
  if (header === undefined) return true;
  for (const lineNo of [header - 1, header]) {
    const text = lines[lineNo - 1];
    if (text === undefined) continue;
    for (const codeText of [text, afterLeadingBlockCommentCloser(text)]) {
      const match = DEFAULT_EXPORT_DECL_RE.exec(codeText) ?? CJS_DEFAULT_EXPORT_DECL_RE.exec(codeText);
      if (match !== null && match[1] === member) return true;
    }
  }
  // The rarer split form: `export default` alone on the line right before
  // the declaration's own bare head (`function`/`class` never sees an
  // `export default` prefix on ITS line at all, so neither regex above ever
  // matches either line of this shape on its own).
  const prevText = lines[header - 2];
  const ownText = lines[header - 1];
  if (prevText !== undefined && ownText !== undefined && DEFAULT_EXPORT_BARE_PREFIX_RE.test(prevText)) {
    const bare = BARE_DECL_HEAD_RE.exec(ownText) ?? BARE_DECL_HEAD_RE.exec(afterLeadingBlockCommentCloser(ownText));
    if (bare !== null && bare[1] === member) return true;
  }
  return false;
}

export async function callerSitesForFocal(
  focal: ResolvedFacetFocal,
  args: TaskPackArgs,
  workspace: string,
  cache: FileReadCache,
  allowTestPaths: boolean,
  deadline: number,
): Promise<CallerScanResult> {
  const focalMember: CallerFocalMember = { path: focal.path, typeName: focal.typeName, member: focal.name };
  const result = focal.hasRealType
    ? callSitesForFocalMember(focalMember, args, workspace, cache, allowTestPaths, deadline)
    : plainFunctionCallerSites(focal.name, focal.path, args, workspace, cache, allowTestPaths, deadline);
  const focalContent = readCached(workspace, focal.path, cache);
  const defaultExported = focalContent !== undefined
    && focalIsSoleDefaultExport(focalContent.split(/\r?\n/), focal.startLine, focal.name, focal.endLine);
  return defaultExported ? { ...result, focalDefaultExported: true } : result;
}

/** FIX-FAB item 7 (eval-0927 review #11, flowEn): how many callee layers `calleeDefinitionsForFocal` expands transitively -- 1 = the focal's own direct callees (the old bound); 2 additionally expands each of THOSE callees' own direct callees ("which functions run and in what order" needs the layer the served callee itself calls, e.g. `shouldRetry`/`backoffDelay` behind a one-hop-served handler -- reproduced live, never served before this fix, no gap disclosing the cut). */
export const MAX_FLOW_CALLEE_DEPTH = 2;

/**
 * `flow`'s "definitions of the focal body's direct in-workspace callees" --
 * the SAME one-hop resolution `constantClosureForFocal` uses, but returning
 * each callee's own full definition window instead of scanning inside it
 * for constants. Recurses up to MAX_FLOW_CALLEE_DEPTH layers (item 7):
 * `visited` is shared across the recursion and keyed by the caller's focal
 * range plus callee name. Sibling scopes can bind the same member name to
 * different receiver types, while repeated traversal of one call site stops.
 *
 * Copilot retest (2026-10-02): EVERY direct callee is returned, up to the
 * MAX_SCANNED_CALLEE_NAMES / MAX_REQUIRED_CALLEE_WINDOWS ceilings, for flow
 * and now also for value/condition (what a callable returns or decides is
 * computed by its callees). MAX_CALLEES_PER_REQUIREMENT bounds only which of
 * them get the deeper layer -- the same leading names the old cut kept. The
 * direct list used to be cut at that bound with nothing recording the cut,
 * so the gate required -- and certified -- a hub's first three callees only.
 * `complete` is false exactly when a ceiling cut the direct list.
 */
/** At most this many dependency windows ride an auto-located edit pack. */
export const MAX_EDIT_CONTEXT_WINDOWS = 6;

/** Caller-named targets (or directory scopes) up to this many still receive edit context. */
export const MAX_EDIT_CONTEXT_CALLER_TARGETS = 1;

/** Their combined source bytes (a window the cap would split is skipped, never cut). */
export const MAX_EDIT_CONTEXT_BYTES = 6_000;

/**
 * A dependency file is served whole when that adds at most this many bytes to
 * the declarations the edit needs from it: any file this small, and a larger
 * one those declarations already mostly cover.
 */
export const EDIT_CONTEXT_WHOLE_FILE_BYTES = 1_600;

/** A single dependency window larger than this is left to the caller. */
export const EDIT_CONTEXT_MAX_WINDOW_BYTES = 2_000;

/** The `why` prefix of every edit-context surface; the change contract keeps them review-only. */
export const EDIT_CONTEXT_WHY = "edit-context";

/**
 * 2026-10-16 bench (F1, the T07 ledgerd credit-normal fix): an edit target
 * the server located itself was certified `act.edit` with nothing but its
 * own file, so the caller then had to find what the change depends on
 * (`Balance.Apply`, the account side constants) one call at a time — on
 * Copilot CLI 11.5 requests against native's 6.5. This serves those
 * definitions with the target: the bodies of the callables the focal calls
 * and the constants it reads, one hop, through the same resolvers the
 * answer closure uses (`calleeDefinitionsForFocal`, `constantClosureForFocal`,
 * Go import resolution included). A window in a small file is widened to
 * the whole file, which carries a type's sibling methods for the price of a
 * few lines. Bounded by MAX_EDIT_CONTEXT_WINDOWS / MAX_EDIT_CONTEXT_BYTES;
 * the focal is only a callable the request names explicitly (or the
 * surface's own symbol), never a guess.
 *
 * 2026-10-20 (decision runs 6t-4 to 6t-7, T07 arm A): those windows were a
 * definition's code lines alone, and the solver re-read the files they were
 * cut from in every window (6t-7 rep1: balance.go, posting.go and money.go
 * whole, 10,789 B, the call right after the 10,297 B pack, at 61,989 cached
 * context tokens). The fix needed what the slices lacked: `Balance`'s doc on
 * Net's sign (Compute's result type, same package, not served at all),
 * `posting.Side` with DebitSide/CreditSide (a conversion, `posting.Side(…)`,
 * which the qualified rule skipped as a call) and `Money.Sub` (a method
 * called on a field, which no import names). So a window is now a whole
 * declaration (with its `//` doc comment, and an enum-like Go type with its
 * const block), the focal's own package types and the methods it calls on
 * values are among them (`goPackageTypeWindows`, `goCalledMethodWindows`),
 * and a file is served whole when that adds at most
 * EDIT_CONTEXT_WHOLE_FILE_BYTES to the declarations the edit needs from it
 * (`editContextCandidates`).
 */
/**
 * Go: the constants, variables and types the focal names through one of its
 * file's imports (`account.DebitNormal`, `posting.Side`), resolved to the
 * declaring file by the import graph (importResolveGo.ts). Functions are the
 * callee closure's, so a call-shaped use counts only as a conversion to a
 * type (`posting.Side(x)`); the constant closure only searches the focal's
 * own package.
 */
export async function goQualifiedDeclarationWindows(focal: ResolvedFacetFocal, workspace: string, cache: FileReadCache): Promise<NamedWindow[]> {
  if (path.extname(focal.path) !== ".go") return [];
  const content = readCached(workspace, focal.path, cache);
  if (content === undefined) return [];
  const lines = content.split(/\r?\n/);
  const body = lines.slice(focal.startLine - 1, focal.endLine).map((line) => maskNonCode(line, false)).join("\n");
  const out: NamedWindow[] = [];
  for (const edge of resolveGoImports(workspace, focal.path, lines)) {
    const [qualifier, ...declared] = edge.names;
    if (edge.kind !== "import" || qualifier === undefined) continue;
    for (const name of declared) {
      const uses = [...body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(qualifier)}\\s*\\.\\s*${escapeRegExp(name)}\\b(\\s*\\()?`, "g"))];
      if (uses.length === 0) continue;
      const asValue = uses.some((use) => use[1] === undefined);
      const target = readCached(workspace, edge.path, cache);
      if (target === undefined) continue;
      const targetLines = cachedFileLines(cache, edge.path, target);
      const constant = asValue ? findModuleConstantWindow(targetLines, name, false) : undefined;
      if (constant !== undefined) {
        out.push({ path: edge.path, start: constant.start, end: constant.end, name });
        continue;
      }
      const symbol = ((await cache.parsedSymbols(target, "go", edge.path)) ?? [])
        .find((entry) => unqualifiedSymbolTail(entry.name) === name && (asValue || entry.kind === "type"));
      if (symbol !== undefined) out.push({ path: edge.path, start: symbol.startLine, end: symbol.endLine, name });
    }
  }
  return out;
}

/**
 * Go: the types of the focal's own package it names unqualified — its
 * `Balance` result, a `Balance{…}` literal, a `T(x)` conversion — at their
 * declarations. Qualified ones are goQualifiedDeclarationWindows'.
 */
export async function goPackageTypeWindows(focal: ResolvedFacetFocal, workspace: string, cache: FileReadCache): Promise<NamedWindow[]> {
  if (path.extname(focal.path) !== ".go") return [];
  const content = readCached(workspace, focal.path, cache);
  if (content === undefined) return [];
  const body = cachedFileLines(cache, focal.path, content).slice(focal.startLine - 1, focal.endLine)
    .map((line) => maskNonCode(line, false)).join("\n");
  const named = new Set([...body.matchAll(/(?<![\w$.])[A-Za-z_]\w*/g)].map((match) => match[0]));
  const files = [{ path: focal.path, content }];
  scanGoPackageSiblings(focal.path, workspace, cache, (relPath, text) => {
    files.push({ path: relPath, content: text });
    return undefined;
  }, { mightMatch: (text) => /^type\s/m.test(text) });
  const out: NamedWindow[] = [];
  for (const file of files) {
    for (const symbol of (await cache.parsedSymbols(file.content, "go", file.path)) ?? []) {
      const name = unqualifiedSymbolTail(symbol.name);
      // The first declaration wins: `delete` is true only while the name is still wanted.
      if (symbol.kind === "type" && named.delete(name)) out.push({ path: file.path, start: symbol.startLine, end: symbol.endLine, name });
    }
  }
  return out;
}

/**
 * Go: the methods the focal calls on values (`b.Debit.Sub(…)`) that the
 * callee closure left unresolved — a member call names no import — each at
 * its one declaration on a type the focal handles (one its code names, or a
 * field type of a declaration in `typeWindows`: `Balance.Debit` is a
 * `money.Money`), across the focal's package and the packages its file
 * imports. A method name declared on two such types (`String`) stays out:
 * telling the receivers apart takes types this scan does not have.
 */
export async function goCalledMethodWindows(
  focal: ResolvedFacetFocal,
  workspace: string,
  cache: FileReadCache,
  resolved: ReadonlySet<string>,
  typeWindows: readonly NamedWindow[],
): Promise<NamedWindow[]> {
  if (path.extname(focal.path) !== ".go") return [];
  const content = readCached(workspace, focal.path, cache);
  if (content === undefined) return [];
  const lines = cachedFileLines(cache, focal.path, content);
  const body = lines.slice(focal.startLine - 1, focal.endLine).map((line) => maskNonCode(line, false)).join("\n");
  const called = new Set([...body.matchAll(/\.\s*([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]!).filter((name) => !resolved.has(name)));
  if (called.size === 0) return [];
  const handled = new Set([...body.matchAll(/[A-Za-z_]\w*/g)].map((match) => match[0]));
  for (const window of typeWindows) {
    const text = readCached(workspace, window.path, cache);
    if (text === undefined) continue;
    for (const line of cachedFileLines(cache, window.path, text).slice(window.start - 1, window.end)) {
      for (const match of maskNonCode(line, false).matchAll(/[A-Za-z_]\w*/g)) handled.add(match[0]);
    }
  }
  const owners = new Map([[path.posix.dirname(focal.path), focal.path]]);
  for (const edge of resolveGoImports(workspace, focal.path, lines)) {
    const dir = path.posix.dirname(edge.path);
    if (edge.kind === "import" && !owners.has(dir)) owners.set(dir, edge.path);
  }
  const declares = new RegExp(`^func\\s*\\([^)]*\\)\\s*(?:${[...called].map(escapeRegExp).join("|")})\\s*[(\\[]`, "m");
  const declared = new Map<string, NamedWindow[]>();
  for (const owner of owners.values()) {
    const files = [owner];
    scanGoPackageSiblings(owner, workspace, cache, (relPath) => {
      files.push(relPath);
      return undefined;
    }, { mightMatch: (text) => declares.test(text) });
    for (const file of files) {
      const text = readCached(workspace, file, cache);
      if (text === undefined || !declares.test(text)) continue;
      const fileLines = cachedFileLines(cache, file, text);
      for (const symbol of (await cache.parsedSymbols(text, "go", file)) ?? []) {
        const name = unqualifiedSymbolTail(symbol.name);
        const receiver = /^func\s*\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)/.exec(fileLines[symbol.startLine - 1] ?? "")?.[1];
        if (!called.has(name) || receiver === undefined || !handled.has(receiver)) continue;
        declared.set(name, [...(declared.get(name) ?? []), { path: file, start: symbol.startLine, end: symbol.endLine, name }]);
      }
    }
  }
  return [...declared.values()].flatMap((windows) => windows.length === 1 ? windows : []);
}

/** First line of the `//` (`#`) comment block directly above line `start`, or `start`. */
export function leadingCommentStart(lines: readonly string[], start: number, hashComment: boolean): number {
  const comment = hashComment ? /^\s*#/ : /^\s*\/\//;
  let first = start;
  while (first > 1 && comment.test(lines[first - 2] ?? "")) first--;
  return first;
}

/** Bytes of lines `start`-`end` (1-based, inclusive) as served. */
export function lineSpanBytes(lines: readonly string[], start: number, end: number): number {
  return Buffer.byteLength(lines.slice(start - 1, end).join("\n"), "utf8");
}

/**
 * Go: the `const` declarations of the values of the named non-struct type
 * declared on line `typeLine` — `type Side int` and its `DebitSide Side = 1`
 * block, an enum's members.
 */
export function goTypedConstWindows(lines: readonly string[], name: string, typeLine: number): Array<{ start: number; end: number }> {
  const type = escapeRegExp(name);
  if (!new RegExp(`^type\\s+${type}\\s+[A-Za-z_][\\w.]*\\s*$`).test(maskNonCode(lines[typeLine - 1] ?? "", false).trimEnd())) return [];
  const single = new RegExp(`^const\\s+[A-Za-z_]\\w*\\s+${type}\\b`);
  const member = new RegExp(`^\\s+[A-Za-z_]\\w*(?:\\s*,\\s*[A-Za-z_]\\w*)*\\s+${type}\\b`);
  const out: Array<{ start: number; end: number }> = [];
  for (let at = 0; at < lines.length; at++) {
    const masked = maskNonCode(lines[at]!, false);
    if (single.test(masked)) out.push({ start: at + 1, end: at + 1 });
    if (!/^const\s*\(\s*$/.test(masked)) continue;
    let close = at + 1;
    while (close < lines.length && !/^\)/.test(lines[close]!)) close++;
    if (lines.slice(at + 1, close).some((line) => member.test(maskNonCode(line, false)))) out.push({ start: at + 1, end: Math.min(close + 1, lines.length) });
    at = close;
  }
  return out;
}

/**
 * One dependency window as the declarations it serves: the definition with the
 * comment block directly above it (without it when that would pass
 * EDIT_CONTEXT_MAX_WINDOW_BYTES), and for an enum-like Go type its const
 * block. A span still over the cap is left to the caller.
 */
export function declarationSpans(relPath: string, lines: readonly string[], window: NamedWindow): Array<{ start: number; end: number }> {
  const documented = leadingCommentStart(lines, window.start, hasHashComments(relPath));
  const spans = [{ start: lineSpanBytes(lines, documented, window.end) <= EDIT_CONTEXT_MAX_WINDOW_BYTES ? documented : window.start, end: window.end }];
  if (path.extname(relPath) === ".go") spans.push(...goTypedConstWindows(lines, window.name, window.start));
  return spans.filter((span) => lineSpanBytes(lines, span.start, span.end) <= EDIT_CONTEXT_MAX_WINDOW_BYTES);
}

export interface EditContextSpan {
  readonly start: number;
  readonly end: number;
  /** The declarations it serves, and the focals using them, in first-use order. */
  readonly names: readonly string[];
  readonly focals: readonly string[];
}

/**
 * `spans` in line order, overlapping ones joined, and ones only blank lines
 * apart joined while the join stays within EDIT_CONTEXT_MAX_WINDOW_BYTES (a
 * type and the const block under it are one window).
 */
export function mergeEditContextSpans(lines: readonly string[], spans: readonly EditContextSpan[]): EditContextSpan[] {
  const merged: EditContextSpan[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged[merged.length - 1];
    const overlaps = last !== undefined && span.start <= last.end + 1;
    const adjacent = last !== undefined && !overlaps && lines.slice(last.end, span.start - 1).every((line) => line.trim() === "")
      && lineSpanBytes(lines, last.start, span.end) <= EDIT_CONTEXT_MAX_WINDOW_BYTES;
    if (last === undefined || !overlaps && !adjacent) {
      merged.push(span);
      continue;
    }
    merged[merged.length - 1] = {
      start: last.start,
      end: Math.max(last.end, span.end),
      names: [...new Set([...last.names, ...span.names])],
      focals: [...new Set([...last.focals, ...span.focals])],
    };
  }
  return merged;
}

/**
 * `edit-context: A, B (used by F)`, its names cut short with "…" so the
 * whole stays within the 60 characters `whySummary` keeps of a `why`.
 */
export function editContextWhy(names: readonly string[], focals: readonly string[]): string {
  const tail = ` (used by ${focals.join(", ")})`;
  let shown = names.join(", ");
  for (let count = names.length - 1; count >= 1 && `${EDIT_CONTEXT_WHY}: ${shown}${tail}`.length > 60; count--) {
    shown = `${names.slice(0, count).join(", ")}, …`;
  }
  return `${EDIT_CONTEXT_WHY}: ${shown}${tail}`;
}

/**
 * Appends `editContextCandidates`' windows to a located edit pack as served,
 * non-required context surfaces (`TL_EDIT_CONTEXT`, default ON).
 */
export async function attachEnumStyleReviews(surfaces: TaskPackSurface[], workspace: string, query: string, cache?: FileReadCache): Promise<void> {
  const siblings = existingSiblingMembers(surfaces, workspace, cache), existing = new Set(extractEnumValueTokens(query).map(normIdent).filter(value => siblings.has(value)));
  for (const surface of surfaces.filter(row => row.path.endsWith(".css")).slice(0, 2)) {
    if (typeof surface.code !== "string" || surface.content_completeness === "partial"
      || (surface.remaining_ranges?.length ?? 0) > 0 || (surface.appended_windows?.length ?? 0) > 0) continue;
    const span = parseSurfaceSpan(surface.range), fullBody = readCached(workspace, surface.path, cache);
    if (!span || fullBody === undefined) continue;
    const text = await enumStyleReview({path:surface.path,body:surface.code,fullBody,
      startLine:span.start,endLine:span.end,fresh:true,complete:true}, existing);
    if (text !== undefined) bindEnumStyleReviewOrigin(surface,{path:surface.path,range:surface.range,body:surface.code,text});
  }
}

/**
 * The Go returned-local review of the first two Go surfaces (goReturnedLocalReview.ts: a narrow safety net
 * for one shape, about 1 function in 50,000). A surface qualifies when its body is the exact, complete
 * source of its window and the window parses as whole declarations: the small file served whole, or ONE
 * FUNCTION served as a window of a larger file, with or without a prefix before it. The rest of the file
 * (`remaining_ranges`) does not matter, only a remaining range that overlaps the window itself does
 * (2026-10-24, generality audit §3.9.1: a function served as a window with the rest of the file remaining, as
 * pkgbits `NewDecoderRaw` is served (190-206 of 519 lines), was never reviewed: this required `remaining_ranges`
 * to be empty). `projectEvidence` makes the same distinction when the review reaches the wire.
 */
export async function attachGoReturnedLocalReviews(surfaces: TaskPackSurface[], workspace: string, cache?: FileReadCache): Promise<void> {
  for (const surface of surfaces.slice(0, 2)) {
    if (!surface.path.endsWith(".go") || surface.path.endsWith("_test.go")
      || typeof surface.code !== "string" || surface.content_completeness === "partial"
      || (surface.appended_windows?.length ?? 0) > 0) continue;
    const span = parseSurfaceSpan(surface.range), source = readCached(workspace, surface.path, cache);
    if (span === undefined || source === undefined || !isExactContiguousBody(surface.code, source, span.start, span.end)) continue;
    // A remaining range that is not a plain span, or that touches this window, means the body is not all of its window.
    if ((surface.remaining_ranges ?? []).some(range => {
      const rest = parseSurfaceSpan(range);
      return rest === undefined || (rest.start <= span.end && rest.end >= span.start);
    })) continue;
    const review = await goReturnedLocalReview({path: surface.path, startLine: span.start, endLine: span.end,
      body: surface.code, fresh: true, complete: true});
    if (review !== undefined) bindGoReviewOrigin(surface, {path: surface.path, body: surface.code, range: surface.range, text: review});
  }
}

/** Most surfaces of one pack `attachJavaLoopGuardReviews` reads. */
export const MAX_JAVA_LOOP_GUARD_REVIEW_SURFACES = 64;

export async function attachJavaLoopGuardReviews(surfaces: TaskPackSurface[], workspace: string, cache?: FileReadCache): Promise<void> {
  const analyzed = new Map<string, ReturnType<typeof analyzeJavaLoopGuards>>();
  // A continuation that owes a type's members as rows serves each row as its own
  // surface (up to MAX_FLOW_REQUIRED_MEMBER_WINDOWS of them): the loop in the
  // 43rd must be reviewed as the one in the 3rd is.
  for (const surface of surfaces.filter(row => row.path.endsWith(".java")).slice(0, MAX_JAVA_LOOP_GUARD_REVIEW_SURFACES)) {
    if (typeof surface.code !== "string" || surface.content_completeness === "partial"
      || (surface.remaining_ranges?.length ?? 0) > 0 || (surface.appended_windows?.length ?? 0) > 0) continue;
    const span = parseSurfaceSpan(surface.range), fullBody = readCached(workspace, surface.path, cache);
    if (span === undefined || fullBody === undefined || !isExactContiguousBody(surface.code, fullBody, span.start, span.end)) continue;
    if (!analyzed.has(surface.path)) {
      if (analyzed.size >= 2) continue;
      analyzed.set(surface.path, analyzeJavaLoopGuards(surface.path, fullBody));
    }
    const review = javaLoopGuardReview({path: surface.path, fullBody, body: surface.code, startLine: span.start,
      endLine: span.end, fresh: true, complete: true}, await analyzed.get(surface.path));
    if (review !== undefined) bindJavaLoopGuardOrigin(surface, {path: surface.path, body: surface.code, range: surface.range, text: review});
  }
}

/** How many call names of a nested callee's body `calleeDefinitionsForFocal` tries to resolve. */
export const MAX_NESTED_CALLEE_NAMES_SCANNED = 3 * MAX_CALLEES_PER_REQUIREMENT;

/** `focalIsCallable` for a parsed symbol of `lines` (a callee candidate). */
export function symbolIsCallable(symbol: { kind: string; startLine: number; endLine: number }, lines: readonly string[], hashComment: boolean): boolean {
  if (CALLER_EXPANSION_CALLABLE_KINDS.has(symbol.kind)) return true;
  return symbol.kind === "const" && declarationIsCallable(lines.slice(symbol.startLine - 1, symbol.endLine), hashComment);
}
